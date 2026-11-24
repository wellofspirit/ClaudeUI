/**
 * The server's staged releases under `<root>/versions/` (`server-layout.ts`):
 * staging a downloaded archive, the deletion gate, and the sweep after a healthy
 * update.
 *
 * ## THE deletion gate (Critical: anything that deletes user files)
 *
 * {@link removeServerVersionDir} is the only recursive delete in `src/server`.
 * It refuses unless every check holds:
 *   1. the name is a direct child of `<root>/versions` (no separators, not `.`/`..`);
 *   2. the name is ours: a release version, or `.partial-<v>-<8 hex>`;
 *   3. `versions/` and the candidate are real directories (`lstat`: a symlink or a
 *      Windows junction is refused, so a delete never follows a link elsewhere);
 *   4. the candidate proves it is ours: a valid server marker, or — for a
 *      `.partial-*` only — the `.claudeui-staging` file the stager writes right
 *      after creating it (`{ token, version, at }`, its version the name's). A
 *      partial with neither is left in place and logged, never deleted;
 *   5. it is not the version `current` names, nor the `from` or `to` of a pending
 *      update (an open health window), nor a name the caller protects.
 * A refusal returns the reason and logs it; nothing is touched. It never throws.
 * The flat install (the root's own files) is never a candidate: it is not under
 * `versions/`.
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ArchiveError, extractTarGz, extractZip } from '../core/harness/install/archive'
import { isReleaseVersion } from '../shared/update-manifest'
import {
  readCurrent,
  readPending,
  readServerMarker,
  sameName,
  serverExeName,
  serverFolderProblem,
  versionDir,
  versionsDir,
  versionsDirIsReal
} from './server-layout'

export type GateResult = { removed: true } | { removed: false; reason: string }

export interface GateOptions {
  platform: string
  /** Names that must survive (the running version, an open window's `from`). */
  protect?: readonly string[]
  log?: (message: string) => void
}

const PARTIAL_RE = /^\.partial-(.+)-([0-9a-f]{8})$/

/** Written into a `.partial-*` right after its exclusive mkdir: the stager's proof of ownership. */
export const STAGING_FILE = '.claudeui-staging'

/** Does `dir` hold a staging file for `version`? */
function hasStagingProof(dir: string, version: string): boolean {
  const file = path.join(dir, STAGING_FILE)
  try {
    if (!fs.lstatSync(file).isFile()) return false
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null
    return (
      typeof raw?.token === 'string' &&
      /^[0-9a-f]{32}$/.test(raw.token) &&
      raw.version === version &&
      typeof raw.at === 'number'
    )
  } catch {
    return false
  }
}

/** `.partial-<v>-<t8>`: where {@link stageServerArchive} extracts before the rename. */
export function partialName(version: string, t8: string): string {
  return `.partial-${version}-${t8}`
}

/** A name the server's machinery gives a `versions/` entry. */
export function isOwnedVersionName(name: string): boolean {
  if (isReleaseVersion(name)) return true
  const m = PARTIAL_RE.exec(name)
  return m !== null && isReleaseVersion(m[1])
}

const defaultLog = (message: string): void => {
  process.stderr.write(`[server-versions] ${message}\n`)
}

export function removeServerVersionDir(
  root: string,
  name: string,
  options: GateOptions
): GateResult {
  const log = options.log ?? defaultLog
  const refuse = (reason: string): GateResult => {
    log(`deletion gate refused versions/${JSON.stringify(name)}: ${reason}`)
    return { removed: false, reason }
  }
  try {
    return gate(path.resolve(root), name, options, refuse, log)
  } catch (err) {
    return refuse(`the delete failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function gate(
  root: string,
  name: string,
  options: GateOptions,
  refuse: (reason: string) => GateResult,
  log: (message: string) => void
): GateResult {
  const { platform } = options
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    /[\\/\0]/.test(name)
  )
    return refuse('not a direct child of versions/')
  if (!isOwnedVersionName(name))
    return refuse('the name is neither a release version nor a staging folder')
  const parent = versionsDir(root)
  const candidate = path.join(parent, name)
  if (path.dirname(candidate) !== parent) return refuse('not a direct child of versions/')
  if (!versionsDirIsReal(root)) return refuse('versions/ is not a real directory')
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(candidate)
  } catch {
    return refuse('it does not exist')
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return refuse('not a real directory')
  // Any server marker proves the folder is one a ClaudeUI release put there; a
  // version folder whose marker names another version is still ours to replace.
  // A partial extraction may not have reached its marker: the stager's own file
  // proves it instead.
  const partial = PARTIAL_RE.exec(name)
  if (!readServerMarker(candidate) && !(partial && hasStagingProof(candidate, partial[1]))) {
    if (partial) log(`left the partial extraction versions/${name} in place`)
    return refuse('no ClaudeUI server marker inside')
  }
  const same = (a: string | null | undefined): boolean =>
    typeof a === 'string' && sameName(a, name, platform)
  if (same(readCurrent(root))) return refuse('it is the version current names')
  const pending = readPending(root)
  if (pending === 'invalid') return refuse('an unreadable pending update may name it')
  if (pending && (same(pending.from) || same(pending.to)))
    return refuse('a pending update names it')
  if (options.protect?.some(same)) return refuse('it is in use')

  try {
    fs.rmSync(candidate, { recursive: true, force: false, maxRetries: 3 })
  } catch (err) {
    return refuse(`the delete failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  log(`removed versions/${name}`)
  return { removed: true }
}

/**
 * After a healthy update: remove every release folder under `versions/` but the
 * `keep` ones (the running version and the one before it), each through the
 * gate. Partial extractions are left to their stager. Returns the names removed.
 */
export function gcServerVersions(
  root: string,
  keep: readonly string[],
  options: GateOptions
): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(versionsDir(root), { withFileTypes: true })
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!isReleaseVersion(entry.name)) continue
    if (keep.some((k) => sameName(k, entry.name, options.platform))) continue
    const result = removeServerVersionDir(root, entry.name, {
      ...options,
      protect: [...keep, ...(options.protect ?? [])]
    })
    if (result.removed) removed.push(entry.name)
  }
  return removed
}

// ── Staging ──────────────────────────────────────────────────────────────────

/** A server archive is ~0.5 GB unpacked on macOS and Windows (it carries Claude Code). */
const SERVER_EXTRACT_LIMITS = {
  maxEntryBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 50_000
}

/** Executables in a server folder that need the exec bit on POSIX. */
function executablesOf(platform: string): string[] {
  return [serverExeName(platform), path.join('vendor', 'claude-cli', 'bun-claude')]
}

export interface StageArgs {
  root: string
  archive: string
  version: string
  platform: string
  log?: (message: string) => void
  /** The partial folder's 8 hex (injectable for tests). */
  t8?: string
  signal?: AbortSignal
  /** The final rename and its wait (injectable for tests). */
  rename?: (from: string, to: string) => void
  sleep?: (ms: number) => Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The Windows budget for moving a fresh extraction into place: antivirus scans a
 * new ~0.5 GB tree for a while, holding files open. About 30 s.
 */
export const STAGE_RENAME_RETRY = { attempts: 60, delayMs: 500 }

/** `rename`, retried on Windows while antivirus or the indexer holds a file. */
async function renameRetrying(
  from: string,
  to: string,
  platform: string,
  rename: (from: string, to: string) => void,
  wait: (ms: number) => Promise<void>
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (
        platform !== 'win32' ||
        !['EPERM', 'EBUSY', 'EACCES'].includes(code) ||
        attempt >= STAGE_RENAME_RETRY.attempts
      )
        throw err
      await wait(STAGE_RENAME_RETRY.delayMs)
    }
  }
}

/**
 * Remove leftover `.partial-*` folders through the gate (one that proves nothing
 * stays). Staging is single-flight (the core update service downloads one release
 * at a time), so none of them is in use.
 */
function sweepPartials(root: string, platform: string, log: (message: string) => void): void {
  let names: string[]
  try {
    names = fs.readdirSync(versionsDir(root))
  } catch {
    return
  }
  for (const name of names)
    if (PARTIAL_RE.test(name)) removeServerVersionDir(root, name, { platform, log })
}

/**
 * Extract a verified server archive into `versions/<version>` and return its id
 * (the version). The archive holds one root folder (`claudeui-server-<v>-<target>/`),
 * which is stripped; the result must be a server folder of exactly `version` with
 * this platform's executable. An existing valid `versions/<version>` is reused; an
 * invalid one is replaced through the gate. Leftover partials are swept first; a
 * partial whose final rename keeps failing (files held open on Windows) is left
 * for the next sweep rather than deleted while locked. Errors carry no local path
 * (every client sees them).
 */
export async function stageServerArchive(args: StageArgs): Promise<{ stagedId: string }> {
  const { version, platform } = args
  const root = path.resolve(args.root)
  const log = args.log ?? defaultLog
  if (!isReleaseVersion(version)) throw new Error(`Not a release version: ${version}`)
  const archiveName = path.basename(args.archive)
  const kind = archiveName.endsWith('.zip')
    ? 'zip'
    : archiveName.endsWith('.tar.gz')
      ? 'tar.gz'
      : null
  if (!kind) throw new Error('The update is neither a .zip nor a .tar.gz archive')

  const parent = versionsDir(root)
  try {
    fs.mkdirSync(parent)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw redact(err, root)
  }
  if (!versionsDirIsReal(root))
    throw new Error('versions/ in the server folder is not a real directory')
  sweepPartials(root, platform, log)

  const name = partialName(version, args.t8 ?? randomBytes(4).toString('hex'))
  const partial = path.join(parent, name)
  try {
    fs.mkdirSync(partial)
  } catch (err) {
    throw redact(err, root)
  }
  let renaming = false
  try {
    // The proof that this partial is ours, before anything from the archive lands
    // (an archive entry of the same name then fails as a duplicate).
    fs.writeFileSync(
      path.join(partial, STAGING_FILE),
      JSON.stringify({ token: randomBytes(16).toString('hex'), version, at: Date.now() }),
      { flag: 'wx', mode: 0o600 }
    )
    let rootFolder: string | null = null
    const select = (entry: string): string | null => {
      const [first, ...rest] = entry.split('/')
      if (rootFolder === null) rootFolder = first
      else if (first !== rootFolder)
        throw new ArchiveError('the archive must hold exactly one root folder')
      return rest.length === 0 ? null : rest.join('/')
    }
    const extract = kind === 'zip' ? extractZip : extractTarGz
    const files = await extract(args.archive, partial, {
      select,
      limits: SERVER_EXTRACT_LIMITS,
      platform: platform as NodeJS.Platform,
      signal: args.signal
    })
    if (files.some((f) => f.dest === null))
      throw new ArchiveError('the archive has files outside its root folder')
    // The zip reader keeps unix modes only when the archive recorded them.
    if (platform !== 'win32') {
      for (const rel of executablesOf(platform)) {
        const file = path.join(partial, rel)
        try {
          if (fs.lstatSync(file).isFile()) fs.chmodSync(file, 0o755)
        } catch {
          /* absent (a linux server ships no Claude Code) */
        }
      }
    }
    const problem = serverFolderProblem(partial, version, platform)
    if (problem) throw new Error(`The archive is not a ClaudeUI server ${version}: ${problem}`)

    const final = versionDir(root, version)
    let exists = true
    try {
      fs.lstatSync(final)
    } catch {
      exists = false
    }
    if (exists) {
      if (serverFolderProblem(final, version, platform) === null) {
        log(`versions/${version} is already staged; reusing it`)
        removeServerVersionDir(root, name, { platform, log })
        return { stagedId: version }
      }
      const removed = removeServerVersionDir(root, version, { platform, log })
      if (!removed.removed)
        throw new Error(
          `versions/${version} exists and is not a valid server folder (${removed.reason}); remove it by hand`
        )
    }
    // The staged folder holds what the archive held; the validated marker proves
    // the partial is ours from here on.
    fs.unlinkSync(path.join(partial, STAGING_FILE))
    renaming = true
    await renameRetrying(
      partial,
      final,
      platform,
      args.rename ?? fs.renameSync,
      args.sleep ?? sleep
    )
    log(`staged versions/${version}`)
    return { stagedId: version }
  } catch (err) {
    if (renaming) log(`left versions/${name} in place for the next staging to sweep`)
    else if (fs.existsSync(partial)) removeServerVersionDir(root, name, { platform, log })
    throw redact(
      renaming ? new Error(`Could not move ${version} into place: ${message(err)}`) : err,
      root,
      path.dirname(path.resolve(args.archive))
    )
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * An error whose message names the server folder (and the download folder) by a
 * placeholder instead: `app-update:state` is shown to every client.
 */
function redact(err: unknown, root: string, downloads?: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  let clean = message.split(root).join('<server folder>')
  if (downloads) clean = clean.split(downloads).join('<downloads>')
  if (err instanceof Error && clean === message) return err
  return new Error(clean)
}
