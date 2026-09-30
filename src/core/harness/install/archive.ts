/**
 * Dependency-free archive extraction for harness installs (ADR-082 §4): tar
 * inside gzip (opencode's npm tarball, Codex's per-binary assets, pi on macOS
 * and Linux) and zip (pi on Windows). Ported from the readers in
 * `scripts/ensure-*.mjs`, streaming instead of buffering whole archives: a
 * Codex binary unpacks to ~300 MB, which should not sit in the main process's
 * heap.
 *
 * Every entry of the archive is checked, including entries that are skipped,
 * and one bad entry fails the whole archive:
 *
 *   - no absolute paths, drive letters, `..` segments, `:` (an NTFS alternate
 *     stream) or NUL in a name;
 *   - no symlinks or hardlinks, no devices or FIFOs;
 *   - a file never overwrites another (`wx`), so a duplicate entry fails;
 *   - per-entry, total and entry-count caps.
 *
 * Files are written with their archived permission bits (`& 0o777`: never
 * setuid/setgid), `0o644` when the archive carries none; on Windows the mode is
 * irrelevant. Each written file's SHA-256 is computed while it is written.
 *
 * The caller decides trust: archives are hash-checked before they get here.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { Readable } from 'node:stream'
import { createGunzip, createInflateRaw } from 'node:zlib'

export class ArchiveError extends Error {
  override name = 'ArchiveError'
}

export interface ExtractLimits {
  /** The largest single file (uncompressed). */
  maxEntryBytes: number
  /** The whole archive, uncompressed (tar: the decompressed stream). */
  maxTotalBytes: number
  maxEntries: number
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntryBytes: 768 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxEntries: 20_000
}

export interface ExtractOptions {
  /**
   * Where an entry goes, relative to the destination, given its normalised
   * archive path; null skips it. Default: every entry at its own path.
   */
  select?: (entryPath: string) => string | null
  limits?: Partial<ExtractLimits>
  signal?: AbortSignal
  platform?: NodeJS.Platform
}

/** A regular file in the archive; `dest` and `sha256` are null when it was skipped. */
export interface ExtractedFile {
  entryPath: string
  dest: string | null
  size: number
  sha256: string | null
}

// ── Paths ─────────────────────────────────────────────────────────────────────

/**
 * An archive name as a safe relative path (`/`-separated, no `.` segments), or
 * an `ArchiveError`. Backslashes count as separators.
 */
export function safeEntryPath(raw: string): string {
  const norm = raw.replace(/\\/g, '/')
  if (norm.includes('\0')) throw new ArchiveError(`archive entry has a NUL in its name`)
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
    throw new ArchiveError(`archive entry has an absolute path: ${raw}`)
  }
  const segments = norm.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) throw new ArchiveError(`archive entry leaves its directory: ${raw}`)
  if (segments.some((s) => s.includes(':'))) {
    throw new ArchiveError(`archive entry has a ':' in its name: ${raw}`)
  }
  if (segments.length === 0) throw new ArchiveError(`archive entry has an empty name`)
  return segments.join('/')
}

/** `rel` (already safe) under `destDir`, checked once more after resolution. */
function inside(destDir: string, rel: string): string {
  const root = path.resolve(destDir)
  const dest = path.resolve(root, safeEntryPath(rel))
  if (!dest.startsWith(root + path.sep)) {
    throw new ArchiveError(`archive entry escapes its destination: ${rel}`)
  }
  return dest
}

// ── Writing ───────────────────────────────────────────────────────────────────

interface Ctx {
  destDir: string
  select: (entryPath: string) => string | null
  limits: ExtractLimits
  signal?: AbortSignal
  platform: NodeJS.Platform
  files: ExtractedFile[]
  entries: number
}

function context(destDir: string, opts: ExtractOptions): Ctx {
  return {
    destDir,
    select: opts.select ?? ((p) => p),
    limits: { ...DEFAULT_EXTRACT_LIMITS, ...opts.limits },
    signal: opts.signal,
    platform: opts.platform ?? process.platform,
    files: [],
    entries: 0
  }
}

function countEntry(ctx: Ctx): void {
  ctx.signal?.throwIfAborted()
  if (++ctx.entries > ctx.limits.maxEntries) {
    throw new ArchiveError(`archive has more than ${ctx.limits.maxEntries} entries`)
  }
}

async function makeDir(ctx: Ctx, rel: string): Promise<void> {
  const destRel = ctx.select(rel)
  if (destRel !== null) await fsp.mkdir(inside(ctx.destDir, destRel), { recursive: true })
}

/** Write `chunks` (exactly `size` bytes) to the entry's destination, hashing as it goes. */
async function writeFile(
  ctx: Ctx,
  rel: string,
  size: number,
  mode: number,
  chunks: AsyncIterable<Buffer>
): Promise<void> {
  const dest = inside(ctx.destDir, ctx.select(rel) as string)
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const fileMode = mode & 0o777 || 0o644
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(dest, 'wx', fileMode)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ArchiveError(`archive has a duplicate entry: ${rel}`)
    }
    throw err
  }
  const hash = createHash('sha256')
  let written = 0
  try {
    for await (const chunk of chunks) {
      ctx.signal?.throwIfAborted()
      written += chunk.length
      if (written > size) throw new ArchiveError(`archive entry is larger than it says: ${rel}`)
      hash.update(chunk)
      await handle.write(chunk)
    }
  } finally {
    await handle.close()
  }
  if (written !== size) throw new ArchiveError(`archive entry is truncated: ${rel}`)
  // The process umask may have narrowed the mode `open` was given.
  if (ctx.platform !== 'win32') await fsp.chmod(dest, fileMode)
  ctx.files.push({ entryPath: rel, dest, size, sha256: hash.digest('hex') })
}

async function drain(chunks: AsyncIterable<Buffer>): Promise<void> {
  for await (const chunk of chunks) void chunk
}

// ── tar.gz ────────────────────────────────────────────────────────────────────

const BLOCK = 512

/** Exact-length reads over a stream of chunks. */
class ByteReader {
  private pending: Buffer[] = []
  private pendingLen = 0
  private ended = false

  constructor(
    private readonly source: AsyncIterator<Buffer>,
    private readonly onBytes: (n: number) => void
  ) {}

  private async fill(): Promise<boolean> {
    if (this.ended) return false
    const next = await this.source.next()
    if (next.done) {
      this.ended = true
      return false
    }
    const buf = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
    this.onBytes(buf.length)
    this.pending.push(buf)
    this.pendingLen += buf.length
    return true
  }

  /** Exactly `n` bytes; null at a clean end of input. */
  async exact(n: number): Promise<Buffer | null> {
    while (this.pendingLen < n) {
      if (!(await this.fill())) {
        if (this.pendingLen === 0) return null
        throw new ArchiveError('archive is truncated')
      }
    }
    const joined = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending)
    const rest = joined.subarray(n)
    this.pending = rest.length > 0 ? [rest] : []
    this.pendingLen = rest.length
    return Buffer.from(joined.subarray(0, n))
  }

  /** The next `n` bytes, in pieces. */
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n
    while (left > 0) {
      if (this.pendingLen === 0 && !(await this.fill())) {
        throw new ArchiveError('archive is truncated')
      }
      const head = this.pending[0]
      if (head.length <= left) {
        this.pending.shift()
        this.pendingLen -= head.length
        left -= head.length
        yield head
      } else {
        this.pending[0] = head.subarray(left)
        this.pendingLen -= left
        yield head.subarray(0, left)
        left = 0
      }
    }
  }
}

function cstr(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? length : end).toString('utf8')
}

function octal(header: Buffer, offset: number, length: number, what: string): number {
  if (header[offset] & 0x80) throw new ArchiveError(`archive ${what} is too large`)
  const text = header
    .subarray(offset, offset + length)
    .toString('latin1')
    .replace(/[\0 ]+$/, '')
    .replace(/^ +/, '')
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError(`archive has an invalid ${what} field`)
  return Number.parseInt(text, 8)
}

/** The header checksum, as unsigned or (old tars) signed bytes. */
function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8, 'checksum')
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 32 : header[i]
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  return stored === unsigned || stored === signed
}

/** A POSIX (not GNU) ustar header carries a name prefix at 345. */
function ustarName(header: Buffer): string {
  const name = cstr(header, 0, 100)
  const magic = header.subarray(257, 263).toString('latin1')
  const prefix = magic === 'ustar\0' ? cstr(header, 345, 155) : ''
  return prefix ? `${prefix}/${name}` : name
}

/** pax extended header records: `<len> <key>=<value>\n`. */
function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let pos = 0
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos)
    if (space < 0) break
    const len = Number.parseInt(data.subarray(pos, space).toString('latin1'), 10)
    if (!Number.isInteger(len) || len <= 0 || pos + len > data.length) {
      throw new ArchiveError('archive has an invalid pax header')
    }
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1))
    pos += len
  }
  return records
}

const MAX_META_BYTES = 1024 * 1024

async function readMeta(reader: ByteReader, size: number): Promise<Buffer> {
  if (size > MAX_META_BYTES) throw new ArchiveError('archive metadata entry is too large')
  const padded = Math.ceil(size / BLOCK) * BLOCK
  if (padded === 0) return Buffer.alloc(0)
  const data = await reader.exact(padded)
  if (!data) throw new ArchiveError('archive is truncated')
  return data.subarray(0, size)
}

async function readTar(reader: ByteReader, ctx: Ctx): Promise<void> {
  let longName: string | null = null
  let paxPath: string | null = null
  let paxSize: number | null = null
  for (;;) {
    ctx.signal?.throwIfAborted()
    const header = await reader.exact(BLOCK)
    // A missing end-of-archive marker is tolerated, as by the ensure scripts.
    if (header === null || header.every((b) => b === 0)) return
    if (!checksumOk(header)) throw new ArchiveError('archive has a corrupt tar header')
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const headerSize = octal(header, 124, 12, 'size')

    if (type === 'L') {
      longName = (await readMeta(reader, headerSize)).toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'x') {
      const pax = parsePax(await readMeta(reader, headerSize))
      const p = pax.get('path')
      if (p !== undefined) paxPath = p
      const s = pax.get('size')
      if (s !== undefined) {
        if (!/^\d+$/.test(s)) throw new ArchiveError('archive has an invalid pax size')
        paxSize = Number(s)
      }
      continue
    }
    if (type === 'g') {
      await readMeta(reader, headerSize)
      continue
    }

    // A pax `size` record overrides the header's for the entry it precedes.
    const size = paxSize ?? headerSize
    const padding = Math.ceil(size / BLOCK) * BLOCK - size

    const name = paxPath ?? longName ?? ustarName(header)
    longName = paxPath = paxSize = null
    countEntry(ctx)
    if (type === '1' || type === '2' || type === 'K') {
      throw new ArchiveError(`archive contains a link: ${name}`)
    }
    const rel = safeEntryPath(name)
    if (type === '5') {
      await makeDir(ctx, rel)
      await drain(reader.take(size + padding))
      continue
    }
    if (type !== '0' && type !== '7') {
      throw new ArchiveError(`archive entry ${rel} has unsupported type '${type}'`)
    }
    if (size > ctx.limits.maxEntryBytes) {
      throw new ArchiveError(`archive entry ${rel} exceeds ${ctx.limits.maxEntryBytes} bytes`)
    }
    if (ctx.select(rel) === null) {
      ctx.files.push({ entryPath: rel, dest: null, size, sha256: null })
      await drain(reader.take(size + padding))
      continue
    }
    await writeFile(ctx, rel, size, octal(header, 100, 8, 'mode'), reader.take(size))
    await drain(reader.take(padding))
  }
}

/** Extract a `.tar.gz` file into `destDir` (which must exist). */
export async function extractTarGz(
  file: string,
  destDir: string,
  opts: ExtractOptions = {}
): Promise<ExtractedFile[]> {
  const ctx = context(destDir, opts)
  const source = createReadStream(file, { highWaterMark: 1024 * 1024 })
  const gunzip = createGunzip({ chunkSize: 256 * 1024 })
  source.on('error', (err) => gunzip.destroy(err))
  source.pipe(gunzip)
  let total = 0
  const reader = new ByteReader(gunzip[Symbol.asyncIterator](), (n) => {
    total += n
    if (total > ctx.limits.maxTotalBytes) {
      throw new ArchiveError(`archive unpacks to more than ${ctx.limits.maxTotalBytes} bytes`)
    }
  })
  try {
    await readTar(reader, ctx)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'Z_DATA_ERROR') {
      throw new ArchiveError('archive is not valid gzip')
    }
    throw err
  } finally {
    source.destroy()
    gunzip.destroy()
  }
  return ctx.files
}

// ── zip ───────────────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

async function readAt(handle: fsp.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buf, 0, length, position)
  if (bytesRead !== length) throw new ArchiveError('zip is truncated')
  return buf
}

interface ZipEntry {
  name: string
  method: number
  flags: number
  compSize: number
  size: number
  unixMode: number
  localOffset: number
}

function parseCentralDirectory(cd: Buffer, count: number): ZipEntry[] {
  const entries: ZipEntry[] = []
  let pos = 0
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== CEN_SIG) {
      throw new ArchiveError('zip has a bad central directory entry')
    }
    const madeBy = cd.readUInt16LE(pos + 4) >> 8
    const nameLen = cd.readUInt16LE(pos + 28)
    const extraLen = cd.readUInt16LE(pos + 30)
    const commentLen = cd.readUInt16LE(pos + 32)
    const attrs = cd.readUInt32LE(pos + 38)
    entries.push({
      flags: cd.readUInt16LE(pos + 8),
      method: cd.readUInt16LE(pos + 10),
      compSize: cd.readUInt32LE(pos + 20),
      size: cd.readUInt32LE(pos + 24),
      // Unix permissions live in the upper half when the entry was made on Unix (3).
      unixMode: madeBy === 3 ? attrs >>> 16 : 0,
      localOffset: cd.readUInt32LE(pos + 42),
      name: cd.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Extract a `.zip` file into `destDir` (which must exist). Stored and deflated entries only; no zip64. */
export async function extractZip(
  file: string,
  destDir: string,
  opts: ExtractOptions = {}
): Promise<ExtractedFile[]> {
  const ctx = context(destDir, opts)
  const handle = await fsp.open(file, 'r')
  try {
    const { size: fileSize } = await handle.stat()
    const tailLen = Math.min(fileSize, 22 + 0xffff)
    if (tailLen < 22) throw new ArchiveError('zip is truncated')
    const tail = await readAt(handle, fileSize - tailLen, tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new ArchiveError('zip has no end of central directory')
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 8) !== count) {
      throw new ArchiveError('multi-disk zips are not supported')
    }
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ArchiveError('zip64 archives are not supported')
    }
    if (cdOffset + cdSize > fileSize) throw new ArchiveError('zip is truncated')
    const entries = parseCentralDirectory(await readAt(handle, cdOffset, cdSize), count)

    let total = 0
    for (const entry of entries) {
      countEntry(ctx)
      const type = entry.unixMode & S_IFMT
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
        throw new ArchiveError(`zip contains a link or special file: ${entry.name}`)
      }
      const rel = safeEntryPath(entry.name)
      if (entry.name.endsWith('/') || entry.name.endsWith('\\') || type === S_IFDIR) {
        await makeDir(ctx, rel)
        continue
      }
      if (entry.flags & 1) throw new ArchiveError(`zip entry ${rel} is encrypted`)
      if (entry.method !== 0 && entry.method !== 8) {
        throw new ArchiveError(`zip entry ${rel} uses unsupported compression ${entry.method}`)
      }
      if (entry.size > ctx.limits.maxEntryBytes) {
        throw new ArchiveError(`archive entry ${rel} exceeds ${ctx.limits.maxEntryBytes} bytes`)
      }
      total += entry.size
      if (total > ctx.limits.maxTotalBytes) {
        throw new ArchiveError(`archive unpacks to more than ${ctx.limits.maxTotalBytes} bytes`)
      }
      if (ctx.select(rel) === null) {
        ctx.files.push({ entryPath: rel, dest: null, size: entry.size, sha256: null })
        continue
      }
      const local = await readAt(handle, entry.localOffset, 30)
      if (local.readUInt32LE(0) !== LOC_SIG) throw new ArchiveError(`zip entry ${rel} is corrupt`)
      const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      if (start + entry.compSize > fileSize) throw new ArchiveError('zip is truncated')
      await writeFile(ctx, rel, entry.size, entry.unixMode, zipData(file, start, entry))
    }
  } finally {
    await handle.close()
  }
  return ctx.files
}

async function* zipData(file: string, start: number, entry: ZipEntry): AsyncGenerator<Buffer> {
  if (entry.compSize === 0) return
  const raw = createReadStream(file, { start, end: start + entry.compSize - 1 })
  let stream: Readable = raw
  if (entry.method === 8) {
    const inflate = createInflateRaw()
    raw.on('error', (err) => inflate.destroy(err))
    raw.pipe(inflate)
    stream = inflate
  }
  try {
    for await (const chunk of stream) yield chunk as Buffer
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'Z_DATA_ERROR') {
      throw new ArchiveError('zip entry is not valid deflate data')
    }
    throw err
  } finally {
    raw.destroy()
    stream.destroy()
  }
}
