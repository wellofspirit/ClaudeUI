import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { isImageMediaType, type ToolResultImage } from '../../shared/types'

/**
 * The bytes behind a Codex `imageView` item.
 *
 * `imageView` carries a PATH and nothing else — the `view_image` tool hands the
 * model a local file, and the thread item records where it was. Every other
 * harness ships the bytes with the result, so the card would otherwise say an
 * image was viewed and show nothing. This reads the file ONCE, at map time, and
 * hands the caller a `ToolResultImage` to hang off the tool_result.
 *
 * Nothing new is exposed: the model has already read the file, and the item is
 * the record of that read. The read is still bounded on every axis that matters:
 *
 *  - {@link IMAGE_VIEW_MAX_BYTES} — 5 MB, checked by `stat` BEFORE any byte is
 *    read, so a huge (or endless) file costs a stat and not a heap;
 *  - the EXTENSION must be one of the four renderable ones, and the leading
 *    bytes must agree — a `.png` that is really a PDF is refused, and so is a
 *    PNG named `.txt`. The renderer builds `data:<mediaType>;base64,…` verbatim,
 *    so a lie here would be a broken thumbnail at best;
 *  - it NEVER throws. A missing file, a directory, a permission error, a
 *    symlink loop, a device node: every one of them returns `undefined` and the
 *    card falls back to the path-only form, which is the honest answer.
 *
 * Cold reads run wherever the app-server runs (`history.ts`), which is the same
 * machine the path is local to, so one implementation serves both paths.
 */
export const IMAGE_VIEW_MAX_BYTES = 5 * 1024 * 1024

/** Extension -> media type. The four types `ImageMediaType` allows, and no others. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/**
 * The magic bytes of each allowed type.
 *
 * WebP is RIFF-framed: `RIFF` at 0, the size, then `WEBP` at 8 — both halves are
 * checked, because `RIFF` alone is also a WAV and an AVI.
 */
function sniff(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('latin1') === 'GIF89a')
  )
    return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return undefined
}

/**
 * Read `path` as a renderable image, or `undefined` for any reason at all.
 *
 * The extension and the magic bytes must BOTH resolve to the same media type:
 * the extension is what the reader sees, the bytes are what the browser will
 * decode, and a disagreement means one of them is wrong.
 */
export async function readCodexImageView(path: string): Promise<ToolResultImage | undefined> {
  try {
    const declared = EXTENSIONS[extname(path).toLowerCase()]
    if (!isImageMediaType(declared)) return undefined
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > IMAGE_VIEW_MAX_BYTES) return undefined
    const bytes = await readFile(path)
    // The file can have grown between the stat and the read.
    if (bytes.length > IMAGE_VIEW_MAX_BYTES) return undefined
    if (sniff(bytes) !== declared) return undefined
    return { mediaType: declared, base64Data: bytes.toString('base64') }
  } catch {
    return undefined
  }
}
