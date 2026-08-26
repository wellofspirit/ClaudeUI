#!/usr/bin/env node
/**
 * Rebundle a Bun standalone executable with a replaced cli.js payload.
 *
 * Reads the original claude.exe (PE binary with a `.bun` section containing
 * `[u64 blobLen][data buffer][Offsets 32B][Magic 16B]`), substitutes the
 * cli.js module's contents with a patched version, lays out a fresh blob,
 * and writes a new executable. Drops baked-in JSC bytecode so Bun recompiles
 * cli.js from our patched source on first run (~1-2s cold-start penalty).
 *
 * Truncates the Authenticode cert (binary becomes unsigned — inevitable once
 * we touch the bytes) and shrinks the `.bun` section to match the new blob
 * size, so the output is ~15MB instead of 235MB.
 *
 * Format references:
 *   - Bun StandaloneModuleGraph.zig: 32-byte Offsets struct, 52-byte module
 *     entries (6× StringPointer + 4× u8), strings are \0-terminated, bytecode
 *     requires (offset % 128 == 120) alignment when non-empty.
 *   - byte_count = size of data buffer (excludes Offsets + magic).
 *
 * Usage:
 *   node scripts/rebundle-cli.mjs                              (pipeline mode —
 *     reads sourceBinary + cli.js from vendor/claude-cli/version.json and
 *     writes vendor/claude-cli/bun-claude<ext>)
 *   node scripts/rebundle-cli.mjs <input.exe> <new-cli.js> <output.exe>
 *   node scripts/rebundle-cli.mjs --quiet   (any mode — suppress info logs)
 *   node scripts/rebundle-cli.mjs --noop <input.exe> <output.exe>
 *     (NO-OP rebundle: reuse original cli.js contents unchanged — validates
 *      reader/writer symmetry.)
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCliEntrypointName } from './lib/bun-entrypoint.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const BUN_MAGIC = Buffer.from('\n---- Bun! ----\n', 'utf8')
const ENTRY_SIZE = 52

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { noop: false, input: null, newCli: null, output: null }
  const rest = []
  for (const a of argv) {
    if (a === '--noop') args.noop = true
    else if (!a.startsWith('--')) rest.push(a)
  }
  if (args.noop) {
    ;[args.input, args.output] = rest
    if (!args.input || !args.output) die('usage: --noop <input.exe> <output.exe>')
    return args
  }
  if (rest.length === 0) {
    // Pipeline mode — resolve inputs/outputs from vendor/claude-cli/version.json.
    return resolvePipelineArgs()
  }
  ;[args.input, args.newCli, args.output] = rest
  if (!args.input || !args.newCli || !args.output) {
    die('usage: <input.exe> <new-cli.js> <output.exe>   (or no args for pipeline mode, or --noop)')
  }
  return args
}

/**
 * Pipeline-mode defaults: assumes `extract-cli.mjs` ran first and wrote
 * vendor/claude-cli/version.json with `sourceBinary` pointing at the cached
 * original Bun binary. Output is `bun-claude<ext>` in the vendor dir.
 */
function resolvePipelineArgs() {
  const versionPath = join(ROOT, 'vendor', 'claude-cli', 'version.json')
  let meta
  try {
    meta = JSON.parse(readFileSync(versionPath, 'utf8'))
  } catch {
    die(`pipeline mode: cannot read ${versionPath} — run 'node scripts/extract-cli.mjs' first`)
  }
  if (!meta.sourceBinary || typeof meta.sourceBinary !== 'string') {
    die(`pipeline mode: ${versionPath} missing "sourceBinary" field`)
  }
  // `sourceBinary` is typically relative to ROOT (e.g. `.cache/claude-cli/claude-...`);
  // absolute paths are preserved when passed via `extract-cli --binary`. `resolve()`
  // handles both: absolute input → returned as-is, relative → joined onto ROOT.
  const input = resolve(ROOT, meta.sourceBinary)
  const newCli = join(ROOT, 'vendor', 'claude-cli', 'cli.js')
  const ext = process.platform === 'win32' ? '.exe' : ''
  const output = join(ROOT, 'vendor', 'claude-cli', `bun-claude${ext}`)
  return { noop: false, input, newCli, output }
}

function die(msg) {
  console.error(`rebundle-cli: ${msg}`)
  process.exit(1)
}

const QUIET = process.argv.includes('--quiet')

function log(...args) {
  if (!QUIET) console.log('[rebundle-cli]', ...args)
}

function alignUp(n, align) {
  return (((n + align - 1) / align) | 0) * align
}

// ---------------------------------------------------------------------------
// Format detection: first bytes tell us PE (MZ) vs Mach-O (0xfeedfacf LE) vs
// ELF (0x7F E L F) vs universal Mach-O (0xcafebabe BE).
// ---------------------------------------------------------------------------

function detectFormat(buf) {
  if (buf.readUInt16LE(0) === 0x5a4d) return 'pe'
  const m = buf.readUInt32LE(0)
  if (m === 0xfeedfacf) return 'macho64'
  if (buf.readUInt32BE(0) === 0xcafebabe || buf.readUInt32BE(0) === 0xcafebabf) return 'macho-fat'
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'elf'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// PE parser: locate `.bun` section, cert table, headers we need to update
// ---------------------------------------------------------------------------

function parsePE(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) die('not a PE binary (no MZ)')
  const peOff = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(peOff) !== 0x00004550) die('no PE signature')

  const numSections = buf.readUInt16LE(peOff + 6)
  const sizeOptHdr = buf.readUInt16LE(peOff + 20)
  const optHdrOff = peOff + 24
  const magic = buf.readUInt16LE(optHdrOff)
  const isPe32Plus = magic === 0x20b
  if (!isPe32Plus) die('only PE32+ supported (64-bit)')

  const fileAlignment = buf.readUInt32LE(optHdrOff + 36)
  const sectionAlignment = buf.readUInt32LE(optHdrOff + 32)
  const dataDirsOff = optHdrOff + 112
  const sectionsOff = optHdrOff + sizeOptHdr

  let bunSection = null
  let bunSectionIdx = -1
  for (let i = 0; i < numSections; i++) {
    const s = sectionsOff + i * 40
    const name = buf
      .subarray(s, s + 8)
      .toString('ascii')
      .replace(/\0+$/, '')
    if (name === '.bun') {
      bunSectionIdx = i
      bunSection = {
        headerOff: s,
        virtualSize: buf.readUInt32LE(s + 8),
        virtualAddress: buf.readUInt32LE(s + 12),
        rawSize: buf.readUInt32LE(s + 16),
        rawOff: buf.readUInt32LE(s + 20)
      }
    }
  }
  if (!bunSection) die('.bun section not found')
  if (bunSectionIdx !== numSections - 1) {
    die(
      `.bun must be the last section (was index ${bunSectionIdx} of ${numSections}); ` +
        'shrinking would require shifting later sections, not implemented.'
    )
  }

  return {
    peOff,
    optHdrOff,
    dataDirsOff,
    sectionsOff,
    numSections,
    fileAlignment,
    sectionAlignment,
    bunSection
  }
}

// ---------------------------------------------------------------------------
// Mach-O parser: locate __BUN,__bun section and the code signature.
// The segment is the last payload-bearing segment before __LINKEDIT; shrinking
// it would require repositioning __LINKEDIT + the LC_CODE_SIGNATURE blob.
// First cut keeps the original section size (pad with zeros), so __LINKEDIT
// and the signature stay at their original offsets — simpler & safer.
// ---------------------------------------------------------------------------

function parseMachO(buf) {
  const LC_SEGMENT_64 = 0x19
  const LC_CODE_SIGNATURE = 0x1d

  if (buf.readUInt32LE(0) !== 0xfeedfacf)
    die('not a 64-bit LE Mach-O (universal-fat not supported)')
  const ncmds = buf.readUInt32LE(16)

  let p = 32
  let bunSeg = null
  let bunSect = null
  let codeSig = null

  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(p)
    const cmdsize = buf.readUInt32LE(p + 4)

    if (cmd === LC_SEGMENT_64) {
      const segname = buf
        .subarray(p + 8, p + 24)
        .toString('ascii')
        .replace(/\0+$/, '')
      const nsects = buf.readUInt32LE(p + 64)
      if (segname === '__BUN') {
        bunSeg = {
          headerOff: p,
          cmdsize,
          segname,
          vmaddr: Number(buf.readBigUInt64LE(p + 24)),
          vmsize: Number(buf.readBigUInt64LE(p + 32)),
          fileoff: Number(buf.readBigUInt64LE(p + 40)),
          filesize: Number(buf.readBigUInt64LE(p + 48))
        }
        // Exactly one section expected inside __BUN
        if (nsects !== 1) die(`__BUN segment has ${nsects} sections (expected 1)`)
        const sp = p + 72
        bunSect = {
          headerOff: sp,
          sectname: buf
            .subarray(sp, sp + 16)
            .toString('ascii')
            .replace(/\0+$/, ''),
          addr: Number(buf.readBigUInt64LE(sp + 32)),
          size: Number(buf.readBigUInt64LE(sp + 40)),
          offset: buf.readUInt32LE(sp + 48)
        }
      }
    } else if (cmd === LC_CODE_SIGNATURE) {
      codeSig = {
        headerOff: p,
        dataOff: buf.readUInt32LE(p + 8),
        dataSize: buf.readUInt32LE(p + 12)
      }
    }
    p += cmdsize
  }

  if (!bunSeg || !bunSect) die('__BUN,__bun section not found in Mach-O')
  return { bunSeg, bunSect, codeSig, ncmds }
}

// ---------------------------------------------------------------------------
// Blob reader: parse the data buffer inside the Bun section into a module
// graph we can edit and re-emit. Works on any container — callers hand us
// the raw section bytes.
// ---------------------------------------------------------------------------

function readBlobAtSection(buf, sectionOff, sectionSize) {
  // Section layout: [u64 blobLen][blob == data + Offsets + magic][padding]
  const blobLen = Number(buf.readBigUInt64LE(sectionOff))
  const blobStart = sectionOff + 8
  const blobEnd = blobStart + blobLen
  if (blobEnd > sectionOff + sectionSize) {
    die(`blob end 0x${blobEnd.toString(16)} exceeds section end`)
  }
  const blob = buf.subarray(blobStart, blobEnd)

  // Trailer: magic at very end, Offsets immediately before magic
  const magicIdx = blob.lastIndexOf(BUN_MAGIC)
  if (magicIdx < 0) die('Bun magic not found in blob')
  if (magicIdx !== blob.length - 16)
    die(`magic not at end of blob (at ${magicIdx}, expected ${blob.length - 16})`)

  const offsetsOff = magicIdx - 32
  const byte_count = Number(blob.readBigUInt64LE(offsetsOff))
  const mod_off = blob.readUInt32LE(offsetsOff + 8)
  const mod_len = blob.readUInt32LE(offsetsOff + 12)
  const entry_point_id = blob.readUInt32LE(offsetsOff + 16)
  const argv_off = blob.readUInt32LE(offsetsOff + 20)
  const argv_len = blob.readUInt32LE(offsetsOff + 24)
  const flags = blob.readUInt32LE(offsetsOff + 28)
  if (byte_count !== offsetsOff) {
    die(`byte_count ${byte_count} != offsetsOff ${offsetsOff} (invariant violated)`)
  }
  if (mod_len % ENTRY_SIZE !== 0) die(`mod_len ${mod_len} not a multiple of 52`)

  const n = mod_len / ENTRY_SIZE
  const modules = []
  for (let i = 0; i < n; i++) {
    const e = mod_off + i * ENTRY_SIZE
    const sp = (p) => ({ off: blob.readUInt32LE(p), len: blob.readUInt32LE(p + 4) })
    const name = sp(e)
    const contents = sp(e + 8)
    const sourcemap = sp(e + 16)
    const bytecode = sp(e + 24)
    const module_info = sp(e + 32)
    const bytecode_origin_path = sp(e + 40)
    const encoding = blob.readUInt8(e + 48)
    const loader = blob.readUInt8(e + 49)
    const module_format = blob.readUInt8(e + 50)
    const side = blob.readUInt8(e + 51)
    const readBytes = ({ off, len }) =>
      len > 0 ? Buffer.from(blob.subarray(off, off + len)) : Buffer.alloc(0)
    modules.push({
      index: i,
      name: readBytes(name),
      contents: readBytes(contents),
      sourcemap: readBytes(sourcemap),
      bytecode: readBytes(bytecode),
      module_info: readBytes(module_info),
      bytecode_origin_path: readBytes(bytecode_origin_path),
      encoding,
      loader,
      module_format,
      side
    })
  }

  const argvBytes =
    argv_len > 0 ? Buffer.from(blob.subarray(argv_off, argv_off + argv_len)) : Buffer.alloc(0)

  return { modules, argv: argvBytes, entry_point_id, flags }
}

// ---------------------------------------------------------------------------
// Blob writer: emit strings, modules table, argv, Offsets, magic.
// Drops bytecode (sets offset/len to 0) so Bun recompiles source.
// ---------------------------------------------------------------------------

function writeBlob({ modules, argv, entry_point_id, flags }) {
  // Allocate a generous buffer and track position; we'll slice at the end.
  // Upper bound: sum of all field bytes + terminators + table + argv + trailer.
  const estimate =
    modules.reduce(
      (s, m) =>
        s +
        m.name.length +
        1 +
        m.contents.length +
        1 +
        m.sourcemap.length +
        1 +
        m.module_info.length +
        1 +
        m.bytecode_origin_path.length +
        1,
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

  const strPtrs = [] // per-module, parallel to modules

  for (const m of modules) {
    const ptrs = {}
    const writeStr = (bytes) => {
      if (bytes.length === 0) return { off: 0, len: 0 }
      const off = pos
      bytes.copy(out, pos)
      pos += bytes.length
      out[pos++] = 0 // null terminator (length excludes it)
      return { off, len: bytes.length }
    }
    ptrs.name = writeStr(m.name)
    ptrs.contents = writeStr(m.contents)
    ptrs.sourcemap = writeStr(m.sourcemap)
    // bytecode: intentionally dropped — forces Bun to recompile from source.
    // Keeps blob size down (108MB → ~14MB) and avoids the alignment dance.
    ptrs.bytecode = { off: 0, len: 0 }
    ptrs.module_info = writeStr(m.module_info)
    ptrs.bytecode_origin_path = writeStr(m.bytecode_origin_path)
    strPtrs.push(ptrs)
  }

  // argv blob
  let argvPtr = { off: 0, len: 0 }
  if (argv.length > 0) {
    argvPtr = { off: pos, len: argv.length }
    argv.copy(out, pos)
    pos += argv.length
    out[pos++] = 0
  }

  // Modules table follows all strings.
  const mod_off = pos
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i]
    const p = strPtrs[i]
    const writeSp = (sp) => {
      out.writeUInt32LE(sp.off, pos)
      out.writeUInt32LE(sp.len, pos + 4)
      pos += 8
    }
    writeSp(p.name)
    writeSp(p.contents)
    writeSp(p.sourcemap)
    writeSp(p.bytecode)
    writeSp(p.module_info)
    writeSp(p.bytecode_origin_path)
    out.writeUInt8(m.encoding, pos++)
    out.writeUInt8(m.loader, pos++)
    out.writeUInt8(m.module_format, pos++)
    out.writeUInt8(m.side, pos++)
  }
  const mod_len = modules.length * ENTRY_SIZE

  // Offsets struct sits at byte_count (= current pos), trailer follows.
  const byte_count = pos
  out.writeBigUInt64LE(BigInt(byte_count), pos)
  pos += 8
  out.writeUInt32LE(mod_off, pos)
  pos += 4
  out.writeUInt32LE(mod_len, pos)
  pos += 4
  out.writeUInt32LE(entry_point_id, pos)
  pos += 4
  out.writeUInt32LE(argvPtr.off, pos)
  pos += 4
  out.writeUInt32LE(argvPtr.len, pos)
  pos += 4
  out.writeUInt32LE(flags, pos)
  pos += 4

  // Magic
  BUN_MAGIC.copy(out, pos)
  pos += BUN_MAGIC.length

  return out.subarray(0, pos)
}

// ---------------------------------------------------------------------------
// Mach-O rewriter: overwrite __BUN,__bun section contents in place, preserving
// the original section size via zero padding. Keeping the size fixed means
// __LINKEDIT and the code-signature blob that follow stay at their original
// offsets — we avoid having to rewrite any other load command. The existing
// signature becomes invalid (hashes no longer match); caller must re-sign
// with `codesign --force --sign -` after writing. We do this automatically on
// macOS in `main()`.
// ---------------------------------------------------------------------------

function rewriteMachO(buf, macho, newBlob) {
  const { bunSect } = macho
  const newSectionContentSize = 8 + newBlob.length
  if (newSectionContentSize > bunSect.size) {
    die(
      `new blob (${newBlob.length} + 8-byte header = ${newSectionContentSize} bytes) ` +
        `exceeds __BUN,__bun section size ${bunSect.size}. ` +
        'Growing the section requires shifting __LINKEDIT + code signature — not implemented.'
    )
  }

  // Clone the full buffer; we'll surgically replace only the __BUN section.
  const out = Buffer.from(buf)

  // Zero the entire section first (erases old blob so leftover bytes don't
  // confuse anything reading past the new blob end).
  out.fill(0, bunSect.offset, bunSect.offset + bunSect.size)

  // Write new section contents: [u64 blobLen][blob][zero padding]
  out.writeBigUInt64LE(BigInt(newBlob.length), bunSect.offset)
  newBlob.copy(out, bunSect.offset + 8)

  return out
}

// ---------------------------------------------------------------------------
// PE rewriter: replace `.bun` section contents, shrink to fit new blob,
// strip cert, truncate file.
// ---------------------------------------------------------------------------

function rewritePE(buf, pe, newBlob) {
  const { bunSection, fileAlignment, dataDirsOff } = pe
  const newSectionContentSize = 8 + newBlob.length
  const newSectionRawSize = alignUp(newSectionContentSize, fileAlignment)
  const newFileSize = bunSection.rawOff + newSectionRawSize

  const out = Buffer.alloc(newFileSize)
  // Copy everything before .bun section verbatim (PE headers + earlier sections)
  buf.copy(out, 0, 0, bunSection.rawOff)

  // Write new section contents: [u64 blobLen][blob][zero padding]
  out.writeBigUInt64LE(BigInt(newBlob.length), bunSection.rawOff)
  newBlob.copy(out, bunSection.rawOff + 8)
  // Padding to file alignment is already zero from Buffer.alloc.

  // Update .bun section header: VirtualSize and SizeOfRawData.
  // VirtualSize is the in-memory size (pre-alignment); SizeOfRawData is the
  // on-disk size (file-aligned). We set both to the new content-plus-padding
  // size — Bun's loader reads the 8-byte header then the blob, and Windows
  // maps the whole section regardless, so using the aligned size for both
  // is safe and matches how the original was laid out.
  out.writeUInt32LE(newSectionRawSize, bunSection.headerOff + 8) // VirtualSize
  out.writeUInt32LE(newSectionRawSize, bunSection.headerOff + 16) // SizeOfRawData

  // Zero out Security (cert table) data directory at index 4 (offset 4*8=32).
  // This removes the reference to the now-truncated Authenticode cert.
  out.writeUInt32LE(0, dataDirsOff + 4 * 8)
  out.writeUInt32LE(0, dataDirsOff + 4 * 8 + 4)

  // Update SizeOfImage in optional header: size of image in memory, aligned
  // to SectionAlignment. It's the VirtualAddress of the last section + its
  // aligned VirtualSize. Our .bun is last; its VirtualAddress is unchanged.
  const sizeOfImage = alignUp(bunSection.virtualAddress + newSectionRawSize, pe.sectionAlignment)
  out.writeUInt32LE(sizeOfImage, pe.optHdrOff + 56)

  // Zero CheckSum field — optional, set to 0 when unknown; Windows loader
  // doesn't enforce it for user EXEs. It was valid on the original; ours
  // won't be, so zero it rather than leaving a stale value.
  out.writeUInt32LE(0, pe.optHdrOff + 64)

  return out
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function findCliModule(modules) {
  const cli = modules.find((m) => isCliEntrypointName(m.name.toString('utf8')))
  if (!cli) die('cli.js module not found in blob')
  return cli
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  log(`reading ${args.input}`)
  const buf = readFileSync(args.input)

  const format = detectFormat(buf)
  log(`format: ${format}`)

  let sectionOff, sectionSize
  let container // parser-specific metadata used by the rewriter

  if (format === 'pe') {
    const pe = parsePE(buf)
    sectionOff = pe.bunSection.rawOff
    sectionSize = pe.bunSection.rawSize
    container = { kind: 'pe', pe }
    log(`.bun section at 0x${sectionOff.toString(16)}, size ${sectionSize}`)
  } else if (format === 'macho64') {
    const macho = parseMachO(buf)
    sectionOff = macho.bunSect.offset
    sectionSize = macho.bunSect.size
    container = { kind: 'macho', macho }
    log(
      `__BUN,__bun at 0x${sectionOff.toString(16)}, size ${sectionSize}` +
        (macho.codeSig ? `, code-sig at 0x${macho.codeSig.dataOff.toString(16)}` : '')
    )
  } else if (format === 'elf') {
    // Linux: Bun's ELF standalone layout is not implemented yet. ubuntu CI
    // still runs extract+patch to prove every patch APPLIES against the
    // linux-x64 bundle, so a clean SKIP keeps that gate meaningful — and it
    // stays fail-closed for consumers: no bun-claude output is written at all,
    // so nothing can silently spawn an UNPATCHED binary on Linux. Implementing
    // the ELF rewrite lifts this (the extract side already parses the trailer
    // platform-independently).
    console.log(
      'rebundle-cli: ELF (Linux) rebundle not implemented — skipping. ' +
        'Patched cli.js remains at vendor/claude-cli/cli.js; no bun-claude binary was produced.'
    )
    process.exit(0)
  } else {
    die(
      `unsupported format "${format}" (first bytes: ${buf.subarray(0, 4).toString('hex')}). ` +
        'PE (Windows) and 64-bit LE Mach-O (macOS arm64/x64) are supported.'
    )
  }

  const origBlobLen = Number(buf.readBigUInt64LE(sectionOff))

  const graph = readBlobAtSection(buf, sectionOff, sectionSize)
  log(
    `${graph.modules.length} modules, ${graph.argv.length} argv bytes, flags=0x${graph.flags.toString(16)}`
  )
  for (const m of graph.modules) {
    log(
      `  [${m.index}] ${m.name.toString('utf8')} ` +
        `contents=${m.contents.length} bc=${m.bytecode.length} ` +
        `enc=${m.encoding} ldr=${m.loader}`
    )
  }

  const cli = findCliModule(graph.modules)
  if (!args.noop) {
    const newCli = readFileSync(args.newCli)
    // Guardrail: our replacement must be the wrapped form (Bun CJS IIFE),
    // not the unwrapped Node-runnable form the old pipeline produced. The
    // Bun loader expects `// @bun ...` + `(function(exports, require, ...){`
    // as the first non-whitespace content. If we hand it the unwrapped
    // shape, Bun fails to load the module at startup with a cryptic error.
    if (!newCli.subarray(0, 8).toString('utf8').startsWith('// @bun')) {
      die(
        `${args.newCli} is not a wrapped Bun CJS module (missing "// @bun" header). ` +
          'Re-run `node scripts/extract-cli.mjs` to regenerate it.'
      )
    }
    log(`replacing cli.js contents: ${cli.contents.length} → ${newCli.length} bytes`)
    cli.contents = newCli
  } else {
    log('NO-OP mode: reusing original cli.js contents (drops bytecode only)')
  }

  const newBlob = writeBlob(graph)
  log(`new blob: ${newBlob.length} bytes (was ${origBlobLen})`)

  const out =
    container.kind === 'pe'
      ? rewritePE(buf, container.pe, newBlob)
      : rewriteMachO(buf, container.macho, newBlob)
  log(`new file size: ${out.length} (was ${buf.length})`)

  writeFileSync(args.output, out)
  // Preserve executable bit on non-Windows (chmod on Windows is a no-op).
  if (process.platform !== 'win32') {
    try {
      chmodSync(args.output, 0o755)
    } catch {
      /* best-effort */
    }
  }
  log(`wrote ${args.output}`)

  // Mach-O binaries need an ad-hoc signature to run on Apple Silicon (the
  // kernel rejects unsigned arm64 executables). Our bytewise edits invalidate
  // the original signature, so re-sign here when we're on macOS. Skipped on
  // other hosts — cross-compiling a Mac binary from Windows/Linux produces a
  // file that must be signed on a Mac before it runs anyway.
  //
  // Also strip extended attributes (notably com.apple.quarantine). Node's
  // writeFileSync shouldn't attach quarantine on its own, but the surrounding
  // `build:mac` already does `xattr -cr` on the final .app bundle for good
  // reason — Gatekeeper refuses to launch quarantined children even when the
  // parent app is signed. Doing it here too keeps `bun run dev` usable.
  if (container.kind === 'macho' && process.platform === 'darwin') {
    try {
      log('ad-hoc signing with codesign --force --sign -')
      execFileSync('codesign', ['--force', '--sign', '-', args.output], { stdio: 'inherit' })
    } catch (err) {
      die(`codesign failed: ${err.message}`)
    }
    try {
      execFileSync('xattr', ['-c', args.output], { stdio: 'inherit' })
    } catch (err) {
      // Non-fatal — xattr -c should never fail on a file we just wrote, but
      // be lenient in case the filesystem doesn't support extended attrs.
      log(`warning: xattr -c failed (${err.message}) — output may retain quarantine`)
    }
  } else if (container.kind === 'macho') {
    log(
      `warning: Mach-O output not code-signed (host is ${process.platform}). ` +
        'Run `codesign --force --sign - <output> && xattr -c <output>` on macOS before executing.'
    )
  }
}

main()
