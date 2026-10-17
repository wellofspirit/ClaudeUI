/**
 * Executable container detection, shared by `scripts/rebundle-cli.mjs` (which
 * rewrites PE and Mach-O) and `scripts/boot-probe.mjs` (which only runs a
 * binary its host can execute).
 *
 * The first bytes tell PE (`MZ`) from 64-bit LE Mach-O (0xfeedfacf), universal
 * Mach-O (0xcafebabe / 0xcafebabf, big-endian) and ELF (`\x7fELF`).
 */

/** @param {Buffer} buf at least the first 4 bytes of the file */
export function detectFormat(buf) {
  if (buf.readUInt16LE(0) === 0x5a4d) return 'pe'
  const m = buf.readUInt32LE(0)
  if (m === 0xfeedfacf) return 'macho64'
  if (buf.readUInt32BE(0) === 0xcafebabe || buf.readUInt32BE(0) === 0xcafebabf) return 'macho-fat'
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'elf'
  return 'unknown'
}

/** The container format a binary must have to run on `platform`, or null if unknown. */
export function hostFormat(platform = process.platform) {
  if (platform === 'win32') return 'pe'
  if (platform === 'darwin') return 'macho64'
  if (platform === 'linux') return 'elf'
  return null
}

/**
 * True when a `format` file is a known container that `platform` cannot run
 * (a cross-built PE on linux, ...). 'unknown' is NOT foreign: garbage where a
 * binary should be is a failure to report, not something to skip. A universal
 * Mach-O runs on darwin.
 */
export function isForeignFormat(format, platform = process.platform) {
  if (format === 'unknown') return false
  if (platform === 'darwin' && format === 'macho-fat') return false
  return format !== hostFormat(platform)
}
