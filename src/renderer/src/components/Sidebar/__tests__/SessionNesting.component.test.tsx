/**
 * Layer 2: parent/child links in the sidebar (session tools, slice 1b).
 *
 * The links arrive the way they do in the app — a `session:link-changed` event
 * through the replica fold — and the real `DirectoryItem` / `PinnedSessionList`
 * draw them: a child under its parent in the Projects view with a fold toggle on
 * the parent; a child whose parent is elsewhere (another project, hidden) stays
 * top-level with a "↳ parent" hint; the flat lists carry the same hint; and
 * Detach is a command on the child.
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

const link = (parentRef: string, over: Partial<SessionLinkInfo> = {}): SessionLinkInfo => ({
  parentRef,
  kind: 'started',
  state: 'live',
  createdBy: 'agent',
  wakeParent: false,
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

describe('sidebar nesting', () => {
  let app: TestApp
  const A = group('proj-a', [info('x', 'Other'), info('c', 'Child'), info('p', 'Parent')])

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

  it('draws a child right under its parent, indented, with no hint (the parent is right above)', () => {
    link2()
    renderGroup(A)
    expect(ids()).toEqual(['x', 'p', 'c'])
    expect(row('p').getAttribute('data-depth')).toBe('0')
    expect(row('c').getAttribute('data-depth')).toBe('1')
    expect(within(row('c')).queryByTestId('SessionItem.parentHint')).toBeNull()
    expect(within(row('p')).getByTestId('SessionItem.toggleChildren').textContent).toContain('1')
    expect(within(row('x')).queryByTestId('SessionItem.toggleChildren')).toBeNull()
  })

  it('leaves the list flat without links', () => {
    renderGroup(A)
    expect(ids()).toEqual(['x', 'c', 'p'])
    expect(screen.queryByTestId('SessionItem.toggleChildren')).toBeNull()
  })

  it('folds and unfolds the children from the parent’s toggle, and remembers it', () => {
    link2()
    renderGroup(A)
    const toggle = within(row('p')).getByTestId('SessionItem.toggleChildren')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(ids()).toEqual(['x', 'p'])
    expect(
      within(row('p')).getByTestId('SessionItem.toggleChildren').getAttribute('data-collapsed')
    ).toBe('true')
    cleanup()
    // A new page load starts from what the client stored.
    resetCollapsedParentsForTests()
    renderGroup(A)
    expect(ids()).toEqual(['x', 'p'])

    fireEvent.click(within(row('p')).getByTestId('SessionItem.toggleChildren'))
    expect(ids()).toEqual(['x', 'p', 'c'])
  })

  it('unfolds the parent when its child becomes the active session, so the active row is on screen', () => {
    link2()
    const view = renderGroup(A)
    fireEvent.click(within(row('p')).getByTestId('SessionItem.toggleChildren'))
    expect(ids()).toEqual(['x', 'p'])

    // The user opens the child from a card or the continued-in bar.
    view.unmount()
    renderGroup(A, { active: 'c' })
    expect(ids()).toEqual(['x', 'p', 'c'])
    expect(row('c').className).toContain('bg-bg-tertiary')

    // Folding it again while the child is active sticks until another session is opened.
    fireEvent.click(within(row('p')).getByTestId('SessionItem.toggleChildren'))
    expect(ids()).toEqual(['x', 'p'])
  })

  it('keeps a child whose parent is in another project at the top of its own, with a hint naming the parent', () => {
    const other = group('proj-b', [info('pb', 'Parent in B', 'proj-b')])
    useSessionStore.setState({ directories: [A, other] })
    mirrorStoreIntoReplica()
    link2({}, 'pb')
    const onlyChildren = group('proj-a', [info('c', 'Child'), info('x', 'Other')])
    renderGroup(onlyChildren)
    expect(ids()).toEqual(['c', 'x'])
    expect(row('c').getAttribute('data-depth')).toBe('0')
    expect(within(row('c')).getByTestId('SessionItem.parentHint').textContent).toBe('↳ Parent in B')
  })

  it('keeps a child under a hidden parent top-level, with the hint', () => {
    link2()
    renderGroup(A, { hidden: ['p'] })
    expect(ids()).toEqual(['x', 'c'])
    expect(within(row('c')).getByTestId('SessionItem.parentHint').textContent).toBe('↳ Parent')
  })

  it('draws a detached child top-level with no hint, and a failed one still nested', () => {
    link2({ state: 'detached' })
    renderGroup(A)
    expect(ids()).toEqual(['x', 'c', 'p'])
    expect(within(row('c')).queryByTestId('SessionItem.parentHint')).toBeNull()
    cleanup()

    link2({ state: 'failed' })
    renderGroup(A)
    expect(ids()).toEqual(['x', 'p', 'c'])
  })

  it('carries the parent hint in the flat lists (Pinned, Recent and Watching draw the same row)', () => {
    link2()
    render(
      <PinnedSessionList
        pinnedSessions={[info('c', 'Child'), info('p', 'Parent')]}
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
    expect(within(row('c')).getByTestId('SessionItem.parentHint').textContent).toBe('↳ Parent')
    expect(within(row('p')).queryByTestId('SessionItem.parentHint')).toBeNull()
    expect(screen.queryByTestId('SessionItem.toggleChildren')).toBeNull()
    expect(row('c').getAttribute('data-depth')).toBe('0')
  })

  it('follows the link the host replicates: a detach arriving from another client un-nests the child', () => {
    link2()
    renderGroup(A)
    expect(ids()).toEqual(['x', 'p', 'c'])
    link2({ state: 'detached' })
    expect(ids()).toEqual(['x', 'c', 'p'])
  })

  it('offers Detach on a child only, as the session:link:detach command on the child', async () => {
    const detach = vi.fn(async () => ({ success: true }))
    app.bridge.ipcMain.handle('session:link:detach', detach)
    link2()
    renderGroup(A)

    fireEvent.contextMenu(row('p'))
    expect(screen.queryByTestId('SessionItem.detach')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    cleanup()
    renderGroup(A)

    fireEvent.contextMenu(row('c'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('SessionItem.detach'))
    })
    expect(detach).toHaveBeenCalledTimes(1)
    expect(detach.mock.calls[0].slice(1)).toEqual(['c'])
  })
})
