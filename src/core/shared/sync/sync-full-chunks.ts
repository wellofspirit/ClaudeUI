/**
 * Chunked `sync-full` (ADR-102 amendment): the pure half. A browser WebSocket
 * delivers whole messages only, so a 40 MB snapshot in one frame gives the phone
 * nothing to draw a progress bar from. A client that opts in (`sync.chunked`) gets
 * the exact `JSON.stringify` of the `sync-full` message sliced into
 * `sync-full-chunk` frames; its reassembled text, parsed, IS that message.
 *
 * Isomorphic and Electron-free: the host splits, the web client counts, and both
 * import the one size constant.
 */

/** Characters of the sync-full JSON per chunk frame (~512 KB): ~80 frames for a 40 MB snapshot. */
export const SYNC_FULL_CHUNK_CHARS = 512 * 1024

/**
 * Slice `json` into pieces of at most `size` UTF-16 code units whose concatenation
 * is exactly `json`. Never returns an empty list: a short (or empty) input is ONE
 * piece, so the receiver has a single code path.
 *
 * A boundary never lands between the halves of a surrogate pair. That is
 * belt-and-braces: `JSON.stringify` is well-formed (lone surrogates become
 * `\udXXX` escapes), so a split pair would round-trip through a chunk's own JSON
 * wrapper and rejoin intact anyway — this just keeps every `data` valid on its own.
 */
export function splitSyncFullJson(json: string, size: number): string[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be >= 1: ${size}`)
  if (json.length <= size) return [json]
  const parts: string[] = []
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + size, json.length)
    if (end < json.length && end - 1 > start) {
      const last = json.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end--
    }
    parts.push(json.slice(start, end))
    start = end
  }
  return parts
}
