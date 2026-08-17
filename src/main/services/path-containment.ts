import * as path from 'path'

/**
 * True iff `candidate` resolves to a location strictly inside `root`.
 *
 * Both arguments are resolved to absolute paths first, then compared with
 * `path.relative`. Using the relative form (rather than a naive
 * `resolved.startsWith(root)`) makes the check correct for every case that
 * matters for our security boundaries:
 *
 *  - **Windows drive letters + case.** `path.win32.relative` compares drive
 *    letters and folder names case-insensitively, matching NTFS semantics
 *    (`D:\repo` contains `d:\repo\x`).
 *  - **Mixed separators.** git emits forward slashes even on Windows
 *    (`git worktree list --porcelain`); `path.resolve` normalizes them.
 *  - **`..` traversal.** `root/../secret`, `..`, `a/../../x` all resolve to a
 *    relative path that starts with `..`.
 *  - **Sibling-prefix false positives.** `/a/b` does NOT contain `/a/bfoo`
 *    (relative is `../bfoo`, not `foo`) — the classic `startsWith` bug.
 *  - **Cross-drive paths on Windows.** A `D:\` root vs a `C:\` candidate yields
 *    an absolute relative path (`path.isAbsolute(rel)` is true).
 *
 * Root-equal is deliberately NOT considered inside (returns false): a contained
 * artifact must live *under* the root, never be the root itself.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  )
}

/**
 * Characters that disqualify a string from being used as a SINGLE path segment:
 * either separator (so it cannot reach into a sibling directory) or a `..`
 * component (so it cannot climb out of its root).
 */
export const SEGMENT_TRAVERSAL = /[\\/]|\.\./

/**
 * Throw unless `value` is a non-empty, traversal-free single path segment.
 *
 * Use this on every caller-supplied identifier that gets interpolated into a
 * filesystem path (`path.join(root, projectKey, `${sessionId}.jsonl`)`).
 * `isPathInside` guards a *resolved* path; this guards the *segment* before it
 * is joined, which is what the ~/.claude/projects handlers need.
 */
export function assertSafePathSegment(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`)
  if (SEGMENT_TRAVERSAL.test(value) || value.includes('\0')) throw new Error(`Invalid ${label}`)
}

/**
 * The conservative SLUG an id-like path segment must match.
 *
 * Stricter than {@link assertSafePathSegment} on purpose, and used where the
 * caller-supplied value is an IDENTIFIER (`engineId`, `vendorId`, an opencode
 * agent name, an automation id) rather than an arbitrary name the user chose for
 * a file. Two holes the looser check leaves open are why:
 *
 *  - **Windows drive-relative paths.** `C:evil` contains no separator and no
 *    `..`, so it passes the segment check — and `path.join(root, 'C:evil.json')`
 *    on Windows is not what it looks like. The class below excludes `:`.
 *  - **Dot-leading names.** `.bashrc`, `.gitconfig` are legal segments; an id
 *    that starts with a dot is not an id.
 *
 * Traversal itself cannot survive it either: `/`, `\` and a leading `.` are all
 * outside the pattern, so `../..`, `a/../b` and `..` are refused by construction.
 *
 * The vocabulary it has to admit, checked against the real ones rather than
 * guessed: engine ids (`claude`, `opencode`, `pi`), vendor/provider ids
 * (`anthropic`, `openai`, `google`, `local`, `openai-codex`, `github-copilot`,
 * `zen`, …) and opencode agent names — which the settings UI already restricts to
 * `^[a-z0-9-]+$`, while a hand-written `agents/*.md` may legitimately carry `_`
 * or `.`, so both are allowed here.
 */
export const ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** True iff `value` is a safe id-like single path segment. */
export function isSafeIdSegment(value: unknown): value is string {
  return typeof value === 'string' && ID_SEGMENT_RE.test(value)
}

/**
 * Throw unless `value` is a safe id-like path segment.
 *
 * Use it on EVERY caller-supplied identifier that gets interpolated into a
 * filesystem path. Renderer-supplied ids flow into `path.join`, and since the
 * S1b sweep the remote transport is a trigger too: `config:save-engine-config`
 * with `engineId: '../../settings'` would otherwise write `~/.claude/settings.json`
 * — Claude Code's hooks and permissions file, whose contents execute with no
 * approval gate. Same reasoning as `automation-id.ts`, generalised.
 *
 * It is the PERIMETER half of a two-layer guard: the services that build the
 * paths (`ui-config.ts`, `opencode-agents.ts`) re-check containment with
 * {@link isPathInside} at the join itself, so a future caller that forgets this
 * one still cannot escape its root.
 */
export function assertSafeIdSegment(value: unknown, label: string): asserts value is string {
  if (!isSafeIdSegment(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`)
  }
}
