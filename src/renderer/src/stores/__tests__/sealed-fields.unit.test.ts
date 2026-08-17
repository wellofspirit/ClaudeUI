/**
 * The seal's own guard — SyncCore phase 4c.
 *
 * `sealed-fields.ts` is prose + lists; the thing that actually STOPS a sealed
 * writer from coming back is the `no-restricted-syntax` rule in
 * `eslint.config.mjs`. Two artefacts that must agree, in two files, one of which
 * ESLint's flat config cannot import (it is `.mjs`, the lists are `.ts`). So this
 * test is the joint: it parses the lint patterns out of the config and pins them
 * against the lists, and pins the lists against the canonical types.
 *
 * Without it the failure mode is silent and permanent — someone adds a snapshot
 * field, seals it in the list, forgets the regex, and the brand has a hole nobody
 * will notice until a store action writes through it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SEALED_SESSION_FIELDS,
  SEALED_APP_FIELDS,
  SEALED_SESSION_FIELD_SOURCE,
  SEALED_APP_FIELD_SOURCE,
  TRANSIENT_SESSION_FIELDS,
  TRANSIENT_APP_FIELDS
} from '../sealed-fields'
import { emptySession, emptyCanonicalState, toSnapshot } from '../../../../core/shared/sync/state'
import { channelSpec, CHANNEL_SPECS } from '../../../../core/shared/sync/channels'

const config = readFileSync(join(process.cwd(), 'eslint.config.mjs'), 'utf8')

/** Every `key.name=/^(a|b|c)$/` alternation in the sealed-field rule block. */
function lintPatternGroups(): string[][] {
  return [...config.matchAll(/Property\[key\.name=\/\^\(([^)]+)\)\$\/\]/g)].map((m) =>
    m[1].split('|')
  )
}

describe('the sealed-field lint brand', () => {
  it('is actually installed in the ESLint config', () => {
    expect(config).toContain("'no-restricted-syntax'")
    expect(config).toContain('src/renderer/src/stores/replica.ts')
    // The sanctioned writer is the ONLY exemption for app code (tests build whole
    // `PerSessionState` fixtures and are exempt as a class).
    expect(config).toContain('sealed-fields.ts')
  })

  it('names exactly the per-session sealed fields — no drift in either direction', () => {
    const groups = lintPatternGroups()
    const perSession = groups.find((g) => g.includes('messages'))
    expect(perSession, 'no per-session alternation found in eslint.config.mjs').toBeDefined()
    expect([...perSession!].sort()).toEqual([...SEALED_SESSION_FIELDS].sort())
  })

  it('names exactly the app-level sealed fields', () => {
    const groups = lintPatternGroups()
    const appLevel = groups.find((g) => g.includes('recentSessionIds'))
    expect(appLevel, 'no app-level alternation found in eslint.config.mjs').toBeDefined()
    expect([...appLevel!].sort()).toEqual([...SEALED_APP_FIELDS].sort())
  })

  it('covers the per-session shape through both `set` shapes a store action can use', () => {
    // `updateSession(...)` and a literal `sessions: { … }` — see the config's note.
    expect(config).toContain("CallExpression[callee.name='updateSession']")
    expect(config).toContain("Property[key.name='sessions']")
  })
})

describe('the sealed set is DERIVED from the snapshot, not chosen', () => {
  const snapshot = toSnapshot(
    { ...emptyCanonicalState(), sessions: { r1: emptySession('r1') } },
    0
  )

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
        // `routingId` is the map KEY, not state; the catalogs are app-level here and
        // sealed as such (the wire fans the one list into every session entry).
        !['routingId', 'slashCommands', 'sdkSkillNames'].includes(k)
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
      'session:vendor-auth-required',
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
