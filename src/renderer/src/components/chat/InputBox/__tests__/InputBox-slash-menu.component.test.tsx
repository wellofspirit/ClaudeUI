/**
 * Layer 2: the rendered slash menu is the ACTIVE SESSION's own list.
 *
 * Renders the real InputBox → real useSlashMenu → real View → real
 * SlashCommandMenu (only useIsMobile is stubbed, to pin the desktop layout).
 *
 * Guards: the menu rows, the filter and the keyboard index all come from one list
 * (the session's), and a session never shows another session's commands (the
 * list used to be app-level, so the last session to report filled every menu).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import { InputBox } from '../InputBox'

vi.mock('../../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }))

// jsdom has no layout engine; the menu scrolls its highlighted row into view.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => {}

const ROUTE = 'slash-menu-route'
const OTHER = 'other-route'

let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>

/** Names of the rows the menu actually painted, in order. */
function renderedRows(): string[] {
  return screen.queryAllByTestId('SlashCommandMenu.item').map((el) => el.getAttribute('data-id')!)
}

async function typeSlash(): Promise<void> {
  const textarea = screen.getByTestId('InputBox.textarea')
  await act(async () => {
    fireEvent.change(textarea, { target: { value: '/' } })
  })
}

beforeEach(async () => {
  cleanup()
  const { bootTestApp } = await import('@test/helpers/boot-test-app')
  app = await bootTestApp()

  app.bridge.ipcMain.handle('session:get-models', () => [])
  app.bridge.ipcMain.handle('session:get-engine-models', () => [])
  app.bridge.ipcMain.handle('file:list-dir', () => [])

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
    availableModels: []
  })
  useSessionStore.getState().createNewSession(ROUTE, '/test/cwd')
  useSessionStore.getState().createNewSession(OTHER, '/test/cwd')
  useSessionStore.setState({ activeSessionId: ROUTE })
  app.emit('session:slash-commands', ROUTE, [{ name: '/model' }, { name: '/delegate' }])
  app.emit('session:slash-commands', OTHER, [{ name: '/pi-only' }])
})

afterEach(() => {
  cleanup()
  app.teardown()
  vi.clearAllMocks()
})

describe('InputBox slash menu — the active session list is what renders', () => {
  it('renders the session own commands, engine and catalog entries alike', async () => {
    await act(async () => {
      render(createElement(InputBox))
    })

    await typeSlash()

    expect(renderedRows()).toEqual(['/model', '/delegate'])
  })

  it('does not show another session commands, and follows the active session', async () => {
    await act(async () => {
      render(createElement(InputBox))
    })
    await typeSlash()
    expect(renderedRows()).not.toContain('/pi-only')

    await act(async () => {
      useSessionStore.setState({ activeSessionId: OTHER })
    })
    await typeSlash()

    expect(renderedRows()).toEqual(['/pi-only'])
  })

  it('typed prefix filters the session list', async () => {
    await act(async () => {
      render(createElement(InputBox))
    })

    const textarea = screen.getByTestId('InputBox.textarea')
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '/' } })
    })
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '/del' } })
    })

    expect(renderedRows()).toEqual(['/delegate'])
  })

  it('keyboard selection index addresses the same rows the menu drew', async () => {
    await act(async () => {
      render(createElement(InputBox))
    })
    await typeSlash()

    const textarea = screen.getByTestId('InputBox.textarea')
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    })
    const rows = screen.queryAllByTestId('SlashCommandMenu.item')
    expect(rows[1].className).toContain('bg-bg-hover')

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(useSessionStore.getState().sessions[ROUTE].draftText).toBe('/delegate ')
  })

  it('engine without slash-command support renders no menu at all', async () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          status: {
            ...state.sessions[ROUTE].status,
            capabilities: { ...state.sessions[ROUTE].status.capabilities, slashCommands: false }
          }
        }
      }
    }))

    await act(async () => {
      render(createElement(InputBox))
    })
    await typeSlash()

    expect(screen.queryByTestId('SlashCommandMenu')).toBeNull()
  })
})
