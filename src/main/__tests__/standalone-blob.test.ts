/**
 * @vitest-environment node
 *
 * The Bun standalone blob writer (`scripts/lib/standalone-blob.mjs`) that
 * `scripts/rebundle-cli.mjs` uses to re-inject patched chunks.
 *
 * Why this exists: the writer packed every module's contents back to back, so
 * once patched chunks changed size most `encoding == 2` (UTF-16) modules
 * landed at odd offsets. Bun casts those bytes to `[]u16` in place and
 * panicked (`cast_slice: … is not aligned to 2`, SIGABRT) the moment one
 * loaded — the bundled `dataviz` skill took a live session down.
 */

import { describe, it, expect } from 'vitest'

const mod: any = await import('../../../scripts/lib/standalone-blob.mjs')
const { writeBlob, misalignedModules, BUN_MAGIC, ENTRY_SIZE, ENCODING_UTF16 } = mod

type Mod = { name: string; contents: Buffer; encoding: number; loader?: number }

const graph = (mods: Mod[], flags = 0) => ({
  modules: mods.map((m) => ({
    name: Buffer.from(m.name),
    contents: m.contents,
    sourcemap: Buffer.alloc(0),
    encoding: m.encoding,
    loader: m.loader ?? 13,
    module_format: 0,
    side: 0
  })),
  argv: Buffer.alloc(0),
  entry_point_id: 0,
  flags
})

/** Read entry `i` back from the blob's own table. */
function entry(blob: Buffer, i: number) {
  const offsets = blob.length - BUN_MAGIC.length - 32
  const e = blob.readUInt32LE(offsets + 8) + i * ENTRY_SIZE
  const sp = (p: number) => ({ off: blob.readUInt32LE(p), len: blob.readUInt32LE(p + 4) })
  return { name: sp(e), contents: sp(e + 8), encoding: blob.readUInt8(e + 48) }
}

const utf16 = Buffer.from('chart — ≤ 10,000', 'utf16le')

describe('writeBlob', () => {
  // Every preceding-byte parity, so one of them would put the UTF-16 contents
  // at an odd offset if the writer packed without padding.
  it.each([1, 2, 3, 4])('puts UTF-16 contents at an even offset (prefix name length %i)', (n) => {
    const { blob } = writeBlob(
      graph([
        { name: 'a', contents: Buffer.from('abc'), encoding: 1 },
        { name: 'x'.repeat(n), contents: utf16, encoding: ENCODING_UTF16 }
      ])
    )
    const { contents } = entry(blob, 1)
    expect(contents.off % 2).toBe(0)
    expect(blob.subarray(contents.off, contents.off + contents.len).equals(utf16)).toBe(true)
    expect(misalignedModules(blob)).toEqual([])
  })

  it('leaves latin1 and binary contents unpadded', () => {
    const { blob } = writeBlob(
      graph([
        { name: 'ab', contents: Buffer.from('js'), encoding: 1 },
        { name: 'c', contents: Buffer.from([1, 2, 3]), encoding: 0 }
      ])
    )
    // 'ab\0' (0..3), 'js\0' (3..6), 'c\0' (6..8), binary at 8; latin1 at 3 (odd, unpadded).
    expect(entry(blob, 0).contents.off).toBe(3)
    expect(entry(blob, 1).contents.off).toBe(8)
  })

  it('masks the optional-record trailer flags', () => {
    expect(writeBlob(graph([], 0x3fff)).outFlags).toBe(0xf)
  })

  it('writes argv and the Offsets trailer the loader reads', () => {
    // Upstream 2.1.321 carries 19 argv bytes; a swapped pointer would still
    // boot and silently drop them.
    const argv = Buffer.from('--zero-fill-buffers')
    const { blob } = writeBlob({
      ...graph(
        [{ name: 'cli', contents: Buffer.from('main()\n'), encoding: 1, loader: 1 }],
        0x3fff
      ),
      argv,
      entry_point_id: 7
    })
    const offsets = blob.length - BUN_MAGIC.length - 32
    expect(blob.subarray(offsets + 32).equals(BUN_MAGIC)).toBe(true)
    expect(Number(blob.readBigUInt64LE(offsets))).toBe(offsets) // byte_count
    const modOff = blob.readUInt32LE(offsets + 8)
    expect(blob.readUInt32LE(offsets + 12)).toBe(ENTRY_SIZE) // mod_len
    expect(modOff + ENTRY_SIZE).toBe(offsets)
    expect(blob.readUInt32LE(offsets + 16)).toBe(7) // entry_point_id
    const argvOff = blob.readUInt32LE(offsets + 20)
    const argvLen = blob.readUInt32LE(offsets + 24)
    expect(blob.subarray(argvOff, argvOff + argvLen).equals(argv)).toBe(true)
    expect(blob[argvOff + argvLen]).toBe(0)
    expect(blob.readUInt32LE(offsets + 28)).toBe(0xf) // flags
    const name = entry(blob, 0).name
    expect(blob.subarray(name.off, name.off + name.len).toString()).toBe('cli')
  })
})

describe('misalignedModules', () => {
  it('names a UTF-16 module whose contents sit at an odd offset', () => {
    // Write it as latin1 (no padding) at an odd offset, then flip the table's
    // encoding byte to UTF-16: the shape the old writer shipped.
    const { blob } = writeBlob(graph([{ name: 'dataviz/SKILL.md', contents: utf16, encoding: 1 }]))
    expect(entry(blob, 0).contents.off % 2).toBe(1)
    const offsets = blob.length - BUN_MAGIC.length - 32
    blob.writeUInt8(ENCODING_UTF16, blob.readUInt32LE(offsets + 8) + 48)
    expect(misalignedModules(blob)).toEqual(['dataviz/SKILL.md'])
  })

  it('rejects a buffer without the Bun trailer', () => {
    expect(() => misalignedModules(Buffer.alloc(64))).toThrow(/magic trailer/)
  })
})
