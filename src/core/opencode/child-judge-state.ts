/**
 * What the auto-mode judge knows about each opencode subagent CHILD session
 * (ADR-088 D1 / ADR-091 §4, the pi `childHooks` parity): the child's own
 * assistant trajectory, the outcomes of its calls and its own denial caps.
 *
 * Keyed by the child's opencode SESSION id — the session that raised the ask
 * or emitted the step — never by the owner call id: a resumed child runs under
 * several calls and a grandchild's owner is a call made inside the child. The
 * mapper owns the call→child link (`subagent-started`); this class keeps a copy
 * of it so a child's outputs (which carry only their owner CALL id) resolve to
 * the right child. Lives as long as the OpencodeSession, so a resumed child's
 * judge still sees what it did before.
 */
import type { ChatMessage } from '../../shared/types'
import { AutoModeDenialTracker } from '../automode/denial-tracker'
import { recordToolOutcome, type ToolOutcome } from '../automode/ground-truth'
import { recordTrajectoryMessage } from '../automode/trajectory'

export interface ChildJudgeState {
  /** The child's own assistant messages by id (thinking blocks stripped), bounded. */
  readonly trajectory: Map<string, ChatMessage>
  readonly outcomes: Map<string, ToolOutcome>
  readonly denials: AutoModeDenialTracker
}

export class ChildJudgeStates {
  private readonly states = new Map<string, ChildJudgeState>()
  /** subagent call id → the child session it started or resumed. */
  private readonly callToChild = new Map<string, string>()

  /** A subagent call started (or resumed) `childSessionId`. */
  linkCall(toolUseId: string, childSessionId: string): void {
    this.callToChild.set(toolUseId, childSessionId)
  }

  /** The child's state, created on first use. */
  state(childSessionId: string): ChildJudgeState {
    let state = this.states.get(childSessionId)
    if (!state) {
      state = {
        trajectory: new Map(),
        outcomes: new Map(),
        denials: new AutoModeDenialTracker()
      }
      this.states.set(childSessionId, state)
    }
    return state
  }

  /** A child's step, as the mapper emitted it under its owner call. */
  recordMessage(ownerToolUseId: string, message: ChatMessage): void {
    const child = this.callToChild.get(ownerToolUseId)
    if (!child) return
    // The classifier drops thinking blocks; they would only cost memory here.
    const content = message.content.filter((block) => block.type !== 'thinking')
    recordTrajectoryMessage(
      this.state(child).trajectory,
      content.length === message.content.length ? message : { ...message, content }
    )
  }

  /** A child's tool call settled (its result, a judge block, a user reject). */
  recordOutcome(childSessionId: string, toolUseId: string, outcome: ToolOutcome): void {
    recordToolOutcome(this.state(childSessionId).outcomes, toolUseId, outcome)
  }

  /** The outcome of a child call, by the call's OWNER (the mapper's tool-result carries it). */
  recordOutcomeByOwner(ownerToolUseId: string, toolUseId: string, outcome: ToolOutcome): void {
    const child = this.callToChild.get(ownerToolUseId)
    if (child) this.recordOutcome(child, toolUseId, outcome)
  }
}
