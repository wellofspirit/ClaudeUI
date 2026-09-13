import { isImageMediaType } from '../../shared/types'
import type { AskForApproval } from './protocol/v2/AskForApproval'
import type { ApprovalsReviewer } from './protocol/v2/ApprovalsReviewer'
import type { SandboxMode } from './protocol/v2/SandboxMode'
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy'
import type { UserInput } from './protocol/v2/UserInput'
import { codexSandboxPolicy } from './settings'

/**
 * The mode -> native-policy table and the turn-input mapping, shared by the two
 * things that drive a Codex thread: {@link CodexSession} (the interactive
 * session) and the dispatcher's headless Codex TARGET (ADR-033 slice H).
 *
 * Lifted here rather than exported from CodexSession.ts because the dispatcher
 * cannot import that module — CodexSession.ts imports the dispatcher (for
 * `crossEngineDispatcher`/`crossEngineDispatchAvailable`), so the edge has to
 * run this way or it is a require-cycle. A LEAF module by construction: its
 * only non-type import is `./settings`, itself a leaf.
 */

/** Inline image attachments on a prompt — Codex takes base64 PNG/JPEG/GIF/WebP only. */
export type CodexAttachments = Array<{ mediaType: string; base64Data: string }>

/** One row of {@link CODEX_TURN_POLICY}. */
export interface CodexModePolicy {
  approvalPolicy: AskForApproval
  sandbox: SandboxMode
  approvalsReviewer: ApprovalsReviewer
}

/**
 * Per-turn native policy. Codex EXECUTES, ClaudeUI DECIDES (ADR-066 slice 3):
 * every turn but `auto` runs `untrusted`, the one policy the pinned binary asks
 * before running anything (docs/codex-spike.md, "Native approval surface probe"
 * answer B), so every command and file change arrives as a server request for
 * ClaudeUI's own permission engine to answer. `auto` is the exception — it hands
 * review to Codex's native `auto_review` subagent under `on-request`, and only
 * what that subagent escalates reaches us, gated exactly like `default`.
 *
 * The sandbox is the containment floor, not the decision: an ACCEPTED command
 * runs unsandboxed on this wire regardless (same probe, "Other observations").
 */
export const CODEX_TURN_POLICY: Record<string, CodexModePolicy> = {
  plan: { approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' },
  default: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user' },
  acceptEdits: {
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    approvalsReviewer: 'user'
  },
  auto: {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    approvalsReviewer: 'auto_review'
  }
}

/** The native policy a shared permission mode maps onto. Unknown modes fail toward asking. */
export function codexModePolicy(mode: string): CodexModePolicy {
  return CODEX_TURN_POLICY[mode] ?? CODEX_TURN_POLICY.default
}

/** {@link codexModePolicy} in the shape `turn/start` takes (a POLICY, not a mode). */
export function codexTurnPolicy(mode: string): {
  approvalPolicy: AskForApproval
  sandboxPolicy: SandboxPolicy
  approvalsReviewer: ApprovalsReviewer
} {
  const { approvalPolicy, sandbox, approvalsReviewer } = codexModePolicy(mode)
  return { approvalPolicy, sandboxPolicy: codexSandboxPolicy(sandbox), approvalsReviewer }
}

/** Codex takes inline images only, and only well-formed base64 of one. */
export function assertCodexAttachments(attachments?: CodexAttachments): void {
  if (
    attachments?.some(
      (attachment) =>
        !isImageMediaType(attachment.mediaType) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.base64Data)
    )
  )
    throw new Error('Codex accepts inline PNG/JPEG/GIF/WebP image attachments only')
}

/**
 * The one input mapping every transport uses — `turn/start` and `turn/steer`
 * take the same `UserInput[]`, so a divergence here would be a queued message
 * that reaches the model differently from a typed one (and a dispatched task
 * differently from either).
 */
export function codexTurnInput(prompt: string, attachments?: CodexAttachments): UserInput[] {
  assertCodexAttachments(attachments)
  return [
    { type: 'text', text: prompt, text_elements: [] },
    ...(attachments ?? []).map((attachment) => ({
      type: 'image' as const,
      url: `data:${attachment.mediaType};base64,${attachment.base64Data}`
    }))
  ]
}
