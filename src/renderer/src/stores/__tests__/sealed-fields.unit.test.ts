/**
 * The seal's own guard — SyncCore phase 4c.
 *
 * `sealed-fields.ts` is prose + lists; the thing that actually STOPS a sealed
 * writer from coming back is the `no-restricted-syntax` rule in
 * `eslint.config.mjs`. The config builds its per-session alternation from the
 * `CanonicalSessionState` declaration and cannot import the exception constants,
 * so this test is the joint: it reads the resolved selectors from the config and
 * pins them against the lists, and pins the lists against the canonical types.
 *
 * Without it the failure mode is silent and permanent: the config restates the
 * exceptions, and a drift would leave a store field unsealed until a store action
 * wrote through it.
 */

import { describe, it, expect } from 'vitest'
import {
  SESSION_FIELDS_WITHOUT_STORE_FIELD,
  STORE_NAME_OF_SESSION_FIELD,
  SEALED_SESSION_FIELDS,
  SEALED_APP_FIELDS,
  SEALED_SESSION_FIELD_SOURCE,
  SEALED_APP_FIELD_SOURCE,
  TRANSIENT_SESSION_FIELDS,
  TRANSIENT_APP_FIELDS
} from '../sealed-fields'
import { emptySession, emptyCanonicalState, toSnapshot } from '../../../../core/shared/sync/state'
import { channelSpec, CHANNEL_SPECS } from '../../../../core/shared/sync/channels'

interface RestrictedSelector {
  selector: string
}
interface ConfigObject {
  ignores?: string[]
  rules?: Record<string, unknown>
}

/** The `no-restricted-syntax` config object that carries the seal (it exempts `replica.ts`). */
async function sealConfig(): Promise<{ ignores: string[]; selectors: string[] }> {
  const { default: configs } = (await import('../../../../../eslint.config.mjs')) as {
    default: ConfigObject[]
  }
  const block = configs.find((c) => c.ignores?.includes('src/renderer/src/stores/replica.ts'))
  expect(block, 'no config object exempts stores/replica.ts').toBeDefined()
  const options = block!.rules!['no-restricted-syntax'] as unknown[]
  const selectors = options
    .filter((o): o is RestrictedSelector => typeof o === 'object' && o !== null && 'selector' in o)
    .map((o) => o.selector)
  return { ignores: block!.ignores!, selectors }
}

/** The alternation of a `Property[key.name=/^(a|b)$/]` selector, or undefined. */
function alternationOf(selector: string): string[] | undefined {
  return /Property\[key\.name=\/\^\(([^)]+)\)\$\/\]/.exec(selector)?.[1].split('|')
}

describe('the sealed-field lint brand', () => {
  it('is installed in the ESLint config, exempting only the replica and its field list', async () => {
    const { ignores, selectors } = await sealConfig()
    expect(selectors.length).toBeGreaterThanOrEqual(3)
    // The sanctioned writer is the ONLY exemption for app code (tests build whole
    // `PerSessionState` fixtures and are exempt as a class).
    expect(ignores).toContain('src/renderer/src/stores/replica.ts')
    expect(ignores).toContain('src/renderer/src/stores/sealed-fields.ts')
  })

  it('names exactly the per-session sealed fields — no drift in either direction', async () => {
    const { selectors } = await sealConfig()
    const perSession = selectors.filter((s) => alternationOf(s)?.includes('messages'))
    // `updateSession(...)` and a literal `sessions: { … }` — see the config's note.
    expect(perSession).toHaveLength(2)
    expect(
      perSession.some((s) => s.startsWith("CallExpression[callee.name='updateSession'] "))
    ).toBe(true)
    expect(perSession.some((s) => s.startsWith("Property[key.name='sessions'] "))).toBe(true)
    for (const selector of perSession) {
      // Sorted: the config lists the names in declaration order, the store module in
      // `emptySession` order, and a regex alternation has no order.
      expect([...alternationOf(selector)!].sort()).toEqual([...SEALED_SESSION_FIELDS].sort())
    }
  })

  it('names exactly the app-level sealed fields', async () => {
    const { selectors } = await sealConfig()
    const appLevel = selectors.map(alternationOf).find((g) => g?.includes('recentSessionIds'))
    expect(appLevel, 'no app-level alternation found in eslint.config.mjs').toBeDefined()
    expect([...appLevel!].sort()).toEqual([...SEALED_APP_FIELDS].sort())
  })

  it('restates the exception facts the config cannot import', () => {
    // The config hard-codes these three; sealed-fields.ts owns them. The per-session
    // alternation test above fails if either side moves without the other.
    expect([...SESSION_FIELDS_WITHOUT_STORE_FIELD]).toEqual(['routingId', 'seeded'])
    expect(STORE_NAME_OF_SESSION_FIELD).toEqual({ queue: 'queuedItems' })
    expect(SEALED_SESSION_FIELDS.at(-1)).toBe('worktreeInfo')
  })
})

describe('the sealed set is DERIVED from the snapshot, not chosen', () => {
  const snapshot = toSnapshot({ ...emptyCanonicalState(), sessions: { r1: emptySession('r1') } }, 0)

  it('every sealed per-session field maps to a real wire field', () => {
    const wireKeys = new Set(Object.keys(snapshot.sessions['r1']))
    const appKeys = new Set(Object.keys(snapshot))
    for (const field of SEALED_SESSION_FIELDS) {
      const source = SEALED_SESSION_FIELD_SOURCE[field]
      expect(source, `${field} has no declared wire source`).toBeDefined()
      expect(
        wireKeys.has(source) || appKeys.has(source),
        `${field} claims wire source "${source}", which no snapshot carries`
      ).toBe(true)
    }
  })

  it('every sealed app-level field maps to a real wire field', () => {
    const appKeys = new Set(Object.keys(snapshot))
    for (const field of SEALED_APP_FIELDS) {
      const source = SEALED_APP_FIELD_SOURCE[field]
      expect(source, `${field} has no declared wire source`).toBeDefined()
      expect(appKeys.has(source), `${field} claims wire source "${source}"`).toBe(true)
    }
  })

  it('every per-session wire field is sealed — a new snapshot field cannot slip through', () => {
    const covered = new Set(Object.values(SEALED_SESSION_FIELD_SOURCE))
    const unsealed = Object.keys(snapshot.sessions['r1']).filter(
      (k) =>
        !covered.has(k as never) &&
        // `routingId` is the map KEY, not state.
        // `seeded` is replica-internal (ADR-087 §2): `hydrateReplica` reads it to set
        // the store's per-client `evicted` view flag, and no store field mirrors it.
        !['routingId', 'seeded'].includes(k)
    )
    expect(
      unsealed,
      `PerSessionSnapshot fields with no seal: ${unsealed.join(', ')} — add them to ` +
        `SEALED_SESSION_FIELDS *and* the lint pattern, or say why they are transient`
    ).toEqual([])
  })

  it('every app-level wire field is sealed', () => {
    const covered = new Set(Object.values(SEALED_APP_FIELD_SOURCE))
    const unsealed = Object.keys(snapshot).filter(
      (k) =>
        !covered.has(k as never) &&
        // `seq` is the watermark, `sessions` the map itself (co-owned: local creation
        // and eviction add/remove entries, the replica owns each entry's fields),
        // `activeSessionId` is per-client view state (ADR-041).
        !['seq', 'sessions', 'activeSessionId'].includes(k)
    )
    expect(unsealed, `FullStateSnapshot fields with no seal: ${unsealed.join(', ')}`).toEqual([])
  })
})

describe('the transient set is the `canonical: false` complement', () => {
  it('is disjoint from the sealed set', () => {
    const sealed = new Set<string>([...SEALED_SESSION_FIELDS, ...SEALED_APP_FIELDS])
    for (const field of [...TRANSIENT_SESSION_FIELDS, ...TRANSIENT_APP_FIELDS]) {
      expect(sealed.has(field), `${field} is listed as BOTH sealed and transient`).toBe(false)
    }
  })

  it('the channels feeding it really are classified non-canonical', () => {
    // A spot-check that the classification is what the split rests on: if any of
    // these ever gained a snapshot field, its store writer would become a second
    // interpretation and would have to be deleted.
    for (const channel of [
      'session:error',
      'session:warning',
      'session:sandbox-violation',
      'git:status-update',
      'usage:data',
      'usage:block-data',
      'session:bash-output',
      'session:background-output'
    ]) {
      expect(channelSpec(channel), `${channel} is unclassified`).toBeDefined()
      expect(channelSpec(channel)?.canonical, `${channel} is canonical now`).toBe(false)
    }
  })

  it('nothing in the channel table is canonical without a reducer-owned field', () => {
    // The inverse guard: a `canonical: true` channel with no sealed field to write
    // would fold into state nothing projects.
    const canonicalChannels = Object.entries(CHANNEL_SPECS)
      .filter(([, spec]) => spec.canonical)
      .map(([channel]) => channel)
    expect(canonicalChannels.length).toBeGreaterThan(20)
    expect(SEALED_SESSION_FIELDS.length + SEALED_APP_FIELDS.length).toBeGreaterThan(30)
  })
})
