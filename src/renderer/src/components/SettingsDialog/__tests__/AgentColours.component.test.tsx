/**
 * Layer 2: Settings › <engine> › Agent colours, and the dispatch tile's colour
 * (ADR-094).
 *
 * What has to hold: every engine's page lists the types the host reports, each
 * with its tile in the colour the resolution order gives (override, else the
 * agent file's own colour mapped to the palette, else a hash); the default type
 * is shown greyed with no picker; picking a swatch writes the override through
 * the SAME settings path every other setting takes (`updateSettings`, which
 * saves and replicates); and Reset deletes it, leaving no empty shell in the
 * file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { useSessionStore, DEFAULT_SETTINGS } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { resetAgentTypeCatalog } from '../../../hooks/useAgentTypeCatalog'
import { stableHashColor } from '../../../../../shared/agent-type-colors'
import type { AgentTypeInfo, EngineId } from '../../../../../shared/types'
import { AgentColoursSection, DispatchTileColourSection } from '../AgentColours'
import { pageOf } from '../settings-pages'

const CATALOGS: Record<EngineId, AgentTypeInfo[]> = {
  claude: [
    { type: 'general-purpose', source: 'builtin' },
    { type: 'Explore', source: 'builtin' },
    { type: 'migration-reviewer', source: 'user', nativeColor: 'purple' }
  ],
  opencode: [
    { type: 'general', source: 'builtin' },
    { type: 'explore', source: 'builtin', nativeColor: '#22d3ee' }
  ],
  pi: [
    { type: 'general-purpose', source: 'builtin' },
    { type: 'Plan', source: 'project' }
  ],
  codex: [
    { type: 'default', source: 'builtin' },
    { type: 'explorer', source: 'builtin' },
    { type: 'worker', source: 'builtin' }
  ]
}

function Section({ engine }: { engine: EngineId }): React.JSX.Element {
  const settings = useSessionStore((s) => s.settings)
  const update = useSessionStore((s) => s.updateSettings)
  return <AgentColoursSection engine={engine} settings={settings} update={update} />
}

function DispatchSection(): React.JSX.Element {
  const settings = useSessionStore((s) => s.settings)
  const update = useSessionStore((s) => s.updateSettings)
  return <DispatchTileColourSection settings={settings} update={update} />
}

const rowOf = (type: string): HTMLElement =>
  screen
    .getAllByTestId('AgentColours.row')
    .find((el) => el.getAttribute('data-id') === type) as HTMLElement

const tileOf = (type: string): HTMLElement => within(rowOf(type)).getByTestId('AgentColours.tile')

describe('Agent colours settings', () => {
  let app: TestApp
  let save: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    app = await bootTestApp()
    resetAgentTypeCatalog()
    useSessionStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    save = vi.fn(async () => {})
    Object.assign(window.api, {
      saveSettings: save,
      listAgentTypes: vi.fn(async (engine: EngineId) => CATALOGS[engine])
    })
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  it.each(['claude', 'opencode', 'pi', 'codex'] as const)(
    'lists the %s agent types, with a tile each and the default type greyed',
    async (engine) => {
      render(<Section engine={engine} />)
      await waitFor(() =>
        expect(screen.getAllByTestId('AgentColours.row')).toHaveLength(CATALOGS[engine].length)
      )
      expect(window.api.listAgentTypes).toHaveBeenCalledWith(engine, undefined)

      for (const info of CATALOGS[engine]) {
        const row = rowOf(info.type)
        expect(row).toBeTruthy()
        expect(row.textContent).toContain(info.type)
        const isDefault = ['general-purpose', 'general', 'default'].includes(info.type)
        if (isDefault) {
          // Greyed: dimmed, a neutral tile, and nothing to pick.
          expect(row.textContent).toContain('Default type, no tile.')
          expect(tileOf(info.type).textContent).toBe('–')
          expect(tileOf(info.type).getAttribute('data-color')).toBeNull()
          expect(within(row).queryAllByTestId('AgentColours.swatch')).toHaveLength(0)
        } else {
          expect(tileOf(info.type).textContent).toBe(info.type[0].toUpperCase())
          expect(within(row).getAllByTestId('AgentColours.swatch')).toHaveLength(8)
        }
      }
    }
  )

  it('colours a type by its own agent colour, mapped to the palette, else a hash', async () => {
    render(<Section engine="claude" />)
    await waitFor(() => expect(screen.getAllByTestId('AgentColours.row')).toHaveLength(3))
    // `purple` -> violet; the row says where the colour comes from.
    expect(tileOf('migration-reviewer').getAttribute('data-color')).toBe('violet')
    expect(rowOf('migration-reviewer').textContent).toContain("Auto, from the agent's own colour")
    expect(rowOf('migration-reviewer').textContent).toContain('User agent')
    // No native colour: the stable hash of the name, called Auto.
    expect(tileOf('Explore').getAttribute('data-color')).toBe(stableHashColor('Explore'))
    expect(rowOf('Explore').textContent).toContain('Built-in · Auto')
    // Nothing to reset while Auto.
    expect(within(rowOf('Explore')).queryByTestId('AgentColours.reset')).toBeNull()
  })

  it('writes a picked swatch through the settings path, and Reset deletes it', async () => {
    render(<Section engine="claude" />)
    await waitFor(() => expect(screen.getAllByTestId('AgentColours.row')).toHaveLength(3))

    const pick = (id: string): void => {
      fireEvent.click(
        within(rowOf('migration-reviewer'))
          .getAllByTestId('AgentColours.swatch')
          .find((el) => el.getAttribute('data-id') === id)!
      )
    }

    pick('pink')
    expect(useSessionStore.getState().settings.agentTypeColors).toEqual({
      claude: { 'migration-reviewer': 'pink' }
    })
    // The same path every setting takes: saved to disk (and replicated).
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentTypeColors: { claude: { 'migration-reviewer': 'pink' } } })
    )
    expect(tileOf('migration-reviewer').getAttribute('data-color')).toBe('pink')
    expect(rowOf('migration-reviewer').textContent).toContain('custom colour')
    const picked = within(rowOf('migration-reviewer'))
      .getAllByTestId('AgentColours.swatch')
      .filter((el) => el.getAttribute('aria-pressed') === 'true')
    expect(picked.map((el) => el.getAttribute('data-id'))).toEqual(['pink'])

    // One override per engine: another engine's same-named type is untouched.
    pick('teal')
    expect(useSessionStore.getState().settings.agentTypeColors).toEqual({
      claude: { 'migration-reviewer': 'teal' }
    })

    // Reset: the override goes, the native colour is back, the key is gone.
    const reset = within(rowOf('migration-reviewer')).getByTestId('AgentColours.reset')
    expect(reset.textContent).toBe('Reset')
    expect(rowOf('migration-reviewer').textContent).toContain('custom colour')
    fireEvent.click(reset)
    expect(useSessionStore.getState().settings.agentTypeColors).toBeUndefined()
    expect(tileOf('migration-reviewer').getAttribute('data-color')).toBe('violet')
    const lastSaved = save.mock.calls[save.mock.calls.length - 1][0] as Record<string, unknown>
    expect(lastSaved.agentTypeColors).toBeUndefined()
  })

  it('keeps each engine’s overrides apart', async () => {
    useSessionStore.setState({
      settings: { ...DEFAULT_SETTINGS, agentTypeColors: { pi: { Plan: 'rose' } } }
    })
    render(<Section engine="claude" />)
    await waitFor(() => expect(screen.getAllByTestId('AgentColours.row')).toHaveLength(3))
    fireEvent.click(
      within(rowOf('Explore'))
        .getAllByTestId('AgentColours.swatch')
        .find((el) => el.getAttribute('data-id') === 'green')!
    )
    expect(useSessionStore.getState().settings.agentTypeColors).toEqual({
      pi: { Plan: 'rose' },
      claude: { Explore: 'green' }
    })
  })

  it('says so when the host lists no types', async () => {
    Object.assign(window.api, { listAgentTypes: vi.fn(async () => []) })
    render(<Section engine="pi" />)
    expect(await screen.findByTestId('AgentColours.empty')).toBeTruthy()
  })

  it('is reachable on every engine page, and the dispatch colour on the dispatch page', () => {
    for (const engine of ['claude', 'opencode', 'pi', 'codex'] as const) {
      const group = pageOf(engine).groups.find((g) => g.id === 'agent-colours')
      expect(group?.label, engine).toBe('Agent colours')
      expect(group?.items?.map((i) => i.key)).toEqual([`${engine}AgentColours`])
    }
    expect(
      pageOf('dispatch')
        .groups.find((g) => g.id === 'tile')
        ?.items?.map((i) => i.key)
    ).toEqual(['dispatchTileColour'])
  })
})

describe('Dispatch tile colour', () => {
  let app: TestApp
  let save: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    save = vi.fn(async () => {})
    Object.assign(window.api, { saveSettings: save })
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  it('previews the default orange X, takes a pick, and Reset deletes the key', () => {
    render(<DispatchSection />)
    const tile = screen.getByTestId('DispatchTileColourSection.tile')
    expect(tile.textContent).toBe('X')
    expect(tile.getAttribute('data-color')).toBe('orange')

    fireEvent.click(
      screen
        .getAllByTestId('DispatchTileColour.swatch')
        .find((el) => el.getAttribute('data-id') === 'teal')!
    )
    expect(useSessionStore.getState().settings.dispatchTileColor).toBe('teal')
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ dispatchTileColor: 'teal' }))
    expect(screen.getByTestId('DispatchTileColourSection.tile').getAttribute('data-color')).toBe(
      'teal'
    )

    fireEvent.click(screen.getByTestId('DispatchTileColour.reset'))
    expect(useSessionStore.getState().settings.dispatchTileColor).toBeUndefined()
    expect(screen.getByTestId('DispatchTileColourSection.tile').getAttribute('data-color')).toBe(
      'orange'
    )
  })
})
