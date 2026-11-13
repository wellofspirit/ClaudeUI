/**
 * The Claude engine's command sandbox as ONE shared setting: the `sandbox` block of Claude Code's
 * own user settings file (`<claudeConfigDir()>/settings.json`), which the terminal `claude` reads
 * too. ClaudeUI used to keep a private copy (`engines/claude.json#sandbox`) and send it with every
 * spawn; that copy is gone and migrated once at boot (`migrateClaudeSandboxToSettingsFile`).
 *
 * The Claude page edits a VIEW of the block (`SandboxSettings`); the writer merges the view back
 * into the existing block, so keys the page does not know (`failIfUnavailable`,
 * `enableWeakerNestedSandbox`, `ignoreViolations`, `network.deniedDomains`, ...) and the file's
 * other top-level keys survive. A save is a PATCH applied to a strict re-read, so a client with a
 * stale view cannot write back keys it did not touch. A file that is not valid JSON is refused and
 * never replaced.
 *
 * What a ClaudeUI spawn adds on top of Claude Code's own files is `claudeSandboxFlags`: flag
 * settings read per spawn, never written into the shared file, and built from the validated view
 * (Claude Code drops flag settings that hold a known key of the wrong type, which would drop the
 * fail-closed key too). It never sends `enabled: false`: that would beat every scope, which is
 * not what "off" means here.
 */

import * as fs from 'fs'
import * as path from 'path'
import type {
  ClaudeSandboxScope,
  ClaudeSandboxState,
  SandboxSettings,
  SandboxSettingsPatch
} from '../../shared/types'
import { DEFAULT_SANDBOX } from '../../shared/types'
import { claudeConfigDir, readClaudeSettingsLayers, type JsonObject } from './claude-config-paths'
import { readJsonStrict } from './claude-settings'
import { ensureConfigPlaneMigrated, loadEngineConfig, saveEngineConfig } from './ui-config'
import { logger } from './logger'

const LOG = 'ClaudeSandbox'

type Block = Record<string, unknown>

/** Where cli.js reads the user-scope settings: `$CLAUDE_CONFIG_DIR || ~/.claude`. */
export function claudeUserSettingsPath(): string {
  return path.join(claudeConfigDir(), 'settings.json')
}

// JSON, not structuredClone: everything cloned here came from JSON, and a vm-realm clone has a
// foreign prototype that a strict comparison in a caller's test sees.
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function isObject(v: unknown): v is Block {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function cloneDefaults(): SandboxSettings {
  return clone(DEFAULT_SANDBOX)
}

// ---------------------------------------------------------------------------
// View <-> block
// ---------------------------------------------------------------------------

/**
 * The block as the page edits it. A switch the block does not state reads as what Claude Code
 * applies while the sandbox is on (true) and as false while it is not (nothing applies, and false
 * is what turning the sandbox on from the page writes). `restrictNetwork` is "the block has a
 * `network.allowedDomains` array".
 */
export function sandboxViewFromBlock(block: unknown): SandboxSettings {
  if (!isObject(block)) return cloneDefaults()
  const enabled = block.enabled === true
  const net = isObject(block.network) ? block.network : {}
  const fs_ = isObject(block.filesystem) ? block.filesystem : {}
  const sw = (v: unknown): boolean => (typeof v === 'boolean' ? v : enabled)
  return {
    enabled,
    autoAllowBashIfSandboxed: sw(block.autoAllowBashIfSandboxed),
    allowUnsandboxedCommands: sw(block.allowUnsandboxedCommands),
    network: {
      restrictNetwork: Array.isArray(net.allowedDomains),
      allowLocalBinding: net.allowLocalBinding === true,
      allowedDomains: stringList(net.allowedDomains),
      allowManagedDomainsOnly: net.allowManagedDomainsOnly === true,
      allowAllUnixSockets: net.allowAllUnixSockets === true,
      allowUnixSockets: stringList(net.allowUnixSockets)
    },
    filesystem: {
      allowWrite: stringList(fs_.allowWrite),
      denyWrite: stringList(fs_.denyWrite),
      denyRead: stringList(fs_.denyRead)
    },
    excludedCommands: stringList(block.excludedCommands)
  }
}

function setList(target: Block, key: string, list: string[]): void {
  if (list.length > 0) target[key] = list
  else delete target[key]
}

function setTrue(target: Block, key: string, on: boolean): void {
  if (on) target[key] = true
  else delete target[key]
}

/**
 * `view` written onto `existing`: everything the page does not know stays. `enabled` is always an
 * explicit boolean. The two switches are written when the result is enabled, when the block
 * already states them, or when the view's value is true; an off block that never stated them stays
 * without (a save while off must not plant ClaudeUI's stricter defaults for someone who later
 * enables it in the terminal). Lists are written when non-empty and deleted when empty, except
 * `network.allowedDomains`, which is written (even empty: it blocks everything) while
 * `restrictNetwork` is on and deleted while off.
 */
export function applySandboxViewToBlock(existing: unknown, view: SandboxSettings): Block {
  const block: Block = isObject(existing) ? clone(existing) : {}
  block.enabled = view.enabled
  for (const key of ['autoAllowBashIfSandboxed', 'allowUnsandboxedCommands'] as const) {
    if (view.enabled || block[key] !== undefined || view[key]) block[key] = view[key]
  }
  setList(block, 'excludedCommands', view.excludedCommands)

  const net: Block = isObject(block.network) ? block.network : {}
  const n = view.network
  if (n.restrictNetwork) {
    net.allowedDomains = n.allowedDomains
    net.allowLocalBinding = n.allowLocalBinding
  } else {
    delete net.allowedDomains
    setTrue(net, 'allowLocalBinding', n.allowLocalBinding)
  }
  setTrue(net, 'allowManagedDomainsOnly', n.allowManagedDomainsOnly)
  setTrue(net, 'allowAllUnixSockets', n.allowAllUnixSockets)
  setList(net, 'allowUnixSockets', n.allowUnixSockets)
  if (Object.keys(net).length > 0) block.network = net
  else delete block.network

  const files: Block = isObject(block.filesystem) ? block.filesystem : {}
  setList(files, 'allowWrite', view.filesystem.allowWrite)
  setList(files, 'denyWrite', view.filesystem.denyWrite)
  setList(files, 'denyRead', view.filesystem.denyRead)
  if (Object.keys(files).length > 0) block.filesystem = files
  else delete block.filesystem
  return block
}

/** Where the HOST can run the sandbox: macOS (seatbelt) and Linux (bubblewrap). */
export function claudeSandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

// ---------------------------------------------------------------------------
// Read / save
// ---------------------------------------------------------------------------

/**
 * `null` when the file cannot be read or parsed (the caller keeps its last good state); the
 * defaults when it is missing or has no block.
 */
export function readClaudeSandboxState(): ClaudeSandboxState | null {
  const now = userBlockNow()
  if (!now) return null
  return { settings: sandboxViewFromBlock(now.block), supported: claudeSandboxSupported() }
}

/**
 * The block of the last successful strict read of the file (a copy; `undefined` block = the file
 * had none), or `null` before any. When the file cannot be read, an enabled remembered block keeps
 * the sandbox on: an unreadable file must never open it.
 */
let remembered: { block: Block | undefined } | null = null
let warnedWaiting = false

/** Forget what was last read (specs). */
export function resetClaudeSandboxMemoryForTests(): void {
  remembered = null
  warnedWaiting = false
}

/**
 * The user block right now. With an old copy waiting in the engine config the migration runs
 * first (idempotent; it returns at once when it cannot finish), so a mended file completes it
 * without a restart. Then the file is read strictly: its block, or none, remembered. A file that
 * cannot be parsed yields, in order: the old copy mapped through the writer when that copy is
 * enabled (what the process ran under before); the remembered block when that was enabled (what
 * the page still shows); otherwise `null`: unreadable, and nothing known to be on.
 */
function userBlockNow(): { block: Block | undefined } | null {
  if (legacyCopy()) migrateClaudeSandboxToSettingsFile()
  try {
    const data = readJsonStrict(claudeUserSettingsPath())
    const block = isObject(data.sandbox) ? data.sandbox : undefined
    remembered = { block: block && clone(block) }
    return { block }
  } catch (err) {
    const old = legacyCopy()
    if (old?.enabled) return { block: applySandboxViewToBlock({}, old) }
    if (remembered?.block?.enabled === true) {
      logger.warn(LOG, 'Cannot read the user settings file; keeping the last enabled block', err)
      return { block: clone(remembered.block) }
    }
    logger.warn(LOG, 'Cannot read the user settings file; keeping the last state', err)
    return null
  }
}

function applyPatch(view: SandboxSettings, patch: SandboxSettingsPatch): SandboxSettings {
  const { network, filesystem, ...top } = patch
  return {
    ...view,
    ...top,
    network: { ...view.network, ...network },
    filesystem: { ...view.filesystem, ...filesystem }
  }
}

function writeSettingsFile(filePath: string, data: Block): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Apply a patch to the view of a strict re-read of the file and write the result through the
 * merging writer. Throws, leaving the file untouched, when the file is not a JSON object or when
 * the patch turns the sandbox on where the host cannot run it and the file does not already have
 * it on (turning it off, and editing while it is on, always work).
 */
export function saveClaudeSandbox(patch: SandboxSettingsPatch): void {
  const filePath = claudeUserSettingsPath()
  const data = readJsonStrict(filePath)
  const block = isObject(data.sandbox) ? data.sandbox : undefined
  const next = applyPatch(sandboxViewFromBlock(block), patch)
  if (next.enabled && block?.enabled !== true && !claudeSandboxSupported()) {
    throw new Error(
      `The command sandbox cannot run on this host (${process.platform}); it needs macOS or Linux`
    )
  }
  data.sandbox = applySandboxViewToBlock(block, next)
  writeSettingsFile(filePath, data)
  remembered = { block: clone(data.sandbox as Block) }
  logger.debug(LOG, `Saved the sandbox block to ${filePath}`)
}

// ---------------------------------------------------------------------------
// Spawn flags
// ---------------------------------------------------------------------------

/** What an older build left in `engines/claude.json#sandbox`, read as a view. */
function legacyCopy(): SandboxSettings | null {
  const raw = (loadEngineConfig('claude') as { sandbox?: unknown }).sandbox
  return raw === undefined ? null : coerceLegacyView(raw)
}

function coerceLegacyView(raw: unknown): SandboxSettings {
  const d = cloneDefaults()
  if (!isObject(raw)) return d
  const net = isObject(raw.network) ? raw.network : {}
  const files = isObject(raw.filesystem) ? raw.filesystem : {}
  const bool = (v: unknown): boolean => v === true
  return {
    enabled: bool(raw.enabled),
    autoAllowBashIfSandboxed: bool(raw.autoAllowBashIfSandboxed),
    allowUnsandboxedCommands: bool(raw.allowUnsandboxedCommands),
    network: {
      restrictNetwork: bool(net.restrictNetwork),
      allowLocalBinding: bool(net.allowLocalBinding),
      allowedDomains: stringList(net.allowedDomains),
      allowManagedDomainsOnly: bool(net.allowManagedDomainsOnly),
      allowAllUnixSockets: bool(net.allowAllUnixSockets),
      allowUnixSockets: stringList(net.allowUnixSockets)
    },
    filesystem: {
      allowWrite: stringList(files.allowWrite),
      denyWrite: stringList(files.denyWrite),
      denyRead: stringList(files.denyRead)
    },
    excludedCommands: stringList(raw.excludedCommands)
  }
}

/**
 * The `sandbox` flag settings a ClaudeUI cli.js process spawns with, read from the shared file at
 * spawn time (a change binds the next process).
 *
 * The switch ON (the user block has `enabled: true`): the block built from the validated VIEW of
 * the user block (the writer applied to an empty block, so only the keys the page knows, with
 * checked types: Claude Code drops flag settings holding a known key of the wrong type, and the
 * fail-closed key with them), minus `autoAllowBashIfSandboxed` and `allowUnsandboxedCommands`
 * unless the user block states them as booleans (the flag must not pin Claude Code's default
 * above a project's stricter value), plus `failIfUnavailable: true`, so a process runs under it
 * or does not start, whatever a repository's own settings say; an automation run and a dispatch
 * target (`run`, `target`) also carry `autoAllowBashIfSandboxed: false` (their sandboxed commands
 * still go through a permission gate, ADR-116). Keys the page does not know are not carried at
 * flag priority; a session and a run still get them from the user file. The switch OFF: a
 * session and a target carry nothing, so Claude Code's own files decide as in the terminal; a
 * run carries the gate key alone, which is inert without a sandbox. `enabled: false` is never
 * sent.
 *
 * A pending migration (an enabled old copy waits in the engine config) is completed first when
 * the file allows it; while the file cannot be parsed the old copy counts as the user block.
 */
export function claudeSandboxFlags(
  kind: 'session' | 'run' | 'target'
): Record<string, unknown> | undefined {
  const block = userBlockNow()?.block
  if (block?.enabled === true) {
    const out = applySandboxViewToBlock({}, sandboxViewFromBlock(block))
    for (const key of ['autoAllowBashIfSandboxed', 'allowUnsandboxedCommands'] as const) {
      if (typeof block[key] !== 'boolean') delete out[key]
    }
    return {
      ...out,
      failIfUnavailable: true,
      ...(kind === 'session' ? {} : { autoAllowBashIfSandboxed: false })
    }
  }
  return kind === 'run' ? { autoAllowBashIfSandboxed: false } : undefined
}

/** Which of the project, local and managed settings files set `sandbox.enabled` to exactly `true`. */
export function claudeSandboxScopes(cwd: string): ClaudeSandboxScope[] {
  // Never relative to the host's own working directory.
  if (!cwd || !path.isAbsolute(cwd)) return []
  const layers = readClaudeSettingsLayers(cwd)
  const on = (layer: JsonObject): boolean =>
    isObject(layer.sandbox) && layer.sandbox.enabled === true
  const out: ClaudeSandboxScope[] = []
  if (on(layers.project)) out.push('project')
  if (on(layers.local)) out.push('local')
  if (on(layers.policy)) out.push('managed')
  return out
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

const union = (first: string[], second: string[]): string[] => [...new Set([...first, ...second])]

/**
 * An enabled copy merged into the file's block: Claude Code merged the file's lists into the copy
 * when the copy rode at flag priority, so the file's entries survive, first, then the copy's. The
 * network is restricted when either side restricts it, with the lists of the restricting sides.
 * The switches are the copy's when the file's block was not enabled, and the stricter of the two
 * when it was: auto-approve, the unsandboxed escape, local binding and "all unix sockets" are on
 * only if both sides have them on; "managed domains only" is on if either has it on.
 */
function mergeCopyIntoFile(file: SandboxSettings, copy: SandboxSettings): SandboxSettings {
  const restrict = file.network.restrictNetwork || copy.network.restrictNetwork
  const both = file.enabled
  return {
    ...copy,
    autoAllowBashIfSandboxed: both
      ? file.autoAllowBashIfSandboxed && copy.autoAllowBashIfSandboxed
      : copy.autoAllowBashIfSandboxed,
    allowUnsandboxedCommands: both
      ? file.allowUnsandboxedCommands && copy.allowUnsandboxedCommands
      : copy.allowUnsandboxedCommands,
    excludedCommands: union(file.excludedCommands, copy.excludedCommands),
    network: {
      ...copy.network,
      restrictNetwork: restrict,
      allowedDomains: restrict
        ? union(
            file.network.restrictNetwork ? file.network.allowedDomains : [],
            copy.network.restrictNetwork ? copy.network.allowedDomains : []
          )
        : copy.network.allowedDomains,
      allowLocalBinding: both
        ? file.network.allowLocalBinding && copy.network.allowLocalBinding
        : copy.network.allowLocalBinding,
      allowAllUnixSockets: both
        ? file.network.allowAllUnixSockets && copy.network.allowAllUnixSockets
        : copy.network.allowAllUnixSockets,
      allowManagedDomainsOnly: both
        ? file.network.allowManagedDomainsOnly || copy.network.allowManagedDomainsOnly
        : copy.network.allowManagedDomainsOnly,
      allowUnixSockets: union(file.network.allowUnixSockets, copy.network.allowUnixSockets)
    },
    filesystem: {
      allowWrite: union(file.filesystem.allowWrite, copy.filesystem.allowWrite),
      denyWrite: union(file.filesystem.denyWrite, copy.filesystem.denyWrite),
      denyRead: union(file.filesystem.denyRead, copy.filesystem.denyRead)
    }
  }
}

/**
 * Once, at host boot, before anything can spawn: moves `engines/claude.json#sandbox` into the
 * shared file. Whenever the copy is enabled it is merged into the file's block (`mergeCopyIntoFile`:
 * lists united, the copy's switches over a block that was not enabled, the stricter of the two
 * over one that was; the sandbox stays on and the file's unknown keys survive). A disabled copy
 * never changes a file block; with no block a copy that differs from the defaults is written and
 * an untouched one writes nothing. A domain list kept with the restriction off moves to
 * `sandboxRememberedDomains` whenever the copy is dropped. The file is
 * written first and the engine config second, so a crash between them leaves a file block for
 * the next boot. A file that cannot be parsed changes nothing (the flags' pending rule covers the
 * meantime). Never throws.
 */
export function migrateClaudeSandboxToSettingsFile(): void {
  try {
    // The older migration (app settings -> engine config) must have run before this one reads it.
    ensureConfigPlaneMigrated()
    const cfg = loadEngineConfig('claude') as ReturnType<typeof loadEngineConfig> & {
      sandbox?: unknown
    }
    if (cfg.sandbox === undefined) return
    const copy = coerceLegacyView(cfg.sandbox)

    const filePath = claudeUserSettingsPath()
    let data: Block
    try {
      data = readJsonStrict(filePath)
    } catch (err) {
      if (!warnedWaiting) {
        warnedWaiting = true
        logger.warn(LOG, 'Sandbox migration waits: the user settings file cannot be parsed', err)
      }
      return
    }
    const fileBlock = isObject(data.sandbox) ? data.sandbox : undefined

    const write =
      fileBlock === undefined
        ? JSON.stringify(copy) !== JSON.stringify(DEFAULT_SANDBOX)
        : copy.enabled
    if (write) {
      const view =
        fileBlock === undefined ? copy : mergeCopyIntoFile(sandboxViewFromBlock(fileBlock), copy)
      data.sandbox = applySandboxViewToBlock(fileBlock, view)
      writeSettingsFile(filePath, data)
    }
    const n = copy.network
    if (!n.restrictNetwork && n.allowedDomains.length > 0) {
      cfg.claudeConfig = { ...cfg.claudeConfig, sandboxRememberedDomains: n.allowedDomains }
    }
    delete cfg.sandbox
    saveEngineConfig('claude', cfg)
    logger.info(
      LOG,
      write ? 'Moved the sandbox settings to the shared file' : 'Dropped the old sandbox copy'
    )
  } catch (err) {
    logger.warn(LOG, 'Sandbox migration failed; retried at the next boot', err)
  }
}

// ---------------------------------------------------------------------------
// Perimeter
// ---------------------------------------------------------------------------

const TOP_BOOLS = ['enabled', 'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands'] as const
const NET_BOOLS = [
  'restrictNetwork',
  'allowLocalBinding',
  'allowManagedDomainsOnly',
  'allowAllUnixSockets'
] as const
const NET_LISTS = ['allowedDomains', 'allowUnixSockets'] as const
const FS_LISTS = ['allowWrite', 'denyWrite', 'denyRead'] as const

function parseGroup(
  value: unknown,
  label: string,
  bools: readonly string[],
  lists: readonly string[]
): Record<string, boolean | string[]> {
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  const out: Record<string, boolean | string[]> = {}
  for (const [key, v] of Object.entries(value)) {
    if (bools.includes(key)) {
      if (typeof v !== 'boolean') throw new Error(`${label}.${key} must be a boolean`)
      out[key] = v
    } else if (lists.includes(key)) {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
        throw new Error(`${label}.${key} must be an array of strings`)
      }
      out[key] = [...v]
    } else {
      throw new Error(`${label}.${key} is not a sandbox setting`)
    }
  }
  return out
}

/** The remote-reachable perimeter of a save: known keys only, booleans are booleans, lists are string arrays. */
export function parseSandboxPatch(value: unknown): SandboxSettingsPatch {
  if (!isObject(value)) throw new Error('The sandbox patch must be an object')
  const { network, filesystem, ...top } = value
  const out = parseGroup(top, 'sandbox', TOP_BOOLS, ['excludedCommands']) as SandboxSettingsPatch
  if (network !== undefined) {
    out.network = parseGroup(network, 'sandbox.network', NET_BOOLS, NET_LISTS)
  }
  if (filesystem !== undefined) {
    out.filesystem = parseGroup(filesystem, 'sandbox.filesystem', [], FS_LISTS)
  }
  return out
}
