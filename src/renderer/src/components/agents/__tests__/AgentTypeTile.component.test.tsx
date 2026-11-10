/**
 * Layer 2: the type tile reads the user's override, the engine's native colour
 * (from the host's catalog) and the dispatch colour from the live store, and
 * draws the bot alone, muted, for the engine's default type and for an untyped
 * agent (ADR-094).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { useSessionStore, DEFAULT_SETTINGS } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { resetAgentTypeCatalog } from '../../../hooks/useAgentTypeCatalog'
import { stableHashColor } from '../../../../../shared/agent-type-colors'
import type { EngineId } from '../../../../../shared/types'
import { AgentTypeTile, useAgentTile } from '../AgentTypeTile'

const tile = (): HTMLElement => screen.getByTestId('tile')

describe('AgentTypeTile', () => {
  let app: TestApp
  let listAgentTypes: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    app = await bootTestApp()
    resetAgentTypeCatalog()
    useSessionStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    listAgentTypes = vi.fn(async () => [{ type: 'reviewer', source: 'user', nativeColor: 'blue' }])
    Object.assign(window.api, { listAgentTypes })
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  const draw = (engine: EngineId, type: string | undefined): void => {
    render(<AgentTypeTile engine={engine} type={type} testId="tile" />)
  }

  it('shows the initial, with the full name as tooltip and accessible name', () => {
    draw('claude', 'migration-reviewer')
    expect(tile().textContent).toBe('MR')
    expect(tile().title).toBe('migration-reviewer')
    expect(tile().getAttribute('aria-label')).toBe('migration-reviewer')
  })

  it('drops a prefix shared with the surface’s known types or the catalog', async () => {
    listAgentTypes.mockResolvedValue([{ type: 'orch-verifier', source: 'user' }])
    function Tile(): React.JSX.Element {
      const spec = useAgentTile('claude', 'orch-reader', undefined, ['orch-implementer'])
      return <span data-testid="tile">{spec?.letter}</span>
    }
    render(<Tile />)
    // Known to the surface alone, before the catalog answers...
    expect(tile().textContent).toBe('R')
    await waitFor(() => expect(listAgentTypes).toHaveBeenCalled())
    expect(tile().textContent).toBe('R')
    cleanup()
    // ...and to the catalog alone.
    function CatalogOnly(): React.JSX.Element {
      return (
        <span data-testid="tile">{useAgentTile('claude', 'orch-reader', undefined)?.letter}</span>
      )
    }
    render(<CatalogOnly />)
    await waitFor(() => expect(tile().textContent).toBe('R'))
  })

  const hasBot = (): boolean => tile().querySelector('[data-testid="AgentTile.bot"]') !== null

  it('draws a typed agent as the bot, then its letters', () => {
    draw('claude', 'deep-review')
    expect(tile().textContent).toBe('DR')
    expect(hasBot()).toBe(true)
    // The bot comes first, then the letters.
    expect(tile().firstElementChild?.getAttribute('data-testid')).toBe('AgentTile.bot')
    expect(tile().lastElementChild?.textContent).toBe('DR')
  })

  it('draws the bot alone, muted, for the engine default, and does not even ask the host', () => {
    for (const [engine, type] of [
      ['claude', 'general-purpose'],
      ['pi', 'general-purpose'],
      ['opencode', 'general']
    ] as const) {
      const { unmount } = render(<AgentTypeTile engine={engine} type={type} testId="tile" />)
      expect(hasBot()).toBe(true)
      expect(tile().textContent).toBe('')
      expect(tile().getAttribute('data-color')).toBeNull()
      expect(tile().className).toContain('bg-bg-tertiary')
      expect(tile().title).toBe(type)
      unmount()
    }
    expect(listAgentTypes).not.toHaveBeenCalled()
    // ...and `general-purpose` is an ordinary type on opencode.
    draw('opencode', 'general-purpose')
    expect(tile().textContent).toBe('GP')
  })

  it('draws the bot alone for pi’s legacy parallel form, "scout, planner" is not one type', () => {
    draw('pi', 'scout, planner')
    expect(hasBot()).toBe(true)
    expect(tile().textContent).toBe('')
    expect(tile().getAttribute('data-color')).toBeNull()
    expect(listAgentTypes).not.toHaveBeenCalled()
  })

  it('draws the bot alone for an agent with no type at all', () => {
    draw('pi', undefined)
    expect(hasBot()).toBe(true)
    expect(tile().textContent).toBe('')
    expect(tile().getAttribute('data-color')).toBeNull()
    expect(tile().title).toBe('Agent')
  })

  it('falls to the hash, then to the native colour once the catalog arrives, and the override wins', async () => {
    draw('claude', 'reviewer')
    expect(tile().getAttribute('data-color')).toBe(stableHashColor('reviewer'))
    // `blue` is the agent file's own colour: the nearest palette colour is sky.
    await waitFor(() => expect(tile().getAttribute('data-color')).toBe('sky'))
    expect(listAgentTypes).toHaveBeenCalledTimes(1)

    cleanup()
    useSessionStore.setState({
      settings: { ...DEFAULT_SETTINGS, agentTypeColors: { claude: { reviewer: 'rose' } } }
    })
    draw('claude', 'reviewer')
    // The override is there from the first paint, ahead of the native colour.
    expect(tile().getAttribute('data-color')).toBe('rose')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tile().getAttribute('data-color')).toBe('rose')
  })

  it('reads only the override of its own engine', () => {
    useSessionStore.setState({
      settings: { ...DEFAULT_SETTINGS, agentTypeColors: { pi: { reviewer: 'rose' } } }
    })
    draw('claude', 'reviewer')
    expect(tile().getAttribute('data-color')).toBe(stableHashColor('reviewer'))
  })

  it('survives a host that cannot list types: a hash colour, no throw', async () => {
    Object.assign(window.api, {
      listAgentTypes: vi.fn(async () => {
        throw new Error('no such channel')
      })
    })
    draw('claude', 'reviewer')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tile().getAttribute('data-color')).toBe(stableHashColor('reviewer'))
  })

  it('is an X for a dispatch in the dispatch colour, whatever the engine and type', () => {
    useSessionStore.setState({ settings: { ...DEFAULT_SETTINGS, dispatchTileColor: 'teal' } })
    render(
      <AgentTypeTile
        engine="pi"
        type="general-purpose"
        dispatch={{ engine: 'opencode', model: 'deepseek-v4' }}
        testId="tile"
      />
    )
    expect(tile().textContent).toBe('X')
    expect(hasBot()).toBe(true)
    expect(tile().getAttribute('data-color')).toBe('teal')
    expect(tile().title).toBe('Dispatch → opencode · deepseek-v4')
    expect(listAgentTypes).not.toHaveBeenCalled()
  })
})
