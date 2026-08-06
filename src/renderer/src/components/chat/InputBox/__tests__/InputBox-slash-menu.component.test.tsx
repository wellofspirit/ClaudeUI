/**
 * Layer 2: the rendered slash menu must show the MERGED command list.
 *
 * Renders the real InputBox → real useSlashMenu → real View → real
 * SlashCommandMenu (only useIsMobile is stubbed, to pin the desktop layout).
 *
 * Guard: InputBox used to hand the View the RAW engine list while the menu's
 * open/keyboard state came from the merged list, so filesystem-scanned entries
 * (custom commands AND skills) were keyboard-selectable but never drawn, and
 * the highlight index pointed at the wrong row whenever the lists differed.
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
  // Filesystem fallback: a user-level skill, the case that was invisible.
  app.bridge.ipcMain.handle('config:scan-custom-commands', async () => ['/delegate'])

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
    availableModels: [],
    slashCommands: [{ name: '/model' }],
    customCommands: []
  })
  useSessionStore.getState().createNewSession(ROUTE, '/test/cwd')
  useSessionStore.setState({ activeSessionId: ROUTE })
})

afterEach(() => {
  cleanup()
  app.teardown()
  vi.clearAllMocks()
})

describe('InputBox slash menu — merged list is what renders', () => {
  it('renders both the engine command and the filesystem-scanned skill', async () => {
    await act(async () => {
      render(createElement(InputBox))
    })
    expect(useSessionStore.getState().customCommands).toEqual([{ name: '/delegate' }])

    await typeSlash()

    expect(renderedRows()).toEqual(['/model', '/delegate'])
  })

  it('typed prefix filters down to the filesystem-scanned skill', async () => {
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
    // Row 1 (/delegate) — the row that did not exist in the rendered list
    // pre-fix, so Enter inserted it while the highlight sat on /model.
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

  it('engine list wins on a name collision — no duplicate row', async () => {
    app.bridge.ipcMain.handle('config:scan-custom-commands', async () => ['/model', '/delegate'])

    await act(async () => {
      render(createElement(InputBox))
    })
    await typeSlash()

    expect(renderedRows()).toEqual(['/model', '/delegate'])
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
