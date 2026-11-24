#!/usr/bin/env bun
/**
 * Writes the install marker (`claudeui-install.json`, `src/shared/install-marker.ts`)
 * into a packaged build, after electron-builder and before macOS codesign:
 *
 *   bun scripts/stamp-install-marker.mjs <packagedPath> --platform mac|win [--quiet]
 *
 * macOS: `<packagedPath>` is the `.app`; the marker goes into
 * `Contents/Resources/` with no entries (a bundle is self-contained).
 * Windows: `<packagedPath>` is the unpacked folder (`dist/win-unpacked`); the
 * marker goes into `resources/` and lists the folder's sorted top-level names,
 * read here, after packaging. Runs under bun because it imports the shared TS.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { INSTALL_MARKER_PRODUCT, INSTALL_MARKER_SEGMENTS } from '../src/shared/install-marker.ts'

/**
 * @param {string} packagedPath
 * @param {'mac' | 'win'} platform
 */
export function installMarkerFor(packagedPath, platform) {
  const entries = platform === 'win' ? fs.readdirSync(packagedPath).sort() : []
  return { schema: 1, product: INSTALL_MARKER_PRODUCT, kind: 'desktop', entries }
}

/**
 * @param {string} packagedPath
 * @param {'mac' | 'win'} platform
 * @returns {string} the marker's path
 */
export function writeInstallMarker(packagedPath, platform) {
  if (platform !== 'mac' && platform !== 'win')
    throw new Error(`--platform must be mac or win (got "${platform ?? ''}")`)
  const stat = fs.statSync(packagedPath)
  if (!stat.isDirectory()) throw new Error(`not a directory: ${packagedPath}`)
  if (platform === 'mac' && !packagedPath.replace(/[\\/]+$/, '').endsWith('.app'))
    throw new Error(`a macOS install is an .app bundle (got ${packagedPath})`)
  const marker = installMarkerFor(packagedPath, platform)
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
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--platform') platform = argv[++i]
    else if (argv[i] === '--quiet')
      continue // always one line
    else if (argv[i].startsWith('--')) throw new Error(`unknown argument: ${argv[i]}`)
    else if (packagedPath === undefined) packagedPath = path.resolve(argv[i])
    else throw new Error(`unexpected argument: ${argv[i]}`)
  }
  if (!packagedPath)
    throw new Error('usage: stamp-install-marker.mjs <packagedPath> --platform mac|win')
  const target = writeInstallMarker(packagedPath, platform)
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
