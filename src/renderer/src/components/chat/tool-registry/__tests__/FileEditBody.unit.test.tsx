/**
 * Unit tests for FileEditBody single-diff (ROADMAP #11c)
 *
 * Guards:
 *  - hasDiff success: exactly ONE DiffViewer (in Input) + TerminalView for result.
 *  - hasDiff + hideToolInput: exactly ONE DiffViewer (in Result).
 *  - hasDiff error: red-pre (ExpandableText) — no duplicate diff.
 *  - no diff (MultiEdit): generic JSON input + TerminalView result.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileEditBody } from '../kinds/FileEditBody'
import type { KindBodyProps } from '../kinds/types'
import type { ContentBlock } from '../../../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

// Mock DiffViewer and TerminalView so we can count instances cleanly.
// Paths are relative to THIS test file's location in tool-registry/__tests__/.
vi.mock('../../../../lib/diff', () => ({
  DiffViewer: (p: { oldStr: string; newStr: string; fileName?: string }) => (
    <div data-testid="DiffViewer" data-old={p.oldStr} data-new={p.newStr} />
  )
}))
vi.mock('../../TerminalView', () => ({
  TerminalView: (p: { text: string }) => <div data-testid="TerminalView" data-text={p.text} />
}))

function makeBlock(toolInput: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', toolUseId: 'tu-1', toolName: 'Edit', toolInput }
}
function makeResult(text: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', toolUseId: 'tu-1', toolResult: text, isError }
}

const STATUS_ICON = <span data-testid="status-icon" />

function baseProps(over: Partial<KindBodyProps>): KindBodyProps {
  return {
    view: { kind: 'fileEdit', path: '/a.ts', before: 'old', after: 'new' },
    block: makeBlock({ file_path: '/a.ts', old_string: 'old', new_string: 'new' }),
    result: makeResult('File updated'),
    expanded: true,
    hideToolInput: false,
    theme: 'dark',
    isError: false,
    isBackgroundBash: false,
    isForegroundBashRunning: false,
    isPendingApproval: false,
    permissionMode: 'default',
    onApproval: vi.fn().mockResolvedValue(undefined),
    borderColor: 'border-success/30',
    statusIcon: STATUS_ICON,
    toolOutputMaxChars: 5000,
    ...over
  }
}

describe('FileEditBody — single-diff (ROADMAP #11c)', () => {
  it('hasDiff success: ONE DiffViewer (Input) + TerminalView (Result)', () => {
    render(<FileEditBody {...baseProps({})} />)
    const diffs = screen.getAllByTestId('DiffViewer')
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toHaveAttribute('data-old', 'old')
    expect(diffs[0]).toHaveAttribute('data-new', 'new')
    expect(screen.getByTestId('TerminalView')).toHaveAttribute('data-text', 'File updated')
  })

  it('hasDiff + hideToolInput: ONE DiffViewer in Result (not Input)', () => {
    render(<FileEditBody {...baseProps({ hideToolInput: true })} />)
    const diffs = screen.getAllByTestId('DiffViewer')
    expect(diffs).toHaveLength(1)
    // TerminalView should NOT appear (diff is in Result, not result text)
    expect(screen.queryByTestId('TerminalView')).not.toBeInTheDocument()
  })

  it('hasDiff error: red-pre (ExpandableText) — no DiffViewer in Result', () => {
    render(
      <FileEditBody
        {...baseProps({
          result: makeResult('Cannot edit: permission denied', true),
          isError: true
        })}
      />
    )
    // Diff still in Input
    expect(screen.getAllByTestId('DiffViewer')).toHaveLength(1)
    // Result is the error text, not a second diff
    expect(screen.queryByTestId('TerminalView')).not.toBeInTheDocument()
    expect(screen.getByText('Cannot edit: permission denied')).toBeInTheDocument()
  })

  it('no diff (MultiEdit): generic JSON input + TerminalView result', () => {
    render(
      <FileEditBody
        {...baseProps({
          view: { kind: 'fileEdit', path: '/a.ts', before: '', after: '' },
          block: makeBlock({ file_path: '/a.ts', edits: [{ old_string: 'x', new_string: 'y' }] })
        })}
      />
    )
    expect(screen.queryByTestId('DiffViewer')).not.toBeInTheDocument()
    expect(screen.getByTestId('TerminalView')).toBeInTheDocument()
  })
})
