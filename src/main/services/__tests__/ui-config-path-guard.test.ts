/**
 * @vitest-environment node
 *
 * S1b review F1 — the SERVICE-LAYER half of the engine/vendor path guard.
 *
 * `ipc/config-commands.ts` validates `engineId` / `vendorId` at the registration
 * perimeter, and `remote-handlers.ipc.test.ts` drives that half over the real
 * remote transport. This file bypasses the perimeter entirely and calls the
 * service directly, because the belt must hold on its own: `loadEngineConfig` /
 * `saveEngineConfig` have ~15 in-tree callers, and the next one to pass a
 * caller-supplied id must not be able to re-open the hole.
 *
 * The escalation being closed, concretely: `engineId: '../../settings'` resolves
 * `~/.claude/ui/engines/../../settings.json` → `~/.claude/settings.json`, which is
 * Claude Code's own hooks and permissions file. Hooks execute with no approval
 * gate, so an arbitrary write there is host code execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const home = vi.hoisted(() => ({ dir: '' }))

// ui-config derives every path from `os.homedir()` at module load, so the temp
// home has to be installed before the import.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, default: actual, homedir: () => home.dir }
})

vi.mock('../sync-host', () => ({ emitEvent: vi.fn(), syncCore: {} }))
vi.mock('../db', () => ({
  allSessionMeta: vi.fn(() => []),
  setSessionMeta: vi.fn(),
  deleteSessionMeta: vi.fn(),
  importSessionEnginesOnce: vi.fn()
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

let uiConfig: typeof import('../ui-config')

beforeEach(async () => {
  home.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-config-guard-'))
  vi.resetModules()
  uiConfig = await import('../ui-config')
})

afterEach(() => {
  fs.rmSync(home.dir, { recursive: true, force: true })
})

/** Every shape that must never reach a `path.join`. */
const ESCAPES = [
  '../../settings',
  '../../../.claude/settings',
  '..',
  '.',
  'a/b',
  'a\\b',
  // Windows drive-relative: no separator, no `..`, and still not a segment —
  // the reason the id guard is stricter than `assertSafePathSegment`.
  'C:evil',
  // A dot-leading name is a dotfile, not an id.
  '.bashrc',
  ''
]

describe('engine/vendor config path guard (F1 backstop)', () => {
  it('refuses a traversal engineId on save, and writes nothing', () => {
    const settingsFile = path.join(home.dir, '.claude', 'settings.json')
    for (const bad of ESCAPES) {
      expect(() => uiConfig.saveEngineConfig(bad, { proxy: { enabled: true } } as never)).toThrow(
        /Invalid engineId/
      )
    }
    // The escalation target specifically: Claude Code's hooks/permissions file.
    expect(fs.existsSync(settingsFile)).toBe(false)
  })

  it('refuses a traversal engineId on load', () => {
    for (const bad of ESCAPES) {
      expect(() => uiConfig.loadEngineConfig(bad)).toThrow(/Invalid engineId/)
    }
  })

  it('refuses a traversal vendorId on save and load, and writes nothing', () => {
    for (const bad of ESCAPES) {
      expect(() => uiConfig.saveVendorConfig(bad, {} as never)).toThrow(/Invalid vendorId/)
      expect(() => uiConfig.loadVendorConfig(bad)).toThrow(/Invalid vendorId/)
    }
    expect(fs.existsSync(path.join(home.dir, '.claude', 'settings.json'))).toBe(false)
  })

  it('still round-trips every REAL id vocabulary', () => {
    // Checked against the actual vocabularies rather than a guess: `EngineId` is
    // the three-member union, and vendor ids are engine provider ids (the
    // `VendorId` type is deliberately open — `'anthropic' | … | (string & {})`).
    for (const engineId of ['claude', 'opencode', 'pi']) {
      uiConfig.saveEngineConfig(engineId, { dispatch: { defaultModel: engineId } } as never)
      expect(uiConfig.loadEngineConfig(engineId)).toEqual({
        dispatch: { defaultModel: engineId }
      })
      expect(
        fs.existsSync(path.join(home.dir, '.claude', 'ui', 'engines', `${engineId}.json`))
      ).toBe(true)
    }
    for (const vendorId of [
      'anthropic',
      'openai',
      'google',
      'local',
      'openai-codex',
      'github-copilot',
      'amazon-bedrock',
      'zen',
      'opencode'
    ]) {
      uiConfig.saveVendorConfig(vendorId, { endpoint: { enabled: false } } as never)
      expect(
        fs.existsSync(path.join(home.dir, '.claude', 'ui', 'vendors', `${vendorId}.json`))
      ).toBe(true)
    }
  })

  it('an unknown-but-well-formed id still reads as empty rather than throwing', () => {
    // The guard must not turn "no config yet" into an error: a fresh install
    // loads `engines/claude.json` before anything has written it.
    expect(uiConfig.loadEngineConfig('claude')).toEqual({})
    expect(uiConfig.loadVendorConfig('some-new-provider')).toEqual({})
  })
})
