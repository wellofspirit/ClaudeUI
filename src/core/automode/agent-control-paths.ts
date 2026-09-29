/**
 * Agent-control paths (ADR-084 §3): files and directories whose contents steer
 * what an agent, git, or the editor does next — git's own directory and hooks,
 * agent instructions and settings, editor tasks that run on folder open, MCP
 * server lists, the engines' own config. An edit to one of them is not an
 * ordinary edit: it can arm code execution (`.git/config`'s `core.fsmonitor`,
 * a hook), rewrite future sessions' instructions, or widen the agent's own
 * permissions. The edit-auto-accepting bases therefore ask for these instead
 * of allowing them — in auto mode that ask reaches the judge, in plain
 * acceptEdits it reaches the human. cli.js does the same for its acceptEdits
 * fast path (`DANGEROUS_DIRECTORIES`/`DANGEROUS_FILES` raise a safety check;
 * docs/protocol-cc/14-auto-mode-classifier.md §3 step 2).
 *
 * ONE list, two consumers:
 *  - pi (and Codex, which shares pi's evaluator) call {@link isAgentControlPath}
 *    from the acceptEdits mode base (`pi/permission-engine.ts`);
 *  - opencode evaluates its ruleset server-side, so the list is rendered into
 *    opencode `edit` ask patterns by {@link agentControlEditPatterns}
 *    (`opencode/permission-ruleset.ts`).
 *
 * Pure: no fs, no platform lookups — it must decide the same way wherever the
 * command runs (remote hosts included).
 */
import path from 'node:path'

/** Directories matched as ANY path component, at any depth, including as the
 *  last component (a linked worktree's `.git` is a FILE pointing at the gitdir). */
export const AGENT_CONTROL_DIRS: readonly string[] = [
  '.git',
  '.claude',
  '.husky',
  '.githooks',
  '.vscode',
  '.devcontainer',
  '.opencode',
  // pi's project config dir (vendor/pi-cli/docs/configuration.md "Project
  // `.pi` directory": settings, SYSTEM.md, extensions, skills, prompts).
  '.pi',
  // Agent Skills location pi discovers from cwd up to the repo root
  // (vendor/pi-cli/docs/skills.md) — skills are instructions future sessions load.
  '.agents'
]

/** File names matched as the LAST path component, at any depth. */
export const AGENT_CONTROL_FILES: readonly string[] = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  // Replaces AGENTS.md/CLAUDE.md in its directory for pi
  // (vendor/pi-cli/docs/configuration.md "Context files").
  'AGENTS.override.md',
  '.mcp.json',
  'opencode.json',
  'opencode.jsonc',
  // The single-file form of `.devcontainer/` — same run-on-open mechanism.
  '.devcontainer.json'
]

const DIR_SET = new Set(AGENT_CONTROL_DIRS.map(foldName))
const FILE_SET = new Set(AGENT_CONTROL_FILES.map(foldName))

/**
 * A Windows 8.3 short-name alias (`GIT~1`, `CLAUDE~1`, `AGENTS~1.MD`). NTFS
 * resolves it to the long name, so `GIT~1/config` IS `.git/config` on a volume
 * with short names enabled. Mapping an alias back to its long name needs the
 * filesystem, so ANY alias-shaped component is treated as a match — fail toward
 * asking; real repositories almost never carry such names. Same shape cli.js
 * uses (`/^([^.~]{1,6})~\d+(\.[^.]{1,3})?$/`).
 */
const SHORT_NAME_ALIAS = /^[^.~]{1,6}~\d+(\.[^.]{1,3})?$/

/**
 * Fold one path component to the spelling the filesystem treats as the same
 * entry, so a different spelling cannot slip past the list:
 *  - an NTFS alternate-data-stream suffix is dropped (`CLAUDE.md:x`,
 *    `.git::$INDEX_ALLOCATION` — both name the entry before the colon);
 *  - trailing dots and spaces are dropped (Win32 path normalisation strips
 *    them: `.git.` opens `.git`);
 *  - case is folded on EVERY platform (NTFS and APFS are case-insensitive by
 *    default; over-matching on a case-sensitive Linux volume only asks more),
 *    including the two non-ASCII letters whose uppercase is an ASCII one
 *    (U+0131 dotless i → I, U+017F long s → S), as cli.js does.
 * A drive component (`C:`) folds to a single letter and so never matches.
 */
function foldName(component: string): string {
  const colon = component.indexOf(':')
  const base = colon === -1 ? component : component.slice(0, colon)
  return base
    .replace(/[. ]+$/, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ſ/g, 's')
}

/**
 * True when `filePath` — relative or absolute, `/` or `\` separated — names an
 * agent-control path or something inside one.
 *
 * Callers should pass the path RELATIVE to the session's working directory
 * where they can: an absolute path carries the cwd's own ancestors, and a
 * session running inside a ClaudeUI worktree (`<repo>/.claude/worktrees/<name>`)
 * would otherwise match `.claude` on every edit. `..` and `.` components are
 * ignored, so a relative path that climbs out still matches on what it names.
 */
export function isAgentControlPath(filePath: string): boolean {
  const components = filePath.split(/[\\/]+/).filter((c) => c.length > 0)
  const last = components.length - 1
  return components.some((raw, i) => {
    if (SHORT_NAME_ALIAS.test(raw)) return true
    const name = foldName(raw)
    if (name === '') return false
    return DIR_SET.has(name) || (i === last && FILE_SET.has(name))
  })
}

/**
 * {@link isAgentControlPath} for a tool's path argument, resolved against the
 * session's working directory — the one entry point both engines' edit gates
 * use (pi's acceptEdits base, opencode's auto-mode edit gate).
 *
 * The path is resolved to an absolute one first (relative paths against
 * `cwd`), so `..` segments and other-drive paths keep the ancestors they name.
 * A target INSIDE cwd is then matched relative to cwd: a session running in a
 * ClaudeUI worktree (`<repo>/.claude/worktrees/<name>`) must not match
 * `.claude` on every edit. A target OUTSIDE cwd is matched on its absolute
 * path, so `../../settings.json` from that worktree — the parent repo's
 * `.claude/settings.json` — still matches.
 *
 * Path semantics (win32 vs posix) follow `cwd`'s own syntax, not the host's,
 * as `pi/permission-engine.ts`'s matcher does. Without a cwd the path is
 * matched as given (an absolute one may then over-match on its ancestors —
 * asking, the safe direction).
 */
export function isAgentControlTarget(filePath: string, cwd: string | undefined): boolean {
  if (!cwd) return isAgentControlPath(filePath)
  const flavor = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') ? path.win32 : path.posix
  const raw = flavor === path.win32 ? filePath : filePath.replaceAll('\\', '/')
  const absolute = flavor.isAbsolute(raw) ? flavor.normalize(raw) : flavor.resolve(cwd, raw)
  const relative = flavor.relative(cwd, absolute)
  const outside =
    relative === '..' ||
    relative.startsWith('../') ||
    relative.startsWith('..\\') ||
    flavor.isAbsolute(relative)
  return isAgentControlPath(outside ? absolute : relative)
}

/**
 * The list rendered as opencode `edit` permission patterns.
 *
 * opencode's edit/write/apply_patch tools ask with the path RELATIVE to the
 * project worktree (`path.relative(instance.worktree, filePath)` —
 * vendor/opencode-src/packages/opencode/src/tool/edit.ts:104/147,
 * write.ts:56, apply_patch.ts:205), which is absolute only when the file sits
 * on another drive, and `../`-prefixed when it sits outside the worktree.
 * `Wildcard.match` (vendor/opencode-src/packages/core/src/util/wildcard.ts)
 * normalises `\` → `/` on both sides, turns `*` into `.*` (which crosses `/`),
 * anchors the whole string, and is case-insensitive on win32 ONLY. So each
 * name needs a bare form (`N`) and a star-slash-prefixed form (`*` + `/N`) to
 * cover the root and every depth (relative, `../`, and absolute alike), and
 * each directory the same pair with a `/*` suffix for its contents.
 *
 * What the rendering cannot express, and {@link isAgentControlPath} does:
 * case-insensitivity off Windows, 8.3 aliases, trailing dots, ADS suffixes.
 */
export function agentControlEditPatterns(): string[] {
  return [
    ...AGENT_CONTROL_DIRS.flatMap((d) => [d, `${d}/*`, `*/${d}`, `*/${d}/*`]),
    ...AGENT_CONTROL_FILES.flatMap((f) => [f, `*/${f}`])
  ]
}
