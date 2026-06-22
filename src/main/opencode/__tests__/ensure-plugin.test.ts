/**
 * @vitest-environment node
 *
 * Unit tests for ensureOpencodePlugin (Phase 5c — Part B).
 *
 * Verifies the version-stamped, idempotent install into a fake
 * ~/.config/opencode/plugin dir, with `app.getAppPath()` + `os.homedir()` mocked
 * so the test never touches the real filesystem locations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mocks (hoisted): electron.app.getAppPath + os.homedir are driven by mutable refs
// ---------------------------------------------------------------------------

const { appPathRef, homeRef } = vi.hoisted(() => ({
  appPathRef: { value: '' },
  homeRef: { value: '' }
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => appPathRef.value }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => homeRef.value }
})

vi.mock('../../services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import {
  ensureOpencodePlugin,
  opencodePluginDir,
  locatePluginSource,
  _resetEnsureOpencodePluginForTests
} from '../ensure-plugin'

// ---------------------------------------------------------------------------
// Setup: a fake "project root" with a plugin source, + a fake HOME
// ---------------------------------------------------------------------------

let projectRoot: string
let home: string
const SOURCE_REL = ['src', 'main', 'opencode', 'plugin', 'claudeui.plugin.js']

async function writePluginSource(version: string): Promise<void> {
  const dir = join(projectRoot, 'src', 'main', 'opencode', 'plugin')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'claudeui.plugin.js'),
    `export const CLAUDEUI_PLUGIN_VERSION = '${version}'\nexport default async () => ({ tool: {} })\n`,
    'utf-8'
  )
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'claudeui-approot-'))
  home = await mkdtemp(join(tmpdir(), 'claudeui-home-'))
  appPathRef.value = projectRoot
  homeRef.value = home
  _resetEnsureOpencodePluginForTests()
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
  _resetEnsureOpencodePluginForTests()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('locatePluginSource', () => {
  it('resolves the dev path under the project root', () => {
    expect(locatePluginSource()).toBe(join(projectRoot, ...SOURCE_REL))
  })
})

describe('opencodePluginDir', () => {
  it('points at <home>/.config/opencode/plugin', () => {
    expect(opencodePluginDir()).toBe(join(home, '.config', 'opencode', 'plugin'))
  })
})

describe('ensureOpencodePlugin', () => {
  it('copies the plugin + writes the version sidecar on first run', async () => {
    await writePluginSource('1.0.0')
    await ensureOpencodePlugin()

    const dest = join(opencodePluginDir(), 'claudeui.plugin.js')
    const versionFile = join(opencodePluginDir(), '.claudeui.plugin.version')
    expect(existsSync(dest)).toBe(true)
    expect(existsSync(versionFile)).toBe(true)
    expect((await readFile(versionFile, 'utf-8')).trim()).toBe('1.0.0')
    expect(await readFile(dest, 'utf-8')).toContain("CLAUDEUI_PLUGIN_VERSION = '1.0.0'")
  })

  it('is idempotent — does not rewrite when version matches', async () => {
    await writePluginSource('1.0.0')
    await ensureOpencodePlugin()

    const dest = join(opencodePluginDir(), 'claudeui.plugin.js')
    const mtime1 = (await stat(dest)).mtimeMs

    // Reset memoization so it actually re-runs the install logic
    _resetEnsureOpencodePluginForTests()
    await new Promise((r) => setTimeout(r, 10))
    await ensureOpencodePlugin()
    const mtime2 = (await stat(dest)).mtimeMs

    // Same version → skip copy → mtime unchanged
    expect(mtime2).toBe(mtime1)
  })

  it('re-stamps when the bundled version changes', async () => {
    await writePluginSource('1.0.0')
    await ensureOpencodePlugin()
    const versionFile = join(opencodePluginDir(), '.claudeui.plugin.version')
    expect((await readFile(versionFile, 'utf-8')).trim()).toBe('1.0.0')

    // Bump the bundled source + reset memoization
    await writePluginSource('1.1.0')
    _resetEnsureOpencodePluginForTests()
    await ensureOpencodePlugin()

    const dest = join(opencodePluginDir(), 'claudeui.plugin.js')
    expect((await readFile(versionFile, 'utf-8')).trim()).toBe('1.1.0')
    expect(await readFile(dest, 'utf-8')).toContain("CLAUDEUI_PLUGIN_VERSION = '1.1.0'")
  })

  it('overwrites a foreign installed copy when the version sidecar is missing', async () => {
    // Pre-existing plugin file but NO version sidecar (e.g. older install)
    const dir = opencodePluginDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'claudeui.plugin.js'), '// stale', 'utf-8')

    await writePluginSource('2.0.0')
    await ensureOpencodePlugin()

    const dest = join(dir, 'claudeui.plugin.js')
    expect(await readFile(dest, 'utf-8')).toContain("CLAUDEUI_PLUGIN_VERSION = '2.0.0'")
  })

  it('does not throw when the source is missing (opencode optional)', async () => {
    // No plugin source written → install should be a no-op, not a throw
    await expect(ensureOpencodePlugin()).resolves.toBeUndefined()
    expect(existsSync(join(opencodePluginDir(), 'claudeui.plugin.js'))).toBe(false)
  })

  it('memoizes — concurrent calls install once', async () => {
    await writePluginSource('1.0.0')
    const [a, b, c] = await Promise.all([
      ensureOpencodePlugin(),
      ensureOpencodePlugin(),
      ensureOpencodePlugin()
    ])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(c).toBeUndefined()
    expect(existsSync(join(opencodePluginDir(), 'claudeui.plugin.js'))).toBe(true)
  })
})
