/**
 * @vitest-environment node
 *
 * `resolveSystemInstall`'s consistency check on its own, where the platform
 * rules can be pinned: Windows paths compare case-insensitively, POSIX paths
 * exactly, and the launch returned is always rebuilt from the checked fields.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DetectedInstall } from '../../../shared/harness-types'
import { fingerprintOf } from '../detect/fs-util'
import { harnessManifest } from '../manifests'
import { resolveSystemInstall } from '../system-source'

let tmp: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'system-source-')))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function opencode(command: (real: string) => string): DetectedInstall {
  const real = path.join(tmp, 'bin', 'opencode.exe')
  fs.mkdirSync(path.dirname(real), { recursive: true })
  fs.writeFileSync(real, 'x')
  return {
    id: 'opencode',
    displayPath: real,
    realPath: real,
    launch: { command: command(real), args: [] },
    installKind: 'path',
    version: harnessManifest('opencode').tested,
    verdict: 'tested',
    fingerprint: fingerprintOf(real)
  }
}

const detection = (install: DetectedInstall) => ({
  id: install.id,
  detectedAt: 'x',
  installs: [install]
})

describe('resolveSystemInstall', () => {
  it('compares a Windows command case-insensitively and spawns the fingerprinted path', () => {
    const install = opencode((real) => real.toUpperCase())
    const outcome = resolveSystemInstall('opencode', detection(install), {
      electron: null,
      platform: 'win32'
    })
    expect(outcome).toMatchObject({ kind: 'ok', launch: { command: install.realPath, args: [] } })
  })

  it('compares a POSIX command exactly', () => {
    const install = opencode((real) => real.toUpperCase())
    const outcome = resolveSystemInstall('opencode', detection(install), {
      electron: null,
      platform: 'linux'
    })
    expect(outcome).toMatchObject({ kind: 'fallback', redetect: true })
  })

  it('never hands back the cached launch object', () => {
    const install = opencode((real) => real)
    const outcome = resolveSystemInstall('opencode', detection(install), { electron: null })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.launch).not.toBe(install.launch)
  })

  it('refuses a node launch for anything but pi', () => {
    const install = opencode((real) => real)
    const node = path.join(tmp, 'node.exe')
    fs.writeFileSync(node, 'n')
    const outcome = resolveSystemInstall(
      'opencode',
      detection({
        ...install,
        launch: { command: node, args: [install.realPath] },
        node: { path: node, version: '24.1.0' },
        nodeFingerprint: fingerprintOf(node)
      }),
      { electron: null }
    )
    expect(outcome.kind).toBe('fallback')
  })
})
