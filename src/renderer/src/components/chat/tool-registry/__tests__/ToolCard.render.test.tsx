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
 *  - fileEdit: DiffViewer once (input; result shows TerminalView); hideToolInput
 *    moves the diff to result; MultiEdit (no before/after) → generic JSON fallback.
 *  - fileWrite: WriteResult (CodeView) on the written content.
 *  - fileRead: CodeView(content) result; path input.
 *  - search/web/mcp/unknown: JSON input + TerminalView result.
 *  - diagram/mockup: custom card (MermaidDiagram / MockupPreviewCard).
 *  - summarizeTool header + expand/collapse.
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
import type {
  ContentBlock,
  PermissionDenialBlock,
  ToolReviewBlock
} from '../../../../../../shared/types'
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
    // The input block is now syntax-highlighted, so the command is a run of
    // Prism token spans rather than one text node: assert on the block itself.
    expect(screen.getByTestId('ShellCode')).toHaveTextContent('$ echo hi')
    // The header summary shows the command too.
    expect(screen.getByTestId('ToolCard.expand')).toHaveTextContent('echo hi')
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

  it('shows the command name header + summarizeTool summary', () => {
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
    // summarizeTool returns the command for Bash — appears in the header summary
    // AND in the `$ ls -la` input pre.
    expect(screen.getAllByText('ls -la').length).toBeGreaterThanOrEqual(1)
  })
})

describe('ToolCard — fileEdit kind', () => {
  it('renders DiffViewer exactly once in Input, TerminalView for result (single-diff)', () => {
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
    // Single diff only (was two before ROADMAP #11c)
    const diffs = screen.getAllByTestId('DiffViewer')
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toHaveAttribute('data-old', 'old')
    expect(diffs[0]).toHaveAttribute('data-new', 'new')
    // Result shows the result text via TerminalView instead of a duplicate diff
    expect(screen.getByTestId('TerminalView')).toHaveAttribute('data-text', 'Edited')
  })

  it('renders DiffViewer in Result when hideToolInput=true (diff still shows once)', () => {
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
          result: result('Edited'),
          hideToolInput: true
        })}
      />
    )
    // Input is hidden, so diff must appear in Result
    const diffs = screen.getAllByTestId('DiffViewer')
    expect(diffs).toHaveLength(1)
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

  // Regression: ToolCard must render the body as <Body /> (own fiber), not call
  // Body(props). FileReadBody calls useState; calling it as a function folded that
  // hook into ToolCard, so toggling `expanded` changed ToolCard's hook count and
  // crashed with React error #310 ("rendered fewer hooks than expected").
  it('survives expand → collapse → expand without a hooks-order crash (#310)', () => {
    const view: ToolView = { kind: 'fileRead', path: '/a.ts', content: 'file body' }
    const props = baseProps({
      kind: 'fileRead',
      view,
      block: block('Read', { file_path: '/a.ts' }),
      result: result('file body'),
      expandToolCalls: false
    })
    const { rerender } = render(<ToolCard {...props} />)
    // collapsed → no body
    expect(screen.queryByTestId('CodeView')).not.toBeInTheDocument()
    // expand via header — FileReadBody (useState) mounts
    fireEvent.click(screen.getByText('Read'))
    expect(screen.getByTestId('CodeView')).toBeInTheDocument()
    // collapse — body (and its hook) unmounts; must not throw #310
    fireEvent.click(screen.getByText('Read'))
    expect(screen.queryByTestId('CodeView')).not.toBeInTheDocument()
    // expand once more for good measure
    fireEvent.click(screen.getByText('Read'))
    expect(screen.getByTestId('CodeView')).toBeInTheDocument()
    // a forced re-render after toggling must also be stable
    rerender(<ToolCard {...props} expandToolCalls={true} />)
    expect(screen.getByTestId('CodeView')).toBeInTheDocument()
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
          block: block('mcp__claude-ui__render_mermaid', {
            source: 'graph TD; A-->B',
            title: 'Flow'
          })
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

describe('ToolCard — tool-result images strip', () => {
  const IMAGES = [
    { mediaType: 'image/png' as const, base64Data: 'AAA', fileName: 'a.png' },
    { mediaType: 'image/webp' as const, base64Data: 'BBB' }
  ]

  function imageResult(): ToolResultBlock {
    return {
      type: 'tool_result',
      toolUseId: 'tu-1',
      toolResult: '',
      isError: false,
      images: IMAGES
    }
  }

  it('renders one thumb per image for a fileRead whose result text is empty', () => {
    // FileReadBody hides its whole result section when toolResult is '' — the
    // strip lives in ToolCard, so an image-only Read still shows its images.
    render(
      <ToolCard
        {...baseProps({
          kind: 'fileRead',
          view: { kind: 'fileRead', path: '/shot.png', content: '' },
          block: block('Read', { file_path: '/shot.png' }),
          result: imageResult()
        })}
      />
    )
    expect(screen.queryByTestId('CodeView')).toBeNull()
    const thumbs = screen.getAllByTestId('ToolResultImages.thumb')
    expect(thumbs).toHaveLength(2)
    expect((thumbs[0].querySelector('img') as HTMLImageElement).src).toBe(
      'data:image/png;base64,AAA'
    )
    expect((thumbs[1].querySelector('img') as HTMLImageElement).src).toBe(
      'data:image/webp;base64,BBB'
    )
  })

  it('stays visible while the card is COLLAPSED (the image is the result)', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'fileRead',
          view: { kind: 'fileRead', path: '/shot.png', content: '' },
          block: block('Read', { file_path: '/shot.png' }),
          result: imageResult(),
          expandToolCalls: false,
          expandReadResults: false
        })}
      />
    )
    expect(screen.queryByTestId('FileReadBody')).toBeNull()
    expect(screen.getAllByTestId('ToolResultImages.thumb')).toHaveLength(2)
  })

  it('covers a non-Read kind with no per-kind wiring (mcp)', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'mcp',
          view: { kind: 'mcp', input: {} },
          block: block('mcp__shots__capture', {}),
          result: { ...imageResult(), toolResult: 'ok' }
        })}
      />
    )
    expect(screen.getAllByTestId('ToolResultImages.thumb')).toHaveLength(2)
  })

  it('renders nothing for an empty images array (never an empty bordered strip)', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'ls', output: 'a' },
          block: block('Bash', { command: 'ls' }),
          result: { type: 'tool_result', toolUseId: 'tu-1', toolResult: 'a', images: [] }
        })}
      />
    )
    expect(screen.queryByTestId('ToolResultImages')).toBeNull()
  })

  it('custom-layout kinds render their own card and so get NO strip', () => {
    // diagram/mockup synthesize their visual from the tool INPUT and have never
    // carried returned images — documented limitation, pinned here.
    render(
      <ToolCard
        {...baseProps({
          kind: 'diagram',
          view: { kind: 'diagram', source: 'graph TD; A-->B', title: 'Flow' },
          block: block('mcp__claude-ui__render_mermaid', { source: 'graph TD; A-->B' }),
          result: imageResult()
        })}
      />
    )
    expect(screen.queryByTestId('ToolResultImages')).toBeNull()
  })

  it('thumbs are inert without an ImageGalleryProvider above', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'mcp',
          view: { kind: 'mcp', input: {} },
          block: block('mcp__shots__capture', {}),
          result: imageResult()
        })}
      />
    )
    expect(screen.getAllByTestId('ToolResultImages.thumb')[0]).toBeDisabled()
  })
})

/**
 * F18 — a permission judge's verdict on the card it judged. Collapsed, it is one
 * chip in the header; expanded, a review strip between the header and the body.
 * Both carry the same three facts: who decided, how, and (Codex) at what risk.
 */
describe('ToolCard — review verdict', () => {
  const codexReview = (over: Partial<ToolReviewBlock> = {}): ToolReviewBlock => ({
    type: 'tool_review',
    toolUseId: 'tu-1',
    reviewId: 'rv-1',
    reviewer: 'codex-auto-review',
    decision: 'approved',
    riskLevel: 'medium',
    rationale: 'Builds inside the workspace.',
    ...over
  })

  function renderCard(review: ToolReviewBlock, expandToolCalls = true) {
    return render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'bun run build' },
          block: block('Bash', { command: 'bun run build' }),
          review,
          expandToolCalls
        })}
      />
    )
  }

  it('shows the Codex chip with decision and risk, collapsed', () => {
    renderCard(codexReview(), false)
    expect(screen.getByTestId('ToolCard.reviewChip')).toHaveTextContent(
      'Auto-review · approved · medium'
    )
    // Collapsed: the chip only — the strip belongs to the expanded card.
    expect(screen.queryByTestId('ToolCard.review')).not.toBeInTheDocument()
  })

  it('shows the strip between header and body once expanded', () => {
    renderCard(codexReview())
    const strip = screen.getByTestId('ToolCard.review')
    expect(strip).toHaveTextContent('Codex auto-review approved this action')
    expect(strip).toHaveTextContent('medium risk')
    expect(strip).toHaveTextContent('Builds inside the workspace.')
    // The chip stays in the header when expanded too.
    expect(screen.getByTestId('ToolCard.reviewChip')).toBeInTheDocument()
  })

  it.each([
    ['approved', 'text-success'],
    ['denied', 'text-danger'],
    ['timedOut', 'text-warning'],
    ['aborted', 'text-warning'],
    ['inProgress', 'text-warning']
  ] as const)('colours the %s chip with %s', (decision, tone) => {
    renderCard(codexReview({ decision }), false)
    expect(screen.getByTestId('ToolCard.reviewChip').className).toContain(tone)
  })

  it('words an unfinished Codex review as one', () => {
    renderCard(codexReview({ decision: 'timedOut' }))
    expect(screen.getByTestId('ToolCard.review')).toHaveTextContent(
      'Codex auto-review did not finish reviewing this action'
    )
  })

  it("names ClaudeUI's own judge and its corpus rule, with no risk level", () => {
    renderCard({
      type: 'tool_review',
      toolUseId: 'tu-1',
      reviewId: 'rv-2',
      reviewer: 'auto-mode',
      decision: 'denied',
      rule: 'Remote Code Execution',
      rationale: 'Pipes an unverified remote script into a shell.'
    })
    expect(screen.getByTestId('ToolCard.reviewChip')).toHaveTextContent('Auto mode · blocked')
    const strip = screen.getByTestId('ToolCard.review')
    expect(strip).toHaveTextContent('Auto mode blocked this action')
    expect(strip).toHaveTextContent('Remote Code Execution')
    expect(strip).not.toHaveTextContent('risk')
  })

  it('reads an allowed Auto-mode verdict as allowed', () => {
    renderCard({
      type: 'tool_review',
      toolUseId: 'tu-1',
      reviewId: 'rv-3',
      reviewer: 'auto-mode',
      decision: 'approved'
    })
    expect(screen.getByTestId('ToolCard.reviewChip')).toHaveTextContent('Auto mode · allowed')
    expect(screen.getByTestId('ToolCard.review')).toHaveTextContent('Auto mode allowed this action')
  })

  /**
   * The rationale is UNTRUSTED model text from a thread the user never saw. It
   * is plain text, never markdown: the asterisks must survive as asterisks.
   */
  it('renders the rationale verbatim, never through markdown', () => {
    renderCard(codexReview({ rationale: 'It writes **only** to dist/.' }))
    expect(screen.getByTestId('ToolCard.review')).toHaveTextContent('It writes **only** to dist/.')
    expect(screen.queryByTestId('MarkdownRenderer')).not.toBeInTheDocument()
  })

  it('renders neither chip nor strip when no verdict was reached', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'bun run build' },
          block: block('Bash', { command: 'bun run build' })
        })}
      />
    )
    expect(screen.queryByTestId('ToolCard.reviewChip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ToolCard.review')).not.toBeInTheDocument()
  })
})

/**
 * A pre-ask refusal nothing judged — cli.js's `permission_denied` with a
 * `decision_reason_type` other than `classifier`. Same two surfaces as a
 * verdict, deliberately different words: the card must say WHO refused without
 * implying anyone weighed it.
 */
describe('ToolCard — pre-ask denial', () => {
  const denial = (over: Partial<PermissionDenialBlock> = {}): PermissionDenialBlock => ({
    type: 'permission_denial',
    toolUseId: 'tu-1',
    denialId: 'dn-1',
    source: 'rule',
    ...over
  })

  function renderCard(d: PermissionDenialBlock, expandToolCalls = true) {
    return render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'mkdir -p out' },
          block: block('Bash', { command: 'mkdir -p out' }),
          denial: d,
          expandToolCalls
        })}
      />
    )
  }

  it('shows the source chip collapsed, and the strip once expanded', () => {
    renderCard(denial(), false)
    expect(screen.getByTestId('ToolCard.denialChip')).toHaveTextContent('Blocked · deny rule')
    expect(screen.queryByTestId('ToolCard.denial')).not.toBeInTheDocument()

    renderCard(denial())
    expect(screen.getByTestId('ToolCard.denial')).toHaveTextContent(
      'A deny rule refused this action'
    )
  })

  // Every source cli.js declares gets its own sentence: "denied" alone is what
  // the tool_result already said, so a generic line would make this redundant.
  // `subcommandResults` shares the `rule` sentence deliberately: cli.js reports
  // it for every Bash decision, so a "part of this command" claim is wrong for
  // the single-subcommand case that dominates in practice.
  it.each([
    ['subcommandResults', 'A deny rule refused this action'],
    ['mode', 'The permission mode refused this action'],
    ['hook', 'A permission hook refused this action'],
    ['safetyCheck', 'The safety checker refused this action'],
    ['workingDir', 'Refused — outside the working directory'],
    ['other', 'This action was refused']
  ] as const)('words a %s denial as its own', (source, sentence) => {
    renderCard(denial({ source }))
    expect(screen.getByTestId('ToolCard.denial')).toHaveTextContent(sentence)
  })

  it('shows the reason when the source carries one', () => {
    renderCard(denial({ source: 'hook', reason: 'PreToolUse blocked writes to /etc.' }))
    expect(screen.getByTestId('ToolCard.denial')).toHaveTextContent(
      'PreToolUse blocked writes to /etc.'
    )
  })

  /**
   * Auto mode refused without judging — the classifier was unavailable or
   * reached no verdict. It must read as a refusal with no verdict, never as
   * the judge's block, and still say why under the sentence.
   */
  it('words an auto-mode no-verdict block as one, with its reason under it', () => {
    renderCard(denial({ source: 'autoModeNoVerdict', reason: 'Classifier unavailable' }), false)
    expect(screen.getByTestId('ToolCard.denialChip')).toHaveTextContent('Blocked · no verdict')

    renderCard(denial({ source: 'autoModeNoVerdict', reason: 'Classifier unavailable' }))
    const strip = screen.getByTestId('ToolCard.denial')
    expect(strip).toHaveTextContent(
      'Auto mode could not reach a verdict, so it blocked this action'
    )
    expect(strip).toHaveTextContent('Classifier unavailable')
    expect(screen.queryByTestId('ToolCard.review')).not.toBeInTheDocument()
  })

  /** UNTRUSTED text — a hook's own stdout. Plain text, never markdown. */
  it('renders the reason verbatim, never through markdown', () => {
    renderCard(denial({ source: 'hook', reason: 'It writes **only** to dist/.' }))
    expect(screen.getByTestId('ToolCard.denial')).toHaveTextContent('It writes **only** to dist/.')
    expect(screen.queryByTestId('MarkdownRenderer')).not.toBeInTheDocument()
  })

  // A denial is not a verdict; rendering it through the review surfaces would
  // tell the user a judge weighed something that nothing weighed.
  it('never renders as a review', () => {
    renderCard(denial())
    expect(screen.queryByTestId('ToolCard.reviewChip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ToolCard.review')).not.toBeInTheDocument()
  })

  it('renders nothing when the call was not refused', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'mkdir -p out' },
          block: block('Bash', { command: 'mkdir -p out' })
        })}
      />
    )
    expect(screen.queryByTestId('ToolCard.denialChip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ToolCard.denial')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Header metadata chips
// ---------------------------------------------------------------------------

describe('ToolCard — metadata chips', () => {
  const chipText = (): string[] =>
    screen.queryAllByTestId('ToolCard.chip').map((el) => el.textContent ?? '')

  it('shows the edit delta and language, and shows them while COLLAPSED', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'fileEdit',
          view: { kind: 'fileEdit', path: 'src/a.ts', before: 'one', after: 'one\ntwo' },
          block: block('Edit', { file_path: 'src/a.ts' }),
          result: result('OK'),
          expandToolCalls: false
        })}
      />
    )
    expect(chipText()).toEqual(['+2 −1', 'typescript'])
  })

  it('shows an exit code for an engine that reports one', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'cargo build', exitCode: 101 },
          block: block('commandExecution', { command: 'cargo build', exitCode: 101 }),
          result: result('error: could not compile', true),
          displayName: 'Command'
        })}
      />
    )
    expect(chipText()).toEqual(['exit 101'])
  })

  it('shows no chips for a Claude Bash card, whose result carries no exit code', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'command',
          view: { kind: 'command', command: 'ls', output: 'a' },
          block: block('Bash', { command: 'ls' }),
          result: result('a')
        })}
      />
    )
    expect(chipText()).toEqual([])
  })

  it('shows search counts derived from the result text', () => {
    render(
      <ToolCard
        {...baseProps({
          kind: 'search',
          view: { kind: 'search', query: 'needle' },
          block: block('Grep', { pattern: 'needle' }),
          result: result('src/a.ts:1:needle\nsrc/a.ts:9:needle\nsrc/b.ts:4:needle')
        })}
      />
    )
    expect(chipText()).toEqual(['2 files', '3 hits'])
  })
})
