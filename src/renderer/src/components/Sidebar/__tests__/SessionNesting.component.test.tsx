/**
 * Layer 2: session groups in the sidebar (session tools, slice 1b; flat groups in slice 5).
 *
 * The links arrive the way they do in the app — a `session:link-changed` event
 * through the replica fold — and the real `DirectoryItem` / `PinnedSessionList`
 * draw them: a grouped session one level under its group's head in the Projects view
 * with a fold toggle and a count on the head; a standalone session, or one whose head is
 * elsewhere (another project, hidden), stays a top-level row; every row that came from
 * another session carries a "started from" / "continued from" hint, in the flat lists
 * too; and Detach from group / Add to group are one command on the row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica, seed } from '@test/helpers/replica-seed'
import type { SessionLinkInfo } from '../../../../../shared/session-links'
import type { DirectoryGroup, SessionInfo } from '../../../../../shared/types'
import { resetCollapsedParentsForTests } from '../../../lib/collapsed-parents'
import { DirectoryItem } from '../DirectoryItem'
import { PinnedSessionList } from '../PinnedSessionList'

const info = (sessionId: string, title: string, projectKey = 'proj-a'): SessionInfo => ({
  sessionId,
  cwd: `/work/${projectKey}`,
  projectKey,
  title,
  timestamp: 0,
  lastActivityAt: 0
})

const group = (projectKey: string, sessions: SessionInfo[]): DirectoryGroup => ({
  cwd: `/work/${projectKey}`,
  projectKey,
  folderName: projectKey,
  sessions
})

const link = (originRef: string, over: Partial<SessionLinkInfo> = {}): SessionLinkInfo => ({
  originRef,
  kind: 'started',
  state: 'live',
  createdBy: 'agent',
  grouped: true,
  createdAt: 1,
  ...over
})

function noop(): void {}

function renderGroup(
  g: DirectoryGroup,
  extra: { hidden?: string[]; active?: string | null } = {}
): ReturnType<typeof render> {
  return render(
    <DirectoryItem
      group={g}
      expanded
      activeSessionId={extra.active ?? null}
      onClick={noop}
      onDoubleClick={noop}
      onSessionClick={noop}
      onSessionDoubleClick={noop}
      onToggleWatch={noop}
      renamingKey={null}
      renamePrefix="project:test"
      onStartRename={noop}
      onFinishRename={noop}
      onAutoRename={noop}
      onCancelRename={noop}
      hiddenSessionIds={new Set(extra.hidden ?? [])}
    />
  )
}

const ids = (): string[] =>
  screen.getAllByTestId('SessionItem').map((el) => el.getAttribute('data-id') ?? '')
const row = (id: string): HTMLElement =>
  screen.getAllByTestId('SessionItem').find((el) => el.getAttribute('data-id') === id)!

describe('sidebar groups', () => {
  let app: TestApp
  const A = group('proj-a', [info('x', 'Other'), info('c', 'Member'), info('p', 'Head')])

  beforeEach(async () => {
    ;(window as unknown as { matchMedia: unknown }).matchMedia ??= (): MediaQueryList =>
      ({
        matches: false,
        media: '',
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      }) as unknown as MediaQueryList
    app = await bootTestApp()
    localStorage.clear()
    resetCollapsedParentsForTests()
    useSessionStore.setState({ directories: [A], customTitles: {}, sessions: {} })
    mirrorStoreIntoReplica()
    // The replica outlives a test; start from no links.
    act(() => seed.links({ links: {}, refs: {} }))
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  function link2(over: Partial<SessionLinkInfo> = {}, parentId = 'p'): void {
    act(() => {
      seed.links({
        links: { 'r-c': link('r-p', over) },
        refs: { c: 'r-c', [parentId]: 'r-p' }
      })
    })
  }

  it('draws a grouped session right under its head, one level in, with the head’s count and its own hint', () => {
    link2()
    renderGroup(A)
    expect(ids()).toEqual(['x', 'p', 'c'])
    expect(row('p').getAttribute('data-depth')).toBe('0')
    expect(row('c').getAttribute('data-depth')).toBe('1')
    expect(within(row('c')).getByTestId('SessionItem.originHint').textContent).toBe(
      'started from Head'
    )
    expect(within(row('p')).getByTestId('SessionItem.toggleMembers').textContent).toContain('1')
    expect(within(row('x')).queryByTestId('SessionItem.toggleMembers')).toBeNull()
  })

  it('says "continued from" for a hand-off and "started from" for a same-work start', () => {
    link2({ kind: 'handoff' })
    renderGroup(A)
    expect(within(row('c')).getByTestId('SessionItem.originHint').textContent).toBe(
      'continued from Head'
    )
    cleanup()
    link2({ kind: 'started' })
    renderGroup(A)
    expect(within(row('c')).getByTestId('SessionItem.originHint').textContent).toBe(
      'started from Head'
    )
  })

  it('draws four hand-offs as the head and four members, all at depth 1, never deeper', () => {
    const chain = group('proj-a', [
      info('h4', 'H4'),
      info('h3', 'H3'),
      info('h2', 'H2'),
      info('h1', 'H1'),
      info('p', 'Head')
    ])
    useSessionStore.setState({ directories: [chain] })
    mirrorStoreIntoReplica()
    act(() => {
      seed.links({
        links: {
          'r-h1': link('r-p', { kind: 'handoff', createdAt: 1 }),
          'r-h2': link('r-h1', { kind: 'handoff', createdAt: 2 }),
          'r-h3': link('r-h2', { kind: 'handoff', createdAt: 3 }),
          'r-h4': link('r-h3', { kind: 'handoff', createdAt: 4 })
        },
        refs: { p: 'r-p', h1: 'r-h1', h2: 'r-h2', h3: 'r-h3', h4: 'r-h4' }
      })
    })
    renderGroup(chain)
    expect(ids()).toEqual(['p', 'h1', 'h2', 'h3', 'h4'])
    expect(screen.getAllByTestId('SessionItem').map((el) => el.getAttribute('data-depth'))).toEqual(
      ['0', '1', '1', '1', '1']
    )
    expect(within(row('p')).getByTestId('SessionItem.toggleMembers').textContent).toContain('4')
    // Each member names the session it directly continued from.
    expect(within(row('h3')).getByTestId('SessionItem.originHint').textContent).toBe(
      'continued from H2'
    )
  })

  it('leaves the list flat without links', () => {
    renderGroup(A)
    expect(ids()).toEqual(['x', 'c', 'p'])
    expect(screen.queryByTestId('SessionItem.toggleMembers')).toBeNull()
    expect(screen.queryByTestId('SessionItem.originHint')).toBeNull()
  })

  it('folds and unfolds the members from the head’s toggle, and remembers it', () => {
    link2()
    renderGroup(A)
    const toggle = within(row('p')).getByTestId('SessionItem.toggleMembers')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(ids()).toEqual(['x', 'p'])
    expect(
      within(row('p')).getByTestId('SessionItem.toggleMembers').getAttribute('data-collapsed')
    ).toBe('true')
    cleanup()
    // A new page load starts from what the client stored.
    resetCollapsedParentsForTests()
    renderGroup(A)
    expect(ids()).toEqual(['x', 'p'])

    fireEvent.click(within(row('p')).getByTestId('SessionItem.toggleMembers'))
    expect(ids()).toEqual(['x', 'p', 'c'])
  })

  it('unfolds the group when a member becomes the active session, so the active row is on screen', () => {
    link2()
    const view = renderGroup(A)
    fireEvent.click(within(row('p')).getByTestId('SessionItem.toggleMembers'))
    expect(ids()).toEqual(['x', 'p'])

    // The user opens the member from a card or the continued-in bar.
    view.unmount()
    renderGroup(A, { active: 'c' })
    expect(ids()).toEqual(['x', 'p', 'c'])
    expect(row('c').className).toContain('bg-bg-tertiary')

    // Folding it again while the member is active sticks until another session is opened.
    fireEvent.click(within(row('p')).getByTestId('SessionItem.toggleMembers'))
    expect(ids()).toEqual(['x', 'p'])
  })

  it('keeps a member whose head is in another project at the top of its own, with a hint naming where it came from', () => {
    const other = group('proj-b', [info('pb', 'Head in B', 'proj-b')])
    useSessionStore.setState({ directories: [A, other] })
    mirrorStoreIntoReplica()
    link2({}, 'pb')
    const onlyMembers = group('proj-a', [info('c', 'Member'), info('x', 'Other')])
    renderGroup(onlyMembers)
    expect(ids()).toEqual(['c', 'x'])
    expect(row('c').getAttribute('data-depth')).toBe('0')
    expect(within(row('c')).getByTestId('SessionItem.originHint').textContent).toBe(
      'started from Head in B'
    )
  })

  it('keeps a member under a hidden head top-level, with the hint', () => {
    link2()
    renderGroup(A, { hidden: ['p'] })
    expect(ids()).toEqual(['x', 'c'])
    expect(within(row('c')).getByTestId('SessionItem.originHint').textContent).toBe(
      'started from Head'
    )
  })

  it('draws a standalone session as an ordinary top-level row with a faint hint, and a failed member still in the group', () => {
    link2({ grouped: false })
    renderGroup(A)
    expect(ids()).toEqual(['x', 'c', 'p'])
    expect(row('c').getAttribute('data-depth')).toBe('0')
    expect(screen.queryByTestId('SessionItem.toggleMembers')).toBeNull()
    const hint = within(row('c')).getByTestId('SessionItem.originHint')
    expect(hint.textContent).toBe('started from Head')
    expect(hint.getAttribute('data-grouped')).toBe('false')
    cleanup()

    link2({ state: 'failed' })
    renderGroup(A)
    expect(ids()).toEqual(['x', 'p', 'c'])
  })

  it('carries the hint in the flat lists (Pinned, Recent and Watching draw the same row), and never groups there', () => {
    link2()
    render(
      <PinnedSessionList
        pinnedSessions={[info('c', 'Member'), info('p', 'Head')]}
        activeSessionId={null}
        onClickSession={noop}
        onToggleWatch={noop}
        onUnpin={noop}
        onReorder={noop}
        renamingKey={null}
        renamePrefix="pinned"
        onStartRename={noop}
        onFinishRename={noop}
        onAutoRename={noop}
        onCancelRename={noop}
      />
    )
    expect(ids()).toEqual(['c', 'p'])
    expect(within(row('c')).getByTestId('SessionItem.originHint').textContent).toBe(
      'started from Head'
    )
    expect(within(row('p')).queryByTestId('SessionItem.originHint')).toBeNull()
    expect(screen.queryByTestId('SessionItem.toggleMembers')).toBeNull()
    expect(row('c').getAttribute('data-depth')).toBe('0')
  })

  it('follows the link the host replicates: a detach arriving from another client takes the member out of the group', () => {
    link2()
    renderGroup(A)
    expect(ids()).toEqual(['x', 'p', 'c'])
    link2({ grouped: false })
    expect(ids()).toEqual(['x', 'c', 'p'])
    link2({ grouped: true })
    expect(ids()).toEqual(['x', 'p', 'c'])
  })

  it('offers Detach from group on a grouped session only, and Add to group on a standalone one with an origin: both are session:link:set-grouped on that session', async () => {
    const setGrouped = vi.fn(async () => ({ success: true }))
    app.bridge.ipcMain.handle('session:link:set-grouped', setGrouped)
    link2()
    renderGroup(A)

    // The head and a session with no link offer neither.
    fireEvent.contextMenu(row('p'))
    expect(screen.queryByTestId('SessionItem.detach')).toBeNull()
    expect(screen.queryByTestId('SessionItem.attach')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    cleanup()
    renderGroup(A)

    fireEvent.contextMenu(row('c'))
    expect(screen.queryByTestId('SessionItem.attach')).toBeNull()
    expect(screen.getByTestId('SessionItem.detach').textContent).toBe('Detach from group')
    await act(async () => {
      fireEvent.click(screen.getByTestId('SessionItem.detach'))
    })
    expect(setGrouped).toHaveBeenCalledTimes(1)
    expect(setGrouped.mock.calls[0].slice(1)).toEqual(['c', false])
    cleanup()

    link2({ grouped: false })
    renderGroup(A)
    fireEvent.contextMenu(row('c'))
    expect(screen.queryByTestId('SessionItem.detach')).toBeNull()
    expect(screen.getByTestId('SessionItem.attach').textContent).toBe('Add to group')
    await act(async () => {
      fireEvent.click(screen.getByTestId('SessionItem.attach'))
    })
    expect(setGrouped).toHaveBeenCalledTimes(2)
    expect(setGrouped.mock.calls[1].slice(1)).toEqual(['c', true])
  })

  it('does not offer Add to group when the session it came from is gone', () => {
    // The ref of the origin names no session any more.
    act(() => {
      seed.links({ links: { 'r-c': link('r-gone', { grouped: false }) }, refs: { c: 'r-c' } })
    })
    renderGroup(A)
    fireEvent.contextMenu(row('c'))
    expect(screen.queryByTestId('SessionItem.attach')).toBeNull()
    expect(screen.queryByTestId('SessionItem.detach')).toBeNull()
  })
})
