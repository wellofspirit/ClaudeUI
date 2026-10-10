/**
 * Layer 2: one roster row (ADR-073 §10) — the label rules (a named agent, an
 * unnamed one that falls back to its description, a shell's whole command), the
 * 16px type column, Stop inline BEFORE the metrics, and a running shell's live
 * clock. Geometry (one line, aligned metrics) is the browser layout test's job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { AgentRow } from '../AgentRow'
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
  })

  it('keeps the type column 16px wide on a default-type agent, with no tile in it', async () => {
    await renderRow(row({ toolUseId: 'a', type: 'general-purpose' }))
    expect(screen.queryByTestId('AgentRow.typeTile')).toBeNull()
    expect(screen.queryByTestId('AgentRow.shellGlyph')).toBeNull()
    const name = screen.getByTestId('AgentRow.name')
    const spacer = name.previousElementSibling as HTMLElement
    expect(spacer.className).toContain('w-4')
  })

  it('draws a typed agent as the tile', async () => {
    await renderRow(row({ toolUseId: 'a', type: 'Explore' }))
    expect(screen.getByTestId('AgentRow.typeTile').textContent).toBe('E')
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
