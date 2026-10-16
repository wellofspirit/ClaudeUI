/**
 * @vitest-environment node
 *
 * `scripts/lib/build-targets.mjs`: the stage lists behind `scripts/build.mjs`.
 *
 * Why this exists: `postinstall` used to be one `&&` chain, so a failure in
 * `install-app-deps` (node-pty's `GetCommitHash.bat` is not found when the
 * environment sets NoDefaultCurrentDirectoryInExePath, as agent shells do)
 * silently skipped every ensure after it. These pin the shape that fixed it:
 * the native stage drops that variable and may fail without stopping the
 * ensures, and every ensure-cli run ends in the boot probe.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mod: any = await import('../../../scripts/lib/build-targets.mjs')
const { targets, vendorOverrideRefusal } = mod

const childEnv = {
  PATH: '/bin',
  FORCE_COLOR: '0',
  NoDefaultCurrentDirectoryInExePath: '1',
  // Windows env keys are case-insensitive: any spelling must go.
  nodefaultcurrentdirectoryinexepath: '1'
}
const build = (opts: { quiet?: boolean; platform?: string } = {}) =>
  targets({ quiet: opts.quiet ?? true, childEnv, platform: opts.platform ?? 'win32' })

const memberLabels = (stage: any) => stage.parallel.map((m: any) => m.label)

describe('postinstall', () => {
  it('is electron install, then native deps, then the ensure group', () => {
    const stages = build().postinstall
    expect(stages).toHaveLength(3)
    expect(stages[0].label).toBe('electron install')
    expect(stages[0].keepGoing).toBeUndefined() // a failed Electron download still stops
    expect(stages[1].label).toBe('native deps')
    expect(memberLabels(stages[2])).toEqual([
      'ensure-cli',
      'ensure-opencode',
      'ensure-pi',
      'ensure-codex'
    ])
  })

  it('lets the native stage fail without stopping the ensures', () => {
    expect(build().postinstall[1].keepGoing).toBe(true)
  })

  it('runs install-app-deps without NoDefaultCurrentDirectoryInExePath, in any case', () => {
    const [, args, extra] = build().postinstall[1].steps[0]
    expect(args).toEqual(['electron-builder', 'install-app-deps'])
    const keys = Object.keys(extra.env).map((k) => k.toLowerCase())
    expect(keys).not.toContain('nodefaultcurrentdirectoryinexepath')
    expect(extra.env.PATH).toBe('/bin') // the rest of the env is intact
  })
})

describe('ensure', () => {
  it('is the same four-member parallel group postinstall ends with', () => {
    const t = build()
    expect(t.ensure).toHaveLength(1)
    expect(memberLabels(t.ensure[0])).toEqual([
      'ensure-cli',
      'ensure-opencode',
      'ensure-pi',
      'ensure-codex'
    ])
    expect(t.ensure[0]).toEqual(t.postinstall[2])
  })

  it('does not pass the runner env override to its members (they inherit)', () => {
    for (const m of build().ensure[0].parallel)
      for (const step of m.steps) expect(step[2]).toBeUndefined()
  })
})

describe('ensure-cli', () => {
  const steps = (t: any, name = 'ensure-cli') =>
    t[name][0].steps.map((s: any[]) => `${s[0]} ${s[1].join(' ')}`)

  it('ends with the boot probe, after rebundle', () => {
    const s = steps(build({ quiet: false }))
    expect(s).toHaveLength(4)
    expect(s[2]).toContain('rebundle-cli.mjs')
    expect(s[3]).toBe('node scripts/boot-probe.mjs')
  })

  it('passes --quiet through, and update-cli forces the re-download', () => {
    expect(steps(build())[3]).toBe('node scripts/boot-probe.mjs --quiet')
    expect(steps(build({ quiet: false }), 'update-cli')[0]).toContain('--force')
  })

  it('is warn-only on darwin and nowhere else', () => {
    expect(steps(build({ platform: 'darwin' }))[3]).toContain('--warn-only')
    expect(steps(build({ platform: 'win32' }))[3]).not.toContain('--warn-only')
    expect(steps(build({ platform: 'linux' }))[3]).not.toContain('--warn-only')
  })

  it('is also the last CLI step of every package build', () => {
    const t = build()
    for (const name of ['build', 'build:win', 'build:linux', 'build:unpack', 'build:mac']) {
      const group = t[name][0].parallel.find((m: any) => m.label === 'ensure-cli')
      expect(group.steps.at(-1)[1][0]).toBe('scripts/boot-probe.mjs')
    }
  })
})

describe('the other targets keep their shape', () => {
  it('lists every documented target', () => {
    expect(Object.keys(build()).sort()).toEqual(
      [
        'build',
        'build:linux',
        'build:mac',
        'build:unpack',
        'build:win',
        'ensure',
        'ensure-cli',
        'ensure-codex',
        'ensure-opencode',
        'ensure-pi',
        'postinstall',
        'update-cli',
        'update-codex',
        'update-opencode',
        'update-pi'
      ].sort()
    )
  })

  it('build:mac still overlays CSC_IDENTITY_AUTO_DISCOVERY on the child env', () => {
    const builder = build()['build:mac'][1].steps[0]
    expect(builder[2].env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
    expect(builder[2].env.PATH).toBe('/bin')
  })
})

describe('vendorOverrideRefusal', () => {
  const env = { CLAUDEUI_CLI_VENDOR_DIR: '/scratch/vendor' }

  it.each(['build', 'build:win', 'build:mac', 'build:linux', 'build:unpack'])(
    'refuses %s while the vendor dir is overridden, and says why',
    (target) => {
      const msg = vendorOverrideRefusal(target, env)
      expect(msg).toContain(target)
      expect(msg).toContain('vendor/claude-cli')
      expect(msg).toContain('Unset')
    }
  )

  it.each(['build', 'build:win', 'build:unpack'])('lets %s run without the variable', (target) => {
    expect(vendorOverrideRefusal(target, {})).toBeNull()
    expect(vendorOverrideRefusal(target, { CLAUDEUI_CLI_VENDOR_DIR: '' })).toBeNull()
  })

  it.each([
    'ensure',
    'ensure-cli',
    'update-cli',
    'postinstall',
    'ensure-pi',
    'update-codex',
    'builder-thing'
  ])('does not refuse %s', (target) => {
    expect(vendorOverrideRefusal(target, env)).toBeNull()
  })

  it('build.mjs exits 2 before running any stage', () => {
    const r = spawnSync(
      process.execPath,
      [resolve(__dirname, '../../../scripts/build.mjs'), 'build'],
      {
        env: {
          ...process.env,
          CLAUDEUI_CLI_VENDOR_DIR: join(tmpdir(), 'build-targets-test-never-created')
        },
        encoding: 'utf8',
        timeout: 30000
      }
    )
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('refusing "build"')
    expect(r.stdout).not.toContain('[1/')
  })
})
