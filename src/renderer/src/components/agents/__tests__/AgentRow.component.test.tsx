/**
 * Layer 2: one roster row (ADR-073 §10) — the label rules (a named agent, an
 * unnamed one that falls back to its description, a shell's whole command), the
 * 16px type column, Stop inline BEFORE the metrics, and a running shell's live
 * clock. Geometry (one line, aligned metrics) is the browser layout test's job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useSessionStore, DEFAULT_SETTINGS } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { AgentRow, rowStatus } from '../AgentRow'
import type { AgentRosterRow } from '../../../hooks/useAgentRoster'

const ROUTE = 'route-agent-row'

function row(over: Partial<AgentRosterRow> & { toolUseId: string }): AgentRosterRow {
  return {
    kind: 'agent',
    name: 'reviewer',
    hasExplicitName: true,
    description: 'Review the scroll bench code',
    isRunning: false,
    isError: false,
    isStopped: false,
    isLoaded: false,
    depth: 0,
    runIndex: 1,
    ...over
  }
}

async function renderRow(r: AgentRosterRow): Promise<void> {
  await act(async () => {
    render(React.createElement(AgentRow, { row: r, selected: false, onOpen: vi.fn() }))
  })
}

describe('AgentRow', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    vi.useRealTimers()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('labels a named agent with its name and keeps the description in the tooltip', async () => {
    await renderRow(row({ toolUseId: 'a' }))
    const name = screen.getByTestId('AgentRow.name')
    expect(name.textContent).toBe('reviewer')
    expect(name.className).toContain('text-text-primary')
    expect(name.title).toBe('Review the scroll bench code')
    // The description line is gone from the row.
    expect(screen.queryByTestId('AgentRow.description')).toBeNull()
    expect(screen.getByTestId('AgentRow').getAttribute('data-kind')).toBe('agent')
  })

  it('labels an unnamed agent with its description, in the secondary colour', async () => {
    // The spawn named no one: `name` is only the type fallback.
    await renderRow(row({ toolUseId: 'a', name: 'Explore', hasExplicitName: false }))
    const name = screen.getByTestId('AgentRow.name')
    expect(name.textContent).toBe('Review the scroll bench code')
    expect(name.className).toContain('text-text-secondary')
    expect(name.title).toBe('Review the scroll bench code')
  })

  it('falls back to the type when an unnamed agent has no description', async () => {
    await renderRow(
      row({ toolUseId: 'a', name: 'Explore', hasExplicitName: false, description: '' })
    )
    expect(screen.getByTestId('AgentRow.name').textContent).toBe('Explore')
  })

  it('shows a shell as a $ glyph and its whole command', async () => {
    const command = 'until grep -q "END compare" /d/repo/.cache/compare.log; do sleep 5; done'
    await renderRow(
      row({
        toolUseId: 'sh',
        kind: 'shell',
        name: 'until',
        hasExplicitName: false,
        description: command,
        isRunning: true
      })
    )
    const glyph = screen.getByTestId('AgentRow.shellGlyph')
    expect(glyph.textContent).toBe('$')
    expect(glyph.title).toBe('Background shell')
    const name = screen.getByTestId('AgentRow.name')
    // The command, not its first word, and not cut at a fixed length.
    expect(name.textContent).toBe(command)
    expect(name.className).toContain('font-mono')
    expect(name.title).toBe(command)
    expect(screen.getByTestId('AgentRow').getAttribute('data-kind')).toBe('shell')
    expect(screen.queryByTestId('AgentRow.typeTile')).toBeNull()
    expect(screen.getByTestId('AgentRow.typeSlot').contains(glyph)).toBe(true)
  })

  it('draws a default-type agent as the muted bot alone, in the same type slot', async () => {
    await renderRow(row({ toolUseId: 'a', type: 'general-purpose' }))
    const tile = screen.getByTestId('AgentRow.typeTile')
    expect(tile.querySelector('[data-testid="AgentTile.bot"]')).not.toBeNull()
    expect(tile.textContent).toBe('')
    expect(tile.title).toBe('general-purpose')
    // Muted: no palette colour, the neutral tile.
    expect(tile.getAttribute('data-color')).toBeNull()
    expect(tile.className).toContain('bg-bg-tertiary')
    expect(tile.className).toContain('text-text-muted')
    expect(screen.queryByTestId('AgentRow.shellGlyph')).toBeNull()
    // The slot is the same wide, left-aligned column a lettered tile sits in.
    const slot = screen.getByTestId('AgentRow.typeSlot')
    expect(slot.className).toContain('w-9')
    expect(slot.contains(tile)).toBe(true)
    expect(screen.getByTestId('AgentRow.name').previousElementSibling).toBe(slot)
  })

  it('draws an agent with no type at all (a Codex spawn) as the muted bot alone', async () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          status: { ...state.sessions[ROUTE].status, engineId: 'codex' }
        }
      }
    }))
    await renderRow(row({ toolUseId: 'a', type: undefined, name: 'gpt-6' }))
    const tile = screen.getByTestId('AgentRow.typeTile')
    expect(tile.querySelector('[data-testid="AgentTile.bot"]')).not.toBeNull()
    expect(tile.textContent).toBe('')
    expect(tile.getAttribute('data-color')).toBeNull()
    expect(tile.className).toContain('bg-bg-tertiary')
  })

  it('shows a first-party last tool by its product name, not the wire name', async () => {
    await renderRow(
      row({
        toolUseId: 'a',
        isRunning: true,
        lastToolName: 'mcp__claude-ui-collab__dispatch_agent',
        elapsedSeconds: 5
      })
    )
    expect(screen.getByTestId('AgentRow.metrics.tool').textContent).toBe('X-Agent · ')
    expect(screen.getByTestId('AgentRow.metrics').textContent).not.toContain('mcp__')
  })

  it('leaves a third-party MCP last tool as the wire reported it', async () => {
    await renderRow(
      row({ toolUseId: 'a', isRunning: true, lastToolName: 'mcp__github__create_issue' })
    )
    expect(screen.getByTestId('AgentRow.metrics.tool').textContent).toBe(
      'mcp__github__create_issue'
    )
  })

  it('draws a dispatch as the bot and an X', async () => {
    await renderRow(row({ toolUseId: 'a', dispatch: { engine: 'opencode', model: 'deepseek-v4' } }))
    const tile = screen.getByTestId('AgentRow.typeTile')
    expect(tile.querySelector('[data-testid="AgentTile.bot"]')).not.toBeNull()
    expect(tile.textContent).toBe('X')
  })

  describe('the name colour follows the model tier', () => {
    const name = (): HTMLElement => screen.getByTestId('AgentRow.name')
    const setTierColors = (on: boolean): void =>
      useSessionStore.setState({ settings: { ...DEFAULT_SETTINGS, agentModelTierColors: on } })

    beforeEach(() => setTierColors(true))

    it('is on by default, and colours the name of an agent whose model has a tier', async () => {
      expect(DEFAULT_SETTINGS.agentModelTierColors).toBe(true)
      await renderRow(row({ toolUseId: 'a', model: 'claude-opus-5-5' }))
      expect(name().getAttribute('data-model-tier')).toBe('high')
      expect(name().className).toContain('text-model-tier-high')
      expect(name().className).not.toContain('text-text-primary')
    })

    it.each([
      ['claude-fable-5-1', 'top'],
      ['claude-sonnet-5-5', 'mid'],
      ['openai/gpt-6-luna', 'low']
    ] as const)('%s is %s', async (model, tier) => {
      await renderRow(row({ toolUseId: 'a', model }))
      expect(name().getAttribute('data-model-tier')).toBe(tier)
      expect(name().className).toContain(`text-model-tier-${tier}`)
    })

    it('colours an unnamed agent’s description label too', async () => {
      await renderRow(
        row({ toolUseId: 'a', hasExplicitName: false, name: 'Explore', model: 'claude-haiku-4-5' })
      )
      expect(name().textContent).toBe('Review the scroll bench code')
      expect(name().className).toContain('text-model-tier-low')
    })

    it('keeps the usual colours with the setting off', async () => {
      setTierColors(false)
      await renderRow(row({ toolUseId: 'a', model: 'claude-opus-5-5' }))
      expect(name().getAttribute('data-model-tier')).toBeNull()
      expect(name().className).toContain('text-text-primary')
      expect(name().className).not.toContain('text-model-tier')
    })

    it('keeps the usual colours for a model with no tier, and for no model', async () => {
      await renderRow(row({ toolUseId: 'a', model: 'deepseek/deepseek-v4-flash' }))
      expect(name().getAttribute('data-model-tier')).toBeNull()
      expect(name().className).toContain('text-text-primary')
      cleanup()
      await renderRow(row({ toolUseId: 'b' }))
      expect(name().getAttribute('data-model-tier')).toBeNull()
    })

    it('never colours a shell', async () => {
      await renderRow(
        row({ toolUseId: 'sh', kind: 'shell', hasExplicitName: false, model: 'claude-opus-5-5' })
      )
      expect(name().getAttribute('data-model-tier')).toBeNull()
      expect(name().className).toContain('text-text-secondary')
      expect(name().className).not.toContain('text-model-tier')
    })

    it('draws a finished context row, and a failed one, like any other row: no dimming', async () => {
      render(
        React.createElement(AgentRow, {
          row: row({ toolUseId: 'a', model: 'claude-opus-5-5' }),
          selected: false,
          onOpen: vi.fn(),
          isContext: true
        })
      )
      expect(screen.getByTestId('AgentRow').className).not.toMatch(/opacity/)
      expect(name().className).toContain('text-model-tier-high')
      cleanup()
      await renderRow(row({ toolUseId: 'b', isError: true }))
      expect(screen.getByTestId('AgentRow').className).not.toMatch(/opacity/)
    })
  })

  describe('the status dot is the session dot (status-dot)', () => {
    const dot = (): HTMLElement => screen.getByTestId('AgentRow.status')

    it('ripples green while the agent itself works', async () => {
      await renderRow(row({ toolUseId: 'a', isRunning: true }))
      expect(dot().classList.contains('status-dot')).toBe(true)
      expect(dot().classList.contains('status-dot--ripple')).toBe(true)
      expect(dot().getAttribute('data-state')).toBe('running')
      expect(dot().getAttribute('data-status')).toBe('running')
      // A random phase per dot, as on the session list.
      expect(dot().style.getPropertyValue('--dot-phase')).toMatch(/^-\d(\.\d+)?s$/)
    })

    it('is steady green when its own run ended but something it launched still runs', async () => {
      await renderRow(row({ toolUseId: 'a', runningDescendants: 2 }))
      expect(dot().getAttribute('data-state')).toBe('idle')
      expect(dot().getAttribute('data-status')).toBe('subagents')
      expect(dot().classList.contains('status-dot--ripple')).toBe(false)
      expect(dot().title).toBe('Done · 2 still running below')
    })

    it('is steady grey when done, steady red when failed', async () => {
      await renderRow(row({ toolUseId: 'a' }))
      expect(dot().getAttribute('data-state')).toBe('inactive')
      expect(dot().getAttribute('data-status')).toBe('done')
      expect(dot().title).toBe('Done')
      expect(dot().classList.contains('status-dot--ripple')).toBe(false)
      cleanup()
      await renderRow(row({ toolUseId: 'b', isError: true }))
      expect(dot().getAttribute('data-state')).toBe('failed')
      expect(dot().getAttribute('data-status')).toBe('failed')
      expect(dot().classList.contains('status-dot--ripple')).toBe(false)
    })

    it('is muted, never warning-coloured, when stopped by the user or loaded from history', async () => {
      await renderRow(row({ toolUseId: 'a', isStopped: true }))
      expect(dot().getAttribute('data-state')).toBe('inactive')
      expect(dot().getAttribute('data-status')).toBe('stopped')
      expect(dot().classList.contains('status-dot--ripple')).toBe(false)
      expect(dot().className).not.toMatch(/warning|yellow|amber/)
      expect(dot().title).toBe('Stopped')
      cleanup()
      await renderRow(row({ toolUseId: 'b', isLoaded: true }))
      expect(dot().getAttribute('data-state')).toBe('inactive')
      expect(dot().getAttribute('data-status')).toBe('loaded')
    })

    it('reads how an agent ended before what still runs below it', () => {
      const base = { isRunning: false, isError: false, isStopped: false, isLoaded: false }
      const below = { runningDescendants: 1 }
      expect(rowStatus({ ...base, ...below })).toBe('subagents')
      expect(rowStatus({ ...base, ...below, isRunning: true })).toBe('running')
      expect(rowStatus({ ...base, ...below, isError: true })).toBe('failed')
      expect(rowStatus({ ...base, ...below, isStopped: true })).toBe('stopped')
      expect(rowStatus({ ...base, ...below, isLoaded: true })).toBe('loaded')
      expect(rowStatus({ ...base, runningDescendants: 0 })).toBe('done')
    })
  })

  it('puts Stop before the metrics in the DOM, and styles it red', async () => {
    await renderRow(
      row({
        toolUseId: 'a',
        isRunning: true,
        elapsedSeconds: 135,
        lastToolName: 'Bash',
        usage: { totalTokens: 8000, toolUses: 2, durationMs: 1 }
      })
    )
    const stop = screen.getByTestId('AgentRow.stop')
    const metrics = screen.getByTestId('AgentRow.metrics')
    expect(stop.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Directly adjacent: nothing sits between Stop and the metrics.
    expect(stop.nextElementSibling).toBe(metrics)
    expect(stop.className).toContain('bg-danger/10')
    expect(stop.className).toContain('text-danger')
    expect(metrics.textContent).toBe('Bash · 2m 15s · 8.0k')
    expect(screen.getByTestId('AgentRow.metrics.tool').textContent).toBe('Bash · ')
  })

  it('offers no Stop on a finished row', async () => {
    await renderRow(row({ toolUseId: 'a', elapsedSeconds: 5 }))
    expect(screen.queryByTestId('AgentRow.stop')).toBeNull()
    expect(screen.getByTestId('AgentRow.metrics').textContent).toBe('5s')
  })

  it('shows the resumed chip as the short form only', async () => {
    await renderRow(row({ toolUseId: 'a', runIndex: 3 }))
    expect(screen.getByTestId('AgentRow.resumed').textContent).toBe('↻2')
  })

  describe('a running shell clock', () => {
    const shell = (over: Partial<AgentRosterRow>): AgentRosterRow =>
      row({
        toolUseId: 'sh',
        kind: 'shell',
        name: 'bun',
        hasExplicitName: false,
        description: 'bun run dev',
        isRunning: true,
        ...over
      })

    it('counts up from its start, once a second', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      vi.setSystemTime(1_000_000)
      await renderRow(shell({ startedAt: 1_000_000 - 65_000 }))
      expect(screen.getByTestId('AgentRow.metrics').textContent).toBe('1m 5s')

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })
      expect(screen.getByTestId('AgentRow.metrics').textContent).toBe('1m 8s')
    })

    it('floors the clock: 59.6 s reads 59s, and 119.6 s reads 1m 59s', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      vi.setSystemTime(1_000_000)
      await renderRow(shell({ startedAt: 1_000_000 - 59_600 }))
      expect(screen.getByTestId('AgentRow.metrics').textContent).toBe('59s')
      cleanup()
      await renderRow(shell({ startedAt: 1_000_000 - 119_600 }))
      expect(screen.getByTestId('AgentRow.metrics').textContent).toBe('1m 59s')
    })

    it('shows no clock and starts no ticker for a running shell without a start', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      vi.setSystemTime(1_000_000)
      await renderRow(shell({}))
      expect(screen.getByTestId('AgentRow').getAttribute('data-running')).toBe('true')
      expect(screen.queryByTestId('AgentRow.metrics')).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not tick, or show a clock, when the shell has no start or has finished', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      vi.setSystemTime(1_000_000)
      await renderRow(shell({ isRunning: false, startedAt: 1_000_000 - 65_000 }))
      expect(screen.queryByTestId('AgentRow.metrics')).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
