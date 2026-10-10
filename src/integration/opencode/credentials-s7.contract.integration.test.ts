/**
 * opencode 2.x contract for S7 (ADR-097 §5/§6): ClaudeUI's PRODUCTION credential
 * store and model discovery against a real 2.0.24 server, hermetic (isolated
 * home, refusing proxy; on darwin also loopback-only sandbox-exec and a plugin
 * that rewrites every ChatGPT request to the localhost fixture). Fake keys and
 * fake JWTs only; nothing may reach auth.openai.com or chatgpt.com.
 *
 * (k) keys: vend → the turn carries it; rotate → the next request carries the
 *     new one; disconnect → ClaudeUI's rows gone, the user's pre-seeded row
 *     active again and used.
 * (c) ChatGPT access-only, padded: ChatGPT mode with the account header on a
 *     token whose REAL expiry is inside opencode's 5-min refresh window, and no
 *     refresh attempt (proxy log empty); rotate → new bearer; a really expired
 *     bearer → `provider.auth`, recovered by a rotation; disconnect → the user's
 *     row re-activated.
 * (d) discovery right after a server boot answers the catalog (never an empty
 *     list cached).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../core/services/ui-config', () => ({
  loadEngineConfig: () => ({}),
  saveEngineConfig: () => {}
}))
vi.mock('../../core/opencode/opencode-config', () => ({
  readOpencodeNativeConfig: () => ({}),
  readDeclaredProviderIds: () => [],
  resolveOpencodeConfigFile: () => ({ path: '/nowhere/opencode.jsonc', existed: false })
}))

import { OpencodeClient } from '../../core/opencode/OpencodeClient'
import { OpencodeServerManager } from '../../core/opencode/OpencodeServerManager'
import { endStdioServer, spawnStdioServer } from '../../core/opencode/opencode-server-spawn'
import { installCopyCleanupHook } from '../../core/opencode/opencode-credentials'
import {
  CHATGPT_EXPIRY_PADDING_MS,
  OpencodeCredentialStore,
  memorySlotMemory,
  type CredentialLease
} from '../../core/opencode/credential-store'
import {
  discoverOpencodeModels,
  invalidateOpencodeModelCache,
  peekOpencodeModels,
  setOpencodeDiscoveryConnect
} from '../../core/opencode/model-discovery'
import {
  describeV2,
  fixtureConfig,
  installPlugin,
  isolatedEnv,
  nonce,
  SANDBOX_AVAILABLE,
  sandboxProfile,
  useRig,
  V2_BIN,
  type Rig
} from './harness/host'

function storeOn(rig: () => Rig) {
  const client = () =>
    new OpencodeClient({
      baseUrl: rig().server.url,
      authHeader: `Basic ${Buffer.from(`opencode:${rig().server.password}`).toString('base64')}`,
      directory: rig().cwd
    })
  const connect = async (): Promise<CredentialLease> => {
    const c = client()
    return {
      api: {
        list: () => c.listCredentials(),
        create: (input) => c.createCredential(input),
        remove: (id) => c.removeCredential(id),
        activate: (id) => c.activateCredential(id),
        relabel: (id, label) => c.updateCredentialLabel(id, label)
      },
      release: () => {}
    }
  }
  return new OpencodeCredentialStore({ connect, memory: memorySlotMemory() })
}

const ours = async (rig: Rig) =>
  (await rig.api.ok('credential.list')).data
    .filter((row) => row.id.startsWith('cred_claudeui_'))
    .map((row) => row.id)
const activeRow = async (rig: Rig, integrationID: string) =>
  (await rig.api.ok('credential.list')).data.find(
    (row) => row.integrationID === integrationID && row.active
  )

// ── (k) API keys ─────────────────────────────────────────────────────────────

describeV2('opencode 2.x contract (S7): ClaudeUI’s key credentials', () => {
  const rig = useRig('s7-keys', {
    config: (fixture) => fixtureConfig(fixture, { apiKey: null })
  })
  const store = storeOn(rig)

  it('(k) vend → used; rotate → the new key; disconnect → the user’s row active again and used', async () => {
    const { api, fixture } = rig()
    // The user's active key, and a NEWER inactive one: opencode's own
    // delete-of-active would promote the newer row; ClaudeUI must restore the
    // one it displaced.
    await api.ok('credential.create', {
      body: {
        id: 'cred_user_fixture',
        integrationID: 'fixture',
        label: 'mine',
        value: { type: 'key', key: 'user-own-key' }
      }
    })
    await api.ok('credential.create', {
      body: {
        id: 'cred_user_fixture_newer',
        integrationID: 'fixture',
        label: 'mine too',
        activate: false,
        value: { type: 'key', key: 'user-newer-key' }
      }
    })
    const sessionID = await rig().createSession()
    const bearerOf = async (label: string) => {
      const tag = nonce(label)
      expect((await rig().turn(sessionID, tag)).end.type).toBe('session.execution.succeeded')
      return fixture.mentioning(tag).map((request) => request.authorization)
    }
    expect(await bearerOf('user')).toEqual(['Bearer user-own-key'])

    await store.vendKey('fixture', 'claudeui-key-1')
    expect(await bearerOf('vended')).toEqual(['Bearer claudeui-key-1'])

    await store.vendKey('fixture', 'claudeui-key-2')
    expect(await ours(rig())).toEqual(['cred_claudeui_fixture_v2'])
    expect(await bearerOf('rotated')).toEqual(['Bearer claudeui-key-2'])

    expect(await store.removeSlot('fixture', 'key', 'disconnect')).toBe(true)
    expect(await ours(rig())).toEqual([])
    expect((await activeRow(rig(), 'fixture'))?.id).toBe('cred_user_fixture')
    expect(await bearerOf('restored')).toEqual(['Bearer user-own-key'])
  })
})

// ── (c) ChatGPT ──────────────────────────────────────────────────────────────

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
/** A fake, unsigned JWT that only looks like a ChatGPT access token. */
const fakeJwt = (account: string, tag: string, expSeconds: number) =>
  `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    'https://api.openai.com/auth': { chatgpt_account_id: account },
    tag,
    exp: expSeconds
  })}.fake-${tag}`

interface Redirected {
  readonly url: string
  readonly headers: Record<string, string | null>
}
const redirectLog = (root: string) => join(root, 'redirect.jsonl')
const redirected = (root: string): Redirected[] =>
  existsSync(redirectLog(root))
    ? readFileSync(redirectLog(root), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Redirected)
    : []

const describeChatgpt = SANDBOX_AVAILABLE ? describeV2 : describe.skip

describeChatgpt(
  'opencode 2.x contract (S7): ChatGPT vending, padded and access-only (hermetic)',
  () => {
    const rig = useRig('s7-chatgpt', {
      sandbox: true,
      config: (_fixture, home) => ({
        model: 'openai/gpt-5.5',
        providers: { openai: { settings: { transport: 'http' } } },
        plugins: [installPlugin(home, 'contract-chatgpt-redirect', 'chatgpt-redirect-plugin.js')]
      }),
      env: (fixture, home) => ({
        CONTRACT_REDIRECT_LOG: redirectLog(home.root),
        CONTRACT_FIXTURE_ORIGIN: fixture.origin
      })
    })
    const store = storeOn(rig)
    const now = () => Math.floor(Date.now() / 1000)

    it('(c) ChatGPT mode inside the 5-min window without a refresh; rotate; expired → provider.auth → rotate recovers; disconnect restores the user’s row', async () => {
      const { api, home, proxy, feed } = rig()
      // The user's own OpenAI key, active before ClaudeUI takes the slot.
      await api.ok('credential.create', {
        body: {
          id: 'cred_user_openai',
          integrationID: 'openai',
          label: 'mine',
          value: { type: 'key', key: 'sk-user-own' }
        }
      })
      const sessionID = (
        await api.ok('session.create', {
          body: {
            location: { directory: rig().cwd },
            model: { id: 'gpt-5.5', providerID: 'openai' }
          }
        })
      ).data.id
      const turn = async (label: string) => {
        const seen = redirected(home.root).length
        const { end } = await rig().turn(sessionID, nonce(label))
        return { end, request: redirected(home.root).slice(seen).at(-1) }
      }

      // REAL expiry in 2 min — inside opencode's own `expires <= now+5min`
      // refresh window. Padded by 24 h, opencode never tries to refresh it.
      const exp = now() + 120
      const a = fakeJwt('acct-111', 'A', exp)
      const switched = feed.mark()
      await store.vendChatgpt({ access: a, expires: exp * 1000 })
      await feed.waitFor('credential.switched', { after: switched })
      const row = await activeRow(rig(), 'openai')
      expect(row).toMatchObject({
        id: 'cred_claudeui_acct-111_v1',
        value: {
          type: 'oauth',
          methodID: 'chatgpt-browser',
          refresh: '',
          access: a,
          expires: exp * 1000 + CHATGPT_EXPIRY_PADDING_MS,
          metadata: { accountID: 'acct-111' }
        }
      })
      const one = await turn('chatgpt-a')
      expect(one.end.type).toBe('session.execution.succeeded')
      expect(one.request?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
      expect(one.request?.headers).toMatchObject({
        authorization: `Bearer ${a}`,
        'chatgpt-account-id': 'acct-111'
      })

      // Rotate: the next request carries the new bearer.
      const b = fakeJwt('acct-111', 'B', now() + 3600)
      await store.vendChatgpt({ access: b, expires: Date.now() + 3_600_000 })
      expect(await ours(rig())).toEqual(['cred_claudeui_acct-111_v2'])
      expect((await turn('chatgpt-b')).request?.headers.authorization).toBe(`Bearer ${b}`)

      // A token that really expired while vended: chatgpt.com rejects it (401) →
      // provider.auth. (Another account's: the store never lets an older token of
      // the SAME account replace a newer row, and CredentialSync never vends an
      // expired one — this stands for a token that expired after its vend.)
      const expired = fakeJwt('acct-222', 'expired', now() - 60)
      await store.vendChatgpt({ access: expired, expires: Date.now() - 60_000 })
      const failed = await turn('chatgpt-expired')
      expect(failed.end.type).toBe('session.execution.failed')
      expect((failed.end.data as { error?: { type?: string } }).error?.type).toBe('provider.auth')
      // …and the vault's rotation recovers without a restart.
      const c = fakeJwt('acct-111', 'C', now() + 3600)
      await store.vendChatgpt({ access: c, expires: Date.now() + 3_600_000 })
      const recovered = await turn('chatgpt-c')
      expect(recovered.end.type).toBe('session.execution.succeeded')
      expect(recovered.request?.headers.authorization).toBe(`Bearer ${c}`)

      // Disconnect: ClaudeUI's rows go, the user's key is active again and used.
      expect(await store.removeSlot('openai', 'oauth', 'disconnect')).toBe(true)
      expect(await ours(rig())).toEqual([])
      expect((await activeRow(rig(), 'openai'))?.id).toBe('cred_user_openai')
      const back = await turn('user-key')
      expect(back.request?.headers.authorization).toBe('Bearer sk-user-own')

      // Nothing ever tried auth.openai.com (or anything else off the box).
      expect(proxy.attempts).toEqual([])
    })
  }
)

// ── (h) the imported copy is never promoted ─────────────────────────────────

describeChatgpt(
  'opencode 2.x contract (S7): a copy of ClaudeUI’s 1.x sign-in is never promoted (hermetic)',
  () => {
    const rig = useRig('s7-copy', {
      sandbox: true,
      config: (_fixture, home) => ({
        model: 'openai/gpt-5.5',
        providers: { openai: { settings: { transport: 'http' } } },
        plugins: [installPlugin(home, 'contract-chatgpt-redirect', 'chatgpt-redirect-plugin.js')]
      }),
      env: (fixture, home) => ({
        CONTRACT_REDIRECT_LOG: redirectLog(home.root),
        CONTRACT_FIXTURE_ORIGIN: fixture.origin
      })
    })
    const VAULT_REFRESH = 'rt-vault-current-fake'

    it('(h) a removal keeps ClaudeUI’s padded row instead of activating the copy (no refresh attempt); only emptying the vault lets it go', async () => {
      const { api, proxy, feed } = rig()
      const store = storeOn(rig)
      store.configure({ isClaudeuiToken: (refresh) => refresh === VAULT_REFRESH })
      const now = Math.floor(Date.now() / 1000)
      await store.vendChatgpt({
        access: fakeJwt('acct-1', 'A', now + 3600),
        expires: Date.now() + 3_600_000
      })
      // The row opencode's migration imported from 1.x's auth.json: the vault's
      // refresh token, an expired access token — inactive behind ClaudeUI's.
      await api.ok('credential.create', {
        body: {
          id: 'cred_imported_openai',
          integrationID: 'openai',
          label: 'imported',
          activate: false,
          value: {
            type: 'oauth',
            methodID: 'chatgpt-browser',
            refresh: VAULT_REFRESH,
            access: fakeJwt('acct-1', 'old', now - 3600),
            expires: Date.now() - 3_600_000,
            metadata: { accountID: 'acct-1' }
          }
        }
      })
      for (const context of ['removeDisabledCopies', 'harnessArrived', 'start']) {
        expect(await store.removeSlot('openai', 'oauth', context)).toBe(false)
        expect((await activeRow(rig(), 'openai'))?.id).toBe('cred_claudeui_acct-1_v1')
      }
      // Give a Switched-triggered refresh time to show, had one happened.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(proxy.attempts).toEqual([])

      // Emptying the vault (disconnect) removes ClaudeUI's row anyway: opencode
      // promotes the copy and at once tries to refresh it — the hazard the guard
      // prevents everywhere else (refused by the proxy here).
      const from = feed.mark()
      expect(
        await store.removeSlot('openai', 'oauth', 'disconnect', undefined, {
          force: true,
          vaultEmptying: true
        })
      ).toBe(true)
      await feed.waitFor('credential.switched', { after: from })
      expect((await activeRow(rig(), 'openai'))?.id).toBe('cred_imported_openai')
      await api.ok('credential.remove', { params: { credentialID: 'cred_imported_openai' } })
    })
  }
)

// ── (p) proven copies deleted at first contact; (s) ClaudeUI-started sign-ins ──

describeChatgpt(
  'opencode 2.x contract (S7 follow-up): proven copies and ClaudeUI-started sign-ins (hermetic)',
  () => {
    const rig = useRig('s7-owner', { sandbox: true })
    const VAULT_REFRESH = 'rt-vault-current-fake'

    it('(p) a proven copy is deleted through the credential routes before any location resolves it; unrelated rows untouched; no refresh attempt', async () => {
      const { api } = rig()
      const now = Math.floor(Date.now() / 1000)
      // The copy opencode's migration imported from 1.x auth.json: ACTIVE,
      // expired, carrying the vault's refresh token.
      await api.ok('credential.create', {
        body: {
          id: 'cred_imported_openai',
          integrationID: 'openai',
          label: 'imported',
          value: {
            type: 'oauth',
            methodID: 'chatgpt-browser',
            refresh: VAULT_REFRESH,
            access: fakeJwt('acct-1', 'old', now - 3600),
            expires: Date.now() - 3_600_000,
            metadata: { accountID: 'acct-1' }
          }
        }
      })
      // Unrelated user rows: a ChatGPT sign-in of the user's own (another
      // refresh token, unexpired, inactive), an OpenAI key (inactive) and an
      // OpenRouter key.
      await api.ok('credential.create', {
        body: {
          id: 'cred_users_own_chatgpt',
          integrationID: 'openai',
          label: 'my chatgpt',
          activate: false,
          value: {
            type: 'oauth',
            methodID: 'chatgpt-browser',
            refresh: 'rt-users-own-fake',
            access: fakeJwt('acct-9', 'own', now + 86_400),
            expires: Date.now() + 86_400_000,
            metadata: { accountID: 'acct-9' }
          }
        }
      })
      await api.ok('credential.create', {
        body: {
          id: 'cred_user_openai_key',
          integrationID: 'openai',
          label: 'mine',
          activate: false,
          value: { type: 'key', key: 'sk-user-openai' }
        }
      })
      await api.ok('credential.create', {
        body: {
          id: 'cred_user_openrouter',
          integrationID: 'openrouter',
          label: 'mine',
          value: { type: 'key', key: 'sk-user-or' }
        }
      })
      // A fresh process on that data dir, as at ClaudeUI's start.
      await rig().restart()
      const before = rig().proxy.attempts.length
      // What the server-started hook runs, before the server is handed to anyone.
      const store = storeOn(rig)
      store.configure({ isClaudeuiToken: (refresh) => refresh === VAULT_REFRESH })
      const c = new OpencodeClient({
        baseUrl: rig().server.url,
        authHeader: `Basic ${Buffer.from(`opencode:${rig().server.password}`).toString('base64')}`,
        directory: rig().cwd
      })
      expect(
        await store.deleteProvenCopies(
          {
            list: () => c.listCredentials(),
            create: (input) => c.createCredential(input),
            remove: (id) => c.removeCredential(id),
            activate: (id) => c.activateCredential(id)
          },
          'first contact'
        )
      ).toBe(1)
      // Now a location activates (catalogs, sessions): nothing left to refresh.
      await rig().api.ok('integration.list')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const rows = (await rig().api.ok('credential.list')).data.map((row) => [row.id, row.label])
      expect(rows.map(([id]) => id).sort()).toEqual([
        'cred_user_openai_key',
        'cred_user_openrouter',
        'cred_users_own_chatgpt'
      ])
      expect(rows).toContainEqual(['cred_user_openrouter', 'mine'])
      expect(rig().proxy.attempts.slice(before)).toEqual([])
    })

    it('(s) a key sign-in started from ClaudeUI: its opencode-id row is found by the attempt label (not a concurrent one), and removed like ClaudeUI’s own', async () => {
      const { api } = rig()
      const store = storeOn(rig)
      // Its own starting point (independent of the other cases): the user's
      // OpenAI key, active.
      await api.ok('credential.create', {
        body: {
          id: 'cred_user_signin_case',
          integrationID: 'openai',
          label: 'mine (s)',
          value: { type: 'key', key: 'sk-user-s' }
        }
      })
      const signin = await store.prepareSignin('openai')
      expect(signin.previousActive).toBe('cred_user_signin_case')
      // The connect routes need the location's integrations registered (the
      // activation barrier) — as in the app, where the provider screen lists them first.
      await api.ok('integration.list')
      // ClaudeUI's sign-in, through opencode's own connect flow (opencode picks the id).
      await api.ok('integration.connect.key', {
        params: { integrationID: 'openai' },
        body: { key: 'sk-claudeui-signin', label: signin.label }
      })
      // The user's own opencode signs in right after, before ClaudeUI looks:
      // the NEWEST (and now active) row is theirs, so only the label finds ours.
      await api.ok('integration.connect.key', {
        params: { integrationID: 'openai' },
        body: { key: 'sk-concurrent', label: 'theirs' }
      })
      const adopted = await store.adoptSignin('openai', signin.label, signin.previousActive)
      expect(adopted).toBeTruthy()
      expect(adopted).not.toMatch(/^cred_claudeui_/)
      const listed = (await api.ok('credential.list')).data
      expect(listed.find((row) => row.id === adopted)).toMatchObject({
        label: `ClaudeUI sign-in · ${signin.label.slice('claudeui:signin:'.length)}`,
        value: { type: 'key', key: 'sk-claudeui-signin' }
      })
      expect(listed.find((row) => row.label === 'theirs')?.active).toBe(true)
      expect(await store.removeSlot('openai', 'signin', 'remove openai')).toBe(true)
      const after = (await api.ok('credential.list')).data.filter(
        (row) => row.integrationID === 'openai'
      )
      // Only ClaudeUI's row went; the user's later sign-in keeps the slot.
      expect(after.some((row) => row.id === adopted)).toBe(false)
      expect(after.some((row) => row.id === 'cred_user_signin_case')).toBe(true)
      expect(after.find((row) => row.active)?.label).toBe('theirs')
      expect(rig().proxy.attempts).toEqual([])
    })
  }
)

// ── (r) the real first-contact hook on a production server manager ──────────

describeChatgpt(
  'opencode 2.x contract (S7 follow-up): the production server manager deletes a proven copy at first contact (hermetic)',
  () => {
    const rig = useRig('s7-hook', { sandbox: true })
    const VAULT_REFRESH = 'rt-vault-hook-fake'
    let manager: OpencodeServerManager | undefined
    const ends: Promise<unknown>[] = []
    afterAll(async () => {
      manager?.dispose()
      await Promise.all(ends)
    })

    it('(r) a server started by the production manager — no manual cleanup call — never resolves the copy', async () => {
      const { api, home, proxy } = rig()
      const now = Math.floor(Date.now() / 1000)
      await api.ok('credential.create', {
        body: {
          id: 'cred_imported_hook',
          integrationID: 'openai',
          label: 'imported',
          value: {
            type: 'oauth',
            methodID: 'chatgpt-browser',
            refresh: VAULT_REFRESH,
            access: fakeJwt('acct-1', 'old', now - 3600),
            expires: Date.now() - 3_600_000,
            metadata: { accountID: 'acct-1' }
          }
        }
      })
      await api.ok('credential.create', {
        body: {
          id: 'cred_users_own_hook',
          integrationID: 'openai',
          label: 'my chatgpt',
          activate: false,
          value: {
            type: 'oauth',
            methodID: 'chatgpt-browser',
            refresh: 'rt-users-own-hook-fake',
            access: fakeJwt('acct-9', 'own', now + 86_400),
            expires: Date.now() + 86_400_000,
            metadata: { accountID: 'acct-9' }
          }
        }
      })
      // Stop the rig's server: only the production manager's runs on the data dir.
      rig().feed.close()
      await rig().server.stop()
      const before = proxy.attempts.length
      const env = isolatedEnv(home, proxy)
      manager = new OpencodeServerManager({
        locateBinaryFn: () => ({
          command: '/usr/bin/sandbox-exec',
          args: ['-f', sandboxProfile(home), V2_BIN]
        }),
        spawnFn: (launch, options) => spawnStdioServer(launch, options, { env }),
        configInputFn: () => ({ bridgedMcp: {}, pluginDir: null }),
        endServerFn: (child) => {
          ends.push(endStdioServer(child))
        },
        serverCwd: home.workspace('server-cwd')
      })
      const store = new OpencodeCredentialStore({
        connect: async () => {
          throw new Error('not used')
        },
        memory: memorySlotMemory(),
        isClaudeuiToken: (refresh) => refresh === VAULT_REFRESH
      })
      // The production wiring, default credential API over the server's endpoint.
      installCopyCleanupHook(manager, store)
      const conn = await manager.acquire(rig().cwd, { waitForHostedTools: false })
      const client = new OpencodeClient(conn)
      // A location activates (catalogs): the copy would be resolved now.
      await client.integrations()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const ids = (await client.listCredentials()).map((row) => row.id)
      expect(ids).not.toContain('cred_imported_hook')
      expect(ids).toContain('cred_users_own_hook')
      expect(proxy.attempts.slice(before)).toEqual([])
      manager.releaseIfCurrent(rig().cwd, conn)
      // The rig expects its own server for teardown.
      await rig()
        .restart()
        .catch(() => undefined)
    })
  }
)

// ── (d) discovery after a boot ───────────────────────────────────────────────

describeV2('opencode 2.x contract (S7): discovery right after a server boots', () => {
  const rig = useRig('s7-discovery')
  afterAll(() => setOpencodeDiscoveryConnect(null))

  it('(d) a cold location answers an empty model list; discovery re-reads it, never caches it empty', async () => {
    // Started BEFORE the restart: the server is genuinely inside its warm-up.
    const startedAt = Date.now()
    await rig().restart()
    invalidateOpencodeModelCache()
    const client = new OpencodeClient({
      baseUrl: rig().server.url,
      authHeader: `Basic ${Buffer.from(`opencode:${rig().server.password}`).toString('base64')}`,
      directory: rig().cwd
    })
    // A location the activation barrier did not warm (2.0.24: its first
    // `model.list` answers EMPTY, measured ~100-300 ms after boot): the retry
    // is what keeps that from being taken for "no models".
    const cold = rig().home.workspace(nonce('cold'))
    let firstModels: number | undefined
    setOpencodeDiscoveryConnect(async () => ({
      client: {
        integrations: async () => (await client.call('integration.list', {})).data,
        providers: async () => (await client.call('provider.list', { directory: cold })).data,
        models: async () => {
          const models = (await client.call('model.list', { directory: cold })).data
          firstModels ??= models.length
          return models
        }
      },
      startedAt,
      release: () => {}
    }))
    const groups = await discoverOpencodeModels()
    expect(firstModels).toBe(0)
    const values = groups.flatMap((group) => group.models.map((m) => m.value))
    expect(values).toContain('fixture/fixture-model')
    expect(peekOpencodeModels()).not.toBeNull()
  })
})
