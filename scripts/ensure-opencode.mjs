#!/usr/bin/env node
/**
 * ensure-opencode.mjs
 *
 * Puts the upstream opencode release binary for this platform into
 * vendor/opencode-cli/, checked against digests reviewed into the repo
 * (ADR-081 §7). There is one source: `npm pack opencode-<os>-<arch>@<version>`,
 * where `<version>` is the release manifest's `tested`
 * (`src/shared/harness-manifests/opencode.json`, ADR-082 §5).
 *
 * The manifest pins, per `<platform>-<arch>`, the npm package, the tarball's npm
 * `integrity` (sha512) and the SHA-256 of `package/bin/opencode[.exe]`.
 * Every step fails closed:
 *
 *  - the tarball's integrity must match, then the extracted binary's SHA-256;
 *  - the staged binary must answer `--version` with the pinned version, run
 *    in an isolated home so the check never touches the developer's own
 *    opencode config or data.
 *
 * Any failure deletes the download and leaves the vendored binary untouched.
 * `version.json` records the package, integrity and `binarySha256`; a cache
 * hit re-hashes the installed binary against the manifest, so a stale or
 * swapped binary (including a pre-ADR-081 fork build) is always replaced.
 *
 * The tarball is unpacked with Node.js-native zlib + a minimal tar parser to
 * avoid relying on any external `tar` command (Git Bash's tar treats Windows
 * drive letters like "D:" as hostnames, causing extraction failures).
 *
 * Bumping: set the manifest's `tested` (and `floor`), `npm pack` each package in
 * it, record `integrity` from `npm pack --json` and the SHA-256 of the binary
 * inside, then run `bun run update-opencode`.
 *
 * Usage:
 *   node scripts/ensure-opencode.mjs          # vendor the pinned release (cache hit = no-op)
 *   node scripts/ensure-opencode.mjs --force  # re-download even on a cache hit
 *   node scripts/ensure-opencode.mjs --quiet  # suppress info logs (cache-hit/installed lines stay)
 */

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execSync, execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'opencode-cli')

const MANIFEST_PATH = 'src/shared/harness-manifests/opencode.json'
export const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST_PATH), 'utf8'))
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
/** npm's `integrity` format (Subresource Integrity, sha512). */
export const sriSha512 = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

// The largest pinned tarball is ~60 MB and the largest binary ~185 MB (linux
// x64, 1.18.32); both caps leave room for growth without accepting anything.
const MAX_TARBALL = 256 * 1024 * 1024
const MAX_BINARY = 512 * 1024 * 1024

const QUIET = process.argv.includes('--quiet')

/** Info-level log — suppressed by --quiet. */
function info(...args) {
  if (!QUIET) console.log(...args)
}

// ── Platform detection ────────────────────────────────────────────────────────

/**
 * The manifest platform whose package runs on this host. Windows on arm64 runs
 * the x64 build under emulation; any other host has no reviewed package and
 * fails here rather than vendoring a binary that cannot run.
 */
export function detectPlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'win32-x64'
  if ((platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64'))
    return `${platform}-${arch}`
  throw new Error(`no reviewed opencode release for ${platform}-${arch}`)
}

export function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'opencode.exe' : 'opencode'
}

// ── Pin + manifest ────────────────────────────────────────────────────────────

export function getPinnedVersion(m = manifest) {
  const version = m.tested
  // The version is interpolated into the `npm pack` command line below.
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${MANIFEST_PATH}#tested is missing or not a plain semver`)
  }
  return version
}

/**
 * The reviewed record for one manifest platform, in exactly the shape
 * `version.json` carries (and `isCacheHit` compares).
 */
export function expectedRelease(platformKey, m = manifest) {
  // Own-property lookup only: the key is caller-supplied, not a trusted path.
  const entry = Object.hasOwn(m.platforms ?? {}, platformKey) ? m.platforms[platformKey] : null
  if (
    !entry ||
    // The package name is interpolated into the `npm pack` command line below.
    typeof entry.package !== 'string' ||
    !/^opencode-[a-z0-9]+-[a-z0-9]+$/.test(entry.package) ||
    typeof entry.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity) ||
    typeof entry.binarySha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(entry.binarySha256)
  ) {
    throw new Error(`${MANIFEST_PATH} has no valid digest record for ${platformKey}`)
  }
  return {
    version: getPinnedVersion(m),
    package: entry.package,
    integrity: entry.integrity,
    binarySha256: entry.binarySha256
  }
}

// ── Cache-hit check ────────────────────────────────────────────────────────────

/**
 * A hit needs the recorded identity (version, platform/arch, release source,
 * package, digest) AND the installed bytes to match the manifest. Hashing the
 * binary is what makes a hit trustworthy: an AV quarantine, a partial
 * checkout, a copy from another machine or an old fork build all miss.
 */
export function isCacheHit(
  expected,
  dir = VENDOR_DIR,
  platform = process.platform,
  arch = process.arch
) {
  try {
    const saved = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'))
    if (
      saved.version !== expected.version ||
      saved.platform !== platform ||
      saved.arch !== arch ||
      saved.source !== 'release' ||
      saved.package !== expected.package ||
      saved.binarySha256 !== expected.binarySha256
    ) {
      return false
    }
    const bin = join(dir, binaryName(platform))
    return lstatSync(bin).isFile() && sha256(readFileSync(bin)) === expected.binarySha256
  } catch {
    return false
  }
}

// ── Minimal tar extractor (Node.js native, no external tar command) ───────────
//
// Tar format: 512-byte header blocks followed by file data padded to 512 bytes.
// POSIX ustar header layout (offsets):
//   0   name[100]
//   100 mode[8]
//   124 size[12]   (octal)
//   156 typeflag[1]  ('0'/'\0' = file, '5' = dir, 'L' = GNU long-name)
//   345 prefix[155]  (ustar prefix for long filenames)
// GNU long-name: typeflag='L', data block(s) contain the real path.
//
// The parser is lenient because it never decides trust: the tarball's
// integrity is checked before it runs and the binary's digest after.

const TAR_BLOCK = 512

function readOctal(buf, offset, len) {
  const s = buf
    .subarray(offset, offset + len)
    .toString('ascii')
    .trim()
  return s ? parseInt(s, 8) : 0
}

function readCStr(buf, offset, len) {
  let end = offset
  while (end < offset + len && buf[end] !== 0) end++
  return buf.subarray(offset, end).toString('utf8')
}

/**
 * Walk a raw tar buffer and return the contents of the regular-file entry
 * whose path is exactly `targetPath`, or null.
 */
export function walkTar(tar, targetPath) {
  let pos = 0
  let pendingLongName = null

  while (pos + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + TAR_BLOCK)
    if (header.every((b) => b === 0)) break // end-of-archive sentinel

    pos += TAR_BLOCK

    const typeFlag = String.fromCharCode(header[156])
    const fileSize = readOctal(header, 124, 12)

    // GNU long-name extension: typeflag 'L' → the next data block(s) hold the real name
    if (typeFlag === 'L') {
      const nameBytes = tar.subarray(pos, pos + fileSize)
      pendingLongName = nameBytes.toString('utf8').replace(/\0/g, '')
      pos += Math.ceil(fileSize / TAR_BLOCK) * TAR_BLOCK
      continue
    }

    let name
    if (pendingLongName !== null) {
      name = pendingLongName
      pendingLongName = null
    } else {
      const prefix = readCStr(header, 345, 155)
      const fname = readCStr(header, 0, 100)
      name = prefix ? `${prefix}/${fname}` : fname
    }

    if ((typeFlag === '0' || typeFlag === '\0') && fileSize > 0 && name === targetPath) {
      if (pos + fileSize > tar.length) return null // truncated archive
      return Buffer.from(tar.subarray(pos, pos + fileSize))
    }

    pos += Math.ceil(fileSize / TAR_BLOCK) * TAR_BLOCK
  }

  return null
}

/**
 * Verify an npm tarball against its reviewed record and return the binary.
 * The npm layout is `package/bin/opencode[.exe]`.
 */
export function extractBinary(tgz, expected, binName = binaryName()) {
  if (tgz.length > MAX_TARBALL) throw new Error(`${expected.package} tarball exceeds the size cap`)
  const integrity = sriSha512(tgz)
  if (integrity !== expected.integrity) {
    throw new Error(
      `${expected.package}@${expected.version} tarball integrity ${integrity} does not match ` +
        `the reviewed ${expected.integrity} (${MANIFEST_PATH})`
    )
  }
  const tar = gunzipSync(tgz, { maxOutputLength: MAX_BINARY + 1024 * 1024 })
  const bin = walkTar(tar, `package/bin/${binName}`)
  if (!bin) throw new Error(`package/bin/${binName} not found in ${expected.package}`)
  const digest = sha256(bin)
  if (digest !== expected.binarySha256) {
    throw new Error(
      `${expected.package}@${expected.version} binary SHA-256 ${digest} does not match ` +
        `the reviewed ${expected.binarySha256} (${MANIFEST_PATH})`
    )
  }
  return bin
}

// ── Version check ─────────────────────────────────────────────────────────────

/**
 * A throwaway home for `opencode --version`: opencode creates its XDG data,
 * config, cache and state dirs at startup, and must not do so in the
 * developer's real ones. PATH is minimal so nothing on the caller's PATH is
 * picked up; SYSTEMROOT is kept because parts of the Windows runtime resolve
 * it at startup (as in ensure-codex).
 */
export function isolatedEnv(directory, platform = process.platform) {
  const home = join(directory, 'home')
  const tmp = join(directory, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  const xdg = {
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state')
  }
  if (platform === 'win32') {
    const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows'
    return {
      USERPROFILE: home,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      TEMP: tmp,
      TMP: tmp,
      SYSTEMROOT: systemRoot,
      PATH: join(systemRoot, 'System32'),
      ...xdg
    }
  }
  return { HOME: home, TMPDIR: tmp, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', ...xdg }
}

/** `binary --version` must print exactly `version`. */
export function verifyVersion(binary, cwd, env, version) {
  let output
  try {
    output = execFileSync(binary, ['--version'], {
      cwd,
      env,
      // Generous: the first run of a fresh 180 MB executable can sit behind an
      // on-access AV scan.
      timeout: 60000,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    })
  } catch (err) {
    throw new Error(`the downloaded opencode failed to run --version (${err.code ?? 'error'})`)
  }
  if (output.trim() !== version) {
    throw new Error(
      `the downloaded opencode reports version ${JSON.stringify(output.trim())}, expected ${version}`
    )
  }
}

// ── Install ───────────────────────────────────────────────────────────────────

/**
 * Move `tmp` onto `dest`, tolerating a *running* vendored binary.
 *
 * Windows refuses `rename(tmp, dest)` while something has `dest` open — a live
 * ClaudeUI holds two `opencode serve` children on it — but it does allow
 * renaming the open file itself out of the way (the self-update trick). So:
 * displace the old binary, move the new one in, then best-effort delete the
 * displaced copy (which fails while it is still running; the next run sweeps
 * the leftovers).
 */
function replaceBinary(tmp, dest) {
  // Sweep displaced copies from earlier runs whose processes have since exited.
  const dir = dirname(dest)
  const base = dest.slice(dir.length + 1)
  for (const name of readdirSync(dir)) {
    if (name.startsWith(`${base}.old-`)) {
      try {
        rmSync(join(dir, name), { force: true })
      } catch {
        /* still running — try again next time */
      }
    }
  }

  if (!existsSync(dest)) {
    renameSync(tmp, dest)
    return
  }
  const displaced = `${dest}.old-${Date.now()}`
  try {
    renameSync(dest, displaced)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw new Error(
      `cannot replace ${dest} (${err.code ?? err.message}). Close ClaudeUI (it keeps ` +
        '`opencode serve` children alive on this binary) and re-run.'
    )
  }
  renameSync(tmp, dest)
  try {
    rmSync(displaced, { force: true })
  } catch {
    info(`[ensure-opencode] previous binary still in use; left ${displaced} for later cleanup`)
  }
}

async function install(expected) {
  const binName = binaryName()
  mkdirSync(VENDOR_DIR, { recursive: true })
  // Staged inside the vendor dir: gitignored, outside electron-builder's
  // `opencode*` filter, and on the same volume as the final rename.
  const stage = mkdtempSync(join(VENDOR_DIR, '.stage-'))
  const isolation = mkdtempSync(join(tmpdir(), 'opencode-version-'))
  try {
    const fullPkg = `${expected.package}@${expected.version}`
    info(`[ensure-opencode] Downloading ${fullPkg} via npm pack ...`)

    // Use execSync with a constructed command string so Node runs it via the
    // shell on all platforms. This avoids the shell:true + array-args deprecation
    // warning (DEP0190), and lets npm be found as a .cmd script on Windows.
    // The package name and the version are validated in expectedRelease() and
    // getPinnedVersion(); the stage path is quoted.
    execSync(`npm pack ${fullPkg} --pack-destination "${stage}"`, { stdio: 'inherit', cwd: ROOT })

    const tgzFiles = readdirSync(stage).filter((f) => f.endsWith('.tgz'))
    if (tgzFiles.length !== 1) {
      throw new Error(`npm pack produced ${tgzFiles.length} tarballs, expected one`)
    }

    info(`[ensure-opencode] Verifying and extracting ${binName} from ${tgzFiles[0]} ...`)
    const binBytes = extractBinary(readFileSync(join(stage, tgzFiles[0])), expected, binName)
    info(`[ensure-opencode] Extracted ${(binBytes.length / 1024 / 1024).toFixed(1)} MB (digest ok)`)

    const staged = join(stage, binName)
    writeFileSync(staged, binBytes, { mode: 0o755 })
    if (process.platform !== 'win32') chmodSync(staged, 0o755)
    verifyVersion(staged, isolation, isolatedEnv(isolation), expected.version)

    replaceBinary(staged, join(VENDOR_DIR, binName))
    writeFileSync(
      join(VENDOR_DIR, 'version.json'),
      JSON.stringify(
        {
          version: expected.version,
          platform: process.platform,
          arch: process.arch,
          source: 'release',
          package: expected.package,
          integrity: expected.integrity,
          binarySha256: expected.binarySha256,
          downloadedAt: new Date().toISOString()
        },
        null,
        2
      ) + '\n'
    )

    console.log(
      `[ensure-opencode] opencode ${expected.version} (${expected.package}, sha256 ` +
        `${expected.binarySha256.slice(0, 12)}…) verified and installed to vendor/opencode-cli/${binName}`
    )
  } finally {
    // The stage holds the tarball, and the binary whenever a check failed.
    rmSync(stage, { recursive: true, force: true, maxRetries: 3 })
    rmSync(isolation, { recursive: true, force: true, maxRetries: 3 })
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes('--force')
  const version = getPinnedVersion()
  const expected = expectedRelease(detectPlatformKey())

  if (!force && isCacheHit(expected)) {
    console.log(
      `[ensure-opencode] opencode ${version} (${expected.package}) already vendored and ` +
        'verified (cache hit). Use --force to re-download.'
    )
    return
  }
  await install(expected)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n[ensure-opencode] FAIL: ${err.message}`)
    if (err.stack) console.error(err.stack)
    process.exitCode = 1
  })
}
