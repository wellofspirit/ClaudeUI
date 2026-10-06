/**
 * opencode 2.x contract: ClaudeUI-owned credentials over `/api/credential`
 * (ADR-093 §5). No restart anywhere: a change applies to the next request.
 *
 * (h1) key credential with a ClaudeUI id: POST → next request carries it → DELETE.
 * (h2) ChatGPT access-token-only vending and rotate-by-replace
 *      (`cred_claudeui_<account>_v<n>`: POST next with activate, DELETE previous)
 *      → exactly one `credential.switched`, and the next request carries the new
 *      bearer and account header. Hermetic in three layers, so darwin only:
 *      loopback-only sandbox-exec, a refusing proxy, and a plugin that rewrites
 *      every model request to the localhost fixture. Fake JWTs only.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Credential_CreateInput } from '../../core/opencode/protocol-v2/openapi'
import {
  describeV2,
  fixtureConfig,
  installPlugin,
  nonce,
  SANDBOX_AVAILABLE,
  useRig,
  type Rig
} from './harness/host'

const deleteCredential = (rig: Rig, credentialID: string) =>
  rig.api.ok('credential.remove', { params: { credentialID } })

describeV2('opencode 2.x contract: key credential CRUD', () => {
  const rig = useRig('credential', {
    config: (fixture) => fixtureConfig(fixture, { apiKey: null })
  })

  it('(h1) POST a ClaudeUI-id key → the next request carries it → DELETE → gone', async () => {
    const { api, feed, fixture } = rig()
    const sessionID = await rig().createSession()
    const before = nonce('nokey')
    expect((await rig().turn(sessionID, before)).end.type).toBe('session.execution.succeeded')
    expect(fixture.mentioning(before).map((r) => r.authorization)).toEqual([null])

    const id = `cred_claudeui_fixture_v${Date.now()}`
    const key = `contract-key-${randomBytes(8).toString('hex')}`
    const from = feed.mark()
    const created = await api.ok('credential.create', {
      body: {
        id,
        integrationID: 'fixture',
        label: 'claudeui:contract',
        value: { type: 'key', key }
      }
    })
    expect(created.data).toMatchObject({ id, integrationID: 'fixture', active: true })
    const switched = await feed.waitFor('credential.switched', { after: from })
    expect(switched.data).toEqual({ integrationID: 'fixture', credentialID: id })

    const withKey = nonce('withkey')
    expect((await rig().turn(sessionID, withKey)).end.type).toBe('session.execution.succeeded')
    expect(fixture.mentioning(withKey).map((r) => r.authorization)).toEqual([`Bearer ${key}`])

    await deleteCredential(rig(), id)
    const listed = await api.ok('credential.list')
    expect(listed.data.map((entry) => entry.id)).not.toContain(id)
    const after = nonce('deleted')
    expect((await rig().turn(sessionID, after)).end.type).toBe('session.execution.succeeded')
    expect(fixture.mentioning(after).map((r) => r.authorization)).toEqual([null])
  })
})

// ---------------------------------------------------------------------------

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
/** A fake, unsigned JWT that only looks like a ChatGPT access token. */
const fakeJwt = (account: string, tag: string) =>
  `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    'https://api.openai.com/auth': { chatgpt_account_id: account },
    tag,
    exp: Math.floor(Date.now() / 1000) + 3600
  })}.fake-${tag}`

function chatgptCredential(id: string, account: string, access: string): Credential_CreateInput {
  return {
    id,
    integrationID: 'openai',
    label: `claudeui:chatgpt:${account}`,
    activate: true,
    value: {
      type: 'oauth',
      methodID: 'chatgpt-browser',
      refresh: '',
      access,
      expires: Date.now() + 60 * 60_000,
      metadata: { accountID: account }
    }
  }
}

interface Redirected {
  readonly url: string
  readonly headers: {
    readonly authorization: string | null
    readonly 'chatgpt-account-id': string | null
    readonly originator: string | null
  }
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

describeChatgpt('opencode 2.x contract: ChatGPT access-token vending (hermetic)', () => {
  const rig = useRig('chatgpt', {
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

  it('(h2) access-only POST enters ChatGPT mode; rotate-by-replace switches once and carries the new bearer + account', async () => {
    const { api, feed, fixture, home, proxy } = rig()
    const first = { id: 'cred_claudeui_acct111_v1', access: fakeJwt('acct-111', 'A') }
    await api.ok('credential.create', {
      body: chatgptCredential(first.id, 'acct-111', first.access)
    })
    await feed.waitFor('credential.switched', {
      where: (event) => event.data.credentialID === first.id
    })
    const created = await api.ok('session.create', {
      body: {
        location: { directory: rig().cwd },
        model: { id: 'gpt-5.5', providerID: 'openai' }
      }
    })
    const sessionID = created.data.id

    const turn = async (label: string) => {
      const seen = redirected(home.root).length
      const { end } = await rig().turn(sessionID, nonce(label))
      expect(end.type).toBe('session.execution.succeeded')
      const requests = redirected(home.root).slice(seen)
      expect(requests.length).toBeGreaterThan(0)
      return requests.at(-1)!
    }
    const one = await turn('chatgpt-a')
    expect(one.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(one.headers).toEqual({
      authorization: `Bearer ${first.access}`,
      'chatgpt-account-id': 'acct-111',
      originator: 'opencode'
    })

    // Rotate within the account: POST v2 (activate) then DELETE v1.
    const second = { id: 'cred_claudeui_acct111_v2', access: fakeJwt('acct-111', 'B') }
    const from = feed.mark()
    await api.ok('credential.create', {
      body: chatgptCredential(second.id, 'acct-111', second.access)
    })
    await deleteCredential(rig(), first.id)
    const two = await turn('chatgpt-b')
    const switched = feed.select('credential.switched', { after: from })
    expect(switched.map((event) => event.data)).toEqual([
      { integrationID: 'openai', credentialID: second.id }
    ])
    expect(two.headers.authorization).toBe(`Bearer ${second.access}`)
    expect(two.headers['chatgpt-account-id']).toBe('acct-111')

    // Another account: the account header follows the switch, no restart.
    const other = { id: 'cred_claudeui_acct222_v1', access: fakeJwt('acct-222', 'C') }
    await api.ok('credential.create', {
      body: chatgptCredential(other.id, 'acct-222', other.access)
    })
    await deleteCredential(rig(), second.id)
    const three = await turn('chatgpt-c')
    expect(three.headers.authorization).toBe(`Bearer ${other.access}`)
    expect(three.headers['chatgpt-account-id']).toBe('acct-222')

    await deleteCredential(rig(), other.id)
    // Every model call reached only the localhost fixture; nothing tried the network.
    expect(fixture.upstream.length).toBeGreaterThanOrEqual(3)
    expect(proxy.attempts).toEqual([])
  })
})
