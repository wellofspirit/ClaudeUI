/**
 * @vitest-environment node
 *
 * opencode-pricing.ts unit tests — ADR-071 §5, the models.dev source.
 *
 * Tests:
 *  1. refreshPrices maps a fake models.dev payload to PricingEntry[] + calls
 *     registerSupplementalPricing so equivalentCostUsd resolves the model.
 *  2. Zero-priced models are KEPT (on models.dev a 0 means free) and malformed
 *     entries are skipped without taking their neighbours with them.
 *  3. A failed fetch, a non-200, an oversized body and an empty result all leave
 *     the persisted file and the registered table untouched.
 *  4. persisted-file round-trip through loadPersistedPrices.
 *  5. refreshPricesIfStale: missing / fresh / stale file, and the env gate.
 *
 * Isolation: the SUT's PRICES_FILE is a module-level const derived from
 * os.homedir() at import time. We mock 'os' so homedir() resolves to a per-run
 * temp dir — these tests must NEVER touch the developer's real
 * ~/.claude/ui/opencode-prices.json (refreshPrices persists on every call).
 *
 * Network: global fetch is stubbed in every test. Nothing here reaches models.dev.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be at top level so vi.hoisted runs before any imports
// ---------------------------------------------------------------------------

const { TEMP_HOME, renameFailure } = vi.hoisted(() => {
  // Hoisted code runs before ESM imports resolve, so use process.getBuiltinModule
  // (Node 22.3+) to reach the REAL fs/os/path for the temp-dir setup.
  const realFs = process.getBuiltinModule('fs')
  const realOs = process.getBuiltinModule('os')
  const realPath = process.getBuiltinModule('path')
  return {
    TEMP_HOME: realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'opencode-prices-test-')),
    // Set by the atomic-persist test to make the rename half of the write fail.
    renameFailure: { error: null as Error | null }
  }
})

// Redirect os.homedir() → TEMP_HOME. vitest hoists vi.mock above imports, so the
// mock is in place before the SUT module (and its PRICES_FILE const) loads.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

// A pass-through 'fs' whose renameSync can be made to fail. ESM namespaces are
// not configurable, so vi.spyOn cannot reach the rename inside write-json-atomic;
// this is the only way to exercise the failure half of the atomic write.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (renameFailure.error) throw renameFailure.error
    return actual.renameSync(from, to)
  }
  return { ...actual, renameSync, default: { ...actual, renameSync } }
})

// ---------------------------------------------------------------------------
// Shared fake models.dev payload
// ---------------------------------------------------------------------------

/** Mirrors https://models.dev/api.json: { [providerId]: { id, name, models } }. */
const fakeCatalog: Record<string, unknown> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-4o-test': {
        id: 'gpt-4o-test',
        name: 'GPT-4o Test',
        cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 }
      },
      // No cache rates published — both cache rates must fall back to `input`.
      'gpt-nano-test': {
        id: 'gpt-nano-test',
        name: 'GPT Nano Test',
        cost: { input: 3, output: 12 }
      },
      // A free tier. On models.dev a 0 is a real, known price.
      'free-tier-llm-v1': {
        id: 'free-tier-llm-v1',
        name: 'Free Tier LLM',
        cost: { input: 0, output: 0 }
      }
    }
  },
  local: {
    id: 'local',
    name: 'Local',
    models: {
      // No cost field at all — skipped.
      'llama-3': { id: 'llama-3', name: 'Llama 3' }
    }
  }
}

/** A minimal stand-in for the parts of Response the SUT touches. */
function jsonResponse(
  body: unknown,
  opts: { status?: number; contentLength?: string; raw?: string } = {}
): Response {
  const text = opts.raw ?? JSON.stringify(body)
  const headers = new Headers()
  if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength)
  return {
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    headers,
    text: async () => text
  } as unknown as Response
}

/** Leftover atomic-write temp files in a directory (there must never be any). */
function tempFilesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
}

const oneMTokIn = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

import {
  refreshPrices,
  refreshPricesIfStale,
  loadPersistedPrices
} from '../../../core/services/opencode-pricing'
import { equivalentCostUsd, registerSupplementalPricing } from '../../../shared/pricing'

/** The SUT's PRICES_FILE, resolved under the mocked (temp) homedir. */
const PRICES_PATH = path.join(TEMP_HOME, '.claude', 'ui', 'opencode-prices.json')

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => jsonResponse(fakeCatalog))
  vi.stubGlobal('fetch', fetchMock)
  // Empty, not deleted: stubEnv restores whatever the developer's shell had.
  vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '')
  fs.rmSync(PRICES_PATH, { force: true })
  // Reset the SUT's "is the persisted file usable" flag, which a corrupt-file
  // test leaves false and refreshPricesIfStale reads. With no file present this
  // registers nothing and just sets the flag back to true.
  loadPersistedPrices()
})

afterEach(() => {
  // Clear supplemental pricing so we don't pollute other test suites
  registerSupplementalPricing([])
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  renameFailure.error = null
})

afterAll(() => {
  // Best-effort cleanup of the per-run temp home.
  try {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// ---------------------------------------------------------------------------
// refreshPrices — mapping
// ---------------------------------------------------------------------------

describe('opencode-pricing: refreshPrices mapping', () => {
  it('fetches models.dev once, with a timeout signal', async () => {
    await refreshPrices()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://models.dev/api.json')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns the priced-model count and a refreshedAt timestamp', async () => {
    const result = await refreshPrices()
    // 3 openai models carry a cost; llama-3 has none → 3 entries
    expect(result.count).toBe(3)
    expect(result.refreshedAt).toBeGreaterThan(0)
  })

  it('maps input/output rates via equivalentCostUsd', async () => {
    await refreshPrices()
    expect(equivalentCostUsd('openai', 'gpt-4o-test', oneMTokIn)).toBeCloseTo(2.5)
    expect(
      equivalentCostUsd('openai', 'gpt-4o-test', {
        ...oneMTokIn,
        inputTokens: 0,
        outputTokens: 1e6
      })
    ).toBeCloseTo(10)
  })

  it('maps published cache_read / cache_write rates', async () => {
    await refreshPrices()
    expect(
      equivalentCostUsd('openai', 'gpt-4o-test', {
        ...oneMTokIn,
        inputTokens: 0,
        cacheWriteTokens: 1e6
      })
    ).toBeCloseTo(2.5)
    expect(
      equivalentCostUsd('openai', 'gpt-4o-test', {
        ...oneMTokIn,
        inputTokens: 0,
        cacheReadTokens: 1e6
      })
    ).toBeCloseTo(1.25)
  })

  it('falls back to the input rate when no cache rates are published', async () => {
    await refreshPrices()
    // gpt-nano-test has input 3 and no cache_read/cache_write — both cache rates
    // must be 3, not 0: an unpublished discount is no discount.
    expect(
      equivalentCostUsd('openai', 'gpt-nano-test', {
        ...oneMTokIn,
        inputTokens: 0,
        cacheWriteTokens: 1e6
      })
    ).toBeCloseTo(3)
    expect(
      equivalentCostUsd('openai', 'gpt-nano-test', {
        ...oneMTokIn,
        inputTokens: 0,
        cacheWrite1hTokens: 1e6,
        cacheWriteTokens: 1e6
      })
    ).toBeCloseTo(3)
    expect(
      equivalentCostUsd('openai', 'gpt-nano-test', {
        ...oneMTokIn,
        inputTokens: 0,
        cacheReadTokens: 1e6
      })
    ).toBeCloseTo(3)
  })

  it('keeps a zero-priced model and resolves it to exactly 0, not null', async () => {
    await refreshPrices()
    // On models.dev a 0 list price means the model is free — a known 0.
    expect(equivalentCostUsd('openai', 'free-tier-llm-v1', oneMTokIn)).toBe(0)
  })

  it('skips a model with no cost field', async () => {
    await refreshPrices()
    expect(equivalentCostUsd('local', 'llama-3', oneMTokIn)).toBeNull()
  })

  it('skips a malformed provider or model without losing its neighbours', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        broken: null,
        alsoBroken: { id: 'alsoBroken', models: 'not-an-object' },
        arrayModels: { id: 'arrayModels', models: [] },
        partly: {
          id: 'partly',
          models: {
            'bad-cost-shape': { id: 'bad-cost-shape', cost: 'free' },
            'string-rates': { id: 'string-rates', cost: { input: '1', output: '2' } },
            'nan-rate': { id: 'nan-rate', cost: { input: Number.NaN, output: 2 } },
            'missing-output': { id: 'missing-output', cost: { input: 1 } },
            'good-model': { id: 'good-model', cost: { input: 4, output: 8 } }
          }
        }
      })
    )
    const result = await refreshPrices()
    expect(result.count).toBe(1)
    expect(equivalentCostUsd('partly', 'good-model', oneMTokIn)).toBeCloseTo(4)
    expect(equivalentCostUsd('partly', 'bad-cost-shape', oneMTokIn)).toBeNull()
    expect(equivalentCostUsd('partly', 'string-rates', oneMTokIn)).toBeNull()
  })

  it('lower-cases the model id so lookups match case-insensitively', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        vendorx: {
          id: 'vendorx',
          models: { 'Mixed-Case-Model': { cost: { input: 5, output: 5 } } }
        }
      })
    )
    await refreshPrices()
    expect(equivalentCostUsd('vendorx', 'Mixed-Case-Model', oneMTokIn)).toBeCloseTo(5)
  })
})

// ---------------------------------------------------------------------------
// refreshPrices — failures never destroy good prices
// ---------------------------------------------------------------------------

describe('opencode-pricing: refreshPrices failure modes', () => {
  /** Seed a good persisted file + registered table, and return the file bytes. */
  async function seedGoodPrices(): Promise<Buffer> {
    await refreshPrices()
    return fs.readFileSync(PRICES_PATH)
  }

  function expectPricesIntact(before: Buffer): void {
    expect(fs.readFileSync(PRICES_PATH).equals(before)).toBe(true)
    expect(equivalentCostUsd('openai', 'gpt-4o-test', oneMTokIn)).toBeCloseTo(2.5)
  }

  it('a thrown fetch leaves the file and the table intact, and returns count 0', async () => {
    const before = await seedGoodPrices()
    fetchMock.mockRejectedValue(new Error('network down'))

    const result = await refreshPrices()
    expect(result.count).toBe(0)
    expectPricesIntact(before)
  })

  it('a non-200 leaves the file and the table intact', async () => {
    const before = await seedGoodPrices()
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }))

    expect((await refreshPrices()).count).toBe(0)
    expectPricesIntact(before)
  })

  it('a body over 32 MB is refused before it is parsed', async () => {
    const before = await seedGoodPrices()
    fetchMock.mockResolvedValue(
      jsonResponse(null, { raw: 'x'.repeat(32 * 1024 * 1024 + 1), contentLength: undefined })
    )

    expect((await refreshPrices()).count).toBe(0)
    expectPricesIntact(before)
  })

  it('a declared content-length over 32 MB is refused without reading the body', async () => {
    const before = await seedGoodPrices()
    const text = vi.fn(async () => JSON.stringify(fakeCatalog))
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(64 * 1024 * 1024) }),
      text
    } as unknown as Response)

    expect((await refreshPrices()).count).toBe(0)
    expect(text).not.toHaveBeenCalled()
    expectPricesIntact(before)
  })

  it('unparseable JSON leaves the file and the table intact', async () => {
    const before = await seedGoodPrices()
    fetchMock.mockResolvedValue(jsonResponse(null, { raw: '{not json' }))

    expect((await refreshPrices()).count).toBe(0)
    expectPricesIntact(before)
  })

  it('an empty catalog leaves the file and the table intact', async () => {
    const before = await seedGoodPrices()
    fetchMock.mockResolvedValue(jsonResponse({}))

    expect((await refreshPrices()).count).toBe(0)
    expectPricesIntact(before)
  })

  it('a failed rename leaves the previous file byte-identical (atomic persist)', async () => {
    const before = await seedGoodPrices()
    // A DIFFERENT catalog, so a non-atomic write would be visible on disk.
    fetchMock.mockResolvedValue(
      jsonResponse({
        vendorx: { id: 'vendorx', models: { 'other-model': { cost: { input: 42, output: 84 } } } }
      })
    )
    renameFailure.error = new Error('EPERM')

    // The in-memory table still takes the fresh prices; only the disk copy is
    // left behind, and it is left COMPLETE rather than torn.
    const result = await refreshPrices()
    expect(result.count).toBe(1)
    expect(equivalentCostUsd('vendorx', 'other-model', oneMTokIn)).toBeCloseTo(42)
    expect(fs.readFileSync(PRICES_PATH).equals(before)).toBe(true)
    expect(tempFilesIn(path.dirname(PRICES_PATH))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// loadPersistedPrices — round-trip via the (temp-homedir) prices file
// ---------------------------------------------------------------------------

describe('opencode-pricing: persisted-file round-trip', () => {
  it('sanity: the prices file under test lives under os.tmpdir(), not the real home', () => {
    expect(PRICES_PATH.startsWith(os.tmpdir())).toBe(true)
  })

  it('persists compactly — no pretty-printing for ~7,400 entries', async () => {
    await refreshPrices()
    const raw = fs.readFileSync(PRICES_PATH, 'utf-8')
    expect(raw.includes('\n')).toBe(false)
  })

  it('leaves no temp file behind after a successful write', async () => {
    await refreshPrices()
    expect(tempFilesIn(path.dirname(PRICES_PATH))).toEqual([])
  })

  it('registers entries from a hand-written JSON file', () => {
    const entries = [
      {
        vendorId: 'test-vendor',
        match: 'my-model-x1',
        pricing: {
          inputPerMTok: 7,
          outputPerMTok: 28,
          cacheWritePerMTok: 7,
          cacheWrite1hPerMTok: 7,
          cacheReadPerMTok: 1.75
        }
      }
    ]
    fs.mkdirSync(path.dirname(PRICES_PATH), { recursive: true })
    fs.writeFileSync(PRICES_PATH, JSON.stringify(entries), 'utf-8')

    expect(loadPersistedPrices()).toBe(true)

    expect(equivalentCostUsd('test-vendor', 'my-model-x1', oneMTokIn)).toBeCloseTo(7)
  })

  it('refreshPrices → loadPersistedPrices full round-trip (write then re-read from disk)', async () => {
    await refreshPrices()
    // Simulate an app restart: wipe the in-memory table, reload from disk only.
    registerSupplementalPricing([])
    loadPersistedPrices()

    expect(equivalentCostUsd('openai', 'gpt-4o-test', oneMTokIn)).toBeCloseTo(2.5)
    // The free tier survives the round trip as a known 0.
    expect(equivalentCostUsd('openai', 'free-tier-llm-v1', oneMTokIn)).toBe(0)
  })

  it('reports a missing file as nothing-to-fix rather than a problem', () => {
    expect(loadPersistedPrices()).toBe(true)
  })

  it('reports a corrupt file as unusable, without throwing', () => {
    fs.mkdirSync(path.dirname(PRICES_PATH), { recursive: true })
    fs.writeFileSync(PRICES_PATH, '{ not json', 'utf-8')
    expect(loadPersistedPrices()).toBe(false)
  })

  it('reports a file that is not an entry array as unusable', () => {
    fs.mkdirSync(path.dirname(PRICES_PATH), { recursive: true })
    fs.writeFileSync(PRICES_PATH, '{"providers":[]}', 'utf-8')
    expect(loadPersistedPrices()).toBe(false)
  })

  it('reports an empty entry array as unusable — it prices nothing', () => {
    fs.mkdirSync(path.dirname(PRICES_PATH), { recursive: true })
    fs.writeFileSync(PRICES_PATH, '[]', 'utf-8')
    expect(loadPersistedPrices()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// refreshPricesIfStale
// ---------------------------------------------------------------------------

describe('opencode-pricing: refreshPricesIfStale', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  it('fetches when no catalog has ever been persisted', async () => {
    await refreshPricesIfStale()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fs.existsSync(PRICES_PATH)).toBe(true)
  })

  it('does not fetch when the persisted catalog is fresh', async () => {
    await refreshPrices()
    fetchMock.mockClear()

    await refreshPricesIfStale()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches when the persisted catalog is older than maxAgeMs', async () => {
    await refreshPrices()
    fetchMock.mockClear()
    const old = new Date(Date.now() - DAY_MS - 60_000)
    fs.utimesSync(PRICES_PATH, old, old)

    await refreshPricesIfStale()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('honours a caller-supplied max age', async () => {
    await refreshPrices()
    fetchMock.mockClear()

    await refreshPricesIfStale(0)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refetches a truncated file even though its mtime is fresh', async () => {
    // The exact failure atomic persist is there to prevent, arriving from
    // somewhere else (a disk that filled up under another writer, say). Without
    // the read-side check this file looks fresh and the app runs a day unpriced.
    fs.mkdirSync(path.dirname(PRICES_PATH), { recursive: true })
    fs.writeFileSync(PRICES_PATH, '[{"vendorId":"openai","match":"gpt-4o-te', 'utf-8')
    expect(loadPersistedPrices()).toBe(false)
    fetchMock.mockClear()

    await refreshPricesIfStale()
    expect(fetchMock).toHaveBeenCalledOnce()
    // And the refetch repairs the file.
    expect(loadPersistedPrices()).toBe(true)
  })

  // The gate reads cli.js's boolean-env semantics (envFlag), so only the values
  // cli.js treats as ON disable the fetch — `0` and `false` mean the user turned
  // it OFF, not that they set it.
  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('does nothing when the flag is %s', async (value) => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value)
    await refreshPricesIfStale()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fs.existsSync(PRICES_PATH)).toBe(false)
  })

  it.each(['0', 'false', ''])('still fetches when the flag is "%s"', async (value) => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value)
    await refreshPricesIfStale()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('never throws when the fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    await expect(refreshPricesIfStale()).resolves.toBeUndefined()
  })
})
