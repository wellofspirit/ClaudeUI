/**
 * An in-memory X-Agent ledger (ADR-105) for tests that drive `CrossEngineDispatcher`
 * without the operational DB. Same contract as the real `dispatchLedger`: `create`
 * writes a `running` row with a fresh ref-shaped id and refuses a (engine, harness id)
 * that is already recorded. It also keeps the ordered log of calls, so a test can
 * assert a row existed BEFORE the harness spawned.
 */
import type {
  DispatchLedgerStore,
  DispatchTargetPatch,
  DispatchTargetRow
} from '../../core/services/dispatch-target-ledger'
import type { EngineId } from '../../shared/types'

export interface FakeDispatchLedger extends DispatchLedgerStore {
  /** Every row, by ledger id, as currently stored. */
  readonly rows: Map<string, DispatchTargetRow>
  /** `create:<harnessRef>` and `update:<id>` in call order. */
  readonly log: string[]
  /** What `spend` answers for a harness id (default none). */
  spendByHarnessRef: Map<string, { costUsd: number; unpricedTurns: number }>
  /** The row recorded for this harness id, if any. */
  rowFor(engine: EngineId, harnessRef: string): DispatchTargetRow | undefined
}

export function makeFakeDispatchLedger(): FakeDispatchLedger {
  const rows = new Map<string, DispatchTargetRow>()
  const log: string[] = []
  const spendByHarnessRef = new Map<string, { costUsd: number; unpricedTurns: number }>()
  let next = 0
  const rowFor = (engine: EngineId, harnessRef: string): DispatchTargetRow | undefined =>
    [...rows.values()].find((r) => r.engine === engine && r.harnessRef === harnessRef)
  return {
    rows,
    log,
    spendByHarnessRef,
    rowFor,
    create(input) {
      if (rowFor(input.engine, input.harnessRef))
        throw new Error('Could not record the dispatch target')
      next++
      const now = 1_000 + next
      const row: DispatchTargetRow = {
        ...input,
        id: `s-${String(next).padStart(6, '0')}`,
        state: 'running',
        createdAt: now,
        lastActiveAt: now
      }
      rows.set(row.id, row)
      log.push(`create:${row.harnessRef}`)
      return { ...row }
    },
    get: (id) => {
      const row = rows.get(id)
      return row ? { ...row } : undefined
    },
    getByHarnessRef: (engine, harnessRef) => {
      const row = rowFor(engine, harnessRef)
      return row ? { ...row } : undefined
    },
    update(id: string, patch: DispatchTargetPatch) {
      const row = rows.get(id)
      if (!row) return
      rows.set(id, { ...row, ...patch })
      log.push(`update:${id}`)
    },
    spend: (harnessRef) => spendByHarnessRef.get(harnessRef) ?? { costUsd: 0, unpricedTurns: 0 }
  }
}
