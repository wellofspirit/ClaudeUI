/**
 * @vitest-environment node
 *
 * Phase 9b — opencode-pricing.ts unit tests.
 *
 * Tests:
 *  1. refreshPrices maps a fake getConfigProviders payload to PricingEntry[] +
 *     calls registerSupplementalPricing so equivalentCostUsd resolves the model.
 *  2. persisted-file round-trip: refreshPrices writes to disk; loadPersistedPrices
 *     reads it back and registers prices without a server.
 *  3. registerSupplementalPricing integration via the refreshPrices path.
 *  4. Best-effort: server failures return { count: 0 } without throwing.
 *
 * Isolation: the SUT's PRICES_FILE is a module-level const derived from
 * os.homedir() at import time. We mock 'os' so homedir() resolves to a per-run
 * temp dir — these tests must NEVER touch the developer's real
 * ~/.claude/ui/opencode-prices.json (refreshPrices persists on every call).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be at top level so vi.hoisted runs before any imports
// ---------------------------------------------------------------------------

const { mockAcquire, mockRelease, mockGetConfigProviders, TEMP_HOME } = vi.hoisted(() => {
  // Hoisted code runs before ESM imports resolve, so use process.getBuiltinModule
  // (Node 22.3+) to reach the REAL fs/os/path for the temp-dir setup.
  const realFs = process.getBuiltinModule('fs')
  const realOs = process.getBuiltinModule('os')
  const realPath = process.getBuiltinModule('path')
  return {
    mockAcquire: vi.fn(),
    mockRelease: vi.fn(),
    mockGetConfigProviders: vi.fn(),
    TEMP_HOME: realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'opencode-prices-test-'))
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

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: mockAcquire, release: mockRelease }
}))

vi.mock('../../../core/opencode/OpencodeClient', () => ({
  OpencodeClient: class {
    getConfigProviders() {
      return mockGetConfigProviders()
    }
  }
}))

vi.mock('../../../core/services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted-sessions-pricing-test'
}))

// ---------------------------------------------------------------------------
// Shared fake providers payload
// ---------------------------------------------------------------------------

const fakePaidProvider = {
  id: 'openai',
  name: 'OpenAI',
  source: 'env' as const,
  env: [],
  options: {},
  models: {
    'gpt-4o-test': {
      id: 'gpt-4o-test', providerID: 'openai',
      api: { id: 'openai', url: '', npm: '' },
      name: 'GPT-4o Test', family: 'gpt-4o',
      capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false } },
      cost: { input: 2.5, output: 10.0, cache: { read: 1.25, write: 2.5 } }
    },
    'free-tier-llm-v1': {
      id: 'free-tier-llm-v1', providerID: 'openai',
      api: { id: 'openai', url: '', npm: '' },
      name: 'Free Tier LLM', family: 'free',
      capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: false,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false } },
      cost: { input: 0, output: 0 } // free model — 0 is a valid real cost
    }
  }
}

const fakeNoCostProvider = {
  id: 'local',
  name: 'Local',
  source: 'env' as const,
  env: [],
  options: {},
  models: {
    'llama-3': {
      id: 'llama-3', providerID: 'local',
      api: { id: 'local', url: '', npm: '' },
      name: 'Llama 3', family: 'llama',
      capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: false,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false } }
      // No cost field — should be skipped
    }
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

import { refreshPrices, loadPersistedPrices } from '../../../core/services/opencode-pricing'
import { equivalentCostUsd, registerSupplementalPricing } from '../../../shared/pricing'

/** The SUT's PRICES_FILE, resolved under the mocked (temp) homedir. */
const PRICES_PATH = path.join(TEMP_HOME, '.claude', 'ui', 'opencode-prices.json')

beforeEach(() => {
  mockAcquire.mockResolvedValue({ baseUrl: 'http://localhost:9999', authHeader: 'Bearer test' })
  mockRelease.mockReturnValue(undefined)
  mockGetConfigProviders.mockResolvedValue({
    providers: [fakePaidProvider, fakeNoCostProvider]
  })
})

afterEach(() => {
  // Clear supplemental pricing so we don't pollute other test suites
  registerSupplementalPricing([])
  vi.clearAllMocks()
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
// refreshPrices — mapping and count
// ---------------------------------------------------------------------------

describe('opencode-pricing: refreshPrices', () => {
  it('returns count=1 (models with a non-zero cost) and a refreshedAt timestamp', async () => {
    const result = await refreshPrices()
    // gpt-4o-test has non-zero cost; free-tier-llm-v1 is $0/$0 (filtered — see
    // isZeroCost); llama-3 has no cost field at all → 1 entry
    expect(result.count).toBe(1)
    expect(typeof result.refreshedAt).toBe('number')
    expect(result.refreshedAt).toBeGreaterThan(0)
  })

  it('maps paid model to correct rates via equivalentCostUsd', async () => {
    await refreshPrices()
    const cost = equivalentCostUsd('openai', 'gpt-4o-test', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0
    })
    expect(cost).toBeCloseTo(2.5)
  })

  it('skips a $0/$0 model (cost.input=0, cost.output=0) — produces NO entry', async () => {
    await refreshPrices()
    // free-tier-llm-v1 has cost {input:0, output:0} — a $0 list price carries no
    // estimation signal (see isZeroCost) so it must not be registered at all;
    // equivalentCostUsd falls through to null, not a poisoned 0.
    const cost = equivalentCostUsd('openai', 'free-tier-llm-v1', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0
    })
    expect(cost).toBeNull()
  })

  it('skips models without a cost field (llama-3 → not registered)', async () => {
    await refreshPrices()
    const cost = equivalentCostUsd('local', 'llama-3', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0
    })
    expect(cost).toBeNull()
  })

  it('maps cache fields correctly', async () => {
    await refreshPrices()
    // gpt-4o-test: cache.read=1.25, cache.write=2.5
    const cost = equivalentCostUsd('openai', 'gpt-4o-test', {
      inputTokens: 0, outputTokens: 0,
      cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 0, cacheReadTokens: 0
    })
    expect(cost).toBeCloseTo(2.5) // cacheWritePerMTok = cache.write = 2.5
  })

  it('acquires and releases the opencode server', async () => {
    await refreshPrices()
    expect(mockAcquire).toHaveBeenCalledOnce()
    expect(mockRelease).toHaveBeenCalledOnce()
  })

  it('releases server even when getConfigProviders throws', async () => {
    mockGetConfigProviders.mockRejectedValue(new Error('network error'))
    const result = await refreshPrices()
    expect(result.count).toBe(0)
    expect(mockRelease).toHaveBeenCalledOnce()
  })

  it('best-effort: acquire failure → { count: 0 } without throwing', async () => {
    mockAcquire.mockRejectedValue(new Error('binary not found'))
    const result = await refreshPrices()
    expect(result.count).toBe(0)
    expect(typeof result.refreshedAt).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// loadPersistedPrices — round-trip via the (temp-homedir) prices file
// ---------------------------------------------------------------------------

describe('opencode-pricing: persisted-file round-trip', () => {
  beforeEach(() => {
    // Isolate from the refreshPrices tests above (they persist to the same file).
    fs.rmSync(PRICES_PATH, { force: true })
  })

  it('sanity: the prices file under test lives under os.tmpdir(), not the real home', () => {
    expect(PRICES_PATH.startsWith(os.tmpdir())).toBe(true)
  })

  it('loadPersistedPrices registers entries from a hand-written JSON file', () => {
    const entries = [
      {
        vendorId: 'test-vendor',
        match: 'my-model-x1',
        pricing: {
          inputPerMTok: 7, outputPerMTok: 28,
          cacheWritePerMTok: 7, cacheWrite1hPerMTok: 7, cacheReadPerMTok: 1.75
        }
      }
    ]
    fs.mkdirSync(path.dirname(PRICES_PATH), { recursive: true })
    fs.writeFileSync(PRICES_PATH, JSON.stringify(entries), 'utf-8')

    loadPersistedPrices()

    const cost = equivalentCostUsd('test-vendor', 'my-model-x1', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0
    })
    expect(cost).toBeCloseTo(7.0)
  })

  it('refreshPrices → loadPersistedPrices full round-trip (write then re-read from disk)', async () => {
    await refreshPrices()
    // Simulate an app restart: wipe the in-memory table, reload from disk only.
    registerSupplementalPricing([])
    loadPersistedPrices()

    const cost = equivalentCostUsd('openai', 'gpt-4o-test', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0
    })
    expect(cost).toBeCloseTo(2.5)
  })

  it('loadPersistedPrices is a no-op when the file does not exist', () => {
    // Should not throw even when the prices file is absent
    expect(() => loadPersistedPrices()).not.toThrow()
  })

  it('self-heals a poisoned persisted file — drops a $0/$0 entry on load, keeps a paid entry', () => {
    const poisoned = [
      {
        vendorId: 'openai',
        match: 'poisoned-zero-cost-model',
        pricing: {
          inputPerMTok: 0, outputPerMTok: 0,
          cacheWritePerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0
        }
      },
      {
        vendorId: 'openai',
        match: 'legit-paid-model',
        pricing: {
          inputPerMTok: 2.5, outputPerMTok: 10,
          cacheWritePerMTok: 2.5, cacheWrite1hPerMTok: 2.5, cacheReadPerMTok: 1.25
        }
      }
    ]
    fs.mkdirSync(path.dirname(PRICES_PATH), { recursive: true })
    fs.writeFileSync(PRICES_PATH, JSON.stringify(poisoned), 'utf-8')

    loadPersistedPrices()

    const zeroCost = equivalentCostUsd('openai', 'poisoned-zero-cost-model', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0
    })
    expect(zeroCost).toBeNull()

    const paidCost = equivalentCostUsd('openai', 'legit-paid-model', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0
    })
    expect(paidCost).toBeCloseTo(2.5)
  })
})
