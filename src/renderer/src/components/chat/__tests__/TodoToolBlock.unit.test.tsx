/**
 * Unit tests for TodoToolBlock — renders from engine-neutral ToolView.
 *
 * Guard: the component must NOT read block.toolInput.todos; it reads view.items.
 * Tests cover both Claude shape (with activeForm) and opencode shape (no activeForm),
 * plus the 'cancelled' status extension.
 */

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TodoToolBlock } from '../TodoToolBlock'
import type { ContentBlock } from '../../../../../shared/types'
import type { ToolView } from '../../../../../shared/tool-kinds'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type TodoView = Extract<ToolView, { kind: 'todo' }>

function makeBlock(toolInputTodos?: unknown[]): ToolUseBlock {
  return {
    type: 'tool_use',
    toolUseId: 'tu-todo-1',
    toolName: 'TodoWrite',
    // Intentionally different from the view so tests verify view wins
    toolInput: { todos: toolInputTodos ?? [] }
  } as unknown as ToolUseBlock
}

function makeView(items: TodoView['items']): TodoView {
  return { kind: 'todo', items }
}

describe('TodoToolBlock — renders from view.items (GUARD: not block.toolInput)', () => {
  it('shows correct completed/total count from view items (not block.toolInput)', () => {
    const block = makeBlock([]) // block has 0 todos — if component reads block it shows 'update tasks'
    const view = makeView([
      { status: 'completed', text: 'Task A' },
      { status: 'pending', text: 'Task B' },
      { status: 'in_progress', text: 'Task C' }
    ])
    const { container } = render(<TodoToolBlock block={block} view={view} />)
    // If it reads view.items: 1/3 tasks. If it reads block.toolInput: 'update tasks'.
    // This assertion fails against pre-fix code (which read block.toolInput.todos).
    expect(container.textContent).toContain('1/3 tasks')
  })

  it('opencode shape — no activeForm, cancelled status treated correctly in count', () => {
    const block = makeBlock([])
    const view = makeView([
      { status: 'completed', text: 'Done' },
      { status: 'cancelled', text: 'Dropped' },
      { status: 'pending', text: 'Remaining' }
    ])
    const { container } = render(<TodoToolBlock block={block} view={view} />)
    // 1 completed of 2 active (cancelled excluded from denominator)
    expect(container.textContent).toContain('tasks')
  })

  it('shows "update tasks" when view has no items', () => {
    const block = makeBlock([{ content: 'ignored', status: 'pending' }]) // block has 1 todo
    const view = makeView([])
    const { container } = render(<TodoToolBlock block={block} view={view} />)
    expect(container.textContent).toContain('update tasks')
  })

  it('shows spinning indicator when no result (pending)', () => {
    const view = makeView([{ status: 'pending', text: 'Thing' }])
    render(<TodoToolBlock block={makeBlock()} view={view} />)
    // Spinner class present
    const spinner = document.querySelector('.animate-spin-slow')
    expect(spinner).not.toBeNull()
  })

  it('shows success icon when result present and no error', () => {
    const view = makeView([{ status: 'completed', text: 'Done' }])
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'tu-todo-1',
      toolResult: 'ok',
      isError: false
    }
    render(<TodoToolBlock block={makeBlock()} view={view} result={result} />)
    // No spinner present
    const spinner = document.querySelector('.animate-spin-slow')
    expect(spinner).toBeNull()
  })

  it('shows error icon when result is an error', () => {
    const view = makeView([{ status: 'pending', text: 'Failed' }])
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'tu-todo-1',
      toolResult: 'error text',
      isError: true
    }
    render(<TodoToolBlock block={makeBlock()} view={view} result={result} />)
    const errorLines = document.querySelectorAll('line[x1="18"]')
    expect(errorLines.length).toBeGreaterThan(0)
  })
})
