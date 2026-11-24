/**
 * Fake `claudeui-server` folders for the monitor, staging and gate specs: a temp
 * root with a server marker, an "executable" and a build-info file. Nothing here
 * touches the real `~/.claude/ui`.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { INSTALL_MARKER_PRODUCT } from '../../shared/install-marker'

export function tempDir(prefix = 'claudeui-server-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

export function markerText(
  version: string | undefined,
  kind: 'server' | 'desktop' = 'server'
): string {
  return JSON.stringify({
    schema: 1,
    product: INSTALL_MARKER_PRODUCT,
    kind,
    entries: ['claudeui-server', 'out'],
    ...(version !== undefined ? { version } : {})
  })
}

export function buildInfoText(version: string): string {
  return JSON.stringify({
    schema: 1,
    kind: 'release',
    version,
    channel: 'stable',
    git: {
      describe: `v${version}-0-gabcdef0`,
      baseTag: `v${version}`,
      ahead: 0,
      commit: 'abcdef0123456789',
      dirty: false,
      branch: null
    },
    builtAt: '2026-11-25T00:00:00Z'
  })
}

export interface FakeFolderOptions {
  /** Default true. */
  marker?: boolean
  /** The version the marker names (default: `version`). */
  markerVersion?: string
  /** Default true. */
  exe?: boolean
  exeName?: string
  /** Text of the executable (default a no-op shell script). */
  exeText?: string
}

/** A server folder at `dir` for `version`. */
export function makeServerFolder(
  dir: string,
  version: string,
  opts: FakeFolderOptions = {}
): string {
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'out', 'build-info.json'), buildInfoText(version))
  if (opts.marker !== false)
    fs.writeFileSync(
      path.join(dir, 'claudeui-install.json'),
      markerText(opts.markerVersion ?? version)
    )
  if (opts.exe !== false) {
    const exe = path.join(dir, opts.exeName ?? 'claudeui-server')
    fs.writeFileSync(exe, opts.exeText ?? '#!/bin/sh\nexit 0\n')
    fs.chmodSync(exe, 0o755)
  }
  return dir
}

/** `<root>/versions/<version>` as a server folder. */
export function makeVersion(root: string, version: string, opts: FakeFolderOptions = {}): string {
  return makeServerFolder(path.join(root, 'versions', version), version, opts)
}
