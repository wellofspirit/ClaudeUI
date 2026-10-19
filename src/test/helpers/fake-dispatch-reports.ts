/**
 * An in-memory X-Agent report store (ADR-105 §3) for tests that drive `CrossEngineDispatcher`
 * without the operational DB. Same contract as the real one: rows are numbered 1, 2, … per
 * target, `latest` is the highest run.
 */
import type {
  DispatchReportRow,
  DispatchReportStore
} from '../../core/services/dispatch-report-store'

export interface FakeDispatchReports extends DispatchReportStore {
  /** Every row written, in order. */
  readonly rows: DispatchReportRow[]
}

export function makeFakeDispatchReports(): FakeDispatchReports {
  const rows: DispatchReportRow[] = []
  const of = (targetId: string): DispatchReportRow[] => rows.filter((r) => r.targetId === targetId)
  return {
    rows,
    add(input) {
      const row: DispatchReportRow = {
        targetId: input.targetId,
        run: of(input.targetId).length + 1,
        toolUseId: input.toolUseId,
        status: input.status,
        report: input.report,
        createdAt: input.createdAt,
        deliveredAt: null
      }
      rows.push(row)
      return { ...row }
    },
    latest: (targetId) => of(targetId).at(-1),
    rowsOf: (targetIds) => rows.filter((r) => targetIds.includes(r.targetId)),
    count: (targetId) => of(targetId).length
  }
}
