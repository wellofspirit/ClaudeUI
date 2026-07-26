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
