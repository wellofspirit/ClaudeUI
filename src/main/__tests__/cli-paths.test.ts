/**
 * @vitest-environment node
 *
 * `scripts/lib/cli-paths.mjs`: CLAUDEUI_CLI_VENDOR_DIR redirects the whole
 * patch pipeline into another directory.
 *
 * Why this exists: `scripts/check-patches-cross-platform.mjs` patches three
 * platforms' bundles in scratch dirs while the real `vendor/claude-cli` stays
 * untouched. That only holds if EVERY consumer reads the variable — one script
 * that still hard-codes `vendor/claude-cli/cli.js` would silently patch (or
 * wipe) the developer's real build. The per-consumer tests run each script
 * against an empty override dir and check that its complaint names that dir.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mod: any = await import('../../../scripts/lib/cli-paths.mjs')
const {
  cliVendorDir,
  cliJsPath,
  versionJsonPath,
  cliTrashDir,
  CLI_PLATFORM_KEYS,
  cliSourceBinName
} = mod
const { defaultBin }: any = await import('../../../scripts/boot-probe.mjs')

const ROOT = resolve(__dirname, '..', '..', '..')
const saved = process.env.CLAUDEUI_CLI_VENDOR_DIR
const dirs: string[] = []

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDEUI_CLI_VENDOR_DIR
  else process.env.CLAUDEUI_CLI_VENDOR_DIR = saved
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const emptyDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cli-paths-test-'))
  dirs.push(d)
  return d
}

describe('cli-paths', () => {
  it('defaults to vendor/claude-cli with a sibling trash dir', () => {
    delete process.env.CLAUDEUI_CLI_VENDOR_DIR
    expect(cliVendorDir()).toBe(join(ROOT, 'vendor', 'claude-cli'))
    expect(cliJsPath()).toBe(join(ROOT, 'vendor', 'claude-cli', 'cli.js'))
    expect(versionJsonPath()).toBe(join(ROOT, 'vendor', 'claude-cli', 'version.json'))
    expect(cliTrashDir()).toBe(join(ROOT, 'vendor', '.claude-cli-trash'))
  })

  it('treats an empty variable as unset', () => {
    process.env.CLAUDEUI_CLI_VENDOR_DIR = ''
    expect(cliVendorDir()).toBe(join(ROOT, 'vendor', 'claude-cli'))
  })

  it('honours an absolute override, with the trash dir inside it', () => {
    const d = emptyDir()
    process.env.CLAUDEUI_CLI_VENDOR_DIR = d
    expect(cliVendorDir()).toBe(d)
    expect(cliJsPath()).toBe(join(d, 'cli.js'))
    expect(versionJsonPath()).toBe(join(d, 'version.json'))
    expect(cliTrashDir()).toBe(join(d, '.trash'))
  })

  it('rejects a relative override rather than resolving it against some cwd', () => {
    process.env.CLAUDEUI_CLI_VENDOR_DIR = 'scratch/vendor'
    expect(() => cliVendorDir()).toThrow(/absolute/)
  })

  it('knows the six release platforms and their upstream binary names', () => {
    expect([...CLI_PLATFORM_KEYS].sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64'
    ])
    expect(cliSourceBinName('win32-x64')).toBe('claude.exe')
    expect(cliSourceBinName('darwin-arm64')).toBe('claude')
    expect(cliSourceBinName('linux-x64')).toBe('claude')
  })

  it('points the boot probe at the override', () => {
    const d = emptyDir()
    process.env.CLAUDEUI_CLI_VENDOR_DIR = d
    expect(defaultBin('win32')).toBe(join(d, 'bun-claude.exe'))
    expect(defaultBin('linux')).toBe(join(d, 'bun-claude'))
  })
})

describe('every consumer follows the override', () => {
  /** Run `node <script>` with the override set to a fresh empty dir. */
  const run = (script: string, ...args: string[]) => {
    const d = emptyDir()
    const r = spawnSync(process.execPath, [join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, CLAUDEUI_CLI_VENDOR_DIR: d },
      encoding: 'utf8',
      timeout: 60000
    })
    return { dir: d, code: r.status, out: `${r.stdout}\n${r.stderr}` }
  }

  it.each([
    'patch/subagent-streaming/apply.mjs',
    'patch/voice-server/apply.mjs',
    'patch/bash-output-streaming/apply.mjs'
  ])('%s reads cli.js from the override dir', (script) => {
    const r = run(script)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(join(r.dir, 'cli.js'))
  })

  it('apply-all runs its patches against the override dir', () => {
    const r = run('patch/apply-all.mjs', '--quiet')
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(join(r.dir, 'cli.js'))
  })

  it('rebundle-cli pipeline mode reads version.json from the override dir', () => {
    const r = run('scripts/rebundle-cli.mjs', '--quiet')
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(join(r.dir, 'version.json'))
  })

  it.runIf(process.platform !== 'linux')(
    'boot-probe looks for its binary in the override dir',
    () => {
      const r = run('scripts/boot-probe.mjs')
      expect(r.code).toBe(1)
      expect(r.out).toContain(r.dir)
    }
  )
})
