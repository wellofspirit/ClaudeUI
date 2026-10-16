/**
 * Layer 2b: the status dot's colours as the browser resolves them, per theme —
 * real Chromium, real Tailwind. The unit test pins the rules in app.css; this
 * proves the themed tokens they name (`--color-success`, `--color-danger`,
 * `--color-dot-inactive`) reach the element, so the dot is not a fixed colour.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { StatusDot, type SessionDotState } from '../StatusDot'

const colourOf = (state: SessionDotState): string => {
  const { container, unmount } = render(<StatusDot state={state} runningSubagents={0} />)
  const colour = getComputedStyle(container.querySelector('.status-dot')!).backgroundColor
  unmount()
  return colour
}

describe('StatusDot colours per theme', () => {
  afterEach(() => {
    cleanup()
    delete document.documentElement.dataset.theme
  })

  it.each([
    ['dark', 'running', 'rgb(74, 222, 128)'],
    ['dark', 'failed', 'rgb(248, 113, 113)'],
    ['dark', 'inactive', 'rgb(107, 114, 128)'],
    ['light', 'running', 'rgb(21, 128, 61)'],
    ['light', 'idle', 'rgb(21, 128, 61)'],
    ['light', 'failed', 'rgb(185, 28, 28)'],
    ['light', 'subagents', 'rgb(124, 58, 237)'],
    ['light', 'watching', 'rgb(37, 99, 235)'],
    ['light', 'inactive', 'rgb(107, 114, 128)'],
    ['monokai', 'running', 'rgb(166, 226, 46)'],
    ['monokai', 'inactive', 'rgb(139, 136, 120)']
  ] as const)('%s %s is %s', (theme, state, expected) => {
    if (theme === 'dark') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    expect(colourOf(state)).toBe(expected)
  })
})
