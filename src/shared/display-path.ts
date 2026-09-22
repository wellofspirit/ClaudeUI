/**
 * Display-only normalization of a working directory's separators.
 *
 * Each engine hands back the cwd in whatever form it stored: opencode keeps
 * forward slashes on Windows, Claude and the others keep backslashes, so the
 * same directory reads differently depending on which engine opened it. Only
 * presentation is normalized — project grouping deliberately depends on the
 * raw form (see {@link ./project-key}), and nothing here feeds a filesystem
 * call.
 *
 * The rule keys on the path's OWN shape rather than on `window.api.platform`,
 * because the web client reports `web` for every host OS and would otherwise
 * leave a Windows path mixed when viewed from a browser.
 */

/** Windows paths render with backslashes throughout; every other path is left alone. */
export function displayCwd(cwd: string): string {
  if (!/^[A-Za-z]:/.test(cwd)) return cwd
  return cwd.replace(/\//g, '\\')
}
