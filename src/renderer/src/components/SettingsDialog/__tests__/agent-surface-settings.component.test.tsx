/**
 * Layer 2: Settings → Appearance → Agents (ADR-073).
 *
 * Both surfaces are optional by owner ruling, so the two rows have to exist on
 * that page, write to the store, and actually take the surfaces off screen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { useSessionStore, DEFAULT_SETTINGS } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { PAGES } from '../settings-pages'
import { AgentPill } from '../../agents/AgentPill'
import { AgentTab } from '../../agents/AgentTab'
import type { ChatMessage } from '../../../../../shared/types'
import type { AppSettings } from '../../../stores/session-store'

/** The group under test, looked up the way the dialog itself does. */
function agentsGroup() {
  const appearance = PAGES.find((p) => p.id === 'appearance')
  const group = appearance?.groups.find((g) => g.id === 'agents')
  if (!group) throw new Error('no Agents group on the Appearance page')
  return group
}

const ROUTE = 'route-agent-settings'

function taskMessage(): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        toolUseId: 'tu-a',
        toolName: 'Task',
        toolInput: { name: 'reviewer', description: 'work' }
      }
    ],
    timestamp: Date.now()
  } as ChatMessage
}

describe('agent surface settings', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE, settings: { ...DEFAULT_SETTINGS } })
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          messages: [taskMessage()],
          activeTasks: { 'tu-a': { taskId: 'a1', taskType: 'local_agent' } }
        }
      }
    }))
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('lives in an Agents group on the Appearance page', () => {
    expect(agentsGroup().label).toBe('Agents')
    expect(agentsGroup().items?.map((i) => i.key)).toEqual(['showAgentPill', 'showAgentTab'])
  })

  it('both default to on', () => {
    expect(DEFAULT_SETTINGS.showAgentPill).toBe(true)
    expect(DEFAULT_SETTINGS.showAgentTab).toBe(true)
  })

  it('each row writes its own key, and nothing else', async () => {
    const patches: Partial<AppSettings>[] = []
    const update = (p: Partial<AppSettings>): void => {
      patches.push(p)
    }
    // The four engine/vendor arguments are positional and unused by these two
    // rows; `render`'s signature requires them all the same.
    const unused = {} as never

    await act(async () => {
      render(
        <>
          {(agentsGroup().items ?? []).map((item) => (
            <div key={item.key}>
              {item.render(
                useSessionStore.getState().settings,
                update,
                unused,
                unused,
                unused,
                unused
              )}
            </div>
          ))}
        </>
      )
    })

    fireEvent.click(screen.getByTestId('SettingsAgentPill'))
    fireEvent.click(screen.getByTestId('SettingsAgentTab'))
    expect(patches).toEqual([{ showAgentPill: false }, { showAgentTab: false }])
  })

  it('turning them off takes each surface off screen', async () => {
    await act(async () => {
      render(
        <>
          <AgentPill />
          <AgentTab />
        </>
      )
    })
    expect(screen.getByTestId('AgentPill')).toBeTruthy()
    expect(screen.getByTestId('AgentTab')).toBeTruthy()

    await act(async () => {
      useSessionStore.setState({
        settings: { ...DEFAULT_SETTINGS, showAgentPill: false, showAgentTab: false }
      })
    })
    expect(screen.queryByTestId('AgentPill')).toBeNull()
    expect(screen.queryByTestId('AgentTab')).toBeNull()
  })
})
