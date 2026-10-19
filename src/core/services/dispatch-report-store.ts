/**
 * The X-Agent report store as the dispatcher and the history reader see it (ADR-105 §3,
 * slice B-3a): one row per run that ended, keyed by the target's ledger id.
 *
 * A LEAF over `db.ts`, like `dispatch-target-ledger.ts`: injectable (`DispatcherDeps.reports`)
 * so the dispatcher's tests stay off the operational DB.
 */
import {
  dispatchReportCount,
  dispatchReportsOf,
  insertDispatchReport,
  latestDispatchReport,
  type DispatchReportRow,
  type DispatchReportStatus
} from './db'

export type { DispatchReportRow, DispatchReportStatus }

export interface DispatchReportStore {
  /** Store how a run ended as the target's next run; undefined when the number was taken meanwhile. */
  add(input: {
    targetId: string
    /** The dispatch_agent call that launched or continued the run. */
    toolUseId: string | null
    status: DispatchReportStatus
    /** The report text (delivered, fallback); null for an end without one. */
    report: string | null
    createdAt: number
  }): DispatchReportRow | undefined
  /** The target's newest row. */
  latest(targetId: string): DispatchReportRow | undefined
  /** Every run's row of these targets, oldest first. */
  rowsOf(targetIds: readonly string[]): DispatchReportRow[]
  /** How many runs of the target ended with a row. */
  count(targetId: string): number
}

export const dispatchReports: DispatchReportStore = {
  add: (input) => insertDispatchReport(input),
  latest: (targetId) => latestDispatchReport(targetId),
  rowsOf: (targetIds) => dispatchReportsOf(targetIds),
  count: (targetId) => dispatchReportCount(targetId)
}
