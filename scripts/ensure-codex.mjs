#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  renameSync,
  lstatSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const manifest = JSON.parse(readFileSync(join(root, 'scripts/codex-digests.json'), 'utf8'))
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const MAX_ARCHIVE = 128 * 1024 * 1024
const MAX_PAYLOAD = 256 * 1024 * 1024

export function assertPin(platform = process.platform, arch = process.arch) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).codexCliVersion
  if (version !== manifest.version) throw new Error('Codex pin has no reviewed digest manifest')
  if (platform !== manifest.platform || arch !== manifest.arch) {
    throw new Error('Codex provisioning is verified only on macOS arm64')
  }
}

// This release contains exactly one regular member. Reject other tar dialects,
// links and extra members rather than maintaining a general archive extractor.
export function extractBinary(archive, expected = manifest) {
  if (archive.length > MAX_ARCHIVE || sha256(archive) !== expected.archiveSha256) {
    throw new Error('Codex archive digest/size mismatch')
  }
  const tar = gunzipSync(archive, { maxOutputLength: MAX_PAYLOAD + 10240 })
  if (tar.length < 1536 || tar.length % 512 !== 0) throw new Error('Invalid Codex tar length')
  const header = tar.subarray(0, 512)
  const cstr = (start, length) =>
    header
      .subarray(start, start + length)
      .toString('utf8')
      .split('\0')[0]
  const octal = (start, length) => {
    const value = cstr(start, length).trim()
    if (!/^[0-7]+$/.test(value)) throw new Error('Invalid Codex tar number')
    return Number.parseInt(value, 8)
  }
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
  const size = octal(124, 12)
  const end = 512 + Math.ceil(size / 512) * 512
  if (
    cstr(0, 100) !== expected.member ||
    /[/\\]/.test(expected.member) ||
    cstr(345, 155) !== '' ||
    cstr(157, 100) !== '' ||
    ![0, 48].includes(header[156]) ||
    sum !== octal(148, 8) ||
    size === 0 ||
    size > MAX_PAYLOAD ||
    end + 1024 > tar.length ||
    !tar.subarray(512 + size).every((byte) => byte === 0)
  )
    throw new Error('Invalid Codex tar member')
  const binary = tar.subarray(512, 512 + size)
  if (sha256(binary) !== expected.binarySha256) throw new Error('Codex payload digest mismatch')
  return binary
}

export function cacheValid(directory, expected = manifest) {
  try {
    const saved = JSON.parse(readFileSync(join(directory, 'version.json'), 'utf8'))
    return (
      Object.entries(expected).every(([key, value]) => saved[key] === value) &&
      lstatSync(join(directory, 'codex')).isFile() &&
      (lstatSync(join(directory, 'codex')).mode & 0o111) !== 0 &&
      sha256(readFileSync(join(directory, 'codex'))) === expected.binarySha256 &&
      sha256(readFileSync(join(directory, 'LICENSE'))) === expected.licenseSha256
    )
  } catch {
    return false
  }
}

async function download(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) })
  if (!response.ok || !response.body) throw new Error('Codex download failed')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw new Error('Codex download exceeds limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function isolatedEnv(directory) {
  mkdirSync(join(directory, 'home/.codex'), { recursive: true })
  mkdirSync(join(directory, 'tmp'), { recursive: true })
  return {
    HOME: join(directory, 'home'),
    CODEX_HOME: join(directory, 'home/.codex'),
    TMPDIR: join(directory, 'tmp'),
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
  if (output.trim() !== `codex-cli ${manifest.version}`) throw new Error('Codex version mismatch')
}

export class CodexRecoveryError extends Error {
  constructor(backup) {
    super('Codex installation and rollback failed; prior installation retained')
    this.backup = backup
  }
}

/** Owns stage cleanup once a verified payload is ready to replace the install. */
export function installStaged(stage, destination, rename = renameSync) {
  const backup = join(stage, 'previous')
  let moved = false
  let preserveBackup = false
  try {
    try {
      rename(destination, backup)
      moved = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try {
      rename(join(stage, 'payload'), destination)
    } catch (error) {
      if (moved) {
        try {
          rename(backup, destination)
        } catch {
          preserveBackup = true
          throw new CodexRecoveryError(backup)
        }
      }
      throw error
    }
  } finally {
    if (!preserveBackup) rmSync(stage, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const archiveAt = args.indexOf('--archive')
  const archivePath = archiveAt < 0 ? undefined : args[archiveAt + 1]
  const licenseAt = args.indexOf('--license')
  const licensePath = licenseAt < 0 ? undefined : args[licenseAt + 1]
  const rest = args.filter(
    (_, i) =>
      ![
        archiveAt,
        archiveAt < 0 ? -1 : archiveAt + 1,
        licenseAt,
        licenseAt < 0 ? -1 : licenseAt + 1
      ].includes(i)
  )
  if (
    (archiveAt >= 0 && !archivePath) ||
    (licenseAt >= 0 && !licensePath) ||
    rest.some((a) => a !== '--force')
  )
    throw new Error('Invalid Codex arguments')
  assertPin()
  const destination = join(root, 'vendor/codex-cli')
  if (!args.includes('--force') && cacheValid(destination)) {
    console.log('Codex verified cache hit')
    return
  }
  if (archivePath && lstatSync(archivePath).size > MAX_ARCHIVE)
    throw new Error('Codex archive exceeds limit')
  const archive = archivePath
    ? readFileSync(archivePath)
    : await download(
        `https://github.com/openai/codex/releases/download/rust-v${manifest.version}/${manifest.member}.tar.gz`,
        MAX_ARCHIVE
      )
  const binary = extractBinary(archive)
  if (licensePath && lstatSync(licensePath).size > 65536)
    throw new Error('Codex license exceeds limit')
  const license = licensePath ? readFileSync(licensePath) : await download(manifest.license, 65536)
  if (sha256(license) !== manifest.licenseSha256) throw new Error('Invalid Codex license digest')
  mkdirSync(join(root, 'vendor'), { recursive: true })
  const stage = mkdtempSync(join(root, 'vendor/.codex-stage-'))
  const isolation = mkdtempSync(join(tmpdir(), 'codex-version-'))
  let handedOff = false
  try {
    const payload = join(stage, 'payload')
    mkdirSync(payload)
    writeFileSync(join(payload, 'codex'), binary, { mode: 0o755 })
    writeFileSync(join(payload, 'LICENSE'), license)
    writeFileSync(
      join(payload, 'version.json'),
      JSON.stringify({ ...manifest, licenseSha256: sha256(license) }, null, 2) + '\n'
    )
    verifyVersion(join(payload, 'codex'), isolation, isolatedEnv(isolation))
    handedOff = true
    installStaged(stage, destination)
    console.log('Codex 0.154.0 installed and verified (macOS arm64)')
  } finally {
    if (!handedOff) rmSync(stage, { recursive: true, force: true })
    rmSync(isolation, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof CodexRecoveryError) {
      // Only our generated recovery location is printed, never the underlying OS error.
      console.error(
        `Codex rollback failed; prior installation retained at ${JSON.stringify(error.backup)}`
      )
    } else console.error('Codex acquisition failed; check pin, platform, archive and connectivity')
    process.exitCode = 1
  })
}
