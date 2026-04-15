/**
 * Layer 2: Component tests for ReviewBar.
 *
 * Part 1 — composeReviewPrompt: Pure business logic tests. No React rendering.
 *
 * Part 2 — ReviewBar FC (rendered): Renders the FC, captures the View props it
 * passes to <ReviewBarView />, and calls prop callbacks to assert IPC + store
 * effects. The View is mocked so no real DOM is rendered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DiffComment } from '../../../../../../shared/types'
import { composeReviewPrompt } from '../utils'

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'c1',
    filePath: 'src/main.ts',
    lineNumber: 10,
    endLineNumber: 10,
    side: 'new',
    lineContent: 'const x = 1',
    comment: 'Fix this',
    createdAt: Date.now(),
    ...overrides,
  }
}

const HEADER = 'Please address these review comments on the current git changes:\n'

describe('composeReviewPrompt', () => {
  it('starts with the instruction header', () => {
    const result = composeReviewPrompt([makeComment()])
    expect(result).toMatch(/^Please address these review comments/)
  })

  it('formats a single-line comment with file, line, side, quote and comment text', () => {
    const result = composeReviewPrompt([
      makeComment({ filePath: 'src/app.ts', lineNumber: 5, endLineNumber: 5, side: 'new', lineContent: 'let foo = bar', comment: 'Avoid let' }),
    ])

    expect(result).toContain('**src/app.ts** (line 5, new side):')
    expect(result).toContain('> let foo = bar')
    expect(result).toContain('Comment: "Avoid let"')
  })

  it('uses en-dash range label when endLineNumber exceeds lineNumber', () => {
    const result = composeReviewPrompt([
      makeComment({ lineNumber: 3, endLineNumber: 7 }),
    ])

    // en-dash U+2013
    expect(result).toContain('lines 3\u20137')
    expect(result).not.toContain('line 3\u2013') // no "line" prefix for range
  })

  it('uses single-line label when endLineNumber equals lineNumber', () => {
    const result = composeReviewPrompt([
      makeComment({ lineNumber: 42, endLineNumber: 42 }),
    ])

    expect(result).toContain('line 42')
    expect(result).not.toContain('lines 42')
  })

  it('respects the side field — old side', () => {
    const result = composeReviewPrompt([
      makeComment({ side: 'old' }),
    ])

    expect(result).toContain('old side')
  })

  it('groups multiple comments on the same file together', () => {
    const comments = [
      makeComment({ id: 'c1', filePath: 'a.ts', lineNumber: 1, endLineNumber: 1, comment: 'First' }),
      makeComment({ id: 'c2', filePath: 'b.ts', lineNumber: 1, endLineNumber: 1, comment: 'Second' }),
      makeComment({ id: 'c3', filePath: 'a.ts', lineNumber: 2, endLineNumber: 2, comment: 'Third' }),
    ]
    const result = composeReviewPrompt(comments)

    // Both a.ts entries appear before b.ts
    const firstA = result.indexOf('**a.ts**')
    const secondA = result.indexOf('**a.ts**', firstA + 1)
    const firstB = result.indexOf('**b.ts**')

    expect(firstA).toBeGreaterThanOrEqual(0)
    expect(secondA).toBeGreaterThanOrEqual(0)
    expect(firstB).toBeGreaterThanOrEqual(0)
    expect(firstA).toBeLessThan(firstB)
    expect(secondA).toBeLessThan(firstB)
  })

  it('outputs comments on different files in separate groups', () => {
    const comments = [
      makeComment({ id: 'c1', filePath: 'alpha.ts', comment: 'Alpha comment' }),
      makeComment({ id: 'c2', filePath: 'beta.ts', comment: 'Beta comment' }),
    ]
    const result = composeReviewPrompt(comments)

    expect(result).toContain('**alpha.ts**')
    expect(result).toContain('**beta.ts**')
    // Both comments present
    expect(result).toContain('Comment: "Alpha comment"')
    expect(result).toContain('Comment: "Beta comment"')
  })

  it('skips the blockquote when lineContent is falsy', () => {
    const result = composeReviewPrompt([
      makeComment({ lineContent: '' }),
    ])

    expect(result).not.toContain('> ')
    expect(result).toContain('Comment: "Fix this"')
  })

  it('prefixes each line of multi-line lineContent with "> "', () => {
    const result = composeReviewPrompt([
      makeComment({ lineContent: 'line1\nline2\nline3' }),
    ])

    expect(result).toContain('> line1\n> line2\n> line3')
  })

  it('preserves insertion order of files within groups', () => {
    // c1 → file-x, c2 → file-y, c3 → file-x
    // file-x group should preserve c1 then c3 order
    const comments = [
      makeComment({ id: 'c1', filePath: 'file-x.ts', lineNumber: 1, comment: 'Comment A' }),
      makeComment({ id: 'c2', filePath: 'file-y.ts', lineNumber: 1, comment: 'Comment B' }),
      makeComment({ id: 'c3', filePath: 'file-x.ts', lineNumber: 99, comment: 'Comment C' }),
    ]
    const result = composeReviewPrompt(comments)

    const posA = result.indexOf('Comment: "Comment A"')
    const posC = result.indexOf('Comment: "Comment C"')
    expect(posA).toBeGreaterThanOrEqual(0)
    expect(posC).toBeGreaterThanOrEqual(0)
    expect(posA).toBeLessThan(posC)
  })

  it('returns only the header when given an empty array', () => {
    const result = composeReviewPrompt([])
    expect(result).toBe(HEADER)
  })
})

// ---------------------------------------------------------------------------
// FC rendering tests — exercises View prop callbacks via IPC + store
// ---------------------------------------------------------------------------

import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../../../stores/session-store'
import { resetFactoryCounter } from '@test/factories/messages'
import type { ReviewBarViewProps } from '../View'
import { ReviewBar } from '../ReviewBar'

let viewProps: ReviewBarViewProps

vi.mock('../View', () => ({
  ReviewBarView: (props: ReviewBarViewProps) => {
    viewProps = props
    return null
  },
}))

function makeDiffComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'c1',
    filePath: 'src/main.ts',
    lineNumber: 10,
    endLineNumber: 10,
    side: 'new' as const,
    lineContent: 'const x = 1',
    comment: 'Fix this',
    createdAt: Date.now(),
    ...overrides,
  }
}

const FC_ROUTE = 'route-reviewbar-fc'
const FC_CWD = '/repo-reviewbar'

describe('ReviewBar FC — rendered', () => {
  let app: TestApp
  let createCalls: Array<unknown[]> = []
  let sendCalls: Array<[string, string]> = []

  beforeEach(async () => {
    resetFactoryCounter()
    createCalls = []
    sendCalls = []

    app = await bootTestApp()
    const { bridge } = app

    bridge.ipcMain.handle('session:create', (_e, ...args: unknown[]) => {
      createCalls.push(args)
      return null
    })
    bridge.ipcMain.handle('session:send', (_e, routingId: string, prompt: string) => {
      sendCalls.push([routingId, prompt])
      return null
    })

    // Seed the store: create session, set it active
    useSessionStore.getState().createNewSession(FC_ROUTE, FC_CWD)
    useSessionStore.setState({ activeSessionId: FC_ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      directories: [],
      recentSessionIds: [],
      pinnedSessionIds: [],
      customTitles: {},
    })
  })

  it('onSend creates session when not active and sends prompt', async () => {
    // sdkActive defaults to false in a freshly created session
    const comments = [makeDiffComment()]
    render(React.createElement(ReviewBar, { comments }))

    await act(async () => {
      await viewProps.onSend()
    })

    // session:create was called before session:send
    expect(createCalls).toHaveLength(1)
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0][0]).toBe(FC_ROUTE)
    // Prompt should be the composed review prompt
    expect(sendCalls[0][1]).toMatch(/^Please address these review comments/)
    expect(sendCalls[0][1]).toContain('src/main.ts')

    // markSdkActive should have been called: sdkActive is now true in store
    expect(useSessionStore.getState().sessions[FC_ROUTE].sdkActive).toBe(true)

    // clearDiffComments should have been called: gitReviewComments is empty
    expect(useSessionStore.getState().sessions[FC_ROUTE].gitReviewComments).toEqual([])
  })

  it('onSend skips session creation when already active', async () => {
    // Mark SDK as already active
    useSessionStore.getState().markSdkActive(FC_ROUTE)

    const comments = [makeDiffComment()]
    render(React.createElement(ReviewBar, { comments }))

    await act(async () => {
      await viewProps.onSend()
    })

    // session:create must NOT have been called
    expect(createCalls).toHaveLength(0)
    // session:send should still be called
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0][0]).toBe(FC_ROUTE)
  })

  it('onSend clears diff comments from store', async () => {
    const comments = [
      makeDiffComment({ id: 'c1', comment: 'First comment' }),
      makeDiffComment({ id: 'c2', filePath: 'src/other.ts', comment: 'Second comment' }),
    ]

    // Pre-populate gitReviewComments in store
    useSessionStore.getState().addDiffComment(FC_ROUTE, comments[0])
    useSessionStore.getState().addDiffComment(FC_ROUTE, comments[1])
    expect(useSessionStore.getState().sessions[FC_ROUTE].gitReviewComments).toHaveLength(2)

    render(React.createElement(ReviewBar, { comments }))

    await act(async () => {
      await viewProps.onSend()
    })

    expect(useSessionStore.getState().sessions[FC_ROUTE].gitReviewComments).toEqual([])
  })

  it('passes correct fileCount from comments spanning two different files', () => {
    const comments = [
      makeDiffComment({ id: 'c1', filePath: 'src/alpha.ts' }),
      makeDiffComment({ id: 'c2', filePath: 'src/beta.ts' }),
      makeDiffComment({ id: 'c3', filePath: 'src/alpha.ts' }),
    ]

    render(React.createElement(ReviewBar, { comments }))

    // 2 unique files: alpha.ts and beta.ts
    expect(viewProps.fileCount).toBe(2)
  })
})
