export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

/**
 * The native `item/tool/requestUserInput` question card, which has no shared
 * analogue. Commands and file changes are gated by ClaudeUI's own permission
 * engine (ADR-066 / slice 3) and render through the standard approval card, so
 * their `PendingApproval` carries no engine-specific payload at all.
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
  guardianOverride?: undefined
}

/**
 * A guardian denial the human may still reverse (ADR-067, 2026-09-12). There is
 * no native server request behind it: the auto-review subagent already answered
 * for us, so this card is bound to the DECLINED item's `toolUseId` and its
 * `allow` sends `thread/approveGuardianDeniedAction`. It carries no questions
 * and no decision vocabulary, which is what tells the two payloads apart.
 */
export interface CodexGuardianOverride {
  guardianOverride: true
  questions?: undefined
  decisions?: undefined
  routingId?: undefined
}

/** Every engine-specific approval payload Codex still produces. */
export type CodexApprovalPayload = CodexApprovalChoices | CodexGuardianOverride

/**
 * Explicit session overrides only. Absence preserves native user
 * configuration. Approval/sandbox/reviewer are NOT settable: ClaudeUI derives
 * them from the session's shared PermissionMode on every turn.
 */
export interface CodexSettings {
  model?: string
  effort?: string
  /**
   * The vault ChatGPT account this session is PINNED to (ADR-068 §2), stored in
   * the same `codex_session_overrides.settings_json` blob as the two above — a
   * new key, not a schema migration.
   *
   * Three states, all load-bearing: a string pins that account, an explicit
   * `null` clears the pin so the session follows whichever account is active,
   * and an absent key changes nothing. Unlike model and effort this is NOT a
   * native thread setting — it never reaches `thread/settings/update`; it
   * decides which token `account/login/start {type:'chatgptAuthTokens'}` carries.
   */
  accountId?: string | null
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
  /**
   * The vault account this session is PINNED to, or null when it follows the
   * active account (ADR-068 §2).
   *
   * It cannot be derived from `SessionStatus.account.accountId`: a session that
   * follows the active account carries that same id, so the two states are
   * indistinguishable there and the picker would read "pinned" for everybody.
   */
  pinnedAccountId: string | null
}

/**
 * One thread a Codex delete will remove, and what the user is told about it.
 *
 * `depth` is the distance from the thread the user clicked (0 for that thread),
 * so a fork of a fork is 2. `live` means a process still holds the thread and
 * the walk has to stop it first — the native delete is refused while anything
 * owns the thread.
 */
export interface CodexDeleteNode {
  threadId: string
  /** The sidebar's title when the listing knows the thread; otherwise null. */
  title: string | null
  live: boolean
  depth: number
}

/**
 * What deleting one Codex session actually removes.
 *
 * A native delete is refused while any fork still references the thread's
 * history, so deleting a branched session means deleting its whole subtree,
 * leaf-first. `order` is that sequence — deepest first, the clicked thread
 * last — and `nodes` is the same set with what the confirmation has to show.
 */
export interface CodexDeletePlan {
  nodes: CodexDeleteNode[]
  order: string[]
}

// ── Codex's own configuration (ADR-068 §6, Slice 5a) ────────────────────────

/**
 * A JSON value as it crosses the config boundary. Structurally the same as the
 * generated `serde_json/JsonValue`, restated here so the shared API surface —
 * which the web client and the preload both import — does not pull the whole
 * generated protocol tree into the renderer bundle.
 */
export type CodexConfigValue =
  null | boolean | number | string | CodexConfigValue[] | { [key: string]: CodexConfigValue }

/**
 * One read of Codex's `config.toml` through the app-server (`config/read` with
 * layers). ClaudeUI never parses TOML: this IS the parse.
 *
 * `user` is the BASE user layer's own table — the profile-less `user` layer, the
 * file at `file`. It is the page's "changed from default" oracle: a row is
 * modified exactly when its key path is present here, which is what makes Reset
 * a removal (probe (c), `docs/codex-spike.md`).
 *
 * `effective` is the merged view every layer produced, so a row can show what it
 * falls back to when the user's file says nothing.
 *
 * `version` is the base user layer's optimistic-concurrency token: every write
 * echoes it, and a write that does not match is refused rather than clobbering
 * an edit made outside ClaudeUI.
 */
export interface CodexConfigSnapshot {
  version: string
  /** Absolute path to the user's `config.toml` — the write target. */
  file: string
  /**
   * The selected profile-v2 layer's name when one is active, else null. Shown
   * (never written) in the Managed group, because a profile layer overrides the
   * very rows this page draws.
   */
  profile: string | null
  user: Record<string, CodexConfigValue>
  effective: Record<string, CodexConfigValue>
  /** Which layer each effective key came from, keyed by key path. */
  origins: Record<string, { layer: string; version: string }>
}

/** One key path to set, or — with `value: null` — to REMOVE (probe (c)). */
export interface CodexConfigEdit {
  keyPath: string
  value: CodexConfigValue | null
}

/**
 * The outcome of a `config.toml` write, discriminated on `status`.
 *
 * Deliberately NOT an `ok` flag: the preload and web `unwrap` helpers treat ANY
 * object carrying an `ok` key as the IPC transport envelope (`{ ok, data, error
 * }`) and hand the renderer its `data` — so a `{ ok: true, … }` result arrived as
 * `undefined` and a `{ ok: false }` refusal was thrown as a generic transport
 * failure (seen live on 2026-09-14: three page errors and a poisoned write
 * queue). `codex-config.test.ts` pins the absence of that key.
 *
 *  · `ok` — written. `snapshot` is the config as it stands AFTER the write, read
 *    on the same app-server child that performed it: a settings click costs ONE
 *    process start rather than two, and the page cannot land on a third state
 *    between a separate write and a separate read.
 *  · `version-conflict` — the file moved under us since the read. A NORMAL
 *    outcome, not a user error: the store re-reads and says so once.
 *  · `refused` — the app-server rejected the edit (unknown key, invalid value,
 *    a managed/requirements-locked key). `message` is the native sentence,
 *    verbatim, because only Codex knows why. Never contains token material.
 *  · `unavailable` — no Codex binary, or the transport broke.
 */
export type CodexConfigWriteResult =
  | { status: 'ok'; version: string; snapshot: CodexConfigSnapshot }
  | { status: 'version-conflict' }
  | { status: 'refused'; message: string }
  | { status: 'unavailable' }

/**
 * The compiled Bash-rule file ClaudeUI owns under `$CODEX_HOME/rules/`
 * (ADR-067). Read-only status for the Codex page's Managed group; the Recompile
 * action is what writes.
 */
export interface CodexRulesStatus {
  path: string
  /** How many `prefix_rule` lines the current Claude rules compile to. */
  rules: number
  /** How many of the user's rules could not be expressed as an argv prefix. */
  skipped: number
  /** The file's mtime, ISO 8601, or null when it has never been written. */
  syncedAt: string | null
  /** The file on disk is byte-identical to what ClaudeUI would write now. */
  upToDate: boolean
}

/**
 * One open of the Codex settings page: the config snapshot and the compiled
 * rules status, read together because both are what the page needs before it
 * can draw a row, and two channels would be two round trips for one card set.
 *
 * `config` is null when Codex is not installed or the read failed; `error` then
 * says which, and the page renders its self-gating row rather than empty
 * controls (the pi/opencode `PaneShell` convention).
 */
export interface CodexConfigRead {
  config: CodexConfigSnapshot | null
  rules: CodexRulesStatus
  /**
   * The Claude MCP list Codex threads inherit (ADR-068 §5, Slice 4). Names
   * only — the page states how many servers a Codex thread will start with and
   * links to the MCP dialog; the definitions are edited there, not here.
   * `skipped` are the SSE servers Codex has no transport for.
   */
  mcp: { inherited: string[]; skipped: string[] }
  error?: string
}
