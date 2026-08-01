#!/usr/bin/env node
/**
 * ensure-opencode.mjs
 *
 * Puts a platform-specific opencode binary into vendor/opencode-cli/.
 *
 * Two sources, and the DEFAULT is the fork (ADR-037):
 *
 *  1. **fork build (default)** — clone `package.json#opencodeFork` (our
 *     `sst/opencode` fork, branch `claudeui`, forked from the vendored tag) into
 *     `.cache/opencode-fork`, build it with opencode's own release pipeline
 *     (`packages/opencode/script/build.ts --single`), and vendor the result.
 *     This is how ClaudeUI's patches (P1: the tool-less `/judge/completion`
 *     route) reach the running binary. The upstream release tarball has no
 *     patches, so this path is what production uses.
 *  2. **release download (fallback)** — the original `npm pack` path, kept
 *     behind `--from-release` (or `OPENCODE_VENDOR_FROM_RELEASE=1`) for a
 *     machine that cannot build (no toolchain, offline-ish, CI smoke). The
 *     resulting binary lacks every patch; ClaudeUI degrades gracefully (the
 *     judge transport probes `/doc` and falls back to the tool-denied judge
 *     session), it is just slower and weaker.
 *
 * The download path uses Node.js-native zlib + a minimal tar parser to avoid
 * relying on any external `tar` command (Git Bash's tar treats Windows drive
 * letters like "D:" as hostnames, causing extraction failures).
 *
 * Usage:
 *   node scripts/ensure-opencode.mjs                 # build the fork branch
 *   node scripts/ensure-opencode.mjs --force         # rebuild/re-download even on a cache hit
 *   node scripts/ensure-opencode.mjs --from-release  # unpatched upstream release instead
 */

import { createGunzip } from 'node:zlib'
import { createReadStream } from 'node:fs'
import {
  existsSync,
  mkdirSync,
  chmodSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
  renameSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, execFileSync } from 'node:child_process'
import { cpSync, statSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'opencode-cli')
const CACHE_BASE = join(ROOT, '.cache')
const FORK_DIR = join(CACHE_BASE, 'opencode-fork')

// ── Platform detection ────────────────────────────────────────────────────────

function detectPackageName() {
  const plat = process.platform
  const arch = process.arch
  if (plat === 'win32') return 'opencode-windows-x64'
  if (plat === 'darwin' && arch === 'arm64') return 'opencode-darwin-arm64'
  if (plat === 'darwin') return 'opencode-darwin-x64'
  return 'opencode-linux-x64'
}

// ── Version from package.json ─────────────────────────────────────────────────

function readRootPkg() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
}

function getPinnedVersion() {
  return readRootPkg().opencodeCliVersion ?? '1.17.9'
}

function getForkConfig() {
  const fork = readRootPkg().opencodeFork
  if (!fork?.repo || !fork?.branch) {
    throw new Error('package.json#opencodeFork must set { repo, branch } to build from the fork')
  }
  return fork
}

function binaryName() {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode'
}

// ── Cache-hit check ────────────────────────────────────────────────────────────

/**
 * `expect` narrows the hit to one source. A vendor dir holding an unpatched
 * release binary must NOT satisfy a fork-source request (and vice versa),
 * otherwise switching modes silently keeps the wrong binary.
 */
function isCacheHit(version, expect) {
  const versionFile = join(VENDOR_DIR, 'version.json')
  if (!existsSync(versionFile)) return false
  // The binary must actually be present — an AV quarantine or partial checkout
  // can leave version.json behind with no executable (M-BD1).
  if (!existsSync(join(VENDOR_DIR, binaryName()))) return false
  try {
    const saved = JSON.parse(readFileSync(versionFile, 'utf8'))
    // Match platform/arch too — a checkout copied across machines/architectures
    // otherwise keeps a wrong-arch binary the version alone can't detect.
    if (
      saved.version !== version ||
      saved.platform !== process.platform ||
      saved.arch !== process.arch
    ) {
      return false
    }
    // Pre-ADR-037 version.json files have no `source`; treat them as release.
    const savedSource = saved.source ?? 'release'
    if (savedSource !== expect.source) return false
    if (expect.source === 'fork') {
      return saved.fork?.repo === expect.repo && saved.fork?.branch === expect.branch
    }
    return true
  } catch {
    return false
  }
}

function writeVersionFile(extra) {
  writeFileSync(
    join(VENDOR_DIR, 'version.json'),
    JSON.stringify(
      {
        version: getPinnedVersion(),
        platform: process.platform,
        arch: process.arch,
        ...extra,
      },
      null,
      2
    ) + '\n'
  )
}

// ── Minimal tar extractor (Node.js native, no external tar command) ───────────
//
// Tar format: 512-byte header blocks followed by file data padded to 512 bytes.
// POSIX ustar header layout (offsets):
//   0   name[100]
//   100 mode[8]
//   124 size[12]   (octal)
//   156 typeflag[1]  ('0'/'\0' = file, '5' = dir, 'L' = GNU long-name)
//   265 prefix[155]  (ustar prefix for long filenames)
// GNU long-name: typeflag='L', data block(s) contain the real path.

const TAR_BLOCK = 512

function readOctal(buf, offset, len) {
  const s = buf.subarray(offset, offset + len).toString('ascii').trim()
  return s ? parseInt(s, 8) : 0
}

function readCStr(buf, offset, len) {
  let end = offset
  while (end < offset + len && buf[end] !== 0) end++
  return buf.subarray(offset, end).toString('utf8')
}

/**
 * Extract the first file whose path ends with `targetSuffix` from a .tgz.
 * Reads the file as a stream to avoid loading the 165MB binary fully into RAM
 * before gunzip. Returns a Buffer with the file contents.
 */
function extractFileFromTgz(tgzPath, targetSuffix) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const readable = createReadStream(tgzPath)
    const gunzip = createGunzip()

    readable.on('error', reject)
    gunzip.on('error', reject)

    gunzip.on('data', (chunk) => chunks.push(chunk))
    gunzip.on('end', () => {
      try {
        const tar = Buffer.concat(chunks)
        const result = walkTar(tar, targetSuffix)
        if (!result) {
          reject(new Error(`"${targetSuffix}" not found in ${tgzPath}`))
        } else {
          resolve(result)
        }
      } catch (e) {
        reject(e)
      }
    })

    readable.pipe(gunzip)
  })
}

/**
 * Walk a raw tar buffer and return the contents of the first entry whose path
 * ends with `targetSuffix`.
 */
function walkTar(tar, targetSuffix) {
  let pos = 0
  let pendingLongName = null

  while (pos + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + TAR_BLOCK)
    if (header.every((b) => b === 0)) break  // end-of-archive sentinel

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

    // Normalize path separators for cross-platform matching
    const normName = name.replace(/\\/g, '/')
    const normTarget = targetSuffix.replace(/\\/g, '/')

    const dataBlocks = Math.ceil(fileSize / TAR_BLOCK) * TAR_BLOCK

    if ((typeFlag === '0' || typeFlag === '\0') && fileSize > 0) {
      if (normName.endsWith('/' + normTarget) || normName === normTarget) {
        return Buffer.from(tar.subarray(pos, pos + fileSize))
      }
    }

    pos += dataBlocks
  }

  return null
}

// ── Main download + extract logic ─────────────────────────────────────────────

async function download(pkgName, version) {
  const tmpDir = join(CACHE_BASE, `opencode-tmp-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })

  try {
    const fullPkg = `${pkgName}@${version}`
    console.log(`[ensure-opencode] Downloading ${fullPkg} via npm pack ...`)

    // Use execSync with a constructed command string so Node runs it via the
    // shell on all platforms. This avoids the shell:true + array-args deprecation
    // warning (DEP0190), and lets npm be found as a .cmd script on Windows.
    // All values are version strings / file paths from trusted sources (not user input).
    // The tmpDir path is quoted to handle spaces. The package name has no spaces.
    const packCmd = `npm pack ${fullPkg} --pack-destination "${tmpDir}"`
    execSync(packCmd, { stdio: 'inherit', cwd: ROOT })

    // Find the .tgz produced by npm pack
    const tgzFiles = readdirSync(tmpDir).filter((f) => f.endsWith('.tgz'))
    if (tgzFiles.length === 0) {
      throw new Error(`npm pack did not produce a .tgz in ${tmpDir}`)
    }
    const tgzPath = join(tmpDir, tgzFiles[0])

    const binName = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
    // The npm pack layout is: package/bin/opencode[.exe]
    const targetSuffix = `bin/${binName}`

    console.log(`[ensure-opencode] Extracting ${binName} from ${tgzFiles[0]} ...`)
    const binBytes = await extractFileFromTgz(tgzPath, targetSuffix)
    console.log(`[ensure-opencode] Extracted ${(binBytes.length / 1024 / 1024).toFixed(1)} MB`)

    mkdirSync(VENDOR_DIR, { recursive: true })
    const dest = join(VENDOR_DIR, binName)

    // Write via temp file + rename for atomicity
    const tmpDest = dest + '.tmp'
    const fd = openSync(tmpDest, 'w')
    writeSync(fd, binBytes)
    closeSync(fd)
    replaceBinary(tmpDest, dest)

    if (process.platform !== 'win32') {
      chmodSync(dest, 0o755)
    }

    writeVersionFile({
      source: 'release',
      package: pkgName,
      downloadedAt: new Date().toISOString(),
    })

    console.log(
      `[ensure-opencode] opencode ${version} installed to vendor/opencode-cli/${binName}` +
        ' (UNPATCHED upstream release — the /judge/completion route is absent)'
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Fork build ────────────────────────────────────────────────────────────────

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
    console.log(`[ensure-opencode] previous binary still in use; left ${displaced} for later cleanup`)
  }
}

/** Run git, streaming its output. */
function gitRun(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'inherit' })
}

/** Run git and capture stdout. */
function gitOut(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}

/**
 * opencode's build names each dist dir `opencode-<os>-<arch>` with `win32`
 * spelled `windows`. Derive it here rather than reusing the npm package name,
 * which collapses every linux arch onto x64.
 */
function distDirName() {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  return `opencode-${os}-${process.arch}`
}

/**
 * opencode's build scripts hard-require the bun version in their root
 * `packageManager` field (packages/script/src/index.ts refuses to run
 * otherwise). Rather than force a global `bun upgrade` on the developer, drop a
 * pinned standalone bun in `.cache/` and use it only for this build.
 */
function ensureBun(forkDir) {
  const required = JSON.parse(readFileSync(join(forkDir, 'package.json'), 'utf8'))
    .packageManager?.split('@')[1]
  if (!required) throw new Error('fork root package.json has no packageManager field')

  const localOk = (() => {
    try {
      const have = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim()
      const [a, b, c] = have.split('.').map(Number)
      const [x, y, z] = required.split('.').map(Number)
      // `^x.y.z` — same major, and >= the pinned minor/patch.
      return a === x && (b > y || (b === y && c >= z))
    } catch {
      return false
    }
  })()
  if (localOk) return 'bun'

  const dir = join(CACHE_BASE, `bun-${required}`)
  const exe = join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (existsSync(exe)) return exe

  const target =
    process.platform === 'win32'
      ? 'bun-windows-x64'
      : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? 'bun-darwin-aarch64'
          : 'bun-darwin-x64'
        : process.arch === 'arm64'
          ? 'bun-linux-aarch64'
          : 'bun-linux-x64'

  console.log(`[ensure-opencode] Local bun does not satisfy ^${required}; fetching ${target} ...`)
  mkdirSync(dir, { recursive: true })
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${required}/${target}.zip`
  const zip = join(dir, 'bun.zip')
  execSync(`curl -fsSL -o "${zip}" "${url}"`, { stdio: 'inherit' })
  // Node has no zip reader; use the platform's. NOT `tar` on Windows: the
  // bundled bsdtar reads "D:\..." as host:path and fails (the same trap this
  // file's header calls out for the release tarball).
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`,
      ],
      { stdio: 'inherit' }
    )
  } else {
    execSync(`unzip -o -q "${zip}" -d "${dir}"`, { stdio: 'inherit' })
  }
  const nested = join(dir, target, process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (existsSync(nested)) {
    cpSync(nested, exe)
    if (process.platform !== 'win32') chmodSync(exe, 0o755)
  }
  if (!existsSync(exe)) throw new Error(`bun ${required} not found after extracting ${url}`)
  return exe
}

/** Clone (or refresh) the fork branch and return its HEAD sha. */
function syncFork(fork) {
  mkdirSync(CACHE_BASE, { recursive: true })
  if (!existsSync(join(FORK_DIR, '.git'))) {
    console.log(`[ensure-opencode] Cloning ${fork.repo} (${fork.branch}) ...`)
    // Blobless: full history/refs (the build reads `git branch --show-current`)
    // without paying for every blob ever committed.
    execFileSync(
      'git',
      ['clone', '--filter=blob:none', '--branch', fork.branch, fork.repo, FORK_DIR],
      { stdio: 'inherit' }
    )
  } else {
    console.log(`[ensure-opencode] Refreshing ${FORK_DIR} (${fork.branch}) ...`)
    gitRun(['fetch', 'origin', fork.branch], FORK_DIR)
    gitRun(['checkout', '-B', fork.branch, `origin/${fork.branch}`], FORK_DIR)
  }
  // Any local edit (our install workaround below, a stray build artifact) must
  // not leak into the vendored binary.
  gitRun(['reset', '--hard', `origin/${fork.branch}`], FORK_DIR)
  return gitOut(['rev-parse', 'HEAD'], FORK_DIR)
}

/**
 * Windows-only: `tree-sitter-powershell`'s postinstall runs node-gyp, which
 * fails without a matching MSVC toolchain AND aborts the rest of bun's install,
 * leaving a half-extracted node_modules that then fails the build in confusing
 * ways. opencode only ever imports that package's prebuilt `.wasm`
 * (packages/opencode/src/tool/shell.ts), so the native binding is dead weight —
 * temporarily untrust it so its script never runs.
 */
function withInstallWorkaround(forkDir, run) {
  const pkgPath = join(forkDir, 'package.json')
  const original = readFileSync(pkgPath, 'utf8')
  if (process.platform === 'win32') {
    const patched = original.replace(/^[ \t]*"tree-sitter-powershell",[ \t]*\r?\n/m, '')
    if (patched !== original) writeFileSync(pkgPath, patched)
  }
  try {
    run()
  } finally {
    writeFileSync(pkgPath, original)
  }
}

async function buildFork(version, fork) {
  const commit = syncFork(fork)
  const bun = ensureBun(FORK_DIR)

  console.log(`[ensure-opencode] Installing fork dependencies (bun: ${bun}) ...`)
  withInstallWorkaround(FORK_DIR, () => {
    execFileSync(bun, ['install'], { cwd: FORK_DIR, stdio: 'inherit' })
  })

  console.log(`[ensure-opencode] Building opencode ${version} from ${fork.branch}@${commit.slice(0, 8)} ...`)
  const pkgDir = join(FORK_DIR, 'packages', 'opencode')
  execFileSync(bun, ['run', 'script/build.ts', '--single', '--skip-install'], {
    cwd: pkgDir,
    stdio: 'inherit',
    // Pin the version instead of letting their script derive one from the npm
    // registry / current branch name (which would produce a 0.0.0-claudeui-*
    // preview version and break every version comparison downstream).
    env: { ...process.env, OPENCODE_VERSION: version },
  })

  const binName = binaryName()
  const built = join(pkgDir, 'dist', distDirName(), 'bin', binName)
  if (!existsSync(built)) throw new Error(`fork build produced no binary at ${built}`)

  mkdirSync(VENDOR_DIR, { recursive: true })
  const dest = join(VENDOR_DIR, binName)
  const tmpDest = dest + '.tmp'
  cpSync(built, tmpDest)
  replaceBinary(tmpDest, dest)
  if (process.platform !== 'win32') chmodSync(dest, 0o755)

  writeVersionFile({
    source: 'fork',
    fork: {
      repo: fork.repo,
      branch: fork.branch,
      commit,
      ...(fork.tag ? { forkedFrom: fork.tag } : {}),
    },
    builtAt: new Date().toISOString(),
  })

  console.log(
    `[ensure-opencode] opencode ${version} (fork ${fork.branch}@${commit.slice(0, 8)}, ` +
      `${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB) installed to vendor/opencode-cli/${binName}`
  )
}

// ── Entry point ────────────────────────────────────────────────────────────────

const force = process.argv.includes('--force')
const fromRelease =
  process.argv.includes('--from-release') || process.env.OPENCODE_VENDOR_FROM_RELEASE === '1'
const version = getPinnedVersion()
const pkgName = detectPackageName()

const expect = fromRelease ? { source: 'release' } : { source: 'fork', ...getForkConfig() }

if (!force && isCacheHit(version, expect)) {
  console.log(
    `[ensure-opencode] opencode ${version} (${expect.source}) already vendored (cache hit). ` +
      'Use --force to rebuild.'
  )
  process.exit(0)
}

const task = fromRelease ? download(pkgName, version) : buildFork(version, getForkConfig())

task.catch((err) => {
  console.error(`\n[ensure-opencode] FAIL: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
