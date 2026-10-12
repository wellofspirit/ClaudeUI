/**
 * Where the speech pack lives on disk, and whether a usable one is there —
 * ADR-101 §5, local-voice-spec C2.
 *
 *   ~/.claude/ui/voice/                      `CLAUDEUI_VOICE_STORE` moves the root
 *     <pack id>/                             one installed pack
 *       runtime/node_modules/sherpa-onnx-node/…        the wrapper tarball's `package/`
 *       runtime/node_modules/<platform package>/…      beside it, so the wrapper's
 *                                                      `../sherpa-onnx-<plat>/` lookup resolves
 *       model/<the four files>
 *       install.json                         written LAST
 *     .staging/<id>-<random>/                an install in progress
 *     .trash/<id>-<random>/                  moved aside, deleted later
 *
 * A separate root from the harness store on purpose: the harness store's
 * garbage collection and "installed" semantics are about engine versions, and a
 * 700 MB model must never be swept up by either.
 *
 * `install.json` is the only thing that says "installed". The installer renames
 * a fully verified staging directory into place and writes it after, so a
 * directory without a readable record is an interrupted install and not a pack.
 * Resolution therefore does NOT re-hash 650 MB on every voice start — hashing
 * happened at install — but it does compare every model file's size, which
 * catches a truncated or hand-edited store for the price of a few `stat`s. The
 * runtime is checked the same way, by presence: the wrapper's `package.json` and
 * the platform package's native binary.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { VOICE_PACK, voicePackPlatformKey } from '../../shared/voice-pack'

export const VOICE_STORE_ENV = 'CLAUDEUI_VOICE_STORE'

/** What `install.json` records. Written by the installer, read back here. */
export interface VoiceInstallRecord {
  packId: string
  runtimeVersion: string
  platform: string
  model: { repo: string; revision: string }
  /** Pack-relative path → sha256 of the file as installed. */
  files: Record<string, string>
  installedAt: string
}

/** A pack that is installed and matches this build's pins. */
export interface ResolvedVoicePack {
  /** The directory `require()` loads `sherpa-onnx-node` from. */
  addonDir: string
  modelDir: string
}

/** Resolved at call time so a redirected home or env (tests) is honoured. */
export function voiceStoreRoot(): string {
  const override = process.env[VOICE_STORE_ENV]
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude', 'ui', 'voice')
}

/** The installed pack's directory (it may not exist). */
export function voicePackDir(root: string = voiceStoreRoot()): string {
  return path.join(root, VOICE_PACK.id)
}

export function voiceInstallRecordPath(root: string = voiceStoreRoot()): string {
  return path.join(voicePackDir(root), 'install.json')
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function readRecord(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * The installed pack, or null when there is none for this host and these pins.
 * Null covers every way of not being usable — never installed, interrupted,
 * installed by a build with other pins, wrong platform, a model file missing or
 * the wrong size — because the caller's answer to all of them is the same
 * (offer the download), and the installer re-verifies on its own.
 */
export function resolveVoicePack(): ResolvedVoicePack | null {
  const platform = voicePackPlatformKey()
  if (!platform) return null

  const dir = voicePackDir()
  const record = readRecord(path.join(dir, 'install.json')) as Partial<VoiceInstallRecord> | null
  if (
    !record ||
    typeof record !== 'object' ||
    record.packId !== VOICE_PACK.id ||
    record.runtimeVersion !== VOICE_PACK.runtime.version ||
    record.platform !== platform ||
    record.model?.revision !== VOICE_PACK.model.revision
  ) {
    return null
  }

  const modelDir = path.join(dir, 'model')
  for (const file of VOICE_PACK.model.files) {
    try {
      const stat = fs.statSync(path.join(modelDir, file.name))
      if (!stat.isFile() || stat.size !== file.size) return null
    } catch {
      return null
    }
  }

  // The runtime must still be there: an antivirus quarantine or a hand-deleted
  // folder leaves a valid-looking record over a pack that cannot load, and the
  // right answer is the same as for a missing model (offer the download).
  const nodeModules = path.join(dir, 'runtime', 'node_modules')
  const addonDir = path.join(nodeModules, 'sherpa-onnx-node')
  const addonBinary = path.join(
    nodeModules,
    VOICE_PACK.runtime.platforms[platform].package,
    'sherpa-onnx.node'
  )
  if (!isFile(path.join(addonDir, 'package.json')) || !isFile(addonBinary)) return null

  return { addonDir, modelDir }
}
