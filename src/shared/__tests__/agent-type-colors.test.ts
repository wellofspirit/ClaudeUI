import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_COLOR_IDS,
  DEFAULT_SUBAGENT_TYPE,
  agentColorOverride,
  dispatchTileTitle,
  hasTypeTile,
  isAgentColorId,
  isDefaultSubagentType,
  nearestPaletteColor,
  resolveAgentTypeColor,
  stableHashColor,
  tileLetter,
  withAgentColorOverride
} from '../agent-type-colors'
import type { EngineId } from '../types'

const ENGINES: EngineId[] = ['claude', 'opencode', 'pi', 'codex']

describe('the default type has no tile', () => {
  it('is general-purpose / general / general-purpose / default per engine', () => {
    expect(DEFAULT_SUBAGENT_TYPE).toEqual({
      claude: 'general-purpose',
      opencode: 'general',
      pi: 'general-purpose',
      codex: 'default'
    })
  })

  it('recognises each engine its own default, ignoring case and padding', () => {
    expect(isDefaultSubagentType('claude', 'general-purpose')).toBe(true)
    expect(isDefaultSubagentType('claude', ' General-Purpose ')).toBe(true)
    expect(isDefaultSubagentType('pi', 'general-purpose')).toBe(true)
    expect(isDefaultSubagentType('opencode', 'general')).toBe(true)
    expect(isDefaultSubagentType('codex', 'default')).toBe(true)
  })

  it('does not cross engines: opencode `general` is a custom type on Claude', () => {
    expect(isDefaultSubagentType('claude', 'general')).toBe(false)
    expect(isDefaultSubagentType('opencode', 'general-purpose')).toBe(false)
    expect(isDefaultSubagentType('codex', 'general-purpose')).toBe(false)
    for (const engine of ENGINES) expect(isDefaultSubagentType(engine, 'Explore')).toBe(false)
  })

  it('treats an unknown engine as Claude', () => {
    expect(isDefaultSubagentType(undefined, 'general-purpose')).toBe(true)
  })
})

describe('hasTypeTile', () => {
  it('is false for no type, the default, and a comma list (pi legacy parallel subagents)', () => {
    expect(hasTypeTile('pi', undefined)).toBe(false)
    expect(hasTypeTile('pi', '')).toBe(false)
    expect(hasTypeTile('pi', 'general-purpose')).toBe(false)
    expect(hasTypeTile('pi', 'scout, planner')).toBe(false)
    expect(hasTypeTile('pi', 'scout,planner')).toBe(false)
  })

  it('is true for one custom type', () => {
    expect(hasTypeTile('pi', 'scout')).toBe(true)
    expect(hasTypeTile('opencode', 'general-purpose')).toBe(true)
  })
})

describe('tileLetter', () => {
  it('is the initial, uppercased', () => {
    expect(tileLetter('Explore')).toBe('E')
    expect(tileLetter('migration-reviewer')).toBe('M')
    expect(tileLetter('plan')).toBe('P')
  })

  it('skips leading punctuation and keeps digits', () => {
    expect(tileLetter('  _scan')).toBe('S')
    expect(tileLetter('9lives')).toBe('9')
  })

  it('falls back for an empty or symbol-only name', () => {
    expect(tileLetter('')).toBe('?')
    expect(tileLetter('--')).toBe('-')
  })
})

describe('dispatchTileTitle', () => {
  it('reads `Dispatch -> <engine> · <model>`', () => {
    expect(dispatchTileTitle({ engine: 'opencode', model: 'deepseek-v4' })).toBe(
      'Dispatch → opencode · deepseek-v4'
    )
    expect(dispatchTileTitle({ engine: 'pi' })).toBe('Dispatch → pi')
  })
})

describe('nearestPaletteColor', () => {
  it.each([
    ['red', 'rose'],
    ['blue', 'sky'],
    ['green', 'green'],
    ['yellow', 'amber'],
    ['purple', 'violet'],
    ['orange', 'orange'],
    ['pink', 'pink'],
    ['cyan', 'teal']
  ])("maps Claude Code's %s to %s", (name, expected) => {
    expect(nearestPaletteColor(name)).toBe(expected)
  })

  it("maps Claude Code's eight names to eight DISTINCT palette colours, all of them", () => {
    const names = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']
    const mapped = names.map((name) => nearestPaletteColor(name))
    expect(new Set(mapped).size).toBe(8)
    // A bijection: every palette colour is reachable from a native name.
    expect([...mapped].sort()).toEqual([...AGENT_COLOR_IDS].sort())
  })

  // The six swatches opencode's agent editor offers (OpencodeAgents.tsx PRESET_COLORS).
  it.each([
    ['#f59e0b', 'amber'],
    // Hex is by hue, not one-to-one: cyan-ish and blue-ish presets share sky.
    ['#22d3ee', 'sky'],
    ['#a78bfa', 'violet'],
    ['#4ade80', 'green'],
    ['#f87171', 'rose'],
    ['#60a5fa', 'sky']
  ])('maps the opencode preset %s to %s', (hex, expected) => {
    expect(nearestPaletteColor(hex)).toBe(expected)
  })

  it('reads three-digit hex, mixed case and quoted names', () => {
    expect(nearestPaletteColor('#0F0')).toBe('green')
    expect(nearestPaletteColor('"Purple"')).toBe('violet')
    expect(nearestPaletteColor(' CYAN ')).toBe('teal')
  })

  it('ignores a trailing YAML comment after the colour', () => {
    expect(nearestPaletteColor('purple  # the reviewer')).toBe('violet')
    expect(nearestPaletteColor('"cyan" # note')).toBe('teal')
    expect(nearestPaletteColor('#22d3ee # note')).toBe('sky')
  })

  it("maps opencode's theme names", () => {
    expect(nearestPaletteColor('success')).toBe('green')
    expect(nearestPaletteColor('error')).toBe('rose')
  })

  it('has no answer for a grey or an unreadable colour', () => {
    expect(nearestPaletteColor('#888888')).toBeUndefined()
    expect(nearestPaletteColor('chartreuse-ish')).toBeUndefined()
    expect(nearestPaletteColor('')).toBeUndefined()
  })

  it('maps every palette hue to itself', () => {
    // The dark-theme hexes of main.css: a palette colour is its own nearest.
    const dark: Record<string, string> = {
      sky: '#4fc3e8',
      violet: '#b28bf0',
      green: '#7bc47f',
      orange: '#f0965a',
      rose: '#f2708a',
      amber: '#e3c45a',
      teal: '#3fcfb4',
      pink: '#ec82c8'
    }
    for (const id of AGENT_COLOR_IDS) expect(nearestPaletteColor(dark[id])).toBe(id)
  })
})

describe('stableHashColor', () => {
  it('is stable and always a palette colour', () => {
    for (const type of ['Explore', 'migration-reviewer', 'x', '日本語', '']) {
      const a = stableHashColor(type)
      expect(AGENT_COLOR_IDS).toContain(a)
      expect(stableHashColor(type)).toBe(a)
    }
  })

  it('ignores case and padding, and does not collapse onto one colour', () => {
    expect(stableHashColor('  EXPLORE ')).toBe(stableHashColor('explore'))
    const used = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((n) =>
        stableHashColor(`agent-${n}`)
      )
    )
    expect(used.size).toBeGreaterThan(3)
  })
})

describe('resolveAgentTypeColor', () => {
  it('prefers the override over the native colour and the hash', () => {
    expect(resolveAgentTypeColor('Explore', { override: 'pink', native: 'blue' })).toBe('pink')
  })

  it('falls to the native colour, mapped to the nearest palette colour', () => {
    expect(resolveAgentTypeColor('Explore', { native: 'blue' })).toBe('sky')
  })

  it('falls to the hash with neither, or with an unusable native colour', () => {
    expect(resolveAgentTypeColor('Explore')).toBe(stableHashColor('Explore'))
    expect(resolveAgentTypeColor('Explore', { native: '#888' })).toBe(stableHashColor('Explore'))
  })

  it('ignores an override that is not a palette id (a hand-edited settings file)', () => {
    expect(resolveAgentTypeColor('Explore', { override: '#ff0000', native: 'green' })).toBe('green')
    expect(isAgentColorId('#ff0000')).toBe(false)
  })
})

describe('agentColorOverride', () => {
  const overrides = { opencode: { explore: 'teal', bad: 'chartreuse' } }

  it("reads the engine's own table", () => {
    expect(agentColorOverride(overrides, 'opencode', 'explore')).toBe('teal')
    expect(agentColorOverride(overrides, 'claude', 'explore')).toBeUndefined()
  })

  it('matches the type name case-insensitively, exact first', () => {
    // An `Explore` override colours a pi transcript's `explore`.
    expect(agentColorOverride({ pi: { Explore: 'pink' } }, 'pi', 'explore')).toBe('pink')
    expect(agentColorOverride({ pi: { explore: 'teal' } }, 'pi', 'EXPLORE')).toBe('teal')
    // Both present: the exact spelling wins.
    const both = { pi: { Explore: 'pink', explore: 'teal' } }
    expect(agentColorOverride(both, 'pi', 'explore')).toBe('teal')
    expect(agentColorOverride(both, 'pi', 'Explore')).toBe('pink')
    // Still per engine.
    expect(agentColorOverride({ pi: { Explore: 'pink' } }, 'claude', 'explore')).toBeUndefined()
  })

  it('drops a non-palette value and tolerates no settings at all', () => {
    expect(agentColorOverride(overrides, 'opencode', 'bad')).toBeUndefined()
    expect(agentColorOverride(undefined, 'pi', 'x')).toBeUndefined()
  })
})

describe('withAgentColorOverride', () => {
  it('sets one type for one engine without touching the others', () => {
    const before = { claude: { Explore: 'sky' }, pi: { Plan: 'rose' } }
    const after = withAgentColorOverride(before, 'claude', 'reviewer', 'pink')
    expect(after).toEqual({ claude: { Explore: 'sky', reviewer: 'pink' }, pi: { Plan: 'rose' } })
    // Pure: the input is untouched.
    expect(before).toEqual({ claude: { Explore: 'sky' }, pi: { Plan: 'rose' } })
  })

  it('replaces an existing override', () => {
    expect(withAgentColorOverride({ pi: { Plan: 'rose' } }, 'pi', 'Plan', 'teal')).toEqual({
      pi: { Plan: 'teal' }
    })
  })

  it('clears one type, pruning the engine and then the whole key when they empty', () => {
    expect(
      withAgentColorOverride({ claude: { a: 'sky', b: 'rose' } }, 'claude', 'a', undefined)
    ).toEqual({ claude: { b: 'rose' } })
    expect(
      withAgentColorOverride({ claude: { a: 'sky' }, pi: { b: 'rose' } }, 'claude', 'a', undefined)
    ).toEqual({ pi: { b: 'rose' } })
    expect(
      withAgentColorOverride({ claude: { a: 'sky' } }, 'claude', 'a', undefined)
    ).toBeUndefined()
  })

  it('clearing from nothing is nothing', () => {
    expect(withAgentColorOverride(undefined, 'codex', 'worker', undefined)).toBeUndefined()
  })
})

describe('the palette tokens in main.css', () => {
  it('defines every palette colour for the dark and the light theme', () => {
    const css = readFileSync(join(__dirname, '../../renderer/src/assets/main.css'), 'utf8')
    const light = css.slice(
      css.indexOf("[data-theme='light']"),
      css.indexOf("[data-theme='monokai']")
    )
    const dark = css.slice(0, css.indexOf("[data-theme='light']"))
    for (const id of AGENT_COLOR_IDS) {
      expect(dark, `dark --color-agent-${id}`).toMatch(
        new RegExp(`--color-agent-${id}: #[0-9a-f]{6};`)
      )
      expect(light, `light --color-agent-${id}`).toMatch(
        new RegExp(`--color-agent-${id}: #[0-9a-f]{6};`)
      )
    }
  })
})
