/**
 * Where each managed harness comes from and how its download is verified
 * (ADR-082 §4). The pipelines in `scripts/ensure-{opencode,pi,codex}.mjs` are
 * the reference; these put the same payload into a staging directory in the
 * layout the resolver reads (`store.ts`).
 *
 *   opencode  npm registry: `<platform-package>/<version>` metadata gives
 *             `dist.tarball` (must be on registry.npmjs.org) and
 *             `dist.integrity`. Only `package/bin/opencode[.exe]` is kept.
 *             Tested: the reviewed `integrity` and `binarySha256` must match.
 *             Otherwise npm's `integrity` only (`publisher`).
 *   pi        GitHub release `earendil-works/pi` `v<version>`: the host's
 *             asset and `SHA256SUMS`. Tested: the reviewed `archiveSha256`
 *             and the SHA256SUMS entry must match. Otherwise SHA256SUMS only
 *             (`publisher`). The whole archive is kept (pi resolves its
 *             assets relative to itself).
 *   Codex     tested only: `codex` and `codex-code-mode-host` from
 *             `openai/codex` `rust-v<version>`, each `.tar.gz` holding exactly
 *             one member, checked against the reviewed `archiveSha256` and
 *             `binarySha256`, plus the LICENSE at the pinned commit
 *             (`licenseSha256`).
 *
 * Every check fails closed with the reason; there is no override.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HarnessId, HarnessManifest } from '../../../shared/harness-types'
import { ArchiveError, extractTarGz, extractZip, type ExtractedFile } from './archive'
import {
  DownloadError,
  GITHUB_RAW,
  GITHUB_RELEASES,
  NPM_REGISTRY,
  downloadToFile,
  fetchBytes,
  fetchJson,
  fetchText,
  type DownloadedFile,
  type HostPolicy
} from './download'

export class VerifyError extends Error {
  override name = 'VerifyError'
}

export type AcquirePhase = 'resolving' | 'downloading' | 'verifying' | 'extracting'

export interface AcquireContext {
  id: HarnessId
  version: string
  manifest: HarnessManifest
  /** `version === manifest.tested`: the reviewed digests apply. */
  tested: boolean
  platform: NodeJS.Platform
  arch: string
  /** Empty; becomes the version directory. */
  payloadDir: string
  /** Empty; scratch space for archives, removed afterwards. */
  downloadsDir: string
  fetch: typeof fetch
  signal: AbortSignal
  /**
   * The install's download cap, shared by all of its files: bytes still
   * allowed, and bytes received so far (for progress).
   */
  budget: { remaining: number; received: number }
  phase(phase: AcquirePhase): void
  /** Bytes received across the install's downloads, and the current total when known. */
  progress(receivedBytes: number, totalBytes: number | undefined): void
}

export interface Acquired {
  /** The executable `--version` is asked of. */
  executable: string
  verified: 'reviewed' | 'publisher'
}

const METADATA_MAX_BYTES = 1024 * 1024
const SUMS_MAX_BYTES = 64 * 1024
const LICENSE_MAX_BYTES = 64 * 1024

/** Own-property lookup: platform keys come from host strings. */
function platformEntry(manifest: HarnessManifest, key: string): Record<string, unknown> | null {
  return Object.hasOwn(manifest.platforms, key) ? manifest.platforms[key] : null
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** A plain file name: no separators, no leading dot. */
function plainName(value: unknown): value is string {
  return (
    typeof value === 'string' && value !== '' && !/[/\\:]/.test(value) && !value.startsWith('.')
  )
}

/** Download one file of the install into `downloadsDir`, within the install's budget. */
async function download(
  ctx: AcquireContext,
  url: string,
  name: string,
  policy: HostPolicy
): Promise<{ file: string } & DownloadedFile> {
  ctx.phase('downloading')
  const file = path.join(ctx.downloadsDir, name)
  const before = ctx.budget.received
  const result = await downloadToFile(url, file, {
    fetch: ctx.fetch,
    policy,
    signal: ctx.signal,
    maxBytes: ctx.budget.remaining,
    onProgress: (received, total) =>
      ctx.progress(before + received, total !== undefined ? before + total : undefined)
  })
  ctx.budget.remaining -= result.bytes
  ctx.budget.received += result.bytes
  return { file, ...result }
}

async function extract(
  ctx: AcquireContext,
  file: string,
  kind: 'tar.gz' | 'zip',
  select?: (entryPath: string) => string | null
): Promise<ExtractedFile[]> {
  ctx.phase('extracting')
  const opts = { select, signal: ctx.signal, platform: ctx.platform }
  return kind === 'zip'
    ? extractZip(file, ctx.payloadDir, opts)
    : extractTarGz(file, ctx.payloadDir, opts)
}

// ── opencode ──────────────────────────────────────────────────────────────────

/**
 * The manifest platform whose package runs on this host (`ensure-opencode.mjs`
 * `detectPlatformKey`): Windows on arm64 runs the x64 build under emulation.
 */
export function opencodePlatformKey(platform: string, arch: string): string | null {
  if (platform === 'win32') return 'win32-x64'
  if ((platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64')) {
    return `${platform}-${arch}`
  }
  return null
}

/** The sha512 entries of an SRI string (`sha512-<b64> sha1-<b64>`), base64. */
function sriSha512s(integrity: string): string[] {
  return integrity
    .split(/\s+/)
    .filter((part) => part.startsWith('sha512-'))
    .map((part) => part.slice('sha512-'.length))
}

async function acquireOpencode(ctx: AcquireContext): Promise<Acquired> {
  ctx.phase('resolving')
  const key = opencodePlatformKey(ctx.platform, ctx.arch)
  const entry = key ? platformEntry(ctx.manifest, key) : null
  const pkg = entry?.package
  if (!entry || typeof pkg !== 'string' || !/^opencode-[a-z0-9]+-[a-z0-9]+$/.test(pkg)) {
    throw new VerifyError(`opencode has no release for ${ctx.platform}-${ctx.arch}`)
  }
  const reviewedIntegrity = entry.integrity
  const reviewedBinary = entry.binarySha256
  if (
    ctx.tested &&
    (typeof reviewedIntegrity !== 'string' ||
      sriSha512s(reviewedIntegrity).length === 0 ||
      !isHex64(reviewedBinary))
  ) {
    throw new VerifyError(`the opencode manifest has no reviewed digests for ${key}`)
  }

  const meta = await fetchJson(`https://registry.npmjs.org/${pkg}/${ctx.version}`, {
    fetch: ctx.fetch,
    policy: NPM_REGISTRY,
    signal: ctx.signal,
    maxBytes: METADATA_MAX_BYTES
  })
  const dist = (meta as { dist?: { tarball?: unknown; integrity?: unknown } } | null)?.dist
  const tarball = dist?.tarball
  const npmIntegrity = dist?.integrity
  if (typeof tarball !== 'string' || typeof npmIntegrity !== 'string') {
    throw new VerifyError(`npm has no tarball or integrity for ${pkg}@${ctx.version}`)
  }
  let tarballUrl: URL
  try {
    tarballUrl = new URL(tarball)
  } catch {
    throw new VerifyError(`npm lists an invalid tarball URL for ${pkg}@${ctx.version}`)
  }
  if (tarballUrl.protocol !== 'https:' || tarballUrl.host !== 'registry.npmjs.org') {
    throw new VerifyError(
      `npm lists ${pkg}@${ctx.version}'s tarball outside https://registry.npmjs.org/`
    )
  }
  const publisher = sriSha512s(npmIntegrity)
  if (publisher.length === 0) {
    throw new VerifyError(`npm lists no sha512 integrity for ${pkg}@${ctx.version}`)
  }

  const tgz = await download(ctx, tarballUrl.href, `${pkg}-${ctx.version}.tgz`, NPM_REGISTRY)
  ctx.phase('verifying')
  const actual = `sha512-${tgz.sha512}`
  if (!publisher.includes(tgz.sha512)) {
    throw new VerifyError(
      `${pkg}@${ctx.version} tarball integrity ${actual} does not match npm's ${npmIntegrity}`
    )
  }
  if (ctx.tested && !sriSha512s(reviewedIntegrity as string).includes(tgz.sha512)) {
    throw new VerifyError(
      `${pkg}@${ctx.version} tarball integrity ${actual} does not match the reviewed ${String(reviewedIntegrity)}`
    )
  }

  const binName = ctx.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const member = `package/bin/${binName}`
  const files = await extract(ctx, tgz.file, 'tar.gz', (p) => (p === member ? binName : null))
  const bin = files.find((f) => f.dest !== null)
  if (!bin || bin.dest === null) throw new VerifyError(`${member} is missing from ${pkg}`)
  ctx.phase('verifying')
  if (ctx.tested && bin.sha256 !== reviewedBinary) {
    throw new VerifyError(
      `${pkg}@${ctx.version} binary SHA-256 ${bin.sha256} does not match the reviewed ${String(reviewedBinary)}`
    )
  }
  if (ctx.platform !== 'win32') fs.chmodSync(bin.dest, 0o755)
  return { executable: bin.dest, verified: ctx.tested ? 'reviewed' : 'publisher' }
}

// ── pi ────────────────────────────────────────────────────────────────────────

/** `ensure-pi.mjs`'s host naming: anything but Windows and macOS is linux, anything but arm64 is x64. */
export function piPlatformKey(platform: string, arch: string): string {
  const plat = platform === 'win32' || platform === 'darwin' ? platform : 'linux'
  return `${plat}-${arch === 'arm64' ? 'arm64' : 'x64'}`
}

/** The SHA-256 SHA256SUMS lists for exactly `asset`, or null. */
export function sumsEntry(sums: string, asset: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m && m[2] === asset) return m[1].toLowerCase()
  }
  return null
}

async function acquirePi(ctx: AcquireContext): Promise<Acquired> {
  ctx.phase('resolving')
  const key = piPlatformKey(ctx.platform, ctx.arch)
  const entry = platformEntry(ctx.manifest, key)
  const asset = entry?.asset
  if (
    !entry ||
    typeof asset !== 'string' ||
    !/^pi-[a-z0-9]+-[a-z0-9]+\.(?:zip|tar\.gz)$/.test(asset)
  ) {
    throw new VerifyError(`pi has no release asset for ${key}`)
  }
  const reviewed = entry.archiveSha256
  if (ctx.tested && !isHex64(reviewed)) {
    throw new VerifyError(`the pi manifest has no reviewed digest for ${key}`)
  }
  const base = `https://github.com/earendil-works/pi/releases/download/v${ctx.version}`
  const sums = await fetchText(`${base}/SHA256SUMS`, {
    fetch: ctx.fetch,
    policy: GITHUB_RELEASES,
    signal: ctx.signal,
    maxBytes: SUMS_MAX_BYTES
  })
  const listed = sumsEntry(sums, asset)
  if (!listed) throw new VerifyError(`pi ${ctx.version}'s SHA256SUMS does not list ${asset}`)

  const archive = await download(ctx, `${base}/${asset}`, asset, GITHUB_RELEASES)
  ctx.phase('verifying')
  if (archive.sha256 !== listed) {
    throw new VerifyError(
      `${asset} SHA-256 ${archive.sha256} does not match SHA256SUMS (${listed})`
    )
  }
  if (ctx.tested && archive.sha256 !== reviewed) {
    throw new VerifyError(
      `${asset} SHA-256 ${archive.sha256} does not match the reviewed ${String(reviewed)}`
    )
  }

  const files = await extract(ctx, archive.file, asset.endsWith('.zip') ? 'zip' : 'tar.gz')
  if (files.length === 0) throw new VerifyError(`${asset} is empty`)
  const exe = ctx.platform === 'win32' ? 'pi.exe' : 'pi'
  // Flat (`pi`) or nested (`pi/pi`), as the resolver accepts.
  const executable = [path.join(ctx.payloadDir, exe), path.join(ctx.payloadDir, 'pi', exe)].find(
    (p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile()
  )
  if (!executable) throw new VerifyError(`${asset} has no ${exe}`)
  return { executable, verified: ctx.tested ? 'reviewed' : 'publisher' }
}

// ── Codex ─────────────────────────────────────────────────────────────────────

interface CodexBinary {
  name: string
  member: string
  archiveSha256: string
  binarySha256: string
}

function codexBinaries(ctx: AcquireContext): CodexBinary[] {
  const key = `${ctx.platform}-${ctx.arch}`
  const host = platformEntry(ctx.manifest, key)
  const binaries = host?.binaries
  if (!binaries || typeof binaries !== 'object') {
    throw new VerifyError(`Codex has no reviewed release for ${key}`)
  }
  const list: CodexBinary[] = []
  for (const [name, raw] of Object.entries(binaries as Record<string, unknown>)) {
    const e = raw as Record<string, unknown> | null
    if (
      !plainName(name) ||
      !plainName(e?.member) ||
      !isHex64(e?.archiveSha256) ||
      !isHex64(e?.binarySha256)
    ) {
      throw new VerifyError(`the Codex manifest has an invalid record for ${key}`)
    }
    list.push({
      name,
      member: e.member as string,
      archiveSha256: e.archiveSha256 as string,
      binarySha256: e.binarySha256 as string
    })
  }
  const exe = ctx.platform === 'win32' ? 'codex.exe' : 'codex'
  if (!list.some((b) => b.name === exe)) {
    throw new VerifyError(`the Codex manifest for ${key} has no ${exe}`)
  }
  return list
}

async function acquireCodex(ctx: AcquireContext): Promise<Acquired> {
  ctx.phase('resolving')
  if (!ctx.tested) {
    throw new VerifyError(
      `ClaudeUI's Codex is locked to ${ctx.manifest.tested}; ${ctx.version} cannot be installed`
    )
  }
  const binaries = codexBinaries(ctx)
  const licenseUrl = (ctx.manifest as { license?: unknown }).license
  const licenseSha = (ctx.manifest as { licenseSha256?: unknown }).licenseSha256
  if (typeof licenseUrl !== 'string' || !isHex64(licenseSha)) {
    throw new VerifyError('the Codex manifest has no reviewed LICENSE')
  }

  for (const binary of binaries) {
    const archive = await download(
      ctx,
      `https://github.com/openai/codex/releases/download/rust-v${ctx.version}/${binary.member}.tar.gz`,
      `${binary.member}.tar.gz`,
      GITHUB_RELEASES
    )
    ctx.phase('verifying')
    if (archive.sha256 !== binary.archiveSha256) {
      throw new VerifyError(
        `${binary.member}.tar.gz SHA-256 ${archive.sha256} does not match the reviewed ${binary.archiveSha256}`
      )
    }
    // Exactly one regular member, named as reviewed (as `ensure-codex.mjs`).
    const files = await extract(ctx, archive.file, 'tar.gz', (p) =>
      p === binary.member ? binary.name : null
    )
    if (files.length !== 1 || files[0].entryPath !== binary.member || files[0].dest === null) {
      throw new VerifyError(`${binary.member}.tar.gz does not hold exactly ${binary.member}`)
    }
    ctx.phase('verifying')
    if (files[0].sha256 !== binary.binarySha256) {
      throw new VerifyError(
        `${binary.name} SHA-256 ${files[0].sha256} does not match the reviewed ${binary.binarySha256}`
      )
    }
    if (ctx.platform !== 'win32') fs.chmodSync(files[0].dest, 0o755)
  }

  ctx.phase('downloading')
  const licenseBytes = await fetchBytes(licenseUrl, {
    fetch: ctx.fetch,
    policy: GITHUB_RAW,
    signal: ctx.signal,
    maxBytes: LICENSE_MAX_BYTES
  })
  ctx.phase('verifying')
  const actual = createHash('sha256').update(licenseBytes).digest('hex')
  if (actual !== licenseSha) {
    throw new VerifyError(
      `Codex LICENSE SHA-256 ${actual} does not match the reviewed ${licenseSha}`
    )
  }
  fs.writeFileSync(path.join(ctx.payloadDir, 'LICENSE'), licenseBytes, { flag: 'wx' })

  const exe = ctx.platform === 'win32' ? 'codex.exe' : 'codex'
  return { executable: path.join(ctx.payloadDir, exe), verified: 'reviewed' }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const ACQUIRERS: Partial<Record<HarnessId, (ctx: AcquireContext) => Promise<Acquired>>> = {
  opencode: acquireOpencode,
  pi: acquirePi,
  codex: acquireCodex
}

/** Download, verify and unpack `ctx.id` into `ctx.payloadDir`. */
export function acquire(ctx: AcquireContext): Promise<Acquired> {
  const run = ACQUIRERS[ctx.id]
  if (!run) return Promise.reject(new VerifyError(`${ctx.id} has no ClaudeUI-managed copy`))
  return run(ctx)
}

/** Errors whose message is already the user-readable reason. */
export function isInstallFailure(err: unknown): err is Error {
  return err instanceof VerifyError || err instanceof DownloadError || err instanceof ArchiveError
}
