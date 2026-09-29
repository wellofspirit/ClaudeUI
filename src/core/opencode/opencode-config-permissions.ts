/**
 * ADR-085 S4 — a read-only model of the opencode config that decides a task
 * subagent's permission ruleset, so the spawn-time asks
 * (`subagent-permissions.ts`) never widen something the user's own opencode
 * config denies, and cover the agents it defines inline.
 *
 * What opencode computes for an agent (`vendor/opencode-src/packages/opencode/
 * src/agent/agent.ts`): `defaults`, the agent's native rules, then `user` —
 * the merged TOP-LEVEL `permission` (~138) — then the agent's own merged
 * `agent.<name>` config (~272-293). Both come out of `config/config.ts`, which
 * merges the config sources in order with remeda's `mergeDeep` (objects merge
 * key-wise and recursively, any other value REPLACES):
 *
 *  1. the global config dir: `config.json`, `opencode.json`, `opencode.jsonc`
 *     (`loadGlobal` ~260-275);
 *  2. the project files `opencode.json`, `opencode.jsonc` (~419-423 —
 *     `ConfigPaths.files`, jsonc after json);
 *  3. per config directory (~438-475), global dir first: its `opencode.json`/
 *     `.jsonc` when it is a `.opencode` dir or `OPENCODE_CONFIG_DIR`, then its
 *     `{agent,agents}/**\/*.md` files (~474);
 *  4. `OPENCODE_CONFIG_CONTENT` (~482-490 — ClaudeUI's own asks), and last the
 *     top-level legacy `tools` folded into `permission` (~567-577).
 *
 * Read here, best-effort per file (a missing or unparsable file contributes
 * nothing): the global dir's three files; `<cwd>/opencode.json(c)`; the global
 * dir's agent md files and — when `OPENCODE_CONFIG_DIR` is set — its config
 * files again, at step 3's position; `<cwd>/.opencode/opencode.json(c)`; then
 * `<cwd>/.opencode`'s agent md files. NOT read (residual — the parent-side
 * `task:<name>` backstop over `GET /agent` covers what they change): config
 * files in parent directories up to the worktree, `OPENCODE_CONFIG`,
 * `OPENCODE_PERMISSION`, `~/.opencode`, remote/account/managed config, and
 * `{env:…}`/`{file:…}` substitutions.
 *
 * Every source is normalized the way the vendor decodes it: a bare-string
 * `permission` is `{"*": <action>}` (`packages/core/src/v1/config/permission.ts`
 * `normalizeInput`), and an agent entry's legacy `tools` map becomes
 * permission keys — `false` → `deny`, `true` → `allow`, `write`/`edit`/`patch`
 * → `edit` — UNDER its explicit `permission` (`packages/core/src/v1/config/
 * agent.ts` `normalize` ~62-80, `Object.assign(tools-derived, permission)`).
 */

import * as path from 'node:path'
import { opencodeConfigDir } from './opencode-config'
import { jsoncParseSafe, safeRead } from './opencode-jsonc-io'
import {
  builtinAgent,
  listAgents,
  readAgent,
  type OpencodeAgentDetail,
  type OpencodeAgentMode
} from './opencode-agents'
import type { OpencodeAction } from './permission-compiler'
import type { SubagentScanEntry } from './subagent-permissions'

/** An opencode `permission` object: key → action, or key → {pattern → action}. */
export type OpencodePermissionConfig = Record<string, unknown>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isAction(value: unknown): value is OpencodeAction {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

/**
 * remeda's `mergeDeep` (what `config/config.ts` merges sources with): `{...a,
 * ...b}`, except that a key whose value is a plain object on BOTH sides merges
 * recursively. Existing keys keep their position (key order is rule order).
 */
export function mergeDeep(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const prior = out[key]
    out[key] = isPlainObject(prior) && isPlainObject(value) ? mergeDeep(prior, value) : value
  }
  return out
}

/** `normalizeInput`: a bare action is `{"*": action}`; an object is itself; anything else nothing. */
export function normalizePermissionInput(value: unknown): OpencodePermissionConfig | undefined {
  if (isAction(value)) return { '*': value }
  return isPlainObject(value) ? value : undefined
}

/** The legacy `tools` map as permission keys (`false` → deny; write/edit/patch → `edit`). */
export function toolsToPermission(tools: unknown): Record<string, OpencodeAction> {
  const out: Record<string, OpencodeAction> = {}
  if (!isPlainObject(tools)) return out
  for (const [tool, enabled] of Object.entries(tools)) {
    if (typeof enabled !== 'boolean') continue
    const action: OpencodeAction = enabled ? 'allow' : 'deny'
    if (tool === 'write' || tool === 'edit' || tool === 'patch') out.edit = action
    else out[tool] = action
  }
  return out
}

/**
 * One source's permission for an agent entry or the top level: the
 * tools-derived keys first, the explicit `permission` over them (an explicit
 * key wins and keeps the tools-derived key's position — `Object.assign`).
 */
export function withToolsPermission(permission: unknown, tools: unknown): OpencodePermissionConfig {
  return { ...toolsToPermission(tools), ...(normalizePermissionInput(permission) ?? {}) }
}

/** An agent's merged own config (only the fields that decide its asks). */
interface AgentConfig {
  mode?: OpencodeAgentMode
  disable?: boolean
  permission: OpencodePermissionConfig
}

function isMode(value: unknown): value is OpencodeAgentMode {
  return value === 'primary' || value === 'subagent' || value === 'all'
}

/** What the scan hands `buildSubagentPermissionConfig`. */
export interface OpencodeConfigScan {
  /** The merged top-level `permission` (the vendor's `user` rules), tools folded in. */
  userPermission: OpencodePermissionConfig
  /** Every agent the config sources define, with its merged own permission. */
  agents: SubagentScanEntry[]
}

function readConfigFile(file: string): Record<string, unknown> | undefined {
  const text = safeRead(file)
  if (text === undefined) return undefined
  const parsed = jsoncParseSafe(text)
  return isPlainObject(parsed) ? parsed : undefined
}

/**
 * Scan the opencode config for `cwd` (see the module doc for what is read and
 * in which order). Per-file best-effort; a failing agent md read marks that
 * agent `unreadable` (the caller decides what that means).
 */
export function scanOpencodeConfig(cwd: string): OpencodeConfigScan & { unreadable: Set<string> } {
  const globalDir = opencodeConfigDir()
  let topPermission: Record<string, unknown> = {}
  let topTools: Record<string, unknown> = {}
  const agents = new Map<string, AgentConfig>()
  const unreadable = new Set<string>()

  const mergeAgent = (name: string, entry: Partial<AgentConfig>): void => {
    const prior = agents.get(name) ?? { permission: {} }
    agents.set(name, {
      mode: entry.mode ?? prior.mode,
      disable: entry.disable ?? prior.disable,
      permission: mergeDeep(prior.permission, entry.permission ?? {})
    })
  }

  const applyFile = (file: string): void => {
    const config = readConfigFile(file)
    if (!config) return
    const permission = normalizePermissionInput(config.permission)
    if (permission) topPermission = mergeDeep(topPermission, permission)
    if (isPlainObject(config.tools)) topTools = mergeDeep(topTools, config.tools)
    if (!isPlainObject(config.agent)) return
    for (const [name, value] of Object.entries(config.agent)) {
      if (!isPlainObject(value)) continue
      mergeAgent(name, {
        mode: isMode(value.mode) ? value.mode : undefined,
        disable: typeof value.disable === 'boolean' ? value.disable : undefined,
        permission: withToolsPermission(value.permission, value.tools)
      })
    }
  }

  // The md files that exist per scope, by agent name (listAgents scans both).
  const mdScopes = new Map(
    listAgents(cwd).flatMap((a) => (a.scope !== null ? [[a.name, a.scope] as const] : []))
  )
  const mdNames = [...mdScopes.keys()]
  const applyMd = (scope: 'global' | 'project'): void => {
    for (const name of mdNames) {
      let detail: OpencodeAgentDetail | null
      try {
        detail = readAgent(name, scope, cwd)
      } catch {
        unreadable.add(name)
        continue
      }
      if (!detail || detail.scope !== scope) continue // no file for it in this scope
      mergeAgent(name, {
        // The md's mode falls back to the built-in / `all` when the file names
        // none, so a config `mode` it does not restate can be overridden here
        // (over-inclusion only: at worst an extra ask on an agent no task uses).
        mode: detail.mode,
        disable: detail.disabled ? true : undefined,
        permission: withToolsPermission(detail.permission, detail.tools)
      })
    }
  }

  for (const f of ['config.json', 'opencode.json', 'opencode.jsonc'])
    applyFile(path.join(globalDir, f))
  for (const f of ['opencode.json', 'opencode.jsonc']) applyFile(path.join(cwd, f))
  if (process.env.OPENCODE_CONFIG_DIR) {
    for (const f of ['opencode.json', 'opencode.jsonc']) applyFile(path.join(globalDir, f))
  }
  applyMd('global')
  for (const f of ['opencode.json', 'opencode.jsonc']) applyFile(path.join(cwd, '.opencode', f))
  applyMd('project')

  const entries: SubagentScanEntry[] = []
  const names = new Set([...agents.keys(), 'general', 'explore'])
  for (const name of names) {
    const builtin = builtinAgent(name)
    const config = agents.get(name)
    entries.push({
      name,
      kind: builtin ? 'builtin' : 'custom',
      mode: config?.mode ?? builtin?.mode ?? 'all',
      ...(config?.disable ? { disabled: true } : {}),
      scope: mdScopes.get(name) ?? null,
      ...(config ? { permission: config.permission } : {})
    })
  }
  return {
    // config.ts ~567-577: the merged top-level tools under the merged permission.
    userPermission: mergeDeep(toolsToPermission(topTools), topPermission),
    agents: entries,
    unreadable
  }
}
