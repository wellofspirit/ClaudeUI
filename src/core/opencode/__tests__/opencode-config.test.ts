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
import { parse as jsoncParse } from 'jsonc-parser'
import type { EngineConfig } from '../../../shared/types'
import { agentsOverridingSwitch, configAgentRules } from '../../../shared/opencode-config-v1'

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
  readDeclaredProviderIds,
  writeOpencodeNativeConfig,
  computeMigrationPatch,
  migrateOpencodeConfigToNative,
  onOpencodeConfigWritten,
  setOpencodeToolDisabled,
  toolDisabledIn,
  __resetMigrationGuardForTests
} from '../opencode-config'

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Windows only grants file symlinks with Developer Mode or SeCreateSymbolicLink
 * (`EPERM` otherwise). Probe once so the symlink case is skipped honestly.
 */
const CAN_SYMLINK_FILE = ((): boolean => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cfg-symlink-probe-'))
  try {
    const target = path.join(probeDir, 'target.json')
    fs.writeFileSync(target, '{}')
    fs.symlinkSync(target, path.join(probeDir, 'link.json'), 'file')
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
  }
})()

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
  it('reads a 2.x file: explicit model selection, agents.title, policies, providers, agents', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({
          model: { providerID: 'anthropic', model: 'claude', variant: 'high' },
          agents: {
            title: { model: 'a/small' },
            build: { model: 'x/y', request: { body: { temperature: 0.4 } } }
          },
          experimental: {
            policies: [{ action: 'provider.use', resource: 'groq', effect: 'deny' }]
          },
          providers: {
            p: {
              name: 'P',
              package: '@opencode/ai/providers/openai-compatible',
              settings: { baseURL: 'http://p/v1' },
              models: { m: { capabilities: { tools: false, input: ['text'] }, variants: [] } }
            }
          }
        })
      )
      expect(readOpencodeNativeConfig()).toEqual({
        model: 'anthropic/claude#high',
        smallModel: 'a/small',
        disabledProviders: ['groq'],
        providers: {
          p: {
            name: 'P',
            npm: '@opencode/ai/providers/openai-compatible',
            baseURL: 'http://p/v1',
            models: [
              {
                id: 'm',
                reasoning: false,
                attachment: false,
                toolCall: false,
                inputModalities: ['text']
              }
            ]
          }
        },
        agents: { build: { model: 'x/y', temperature: 0.4 } }
      })
    })
  })

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

// ── readDeclaredProviderIds ────────────────────────────────────────────────────
//
// opencode MERGES both global config files at load (verified via GET /config),
// while resolveOpencodeConfigFile picks ONE write target (jsonc-first). The
// declared-custom-provider guard must therefore union `provider` keys from BOTH
// files — a split layout (jsonc holding disabled_providers, json holding the
// provider map) previously read as "no declared providers".

describe('readDeclaredProviderIds', () => {
  it('reads the 2.x providers key and the 1.x provider key alike', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ provider: { old: {} }, providers: { neu: {} } })
      )
      expect(readDeclaredProviderIds().sort()).toEqual(['neu', 'old'])
    })
  })

  it('unions provider ids across a split layout (jsonc: disabled only; json: provider map)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.jsonc'),
        '{\n  // ClaudeUI-managed\n  "disabled_providers": ["openai"]\n}'
      )
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({
          provider: {
            llamacpp: { options: { baseURL: 'http://localhost:8080/v1' } },
            mtplx: { name: 'MTPLX' }
          }
        })
      )
      expect(readDeclaredProviderIds().sort()).toEqual(['llamacpp', 'mtplx'])
      // Sanity: the single-file reader (jsonc precedence) sees NO providers here —
      // that's exactly the gap the union helper closes.
      expect(readOpencodeNativeConfig().providers).toBeUndefined()
    })
  })

  it('returns provider ids from a jsonc-only layout', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.jsonc'),
        '{\n  // custom local provider\n  "provider": { "llamacpp": {} }\n}'
      )
      expect(readDeclaredProviderIds()).toEqual(['llamacpp'])
    })
  })

  it('returns [] when neither file exists', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      expect(readDeclaredProviderIds()).toEqual([])
    })
  })

  it('tolerates a malformed file — the other file ids are still returned', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(path.join(tmpDir, 'opencode.json'), '%%% not json at all')
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.jsonc'),
        '{ "provider": { "mtplx": { "name": "MTPLX" } } }'
      )
      expect(readDeclaredProviderIds()).toEqual(['mtplx'])
    })
  })
})

// ── writeOpencodeNativeConfig ──────────────────────────────────────────────────

describe('writeOpencodeNativeConfig (opencode 2.x keys, ADR-097 S8)', () => {
  const read = (name = 'opencode.json'): Record<string, any> =>
    jsoncParse(fs.readFileSync(path.join(tmpDir, name), 'utf8'))

  it('creates opencode.json in the dir with the managed fields', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      writeOpencodeNativeConfig({ model: 'anthropic/claude-sonnet-4-6' })
      expect(read().model).toBe('anthropic/claude-sonnet-4-6')
    })
  })

  it('writes small model, disabled and enabled providers as 2.x keys, never the 1.x ones', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      writeOpencodeNativeConfig({
        model: 'anthropic/claude-sonnet-4-6',
        smallModel: 'anthropic/claude-haiku-3',
        disabledProviders: ['bedrock'],
        enabledProviders: ['anthropic', 'openai']
      })
      const parsed = read()
      expect(parsed.agents).toEqual({ title: { model: 'anthropic/claude-haiku-3' } })
      expect(parsed.experimental.policies).toEqual([
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: 'anthropic', effect: 'allow' },
        { action: 'provider.use', resource: 'openai', effect: 'allow' },
        { action: 'provider.use', resource: 'bedrock', effect: 'deny' }
      ])
      for (const legacy of ['small_model', 'disabled_providers', 'enabled_providers'])
        expect(parsed).not.toHaveProperty(legacy)
      expect(readOpencodeNativeConfig()).toEqual({
        model: 'anthropic/claude-sonnet-4-6',
        smallModel: 'anthropic/claude-haiku-3',
        disabledProviders: ['bedrock'],
        enabledProviders: ['anthropic', 'openai']
      })
    })
  })

  it('deletes a managed key when value is emptied', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      writeOpencodeNativeConfig({ model: 'anthropic/claude-sonnet-4-6', smallModel: 'a/b' })
      writeOpencodeNativeConfig({ model: undefined })
      expect(read()).not.toHaveProperty('model')
      expect(read()).not.toHaveProperty('agents')
    })
  })

  it('re-enabling a provider removes its deny; emptying the list removes the policies', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      writeOpencodeNativeConfig({ disabledProviders: ['bedrock', 'groq'] })
      writeOpencodeNativeConfig({ disabledProviders: ['groq'] })
      expect(read().experimental.policies).toEqual([
        { action: 'provider.use', resource: 'groq', effect: 'deny' }
      ])
      writeOpencodeNativeConfig({ disabledProviders: [] })
      expect(read().experimental).toEqual({})
    })
  })

  it('moves the 1.x disabled/enabled lists into policies in 2.x order, keeping other policies', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({
          disabled_providers: ['groq'],
          experimental: {
            subagent_depth: 2,
            policies: [{ action: 'permission', resource: 'shell:rm *', effect: 'deny' }]
          }
        })
      )
      expect(readOpencodeNativeConfig().disabledProviders).toEqual(['groq'])
      writeOpencodeNativeConfig({ disabledProviders: ['groq', 'xai'] })
      const parsed = read()
      expect(parsed).not.toHaveProperty('disabled_providers')
      expect(parsed.experimental).toEqual({
        subagent_depth: 2,
        policies: [
          { action: 'provider.use', resource: 'groq', effect: 'deny' },
          { action: 'permission', resource: 'shell:rm *', effect: 'deny' },
          { action: 'provider.use', resource: 'xai', effect: 'deny' }
        ]
      })
    })
  })

  it('re-enabling an id a wildcard still denies adds a literal allow after it', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({
          experimental: {
            policies: [{ action: 'provider.use', resource: 'open*', effect: 'deny' }]
          },
          disabled_providers: ['openai']
        })
      )
      expect(readOpencodeNativeConfig().disabledProviders).toEqual(['openai'])
      writeOpencodeNativeConfig({ disabledProviders: [] })
      expect(read().experimental.policies).toEqual([
        { action: 'provider.use', resource: 'open*', effect: 'deny' },
        { action: 'provider.use', resource: 'openai', effect: 'allow' }
      ])
      expect(readOpencodeNativeConfig().disabledProviders).toBeUndefined()
    })
  })

  it('writes a new provider in the 2.x shape (package, settings.baseURL, capabilities, variants)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      writeOpencodeNativeConfig({
        providers: {
          'my-ollama': {
            name: 'My Ollama',
            baseURL: 'http://localhost:11434/v1',
            npm: '@ai-sdk/openai-compatible',
            models: [
              { id: 'llama3.2', name: 'Llama 3.2', reasoning: false, attachment: false },
              { id: 'qwen', reasoning: true, attachment: true, toolCall: true },
              { id: 'mistral-7b' }
            ]
          }
        }
      })
      const parsed = read()
      expect(parsed).not.toHaveProperty('provider')
      expect(parsed.providers['my-ollama']).toEqual({
        name: 'My Ollama',
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'http://localhost:11434/v1' },
        models: {
          'llama3.2': { name: 'Llama 3.2', capabilities: { input: ['text'] }, variants: [] },
          qwen: { capabilities: { tools: true, input: ['text', 'image'] } },
          'mistral-7b': {}
        }
      })
      expect(readOpencodeNativeConfig().providers?.['my-ollama']).toEqual({
        name: 'My Ollama',
        npm: '@ai-sdk/openai-compatible',
        baseURL: 'http://localhost:11434/v1',
        models: [
          {
            id: 'llama3.2',
            name: 'Llama 3.2',
            reasoning: false,
            attachment: false,
            inputModalities: ['text']
          },
          { id: 'qwen', attachment: true, toolCall: true, inputModalities: ['text', 'image'] },
          { id: 'mistral-7b' }
        ]
      })
    })
  })

  it('writes to the existing .jsonc file, not creating a new .json', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc')
      fs.writeFileSync(jsoncPath, '{}')
      writeOpencodeNativeConfig({ model: 'anthropic/claude-sonnet-4-6' })
      expect(read('opencode.jsonc').model).toBe('anthropic/claude-sonnet-4-6')
      expect(fs.existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false)
    })
  })
})

// ── writeOpencodeNativeConfig: diff-driven leaf-merge (ADR-031) ─────────────────
//
// The writer must touch ONLY the keys it models AND that actually changed, and
// must NEVER delete keys it does not model (settings.apiKey/headers/cost/…).

describe('writeOpencodeNativeConfig — diff-driven leaf merge', () => {
  function seed(content: string): string {
    const p = path.join(tmpDir, 'opencode.jsonc')
    fs.writeFileSync(p, content)
    return p
  }

  it('preserves comments, unknown keys and unmodelled leaves across a display-name rename', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(
        [
          '// keep me',
          '{',
          '  "theme": "dark",',
          '  "providers": {',
          '    // provider-level comment',
          '    "myprov": {',
          '      "name": "Old Name",',
          '      "settings": { "baseURL": "http://x/v1", "apiKey": "secret-key" },',
          '      "headers": { "x-team": "a" },',
          '      "models": {',
          '        "qwen": { "capabilities": { "input": ["text", "image"] }, "cost": { "input": 1, "output": 2 } }',
          '      }',
          '    }',
          '  }',
          '}'
        ].join('\n')
      )
      const cur = readOpencodeNativeConfig()
      writeOpencodeNativeConfig({
        providers: { myprov: { ...cur.providers!.myprov, name: 'New Name' } }
      })
      const written = fs.readFileSync(p, 'utf8')
      expect(written).toContain('// keep me')
      expect(written).toContain('// provider-level comment')
      const parsed = jsoncParse(written)
      expect(parsed.theme).toBe('dark')
      expect(parsed.providers.myprov).toEqual({
        name: 'New Name',
        settings: { baseURL: 'http://x/v1', apiKey: 'secret-key' },
        headers: { 'x-team': 'a' },
        models: {
          qwen: { capabilities: { input: ['text', 'image'] }, cost: { input: 1, output: 2 } }
        }
      })
    })
  })

  it('updates package and settings.baseURL leaf by leaf, keeping settings.apiKey', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(
        JSON.stringify({
          providers: {
            myprov: {
              package: 'aisdk:@old/adapter',
              settings: { baseURL: 'http://old/v1', apiKey: 'k' }
            }
          }
        })
      )
      const cur = readOpencodeNativeConfig()
      expect(cur.providers?.myprov.npm).toBe('@old/adapter')
      writeOpencodeNativeConfig({
        providers: {
          myprov: {
            ...cur.providers!.myprov,
            npm: '@ai-sdk/openai-compatible',
            baseURL: 'http://new/v1'
          }
        }
      })
      expect(jsoncParse(fs.readFileSync(p, 'utf8')).providers.myprov).toEqual({
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'http://new/v1', apiKey: 'k' }
      })
    })
  })

  it('removing a provider deletes it under both keys; a sibling keeps its fields', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(
        JSON.stringify({
          provider: { dropme: { name: 'Drop', options: { baseURL: 'http://drop/v1' } } },
          providers: {
            keepme: { package: 'aisdk:@custom/pkg', settings: { apiKey: 'k' } },
            dropme: { name: 'Drop' }
          }
        })
      )
      const cur = readOpencodeNativeConfig()
      writeOpencodeNativeConfig({ providers: { keepme: cur.providers!.keepme } })
      const parsed = jsoncParse(fs.readFileSync(p, 'utf8'))
      expect(parsed.provider).toEqual({}) // an emptied 1.x map stays (its comments with it)
      expect(parsed.providers).toEqual({
        keepme: { package: 'aisdk:@custom/pkg', settings: { apiKey: 'k' } }
      })
    })
  })

  it('maps capabilities onto 2.x keys leaf by leaf, keeping unmodelled siblings (ADR-074 slice 10)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(
        JSON.stringify({
          providers: {
            spark: {
              name: 'Spark',
              models: {
                old: { name: 'Old' },
                edited: {
                  capabilities: { output: ['text'] },
                  limit: { context: 1000, output: 10, input: 900 },
                  cost: { input: 1, output: 2 },
                  variants: [{ id: 'high', body: { effort: 'high' } }]
                }
              }
            }
          }
        })
      )
      const caps = {
        reasoning: false,
        attachment: true,
        toolCall: true,
        inputModalities: ['text', 'image'],
        limit: { context: 262144, output: 32768 }
      }
      writeOpencodeNativeConfig({
        providers: {
          spark: {
            name: 'Spark',
            models: [
              { id: 'old', name: 'Old', ...caps },
              { id: 'edited', ...caps, reasoning: true }
            ]
          }
        }
      })
      const models = jsoncParse(fs.readFileSync(p, 'utf8')).providers.spark.models
      expect(models.old).toEqual({
        name: 'Old',
        capabilities: { tools: true, input: ['text', 'image'] },
        variants: [],
        limit: { context: 262144, output: 32768 }
      })
      expect(models.edited).toEqual({
        capabilities: { output: ['text'], tools: true, input: ['text', 'image'] },
        limit: { context: 262144, output: 32768, input: 900 },
        cost: { input: 1, output: 2 },
        variants: [{ id: 'high', body: { effort: 'high' } }]
      })
    })
  })

  it('reasoning true removes an empty variant list (opencode generates variants again)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(JSON.stringify({ providers: { s: { models: { m: { variants: [] } } } } }))
      expect(readOpencodeNativeConfig().providers?.s.models?.[0].reasoning).toBe(false)
      writeOpencodeNativeConfig({ providers: { s: { models: [{ id: 'm', reasoning: true }] } } })
      expect(jsoncParse(fs.readFileSync(p, 'utf8')).providers.s.models.m).toEqual({})
    })
  })

  it('attachment alone toggles image in capabilities.input', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(
        JSON.stringify({
          providers: { s: { models: { m: { capabilities: { input: ['text', 'pdf'] } } } } }
        })
      )
      writeOpencodeNativeConfig({ providers: { s: { models: [{ id: 'm', attachment: true }] } } })
      expect(jsoncParse(fs.readFileSync(p, 'utf8')).providers.s.models.m.capabilities).toEqual({
        input: ['text', 'pdf', 'image']
      })
    })
  })

  it('a caller that does not model capabilities leaves them as the file has them', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(
        JSON.stringify({
          providers: {
            spark: { models: { m: { name: 'M', variants: [], limit: { context: 5, output: 1 } } } }
          }
        })
      )
      writeOpencodeNativeConfig({
        providers: { spark: { models: [{ id: 'm', name: 'Renamed' }] } }
      })
      expect(jsoncParse(fs.readFileSync(p, 'utf8')).providers.spark.models.m).toEqual({
        name: 'Renamed',
        variants: [],
        limit: { context: 5, output: 1 }
      })
    })
  })

  it('agent overrides: model and request.body.temperature, other fields kept', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(
        JSON.stringify({
          agents: {
            build: {
              model: 'anthropic/claude-haiku-3',
              system: 'You are a builder.',
              request: { body: { temperature: 0.2, top_p: 0.9 } }
            }
          }
        })
      )
      const cur = readOpencodeNativeConfig()
      expect(cur.agents?.build).toEqual({ model: 'anthropic/claude-haiku-3', temperature: 0.2 })
      writeOpencodeNativeConfig({ agents: { build: { ...cur.agents!.build, temperature: 0.9 } } })
      expect(jsoncParse(fs.readFileSync(p, 'utf8')).agents.build).toEqual({
        model: 'anthropic/claude-haiku-3',
        system: 'You are a builder.',
        request: { body: { temperature: 0.9, top_p: 0.9 } }
      })
    })
  })

  it('no-op save leaves the file byte-identical (either shape)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const original = [
        '// header',
        '{',
        '  "theme": "dark",',
        '  "disabled_providers": ["groq"],',
        '  "small_model": "a/b",',
        '  "provider": { "legacy": { "options": { "baseURL": "http://l/v1" }, "models": { "q": { "attachment": true } } } },',
        '  "providers": { "myprov": { "name": "Prov", "settings": { "apiKey": "k" }, "models": { "qwen": { "capabilities": { "input": ["text", "image"] } } } } },',
        '  "agent": { "build": { "model": "anthropic/claude-haiku-3", "temperature": 0.3 } },',
        '  "agents": { "plan": { "model": { "providerID": "a", "model": "b" } } }',
        '}'
      ].join('\n')
      const p = seed(original)
      writeOpencodeNativeConfig(readOpencodeNativeConfig())
      expect(fs.readFileSync(p, 'utf8')).toBe(original)
    })
  })
})

// ── A 1.x-shaped file: an edited entry moves WHOLE to its 2.x key ───────────────

describe('writeOpencodeNativeConfig — 1.x-shaped files (ADR-097 S8 write policy)', () => {
  function seed(value: unknown): string {
    const p = path.join(tmpDir, 'opencode.json')
    fs.writeFileSync(p, JSON.stringify(value, null, 2))
    return p
  }

  it('moves an edited 1.x provider whole, mapping every field 2.x reads; untouched 1.x entries stay', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed({
        provider: {
          myprov: {
            name: 'Old',
            npm: '@ai-sdk/openai-compatible',
            whitelist: ['qwen'],
            options: {
              baseURL: 'http://x/v1',
              apiKey: '{env:MY_KEY}',
              headers: { 'x-a': '1' },
              body: { foo: 1 }
            },
            models: {
              qwen: {
                name: 'Qwen',
                attachment: false,
                reasoning: false,
                temperature: true,
                tool_call: true,
                limit: { context: 1000, output: 100 },
                cost: { input: 1, output: 2, cache_read: 0.5 },
                options: { num_ctx: 8192 },
                variants: { high: { reasoningEffort: 'high' } }
              },
              vision: { attachment: true, release_date: '2026-01-01' }
            }
          },
          untouched: { options: { baseURL: 'http://u/v1' } }
        }
      })
      const cur = readOpencodeNativeConfig()
      writeOpencodeNativeConfig({
        providers: { ...cur.providers, myprov: { ...cur.providers!.myprov, name: 'New' } }
      })
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(parsed.provider).toEqual({ untouched: { options: { baseURL: 'http://u/v1' } } })
      expect(parsed.providers.myprov).toEqual({
        name: 'New',
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'http://x/v1', apiKey: '{env:MY_KEY}' },
        headers: { 'x-a': '1' },
        body: { foo: 1 },
        models: {
          // `attachment:false`, `reasoning:false`, `temperature` are inert in 2.x
          // and stay inert: no capabilities.input/variants appear (F4).
          qwen: {
            name: 'Qwen',
            settings: { num_ctx: 8192 },
            capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
            variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
            cost: [{ input: 1, output: 2, cache: { read: 0.5 } }],
            limit: { context: 1000, output: 100 }
          },
          vision: {}
        }
      })
    })
  })

  it('a 1.x provider nobody edited is not moved (byte-identical file)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed({
        model: 'a/b',
        provider: { p: { options: { baseURL: 'http://x' } } }
      })
      const before = fs.readFileSync(p, 'utf8')
      writeOpencodeNativeConfig({ ...readOpencodeNativeConfig(), model: 'a/b' })
      expect(fs.readFileSync(p, 'utf8')).toBe(before)
    })
  })

  it('a 1.x entry beside a 2.x entry of the same id is dropped when ClaudeUI edits it (2.x uses the 2.x one)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed({
        provider: { p: { name: 'Legacy' } },
        providers: { p: { name: 'Native', settings: { apiKey: 'k' } } }
      })
      expect(readOpencodeNativeConfig().providers?.p.name).toBe('Native')
      writeOpencodeNativeConfig({ providers: { p: { name: 'Edited' } } })
      expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({
        provider: {},
        providers: { p: { name: 'Edited', settings: { apiKey: 'k' } } }
      })
    })
  })

  it('moves a 1.x agent override whole (prompt → system, temperature → request.body)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed({
        agent: {
          build: {
            model: 'anthropic/claude-haiku-3',
            temperature: 0.2,
            prompt: 'You are a builder.',
            permission: { bash: 'ask' },
            maxSteps: 7
          }
        }
      })
      const cur = readOpencodeNativeConfig()
      writeOpencodeNativeConfig({ agents: { build: { ...cur.agents!.build, temperature: 0.9 } } })
      expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({
        agent: {},
        agents: {
          build: {
            model: { providerID: 'anthropic', model: 'claude-haiku-3' },
            request: { body: { temperature: 0.9 } },
            system: 'You are a builder.',
            steps: 7,
            permissions: [{ action: 'shell', resource: '*', effect: 'ask' }]
          }
        }
      })
    })
  })

  it('small model: folds small_model and agent.title into agents.title', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed({
        small_model: 'old/small',
        agent: { title: { description: 'Titles' } }
      })
      expect(readOpencodeNativeConfig().smallModel).toBe('old/small')
      writeOpencodeNativeConfig({ ...readOpencodeNativeConfig(), smallModel: 'new/small' })
      expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({
        agent: {},
        agents: { title: { model: 'new/small', description: 'Titles' } }
      })
    })
  })

  it('the shared-provider adapter projection stays stable across the move (no re-write)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      seed({ provider: { p: { name: 'P', models: { m: { attachment: true, tool_call: true } } } } })
      const legacy = readOpencodeNativeConfig()
      writeOpencodeNativeConfig({
        providers: { p: { ...legacy.providers!.p, name: 'P2' } }
      })
      const native = readOpencodeNativeConfig().providers!.p
      expect(native.models).toEqual([
        { id: 'm', attachment: true, toolCall: true, inputModalities: ['text', 'image'] }
      ])
    })
  })
})

// ── S8 review fixes: F4 runtime-neutral moves, F7, F8, F9, F11 ──────────────

describe('F4: moving a 1.x provider changes nothing 2.x runs on', () => {
  function seed(text: string): string {
    const p = path.join(tmpDir, 'opencode.jsonc')
    fs.writeFileSync(p, text)
    return p
  }

  it('unedited inert keys stay inert; the projection is what 2.x does before and after', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(
        JSON.stringify({
          provider: {
            corp: {
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'https://gw', apiKey: '{env:CORP_KEY}', timeout: 600000 },
              models: {
                m1: { name: 'M1', attachment: true, reasoning: false, temperature: true },
                m2: { attachment: false }
              }
            }
          }
        })
      )
      const before = readOpencodeNativeConfig().providers!.corp
      // What 2.x does with them today: nothing (they are dropped as unsupported).
      expect(before.models).toEqual([{ id: 'm1', name: 'M1' }, { id: 'm2' }])
      writeOpencodeNativeConfig({ providers: { corp: { ...before, name: 'Corp' } } })
      const moved = jsoncParse(fs.readFileSync(p, 'utf8')).providers.corp
      expect(moved.models).toEqual({ m1: { name: 'M1' }, m2: {} })
      expect(moved.settings).toEqual({
        baseURL: 'https://gw',
        apiKey: '{env:CORP_KEY}',
        timeout: 600000
      })
      expect(readOpencodeNativeConfig().providers!.corp).toEqual({ ...before, name: 'Corp' })
    })
  })

  it('a capability the user edits in that save IS written on the 2.x key', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(JSON.stringify({ provider: { c: { models: { m: { attachment: true } } } } }))
      writeOpencodeNativeConfig({
        providers: { c: { models: [{ id: 'm', attachment: false, reasoning: false }] } }
      })
      expect(jsoncParse(fs.readFileSync(p, 'utf8')).providers.c.models.m).toEqual({
        capabilities: { input: ['text'] },
        variants: []
      })
    })
  })

  it('keeps the comments of a moved entry, gathered above it (probe3)', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = seed(
        [
          '{',
          '  // my providers',
          '  "provider": {',
          '    // corp gateway, key from env',
          '    "corp": {',
          '      "npm": "@ai-sdk/openai-compatible", // the adapter',
          '      /* block note */',
          '      "options": { "baseURL": "https://gw" }',
          '    }',
          '  }',
          '}'
        ].join('\n')
      )
      const cur = readOpencodeNativeConfig()
      writeOpencodeNativeConfig({ providers: { corp: { ...cur.providers!.corp, name: 'Corp' } } })
      const text = fs.readFileSync(p, 'utf8')
      for (const comment of [
        '// my providers',
        '// corp gateway, key from env',
        '// the adapter',
        '/* block note */'
      ])
        expect(text).toContain(comment)
      expect(text.indexOf('// corp gateway')).toBeLessThan(text.indexOf('"corp"'))
      expect(jsoncParse(text).providers.corp.name).toBe('Corp')
    })
  })
})

describe('F7: the 1.x mode map is honoured', () => {
  it('mode.<name> wins over agent.<name>, reads as primary, and moves whole', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = path.join(tmpDir, 'opencode.json')
      fs.writeFileSync(
        p,
        JSON.stringify({
          agent: { docs: { model: 'a/old', temperature: 0.1 } },
          mode: { docs: { model: 'a/mode', temperature: 0.5, prompt: 'Write docs.' } }
        })
      )
      expect(readOpencodeNativeConfig().agents?.docs).toEqual({ model: 'a/mode', temperature: 0.5 })
      writeOpencodeNativeConfig({ agents: { docs: { model: 'a/mode', temperature: 0.9 } } })
      expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({
        agent: {},
        mode: {},
        agents: {
          docs: {
            model: { providerID: 'a', model: 'mode' },
            request: { body: { temperature: 0.9 } },
            system: 'Write docs.',
            mode: 'primary'
          }
        }
      })
    })
  })
})

describe('F8: reasoning:false never overwrites hand-written variants', () => {
  it('a non-empty variants list stays', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = path.join(tmpDir, 'opencode.json')
      const variants = [{ id: 'high', settings: { reasoningEffort: 'high' } }]
      fs.writeFileSync(p, JSON.stringify({ providers: { s: { models: { m: { variants } } } } }))
      writeOpencodeNativeConfig({ providers: { s: { models: [{ id: 'm', reasoning: false }] } } })
      expect(JSON.parse(fs.readFileSync(p, 'utf8')).providers.s.models.m.variants).toEqual(variants)
    })
  })
})

describe('F9: enabled_providers: [] denies every provider', () => {
  it('reads as an empty allowlist, and survives a save', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = path.join(tmpDir, 'opencode.json')
      fs.writeFileSync(p, JSON.stringify({ enabled_providers: [], model: 'a/b' }))
      const cur = readOpencodeNativeConfig()
      expect(cur.enabledProviders).toEqual([])
      writeOpencodeNativeConfig({ ...cur, model: 'c/d' })
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(parsed.enabled_providers).toEqual([])
      expect(readOpencodeNativeConfig().enabledProviders).toEqual([])
    })
  })

  it('policies with a * deny and no allows read the same way', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      fs.writeFileSync(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({
          experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }] }
        })
      )
      expect(readOpencodeNativeConfig().enabledProviders).toEqual([])
    })
  })
})

describe('F11: conflict-aware, atomic writes', () => {
  it('a stale snapshot never deletes what was added since; only its own changes land', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = path.join(tmpDir, 'opencode.json')
      fs.writeFileSync(p, JSON.stringify({ model: 'a/b', providers: { mine: { name: 'Mine' } } }))
      const snapshot = readOpencodeNativeConfig() // the pane loads…
      // …the user hand-adds a provider and a disabled id meanwhile…
      fs.writeFileSync(
        p,
        JSON.stringify({
          model: 'a/b',
          providers: { mine: { name: 'Mine' }, theirs: { name: 'Theirs' } },
          disabled_providers: ['groq']
        })
      )
      // …and the pane saves its stale snapshot with ONE change.
      writeOpencodeNativeConfig({ ...snapshot, smallModel: 'x/y' }, snapshot)
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(parsed.providers.theirs).toEqual({ name: 'Theirs' })
      expect(parsed.disabled_providers).toEqual(['groq'])
      expect(parsed.agents.title.model).toBe('x/y')
    })
  })

  it('a stale snapshot adds/removes provider ids and disabled ids as set changes', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = path.join(tmpDir, 'opencode.json')
      fs.writeFileSync(p, JSON.stringify({ providers: { a: {}, b: {} } }))
      const snapshot = readOpencodeNativeConfig()
      fs.writeFileSync(p, JSON.stringify({ providers: { a: {}, b: { name: 'B2' }, c: {} } }))
      writeOpencodeNativeConfig(
        { ...snapshot, providers: { b: {}, d: { name: 'D' } }, disabledProviders: ['x'] },
        snapshot
      )
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(Object.keys(parsed.providers).sort()).toEqual(['b', 'c', 'd'])
      expect(parsed.providers.b).toEqual({ name: 'B2' }) // edited since, not by the pane
      expect(parsed.experimental.policies).toEqual([
        { action: 'provider.use', resource: 'x', effect: 'deny' }
      ])
    })
  })

  it('writes atomically, keeping the file mode', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const file = path.join(tmpDir, 'opencode.json')
      fs.writeFileSync(file, '{}')
      fs.chmodSync(file, 0o600)
      writeOpencodeNativeConfig({ model: 'a/b' })
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).model).toBe('a/b')
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    })
  })

  it.skipIf(!CAN_SYMLINK_FILE)('writes through a symlinked config, keeping the link', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const real = path.join(tmpDir, 'real.json')
      fs.writeFileSync(real, '{}')
      fs.chmodSync(real, 0o600)
      fs.symlinkSync(real, path.join(tmpDir, 'opencode.json'))
      writeOpencodeNativeConfig({ model: 'a/b' })
      expect(fs.lstatSync(path.join(tmpDir, 'opencode.json')).isSymbolicLink()).toBe(true)
      expect(JSON.parse(fs.readFileSync(real, 'utf8')).model).toBe('a/b')
      if (process.platform !== 'win32') expect(fs.statSync(real).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    })
  })
})

// ── Built-in tool switches (top-level permissions) ────────────────────────────

describe("setOpencodeToolDisabled (F3: upstream whollyDisabled, only ClaudeUI's own rule)", () => {
  // ClaudeUI's record of the switches it set lives in engines/opencode.json.
  let engine: EngineConfig = {}
  beforeEach(() => {
    engine = {}
    loadEngineConfigMock.mockImplementation(() => structuredClone(engine))
    saveEngineConfigMock.mockImplementation((_id, cfg) => {
      engine = structuredClone(cfg)
    })
  })
  afterEach(() => {
    loadEngineConfigMock.mockImplementation(() => ({}))
    saveEngineConfigMock.mockImplementation(() => {})
  })

  it('appends {action,*,deny} once and removes exactly that on re-enable', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = path.join(tmpDir, 'opencode.jsonc')
      fs.writeFileSync(
        p,
        '{\n  // mine\n  "permissions": [{ "action": "shell", "resource": "rm *", "effect": "deny" }]\n}'
      )
      setOpencodeToolDisabled('webfetch', true)
      setOpencodeToolDisabled('webfetch', true)
      let parsed = jsoncParse(fs.readFileSync(p, 'utf8'))
      expect(parsed.permissions).toEqual([
        { action: 'shell', resource: 'rm *', effect: 'deny' },
        { action: 'webfetch', resource: '*', effect: 'deny' }
      ])
      expect(engine.opencodeToolSwitches).toEqual(['webfetch'])
      expect(toolDisabledIn(parsed, 'webfetch', 'darwin')).toBe(true)
      expect(toolDisabledIn(parsed, 'shell', 'darwin')).toBe(false)
      setOpencodeToolDisabled('webfetch', false)
      const text = fs.readFileSync(p, 'utf8')
      expect(text).toContain('// mine')
      parsed = jsoncParse(text)
      expect(parsed.permissions).toEqual([{ action: 'shell', resource: 'rm *', effect: 'deny' }])
      expect(engine.opencodeToolSwitches).toBeUndefined()
    })
  })

  it('"off" is upstream whollyDisabled: a later narrower allow keeps the tool offered', () => {
    const rules = {
      permissions: [
        { action: 'shell', resource: '*', effect: 'deny' },
        { action: 'shell', resource: 'git *', effect: 'allow' }
      ]
    }
    expect(toolDisabledIn(rules, 'shell', 'darwin')).toBe(false)
    expect(
      toolDisabledIn({ permissions: [...rules.permissions].reverse() }, 'shell', 'darwin')
    ).toBe(true)
    // A wildcard action is matched like upstream does.
    expect(
      toolDisabledIn(
        { permissions: [{ action: '*', resource: '*', effect: 'deny' }] },
        'read',
        'darwin'
      )
    ).toBe(true)
  })

  it("never removes the user's own deny-all: switching on a tool they switched off throws", () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = path.join(tmpDir, 'opencode.json')
      const userRules = {
        permissions: [
          { action: 'shell', resource: 'git *', effect: 'allow' },
          { action: 'shell', resource: '*', effect: 'deny' }
        ]
      }
      fs.writeFileSync(p, JSON.stringify(userRules))
      expect(() => setOpencodeToolDisabled('shell', false)).toThrow(/your own permission rules/)
      expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual(userRules)
    })
  })

  it("removes only ClaudeUI's own rule, the user's identical earlier one stays", () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = path.join(tmpDir, 'opencode.json')
      fs.writeFileSync(
        p,
        JSON.stringify({
          permissions: [
            { action: 'read', resource: '*', effect: 'deny' },
            { action: 'read', resource: 'docs/*', effect: 'allow' }
          ]
        })
      )
      setOpencodeToolDisabled('read', true) // the narrower allow keeps it on, so ClaudeUI appends
      setOpencodeToolDisabled('read', false)
      expect(JSON.parse(fs.readFileSync(p, 'utf8')).permissions).toEqual([
        { action: 'read', resource: '*', effect: 'deny' },
        { action: 'read', resource: 'docs/*', effect: 'allow' }
      ])
    })
  })

  it("a 1.x tools:false is the user's: never removed by the switch", () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const p = path.join(tmpDir, 'opencode.json')
      fs.writeFileSync(p, JSON.stringify({ tools: { bash: false } }))
      expect(toolDisabledIn(JSON.parse(fs.readFileSync(p, 'utf8')), 'shell', 'darwin')).toBe(true)
      expect(() => setOpencodeToolDisabled('shell', false)).toThrow(/your own/)
      expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({ tools: { bash: false } })
    })
  })

  it('names the config agents whose own rules still offer a switched-off tool', () => {
    const config = {
      agent: { rev: { permission: { '*': 'allow', bash: 'deny' } } },
      mode: { loose: { permission: 'allow' } },
      agents: { strict: { permissions: [{ action: 'read', resource: '*', effect: 'deny' }] } }
    }
    const agents = configAgentRules(config)
    expect(agentsOverridingSwitch('read', agents, 'darwin')).toEqual(['rev', 'loose'])
    expect(agentsOverridingSwitch('shell', agents, 'darwin')).toEqual(['loose'])
  })

  it('refuses an action that is not a switchable built-in', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      expect(() => setOpencodeToolDisabled('*', true)).toThrow(/switchable/)
    })
  })
})

// ── Write notifications (the reload hook) ─────────────────────────────────────

describe('onOpencodeConfigWritten', () => {
  it('fires once per write that changed the file, never for a no-op', () => {
    withEnv('OPENCODE_CONFIG_DIR', tmpDir, () => {
      const seen: string[] = []
      const off = onOpencodeConfigWritten((reason) => seen.push(reason))
      writeOpencodeNativeConfig({ model: 'a/b' })
      writeOpencodeNativeConfig({ model: 'a/b' })
      setOpencodeToolDisabled('read', true)
      off()
      writeOpencodeNativeConfig({ model: 'c/d' })
      expect(seen).toEqual(['settings', 'tool read'])
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
