/**
 * Small, never-throwing filesystem probes shared by system detection.
 */
import * as fs from 'node:fs'

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** `realpath` (symlinks and junctions resolved), or null when it does not exist. */
export function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/** The first `bytes` bytes of a file (fewer when it is shorter); null when unreadable. */
export function readHead(p: string, bytes: number): Buffer | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(bytes)
    const read = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Nothing to do.
      }
    }
  }
}

const MACHO_MAGICS = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca]
]

/** Does `head` start like a native executable: PE (`MZ`), ELF or Mach-O (thin or fat, either endian)? */
export function hasNativeMagic(head: Buffer | null): boolean {
  if (!head || head.length < 2) return false
  if (head[0] === 0x4d && head[1] === 0x5a) return true
  if (head.length < 4) return false
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true
  return MACHO_MAGICS.some((m) => m.every((byte, i) => head[i] === byte))
}

export function isNativeExecutable(p: string): boolean {
  return hasNativeMagic(readHead(p, 4))
}

/** Up to `cap` entry names of a directory; empty when it cannot be listed. */
export function listDir(dir: string, cap: number): string[] {
  try {
    const out: string[] = []
    const handle = fs.opendirSync(dir)
    try {
      for (let entry = handle.readSync(); entry && out.length < cap; entry = handle.readSync()) {
        out.push(entry.name)
      }
    } finally {
      handle.closeSync()
    }
    return out
  } catch {
    return []
  }
}

/** A small text file's contents (at most `maxBytes`), or null. */
export function readSmallText(p: string, maxBytes = 4096): string | null {
  const head = readHead(p, maxBytes)
  return head ? head.toString('utf-8') : null
}

/** `{ path, size, mtimeMs }` of a file, zeros when it cannot be stat'ed. */
export function fingerprintOf(p: string): { path: string; size: number; mtimeMs: number } {
  try {
    const st = fs.statSync(p)
    return { path: p, size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { path: p, size: 0, mtimeMs: 0 }
  }
}
