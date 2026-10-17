import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The status dot (`.status-dot`, the sidebar's session dot and the agent roster's
 * rows) is a graphic: every state holds 3:1 against the panel in every theme. The
 * dot colours are read out of app.css the way the browser resolves them, per theme.
 */
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

const css = readFileSync(join(__dirname, '../../renderer/src/assets/app.css'), 'utf8')
const lightAt = css.indexOf("[data-theme='light'] {")
const monokaiAt = css.indexOf("[data-theme='monokai'] {")
const bodyAt = css.indexOf('body {')
const BLOCKS = {
  dark: css.slice(0, lightAt),
  light: css.slice(lightAt, monokaiAt),
  monokai: css.slice(monokaiAt, bodyAt)
} as const
type Theme = keyof typeof BLOCKS

/** A theme token: the theme's own value, else the dark one (Monokai and light inherit what they do not set). */
function token(theme: Theme, name: string): string {
  const re = new RegExp(`--color-${name}: (#[0-9a-f]{6});`)
  const hit = BLOCKS[theme].match(re) ?? BLOCKS.dark.match(re)
  expect(hit, `--color-${name} in ${theme}`).not.toBeNull()
  return hit![1]
}

/** What `--dot-color` is for a state: a hex written in a rule, or a `var(--color-x)` the theme resolves. */
function dotColour(theme: Theme, state: string): string {
  const ruleFor = (selector: string): string | undefined =>
    css.match(
      new RegExp(`${selector.replace(/[[\]'.]/g, '\\$&')}[^{]*\\{[^}]*--dot-color: ([^;]+);`)
    )?.[1]
  const themed =
    theme === 'light'
      ? ruleFor(`[data-theme='light'] .status-dot[data-state='${state}']`)
      : undefined
  const value = themed ?? ruleFor(`.status-dot[data-state='${state}']`)
  expect(value, `--dot-color of ${state}`).toBeDefined()
  const variable = value!.match(/^var\(--color-([\w-]+)\)$/)
  return variable ? token(theme, variable[1]) : value!
}

// 'running' and 'idle' share a rule with a selector list, so match them through `idle`.
const STATES = [
  'running',
  'idle',
  'subagents',
  'attention',
  'watching',
  'inactive',
  'failed'
] as const

describe('the status dot colours in app.css', () => {
  it('draws running and idle in the theme’s success colour, not a fixed green', () => {
    for (const theme of ['dark', 'light', 'monokai'] as const) {
      expect(dotColour(theme, 'running')).toBe(token(theme, 'success'))
      expect(dotColour(theme, 'idle')).toBe(token(theme, 'success'))
    }
    expect(css).not.toMatch(/--dot-color: #4ade80/)
  })

  it('draws a failed agent in the theme’s danger colour', () => {
    for (const theme of ['dark', 'light', 'monokai'] as const) {
      expect(dotColour(theme, 'failed')).toBe(token(theme, 'danger'))
    }
  })

  it.each(['dark', 'light', 'monokai'] as const)(
    'holds 3:1 on the %s panel, for every state',
    (theme) => {
      for (const surface of ['bg-secondary', 'bg-primary']) {
        for (const state of STATES) {
          const ratio = contrast(dotColour(theme, state), token(theme, surface))
          expect(ratio, `${state} on ${theme} ${surface}`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  )
})
