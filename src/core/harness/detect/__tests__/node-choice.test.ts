/**
 * @vitest-environment node
 *
 * Which node runs a Node-script pi install (ADR-082 §2, owner ruling
 * 2026-09-30): the install's own, then PATH, each ≥ 22.19.0; Electron is
 * reported as a distinct fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { chooseNode, parseNodeVersion } from '../node-choice'
import type { RunFn } from '../run'
import { writeNative } from './layout'

const EXE = process.platform === 'win32' ? '.exe' : ''
let tmp: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-node-')))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A runner answering `node --version` from a path → version table. */
function versions(table: Record<string, string>) {
  return vi.fn<RunFn>(async (command, _args, options) => {
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    const v = table[command]
    return v
      ? { stdout: `v${v}\n`, code: 0, timedOut: false }
      : { stdout: '', code: 1, timedOut: false }
  })
}

describe('chooseNode', () => {
  it("prefers the install's own node over PATH", async () => {
    const own = writeNative(path.join(tmp, 'own', `node${EXE}`))
    const onPath = writeNative(path.join(tmp, 'path', `node${EXE}`))
    const run = versions({ [own]: '22.19.0', [onPath]: '26.7.0' })
    await expect(
      chooseNode([own], {
        run,
        env: { ANTHROPIC_API_KEY: 'x' },
        pathEntries: [path.dirname(onPath)],
        electron: null,
        cache: new Map()
      })
    ).resolves.toEqual({ kind: 'node', path: own, version: '22.19.0' })
  })

  it('skips a node that is too old and takes the next suitable one', async () => {
    const old = writeNative(path.join(tmp, 'old', `node${EXE}`))
    const onPath = writeNative(path.join(tmp, 'path', `node${EXE}`))
    const run = versions({ [old]: '22.18.9', [onPath]: '24.0.0' })
    await expect(
      chooseNode([old], {
        run,
        pathEntries: [path.dirname(onPath)],
        electron: null,
        cache: new Map()
      })
    ).resolves.toEqual({ kind: 'node', path: onPath, version: '24.0.0' })
  })

  it('caches node --version per realpath', async () => {
    const node = writeNative(path.join(tmp, 'n', `node${EXE}`))
    const run = versions({ [node]: '24.0.0' })
    const cache = new Map<string, string | null>()
    await chooseNode([node], { run, electron: null, cache })
    await chooseNode([node], { run, electron: null, cache })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('falls back to Electron as a distinct choice', async () => {
    const old = writeNative(path.join(tmp, 'old', `node${EXE}`))
    const run = versions({ [old]: '20.11.0' })
    await expect(
      chooseNode([old], {
        run,
        electron: { execPath: '/app/electron', nodeVersion: '24.18.1' },
        cache: new Map()
      })
    ).resolves.toEqual({ kind: 'electron', path: '/app/electron', version: '24.18.1' })
  })

  it('reports none, naming what it found, without a suitable node or Electron', async () => {
    const old = writeNative(path.join(tmp, 'old', `node${EXE}`))
    const run = versions({ [old]: '20.11.0' })
    const choice = await chooseNode([old], { run, electron: null, cache: new Map() })
    expect(choice.kind).toBe('none')
    expect(choice.kind === 'none' && choice.reason).toBe(
      `pi needs Node 22.19 or newer (${old} is 20.11.0)`
    )
  })

  it('ignores nodes that do not exist', async () => {
    const run = versions({})
    const choice = await chooseNode([path.join(tmp, 'missing', 'node')], {
      run,
      electron: null,
      cache: new Map()
    })
    expect(choice).toEqual({ kind: 'none', reason: 'pi needs Node 22.19 or newer' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('parseNodeVersion', () => {
  it('reads v-prefixed versions and rejects anything else', () => {
    expect(parseNodeVersion('v26.7.0\r\n')).toBe('26.7.0')
    expect(parseNodeVersion('Bun 1.3.0')).toBeNull()
  })
})
