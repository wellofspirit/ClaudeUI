/**
 * Tests for opencode-config.ts
 *
 * Guards:
 * - Path resolution honours OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > ~/.config
 * - .jsonc > .json > create opencode.json precedence
 * - readOpencodeNativeConfig maps native keys → ClaudeUI shape correctly
 * - writeOpencodeNativeConfig sets present fields, deletes empty ones,
 *   and byte-preserves comments + unrelated keys
 * - computeMigrationPatch: maps private→nativePatch+strippedPriv; non-clobber;
 *   strip keeps autoMode + modelAllowlist
 * - migrateOpencodeConfigToNative: strips private opencodeConfig to undefined when
 *   there is no modelAllowlist (otherwise it re-runs + rewrites on every boot)
 */

// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { EngineConfig } from '../../../shared/types'

// Mock ui-config so the migration's load/save are controllable and we don't drag
// in db.ts / the better-sqlite3 chain. The mock is hoisted; tests configure
// loadEngineConfig per-case and assert on saveEngineConfig.
const loadEngineConfigMock = vi.fn<() => EngineConfig>(() => ({}))
const saveEngineConfigMock = vi.fn<(engineId: string, cfg: EngineConfig) => void>(() => {})
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: (...args: unknown[]) => loadEngineConfigMock(...(args as [])),
  saveEngineConfig: (...args: unknown[]) =>
    saveEngineConfigMock(...(args as [string, EngineConfig]))
}))

import {
  opencodeConfigDir,
  resolveOpencodeConfigFile,
  readOpencodeNativeConfig,
  writeOpencodeNativeConfig,
  computeMigrationPatch,
  migrateOpencodeConfigToNative,
  __resetMigrationGuardForTests
} from '../opencode-config'

// ── Helpers ────────────────────────────────────────────────────────────────────

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
  try {
    fn()
  } finally {
    if (prev === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = prev
    }
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cfg-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── Path resolution ────────────────────────────────────────────────────────────

describe('opencodeConfigDir', () => {
  it('OPENCODE_CONFIG_DIR wins over XDG_CONFIG_HOME', () => {
    withEnv('OPENCODE_CONFIG_DIR', '/custom/opencode', () => {
      withEnv('XDG_CONFIG_HOME', '/xdg', () => {
        expect(opencodeConfigDir()).toBe('/custom/opencode')
      })
    })
  })

  it('XDG_CONFIG_HOME/opencode when OPENCODE_CONFIG_DIR unset', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('XDG_CONFIG_HOME', '/xdg-home', () => {
        expect(opencodeConfigDir()).toBe(path.join('/xdg-home', 'opencode'))
      })
    })
  })

  it('~/.config/opencode as fallback', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('XDG_CONFIG_HOME', undefined, () => {
        const dir = opencodeConfigDir()
        expect(dir).toBe(path.join(os.homedir(), '.config', 'opencode'))
      })
    })
  })
})

describe('resolveOpencodeConfigFile', () => {
  it('returns opencode.json (not existed) when neither file exists', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const { path: p, existed } = resolveOpencodeConfigFile()
      expect(p).toBe(path.join(tmpDir, 'opencode.json'))
      expect(existed).toBe(false)
    })
  })

  it('prefers opencode.json over absent opencode.jsonc', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(path.join(tmpDir, 'opencode.json'), '{}')
      const { path: p, existed } = resolveOpencodeConfigFile()
      expect(p).toBe(path.join(tmpDir, 'opencode.json'))
      expect(existed).toBe(true)
    })
  })

  it('prefers opencode.jsonc over opencode.json when both exist', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(path.join(tmpDir, 'opencode.json'), '{}')
      fs.writeFileSync(path.join(tmpDir, 'opencode.jsonc'), '{}')
      const { path: p, existed } = resolveOpencodeConfigFile()
      expect(p).toBe(path.join(tmpDir, 'opencode.jsonc'))
      expect(existed).toBe(true)
    })
  })

  it('prefers opencode.jsonc even when only it exists', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(path.join(tmpDir, 'opencode.jsonc'), '{}')
      const { path: p, existed } = resolveOpencodeConfigFile()
      expect(p).toBe(path.join(tmpDir, 'opencode.jsonc'))
      expect(existed).toBe(true)
    })
  })
})

// ── readOpencodeNativeConfig ───────────────────────────────────────────────────

describe('readOpencodeNativeConfig', () => {
  it('returns {} when no file exists', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      expect(readOpencodeNativeConfig()).toEqual({})
    })
  })

  it('returns {} when file is unparseable', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(path.join(tmpDir, 'opencode.json'), 'not-json!!!')
      expect(readOpencodeNativeConfig()).toEqual({})
    })
  })

  it('maps model → model', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ model: 'anthropic/claude-sonnet-4-6' })
      )
      const result = readOpencodeNativeConfig()
      expect(result.model).toBe('anthropic/claude-sonnet-4-6')
    })
  })

  it('maps small_model → smallModel', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ small_model: 'anthropic/claude-haiku-3' })
      )
      const result = readOpencodeNativeConfig()
      expect(result.smallModel).toBe('anthropic/claude-haiku-3')
      expect(result).not.toHaveProperty('small_model')
    })
  })

  it('maps disabled_providers → disabledProviders', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ disabled_providers: ['bedrock', 'vertex'] })
      )
      const result = readOpencodeNativeConfig()
      expect(result.disabledProviders).toEqual(['bedrock', 'vertex'])
    })
  })

  it('maps enabled_providers → enabledProviders', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ enabled_providers: ['anthropic', 'openai'] })
      )
      const result = readOpencodeNativeConfig()
      expect(result.enabledProviders).toEqual(['anthropic', 'openai'])
    })
  })

  it('maps native provider object → ClaudeUI providers array shape', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({
          provider: {
            'my-ollama': {
              name: 'My Ollama',
              options: { baseURL: 'http://localhost:11434/v1' },
              models: {
                'llama3.2': { name: 'Llama 3.2' },
                'mistral-7b': {}
              }
            }
          }
        })
      )
      const result = readOpencodeNativeConfig()
      expect(result.providers?.['my-ollama']).toMatchObject({
        name: 'My Ollama',
        baseURL: 'http://localhost:11434/v1'
      })
      const models = result.providers?.['my-ollama'].models ?? []
      const llama = models.find((m) => m.id === 'llama3.2')
      expect(llama?.name).toBe('Llama 3.2')
      const mistral = models.find((m) => m.id === 'mistral-7b')
      expect(mistral?.id).toBe('mistral-7b')
    })
  })

  it('maps agent object → agents shape', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({
          agent: {
            build: { model: 'anthropic/claude-haiku-3', temperature: 0.5 },
            plan: { model: 'anthropic/claude-opus-4-8' }
          }
        })
      )
      const result = readOpencodeNativeConfig()
      expect(result.agents?.build).toMatchObject({
        model: 'anthropic/claude-haiku-3',
        temperature: 0.5
      })
      expect(result.agents?.plan?.model).toBe('anthropic/claude-opus-4-8')
    })
  })

  it('tolerates comments in .jsonc files (parsed OK)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.jsonc'),
        '// top comment\n{\n  // inline comment\n  "model": "anthropic/claude-sonnet-4-6"\n}'
      )
      const result = readOpencodeNativeConfig()
      expect(result.model).toBe('anthropic/claude-sonnet-4-6')
    })
  })
})

// ── writeOpencodeNativeConfig ──────────────────────────────────────────────────

describe('writeOpencodeNativeConfig', () => {
  it('creates opencode.json in the dir with the managed fields', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      writeOpencodeNativeConfig({ model: 'anthropic/claude-sonnet-4-6' })
      const filePath = path.join(tmpDir, 'opencode.json')
      expect(fs.existsSync(filePath)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      expect(parsed.model).toBe('anthropic/claude-sonnet-4-6')
    })
  })

  it('sets model, small_model, disabled_providers, enabled_providers', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      writeOpencodeNativeConfig({
        model: 'anthropic/claude-sonnet-4-6',
        smallModel: 'anthropic/claude-haiku-3',
        disabledProviders: ['bedrock'],
        enabledProviders: ['anthropic', 'openai']
      })
      const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'opencode.json'), 'utf8'))
      expect(parsed.model).toBe('anthropic/claude-sonnet-4-6')
      expect(parsed.small_model).toBe('anthropic/claude-haiku-3')
      expect(parsed.disabled_providers).toEqual(['bedrock'])
      expect(parsed.enabled_providers).toEqual(['anthropic', 'openai'])
    })
  })

  it('deletes a managed key when value is emptied', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      // First set it
      writeOpencodeNativeConfig({ model: 'anthropic/claude-sonnet-4-6' })
      // Then clear it
      writeOpencodeNativeConfig({ model: undefined })
      const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'opencode.json'), 'utf8'))
      expect(parsed).not.toHaveProperty('model')
    })
  })

  it('deletes managed key for empty array (disabledProviders: [])', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      writeOpencodeNativeConfig({ disabledProviders: ['bedrock'] })
      writeOpencodeNativeConfig({ disabledProviders: [] })
      const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'opencode.json'), 'utf8'))
      expect(parsed).not.toHaveProperty('disabled_providers')
    })
  })

  it('preserves comments, theme key, and mcp block when editing model', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const filePath = path.join(tmpDir, 'opencode.jsonc')
      // Seed a realistic .jsonc with a comment, a theme key, and an mcp block.
      const original = [
        '// my opencode config',
        '{',
        '  "theme": "dark",',
        '  "mcp": {',
        '    "myserver": { "type": "stdio", "command": "my-mcp" }',
        '  }',
        '}'
      ].join('\n')
      fs.writeFileSync(filePath, original)

      writeOpencodeNativeConfig({ model: 'anthropic/claude-sonnet-4-6' })

      const written = fs.readFileSync(filePath, 'utf8')
      // Comment must survive
      expect(written).toContain('// my opencode config')
      // theme must survive
      expect(written).toContain('"theme"')
      // mcp block must survive
      expect(written).toContain('"mcp"')
      expect(written).toContain('"myserver"')
      // model must be set
      const parsed = JSON.parse(
        written.replace(/\/\/.*/g, '') // strip line comments for JSON.parse
      )
      expect(parsed.model).toBe('anthropic/claude-sonnet-4-6')
      expect(parsed.theme).toBe('dark')
    })
  })

  it('writes provider in native opencode shape (Record not array)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      writeOpencodeNativeConfig({
        providers: {
          'my-ollama': {
            name: 'My Ollama',
            baseURL: 'http://localhost:11434/v1',
            models: [{ id: 'llama3.2', name: 'Llama 3.2' }, { id: 'mistral-7b' }]
          }
        }
      })
      const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'opencode.json'), 'utf8'))
      const entry = parsed.provider?.['my-ollama']
      expect(entry).toBeDefined()
      expect(entry.name).toBe('My Ollama')
      expect(entry.options?.baseURL).toBe('http://localhost:11434/v1')
      // models must be a Record (object), not an array
      expect(Array.isArray(entry.models)).toBe(false)
      expect(entry.models?.['llama3.2']).toMatchObject({ name: 'Llama 3.2' })
      expect(entry.models?.['mistral-7b']).toEqual({})
    })
  })

  it('writes to the existing .jsonc file, not creating a new .json', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      // Only .jsonc exists
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc')
      fs.writeFileSync(jsoncPath, '{}')

      writeOpencodeNativeConfig({ model: 'anthropic/claude-sonnet-4-6' })

      // .jsonc was updated
      expect(fs.existsSync(jsoncPath)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(jsoncPath, 'utf8'))
      expect(parsed.model).toBe('anthropic/claude-sonnet-4-6')
      // No new .json created alongside
      expect(fs.existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false)
    })
  })
})

// ── computeMigrationPatch ──────────────────────────────────────────────────────

describe('computeMigrationPatch', () => {
  it('migrates all six fields from private to native when native is empty', () => {
    const { nativePatch } = computeMigrationPatch(
      {
        opencodeConfig: {
          model: 'anthropic/claude-sonnet-4-6',
          smallModel: 'anthropic/claude-haiku-3',
          disabledProviders: ['bedrock'],
          enabledProviders: ['anthropic'],
          providers: { 'my-ollama': { baseURL: 'http://localhost:11434/v1' } },
          agents: { build: { model: 'anthropic/claude-haiku-3' } }
        }
      },
      {} // no existing native
    )
    expect(nativePatch.model).toBe('anthropic/claude-sonnet-4-6')
    expect(nativePatch.smallModel).toBe('anthropic/claude-haiku-3')
    expect(nativePatch.disabledProviders).toEqual(['bedrock'])
    expect(nativePatch.enabledProviders).toEqual(['anthropic'])
    expect(nativePatch.providers?.['my-ollama']?.baseURL).toBe('http://localhost:11434/v1')
    expect(nativePatch.agents?.build?.model).toBe('anthropic/claude-haiku-3')
  })

  it('non-clobber: does NOT overwrite a native key already set', () => {
    const { nativePatch } = computeMigrationPatch(
      { opencodeConfig: { model: 'anthropic/claude-sonnet-4-6' } },
      { model: 'opencode/mimo-v2.5-free' } // already set in native
    )
    // native value wins (not overwritten)
    expect(nativePatch.model).toBe('opencode/mimo-v2.5-free')
  })

  it('strippedPriv keeps modelAllowlist, removes the six native fields', () => {
    // autoMode is at the EngineConfig level (not inside opencodeConfig) — preserved
    // by the migration caller via `{ ...engCfg, opencodeConfig: strippedPriv.opencodeConfig }`.
    const { strippedPriv } = computeMigrationPatch(
      {
        opencodeConfig: {
          model: 'anthropic/claude-sonnet-4-6',
          modelAllowlist: { openrouter: ['gpt-x'] }
        }
      },
      {}
    )
    // model must be removed from opencodeConfig
    expect(strippedPriv.opencodeConfig).not.toHaveProperty('model')
    // modelAllowlist must survive in opencodeConfig
    expect(strippedPriv.opencodeConfig?.modelAllowlist).toEqual({ openrouter: ['gpt-x'] })
  })

  it('strippedPriv: opencodeConfig is undefined when only native fields were present', () => {
    const { strippedPriv } = computeMigrationPatch(
      { opencodeConfig: { model: 'anthropic/claude-sonnet-4-6' } },
      {}
    )
    expect(strippedPriv.opencodeConfig).toBeUndefined()
  })

  it('with nothing to migrate, nativePatch equals existingNative', () => {
    const existingNative = { model: 'opencode/mimo-v2.5-free' }
    const { nativePatch } = computeMigrationPatch({ opencodeConfig: {} }, existingNative)
    expect(nativePatch.model).toBe('opencode/mimo-v2.5-free')
  })
})

// ── migrateOpencodeConfigToNative ───────────────────────────────────────────────

describe('migrateOpencodeConfigToNative', () => {
  beforeEach(() => {
    __resetMigrationGuardForTests()
    loadEngineConfigMock.mockReset()
    saveEngineConfigMock.mockReset()
  })

  it('strips the private opencodeConfig to undefined when there is no modelAllowlist', () => {
    // This is the regression guard: with no modelAllowlist, the private file must
    // end up with opencodeConfig: undefined — otherwise the six fields linger and
    // the migration re-runs (rewriting the user's config) on every boot.
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      loadEngineConfigMock.mockReturnValue({
        autoMode: { enabled: true },
        opencodeConfig: { model: 'anthropic/claude-sonnet-4-6' }
      } as EngineConfig)

      migrateOpencodeConfigToNative()

      expect(saveEngineConfigMock).toHaveBeenCalledTimes(1)
      const [engineId, savedCfg] = saveEngineConfigMock.mock.calls[0]
      expect(engineId).toBe('opencode')
      // The six native fields are gone (opencodeConfig undefined)…
      expect(savedCfg.opencodeConfig).toBeUndefined()
      // …while EngineConfig-level siblings (autoMode) are preserved.
      expect(savedCfg.autoMode).toMatchObject({ enabled: true })

      // And the native file was written with the migrated model.
      const native = readOpencodeNativeConfig()
      expect(native.model).toBe('anthropic/claude-sonnet-4-6')
    })
  })

  it('keeps modelAllowlist in the private opencodeConfig after migration', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      loadEngineConfigMock.mockReturnValue({
        opencodeConfig: {
          model: 'anthropic/claude-sonnet-4-6',
          modelAllowlist: { openrouter: ['gpt-x'] }
        }
      } as EngineConfig)

      migrateOpencodeConfigToNative()

      const [, savedCfg] = saveEngineConfigMock.mock.calls[0]
      expect(savedCfg.opencodeConfig?.modelAllowlist).toEqual({ openrouter: ['gpt-x'] })
      expect(savedCfg.opencodeConfig).not.toHaveProperty('model')
    })
  })

  it('does nothing (no save, no native file) when there is nothing to migrate', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      loadEngineConfigMock.mockReturnValue({
        opencodeConfig: { modelAllowlist: { openrouter: ['gpt-x'] } }
      } as EngineConfig)

      migrateOpencodeConfigToNative()

      expect(saveEngineConfigMock).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false)
    })
  })
})
