/**
 * Where a media job reads its input images and writes its result (Critical: path containment).
 *
 * A path the agent names is held to what the session itself may touch: its working directory (the
 * worktree it entered, `currentWorkdir`, else its spawn cwd) and the user's additional directories.
 * Containment is `session-tools`' `withinOrEqual` (the one `dispatch-workdir.ts` applies): both sides
 * by real path, a path that does not exist yet real up to its nearest existing ancestor, so a link or a
 * junction that leaves the roots puts the path outside. An agent-given OUTPUT path also may not name an
 * agent-control file (`.claude/settings.json`, `.git/hooks/...`), and may only create a new file or
 * replace an existing image/video file of the same media type; the file is written to a temp name and
 * renamed, so a half-written result never sits under the final name.
 *
 * The default path (`<workdir>/.claude/ui/media/<session-key>/<job>.<ext>`, or `<workdir>/generated/…`)
 * is ClaudeUI's own choice, so it skips the agent-control rule (it is under `.claude` by design) but
 * still has to be contained. Input images: regular files, at most 20 MiB, PNG/JPEG/WebP/GIF by magic bytes.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isAgentControlTarget } from '../automode/agent-control-paths'
import type { MediaKind, MediaSaveTo } from '../../shared/media-generation'
import type { WorktreeInfo } from '../../shared/types'
import { expandHome } from './additional-directories'
import { withinOrEqual } from './session-tools'
import { currentWorkdir } from './session-workdir'

/** Largest input image a job reads. */
export const MEDIA_INPUT_MAX_BYTES = 20 * 1024 * 1024

export interface MediaPathContext {
  /** The session's spawn cwd. */
  cwd: string
  /** The worktree it entered, if any. */
  worktree?: WorktreeInfo | null
  /** The user's additional directories, absolute. */
  additionalDirectories?: readonly string[]
}

export type PathResult<T> = ({ ok: true } & T) | { ok: false; error: string }

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const VIDEO_EXTS = ['.mp4', '.webm', '.mov']

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov'
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
}

/** The extension a provider's mime type is saved under; the kind's default for an unknown one. */
export function extForMime(mime: string, kind: MediaKind): string {
  return MIME_EXT[mime.toLowerCase().split(';')[0].trim()] ?? (kind === 'image' ? '.png' : '.mp4')
}

/** The mime type a saved media file is served as, from its extension. */
export function mimeForExt(file: string): string | undefined {
  return EXT_MIME[path.extname(file).toLowerCase()]
}

function extsOf(kind: MediaKind): string[] {
  return kind === 'image' ? IMAGE_EXTS : VIDEO_EXTS
}

/** The directory a session works in and every root a media path may sit under. */
export function mediaRoots(ctx: MediaPathContext): { workdir: string; roots: string[] } {
  const workdir = currentWorkdir(ctx.cwd, ctx.worktree)
  return { workdir, roots: [...new Set([workdir, ctx.cwd, ...(ctx.additionalDirectories ?? [])])] }
}

/** Is `file` inside the session's roots (by real path)? */
export function isInsideMediaRoots(ctx: MediaPathContext, file: string): boolean {
  return mediaRoots(ctx).roots.some((root) => withinOrEqual(root, file))
}

function absolute(ctx: MediaPathContext, given: string): string {
  return path.resolve(mediaRoots(ctx).workdir, expandHome(given.trim()))
}

/**
 * The checks every OUTPUT path passes, agent-given or not: inside the roots, and a target that is
 * absent or an existing regular file of this kind (never a directory, never a non-media file).
 */
function checkOutput(
  ctx: MediaPathContext,
  file: string,
  kind: MediaKind,
  agentGiven: boolean
): string | null {
  if (!isInsideMediaRoots(ctx, file)) {
    return `The path ${file} is not inside your working directory or the user's additional directories.`
  }
  if (agentGiven && isAgentControlTarget(file, mediaRoots(ctx).workdir)) {
    return `The path ${file} is an agent configuration location; choose another path.`
  }
  let existing: fs.Stats | null = null
  try {
    existing = fs.lstatSync(file)
  } catch {
    // Absent: a new file.
  }
  if (existing) {
    if (!existing.isFile()) return `The path ${file} exists and is not a regular file.`
    if (agentGiven && !extsOf(kind).includes(path.extname(file).toLowerCase())) {
      return `The path ${file} exists and is not ${kind === 'image' ? 'an image' : 'a video'} file, so it will not be overwritten.`
    }
  }
  return null
}

/**
 * The path a job will write, before the provider answers: the agent's `requested` one, or the default.
 * The extension is provisional (the provider's format decides the final one, {@link finalOutputPath}).
 */
export function resolveMediaOutput(
  ctx: MediaPathContext,
  opts: {
    requested?: string
    kind: MediaKind
    saveTo: MediaSaveTo
    sessionKey: string
    jobId: string
  }
): PathResult<{ path: string; agentGiven: boolean }> {
  const { workdir } = mediaRoots(ctx)
  const agentGiven = typeof opts.requested === 'string' && opts.requested.trim() !== ''
  let file: string
  if (agentGiven) {
    file = absolute(ctx, opts.requested as string)
    const ext = path.extname(file).toLowerCase()
    if (!extsOf(opts.kind).includes(ext)) {
      return {
        ok: false,
        error: `The path must end in ${extsOf(opts.kind).join(', ')} for ${opts.kind} generation.`
      }
    }
  } else {
    const dir =
      opts.saveTo === 'generated'
        ? path.join(workdir, 'generated')
        : path.join(workdir, '.claude', 'ui', 'media', safeSegment(opts.sessionKey))
    file = path.join(dir, `${safeSegment(opts.jobId)}${extForMime('', opts.kind)}`)
  }
  const error = checkOutput(ctx, file, opts.kind, agentGiven)
  return error ? { ok: false, error } : { ok: true, path: file, agentGiven }
}

/** Does anything (a link included, even a dangling one) sit at `file`? */
function lexists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * The path a finished job is saved under: the provisional one with the extension of what the provider
 * returned, checked again (the extension changed the name, and a minute has passed). When the agent named
 * the file and the extension had to change, the new name is one the agent did not name: an existing file
 * there is never replaced, the job saves beside it as `<stem>.<jobId>.<ext>` (the notice carries the path).
 */
export function finalOutputPath(
  ctx: MediaPathContext,
  provisional: string,
  mime: string,
  kind: MediaKind,
  agentGiven: boolean,
  jobId: string
): PathResult<{ path: string }> {
  const parsed = path.parse(provisional)
  const ext = extForMime(mime, kind)
  let file = path.join(parsed.dir, parsed.name + ext)
  // Only a REAL extension change can land on a file the agent didn't name: compared case-folded,
  // so `Hero.PNG` returned as PNG still replaces the file the agent asked to replace.
  if (agentGiven && ext !== parsed.ext.toLowerCase() && lexists(file)) {
    file = path.join(parsed.dir, `${parsed.name}.${safeSegment(jobId)}${ext}`)
  }
  const error = checkOutput(ctx, file, kind, agentGiven)
  return error ? { ok: false, error } : { ok: true, path: file }
}

/**
 * Write `bytes` to `file`: temp file in the same directory, then rename. The directory is created, and
 * the real location it lands in is checked against the roots again, so a link made between the check
 * and the write cannot carry the file out.
 */
export function writeMediaFile(ctx: MediaPathContext, file: string, bytes: Buffer): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  if (!isInsideMediaRoots(ctx, dir) || !isInsideMediaRoots(ctx, file)) {
    throw new Error(`The path ${file} is not inside your working directory.`)
  }
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' })
    fs.renameSync(temp, file)
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Best effort: the temp file is ours and inside the roots.
    }
    throw err
  }
}

/** A ref or job id as one path segment: nothing that could climb or nest. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_'
}

/** The image type of `bytes` by magic number: PNG, JPEG, WebP or GIF. */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif'
  return undefined
}

/** An input image: inside the roots, a regular file, within the size cap, an image by its bytes. */
export function readMediaInput(
  ctx: MediaPathContext,
  given: string
): PathResult<{ path: string; bytes: Buffer; mime: string }> {
  const file = absolute(ctx, given)
  if (!isInsideMediaRoots(ctx, file)) {
    return {
      ok: false,
      error: `The image ${given} is not inside your working directory or the user's additional directories.`
    }
  }
  try {
    const real = fs.realpathSync.native(file)
    // The real path is what was checked and what is read.
    if (!isInsideMediaRoots(ctx, real)) {
      return { ok: false, error: `The image ${given} is not inside your working directory.` }
    }
    const stat = fs.statSync(real)
    if (!stat.isFile()) return { ok: false, error: `The image ${given} is not a regular file.` }
    if (stat.size > MEDIA_INPUT_MAX_BYTES) {
      return { ok: false, error: `The image ${given} is larger than 20 MiB.` }
    }
    const bytes = fs.readFileSync(real)
    if (bytes.length > MEDIA_INPUT_MAX_BYTES) {
      return { ok: false, error: `The image ${given} is larger than 20 MiB.` }
    }
    const mime = sniffImageMime(bytes)
    if (!mime) return { ok: false, error: `The image ${given} is not a PNG, JPEG, WebP or GIF.` }
    return { ok: true, path: real, bytes, mime }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      ok: false,
      error:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? `The image ${given} does not exist.`
          : `The image ${given} cannot be read (${code ?? 'unreadable'}).`
    }
  }
}
