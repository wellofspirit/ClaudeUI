/**
 * A local rebuild of ClaudeUI from a source tree, staged beside the install
 * (Critical: it runs a tree's build scripts with the user's rights, and stages
 * the build the relaunch helper swaps in).
 *
 * `start(treeId)`:
 *   1. refuse: a rebuild already running (single-flight); a relaunch in flight;
 *      the id not in a fresh listing of the host's own trees (`trees.ts`); a
 *      pre-check (`precheckTree`): the tree's build scripts have `build:stage`,
 *      its `claudeCliVersion` equals `vendor/claude-cli/version.json` as resolved
 *      inside the tree, and when its `node_modules` resolves outside the tree
 *      (a worktree linked to the main checkout's) its `bun.lock` equals the one
 *      next to that `node_modules`; `bun` found; the install eligible;
 *   2. spawn `bun scripts/build.mjs build:stage -v` in the tree with
 *      `CLAUDEUI_BUILD_OUT=<downloadsDir>/rebuild-<t8>` (POSIX: its own process
 *      group), output to `<downloadsDir>/rebuild-<t8>.log` and parsed for the
 *      stages and the last line (`progress.ts`).
 *   3. exit 0: the built app (`mac-arm64/ClaudeUI.app` / `win-unpacked`) must
 *      carry a desktop install marker with a version; it is copied to the
 *      staging name beside the install (macOS `ditto`, Windows a recursive
 *      copy), the copy checked again, and the output folder removed through
 *      the downloads gate. Anything else: the output folder goes the same way,
 *      a partial staged copy through the deletion gate; the log stays.
 * `cancel()` stops the build by pid (POSIX: SIGTERM to the process group,
 * SIGKILL after 5 s; Windows: `taskkill /pid <pid> /T /F`), never by name, then
 * cleans up as on failure. `stop()` (quitting) does the same and refuses every
 * later start, including one still in its pre-checks: it is checked again right
 * before the build is spawned, so a quit never leaves a detached build running.
 * A new rebuild replaces the previous built one.
 *
 * The copy goes through the extract container (`app-update/extract-container.ts`)
 * like a release: into `.<base>.extract-<version>-<t8>/<inner>`, checked, then
 * renamed to the staging name; a failed or interrupted copy is removable by its
 * staging record. Everything a client sees (progress lines, the error) has local
 * paths and the signing identity replaced.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseBuildInfo } from '../../../shared/build-info'
import type {
  AppUpdateRebuildProgress,
  AppUpdateTreeSummary
} from '../../../shared/types/app-update'
import { checkStagedBuild, DITTO } from '../app-update/stage'
import type { Exec } from '../app-update/exec'
import {
  closeContainer,
  discardContainer,
  openExtractContainer,
  promote
} from '../app-update/extract-container'
import { removeOwnedDir } from '../relaunch/delete-gate'
import { newToken, type RelaunchPlatform } from '../relaunch/paths'
import { removeDownloadsEntry } from './downloads-gate'
import { BuildProgress, expectedStageLabels } from './progress'
import { publicTree, type SourceTree } from './trees'

/** The error a cancelled rebuild's `done` rejects with (the service checks the name). */
export class RebuildCancelled extends Error {
  override name = 'RebuildCancelled'
  constructor() {
    super('The rebuild was cancelled')
  }
}

export const CANCEL_GRACE_MS = 5_000

/**
 * Remove the signing identity from a build output line: the known identity
 * (`MAC_SIGN_IDENTITY`), whatever follows `--sign` up to the path after it,
 * and codesign / electron-builder identity fields.
 */
export function scrubIdentity(line: string, identity?: string): string {
  let s = line
  if (identity && identity !== '-' && identity.length >= 2) s = s.split(identity).join('<identity>')
  s = s.replace(
    /(--sign\s+)(?:"[^"]*"|'[^']*'|.*?)(?=\s+(?:\/|…|~|<tree>|[A-Za-z]:\\)|$)/g,
    '$1<identity>'
  )
  s = s.replace(/\b(Authority|TeamIdentifier)=.*$/g, '$1=<identity>')
  s = s.replace(/\b(identityName|identity)=.*?(?=\s+[A-Za-z]+=|$)/g, '$1=<identity>')
  s = s.replace(/\bidentityHash=\S+/g, 'identityHash=<identity>')
  return s
}

/** Replace each `from` (longest first) by its `to`; on Windows the forward-slash spelling too. */
function pathScrubber(
  pairs: Array<[string | null | undefined, string]>,
  platform: RelaunchPlatform
): (text: string) => string {
  const list: Array<[string, string]> = []
  for (const [from, to] of pairs) {
    if (!from || from.length < 2) continue
    list.push([from, to])
    if (platform === 'win32') list.push([from.replace(/\\/g, '/'), to])
  }
  list.sort((a, b) => b[0].length - a[0].length)
  return (text) => list.reduce((s, [from, to]) => s.split(from).join(to), text)
}

/** Environment a rebuild must not inherit: each would change what gets built. */
const STRIPPED_ENV = [
  'CLAUDEUI_CLI_VENDOR_DIR',
  'CLAUDEUI_BUILD_KIND',
  'CLAUDEUI_RELEASE_CHANNEL',
  'CLAUDEUI_BUILD_OUT',
  'ELECTRON_RUN_AS_NODE'
]

// ── Pre-checks ────────────────────────────────────────────────────────────────

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Why `treePath` cannot be rebuilt as it stands, or null. Reasons name no local path. */
export function precheckTree(treePath: string): string | null {
  let targets = ''
  try {
    targets = fs.readFileSync(path.join(treePath, 'scripts', 'lib', 'build-targets.mjs'), 'utf8')
  } catch {
    /* handled below */
  }
  if (!targets.includes("'build:stage'"))
    return "This tree's build scripts predate rebuilds (no build:stage target): update it first"

  let pinned: unknown
  try {
    pinned = (readJson(path.join(treePath, 'package.json')) as { claudeCliVersion?: unknown })
      .claudeCliVersion
  } catch {
    return "This tree's package.json could not be read"
  }
  if (typeof pinned !== 'string' || pinned === '')
    return "This tree's package.json does not pin a Claude Code version"
  let vendored: unknown
  try {
    vendored = (
      readJson(path.join(treePath, 'vendor', 'claude-cli', 'version.json')) as {
        version?: unknown
      }
    ).version
  } catch {
    return 'vendor/claude-cli is missing in this tree: run bun install first'
  }
  if (vendored !== pinned)
    return `This tree pins Claude Code ${pinned}, but vendor/claude-cli holds ${String(vendored)}: run bun run ensure-cli first`

  let realTree: string
  let modules: string
  try {
    realTree = fs.realpathSync(treePath)
    modules = fs.realpathSync(path.join(treePath, 'node_modules'))
  } catch {
    return 'node_modules is missing in this tree: run bun install first'
  }
  if (!isInside(realTree, modules)) {
    const owner = path.dirname(modules)
    let mine: Buffer | null = null
    let theirs: Buffer | null = null
    try {
      mine = fs.readFileSync(path.join(treePath, 'bun.lock'))
    } catch {
      /* compared below */
    }
    try {
      theirs = fs.readFileSync(path.join(owner, 'bun.lock'))
    } catch {
      /* compared below */
    }
    if (!mine || !theirs || !mine.equals(theirs))
      return `Dependencies changed: run bun install in ${path.basename(owner)} first`
  }
  return null
}

/** `bun` on PATH (the login-shell PATH on macOS, imported at startup), else its usual homes. */
export function findBun(
  env: NodeJS.ProcessEnv,
  platform: RelaunchPlatform,
  home: string = os.homedir(),
  isFile: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
): string | null {
  const exe = platform === 'win32' ? 'bun.exe' : 'bun'
  const p = platform === 'win32' ? path.win32 : path.posix
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const dirs = (pathKey ? (env[pathKey] ?? '') : '').split(p.delimiter).filter(Boolean)
  const fallbacks =
    platform === 'win32'
      ? [p.join(home, '.bun', 'bin')]
      : [p.join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of [...dirs, ...fallbacks]) {
    if (!p.isAbsolute(dir)) continue
    const candidate = p.join(dir, exe)
    if (isFile(candidate)) return candidate
  }
  return null
}

/** The child's environment: ours, the bun dir first on PATH, the build output, no colour, nothing that changes the build. */
export function rebuildEnv(
  base: NodeJS.ProcessEnv,
  bun: string,
  outDir: string,
  platform: RelaunchPlatform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  const same = (a: string, b: string): boolean =>
    platform === 'win32' ? a.toUpperCase() === b.toUpperCase() : a === b
  for (const key of Object.keys(env)) if (STRIPPED_ENV.some((s) => same(s, key))) delete env[key]
  const p = platform === 'win32' ? path.win32 : path.posix
  const pathKey = Object.keys(env).find((k) => same(k, 'PATH')) ?? 'PATH'
  const current = env[pathKey] ?? ''
  env[pathKey] = current ? `${p.dirname(bun)}${p.delimiter}${current}` : p.dirname(bun)
  env.CLAUDEUI_BUILD_OUT = outDir
  env.FORCE_COLOR = '0'
  return env
}

// ── The rebuilder ─────────────────────────────────────────────────────────────

export interface BuiltRebuild {
  stagedPath: string
  version: string
  commit: string | null
  treeName: string
}

/** The install to stage beside; when it cannot be used, the reason (and its path, to scrub from messages). */
export type InstallReading =
  { ok: true; path: string } | { ok: false; reason: string; path?: string }

export interface RebuilderDeps {
  platform: RelaunchPlatform
  /** The install to stage beside, read fresh (S1 eligibility). */
  install: () => InstallReading
  /** The relaunch state dir (the deletion gate consults its lock). */
  stateDir: string
  downloadsDir: string
  listTrees: () => Promise<SourceTree[]>
  /** Whether a relaunch is in flight (a rebuild waits it out). */
  relaunchBusy: () => boolean
  exec: Exec
  findBun?: () => string | null
  env?: () => NodeJS.ProcessEnv
  spawnBuild?: (file: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** Copy the built app to the staging name (default: macOS `ditto`, Windows a recursive copy). */
  copyApp?: (from: string, to: string) => Promise<void>
  /** POSIX: signal the build's process group (default `process.kill(-pid, signal)`). */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void
  /** Windows: end the build's process tree (default `taskkill /pid <pid> /T /F`). */
  killTree?: (pid: number) => void
  precheck?: (treePath: string) => string | null
  now?: () => number
  newT8?: () => string
  /** A folder created for this rebuild (the boot sweep spares it), and when it is let go. */
  onCreated?: (dir: string) => void
  onReleased?: (dir: string) => void
  cancelGraceMs?: number
  log?: (message: string) => void
}

export interface RebuildStart {
  tree: AppUpdateTreeSummary
  done: Promise<{ version: string; commit: string | null }>
}

export interface Rebuilder {
  start(treeId: string, onProgress: (p: AppUpdateRebuildProgress) => void): Promise<RebuildStart>
  cancel(): Promise<void>
  /** Quitting: cancel a running build and refuse every later start (one in its pre-checks too). */
  stop(): Promise<void>
  /** Why a relaunch must wait (a rebuild starting or running), or null. */
  busy(): string | null
  /** The last built rebuild, while it is staged. */
  built(): BuiltRebuild | null
}

interface Running {
  child: ChildProcess | null
  cancelled: boolean
  /** The build's output pipes closed: nothing of its process group writes to them any more. */
  closed: boolean
  settled: Promise<void>
}

export function createRebuilder(deps: RebuilderDeps): Rebuilder {
  const { platform, downloadsDir } = deps
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const precheck = deps.precheck ?? precheckTree
  const spawnBuild = deps.spawnBuild ?? spawn
  const killGroup = deps.killGroup ?? ((pid, signal) => process.kill(-pid, signal))
  const killTree =
    deps.killTree ??
    ((pid: number) => {
      const exe = path.win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'taskkill.exe'
      )
      void deps.exec(exe, ['/pid', String(pid), '/T', '/F'])
    })
  const copyApp =
    deps.copyApp ??
    (async (from: string, to: string): Promise<void> => {
      if (platform === 'darwin') {
        const r = await deps.exec(DITTO, [from, to], { timeoutMs: 10 * 60_000 })
        if (r.code !== 0)
          throw new Error(`The build could not be copied beside ClaudeUI (ditto exit ${r.code})`)
      } else {
        await fs.promises.cp(from, to, {
          recursive: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true
        })
      }
    })
  const newT8 = deps.newT8 ?? (() => randomBytes(4).toString('hex'))

  const envOf = deps.env ?? (() => process.env)

  let starting = false
  let stopping = false
  let running: Running | null = null
  let built: BuiltRebuild | null = null

  /** Local paths (the tree's, when known) and the signing identity out of a line. */
  function scrubber(tree?: SourceTree): (line: string) => string {
    let realTree: string | null = null
    try {
      realTree = tree ? fs.realpathSync(tree.path) : null
    } catch {
      /* gone */
    }
    const inst = deps.install()
    const paths = pathScrubber(
      [
        [tree?.path, '<tree>'],
        [realTree, '<tree>'],
        [downloadsDir, '…'],
        [inst.path ? path.dirname(inst.path) : null, '…'],
        [os.homedir(), '~']
      ],
      platform
    )
    const identity = envOf().MAC_SIGN_IDENTITY
    return (line) => scrubIdentity(paths(line), identity)
  }

  /** The same error with local paths and the identity replaced (a cancel stays a cancel). */
  function scrubbed(err: unknown, scrub: (line: string) => string): unknown {
    if (err instanceof RebuildCancelled) return err
    const message = err instanceof Error ? err.message : String(err)
    const clean = scrub(message)
    return clean === message && err instanceof Error ? err : new Error(clean, { cause: err })
  }

  function discardStaged(installPath: string, staged: string): void {
    const r = removeOwnedDir(installPath, staged, { platform, stateDir: deps.stateDir, log })
    if (!r.removed) {
      try {
        fs.rmdirSync(staged)
      } catch {
        log(`left a partial rebuild copy in place (${r.reason})`)
      }
    }
    deps.onReleased?.(staged)
  }

  function discardBuilt(): void {
    if (!built) return
    const previous = built
    built = null
    const inst = deps.install()
    if (inst.ok) discardStaged(inst.path, previous.stagedPath)
    else log(`kept the previous rebuild: ${inst.reason}`)
  }

  function removeOutput(outDir: string): void {
    try {
      fs.lstatSync(outDir)
    } catch {
      deps.onReleased?.(outDir)
      return
    }
    removeDownloadsEntry(downloadsDir, outDir, log)
    deps.onReleased?.(outDir)
  }

  function builtCommit(tree: SourceTree): string | null {
    try {
      const info = parseBuildInfo(readJson(path.join(tree.path, 'out', 'build-info.json')))
      if (info?.git.commit) return info.git.commit.slice(0, 7)
    } catch {
      /* fall back to the listing */
    }
    return tree.commit
  }

  /** Copy the built app beside the install and check it; the output folder is the caller's. */
  async function stageOutput(
    tree: SourceTree,
    outDir: string,
    run: Running
  ): Promise<BuiltRebuild> {
    const app =
      platform === 'darwin'
        ? path.join(outDir, 'mac-arm64', 'ClaudeUI.app')
        : path.join(outDir, 'win-unpacked')
    const out = checkStagedBuild(app, platform)
    if (!out.ok || !out.marker.version)
      throw new Error(
        `The build did not produce a ClaudeUI this host can stage (${out.ok ? 'no version' : out.reason})`
      )
    const version = out.marker.version
    const inst = deps.install()
    if (!inst.ok) throw new Error(inst.reason)
    const gate = { platform, stateDir: deps.stateDir, log }
    const container = openExtractContainer({
      installPath: inst.path,
      version,
      token: newToken(),
      platform,
      now: now()
    })
    deps.onCreated?.(container.dir)
    try {
      await copyApp(app, container.inner)
      if (run.cancelled || stopping) throw new RebuildCancelled()
      const check = checkStagedBuild(container.inner, platform, version)
      if (!check.ok) throw new Error(check.reason)
      deps.onCreated?.(container.staged)
      promote(container)
    } catch (err) {
      discardContainer(container, inst.path, gate)
      deps.onReleased?.(container.dir)
      throw err
    }
    closeContainer(container, inst.path, gate)
    deps.onReleased?.(container.dir)
    return {
      stagedPath: container.staged,
      version,
      commit: builtCommit(tree),
      treeName: tree.name
    }
  }

  async function start(
    treeId: string,
    onProgress: (p: AppUpdateRebuildProgress) => void
  ): Promise<RebuildStart> {
    if (stopping) throw new Error('ClaudeUI is quitting; no rebuild starts now')
    if (starting || running) throw new Error('A rebuild is already running')
    if (deps.relaunchBusy()) throw new Error('A relaunch is in progress; rebuild after it')
    starting = true
    try {
      return await startChecked(treeId, onProgress)
    } catch (err) {
      throw scrubbed(err, scrubber())
    } finally {
      starting = false
    }
  }

  async function startChecked(
    treeId: string,
    onProgress: (p: AppUpdateRebuildProgress) => void
  ): Promise<RebuildStart> {
    const trees = await deps.listTrees()
    const tree = trees.find((t) => t.id === treeId)
    if (!tree) throw new Error('That source tree is not one ClaudeUI lists; refresh the list')
    const refused = precheck(tree.path)
    if (refused) throw new Error(refused)
    const bun = (deps.findBun ?? (() => findBun(process.env, platform)))()
    if (!bun) throw new Error('bun was not found: install it, or put it on your PATH')
    const inst = deps.install()
    if (!inst.ok) throw new Error(inst.reason)
    if (deps.relaunchBusy()) throw new Error('A relaunch is in progress; rebuild after it')

    fs.mkdirSync(downloadsDir, { recursive: true })
    const t8 = newT8()
    const outDir = path.join(downloadsDir, `rebuild-${t8}`)
    const logFile = `${outDir}.log`
    if (fs.existsSync(outDir) || fs.existsSync(logFile))
      throw new Error('A rebuild folder of that name already exists; try again')
    discardBuilt()

    const scrub = scrubber(tree)
    const progress = new BuildProgress(now, scrub, expectedStageLabels(platform))
    const logStream = fs.createWriteStream(logFile, { flags: 'wx', mode: 0o600 })
    logStream.on('error', (err) => log(`the rebuild log could not be written: ${String(err)}`))
    deps.onCreated?.(outDir)

    let resolveDone!: (v: { version: string; commit: string | null }) => void
    let rejectDone!: (err: unknown) => void
    const done = new Promise<{ version: string; commit: string | null }>((res, rej) => {
      resolveDone = res
      rejectDone = rej
    })
    done.catch(() => {})
    let settle!: () => void
    const run: Running = {
      child: null,
      cancelled: false,
      closed: false,
      settled: new Promise<void>((res) => (settle = res))
    }

    const report = (): void => {
      try {
        onProgress(progress.snapshot())
      } catch (err) {
        log(`rebuild progress listener failed: ${String(err)}`)
      }
    }
    const feed = (): ((chunk: Buffer) => void) => {
      let pending = ''
      return (chunk) => {
        logStream.write(chunk)
        pending += chunk.toString('utf8')
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) progress.push(line)
        if (lines.length > 0) report()
      }
    }

    const finish = async (outcome: { code: number | null; error?: Error }): Promise<void> => {
      try {
        // Bounded: a log stream that already failed may never call back.
        await Promise.race([
          new Promise<void>((res) => logStream.end(res)),
          new Promise<void>((res) => setTimeout(res, 2_000).unref?.())
        ])
        if (run.cancelled) throw new RebuildCancelled()
        if (outcome.error) throw outcome.error
        if (outcome.code !== 0) {
          const failed = progress.failure()
          const at = failed?.label ?? progress.currentStage()
          throw new Error(
            `The build failed${at ? ` at ${at}` : ''} (exit ${failed?.code ?? outcome.code ?? 'by signal'})`
          )
        }
        progress.finish()
        report()
        const result = await stageOutput(tree, outDir, run)
        removeOutput(outDir)
        built = result
        log(`rebuilt ${result.version} from ${tree.name}`)
        resolveDone({ version: result.version, commit: result.commit })
      } catch (err) {
        removeOutput(outDir)
        rejectDone(scrubbed(err, scrub))
      } finally {
        running = null
        settle()
      }
    }

    // Quitting while the pre-checks ran: never spawn a build that would outlive us.
    if (stopping) {
      logStream.end()
      removeOutput(outDir)
      throw new Error('ClaudeUI is quitting; no rebuild starts now')
    }
    let child: ChildProcess
    try {
      child = spawnBuild(bun, ['scripts/build.mjs', 'build:stage', '-v'], {
        cwd: tree.path,
        env: rebuildEnv(envOf(), bun, outDir, platform),
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      logStream.end()
      removeOutput(outDir)
      throw new Error(
        `bun could not be started: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      )
    }
    run.child = child
    running = run
    child.stdout?.on('data', feed())
    child.stderr?.on('data', feed())
    let finished = false
    const once = (outcome: { code: number | null; error?: Error }): void => {
      if (finished) return
      finished = true
      void finish(outcome)
    }
    child.on('error', (err) => {
      run.closed = true
      once({ code: null, error: new Error(`bun could not be started: ${err.message}`) })
    })
    child.on('close', (code) => {
      run.closed = true
      once({ code })
    })
    log(`rebuild of ${tree.name} started (pid ${child.pid ?? '?'})`)
    report()
    const { name, branch, commit, dirty } = publicTree(tree)
    return { tree: { name, branch, commit, dirty }, done }
  }

  async function cancel(): Promise<void> {
    const run = running
    if (!run) return
    run.cancelled = true
    const pid = run.child?.pid
    if (pid !== undefined && !run.closed) {
      try {
        if (platform === 'win32') killTree(pid)
        else killGroup(pid, 'SIGTERM')
      } catch (err) {
        log(`could not stop the rebuild: ${String(err)}`)
      }
      if (platform !== 'win32') {
        // The group, not just the leader: a member still holding the pipes gets it too.
        const timer = setTimeout(() => {
          if (run.closed) return
          try {
            killGroup(pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }, deps.cancelGraceMs ?? CANCEL_GRACE_MS)
        timer.unref?.()
        void run.settled.then(() => clearTimeout(timer))
      }
    }
    log('rebuild cancel requested')
    await Promise.race([run.settled, new Promise((r) => setTimeout(r, 20_000).unref?.())])
  }

  return {
    start,
    cancel,
    async stop() {
      stopping = true
      await cancel()
    },
    busy: () => (starting || running ? 'A rebuild is running; wait for it or cancel it' : null),
    built: () => built
  }
}
