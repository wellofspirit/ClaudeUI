/**
 * @vitest-environment node
 *
 * Anti-re-duplication guard for the Anthropic pricing table (BD-h).
 *
 * History: `block-usage.ts` used to carry its own byte-identical copy of
 * `shared/pricing.ts`'s ANTHROPIC_PRICING, and this file source-scraped both
 * copies to assert they still agreed. block-usage now DERIVES its table from
 * the shared one (`ANTHROPIC_MODEL_PRICING`), so drift is structurally
 * impossible and the value-equality scrape is obsolete — the rates themselves
 * are covered by `src/shared/__tests__/pricing.test.ts` and by
 * `block-usage.test.ts`, which now imports the real derived table.
 *
 * What remains worth guarding is that nobody re-introduces a literal table
 * here. That is a source-level property, so this test still reads the source
 * rather than importing block-usage (which drags in the DB/usage stack).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BLOCK_USAGE_TS = resolve(__dirname, '../../../core/services/block-usage.ts')

describe('Anthropic pricing table — single source of truth', () => {
  const blockUsageSrc = readFileSync(BLOCK_USAGE_TS, 'utf-8')

  it('block-usage.ts derives its table from shared/pricing.ts', () => {
    expect(blockUsageSrc).toMatch(
      /import\s*\{[^}]*\bANTHROPIC_MODEL_PRICING\b[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/pricing'/
    )
    expect(blockUsageSrc).toMatch(/const MODEL_PRICING = ANTHROPIC_MODEL_PRICING/)
  })

  it('block-usage.ts declares no per-model rate literals of its own', () => {
    // Exactly one `inputPerMTok:` may appear — DEFAULT_PRICING, the sonnet-tier
    // fallback for models absent from the table (deliberately local: it is not
    // a model entry and has no counterpart in shared/pricing.ts). Any further
    // occurrence means a model table was pasted back in.
    const rateLiterals = blockUsageSrc.match(/\binputPerMTok:/g) ?? []
    expect(
      rateLiterals.length,
      'block-usage.ts must not re-declare model rates — extend shared/pricing.ts instead'
    ).toBe(1)
    expect(blockUsageSrc).toMatch(/const DEFAULT_PRICING: ModelPricing = \{/)
  })
})
