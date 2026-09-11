/** Explicit session overrides only. Absence preserves native user configuration. */
export interface CodexPolicyOptions {
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalsReviewer?: 'user'
}

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export interface CodexApprovalChoices {
  questions?: Array<{
    id: string
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    allowOther: boolean
  }>
  routingId?: string
  decisions: CodexApprovalDecision[]
  unsupportedDecisions: string[]
}

export interface CodexSettings extends CodexPolicyOptions {
  /** Clear saved policy/effort and disconnect an idle root. Model selection and native credential/config files are unchanged. */
  reset?: true
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

/** JSON-native effective values retain granular and future policy representations. */
export interface CodexSessionState {
  overrides?: Omit<CodexSettings, 'reset'>
  approvalPolicy: unknown
  approvalsReviewer: string
  sandbox: unknown
  activePermissionProfile: unknown
  modelProvider: string
  reasoningEffort: string | null
  effortOptions: Array<{ value: string; description: string }>
}
