/**
 * @vitest-environment node
 *
 * Tests for pi-models-raw.ts — the raw reader / leaf-patch writer for pi's model
 * catalog file, `~/.pi/agent/models.json`. Real files under a temp directory:
 * `os.homedir()` is redirected there via a hoisted mock (same trick as
 * pi-native-raw.test.ts) so BOTH `piAgentDir()` and the shared-provider store
 * (`~/.claude/ui/providers/`) resolve inside the fixture tree. The REAL home
 * directory is never read or written.
 *
 * The mechanics shared with settings.json (BOM/EOL preservation, the delete
 * invariant, path validation, the byte-compare write gate) live in
 * pi-json-raw.ts and are exercised in full by pi-native-raw.test.ts; this file
 * pins them only where models.json could plausibly diverge (its own file path,
 * its own refusal wording) and spends the rest of its length on what settings
 * .json does not have:
 *
 * - `managedProviderIds`: the ids the shared-provider projection owns right now
 * - the OWNERSHIP guard: a raw write into a projected `providers.<id>` entry is
 *   refused (the next sync would clobber it, and the adapter would then refuse
 *   the user's next provider save as "changed outside ClaudeUI")
 * - the BUILT-IN guard: replacing a built-in pi vendor entry wholesale is
 *   refused, while the documented `modelOverrides` leaf writes UNDER one pass
 * - cache invalidation: a real write invalidates pi model discovery, a no-op
 *   write does not
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as jsoncParse } from 'jsonc-parser'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'

const homedirHolder = vi.hoisted(() => ({ current: '' }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => homedirHolder.current,
    default: { ...actual, homedir: () => homedirHolder.current }
  }
})

// Discovery spawns a real pi binary; this suite only cares that a write tells it
// to drop its cache. Mocking the module also keeps its `pi-locate` → host-paths
// import out of a node-environment unit test.
const invalidatePiModelCache = vi.hoisted(() => vi.fn())
vi.mock('../model-discovery', () => ({ invalidatePiModelCache }))

import { readPiModelsRaw, patchPiModelsRaw, piModelsFile } from '../pi-models-raw'

let testHome: string

/** The fixture's `~/.pi/agent/models.json`. */
function modelsPath(): string {
  return join(testHome, '.pi', 'agent', 'models.json')
}

/** Write a models.json fixture (creating `~/.pi/agent`), returning its path. */
function writeModels(text: string): string {
  const p = modelsPath()
  mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true })
  writeFileSync(p, text, 'utf-8')
  return p
}

/** A minimal valid custom shared-provider definition. */
function definition(
  id: string,
  overrides: Partial<SharedProviderDefinition> = {}
): SharedProviderDefinition {
  return {
    id,
    name: id,
    kind: 'custom',
    protocol: 'openai-responses',
    baseUrl: 'https://api.example.test/v1',
    managed: true,
    models: [{ id: 'm1', contextWindow: 100_000, maxTokens: 8_000 }],
    routes: { pi: { enabled: true }, opencode: { enabled: false } },
    ...overrides
  }
}

/** Persist a definition into the store `shared-provider:list` reads. */
function writeSharedProvider(provider: SharedProviderDefinition): void {
  const dir = join(testHome, '.claude', 'ui', 'providers')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${provider.id}.json`), JSON.stringify(provider, null, 2), 'utf-8')
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'pi-models-raw-test-'))
  homedirHolder.current = testHome
  invalidatePiModelCache.mockClear()
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('readPiModelsRaw', () => {
  it('returns {} and the resolved path when no file exists, and does NOT create it', () => {
    const { config, path, text, managedProviderIds } = readPiModelsRaw()
    expect(config).toEqual({})
    expect(text).toBe('')
    expect(managedProviderIds).toEqual([])
    expect(path).toBe(modelsPath())
    expect(path).toBe(piModelsFile())
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(testHome, '.pi'))).toBe(false)
  })

  it('returns the parsed catalog verbatim (no projection)', () => {
    writeModels(
      `{
  "providers": {
    "my-api": {
      "baseUrl": "https://api.example.test/v1",
      "api": "openai-responses",
      "models": [{ "id": "m1", "contextWindow": 100000 }]
    },
    "openai": { "modelOverrides": { "gpt-5.6-sol": { "contextWindow": 1050000 } } }
  }
}`
    )
    const { config } = readPiModelsRaw()
    const providers = config.providers as Record<string, Record<string, unknown>>
    expect(providers['my-api'].api).toBe('openai-responses')
    expect(providers.openai.modelOverrides).toEqual({ 'gpt-5.6-sol': { contextWindow: 1050000 } })
  })

  it('returns {} for an unparseable file but keeps its bytes (and leaves it alone)', () => {
    const p = writeModels('{ "providers": ')
    const { config, text } = readPiModelsRaw()
    expect(config).toEqual({})
    expect(text).toBe('{ "providers": ')
    expect(readFileSync(p, 'utf-8')).toBe('{ "providers": ')
  })

  it('parses a file carrying a UTF-8 BOM, and strips it from `text`', () => {
    writeModels('\uFEFF{ "providers": {} }')
    const { config, text } = readPiModelsRaw()
    expect(config).toEqual({ providers: {} })
    expect(text).toBe('{ "providers": {} }')
  })
})

describe('readPiModelsRaw — managedProviderIds', () => {
  it('lists custom providers with an ENABLED pi route, honouring a route providerId', () => {
    writeSharedProvider(definition('plain'))
    writeSharedProvider(
      definition('renamed', {
        routes: { pi: { enabled: true, providerId: 'pi-side-id' }, opencode: { enabled: false } }
      })
    )
    expect(readPiModelsRaw().managedProviderIds.sort()).toEqual(['pi-side-id', 'plain'])
  })

  it('excludes a DISABLED pi route (the projection removes those entries)', () => {
    writeSharedProvider(
      definition('off', {
        routes: { pi: { enabled: false }, opencode: { enabled: true } }
      })
    )
    expect(readPiModelsRaw().managedProviderIds).toEqual([])
  })

  it('excludes the built-in ChatGPT provider (a native credential, not a models.json entry)', () => {
    // The repository always returns chatgpt; it is kind:'subscription' and its pi
    // route targets the native `openai-codex` vendor, which the projection never
    // writes into models.json.
    expect(readPiModelsRaw().managedProviderIds).toEqual([])
  })

  it('reflects the store as it is NOW, not as it was at import time', () => {
    expect(readPiModelsRaw().managedProviderIds).toEqual([])
    writeSharedProvider(definition('later'))
    expect(readPiModelsRaw().managedProviderIds).toEqual(['later'])
  })
})

describe('patchPiModelsRaw — leaf writes', () => {
  it('sets a leaf while preserving sibling keys and the untouched bytes verbatim', () => {
    const p = writeModels(
      `{
  "providers": {
    "my-api": {
      "baseUrl": "https://api.example.test/v1",
      "models": [
        { "id": "m1", "contextWindow": 100000 }
      ]
    }
  }
}`
    )
    patchPiModelsRaw([
      { path: ['providers', 'my-api', 'models', 0, 'contextWindow'], value: 200_000 }
    ])
    const text = readFileSync(p, 'utf-8')
    expect(text).toContain(`      "baseUrl": "https://api.example.test/v1",`)
    const parsed = jsoncParse(text)
    expect(parsed.providers['my-api'].models[0]).toEqual({ id: 'm1', contextWindow: 200_000 })
  })

  it('preserves a comment in an untouched region (jsonc modify, not a reserialize)', () => {
    const p = writeModels(
      `{
  // hand-written note
  "providers": { "my-api": { "baseUrl": "https://api.example.test/v1" } }
}`
    )
    patchPiModelsRaw([{ path: ['providers', 'my-api', 'api'], value: 'openai-completions' }])
    const text = readFileSync(p, 'utf-8')
    expect(text).toContain('// hand-written note')
    expect(jsoncParse(text).providers['my-api'].api).toBe('openai-completions')
  })

  it('creates the file (and its parent dir) on the first patch, 2-space + trailing newline', () => {
    expect(existsSync(modelsPath())).toBe(false)
    patchPiModelsRaw([{ path: ['providers', 'my-api', 'api'], value: 'openai-responses' }])
    expect(readFileSync(modelsPath(), 'utf-8')).toBe(
      '{\n  "providers": {\n    "my-api": {\n      "api": "openai-responses"\n    }\n  }\n}\n'
    )
  })

  it('deleting a MISSING leaf is a no-op and never creates the file', () => {
    expect(() => patchPiModelsRaw([{ path: ['providers', 'gone'] }])).not.toThrow()
    expect(existsSync(modelsPath())).toBe(false)
  })

  it('refuses to overwrite a models.json that EXISTS but cannot be read', () => {
    // A directory at the file path is the portable stand-in for "present,
    // unreadable" (no chmod on Windows): existsSync says yes, readFileSync throws.
    mkdirSync(modelsPath(), { recursive: true })
    expect(() => patchPiModelsRaw([{ path: ['providers', 'x', 'api'], value: 'y' }])).toThrow(
      /Refusing to overwrite unreadable pi models file/
    )
  })

  it('rejects invalid paths, naming models.json rather than settings.json', () => {
    const p = writeModels(`{ "providers": {} }`)
    const before = readFileSync(p, 'utf-8')
    expect(() => patchPiModelsRaw([{ path: [], value: 1 }])).toThrow(
      /Refusing to apply a pi models patch with an empty path/
    )
    expect(() => patchPiModelsRaw([{ path: ['__proto__', 'x'], value: 1 }])).toThrow(
      /Refusing to apply a pi models patch through prototype segment/
    )
    expect(readFileSync(p, 'utf-8')).toBe(before)
  })
})

describe('patchPiModelsRaw — shared-provider ownership guard', () => {
  it('refuses a leaf write inside a MANAGED provider entry, writing nothing', () => {
    writeSharedProvider(definition('managed-api'))
    const p = writeModels(
      `{ "providers": { "managed-api": { "baseUrl": "https://api.example.test/v1" } } }`
    )
    const before = readFileSync(p, 'utf-8')
    expect(() =>
      patchPiModelsRaw([
        { path: ['providers', 'managed-api', 'models', 0, 'reasoning'], value: true }
      ])
    ).toThrow(/Refusing to edit pi provider "managed-api"/)
    expect(readFileSync(p, 'utf-8')).toBe(before)
    expect(invalidatePiModelCache).not.toHaveBeenCalled()
  })

  it('refuses deleting the whole managed entry too (the projection owns it, not the pane)', () => {
    writeSharedProvider(definition('managed-api'))
    writeModels(`{ "providers": { "managed-api": { "baseUrl": "https://x" } } }`)
    expect(() => patchPiModelsRaw([{ path: ['providers', 'managed-api'] }])).toThrow(
      /projected from a shared provider/
    )
  })

  it('rejects the WHOLE set when one patch touches a managed entry (nothing partially applied)', () => {
    writeSharedProvider(definition('managed-api'))
    const p = writeModels(`{ "providers": { "mine": { "baseUrl": "https://x" } } }`)
    const before = readFileSync(p, 'utf-8')
    expect(() =>
      patchPiModelsRaw([
        { path: ['providers', 'mine', 'api'], value: 'openai-responses' },
        { path: ['providers', 'managed-api', 'api'], value: 'openai-responses' }
      ])
    ).toThrow(/Refusing to edit pi provider "managed-api"/)
    expect(readFileSync(p, 'utf-8')).toBe(before)
  })

  it('allows an UNMANAGED provider with the same file present', () => {
    writeSharedProvider(definition('managed-api'))
    const p = writeModels(`{ "providers": { "mine": { "baseUrl": "https://x" } } }`)
    patchPiModelsRaw([{ path: ['providers', 'mine', 'api'], value: 'openai-responses' }])
    expect(jsoncParse(readFileSync(p, 'utf-8')).providers.mine.api).toBe('openai-responses')
  })

  it('allows the entry again once the shared provider stops managing it', () => {
    // Ownership is answered from the store on every call, so disabling the pi
    // route hands the entry back to the editor without an app restart.
    writeSharedProvider(definition('handover'))
    const p = writeModels(`{ "providers": { "handover": { "baseUrl": "https://x" } } }`)
    expect(() =>
      patchPiModelsRaw([{ path: ['providers', 'handover', 'api'], value: 'openai-responses' }])
    ).toThrow(/Refusing to edit pi provider/)
    writeSharedProvider(
      definition('handover', { routes: { pi: { enabled: false }, opencode: { enabled: false } } })
    )
    patchPiModelsRaw([{ path: ['providers', 'handover', 'api'], value: 'openai-responses' }])
    expect(jsoncParse(readFileSync(p, 'utf-8')).providers.handover.api).toBe('openai-responses')
  })
})

describe('patchPiModelsRaw — built-in vendor guard', () => {
  it('refuses to create a whole entry at a built-in pi vendor id', () => {
    expect(() =>
      patchPiModelsRaw([
        { path: ['providers', 'openai'], value: { baseUrl: 'https://evil.test/v1' } }
      ])
    ).toThrow(/Refusing to replace built-in pi provider "openai"/)
    expect(existsSync(modelsPath())).toBe(false)
  })

  it('ALLOWS the documented modelOverrides leaf write under a built-in id', () => {
    // vendor/pi-cli/docs/models.md "Per-model Overrides" — this is precisely what
    // pi tells users to write, so the guard must not swallow it.
    patchPiModelsRaw([
      {
        path: ['providers', 'openai', 'modelOverrides', 'gpt-5.6-sol', 'contextWindow'],
        value: 1_050_000
      }
    ])
    expect(jsoncParse(readFileSync(modelsPath(), 'utf-8'))).toEqual({
      providers: { openai: { modelOverrides: { 'gpt-5.6-sol': { contextWindow: 1_050_000 } } } }
    })
  })

  it('ALLOWS deleting an existing built-in entry (only CREATION is a collision)', () => {
    const p = writeModels(`{ "providers": { "openai": { "modelOverrides": {} }, "mine": {} } }`)
    patchPiModelsRaw([{ path: ['providers', 'openai'] }])
    expect(jsoncParse(readFileSync(p, 'utf-8'))).toEqual({ providers: { mine: {} } })
  })
})

/**
 * `models` is the one ARRAY the editor writes into, and the panes (C2) need to
 * know whether jsonc-parser's modify() can APPEND and REMOVE elements by index
 * or whether add/remove has to rewrite the whole array as one leaf. These pin
 * what the REAL writer does end to end (index-replace is already covered above).
 */
describe('patchPiModelsRaw — models[] array semantics', () => {
  const twoModels = `{
  "providers": {
    "mine": {
      "baseUrl": "https://api.example.test/v1",
      "models": [
        { "id": "m1" },
        { "id": "m2" }
      ]
    }
  }
}`

  it('APPENDS when the index equals the array length', () => {
    const p = writeModels(twoModels)
    patchPiModelsRaw([{ path: ['providers', 'mine', 'models', 2], value: { id: 'm3' } }])
    expect(jsoncParse(readFileSync(p, 'utf-8')).providers.mine.models).toEqual([
      { id: 'm1' },
      { id: 'm2' },
      { id: 'm3' }
    ])
  })

  it('append keeps comments and earlier elements verbatim, reformatting only the tail', () => {
    // The tradeoff the pane relies on: an insert edit spans the LAST existing
    // element through the closing bracket, so that element is re-printed expanded
    // while everything before it — comments included — survives byte-for-byte.
    // A whole-array leaf rewrite would have destroyed the comment (below).
    const p = writeModels(`{
  "providers": {
    "mine": {
      "models": [
        // hand-written note
        { "id": "m1", "contextWindow": 100000 },
        { "id": "m2" }
      ]
    }
  }
}`)
    patchPiModelsRaw([{ path: ['providers', 'mine', 'models', 2], value: { id: 'm3' } }])
    const text = readFileSync(p, 'utf-8')
    expect(text).toContain('// hand-written note')
    expect(text).toContain(`{ "id": "m1", "contextWindow": 100000 },`)
    expect(jsoncParse(text).providers.mine.models).toEqual([
      { id: 'm1', contextWindow: 100_000 },
      { id: 'm2' },
      { id: 'm3' }
    ])
  })

  it('a WHOLE-ARRAY leaf rewrite loses in-array comments — which is why add/remove go by index', () => {
    const p = writeModels(`{
  "providers": {
    "mine": {
      "models": [
        // hand-written note
        { "id": "m1" }
      ]
    }
  }
}`)
    patchPiModelsRaw([
      { path: ['providers', 'mine', 'models'], value: [{ id: 'm1' }, { id: 'm2' }] }
    ])
    expect(readFileSync(p, 'utf-8')).not.toContain('// hand-written note')
  })

  it('append leaves the provider’s sibling keys byte-identical', () => {
    const p = writeModels(`{
  "providers": {
    "mine": {
      // note about baseUrl
      "baseUrl":    "https://api.example.test/v1",
      "models": [{ "id": "m1" }],
      "compat": { "supportsDeveloperRole": false }
    }
  }
}`)
    patchPiModelsRaw([{ path: ['providers', 'mine', 'models', 1], value: { id: 'm2' } }])
    const text = readFileSync(p, 'utf-8')
    expect(text).toContain('// note about baseUrl')
    expect(text).toContain(`"baseUrl":    "https://api.example.test/v1",`)
    expect(text).toContain(`"compat": { "supportsDeveloperRole": false }`)
  })

  it('creates the whole array when `models` is absent (index 0 under a missing parent)', () => {
    // modify() THROWS deleting under a missing parent but SETS through one, so a
    // first model can be written at index 0 — pinned because the pane relies on
    // it rather than seeding `models: []` first.
    const p = writeModels(`{ "providers": { "mine": { "baseUrl": "https://x" } } }`)
    patchPiModelsRaw([{ path: ['providers', 'mine', 'models', 0], value: { id: 'm1' } }])
    expect(jsoncParse(readFileSync(p, 'utf-8')).providers.mine.models).toEqual([{ id: 'm1' }])
  })

  it('REMOVES an element by index — it splices, it does not leave a null hole', () => {
    const p = writeModels(twoModels)
    patchPiModelsRaw([{ path: ['providers', 'mine', 'models', 0] }])
    const models = jsoncParse(readFileSync(p, 'utf-8')).providers.mine.models
    expect(models).toEqual([{ id: 'm2' }])
    expect(models).toHaveLength(1)
  })

  it('removing the LAST element leaves an empty array, not a removed key', () => {
    const p = writeModels(`{ "providers": { "mine": { "models": [{ "id": "m1" }] } } }`)
    patchPiModelsRaw([{ path: ['providers', 'mine', 'models', 0] }])
    expect(jsoncParse(readFileSync(p, 'utf-8')).providers.mine.models).toEqual([])
  })

  it('removing an OUT-OF-RANGE index is a no-op (the pathExists delete invariant)', async () => {
    const p = writeModels(twoModels)
    const before = readFileSync(p, 'utf-8')
    const mtimeBefore = statSync(p).mtimeMs
    await new Promise((r) => setTimeout(r, 10))
    expect(() => patchPiModelsRaw([{ path: ['providers', 'mine', 'models', 7] }])).not.toThrow()
    expect(readFileSync(p, 'utf-8')).toBe(before)
    expect(statSync(p).mtimeMs).toBe(mtimeBefore)
  })

  it('patches a leaf INSIDE an appended element afterwards (indices stay addressable)', () => {
    const p = writeModels(twoModels)
    patchPiModelsRaw([{ path: ['providers', 'mine', 'models', 2], value: { id: 'm3' } }])
    patchPiModelsRaw([{ path: ['providers', 'mine', 'models', 2, 'reasoning'], value: true }])
    expect(jsoncParse(readFileSync(p, 'utf-8')).providers.mine.models[2]).toEqual({
      id: 'm3',
      reasoning: true
    })
  })
})

describe('patchPiModelsRaw — model cache invalidation', () => {
  it('invalidates pi model discovery after a write', () => {
    patchPiModelsRaw([{ path: ['providers', 'mine', 'api'], value: 'openai-responses' }])
    expect(invalidatePiModelCache).toHaveBeenCalledTimes(1)
  })

  it('does NOT invalidate when the patch set changes no bytes', async () => {
    const p = writeModels(
      `{\n  "providers": {\n    "mine": {\n      "api": "openai-responses"\n    }\n  }\n}\n`
    )
    const mtimeBefore = statSync(p).mtimeMs
    await new Promise((r) => setTimeout(r, 10))
    patchPiModelsRaw([{ path: ['providers', 'mine', 'api'], value: 'openai-responses' }])
    patchPiModelsRaw([])
    patchPiModelsRaw([{ path: ['providers', 'absent', 'api'] }])
    expect(statSync(p).mtimeMs).toBe(mtimeBefore)
    expect(invalidatePiModelCache).not.toHaveBeenCalled()
  })
})
