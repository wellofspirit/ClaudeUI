/**
 * What the Codex development scripts share (`generate-codex-protocol.mjs`,
 * `codex-native-status.mjs`): the release manifest, the pinned Codex in
 * ClaudeUI's managed store (ADR-082 §8; `bun run ensure-codex` installs it),
 * and an isolated `--version` check. It reads the store through the app's own
 * TypeScript modules, so the scripts run under bun.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { payloadExecutable } from '../src/core/harness/resolve.ts'
import { installDir, readInstallRecord } from '../src/core/harness/store.ts'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The release manifest (ADR-082 §5): `tested` is the exact pin, `platforms` the
// reviewed per-host digests.
export const manifest = JSON.parse(
  readFileSync(join(root, 'src/shared/harness-manifests/codex.json'), 'utf8')
)
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The install name of the executable that answers `--version` on this host. */
export const codexExecutableName = (platform = process.platform) =>
  platform === 'win32' ? 'codex.exe' : 'codex'

/** Only a host the reviewed manifest covers has a pinned Codex. */
export function hostSupported(platform = process.platform, arch = process.arch) {
  return Object.hasOwn(manifest.platforms, `${platform}-${arch}`)
}

export function assertPin(platform = process.platform, arch = process.arch) {
  if (!hostSupported(platform, arch)) {
    throw new Error(
      `Codex is pinned only on: ${Object.keys(manifest.platforms).join(', ')} (not ${platform}-${arch})`
    )
  }
}

/**
 * The pinned `codex` in ClaudeUI's managed store (`CLAUDEUI_HARNESS_STORE`
 * honoured), or null when that version is not installed there. Deliberately not
 * the resolver's answer: a System or overridden Codex may be another version.
 */
export function storeCodexExecutable() {
  if (!readInstallRecord('codex', manifest.tested)) return null
  return payloadExecutable('codex', installDir('codex', manifest.tested))
}

export function isolatedEnv(directory) {
  const home = join(directory, 'home')
  const codexHome = join(directory, 'home/.codex')
  const tmp = join(directory, 'tmp')
  mkdirSync(codexHome, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  // Windows resolves the user profile and the temp directory from different
  // variables than POSIX. PATH is System32 only so the preflight runs in a sane
  // Windows environment rather than inheriting the caller's PATH; SYSTEMROOT is
  // kept because parts of the Windows runtime resolve it at startup.
  if (process.platform === 'win32') {
    const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows'
    return {
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      TEMP: tmp,
      TMP: tmp,
      SYSTEMROOT: systemRoot,
      PATH: join(systemRoot, 'System32'),
      RUST_LOG: 'off'
    }
  }
  return {
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: tmp,
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    RUST_LOG: 'off'
  }
}

export function verifyVersion(binary, cwd, env) {
  let output
  try {
    output = execFileSync(binary, ['--version'], {
      cwd,
      env,
      timeout: 15000,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    })
  } catch {
    throw new Error('Codex version check failed')
  }
  if (output.trim() !== `codex-cli ${manifest.tested}`) throw new Error('Codex version mismatch')
}
