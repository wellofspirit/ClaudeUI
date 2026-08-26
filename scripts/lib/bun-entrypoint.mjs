/**
 * Identify the Claude Code entrypoint module inside a Bun standalone blob.
 *
 * The modules table stores virtual paths under `B:/~BUN/root/`, and upstream
 * has renamed the entrypoint at least once:
 *
 *   ≤ 2.1.220   "B:/~BUN/root/src/entrypoints/cli.js"
 *   ≥ 2.1.231   "B:/~BUN/root/cli"            (flattened, extension dropped)
 *
 * Both extract-cli.mjs and rebundle-cli.mjs have to agree on which module is
 * the entrypoint — they previously each hardcoded `endsWith('/cli.js')`, so the
 * 2.1.231 rename broke extraction and would have silently mis-targeted the
 * rebundle. One predicate, imported by both.
 *
 * Matching is on the BASENAME being exactly `cli` or `cli.js`. A looser
 * `includes('cli')` would also catch sibling assets, and the extension-optional
 * suffix match is what makes the rename a no-op here.
 */

/** @param {string} name Module name from the Bun modules table. */
export function isCliEntrypointName(name) {
  const leaf = name.split(/[\\/]/).pop()
  return leaf === 'cli' || leaf === 'cli.js'
}
