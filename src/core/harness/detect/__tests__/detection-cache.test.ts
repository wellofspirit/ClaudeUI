/**
 * @vitest-environment node
 *
 * `~/.claude/ui/harness-detection.json`: round trip, per-harness merge,
 * tolerant reads, and fingerprint freshness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DetectedInstall, HarnessDetection } from '../../../../shared/harness-types'
import {
  harnessDetectionPath,
  isFingerprintFresh,
  loadDetectionCache,
  saveDetectionCache
} from '../detection-cache'
import { fingerprintOf } from '../fs-util'

let tmp: string
let file: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-cache-')))
  file = path.join(tmp, 'ui', 'harness-detection.json')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function install(overrides: Partial<DetectedInstall> = {}): DetectedInstall {
  return {
    id: 'pi',
    displayPath: '/usr/local/bin/pi',
    realPath: '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
    launch: {
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'],
      env: { PI_MANAGED_INSTALL_ROOT: '/r' }
    },
    installKind: 'npm',
    version: '0.87.1',
    verdict: 'tested',
    fingerprint: { path: '/x', size: 10, mtimeMs: 1234.5 },
    node: { path: '/usr/local/bin/node', version: '24.1.0' },
    ...overrides
  }
}

describe('detection cache', () => {
  it('lives in ~/.claude/ui', () => {
    expect(harnessDetectionPath()).toBe(
      path.join(os.homedir(), '.claude', 'ui', 'harness-detection.json')
    )
  })

  it('round-trips, and a save replaces only the harnesses it is given', () => {
    const pi: HarnessDetection = {
      id: 'pi',
      detectedAt: '2026-09-30T00:00:00.000Z',
      installs: [
        install(),
        install({ node: { kind: 'electron', version: '24.18.1' } }),
        install({
          launch: { command: '/n/node', args: ['/cli.js'], pathPrepend: ['/n'] },
          nodeFingerprint: { path: '/n/node', size: 3, mtimeMs: 9 }
        })
      ]
    }
    const claude: HarnessDetection = {
      id: 'claude',
      detectedAt: '2026-09-30T00:00:00.000Z',
      installs: [
        install({
          id: 'claude',
          launch: null,
          node: undefined,
          version: null,
          verdict: 'unsupported',
          reason: 'x is a script launcher ClaudeUI cannot run directly'
        })
      ]
    }
    delete claude.installs[0].node
    saveDetectionCache([pi, claude], file)
    expect(loadDetectionCache(file)).toEqual({ pi, claude })

    const newer: HarnessDetection = { ...pi, detectedAt: '2026-10-01T00:00:00.000Z', installs: [] }
    saveDetectionCache([newer], file)
    expect(loadDetectionCache(file)).toEqual({ pi: newer, claude })
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('reads a missing or malformed file as nothing cached', () => {
    expect(loadDetectionCache(file)).toEqual({})
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json')
    expect(loadDetectionCache(file)).toEqual({})
  })

  it('drops malformed entries and unknown harnesses, keeping the rest', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const good = install()
    fs.writeFileSync(
      file,
      JSON.stringify({
        detections: {
          pi: {
            id: 'pi',
            detectedAt: 'x',
            installs: [
              good,
              { ...good, verdict: 'great' },
              { ...good, launch: { command: 'x', args: [1] } },
              { ...good, fingerprint: { path: '/x' } },
              { ...good, launch: { ...good.launch, pathPrepend: '/n' } },
              { ...good, nodeFingerprint: { path: '/n/node' } },
              { ...good, id: 'claude' }
            ]
          },
          claude: { id: 'opencode', detectedAt: 'x', installs: [] },
          nope: { id: 'nope', detectedAt: 'x', installs: [] }
        }
      })
    )
    expect(loadDetectionCache(file)).toEqual({
      pi: { id: 'pi', detectedAt: 'x', installs: [good] }
    })
  })

  it('replaces a corrupt file on save', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json')
    const pi: HarnessDetection = { id: 'pi', detectedAt: 'x', installs: [] }
    saveDetectionCache([pi], file)
    expect(loadDetectionCache(file)).toEqual({ pi })
  })
})

describe('isFingerprintFresh', () => {
  it('holds until the file changes or disappears', () => {
    const bin = path.join(tmp, 'claude')
    fs.writeFileSync(bin, 'v1')
    const fingerprint = fingerprintOf(bin)
    expect(isFingerprintFresh({ fingerprint })).toBe(true)
    fs.writeFileSync(bin, 'version two')
    expect(isFingerprintFresh({ fingerprint })).toBe(false)
    const again = fingerprintOf(bin)
    fs.utimesSync(bin, new Date(2020, 0, 1), new Date(2020, 0, 1))
    expect(isFingerprintFresh({ fingerprint: again })).toBe(false)
    fs.rmSync(bin)
    expect(isFingerprintFresh({ fingerprint: again })).toBe(false)
  })

  it('holds for pi only while its node is unchanged too', () => {
    const cli = path.join(tmp, 'cli.js')
    const node = path.join(tmp, 'node')
    fs.writeFileSync(cli, 'js')
    fs.writeFileSync(node, 'n1')
    const prints = { fingerprint: fingerprintOf(cli), nodeFingerprint: fingerprintOf(node) }
    expect(isFingerprintFresh(prints)).toBe(true)
    fs.writeFileSync(node, 'node two')
    expect(isFingerprintFresh(prints)).toBe(false)
    fs.rmSync(node)
    expect(isFingerprintFresh(prints)).toBe(false)
  })
})
