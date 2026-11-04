/**
 * The opencode 2.x permission key table (ADR-097 §3): which 2.x permission
 * `action` a ClaudeUI (Claude-form) rule targets, and how 2.x spells the
 * `resource` it asks with for that action. Read at the pinned tag
 * (`vendor/opencode-src` @ v2.2.5, `packages/core/src/tool/plugin/*.ts`).
 *
 * | Claude tool                     | 2.x tool id(s)        | action              | resource 2.x asks with                                                    |
 * | ------------------------------- | --------------------- | ------------------- | ------------------------------------------------------------------------- |
 * | Bash                            | shell                 | shell               | one per parsed statement: its source text (`shell/parse.ts`)              |
 * | Read, NotebookRead              | read                  | read                | path: location-relative inside the session dir/worktree, else absolute    |
 * | Edit, MultiEdit, Write, NotebookEdit | edit, write, patch | edit               | same path rule; `patch` asks once with every target                       |
 * | Glob                            | glob                  | glob                | the glob PATTERN argument (not a path)                                    |
 * | Grep                            | grep                  | grep                | the regex PATTERN argument (not a path)                                   |
 * | WebFetch                        | webfetch              | webfetch            | the full URL                                                              |
 * | WebSearch                       | websearch             | websearch           | the search query                                                          |
 * | Task, Agent                     | subagent              | subagent            | the agent id                                                              |
 * | Skill                           | skill                 | skill               | the skill id                                                              |
 * | mcp__s__t / mcp__s / mcp__s__*  | s_t                   | s_t / s_*           | `*` (sanitized `[^a-zA-Z0-9_-]` → `_`, `tool/mcp.ts`)                    |
 * | additionalDirectories           | (any file tool)       | external_directory  | `<dir>/*` of the target's directory, absolute (`file-access.ts`)         |
 * | (none)                          | question              | question            | `*`                                                                       |
 * | (none)                          | opencode.<session\|worktree\|artifact\|schedule>.* | opencode_<tool> | `*` — wholly denied and hidden (`permission-v2.ts` `DIRECT_TOOL_DENY_RULES`); `worktree_remove` asks `edit` |
 * | (none)                          | experimental_image_generate | experimental_image_generate | `providerID/modelID` (the model the call will bill)                  |
 * | (none)                          | execute (Code Mode)   | (never asserted)    | visibility only — `whollyDisabled("execute")`                             |
 * | (none)                          | list/read_mcp_resource| opencode_list_mcp_resources / opencode_read_mcp_resource | server names / `server:uri` |
 *
 * All paths use forward slashes. Matching is `Wildcard.match`: `*` crosses
 * `/`, `?` is one character, a trailing ` *` also matches the bare prefix,
 * case-insensitive on win32 only (`util/wildcard.ts`, ported in `wildcard.ts`).
 *
 * Gone in 2.x (a rule naming them is dropped, never guessed): `list` (LS),
 * `todowrite`, `todoread`, `doom_loop`, `lsp`, `plan_enter`, `plan_exit`,
 * `batch`, `codesearch`, `invalid`. Renamed: `bash` → `shell`, `task` →
 * `subagent`, `write`/`patch`/`apply_patch`/`multiedit` → `edit` (upstream's
 * own migration map, `core/src/v1/config/migrate.ts` `normalizeAction`).
 */

/** The 2.x tool permission actions Claude tool names compile to, in the order rules are listed. */
export const V2_TOOL_ACTIONS = [
  'shell',
  'read',
  'edit',
  'glob',
  'grep',
  'webfetch',
  'websearch',
  'subagent',
  'skill'
] as const

export type V2Action = (typeof V2_TOOL_ACTIONS)[number]

/** Claude tool name → the 2.x permission action its rules compile to. */
export const CLAUDE_TOOL_TO_V2_ACTION: Readonly<Record<string, V2Action>> = {
  Bash: 'shell',
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  Task: 'subagent',
  Agent: 'subagent',
  Skill: 'skill'
}

/** Actions whose resource is a file path (Claude path specifiers are translated for them). */
export const V2_PATH_ACTIONS: ReadonlySet<string> = new Set(['read', 'edit'])

/** 1.x permission keys with no 2.x tool behind them. */
export const V1_DEAD_KEYS: readonly string[] = [
  'list',
  'todowrite',
  'todoread',
  'doom_loop',
  'lsp',
  'plan_enter',
  'plan_exit',
  'batch',
  'codesearch',
  'invalid'
]

/**
 * A 1.x permission key → its 2.x action (upstream's `normalizeAction`), or
 * `null` for a key 2.x has no tool for.
 */
export function v2ActionForV1Key(key: string): string | null {
  if (V1_DEAD_KEYS.includes(key)) return null
  if (key === 'bash') return 'shell'
  if (key === 'task') return 'subagent'
  if (key === 'write' || key === 'patch' || key === 'apply_patch' || key === 'multiedit')
    return 'edit'
  return key
}

/**
 * The built-in 2.x permission ids and tool ids (`tool/plugin/*.ts` names and
 * `permission` options, `file-access.ts`, `mcp-resource.ts`, the `opencode`
 * namespace's tools — Code Mode tools only while `execute` is visible, DIRECT
 * tools since 2.2.0 — Code Mode's `execute`, and `experimental_image_generate`).
 * A server-level MCP ALLOW glob (`s_*`) that matches one of these is never
 * emitted — an allow on `opencode_*` would also grant
 * `opencode_read_mcp_resource`. At v2.2.5 (`tool/plugin/opencode.ts`,
 * `artifact.ts`, `schedule.ts`, `image-generate.ts`).
 */
export const V2_BUILTIN_ACTIONS: readonly string[] = [
  'shell',
  'read',
  'edit',
  'write',
  'patch',
  'glob',
  'grep',
  'webfetch',
  'websearch',
  'subagent',
  'skill',
  'question',
  'external_directory',
  'execute',
  'opencode_list_mcp_resources',
  'opencode_read_mcp_resource',
  'opencode_session_rename',
  'opencode_session_move',
  'opencode_worktree_create',
  'opencode_worktree_list',
  'opencode_worktree_remove',
  'opencode_models',
  'opencode_artifact_create',
  'opencode_artifact_read',
  'opencode_artifact_update',
  'opencode_artifact_delete',
  'opencode_schedule_create',
  'opencode_schedule_list',
  'opencode_schedule_pause',
  'opencode_schedule_resume',
  'opencode_schedule_delete',
  'experimental_image_generate'
]

/** True when some built-in action satisfies `matches` (e.g. a glob test). */
export function isV2BuiltinAction(matches: (action: string) => boolean): boolean {
  return V2_BUILTIN_ACTIONS.some(matches)
}
