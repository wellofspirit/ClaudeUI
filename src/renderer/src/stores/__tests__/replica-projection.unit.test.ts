/**
 * The store half of the per-session field list: every sealed field a snapshot carries arrives
 * on the store entry under its STORE name, and the two canonical fields with no store field
 * (`routingId`, `seeded`) do not appear on it.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore } from '../session-store'
import { hydrateReplica } from '../replica'
import {
  SEALED_SESSION_FIELD_SOURCE,
  SESSION_FIELDS_WITHOUT_STORE_FIELD,
  type SealedSessionField
} from '../sealed-fields'
import { resetReplicaSeam } from '@test/helpers/replica-seed'
import {
  SESSION_FIELDS,
  emptyCanonicalState,
  emptySession,
  toSnapshot,
  type CanonicalSessionState
} from '../../../../core/shared/sync/state'

/** A distinct value per field; `cwd` must stay a string because the projection reads it. */
function sentinelFor(key: string): unknown {
  return key === 'cwd' ? '/sentinel/cwd' : { sentinel: key }
}

beforeEach(() => {
  resetReplicaSeam()
  useSessionStore.setState({ activeSessionId: null, sessions: {} })
  ;(window as unknown as { api: unknown }).api = {}
})

describe('projecting a snapshot into the store', () => {
  it('lands a sentinel for every sealed field under its store name', () => {
    const sentinels: Record<string, unknown> = {}
    for (const key of SESSION_FIELDS) {
      if ((SESSION_FIELDS_WITHOUT_STORE_FIELD as readonly string[]).includes(key)) continue
      sentinels[key] = sentinelFor(key)
    }
    const entry = { ...emptySession('r1'), ...sentinels, seeded: true } as CanonicalSessionState
    hydrateReplica(toSnapshot({ ...emptyCanonicalState(), sessions: { r1: entry } }, 5), false)

    const stored = useSessionStore.getState().sessions['r1'] as unknown as Record<string, unknown>
    expect(stored).toBeDefined()
    for (const [storeKey, source] of Object.entries(SEALED_SESSION_FIELD_SOURCE) as [
      SealedSessionField,
      string
    ][]) {
      if (storeKey === 'worktreeInfo') continue
      expect(stored[storeKey], `${storeKey} (from ${source}) did not reach the store`).toEqual(
        sentinelFor(source)
      )
    }
    expect('routingId' in stored).toBe(false)
    expect('seeded' in stored).toBe(false)
  })
})
