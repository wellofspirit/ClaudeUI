/**
 * @vitest-environment node
 *
 * H4: the bridge extension THROWS without CLAUDEUI_PI_BRIDGE_URL/TOKEN (pi-bridge-source.ts), so
 * every launch path that loads it with `-e <bridge>` must set BOTH. This pins that for each path:
 * the three child env builders (host-run subagents, dispatch targets, the plain child runner), the
 * real `defaultSpawnPiChild` (also what dispatch targets use), and a scan that catches a builder
 * or a `-e` launch added later without a credential.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  clientOpts: [] as Array<{ cwd: string; args: string[]; env?: NodeJS.ProcessEnv }>
}))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../pi-locate', () => ({ locatePiLaunch: () => ({ command: 'pi', args: [] }) }))
vi.mock('../PiBridgeHost', () => ({
  PiBridgeHost: class {
    start = async (): Promise<{ url: string; token: string }> => ({
      url: 'http://127.0.0.1:4321',
      token: 'tok-abc'
    })
    dispose = vi.fn()
  },
  writeBridgeExtension: () => '/ext/bridge.mjs'
}))
vi.mock('../PiRpcClient', () => ({
  PiRpcClient: class {
    constructor(_launch: unknown, opts: { cwd: string; args: string[]; env?: NodeJS.ProcessEnv }) {
      h.clientOpts.push(opts)
    }
    start = async (): Promise<void> => {}
    dispose = vi.fn()
  }
}))

import { defaultChildEnv, defaultSpawnPiChild } from '../pi-child-runner'
import { buildPiSubagentChildEnv } from '../pi-subagents'
import { buildPiTargetChildEnv } from '../../services/cross-engine-dispatcher'

const BRIDGE = { url: 'http://127.0.0.1:1', token: 't' }

describe('every pi launch path that loads the bridge extension sets both credentials', () => {
  const builders: Array<[string, () => NodeJS.ProcessEnv]> = [
    ['pi-child-runner defaultChildEnv', () => defaultChildEnv(BRIDGE)],
    [
      'pi-subagents buildPiSubagentChildEnv',
      () => buildPiSubagentChildEnv(BRIDGE, { childCanSpawn: true, listing: 'x', skillDirsEnv: {} })
    ],
    ['cross-engine-dispatcher buildPiTargetChildEnv', () => buildPiTargetChildEnv(BRIDGE)],
    [
      'cross-engine-dispatcher buildPiTargetChildEnv (hand-back, messaging)',
      () => buildPiTargetChildEnv(BRIDGE, true, true)
    ]
  ]

  it.each(builders)('%s', (_name, build) => {
    const env = build()
    expect(env.CLAUDEUI_PI_BRIDGE_URL).toBe(BRIDGE.url)
    expect(env.CLAUDEUI_PI_BRIDGE_TOKEN).toBe(BRIDGE.token)
  })

  describe('defaultSpawnPiChild (host-run subagents and dispatch targets spawn through it)', () => {
    beforeEach(() => {
      h.clientOpts.length = 0
    })
    const base = {
      cwd: '/proj',
      gateHandler: async () => ({ behavior: 'deny' as const, message: 'x' }),
      hostedToolHandler: async () => ({ ok: true as const, text: '' })
    }

    it('loads the bridge with -e and passes the bridge host credentials in the env (default env)', async () => {
      await defaultSpawnPiChild(base as never)
      expect(h.clientOpts).toHaveLength(1)
      const { args, env } = h.clientOpts[0]
      expect(args.slice(0, 4)).toEqual(['--mode', 'rpc', '-e', '/ext/bridge.mjs'])
      expect(env?.CLAUDEUI_PI_BRIDGE_URL).toBe('http://127.0.0.1:4321')
      expect(env?.CLAUDEUI_PI_BRIDGE_TOKEN).toBe('tok-abc')
    })

    it("a consumer's own env builder receives the live bridge and its result is what pi gets", async () => {
      await defaultSpawnPiChild({
        ...base,
        env: (bridge: { url: string; token: string }) => buildPiTargetChildEnv(bridge)
      } as never)
      const env = h.clientOpts[0].env
      expect(env?.CLAUDEUI_PI_BRIDGE_URL).toBe('http://127.0.0.1:4321')
      expect(env?.CLAUDEUI_PI_BRIDGE_TOKEN).toBe('tok-abc')
    })
  })

  it('no source file that launches pi with the bridge extension builds its env without both credentials', () => {
    const root = join(__dirname, '..', '..')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          if (entry !== '__tests__' && entry !== 'node_modules') walk(path)
        } else if (path.endsWith('.ts')) files.push(path)
      }
    }
    walk(root)
    // A launch is a `'-e', <bridge path>` in a spawn's args (`PI_BRIDGE_EXTENSION_SOURCE` itself
    // is excluded: it is the extension, not a launcher).
    const launchers = files
      .filter((file) => /'-e',\s*bridgePath/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).replaceAll('\\', '/'))
      .sort()
    expect(launchers).toEqual(['pi/PiSession.ts', 'pi/pi-child-runner.ts'])
    // ...and each of them (or the env builder it defers to) names both credentials.
    for (const rel of ['pi/PiSession.ts', 'pi/pi-child-runner.ts']) {
      const source = readFileSync(join(root, rel), 'utf8')
      expect(source, rel).toMatch(/CLAUDEUI_PI_BRIDGE_URL:\s*bridge\.url/)
      expect(source, rel).toMatch(/CLAUDEUI_PI_BRIDGE_TOKEN:\s*bridge\.token/)
    }
  })
})
