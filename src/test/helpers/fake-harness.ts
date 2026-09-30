/**
 * Fabricate harness payloads on disk for resolver tests (ADR-082): a vendored
 * `vendor/<id>-cli` directory, or a managed store version with its
 * `install.json`. The executables are empty files; nothing here is ever run.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessId, HarnessInstallRecord } from '../../shared/harness-types'

const EXECUTABLES: Record<HarnessId, string> = {
  claude: 'bun-claude',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'codex'
}

export function exeName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base
}

export interface FakePayloadOptions {
  /** pi only: put the executable in a nested `pi/` directory. */
  nested?: boolean
  /** Codex only: write `codex-code-mode-host` beside `codex` (default true). */
  codeModeHost?: boolean
  /** Written as `version.json` in the payload root when given. */
  versionJson?: Record<string, unknown>
}

/**
 * Write a payload laid out like `vendor/<id>-cli` into `root`. Returns the
 * executable's path.
 */
export function writeHarnessPayload(
  root: string,
  id: HarnessId,
  options: FakePayloadOptions = {}
): string {
  const binDir = id === 'pi' && options.nested ? join(root, 'pi') : root
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, exeName(EXECUTABLES[id]))
  writeFileSync(bin, '')
  if (id === 'codex') {
    if (options.codeModeHost !== false) {
      writeFileSync(join(binDir, exeName('codex-code-mode-host')), '')
    }
    writeFileSync(join(root, 'LICENSE'), '')
  }
  if (options.versionJson) {
    writeFileSync(join(root, 'version.json'), JSON.stringify(options.versionJson))
  }
  return bin
}

/**
 * Fabricate `<storeRoot>/<id>/<version>/` with a payload and an `install.json`
 * valid for this host. `record` overrides fields of the install record; `null`
 * writes no install.json at all. Returns the version directory.
 */
export function fakeHarnessInstall(
  storeRoot: string,
  id: HarnessId,
  version: string,
  options: FakePayloadOptions & {
    record?: Partial<Record<keyof HarnessInstallRecord, unknown>> | null
    /** Leave the executable out (a broken install). */
    noExecutable?: boolean
  } = {}
): string {
  const dir = join(storeRoot, id, version)
  mkdirSync(dir, { recursive: true })
  if (!options.noExecutable) writeHarnessPayload(dir, id, options)
  if (options.record !== null) {
    const record: Record<string, unknown> = {
      id,
      version,
      platform: process.platform,
      arch: process.arch,
      installedAt: '2026-09-30T00:00:00.000Z',
      verified: 'reviewed',
      ...options.record
    }
    writeFileSync(join(dir, 'install.json'), JSON.stringify(record))
  }
  return dir
}
