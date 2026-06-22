/**
 * Render tests for ToolCard + TOOL_RENDERERS — one per kind.
 *
 * Verifies the kind-keyed body dispatch produces the right body for each
 * ToolView, reusing the existing leaf components (DiffViewer/CodeView/
 * TerminalView/MermaidDiagram/MockupPreviewCard). The leaves are mocked to
 * testids so we assert "which renderer was selected + fed which ToolView field",
 * without depending on the leaves' internal rendering.
 *
 * Behavior-preservation specifics covered:
 *  - command: `$ {command}` input + TerminalView(output) result; error → red-pre.
 *  - fileEdit: DiffViewer in BOTH input and result (the preserved double-diff);
 *    MultiEdit (no before/after) → generic JSON fallback.
 *  - fileWrite: WriteResult (CodeView) on the written content.
 *  - fileRead: CodeView(content) result; path input.
 *  - search/web/mcp/unknown: JSON input + TerminalView result.
 *  - diagram/mockup: custom card (MermaidDiagram / MockupPreviewCard).
 *  - getSummary header + expand/collapse.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useSessionStore } from '@renderer/stores/session-store'
import { makeSessionStatus, resetFactoryCounter } from '@test/factories/messages'

// Mock the leaf body components so we can assert which one rendered + with what.
vi.mock('../../../../lib/diff', () => ({
  DiffViewer: (p: { oldStr: string; newStr: string; fileName?: string }) => (
    <div data-testid="DiffViewer" data-old={p.oldStr} data-new={p.newStr} data-file={p.fileName} />
  )
}))
vi.mock('../../CodeView', () => ({
  CodeView: (p: { code: string; filePath?: string }) => (
    <div data-testid="CodeView" data-code={p.code} data-file={p.filePath} />
  )
}))
vi.mock('../../TerminalView', () => ({
  TerminalView: (p: { text: string }) => <div data-testid="TerminalView" data-text={p.text} />
}))
vi.mock('../../MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => (
    <div data-testid="MarkdownRenderer" data-content={p.content} />
  )
}))
vi.mock('../../MermaidDiagram', () => ({
  MermaidDiagram: (p: { source: string; title?: string }) => (
    <div data-testid="MermaidDiagram" data-source={p.source} data-title={p.title} />
  )
}))
vi.mock('../../MockupPreviewCard', () => ({
  MockupPreviewCard: (p: { directory: string; title?: string }) => (
    <div data-testid="MockupPreviewCard" data-dir={p.directory} data-title={p.title} />
  )
}))

import { ToolCard, type ToolCardProps } from '../ToolCard'
import type { ContentBlock } from '../../../../../../shared/types'
import type { ToolView } from '../../../../../../shared/tool-kinds'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

beforeEach(() => {
  resetFactoryCounter()
  ;(globalThis as any).window.api = {
    logError: vi.fn(),
    respondApproval: vi.fn(),
    watchBackground: vi.fn(),
    unwatchBackground: vi.fn(),
    readBackgroundRange: vi.fn(),
    saveSessionConfig: vi.fn(),
    saveSlashCommands: vi.fn(),
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([])
  }
  // Use createNewSession for a complete session shape (BackgroundBashOutput reads
  // backgroundWatcherCounts/backgroundOutputs from it for foreground/bg bash).
  useSessionStore.getState().createNewSession('test-session', '/test')
  useSessionStore.setState({
    activeSessionId: 'test-session',
    sessions: {
      ...useSessionStore.getState().sessions,
      'test-session': {
        ...useSessionStore.getState().sessions['test-session'],
        status: makeSessionStatus({ state: 'idle', sessionId: null, model: null, cwd: null })
      }
    }
  })
})

function baseProps(over: Partial<ToolCardProps>): ToolCardProps {
  return {
    kind: 'command',
    view: { kind: 'command', command: '' },
    block: { type: 'tool_use', toolUseId: 'tu-1', toolName: 'Bash', toolInput: {} },
    result: undefined,
    approval: undefined,
    isHistorical: false,
    permissionMode: 'default',
    expandToolCalls: true, // expanded so bodies render
    expandReadResults: true,
    hideToolInput: false,
    theme: 'dark',
    isBackgroundBash: false,
    bashOutput: undefined,
    bgOutput: undefined,
    bgNotification: null,
    isStopping: false,
    isBackgrounding: false,
    hasActiveSession: true,
    backgroundTasksEnabled: true,
    onApproval: vi.fn().mockResolvedValue(undefined),
    onBackgroundTask: vi.fn().mockResolvedValue(undefined),
    onStopTask: vi.fn().mockResolvedValue(undefined),
    onOpenTaskPanel: vi.fn(),
    ...over
  }
}

function block(toolName: string, toolInput: Record<string, unknown>, id = 'tu-1'): ToolUseBlock {
  return { type: 'tool_use', toolUseId: id, toolName, toolInput }
}
function result(text: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', toolUseId: 'tu-1', toolResult: text, isError }
}

describe('ToolCard — command kind', () => {
  it('renders $ command input and TerminalView output (success)', () => {
    const view: ToolView = { kind: 'command', command: 'echo hi', output: 'hi' }
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view,
          block: block('Bash', { command: 'echo hi' }),
          result: result('hi')
        })}
      />
    )
    // The `$ echo hi` input pre — matched via a node-spanning text matcher
    // (`$ ` and `echo hi` are adjacent text nodes inside the pre).
    expect(
      screen.getByText((_content, el) => el?.tagName === 'PRE' && el.textContent === '$ echo hi')
    ).toBeInTheDocument()
    // The header summary shows the command too.
    expect(screen.getByText('echo hi')).toBeInTheDocument()
    expect(screen.getByTestId('TerminalView')).toHaveAttribute('data-text', 'hi')
  })

  it('renders red-pre (not TerminalView) for an errored command result', () => {
    const view: ToolView = { kind: 'command', command: 'bad', output: 'boom' }
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view,
          block: block('Bash', { command: 'bad' }),
          result: result('boom', true)
        })}
      />
    )
    expect(screen.queryByTestId('TerminalView')).not.toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('shows the command name header + getSummary', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'ls -la' },
          block: block('Bash', { command: 'ls -la' })
        })}
      />
    )
    expect(screen.getByText('Bash')).toBeInTheDocument()
    // getSummary returns the command for Bash — appears in the header summary
    // AND in the `$ ls -la` input pre.
    expect(screen.getAllByText('ls -la').length).toBeGreaterThanOrEqual(1)
  })
})

describe('ToolCard — fileEdit kind', () => {
  it('renders DiffViewer in BOTH input and result (preserved double-diff)', () => {
    const view: ToolView = {
      kind: 'fileEdit',
      path: '/a.ts',
      before: 'old',
      after: 'new'
    }
    render(
      <ToolCard
        {...baseProps({
          kind: 'fileEdit',
          view,
          block: block('Edit', { file_path: '/a.ts', old_string: 'old', new_string: 'new' }),
          result: result('Edited')
        })}
      />
    )
    const diffs = screen.getAllByTestId('DiffViewer')
    expect(diffs).toHaveLength(2)
    expect(diffs[0]).toHaveAttribute('data-old', 'old')
    expect(diffs[0]).toHaveAttribute('data-new', 'new')
  })

  it('falls back to generic JSON input when no before/after (MultiEdit)', () => {
    const view: ToolView = { kind: 'fileEdit', path: '/a.ts', before: '', after: '' }
    render(
      <ToolCard
        {...baseProps({
          kind: 'fileEdit',
          view,
          block: block('MultiEdit', { file_path: '/a.ts', edits: [{ x: 1 }] }),
          result: result('ok')
        })}
      />
    )
    expect(screen.queryByTestId('DiffViewer')).not.toBeInTheDocument()
    // generic JSON dump of block.toolInput
    expect(screen.getAllByText(/"edits"/).length).toBeGreaterThanOrEqual(1)
    // generic result → TerminalView
    expect(screen.getByTestId('TerminalView')).toBeInTheDocument()
  })
})

describe('ToolCard — fileWrite kind', () => {
  it('renders WriteResult (CodeView) on the written content', () => {
    const view: ToolView = { kind: 'fileWrite', path: '/new.ts', content: 'export const x = 1' }
    render(
      <ToolCard
        {...baseProps({
          kind: 'fileWrite',
          view,
          block: block('Write', { file_path: '/new.ts', content: 'export const x = 1' }),
          result: result('Wrote')
        })}
      />
    )
    const code = screen.getByTestId('CodeView')
    expect(code).toHaveAttribute('data-code', 'export const x = 1')
    expect(code).toHaveAttribute('data-file', '/new.ts')
  })

  it('renders markdown preview/code toggle for .md files', () => {
    const view: ToolView = { kind: 'fileWrite', path: '/doc.md', content: '# Title' }
    render(
      <ToolCard
        {...baseProps({
          kind: 'fileWrite',
          view,
          block: block('Write', { file_path: '/doc.md', content: '# Title' }),
          result: result('Wrote')
        })}
      />
    )
    // markdown → MarkdownRenderer in the default 'preview' tab
    expect(screen.getByTestId('MarkdownRenderer')).toHaveAttribute('data-content', '# Title')
  })
})

describe('ToolCard — fileRead kind', () => {
  it('renders CodeView(content) on success', () => {
    const view: ToolView = { kind: 'fileRead', path: '/a.ts', content: 'file body' }
    render(
      <ToolCard
        {...baseProps({
          kind: 'fileRead',
          view,
          block: block('Read', { file_path: '/a.ts' }),
          result: result('file body')
        })}
      />
    )
    expect(screen.getByTestId('CodeView')).toHaveAttribute('data-code', 'file body')
  })
})

describe('ToolCard — generic kinds (search/web/mcp/unknown)', () => {
  it('search: JSON input + TerminalView result', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'search',
          view: { kind: 'search', query: '*.ts' },
          block: block('Glob', { pattern: '*.ts' }),
          result: result('found 3 files')
        })}
      />
    )
    expect(screen.getAllByText(/"pattern"/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('TerminalView')).toHaveAttribute('data-text', 'found 3 files')
  })

  it('unknown: JSON input + TerminalView result', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'unknown',
          view: { kind: 'unknown', input: { foo: 'bar' } },
          block: block('SomeTool', { foo: 'bar' }),
          result: result('output')
        })}
      />
    )
    expect(screen.getAllByText(/"foo"/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('TerminalView')).toBeInTheDocument()
  })
})

describe('ToolCard — diagram kind (custom layout)', () => {
  it('renders MermaidDiagram with the source', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'diagram',
          view: { kind: 'diagram', source: 'graph TD; A-->B', title: 'Flow' },
          block: block('mcp__claude-ui__render_mermaid', { source: 'graph TD; A-->B', title: 'Flow' })
        })}
      />
    )
    const m = screen.getByTestId('MermaidDiagram')
    expect(m).toHaveAttribute('data-source', 'graph TD; A-->B')
    // custom header shows the title
    expect(screen.getByText('Flow')).toBeInTheDocument()
  })
})

describe('ToolCard — mockup kind (custom layout)', () => {
  it('renders MockupPreviewCard with the directory (no error)', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'mockup',
          view: { kind: 'mockup', directory: 'abc123', title: 'My UI' },
          block: block('mcp__claude-ui-mockup__show_mockup', { directory: 'abc123' }),
          result: result('Mockup displayed.\nDirectory: abc123')
        })}
      />
    )
    expect(screen.getByTestId('MockupPreviewCard')).toHaveAttribute('data-dir', 'abc123')
    expect(screen.getByText('My UI')).toBeInTheDocument()
  })

  it('renders the error text and no preview when result is an error', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'mockup',
          view: { kind: 'mockup', directory: undefined, title: undefined },
          block: block('mcp__claude-ui-mockup__show_mockup', { directory: 'nope' }),
          result: result('Failed to show mockup: not found', true)
        })}
      />
    )
    expect(screen.queryByTestId('MockupPreviewCard')).not.toBeInTheDocument()
    expect(screen.getByText(/Failed to show mockup/)).toBeInTheDocument()
  })
})

describe('ToolCard — expand/collapse', () => {
  it('hides the body when collapsed and shows it when toggled', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'echo hi', output: 'hi' },
          block: block('Bash', { command: 'echo hi' }),
          result: result('hi'),
          expandToolCalls: false
        })}
      />
    )
    // collapsed: no TerminalView
    expect(screen.queryByTestId('TerminalView')).not.toBeInTheDocument()
    // toggle expand via the header button
    fireEvent.click(screen.getByText('Bash'))
    expect(screen.getByTestId('TerminalView')).toBeInTheDocument()
  })
})

describe('ToolCard — approval', () => {
  it('renders shared ApprovalButtons when a pending approval exists', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'rm -rf /' },
          block: block('Bash', { command: 'rm -rf /' }),
          approval: { requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf /' } }
        })}
      />
    )
    expect(screen.getByText('Allow')).toBeInTheDocument()
    expect(screen.getByText('Deny')).toBeInTheDocument()
  })
})
