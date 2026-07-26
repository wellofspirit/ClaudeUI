/**
 * @vitest-environment node
 *
 * DRY drift guard for the Anthropic pricing table.
 *
 * The equivalent-cost pricing for Anthropic models is declared in TWO places:
 *   - `src/shared/pricing.ts`         → ANTHROPIC_PRICING (the shared, authoritative table)
 *   - `src/main/services/block-usage.ts` → MODEL_PRICING (block-usage's own copy)
 *
 * They agree today, but nothing enforces it — a future price change applied to
 * one and not the other silently diverges cost accounting between the two code
 * paths. Deduping the tables at runtime is the "proper" fix but changes a hot
 * path; per the audit this guard is the low-risk alternative.
 *
 * This test parses both source files (no runtime import of block-usage, which
 * drags in the DB/usage stack) and asserts the Anthropic subset is byte-for-byte
 * equal by `match` key. If it fails, reconcile the two tables — do not just bump
 * this test.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PRICING_TS = resolve(__dirname, '../../../shared/pricing.ts')
const BLOCK_USAGE_TS = resolve(__dirname, '../block-usage.ts')

interface Rates {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok: number
  cacheWrite1hPerMTok: number
  cacheReadPerMTok: number
}

/** Slice the source between a start marker and the next end marker. */
function sliceBetween(src: string, start: string, end: string): string {
  const s = src.indexOf(start)
  if (s === -1) throw new Error(`marker not found: ${start}`)
  const e = src.indexOf(end, s + start.length)
  return src.slice(s, e === -1 ? undefined : e)
}

/** Extract `{ match: 'x', pricing: { ...5 numeric fields... } }` entries, order-independent. */
function extractRates(region: string): Record<string, Rates> {
  const out: Record<string, Rates> = {}
  const blockRe = /match:\s*'([^']+)',\s*pricing:\s*\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(region))) {
    const body = m[2]
    const num = (name: string): number => {
      const fm = body.match(new RegExp(`\\b${name}:\\s*([\\d.]+)`))
      if (!fm) throw new Error(`field ${name} missing for match '${m![1]}'`)
      return Number(fm[1])
    }
    out[m[1]] = {
      inputPerMTok: num('inputPerMTok'),
      outputPerMTok: num('outputPerMTok'),
      cacheWritePerMTok: num('cacheWritePerMTok'),
      cacheWrite1hPerMTok: num('cacheWrite1hPerMTok'),
      cacheReadPerMTok: num('cacheReadPerMTok')
    }
  }
  return out
}

describe('Anthropic pricing table drift guard', () => {
  const pricingSrc = readFileSync(PRICING_TS, 'utf-8')
  const blockUsageSrc = readFileSync(BLOCK_USAGE_TS, 'utf-8')

  const shared = extractRates(
    sliceBetween(pricingSrc, 'const ANTHROPIC_PRICING', 'const OPENAI_PRICING')
  )
  const blockUsage = extractRates(
    sliceBetween(blockUsageSrc, 'const MODEL_PRICING', 'const DEFAULT_PRICING')
  )

  it('parsed a non-trivial number of entries from both files (non-vacuity)', () => {
    // Guards against the regex silently matching nothing (which would make the
    // equality assertion below vacuously pass).
    expect(Object.keys(shared).length).toBeGreaterThanOrEqual(10)
    expect(Object.keys(blockUsage).length).toBeGreaterThanOrEqual(10)
    expect(shared['sonnet']).toBeDefined()
    expect(blockUsage['sonnet']).toBeDefined()
  })

  it('block-usage.ts MODEL_PRICING matches shared/pricing.ts ANTHROPIC_PRICING exactly', () => {
    // Same set of model families...
    expect(Object.keys(blockUsage).sort()).toEqual(Object.keys(shared).sort())
    // ...and identical rates for each.
    for (const key of Object.keys(blockUsage)) {
      expect(blockUsage[key], `rates for '${key}' diverged between the two tables`).toEqual(
        shared[key]
      )
    }
  })
})
