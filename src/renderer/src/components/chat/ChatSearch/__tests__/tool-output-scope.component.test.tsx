/**
 * Layer 2: the "Exclude tool output" marker sites.
 *
 * Scope is tool OUTPUT only: what a tool returned is marked with
 * TOOL_OUTPUT_SCOPE, while its input (the command, the edit diff, the task
 * prompt) must stay searchable. Each case renders the real component and runs
 * the real engine over it, so a marker on the wrong element fails here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createChatSearchEngine } from '../chat-search'
import { CommandBody } from '../../tool-registry/kinds/CommandBody'
import { FileEditBody } from '../../tool-registry/kinds/FileEditBody'
import type { KindBodyProps } from '../../tool-registry/kinds/types'
import type { ContentBlock } from '../../../../../../shared/types'
import type { ToolView } from '../../../../../../shared/tool-kinds'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

vi.mock('../../MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))

import { TaskCard } from '../../TaskCard'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/** Matches for `query` in `root`, with tool output included and excluded. */
function counts(root: HTMLElement, query: string): { all: number; excluded: number } {
  const engine = createChatSearchEngine(root)
  engine.setQuery(query, { caseSensitive: false, excludeToolOutput: false })
  const all = engine.getState().total
  engine.setQuery(query, { caseSensitive: false, excludeToolOutput: true })
  const excluded = engine.getState().total
  engine.dispose()
  return { all, excluded }
}

function block(toolName: string, toolInput: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', toolUseId: 'tu-1', toolName, toolInput } as ToolUseBlock
}

function result(toolResult: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', toolUseId: 'tu-1', toolResult, isError } as ToolResultBlock
}

function bodyProps(
  view: ToolView,
  b: ToolUseBlock,
  r: ToolResultBlock | undefined,
  extra: Partial<KindBodyProps> = {}
): KindBodyProps {
  return {
    view,
    block: b,
    result: r,
    expanded: true,
    hideToolInput: false,
    isError: !!r?.isError,
    theme: 'dark',
    isBackgroundBash: false,
    isForegroundBashRunning: false,
    ...extra
  } as unknown as KindBodyProps
}

describe('CommandBody', () => {
  it('marks the result, not the command', () => {
    const view: ToolView = { kind: 'command', command: 'echo alphacmd' }
    const { container } = render(
      <CommandBody
        {...bodyProps(view, block('Bash', { command: 'echo alphacmd' }), result('betaout'))}
      />
    )
    expect(counts(container, 'alphacmd')).toEqual({ all: 1, excluded: 1 })
    expect(counts(container, 'betaout')).toEqual({ all: 1, excluded: 0 })
  })

  it('marks an error result too', () => {
    const view: ToolView = { kind: 'command', command: 'false' }
    const { container } = render(
      <CommandBody
        {...bodyProps(view, block('Bash', { command: 'false' }), result('betafail', true))}
      />
    )
    expect(counts(container, 'betafail')).toEqual({ all: 1, excluded: 0 })
  })
})

describe('FileEditBody', () => {
  const view: ToolView = {
    kind: 'fileEdit',
    path: '/repo/a.ts',
    before: 'const alphaold = 1',
    after: 'const alphanew = 2'
  }
  const b = block('Edit', {
    file_path: '/repo/a.ts',
    old_string: 'const alphaold = 1',
    new_string: 'const alphanew = 2'
  })

  it('hideToolInput: the diff rendered in the result section stays searchable', () => {
    const { container } = render(
      <FileEditBody {...bodyProps(view, b, result('betaupdated'), { hideToolInput: true })} />
    )
    expect(counts(container, 'alphanew').all).toBeGreaterThan(0)
    expect(counts(container, 'alphanew').excluded).toBe(counts(container, 'alphanew').all)
    expect(container.querySelector('[data-search-scope="tool-output"]')).toBeNull()
  })

  it('hideToolInput: an error result is marked', () => {
    const { container } = render(
      <FileEditBody {...bodyProps(view, b, result('betafailed', true), { hideToolInput: true })} />
    )
    expect(counts(container, 'betafailed')).toEqual({ all: 1, excluded: 0 })
  })

  it('input shown: the diff is searchable, the result text is marked', () => {
    const { container } = render(<FileEditBody {...bodyProps(view, b, result('betaupdated'))} />)
    const diff = counts(container, 'alphanew')
    expect(diff.all).toBeGreaterThan(0)
    expect(diff.excluded).toBe(diff.all)
    expect(counts(container, 'betaupdated')).toEqual({ all: 1, excluded: 0 })
  })
})

describe('TaskCard', () => {
  const ROUTE = 'route-scope'
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('marks the result area, not the description or the prompt', () => {
    const view: ToolView = {
      kind: 'task',
      description: 'alphadesc the chat view',
      prompt: 'alphaprompt every component',
      subagent: 'explore'
    }
    const { container } = render(
      <TaskCard
        block={block('Task', { description: 'alphadesc', prompt: 'alphaprompt' })}
        result={result('betaresult: all done')}
        view={view}
      />
    )
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(counts(container, 'alphadesc')).toEqual({ all: 1, excluded: 1 })
    expect(counts(container, 'alphaprompt')).toEqual({ all: 1, excluded: 1 })
    expect(counts(container, 'betaresult')).toEqual({ all: 1, excluded: 0 })
    // The subagent badge is a header chip: it stays searchable.
    expect(counts(container, 'explore')).toEqual({ all: 1, excluded: 1 })
  })
})
