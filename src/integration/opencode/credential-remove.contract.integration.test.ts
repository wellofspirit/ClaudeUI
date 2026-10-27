/**
 * opencode 2.x contract for an explicit user Remove (ADR-097 §5, ADR-044): the
 * PRODUCTION credential store's `removeIntegration` against a real 2.x server,
 * isolated home, refusing proxy, fake keys only.
 *
 * The 2.x credential table is shared with every opencode that uses the same data
 * dir, and a provider the user "removed" must actually leave opencode — which is
 * only true when EVERY row for the integration goes, the user's own included,
 * with nothing promoted into the slot on the way. This pins, on the SAME running
 * server (no restart, N6):
 *
 *  - a user key row (active, then displaced), another user key row and a ClaudeUI
 *    vended key row for `openrouter` are all deleted, inactive rows first;
 *  - exactly one `credential.switched` follows, to NO credential (nothing was
 *    re-activated on the way);
 *  - the provider leaves `/api/provider` — it was there before, fed by the rows
 *    alone (no `OPENROUTER_API_KEY` in the engine's environment);
 *  - another integration's rows are untouched;
 *  - a Remove an enabled shared route would undo is refused with nothing deleted.
 */
import { expect, it, vi } from 'vitest'
import { OpencodeClient } from '../../core/opencode/OpencodeClient'
import {
  OpencodeCredentialStore,
  SHARED_ROUTE_CLAIM_MESSAGE,
  memorySlotMemory,
  type CredentialLease
} from '../../core/opencode/credential-store'
import { describeV2, isolatedEnv, useRig, type Rig } from './harness/host'

const memory = memorySlotMemory()

function storeOn(rig: () => Rig, claimedBySharedRoute?: (id: string) => boolean) {
  const connect = async (): Promise<CredentialLease> => {
    const c = new OpencodeClient({
      baseUrl: rig().server.url,
      authHeader: `Basic ${Buffer.from(`opencode:${rig().server.password}`).toString('base64')}`,
      directory: rig().cwd
    })
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
  return new OpencodeCredentialStore({ connect, memory, claimedBySharedRoute })
}

const rows = async (rig: Rig, integrationID: string) =>
  (await rig.api.ok('credential.list')).data.filter((row) => row.integrationID === integrationID)
const providerIds = async (rig: Rig) =>
  (await rig.api.ok('provider.list', {})).data.map((provider) => provider.id)

describeV2('opencode 2.x contract: an explicit Remove deletes every row of the integration', () => {
  const rig = useRig('remove-own-key')

  it('user + ClaudeUI key rows for openrouter all go; the provider leaves the SAME server; nothing is re-activated', async () => {
    const { api, feed } = rig()
    const store = storeOn(rig)
    // The provider can only come from the rows: no key in the engine's environment.
    expect(isolatedEnv(rig().home, rig().proxy)).not.toHaveProperty('OPENROUTER_API_KEY')

    // The user's own key (active), a second user key (inactive), and a control row
    // of another integration that must survive.
    await api.ok('credential.create', {
      body: {
        id: 'cred_user_openrouter',
        integrationID: 'openrouter',
        label: 'mine',
        value: { type: 'key', key: 'sk-or-user-own' }
      }
    })
    await api.ok('credential.create', {
      body: {
        id: 'cred_user_openrouter_old',
        integrationID: 'openrouter',
        label: 'older',
        activate: false,
        value: { type: 'key', key: 'sk-or-user-old' }
      }
    })
    await api.ok('credential.create', {
      body: {
        id: 'cred_user_groq',
        integrationID: 'groq',
        label: 'other provider',
        value: { type: 'key', key: 'gsk-user-own' }
      }
    })
    // ClaudeUI's vended key takes the active slot, displacing the user's.
    expect(await store.vendKey('openrouter', 'sk-or-claudeui')).toBe(true)
    const before = await rows(rig(), 'openrouter')
    expect(before.map((row) => row.id).sort()).toEqual([
      'cred_claudeui_openrouter_v1',
      'cred_user_openrouter',
      'cred_user_openrouter_old'
    ])
    expect(before.filter((row) => row.active).map((row) => row.id)).toEqual([
      'cred_claudeui_openrouter_v1'
    ])
    // Non-vacuous: the rows alone make the provider available right now. (The
    // location's integrations register on the first list, as in the app, where the
    // provider screen lists them first; a cold location answers an empty catalog.)
    await api.ok('integration.list')
    await vi.waitFor(async () => expect(await providerIds(rig())).toContain('openrouter'), {
      timeout: 5000,
      interval: 100
    })

    const from = feed.mark()
    let notified = 0
    store.onChange(() => (notified += 1))
    const deleted = await store.removeIntegration('openrouter', 'remove openrouter (contract)')

    // Inactive rows first, the active one last.
    expect([...deleted].sort()).toEqual([
      'cred_claudeui_openrouter_v1',
      'cred_user_openrouter',
      'cred_user_openrouter_old'
    ])
    expect(deleted.at(-1)).toBe('cred_claudeui_openrouter_v1')
    expect(notified).toBe(1)
    expect(await rows(rig(), 'openrouter')).toEqual([])
    // The control integration is untouched.
    expect((await rows(rig(), 'groq')).map((row) => row.id)).toEqual(['cred_user_groq'])

    // Exactly one switch, to no credential: deleting the inactive rows first
    // means opencode never promoted a row about to go.
    await feed.waitFor('credential.switched', {
      after: from,
      where: (event) => event.data.integrationID === 'openrouter'
    })
    const switched = feed
      .select('credential.switched', { after: from })
      .map((event) => event.data)
      .filter((data) => data.integrationID === 'openrouter')
    expect(switched).toEqual([{ integrationID: 'openrouter', credentialID: null }])

    // The provider is gone from the running server's list, no restart.
    await vi.waitFor(async () => expect(await providerIds(rig())).not.toContain('openrouter'), {
      timeout: 5000,
      interval: 100
    })
    // ClaudeUI's record of the slot is forgotten with the rows.
    expect(Object.keys(memory.read()).filter((key) => key.startsWith('openrouter:'))).toEqual([])

    // A second Remove finds nothing and is not an error.
    expect(await store.removeIntegration('openrouter', 'remove openrouter again')).toEqual([])
  })

  it('refuses while an enabled shared route claims the integration — nothing deleted', async () => {
    const { api } = rig()
    const store = storeOn(rig, (id) => id === 'openai')
    await api.ok('credential.create', {
      body: {
        id: 'cred_user_openai_claimed',
        integrationID: 'openai',
        label: 'mine',
        value: { type: 'key', key: 'sk-openai-user' }
      }
    })
    await expect(store.removeIntegration('openai', 'remove openai (contract)')).rejects.toThrow(
      SHARED_ROUTE_CLAIM_MESSAGE
    )
    expect((await rows(rig(), 'openai')).map((row) => row.id)).toEqual(['cred_user_openai_claimed'])
  })
})
