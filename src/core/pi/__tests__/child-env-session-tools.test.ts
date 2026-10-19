/**
 * @vitest-environment node
 *
 * The session tools are for a session's root agent only (slice 2). A pi child (a host-run
 * subagent, a dispatch target, a plain child runner) is spawned with `{...process.env,
 * ...opts.env}`, so each env builder must set `CLAUDEUI_PI_SESSION_TOOLS` to `''`
 * explicitly: omission would let a parent's value through. One table over every builder, and
 * a scan that catches a builder added later.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { defaultChildEnv } from '../pi-child-runner'
import { buildPiSubagentChildEnv } from '../pi-subagents'
import { buildPiTargetChildEnv } from '../../services/cross-engine-dispatcher'

const BRIDGE = { url: 'http://127.0.0.1:1', token: 't' }

describe('every pi child env zeroes CLAUDEUI_PI_SESSION_TOOLS', () => {
  const builders: Array<[string, () => NodeJS.ProcessEnv]> = [
    ['pi-child-runner defaultChildEnv', () => defaultChildEnv(BRIDGE)],
    [
      'pi-subagents buildPiSubagentChildEnv (may spawn)',
      () => buildPiSubagentChildEnv(BRIDGE, { childCanSpawn: true, listing: 'x', skillDirsEnv: {} })
    ],
    [
      'pi-subagents buildPiSubagentChildEnv (may not spawn)',
      () =>
        buildPiSubagentChildEnv(BRIDGE, { childCanSpawn: false, listing: 'x', skillDirsEnv: {} })
    ],
    ['cross-engine-dispatcher buildPiTargetChildEnv', () => buildPiTargetChildEnv(BRIDGE)]
  ]

  it.each(builders)('%s', (_name, build) => {
    const env = build()
    // Explicitly '' (present), not absent: absence lets the parent process's value through.
    expect(env).toHaveProperty('CLAUDEUI_PI_SESSION_TOOLS', '')
    // …which survives the spawn's own merge order.
    const merged = { ...{ CLAUDEUI_PI_SESSION_TOOLS: '[{"name":"session_start"}]' }, ...env }
    expect(merged.CLAUDEUI_PI_SESSION_TOOLS).toBe('')
  })

  it('no source file builds a child env (one that zeroes the hosted-tools gate) without zeroing this one', () => {
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
    const builders = files.filter((file) =>
      /CLAUDEUI_PI_HOSTED_TOOLS:\s*''/.test(readFileSync(file, 'utf8'))
    )
    // The three known sites (guards against the scan matching nothing).
    expect(builders.map((file) => relative(root, file).replaceAll('\\', '/')).sort()).toEqual([
      'pi/pi-child-runner.ts',
      'pi/pi-subagents.ts',
      'services/cross-engine-dispatcher.ts'
    ])
    for (const file of builders)
      expect(readFileSync(file, 'utf8'), relative(root, file)).toMatch(
        /CLAUDEUI_PI_SESSION_TOOLS:\s*''/
      )
  })
})
