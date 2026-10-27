/**
 * What one RUN of a subagent child is worth to the task lifecycle (ADR-073,
 * pi parity): the figures the live mapper (`event-mapper.ts`) and the cold
 * converter (`history.ts`) both put on a task's progress and terminal
 * notification, so a reopened chat reads as it did live.
 *
 * A child resumed by a later call (`subagent {sessionID}`) holds several runs
 * in one session; a run is the steps under ONE call. Its figures count the
 * child session ITSELF — a grandchild's steps belong to the grandchild's own
 * run (pi's `turnTotalTokens` counts the child's turn only).
 */
import type { TaskNotification } from '../../shared/types'
import type { TokenUsage_Info } from './protocol-v2/openapi'

/** A terminal notification's `summary` cap (characters), as pi's. */
export const TASK_SUMMARY_MAX = 100

/** The summary of a run a later call took over (opencode steers a RUNNING child with a `sessionID` call). */
export const SUPERSEDED_SUMMARY = 'continued by a later call'

/** The metric pi reports as `totalTokens`: what the child read fresh plus what it wrote and reasoned. */
export function tokenTotal(tokens: TokenUsage_Info): number {
  return tokens.input + tokens.output + tokens.reasoning
}

export function taskSummary(text: string | undefined): string {
  return (text ?? '').slice(0, TASK_SUMMARY_MAX)
}

export type RunUsage = NonNullable<TaskNotification['usage']>
