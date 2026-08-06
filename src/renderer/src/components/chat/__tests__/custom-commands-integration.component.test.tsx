/**
 * Layer 2: Integration test for the custom slash commands feature.
 *
 * Tests the full signal path:
 *   bootTestApp (TestIpcBridge → window.api)
 *     → real useClaudeEvents (registers IPC event listeners)
 *       → real Zustand store (holds slashCommands + customCommands)
 *         → real mergeSlashCommands + filterSlashCommands
 *           → rendered DOM
 *
 * Events are driven from the "main process" side via app.emit().
 * IPC invoke handlers are registered on bridge.ipcMain.handle().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useEffect, useMemo } from 'react'

vi.mock('electron', async () => import('@test/stubs/electron-shim'))

import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useClaudeEvents } from '../../../hooks/useClaudeEvents'
import { useSessionStore } from '../../../stores/session-store'
import { mergeSlashCommands, filterSlashCommands } from '../SlashCommandMenu'

// ---------------------------------------------------------------------------
// Test harness component
//
// Mounts the REAL useClaudeEvents hook (registers IPC event listeners)
// and reproduces InputBox FC's slash command wiring:
//   - useEffect to scan custom commands on cwd change
//   - mergeSlashCommands to combine SDK + custom commands
//   - filterSlashCommands for type-ahead filtering
// ---------------------------------------------------------------------------

function SlashMenuHarness({
  cwd,
  filter = ''
}: {
  cwd: string
  filter?: string
}): React.JSX.Element {
  useClaudeEvents()

  const slashCommands = useSessionStore((s) => s.slashCommands)
  const customCommands = useSessionStore((s) => s.customCommands)
  const setCustomCommands = useSessionStore((s) => s.setCustomCommands)

  const merged = useMemo(
    () => mergeSlashCommands(slashCommands, customCommands),
    [slashCommands, customCommands]
  )

  // Same useEffect as InputBox FC — triggers scan when cwd changes
  useEffect(() => {
    if (!cwd) return
    window.api
      .scanCustomCommands(cwd)
      .then((names) => {
        setCustomCommands(names.map((name) => ({ name })))
      })
      .catch(() => {})
  }, [cwd, setCustomCommands])

  const filtered = filter ? filterSlashCommands(merged, filter) : merged

  return (
    <ul data-testid="commands">
      {filtered.map((c) => (
        <li key={c.name} data-testid="cmd">
          {c.name}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderedCommands(): string[] {
  return screen.getAllByTestId('cmd').map((el) => el.textContent!)
}

function renderedCommandsSafe(): string[] {
  return screen.queryAllByTestId('cmd').map((el) => el.textContent!)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let app: TestApp

beforeEach(async () => {
  cleanup()
  app = await bootTestApp()

  useSessionStore.setState({
    slashCommands: [],
    customCommands: [],
    sessions: {},
    activeSessionId: null
  })
})

afterEach(() => {
  cleanup()
  app.teardown()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('custom commands integration (IPC → store → render)', () => {
  it('scans filesystem and shows custom commands before SDK init', async () => {
    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => ['/refactor', '/deploy'])

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" />)
    })

    expect(renderedCommands()).toEqual(['/refactor', '/deploy'])
  })

  it('SDK init event provides the authoritative list, filesystem entries fill gaps', async () => {
    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => ['/refactor', '/deploy'])

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" />)
    })
    expect(renderedCommands()).toEqual(['/refactor', '/deploy'])

    // SDK init fires via IPC — useClaudeEvents' onSlashCommands listener handles this
    await act(async () => {
      app.emit('session:slash-commands', 'session-123', [
        { name: '/help' },
        { name: '/clear' },
        { name: '/compact' },
        { name: '/refactor' },
        { name: '/deploy' }
      ])
    })

    expect(renderedCommands()).toEqual(['/help', '/clear', '/compact', '/refactor', '/deploy'])
  })

  it('SDK init re-scans the session cwd instead of wiping the filesystem list', async () => {
    // The wipe used to leave the fallback empty for the app's lifetime: the only
    // other scan is keyed on cwd changes, so a same-cwd session never refilled it.
    const scanCalls: string[] = []
    let onDisk = ['/refactor', '/old-cmd']
    app.bridge.ipcMain.handle('config:scan-custom-commands', async (_e: unknown, cwd: string) => {
      scanCalls.push(cwd)
      return onDisk
    })
    useSessionStore.getState().createNewSession('session-123', '/my/project')

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" />)
    })
    expect(renderedCommands()).toContain('/old-cmd')

    // /old-cmd deleted on disk; the SDK's list doesn't carry it either.
    onDisk = ['/refactor']
    await act(async () => {
      app.emit('session:slash-commands', 'session-123', [{ name: '/help' }, { name: '/refactor' }])
    })

    expect(scanCalls).toEqual(['/my/project', '/my/project'])
    expect(useSessionStore.getState().customCommands).toEqual([{ name: '/refactor' }])
    expect(renderedCommands()).toEqual(['/help', '/refactor'])
  })

  it('a skill the engine under-reports survives SDK init', async () => {
    // The whole point of not wiping: cli.js reports skills as commands, other
    // engines may not. The filesystem entry must still be offered.
    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => ['/delegate'])
    useSessionStore.getState().createNewSession('session-123', '/my/project')

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" />)
    })

    await act(async () => {
      app.emit('session:slash-commands', 'session-123', [{ name: '/help' }])
    })

    expect(renderedCommands()).toEqual(['/help', '/delegate'])
  })

  it('SDK init for an unknown routingId leaves the filesystem list untouched', async () => {
    // No session in the store → no cwd to scan. Must not clear what we have.
    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => ['/refactor'])

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" />)
    })

    await act(async () => {
      app.emit('session:slash-commands', 'no-such-session', [{ name: '/help' }])
    })

    expect(useSessionStore.getState().customCommands).toEqual([{ name: '/refactor' }])
    expect(renderedCommands()).toEqual(['/help', '/refactor'])
  })

  it('custom commands merge without duplicates before SDK init', async () => {
    useSessionStore.setState({
      slashCommands: [{ name: '/help' }, { name: '/clear' }]
    })

    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => ['/help', '/my-custom'])

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" />)
    })

    // /help from SDK, /clear from SDK, /my-custom from filesystem (no duplicate /help)
    expect(renderedCommands()).toEqual(['/help', '/clear', '/my-custom'])
  })

  it('filter narrows merged commands', async () => {
    useSessionStore.setState({
      slashCommands: [{ name: '/help' }, { name: '/clear' }]
    })

    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => ['/hello-world'])

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" filter="hel" />)
    })

    expect(renderedCommands()).toEqual(['/help', '/hello-world'])
  })

  it('shows empty list when no commands from any source', async () => {
    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => [])

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" />)
    })

    expect(renderedCommandsSafe()).toEqual([])
  })

  it('handles scan failure gracefully — keeps existing commands', async () => {
    useSessionStore.setState({
      slashCommands: [{ name: '/help' }]
    })

    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => {
      throw new Error('EACCES: permission denied')
    })

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" />)
    })

    expect(renderedCommands()).toEqual(['/help'])
  })

  it('re-scans when cwd changes (session switch)', async () => {
    let scanCwd = ''
    app.bridge.ipcMain.handle('config:scan-custom-commands', async (_e: unknown, cwd: string) => {
      scanCwd = cwd
      if (cwd === '/project-a') return ['/deploy-a']
      if (cwd === '/project-b') return ['/deploy-b']
      return []
    })

    const { rerender } = await act(async () => {
      return render(<SlashMenuHarness cwd="/project-a" />)
    })
    expect(scanCwd).toBe('/project-a')
    expect(renderedCommands()).toEqual(['/deploy-a'])

    await act(async () => {
      rerender(<SlashMenuHarness cwd="/project-b" />)
    })
    expect(scanCwd).toBe('/project-b')
    expect(renderedCommands()).toEqual(['/deploy-b'])
  })

  it('full lifecycle: scan → merge → SDK init → re-scan', async () => {
    let onDisk = ['/refactor', '/stale-cmd']
    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => onDisk)
    useSessionStore.getState().createNewSession('session-123', '/my/project')

    await act(async () => {
      render(<SlashMenuHarness cwd="/my/project" />)
    })
    expect(renderedCommands()).toEqual(['/refactor', '/stale-cmd'])

    // SDK init arrives — /stale-cmd was deleted
    onDisk = ['/refactor']
    await act(async () => {
      app.emit('session:slash-commands', 'session-123', [
        { name: '/help' },
        { name: '/clear' },
        { name: '/refactor' }
      ])
    })

    expect(renderedCommands()).toEqual(['/help', '/clear', '/refactor'])
    expect(renderedCommands()).not.toContain('/stale-cmd')

    const { customCommands, slashCommands } = useSessionStore.getState()
    expect(customCommands).toEqual([{ name: '/refactor' }])
    expect(slashCommands).toHaveLength(3)
  })
})
