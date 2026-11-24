#!/usr/bin/env bun
/**
 * Writes the install marker (`claudeui-install.json`, `src/shared/install-marker.ts`)
 * into a packaged build, after electron-builder and before macOS codesign:
 *
 *   bun scripts/stamp-install-marker.mjs <packagedPath> --platform mac|win|server
 *     [--build-info <file>] [--quiet]
 *
 * macOS: `<packagedPath>` is the `.app`; the marker goes into
 * `Contents/Resources/` with no entries (a bundle is self-contained).
 * Windows: `<packagedPath>` is the unpacked folder (`dist/win-unpacked`); the
 * marker goes into `resources/` and lists the folder's sorted top-level names,
 * read here, after packaging. Server (`claudeui-server` folder, any OS): the
 * marker sits at the folder's root, `kind: server`, with its top-level names.
 * Every marker carries the build's `version` and `buildId` from build-info
 * (`--build-info`, default: the server folder's own `out/build-info.json`, or
 * the repository's `out/build-info.json` for a desktop build, whose copy is
 * inside the asar); without one, package.json's version and no build id.
 * Runs under bun because it imports the shared TS.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INSTALL_MARKER_PRODUCT, INSTALL_MARKER_SEGMENTS } from '../src/shared/install-marker.ts'
import { buildId, parseBuildInfo } from '../src/shared/build-info.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The build's version and id from a build-info file; package.json's version when unreadable. */
export function buildIdentity(buildInfoFile) {
  try {
    const info = parseBuildInfo(JSON.parse(fs.readFileSync(buildInfoFile, 'utf8')))
    if (info) return { version: info.version, buildId: buildId(info) }
  } catch {
    /* fall back below */
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  return { version }
}

/**
 * @param {string} packagedPath
 * @param {'mac' | 'win' | 'server'} platform
 * @param {{ version: string, buildId?: string }} identity
 */
export function installMarkerFor(packagedPath, platform, identity) {
  const entries = platform === 'mac' ? [] : fs.readdirSync(packagedPath).sort()
  return {
    schema: 1,
    product: INSTALL_MARKER_PRODUCT,
    kind: platform === 'server' ? 'server' : 'desktop',
    entries,
    version: identity.version,
    ...(identity.buildId ? { buildId: identity.buildId } : {})
  }
}

/**
 * @param {string} packagedPath
 * @param {'mac' | 'win' | 'server'} platform
 * @param {string} [buildInfoFile]
 * @returns {string} the marker's path
 */
export function writeInstallMarker(packagedPath, platform, buildInfoFile) {
  if (platform !== 'mac' && platform !== 'win' && platform !== 'server')
    throw new Error(`--platform must be mac, win or server (got "${platform ?? ''}")`)
  const stat = fs.statSync(packagedPath)
  if (!stat.isDirectory()) throw new Error(`not a directory: ${packagedPath}`)
  if (platform === 'mac' && !packagedPath.replace(/[\\/]+$/, '').endsWith('.app'))
    throw new Error(`a macOS install is an .app bundle (got ${packagedPath})`)
  const infoFile =
    buildInfoFile ??
    (platform === 'server'
      ? path.join(packagedPath, 'out', 'build-info.json')
      : path.join(ROOT, 'out', 'build-info.json'))
  const marker = installMarkerFor(packagedPath, platform, buildIdentity(infoFile))
  const segments = INSTALL_MARKER_SEGMENTS[platform]
  const dir = path.join(packagedPath, ...segments.slice(0, -1))
  if (!fs.statSync(dir).isDirectory()) throw new Error(`missing ${dir}`)
  const target = path.join(dir, segments.at(-1))
  fs.writeFileSync(target, JSON.stringify(marker) + '\n')
  return target
}

function main(argv) {
  let packagedPath
  let platform
  let buildInfoFile
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--platform') platform = argv[++i]
    else if (argv[i] === '--build-info') buildInfoFile = path.resolve(argv[++i] ?? '')
    else if (argv[i] === '--quiet')
      continue // always one line
    else if (argv[i].startsWith('--')) throw new Error(`unknown argument: ${argv[i]}`)
    else if (packagedPath === undefined) packagedPath = path.resolve(argv[i])
    else throw new Error(`unexpected argument: ${argv[i]}`)
  }
  if (!packagedPath)
    throw new Error('usage: stamp-install-marker.mjs <packagedPath> --platform mac|win|server')
  const target = writeInstallMarker(packagedPath, platform, buildInfoFile)
  console.log(`install-marker: ${target}`)
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`stamp-install-marker: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
}
