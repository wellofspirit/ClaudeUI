/**
 * Layer 2: Component tests for GitFileDiffView FC.
 *
 * The FC wires store state to <GitFileDiffViewView>. We mock the View to capture
 * props, then exercise the prop callbacks and assert store effects + IPC calls.
 *
 * Tested callbacks:
 *   onToggleWrapLines         — toggles settings.diffWrapLines in store
 *   onToggleIgnoreWhitespace  — toggles settings.diffIgnoreWhitespace in store
 *   onAddComment              — adds DiffComment to gitReviewComments in store
 *   onRemoveComment           — removes DiffComment by id from store
 *   onEditComment             — removes existing comment + sets activeInput on View
 *   IPC fetch on mount        — git:file-patch is called when gitSelectedFile is set
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { GitFileDiffViewViewProps } from '../View'
import type { DiffComment, GitStatusData, GitFileStatus } from '../../../../../../shared/types'

// ---------------------------------------------------------------------------
// Mock the gutter drag selection hook — no DOM needed
// ---------------------------------------------------------------------------

vi.mock('../../../../hooks/useGutterDragSelection', () => ({
  useGutterDragSelection: () => ({ containerRef: () => {} })
}))

// ---------------------------------------------------------------------------
// Mock the View — capture rendered props without any DOM rendering
// ---------------------------------------------------------------------------

let viewProps: GitFileDiffViewViewProps

vi.mock('../View', () => ({
  GitFileDiffViewView: (props: GitFileDiffViewViewProps) => {
    viewProps = props
    return null
  }
}))

// ---------------------------------------------------------------------------
// Import the FC after the mocks are hoisted
// ---------------------------------------------------------------------------

import { GitFileDiffView } from '../GitFileDiffView'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ROUTE = 'route-gitfilediffview-test'
const CWD = '/repo/gdv'
const SELECTED_FILE = 'src/changed.ts'

const changedFile: GitFileStatus = { path: SELECTED_FILE, index: 'M', working: ' ' }

function makeGitStatus(files: GitFileStatus[] = []): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files,
    staged: files.filter((f) => f.index !== ' ' && f.index !== '?').map((f) => f.path),
    unstaged: files.filter((f) => f.index === ' ' || f.index === '?').map((f) => f.path),
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0
  }
}

function makeDiffComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'comment-1',
    filePath: SELECTED_FILE,
    lineNumber: 5,
    endLineNumber: 5,
    side: 'new',
    lineContent: 'const x = 1',
    comment: 'Looks good',
    createdAt: Date.now(),
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('GitFileDiffView FC', () => {
  let app: TestApp
  let filePatchCalls: Array<[string, string, boolean, boolean]> = []
  let fileContentsCalls: Array<[string, string, boolean]> = []

  beforeEach(async () => {
    filePatchCalls = []
    fileContentsCalls = []

    app = await bootTestApp()
    const { bridge } = app

    // Register git IPC handlers
    bridge.ipcMain.handle(
      'git:file-patch',
      (_e, cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean) => {
        filePatchCalls.push([cwd, filePath, staged, ignoreWhitespace])
        return { ok: true, data: { patch: '@@ -1 +1 @@\n-old\n+new' } }
      }
    )
    bridge.ipcMain.handle(
      'git:file-contents',
      (_e, cwd: string, filePath: string, staged: boolean) => {
        fileContentsCalls.push([cwd, filePath, staged])
        return { ok: true, data: { oldContent: 'old', newContent: 'new' } }
      }
    )

    // Seed store: create session, activate it, set cwd + gitStatus + gitSelectedFile
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setGitStatus(ROUTE, makeGitStatus([changedFile]))
    useSessionStore.getState().setGitSelectedFile(ROUTE, SELECTED_FILE)
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      directories: [],
      recentSessionIds: [],
      pinnedSessionIds: [],
      customTitles: {}
    })
  })

  // -------------------------------------------------------------------------
  // 1. onToggleWrapLines toggles the setting in store
  // -------------------------------------------------------------------------

  it('onToggleWrapLines toggles the setting in store', async () => {
    // Ensure diffWrapLines starts false (default)
    useSessionStore.getState().updateSettings({ diffWrapLines: false })

    await act(async () => {
      render(React.createElement(GitFileDiffView))
    })

    expect(useSessionStore.getState().settings.diffWrapLines).toBe(false)

    act(() => {
      viewProps.onToggleWrapLines()
    })

    expect(useSessionStore.getState().settings.diffWrapLines).toBe(true)

    act(() => {
      viewProps.onToggleWrapLines()
    })

    expect(useSessionStore.getState().settings.diffWrapLines).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 2. onToggleIgnoreWhitespace toggles the setting in store
  // -------------------------------------------------------------------------

  it('onToggleIgnoreWhitespace toggles the setting in store', async () => {
    useSessionStore.getState().updateSettings({ diffIgnoreWhitespace: false })

    await act(async () => {
      render(React.createElement(GitFileDiffView))
    })

    expect(useSessionStore.getState().settings.diffIgnoreWhitespace).toBe(false)

    act(() => {
      viewProps.onToggleIgnoreWhitespace()
    })

    expect(useSessionStore.getState().settings.diffIgnoreWhitespace).toBe(true)

    act(() => {
      viewProps.onToggleIgnoreWhitespace()
    })

    expect(useSessionStore.getState().settings.diffIgnoreWhitespace).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 3. onAddComment adds comment to store
  // -------------------------------------------------------------------------

  it('onAddComment adds a DiffComment to gitReviewComments in store', async () => {
    await act(async () => {
      render(React.createElement(GitFileDiffView))
    })

    const comment = makeDiffComment({ id: 'new-comment' })

    act(() => {
      viewProps.onAddComment(comment)
    })

    const comments = useSessionStore.getState().sessions[ROUTE].gitReviewComments
    expect(comments).toHaveLength(1)
    expect(comments[0]).toEqual(comment)
  })

  it('onAddComment appends when multiple comments already exist', async () => {
    // Pre-populate two comments via the store action
    const first = makeDiffComment({ id: 'c1', comment: 'First' })
    const second = makeDiffComment({ id: 'c2', comment: 'Second' })
    useSessionStore.getState().addDiffComment(ROUTE, first)
    useSessionStore.getState().addDiffComment(ROUTE, second)

    await act(async () => {
      render(React.createElement(GitFileDiffView))
    })

    const third = makeDiffComment({ id: 'c3', comment: 'Third' })

    act(() => {
      viewProps.onAddComment(third)
    })

    const comments = useSessionStore.getState().sessions[ROUTE].gitReviewComments
    expect(comments).toHaveLength(3)
    expect(comments.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  // -------------------------------------------------------------------------
  // 4. onRemoveComment removes comment from store
  // -------------------------------------------------------------------------

  it('onRemoveComment removes the targeted comment from store', async () => {
    const keep = makeDiffComment({ id: 'keep', comment: 'Keep this' })
    const remove = makeDiffComment({ id: 'remove', comment: 'Remove this' })
    useSessionStore.getState().addDiffComment(ROUTE, keep)
    useSessionStore.getState().addDiffComment(ROUTE, remove)

    await act(async () => {
      render(React.createElement(GitFileDiffView))
    })

    act(() => {
      viewProps.onRemoveComment('remove')
    })

    const comments = useSessionStore.getState().sessions[ROUTE].gitReviewComments
    expect(comments).toHaveLength(1)
    expect(comments[0].id).toBe('keep')
  })

  it('onRemoveComment is a no-op when the id does not exist', async () => {
    const existing = makeDiffComment({ id: 'existing' })
    useSessionStore.getState().addDiffComment(ROUTE, existing)

    await act(async () => {
      render(React.createElement(GitFileDiffView))
    })

    act(() => {
      viewProps.onRemoveComment('nonexistent')
    })

    const comments = useSessionStore.getState().sessions[ROUTE].gitReviewComments
    expect(comments).toHaveLength(1)
    expect(comments[0].id).toBe('existing')
  })

  // -------------------------------------------------------------------------
  // 5. onEditComment removes the comment and sets activeInput
  // -------------------------------------------------------------------------

  it('onEditComment removes the comment from store and populates activeInput on View', async () => {
    const comment = makeDiffComment({
      id: 'edit-me',
      lineNumber: 10,
      endLineNumber: 12,
      side: 'new',
      lineContent: 'const foo = bar',
      comment: 'Check this'
    })
    useSessionStore.getState().addDiffComment(ROUTE, comment)

    await act(async () => {
      render(React.createElement(GitFileDiffView))
    })

    // Confirm comment is in store before edit
    expect(useSessionStore.getState().sessions[ROUTE].gitReviewComments).toHaveLength(1)

    act(() => {
      viewProps.onEditComment(comment)
    })

    // Comment should be removed from store
    const comments = useSessionStore.getState().sessions[ROUTE].gitReviewComments
    expect(comments).toHaveLength(0)

    // activeInput should reflect the comment's position for editing
    expect(viewProps.activeInput).not.toBeNull()
    expect(viewProps.activeInput?.lineNumber).toBe(comment.endLineNumber)
    expect(viewProps.activeInput?.startLine).toBe(comment.lineNumber)
    expect(viewProps.activeInput?.endLine).toBe(comment.endLineNumber)
    expect(viewProps.activeInput?.side).toBe(comment.side)
    expect(viewProps.activeInput?.lineContent).toBe(comment.lineContent)
    expect(viewProps.activeInput?.editText).toBe(comment.comment)
  })

  // -------------------------------------------------------------------------
  // 6. Fetches patch via IPC when gitSelectedFile is set on mount
  // -------------------------------------------------------------------------

  it('calls git:file-patch IPC when gitSelectedFile is set on mount', async () => {
    await act(async () => {
      render(React.createElement(GitFileDiffView))
      // Allow the async useEffect fetch to complete
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(filePatchCalls).toHaveLength(1)
    expect(filePatchCalls[0][0]).toBe(CWD)
    expect(filePatchCalls[0][1]).toBe(SELECTED_FILE)
    // changedFile has index 'M' → staged = true
    expect(filePatchCalls[0][2]).toBe(true)
  })

  it('does not call git:file-patch when no file is selected', async () => {
    // Clear the selected file
    useSessionStore.getState().setGitSelectedFile(ROUTE, null)

    await act(async () => {
      render(React.createElement(GitFileDiffView))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(filePatchCalls).toHaveLength(0)
  })
})
