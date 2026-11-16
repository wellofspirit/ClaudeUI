/**
 * Bun StandaloneModuleGraph blob writer, shared by `scripts/rebundle-cli.mjs`
 * and its tests (`src/main/__tests__/standalone-blob.test.ts`).
 *
 * Blob layout: [strings + contents][argv][modules table][Offsets 32B][magic 16B].
 * A module entry is 52 bytes: 6× StringPointer {u32 off, u32 len} (name,
 * contents, sourcemap, bytecode, module_info, bytecode_origin_path) then
 * 4× u8 (encoding, loader, module_format, side). Offsets is
 * {u64 byte_count, u32 mod_off, u32 mod_len, u32 entry_point_id,
 *  u32 argv_off, u32 argv_len, u32 flags}.
 *
 * Alignment: Bun reads `encoding == 2` (UTF-16LE) contents in place as a
 * `[]u16`, so their first byte must sit at an even address. The section is
 * page-aligned and the blob follows its 8-byte length prefix, so an even blob
 * offset is an even address on both Mach-O and PE. Packing contents back to
 * back without padding put most UTF-16 modules at odd addresses once patched
 * chunks changed size, and Bun panicked (`cast_slice: … is not aligned to 2`,
 * SIGABRT) the moment one loaded — the bundled `dataviz` / `design` skills.
 * Upstream binaries pad these to even offsets; latin1 (1) and binary (0)
 * contents need no alignment and sit at odd offsets upstream too.
 */

export const BUN_MAGIC = Buffer.from('\n---- Bun! ----\n', 'utf8')
export const ENTRY_SIZE = 52
/** Module `encoding` byte for UTF-16LE contents. */
export const ENCODING_UTF16 = 2

/** Byte alignment Bun requires for a module's contents, by encoding byte. */
export function contentsAlignment(encoding) {
  return encoding === ENCODING_UTF16 ? 2 : 1
}

/**
 * Lay out a fresh blob from a parsed module graph.
 *
 * Drops bytecode and its two companion fields (module_info,
 * bytecode_origin_path) so Bun recompiles from source, and emits none of
 * Bun 1.4's optional post-table records (the trailer flags are masked to
 * `flags & 0xf` accordingly).
 *
 * @param {{ modules: Array<{ name: Buffer, contents: Buffer, sourcemap: Buffer,
 *   encoding: number, loader: number, module_format: number, side: number }>,
 *   argv: Buffer, entry_point_id: number, flags: number }} graph
 * @returns {{ blob: Buffer, outFlags: number }}
 */
export function writeBlob({ modules, argv, entry_point_id, flags }) {
  // Upper bound: the three strings we emit (name, contents, sourcemap) with
  // their \0 terminators, up to one alignment pad byte per module, then
  // argv + table + trailer. bytecode / module_info / bytecode_origin_path are
  // never written.
  const estimate =
    modules.reduce(
      (s, m) => s + m.name.length + 1 + m.contents.length + 1 + m.sourcemap.length + 1 + 1,
      0
    ) +
    argv.length +
    1 +
    modules.length * ENTRY_SIZE +
    32 +
    16 +
    256 /* slack */
  const out = Buffer.alloc(estimate)
  let pos = 0

  const writeStr = (bytes, align = 1) => {
    if (bytes.length === 0) return { off: 0, len: 0 }
    // Buffer.alloc zero-fills, so skipping ahead leaves zero pad bytes.
    pos = Math.ceil(pos / align) * align
    const off = pos
    bytes.copy(out, pos)
    pos += bytes.length
    out[pos++] = 0 // null terminator (length excludes it)
    return { off, len: bytes.length }
  }

  const strPtrs = modules.map((m) => ({
    name: writeStr(m.name),
    contents: writeStr(m.contents, contentsAlignment(m.encoding)),
    sourcemap: writeStr(m.sourcemap)
  }))

  const argvPtr = writeStr(argv)

  // Modules table follows all strings.
  const mod_off = pos
  const NONE = { off: 0, len: 0 }
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i]
    const p = strPtrs[i]
    for (const sp of [p.name, p.contents, p.sourcemap, NONE, NONE, NONE]) {
      out.writeUInt32LE(sp.off, pos)
      out.writeUInt32LE(sp.len, pos + 4)
      pos += 8
    }
    out.writeUInt8(m.encoding, pos++)
    out.writeUInt8(m.loader, pos++)
    out.writeUInt8(m.module_format, pos++)
    out.writeUInt8(m.side, pos++)
  }
  const mod_len = modules.length * ENTRY_SIZE

  // Bun 1.4 chains OPTIONAL records after the module table, each gated by a
  // trailer flag bit: SOURCE_TEXT_CONTIGUOUS (4), HAS_SOURCE_HASHES (5),
  // HAS_BUILTIN_BYTECODE (6), HAS_BYTECODE_STRING_TABLE (7),
  // HAS_STARTUP_MODULE_COUNT (8), HAS_MODULE_INFO_STRING_TABLE (9),
  // CROSS_COMPILED_BYTECODE (10). We emit none of them, so those bits MUST be
  // cleared — copying the upstream flags verbatim (0x3ff on 2.1.261, 0x1fff on
  // 2.1.308, 0x3fff on 2.1.317) makes the loader read whatever follows the
  // table as record data and segfault before main. Bits 0-3
  // (DISABLE_DEFAULT_ENV_FILES / DISABLE_AUTOLOAD_BUNFIG / _TSCONFIG /
  // _PACKAGE_JSON) are behavioural and must be preserved.
  const outFlags = flags & 0xf

  // Offsets struct sits at byte_count (= current pos), trailer follows.
  const byte_count = pos
  out.writeBigUInt64LE(BigInt(byte_count), pos)
  pos += 8
  for (const v of [mod_off, mod_len, entry_point_id, argvPtr.off, argvPtr.len, outFlags]) {
    out.writeUInt32LE(v, pos)
    pos += 4
  }

  BUN_MAGIC.copy(out, pos)
  pos += BUN_MAGIC.length

  return { blob: out.subarray(0, pos), outFlags }
}

/**
 * Names of the modules in a written blob whose contents violate
 * {@link contentsAlignment}. Reads the blob back from its own trailer, so it
 * checks the bytes that ship. It shares `contentsAlignment` with the writer,
 * so it catches layout bugs, not a missing alignment rule.
 *
 * @param {Buffer} blob `[data][Offsets][magic]`, as `writeBlob` returns it
 * @returns {string[]}
 */
export function misalignedModules(blob) {
  const offsetsOff = blob.length - BUN_MAGIC.length - 32
  if (offsetsOff < 0 || !blob.subarray(offsetsOff + 32).equals(BUN_MAGIC)) {
    throw new Error('misalignedModules: blob does not end with the Bun magic trailer')
  }
  const mod_off = blob.readUInt32LE(offsetsOff + 8)
  const mod_len = blob.readUInt32LE(offsetsOff + 12)
  const bad = []
  for (let e = mod_off; e < mod_off + mod_len; e += ENTRY_SIZE) {
    const contentsOff = blob.readUInt32LE(e + 8)
    const contentsLen = blob.readUInt32LE(e + 12)
    const align = contentsAlignment(blob.readUInt8(e + 48))
    if (contentsLen > 0 && contentsOff % align !== 0) {
      const nameOff = blob.readUInt32LE(e)
      const nameLen = blob.readUInt32LE(e + 4)
      bad.push(blob.subarray(nameOff, nameOff + nameLen).toString('utf8'))
    }
  }
  return bad
}
