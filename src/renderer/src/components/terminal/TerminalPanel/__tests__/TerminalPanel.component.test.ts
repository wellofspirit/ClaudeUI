/**
 * Layer 2: Component tests for TerminalPanel FC.
 *
 * Tested flows:
 *   1. onNewTab calls createTerminal IPC + addTerminalTab store action
 *   2. onCloseTab removes tab from store
 *   3. onSelectTab updates active terminal
 *   4. onClosePanel sets terminalPanelOpen=false
 *   5. onTerminalExit event removes tab
 *   6. the detached-but-running indicator it feeds the view (`terminal:pool`)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act, waitFor } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { TerminalPanelViewProps } from '../View'

let viewProps: TerminalPanelViewProps
vi.mock('../View', () => ({
  TerminalPanelView: (props: TerminalPanelViewProps) => {
    viewProps = props
    return null
  }
}))

const ROUTE = 'route-term-panel'
const CWD = '/d/repo'

describe('TerminalPanel FC', () => {
  let app: TestApp
  let createCalls: Array<{ cwd: string; index?: number }>
  let killCalls: string[]
  /** Stands in for the main-process terminal pool: `cwd#index` → pty id. */
  let pool: Map<string, string>
  let spawnCount: number

  beforeEach(async () => {
    app = await bootTestApp()
    createCalls = []
    pool = new Map()
    spawnCount = 0

    app.bridge.ipcMain.handle('terminal:create', async (_e, cwd: string, index?: number) => {
      createCalls.push({ cwd, index })
      const key = `${cwd}#${index ?? pool.size}`
      const existing = pool.get(key)
      if (existing) return existing
      const id = `term-${++spawnCount}`
      pool.set(key, id)
      return id
    })
    killCalls = []
    app.bridge.ipcMain.handle('terminal:kill', async (_e, id: string) => {
      killCalls.push(id)
      // The host frees the slot on kill; the indicator must follow it down.
      for (const [key, value] of pool) if (value === id) pool.delete(key)
    })
    // Stands in for `terminal:pool`: which slots of this cwd hold a live pty.
    app.bridge.ipcMain.handle('terminal:pool', async (_e, cwd: string) =>
      [...pool.keys()]
        .filter((key) => key.startsWith(`${cwd}#`))
        .map((key) => Number(key.slice(cwd.length + 1)))
    )

    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({
      activeSessionId: ROUTE,
      terminalGroups: {},
      terminalPanelOpen: true
    })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {}, terminalGroups: {} })
  })

  async function renderFC(): Promise<void> {
    const { TerminalPanel } = await import('../TerminalPanel')
    await act(async () => {
      render(React.createElement(TerminalPanel, { style: {} }))
    })
    await settle()
  }

  /**
   * Let the pool query settle INSIDE act.
   *
   * `terminal:pool` is asked for over several hops (a refresh bumps state → the
   * effect re-runs → the invoke resolves → the answer is stored), so an
   * operation that triggers one lands its last setState after the caller's own
   * `act` has closed. Flushing here keeps that update inside an act scope
   * instead of leaking a React warning into an unrelated test.
   */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  it('onNewTab creates a terminal via IPC and adds it to store', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onNewTab()
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()

    // Slot 0 of this cwd's pool — not "a new terminal": if another surface
    // already holds slot 0, this resolves to THAT pty.
    expect(createCalls).toEqual([{ cwd: CWD, index: 0 }])
    const tabs = Object.values(useSessionStore.getState().terminalGroups).flatMap((g) => g.tabs)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ id: 'term-1', poolIndex: 0 })
  })

  it('asks for successive pool slots, and reuses a freed slot after a close', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onNewTab()
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()
    await act(async () => {
      await viewProps.onNewTab()
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()
    expect(createCalls.map((c) => c.index)).toEqual([0, 1])
    expect(spawnCount).toBe(2)

    // Close the FIRST tab: this surface detaches from slot 0 — the pty lives on
    // (it may still be open elsewhere), so pressing + asks for slot 0 again and
    // gets the very same terminal back.
    act(() => {
      viewProps.onCloseTab('term-1')
    })
    await settle()
    await act(async () => {
      await viewProps.onNewTab()
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()

    expect(createCalls.map((c) => c.index)).toEqual([0, 1, 0])
    expect(spawnCount).toBe(2)
    const tabs = Object.values(useSessionStore.getState().terminalGroups).flatMap((g) => g.tabs)
    expect(tabs.map((t) => t.id).sort()).toEqual(['term-1', 'term-2'])
  })

  it('selects the existing tab instead of duplicating when a slot resolves to it', async () => {
    useSessionStore
      .getState()
      .addTerminalTab({ id: 'term-9', title: 'A', cwd: CWD, poolIndex: 1 })
    // Slot 0 is free from this surface's point of view, but the host answers
    // with a terminal this surface is already showing.
    pool.set(`${CWD}#0`, 'term-9')
    await renderFC()

    await act(async () => {
      await viewProps.onNewTab()
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()

    const tabs = Object.values(useSessionStore.getState().terminalGroups).flatMap((g) => g.tabs)
    expect(tabs).toHaveLength(1)
    expect(useSessionStore.getState().terminalGroups[CWD].activeTabId).toBe('term-9')
  })

  it('onCloseTab closes the terminal tab', async () => {
    useSessionStore.getState().addTerminalTab({ id: 'term-x', title: 'Test', cwd: CWD })
    await renderFC()

    act(() => {
      viewProps.onCloseTab('term-x')
    })

    // A plain close DETACHES: the pty may still be open on another surface, so
    // the tab goes and the shell stays.
    expect(killCalls).toEqual([])
    const tabs = Object.values(useSessionStore.getState().terminalGroups).flatMap((g) => g.tabs)
    expect(tabs.find((t) => t.id === 'term-x')).toBeUndefined()
  })

  // Shift-click is the ONLY UI path that stops a runaway process: a plain close
  // detaches, and the cold sweep never reaps the cwd you are actively working
  // in. The tab must go either way — the kill is best-effort on top.
  it('onCloseTab with the kill flag kills the pty and still closes the tab', async () => {
    useSessionStore.getState().addTerminalTab({ id: 'term-x', title: 'Test', cwd: CWD })
    await renderFC()

    await act(async () => {
      viewProps.onCloseTab('term-x', true)
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()

    expect(killCalls).toEqual(['term-x'])
    const tabs = Object.values(useSessionStore.getState().terminalGroups).flatMap((g) => g.tabs)
    expect(tabs.find((t) => t.id === 'term-x')).toBeUndefined()
  })

  it('closes the tab even when the kill is refused', async () => {
    app.bridge.ipcMain.handle('terminal:kill', async () => {
      throw new Error('needs-step-up')
    })
    useSessionStore.getState().addTerminalTab({ id: 'term-x', title: 'Test', cwd: CWD })
    await renderFC()

    await act(async () => {
      viewProps.onCloseTab('term-x', true)
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()

    const tabs = Object.values(useSessionStore.getState().terminalGroups).flatMap((g) => g.tabs)
    expect(tabs.find((t) => t.id === 'term-x')).toBeUndefined()
  })

  it('onSelectTab updates the active terminal', async () => {
    useSessionStore.getState().addTerminalTab({ id: 'term-a', title: 'A', cwd: CWD })
    await renderFC()

    act(() => {
      viewProps.onSelectTab('term-a', CWD)
    })

    const group = useSessionStore.getState().terminalGroups[CWD]
    expect(group?.activeTabId).toBe('term-a')
  })

  it('onClosePanel closes the terminal panel', async () => {
    await renderFC()

    act(() => {
      viewProps.onClosePanel()
    })

    expect(useSessionStore.getState().terminalPanelOpen).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // The detached-but-running indicator
  // ---------------------------------------------------------------------------

  it('reports the slot "+" would claim, and whether a shell is already in it', async () => {
    // Another surface (or an earlier tab of this one) left slot 0 running.
    pool.set(`${CWD}#0`, 'term-elsewhere')
    await renderFC()

    await waitFor(() => expect(viewProps.nextSlotRunning).toBe(true))
    expect(viewProps.nextSlot).toBe(0)
  })

  it('says nothing when the slot is genuinely free', async () => {
    await renderFC()

    await waitFor(() => expect(viewProps.nextSlot).toBe(0))
    expect(viewProps.nextSlotRunning).toBe(false)
  })

  it('re-asks after an open: "+" now points past the slot it just took', async () => {
    await renderFC()
    await waitFor(() => expect(viewProps.nextSlot).toBe(0))

    await act(async () => {
      await viewProps.onNewTab()
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()

    // Slot 0 is this surface's own tab now, so the next open asks for slot 1 —
    // which nobody holds. The badge is about shells you CANNOT see.
    await waitFor(() => expect(viewProps.nextSlot).toBe(1))
    expect(viewProps.nextSlotRunning).toBe(false)
  })

  it('lights up when a tab is closed — the detach leaves the shell running', async () => {
    await renderFC()
    await act(async () => {
      await viewProps.onNewTab()
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()
    await waitFor(() => expect(viewProps.nextSlot).toBe(1))

    act(() => {
      viewProps.onCloseTab('term-1')
    })
    await settle()

    await waitFor(() => expect(viewProps.nextSlot).toBe(0))
    expect(viewProps.nextSlotRunning).toBe(true)
  })

  // Found in the live walk: the panel's own "+" is NOT the only way a pty
  // appears — opening the panel auto-opens slot 0 through `toggle-terminal.ts`,
  // which adds the tab straight to the store. A pool answer taken before that
  // shell existed made it invisible the moment its tab was closed, which is
  // precisely the state the indicator exists for.
  it('picks up a pty this panel did not open, once its tab is closed', async () => {
    await renderFC()

    act(() => {
      pool.set(`${CWD}#0`, 'term-auto')
      useSessionStore
        .getState()
        .addTerminalTab({ id: 'term-auto', title: 'Terminal', cwd: CWD, poolIndex: 0 })
    })
    await settle()

    act(() => {
      viewProps.onCloseTab('term-auto')
    })
    await settle()

    expect(viewProps.nextSlot).toBe(0)
    expect(viewProps.nextSlotRunning).toBe(true)
  })

  // Switching sessions switches DIRECTORIES, and the new directory's answer is
  // a round trip away (a visible one over remote). Until it lands, the previous
  // repo's "a shell is still running here" would be describing somebody else's
  // pool — a claim about the wrong machine state, which is exactly what this
  // indicator must never make.
  it('drops the previous directory’s answer the moment the cwd changes', async () => {
    pool.set(`${CWD}#0`, 'term-here')
    await renderFC()
    await waitFor(() => expect(viewProps.nextSlotRunning).toBe(true))

    // The next directory's answer is held in flight for the duration.
    let release = (): void => {}
    const inFlight = new Promise<void>((r) => (release = r))
    app.bridge.ipcMain.handle('terminal:pool', async () => {
      await inFlight
      return []
    })

    const OTHER_ROUTE = 'route-term-panel-other'
    const OTHER_CWD = '/d/other-repo'
    useSessionStore.getState().createNewSession(OTHER_ROUTE, OTHER_CWD)
    act(() => {
      useSessionStore.setState({ activeSessionId: OTHER_ROUTE })
    })

    expect(viewProps.nextSlot).toBe(0)
    expect(viewProps.nextSlotRunning).toBe(false)

    release()
    await settle()
    expect(viewProps.nextSlotRunning).toBe(false)
  })

  it('goes dark after a KILL — the slot is free again', async () => {
    await renderFC()
    await act(async () => {
      await viewProps.onNewTab()
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()

    await act(async () => {
      viewProps.onCloseTab('term-1', true)
      await new Promise((r) => setTimeout(r, 0))
    })
    await settle()

    expect(killCalls).toEqual(['term-1'])
    await waitFor(() => expect(viewProps.nextSlot).toBe(0))
    expect(viewProps.nextSlotRunning).toBe(false)
  })

  it('treats a refused pool query as "nothing known", never as "nothing running"', async () => {
    app.bridge.ipcMain.handle('terminal:pool', async () => {
      throw new Error('needs-step-up')
    })
    pool.set(`${CWD}#0`, 'term-elsewhere')
    await renderFC()

    await waitFor(() => expect(viewProps.nextSlot).toBe(0))
    // No claim either way — the panel must not invent a shell it cannot see.
    expect(viewProps.nextSlotRunning).toBe(false)
  })

  it('onTerminalExit event removes the tab from store', async () => {
    useSessionStore.getState().addTerminalTab({ id: 'term-a', title: 'A', cwd: CWD })
    await renderFC()

    await act(async () => {
      app.emit('terminal:exit', { terminalId: 'term-a' })
    })

    const remaining = Object.values(useSessionStore.getState().terminalGroups).flatMap(
      (g) => g.tabs
    )
    expect(remaining.find((t) => t.id === 'term-a')).toBeUndefined()
  })
})
