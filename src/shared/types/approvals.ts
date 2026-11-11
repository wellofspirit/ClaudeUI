export interface PermissionSuggestion {
  type: string // 'addRules' | 'replaceRules' | 'removeRules' | 'setMode' | 'addDirectories' | 'removeDirectories'
  rules?: { toolName: string; ruleContent?: string }[]
  behavior?: string // 'allow' | 'deny' | 'ask'
  destination: string // 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  mode?: string
  directories?: string[]
}

export interface PendingApproval {
  requestId: string
  /**
   * Set by the dispatcher when it puts back a card a parent's disconnect cleared (ADR-105
   * §5): the user has been told about this ask already, so it raises no new attention and
   * no notification.
   */
  reRaised?: true
  /**
   * cli.js-assigned tool_use id for the invocation being prompted. The
   * correct binding key between an approval and its tool_use block —
   * matching on toolName+input alone is lossy (repeated identical calls
   * all collapse to the same approval and get the UI shown on every
   * historical card).
   */
  toolUseId?: string
  toolName: string
  input: Record<string, unknown>
  /**
   * opencode only: the matched argument(s) the engine evaluated its permission
   * ruleset against (`permission.asked`'s `patterns` — the command, path, or
   * subagent type). Needed host-side to re-match the ask against the
   * user-authored rules, which outrank the auto-mode classifier (ADR-023 G9).
   */
  patterns?: string[]
  /**
   * opencode only: the patterns opencode would remember on an `always` reply
   * (`permission.asked`'s `always` — for a shell call the arity prefix + ` *`
   * per statement, `["*"]` for edit / webfetch / MCP). ClaudeUI never sends
   * `always` (ADR-085 S2); the host session-allow set is keyed by these
   * instead (`core/opencode/session-allows.ts`).
   */
  always?: string[]
  /**
   * opencode only: set on a CHILD (task subagent) ask — the child's opencode
   * session id and the parent `task` part's callID (the `childSessions` value).
   * Absent on an own-session ask. ADR-085 S2 carries it (and logs it); S4
   * evaluates child asks against the parent's rules on this marker.
   */
  subagent?: { sessionId: string; parentToolUseId: string }
  /**
   * pi (ADR-089): set on a host-run child's ask — WHICH agent proposes the
   * action, so the card can say so (the label is the agent's name, else its
   * task description, sanitized). An "allow for this session" on such a card
   * still allows for the whole session, children included (Claude Code parity).
   * Also set on a pi/opencode dispatch target's forwarded ask (ADR-091 §3): the
   * target's session id, its model as the label, `dispatch:<engine>` as the type.
   */
  agent?: { agentId: string; label: string; subagentType: string }
  /**
   * Set when the card holds an auto-mode judge BLOCK for the user (ADR-091 §3;
   * pi, opencode and their dispatch targets): the card offers Keep blocked /
   * Approve anyway, never a standing rule. `expiresAt` (epoch ms) is when the
   * host resolves it as Keep blocked and withdraws the card. Engine-neutral.
   */
  autoModeBlock?: { expiresAt: number }
  suggestions?: PermissionSuggestion[]
  decisionReason?: string
  blockedPath?: string
}

export type ApprovalDecision = 'allow' | 'allowForSession' | 'deny'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto'

// ---------------------------------------------------------------------------
// Claude permissions (allow/deny/ask rules from settings.json files)
// ---------------------------------------------------------------------------

export interface ClaudePermissions {
  allow: string[]
  deny: string[]
  ask: string[]
  additionalDirectories: string[]
  defaultMode: string | undefined
  /**
   * `"disable"` when this settings scope forbids auto mode outright. cli.js
   * honours it at both `permissions.disableAutoMode` and the top level
   * (`disableAutoMode==="disable"||permissions?.disableAutoMode==="disable"`),
   * so the loader normalizes both into this one field. Any other value — and
   * absent — means auto is permitted.
   *
   * Optional, unlike its siblings: absent and `undefined` mean the same thing
   * here, so requiring it would only force every construction site to spell out
   * a value that carries no information.
   */
  disableAutoMode?: string | undefined
  /**
   * `permissions.blockReadsOutsideWorkingDirectories` is `true` in this scope (cli.js: true in
   * any source wins): file-tool reads outside the working directories are refused in every
   * mode. Present only when true, so an unset scope compares equal to the old shape.
   */
  blockReadsOutsideWorkingDirectories?: boolean
}

export type PermissionScope = 'user' | 'project' | 'local'

/**
 * Claude Code's workspace trust for a cwd (`~/.claude.json#projects[root].hasTrustDialogAccepted`).
 * Untrusted, cli.js drops every allow rule and added directory from the project and local scopes.
 */
export interface WorkspaceTrust {
  /** The directory cli.js records trust on: the canonical git root (the main checkout for a linked worktree), else the cwd. */
  root: string
  trusted: boolean
  /** The cwd is a linked git worktree; trust is recorded on its main checkout. */
  worktree: boolean
}

// AskUserQuestion tool types
export interface AskUserQuestionOption {
  label: string
  description: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[]
}
