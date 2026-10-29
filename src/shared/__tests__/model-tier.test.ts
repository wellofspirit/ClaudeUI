import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_TIERS, modelTier } from '../model-tier'

describe('modelTier', () => {
  it.each([
    ['claude-fable-5-1', 'top'],
    ['claude-opus-5-5', 'high'],
    ['claude-sonnet-5-5', 'mid'],
    ['claude-haiku-4-5-20251001', 'low'],
    // Claude aliases
    ['opus', 'high'],
    ['sonnet[1m]', 'mid'],
    ['haiku', 'low'],
    // ChatGPT and pi ids
    ['gpt-6-sol', 'high'],
    ['gpt-6.1-sol', 'high'],
    ['gpt-5.6-sol', 'high'],
    ['openai/gpt-6-luna', 'low'],
    ['openai-codex/gpt-6-astra', 'top'],
    ['requesty/gpt-6-sol@eu', 'high'],
    ['mythos-1', 'top']
  ] as const)('%s is %s', (id, tier) => {
    expect(modelTier(id)).toBe(tier)
  })

  it.each([
    'opusplan',
    'gpt-5.6-terra',
    'deepseek/deepseek-v4-flash',
    'solar-pro',
    'lunaris',
    'console',
    'consolidated',
    '<synthetic>',
    'default',
    ''
  ])('%j has no tier', (id) => {
    expect(modelTier(id)).toBeUndefined()
  })

  it('has no tier for no model', () => {
    expect(modelTier(undefined)).toBeUndefined()
  })

  it('ignores case', () => {
    expect(modelTier('Claude-OPUS-5-5')).toBe('high')
  })

  it('reads the model of provider/model#variant, with the family in the model part', () => {
    expect(modelTier('openai/gpt-6-sol#high')).toBe('high')
    expect(modelTier('anthropic/claude-haiku-4-5#low')).toBe('low')
    expect(modelTier('zen/some-sol-model:free')).toBe('high')
  })

  it('does not take the provider for a family', () => {
    expect(modelTier('sol/deepseek-v4')).toBeUndefined()
    expect(modelTier('astra/gpt-6-luna')).toBe('low')
  })

  it('takes the first family token when an id names two', () => {
    expect(modelTier('opus-sonnet-mix')).toBe('high')
  })

  it('lists the four tiers, top first', () => {
    expect(MODEL_TIERS).toEqual(['top', 'high', 'mid', 'low'])
  })
})

// Contrast of one colour on one background, WCAG 2.x.
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('the model tier tokens in app.css', () => {
  const css = readFileSync(join(__dirname, '../../renderer/src/assets/app.css'), 'utf8')
  const light = css.slice(
    css.indexOf("[data-theme='light']"),
    css.indexOf("[data-theme='monokai']")
  )
  const dark = css.slice(0, css.indexOf("[data-theme='light']"))
  const token = (block: string, name: string): string => {
    const m = block.match(new RegExp(`--color-${name}: (#[0-9a-f]{6});`))
    expect(m, `--color-${name}`).not.toBeNull()
    return m![1]
  }

  it('pins every tier in the dark theme, and gives the light theme its own', () => {
    expect(MODEL_TIERS.map((t) => token(dark, `model-tier-${t}`))).toEqual([
      '#ff8000',
      '#b866f5',
      '#3d95ff',
      '#1eff00'
    ])
    for (const tier of MODEL_TIERS) {
      expect(token(light, `model-tier-${tier}`)).not.toBe(token(dark, `model-tier-${tier}`))
    }
  })

  const monokaiBlock = css.slice(css.indexOf("[data-theme='monokai']"), css.indexOf('body {'))

  it('gives the monokai theme its own values, in the same four hues', () => {
    expect(MODEL_TIERS.map((t) => token(monokaiBlock, `model-tier-${t}`))).toEqual([
      '#ffa447',
      '#d7a9f9',
      '#85bcff',
      '#1eff00'
    ])
  })

  // The name sits on the panel (bg-secondary; bg-input when selected, bg-hover when
  // hovered), the model chip on bg-tertiary: every theme holds 4.5:1 on all four.
  const ALL = ['bg-secondary', 'bg-tertiary', 'bg-input', 'bg-hover']
  const themes = [
    ['dark', dark, dark, ALL],
    ['light', light, light, ALL],
    ['monokai', monokaiBlock, monokaiBlock, ALL]
  ] as const
  it.each(themes)('holds 4.5:1 on the %s theme surfaces', (_name, tokens, surfaces, names) => {
    for (const tier of MODEL_TIERS) {
      const colour = token(tokens, `model-tier-${tier}`)
      for (const surface of names) {
        const ratio = contrast(colour, token(surfaces, surface))
        expect(ratio, `${tier} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
