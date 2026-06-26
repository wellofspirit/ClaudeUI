/**
 * Encode a cwd into the project-grouping key used across the sidebar.
 *
 * This MUST match Claude Code's on-disk project-dir naming under
 * ~/.claude/projects/ — it replaces every non-alphanumeric character with '-'
 * (lossy; not reversible). Both engines' sessions are grouped by this key so the
 * same physical directory collapses to ONE sidebar project.
 *
 * Empty/undefined cwd → ''. No separator/drive-case pre-normalization: '\\' and
 * '/' and ':' all map to '-' already, and Claude uses the path as-is (uppercase
 * Windows drive letters, matching opencode's stored cwd).
 */
export function cwdToProjectKey(cwd: string): string {
  if (!cwd) return ''
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}
