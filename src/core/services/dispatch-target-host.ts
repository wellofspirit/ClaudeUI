/**
 * What the per-engine dispatch target classes need from `CrossEngineDispatcher`: its core methods
 * and core state, and nothing else. The dispatcher builds one host (late-bound, see `targetHost`) and
 * passes it to each engine class.
 */

import { type CallerRestriction } from '../opencode/caller-restriction'
import type { DispatchTargetJudge } from './dispatch-target-judge'
import type { MergedClaudeRules } from '../pi/permission-engine'
import {
  type DispatchLedgerStore,
  type DispatchTargetRow,
  type DispatchTargetState
} from './dispatch-target-ledger'
import type { DispatchRun, DispatchRunRegistry } from './dispatch-runs'
import { type HandBackAnswer } from './dispatch-hand-back-server'
import { type ReportReview } from '../../shared/handback-review'
import { type SessionToolCaller } from './session-tools'
import { type RunContext } from './dispatch-parent'
import type { DispatchConfig, EngineId } from '../../shared/types'
import type {
  DispatchContext,
  FreshLaunch,
  DispatchResult,
  DispatcherDeps,
  DispatchedTurnRecord,
  TurnTimeout,
  TurnLivenessCaps,
  TargetLedgerFields,
  ClaudeTargetEntry,
  TargetEntry,
  ForwardedBlockHold,
  PendingForwardedApproval,
  TurnReturn
} from './dispatch-target-types'

export interface DispatchTargetHost {
  readonly deps: DispatcherDeps
  readonly ledger: DispatchLedgerStore
  readonly requireHandBack: boolean
  readonly handBackSettleMs: number
  readonly targets: Map<string, TargetEntry>
  readonly disposals: Map<string, number>
  readonly pendingApprovals: Map<string, PendingForwardedApproval>
  readonly runs: DispatchRunRegistry
  readonly now: () => number
  targetRules(
    targetCwd: string,
    parentCwd: string,
    restriction?: CallerRestriction,
    originCwd?: string
  ): MergedClaudeRules
  safeRecordUsage(row: DispatchedTurnRecord): void
  recordTarget(
    ctx: RunContext,
    spec: {
      engine: EngineId
      harnessRef: string
      /** Where the target runs ({@link targetCwd}); the parent's own directory is `ctx.cwd`. */
      cwd: string
      model: string
      accountKey: string | null
      fresh?: FreshLaunch
      /** The target was started with the `hand_back` tool. */
      handBack: boolean
    }
  ): DispatchTargetRow
  bindContinuation(ctx: RunContext, cont: { live: TargetEntry } | { row: DispatchTargetRow }): void
  ledgerSet(ledgerId: string, patch: Parameters<DispatchLedgerStore['update']>[1]): void
  ledgerTurnState(
    entry: Pick<TargetLedgerFields, 'ledgerId' | 'released'>,
    state: DispatchTargetState
  ): void
  findContinuation<K extends TargetEntry['kind']>(
    sessionId: string,
    ctx: DispatchContext,
    kind: K
  ): { live: Extract<TargetEntry, { kind: K }> } | { row: DispatchTargetRow } | null
  continuationSpend(
    cont: { live: TargetEntry } | { row: DispatchTargetRow },
    cfg: DispatchConfig | undefined,
    sessionId: string,
    engine: EngineId
  ): { costUsd: number; unpricedTurns: number } | DispatchResult
  resumeModelRefusal(
    engine: EngineId,
    model: string,
    cfg: DispatchConfig | undefined
  ): DispatchResult | null
  noteSteerConsumed(token: string): void
  hasStraySteers(ledgerId: string): boolean
  noteSteerFrame(entry: ClaudeTargetEntry, frame: Record<string, unknown>): void
  taskText(
    entry: Pick<TargetLedgerFields, 'handBack'>,
    ctx: RunContext,
    prompt: string,
    toolName: string
  ): string
  receiveHandBack(
    entry: TargetEntry | undefined,
    report: unknown,
    callId: string | undefined,
    observed?: ReportReview
  ): HandBackAnswer
  settleReview(run: DispatchRun): Promise<void>
  xAgentCaller(entry: TargetEntry, toolUseId?: string): SessionToolCaller
  finishTurn(
    ctx: RunContext,
    engine: EngineId,
    model: string,
    entry: Pick<TargetLedgerFields, 'handBack'>,
    sessionId: string,
    turn: {
      finalText: string
      outText: string
      usage: { totalTokens: number; toolUses: number; durationMs: number }
    }
  ): TurnReturn
  runWithNudges(
    ctx: RunContext,
    who: {
      sessionId: () => string
      engine: EngineId
      /** What the engine calls the tool (the nudge names it). */
      toolName: string
      cumulativeCostUsd: () => number
      waitingOnOwnWork?: () => boolean
    },
    first: string,
    turn: (prompt: string | null, nudge: boolean) => Promise<TurnReturn>
  ): Promise<DispatchResult>
  startHeartbeat(ctx: RunContext): ReturnType<typeof setInterval>
  hasPendingApprovalFor(targetSessionId: string | null): boolean
  takePendingApproval(requestId: string): PendingForwardedApproval | undefined
  armForwardedHold(
    requestId: string,
    ctx: DispatchContext,
    judge: DispatchTargetJudge,
    toolUseId: string,
    block: { reason: string; ms: number }
  ): { hold: ForwardedBlockHold; autoModeBlock: { expiresAt: number } }
  startTurnWatchdog(
    entry: { lastActivityAt: number },
    caps: TurnLivenessCaps,
    turnStartedAt: number,
    isApprovalParked: () => boolean
  ): { promise: Promise<TurnTimeout>; dispose: () => void }
  dismissPendingForTarget(targetSessionId: string): void
}
