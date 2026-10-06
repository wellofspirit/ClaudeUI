/**
 * Layer 2: the shared agent-type catalog hook (ADR-093).
 *
 * What has to hold: a failed read is never remembered (a reconnect must not leave
 * every tile on its hash colour for the life of the window); a tile already on
 * screen picks up a later read (the settings page's `fresh` one); and a hook
 * whose key changes never shows the previous key's list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { AgentTypeInfo, EngineId } from '../../../../shared/types'
import { resetAgentTypeCatalog, useAgentTypeCatalog } from '../useAgentTypeCatalog'

function Probe(props: {
  engine?: EngineId
  cwd?: string
  fresh?: boolean
  testId?: string
}): React.JSX.Element {
  const types = useAgentTypeCatalog(props.engine ?? 'claude', props.cwd, { fresh: props.fresh })
  return (
    <span data-testid={props.testId ?? 'probe'}>
      {types.map((t) => `${t.type}:${t.nativeColor ?? ''}`).join(',')}
    </span>
  )
}

const catalog = (...pairs: Array<[string, string?]>): AgentTypeInfo[] =>
  pairs.map(([type, nativeColor]) => ({
    type,
    source: 'user' as const,
    ...(nativeColor ? { nativeColor } : {})
  }))

describe('useAgentTypeCatalog', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    resetAgentTypeCatalog()
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  it('shares one read between every tile on screen', async () => {
    const list = vi.fn(async () => catalog(['reviewer', 'blue']))
    Object.assign(window.api, { listAgentTypes: list })
    render(
      <>
        <Probe testId="a" />
        <Probe testId="b" />
        <Probe testId="c" />
      </>
    )
    await waitFor(() => expect(screen.getByTestId('c').textContent).toBe('reviewer:blue'))
    expect(screen.getByTestId('a').textContent).toBe('reviewer:blue')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed read: the next mount asks again', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue(catalog(['reviewer', 'blue']))
    Object.assign(window.api, { listAgentTypes: list })

    const first = render(<Probe />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(list).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('probe').textContent).toBe('')
    first.unmount()

    // Reconnected: a new tile mounts and gets the real answer, not a remembered empty one.
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('reviewer:blue'))
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('does not cache a non-list answer either', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValue(catalog(['reviewer']))
    Object.assign(window.api, { listAgentTypes: list })
    const first = render(<Probe />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    first.unmount()
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('reviewer:'))
  })

  it('updates a mounted tile when another hook reads fresh (the settings page)', async () => {
    let answer = catalog(['reviewer', 'blue'])
    Object.assign(window.api, { listAgentTypes: vi.fn(async () => answer) })
    render(<Probe testId="tile" />)
    await waitFor(() => expect(screen.getByTestId('tile').textContent).toBe('reviewer:blue'))

    // The user edits the agent file, then opens the settings page.
    answer = catalog(['reviewer', 'red'])
    render(<Probe testId="settings" fresh />)
    await waitFor(() => expect(screen.getByTestId('settings').textContent).toBe('reviewer:red'))
    // The tile that was already mounted follows, without remounting.
    expect(screen.getByTestId('tile').textContent).toBe('reviewer:red')
  })

  it('never shows the previous key’s list while the new key has none', async () => {
    Object.assign(window.api, {
      listAgentTypes: vi.fn((_engine: EngineId, cwd?: string) =>
        cwd === '/a' ? Promise.resolve(catalog(['from-a'])) : new Promise<AgentTypeInfo[]>(() => {})
      )
    })
    const view = render(<Probe cwd="/a" />)
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('from-a:'))
    view.rerender(<Probe cwd="/b" />)
    expect(screen.getByTestId('probe').textContent).toBe('')
    // And back: /a is remembered.
    view.rerender(<Probe cwd="/a" />)
    expect(screen.getByTestId('probe').textContent).toBe('from-a:')
  })

  it('does not ask the host when disabled', () => {
    const list = vi.fn(async () => catalog(['x']))
    Object.assign(window.api, { listAgentTypes: list })
    function Off(): React.JSX.Element {
      useAgentTypeCatalog('claude', undefined, { enabled: false })
      return <span />
    }
    render(<Off />)
    expect(list).not.toHaveBeenCalled()
  })
})
