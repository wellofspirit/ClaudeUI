export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

/**
 * The ONLY approval shape that still carries a `codex` field: the native
 * `item/tool/requestUserInput` question card, which has no shared analogue.
 * Commands and file changes are gated by ClaudeUI's own permission engine
 * (ADR-066 / slice 3) and render through the standard approval card, so their
 * `PendingApproval` carries no engine-specific payload at all.
 */
export interface CodexApprovalChoices {
  questions: Array<{
    id: string
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    allowOther: boolean
  }>
  routingId?: string
  /** Native replies the card may send for a question — `cancel` only. */
  decisions: CodexApprovalDecision[]
}

/**
 * Explicit session overrides only. Absence preserves native user
 * configuration. Approval/sandbox/reviewer are NOT settable: ClaudeUI derives
 * them from the session's shared PermissionMode on every turn.
 */
export interface CodexSettings {
  model?: string
  effort?: string
}

export interface CodexAuthStatus {
  available: boolean
  authenticated: boolean
  authKind: 'apiKey' | 'chatgpt' | 'amazonBedrock' | null
  error?: string
  catalogError?: string
  modelCount?: number
}

export interface CodexLoginState {
  status: 'idle' | 'starting' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'timed-out'
  verificationUrl?: string
  userCode?: string
}

/** Native state the UI still needs. Policy is ClaudeUI's, so it is not mirrored here. */
export interface CodexSessionState {
  overrides?: CodexSettings
  modelProvider: string
  reasoningEffort: string | null
  effortOptions: Array<{ value: string; description: string }>
}
