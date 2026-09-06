/**
 * The `vendor/claude-cli/cli.js` chunk-concat format (Claude Code 2.1.261+).
 *
 * `scripts/extract-cli.mjs` writes it, `patch/apply-all.mjs` sanity-checks it
 * after patching, and `scripts/rebundle-cli.mjs` splits it back apart. All
 * three must agree on the delimiter, so it is defined once, here.
 *
 * Shape — one delimiter line per Bun standalone module, contents verbatim:
 *
 *     // @bun-chunk <module name>
 *     <chunk bytes, always newline-terminated>
 *
 * The module name is HOST-SPECIFIC. Bun's standalone virtual FS is mounted at
 * `B:/~BUN/root/` on Windows and `/$bunfs/root/` on macOS and Linux, so the
 * same release extracts as `B:/~BUN/root/chunk-w7xy78n9.js` from the win32
 * binary and `/$bunfs/root/chunk-6ja9qp17.js` from the darwin one (the chunk
 * set differs per platform too). Never match on the name's prefix — matching
 * `// @bun-chunk B:` is what broke the macOS and Linux builds on the 2.1.261
 * bump, where extraction and every patch succeeded and only the guard failed.
 */

/** Delimiter that introduces each chunk. Always at column 0. */
export const CHUNK_DELIM_PREFIX = '// @bun-chunk '

/** Global, multiline: `m[1]` is the module name. Tolerates CRLF-normalized files. */
export const CHUNK_DELIM_RE = /^\/\/ @bun-chunk (.+?)\r?$/gm

/** A well-formed leading delimiter line — delimiter plus a non-empty name. */
const HEADER_RE = /^\/\/ @bun-chunk \S/

/**
 * Does this file start with a chunk delimiter line?
 *
 * Also rejects the pre-2.1.261 monolith, whose header was `// @bun @bytecode`
 * — a space where this format has `-chunk`.
 *
 * @param {Buffer} bytes first bytes of (or the whole) candidate file
 * @returns {boolean}
 */
export function isChunkConcat(bytes) {
  return HEADER_RE.test(bytes.subarray(0, 64).toString('latin1'))
}
