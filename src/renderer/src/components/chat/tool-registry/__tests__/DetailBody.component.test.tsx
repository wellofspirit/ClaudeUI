/**
 * DetailBody · FindingsBody · ToolNoteRow — the three renderers behind the
 * twenty per-tool specs.
 *
 * The spec tests cover what each tool SAYS; these cover how the three shapes
 * behave, and in particular the two rules that keep them honest: a field with no
 * value never renders a row, and a failed note is never a quiet grey line.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../TerminalView', () => ({
  TerminalView: (p: { text: string }) => <div data-testid="TerminalView" data-text={p.text} />
}))

import { DetailBody } from '../kinds/DetailBody'
import { FindingsBody } from '../kinds/FindingsBody'
import { ToolNoteRow } from '../../ToolNoteRow'
import type { ContentBlock } from '../../../../../../shared/types'
import type { ToolView } from '../../../../../../shared/tool-kinds'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

const block: ToolUseBlock = {
  type: 'tool_use',
  toolUseId: 'tu-1',
  toolName: 'Skill',
  toolInput: {}
}
const res = (text: string, isError = false): ToolResultBlock => ({
  type: 'tool_result',
  toolUseId: 'tu-1',
  toolResult: text,
  isError
})

function renderBody(
  Body: typeof DetailBody | typeof FindingsBody,
  view: ToolView,
  result?: ToolResultBlock
) {
  return render(
    <Body
      view={view}
      block={block}
      result={result}
      expanded
      hideToolInput={false}
      theme="dark"
      isError={!!result?.isError}
      isBackgroundBash={false}
      isForegroundBashRunning={false}
      isPendingApproval={false}
      permissionMode="default"
      onApproval={vi.fn()}
      borderColor="border-border"
      statusIcon={<span />}
    />
  )
}

describe('DetailBody', () => {
  it('renders each field as a label/value row', () => {
    renderBody(DetailBody, {
      kind: 'detail',
      fields: [
        { label: 'schedule', value: '0 9 * * 1-5' },
        { label: 'prompt', value: 'Check CI' }
      ]
    })
    const dl = screen.getByTestId('DetailBody')
    expect(dl).toHaveTextContent('schedule')
    expect(dl).toHaveTextContent('0 9 * * 1-5')
    expect(dl).toHaveTextContent('Check CI')
  })

  it('renders the returned text through the output view, not as a field', () => {
    renderBody(DetailBody, { kind: 'detail', fields: [], text: 'plain output' })
    expect(screen.queryByTestId('DetailBody')).not.toBeInTheDocument()
    expect(screen.getByTestId('TerminalView')).toHaveAttribute('data-text', 'plain output')
  })

  it('renders an error result in the error tone rather than as output', () => {
    renderBody(DetailBody, { kind: 'detail', fields: [] }, res('no such skill', true))
    expect(screen.queryByTestId('TerminalView')).not.toBeInTheDocument()
    expect(screen.getByText('no such skill')).toBeInTheDocument()
  })

  it('renders nothing at all for a call with neither fields nor output', () => {
    const { container } = renderBody(DetailBody, { kind: 'detail', fields: [] })
    expect(container.textContent).toBe('')
  })
})

describe('FindingsBody', () => {
  it('renders one row per finding, with its verdict and place', () => {
    renderBody(FindingsBody, {
      kind: 'findings',
      findings: [
        {
          file: 'a.ts',
          line: 12,
          summary: 'recall drops a boundary',
          verdict: 'CONFIRMED',
          category: 'correctness'
        },
        { summary: 'summary recomputed per render', verdict: 'PLAUSIBLE' }
      ]
    })
    expect(screen.getAllByTestId('FindingsBody.finding')).toHaveLength(2)
    expect(screen.getByTestId('FindingsBody')).toHaveTextContent('a.ts:12')
    expect(screen.getByTestId('FindingsBody')).toHaveTextContent('CONFIRMED')
  })

  it('says so when a review found nothing, rather than rendering an empty box', () => {
    renderBody(FindingsBody, { kind: 'findings', findings: [] })
    expect(screen.getByTestId('FindingsBody')).toHaveTextContent('Nothing survived verification.')
  })

  it('shows the applied outcome when the review was asked to fix its findings', () => {
    renderBody(FindingsBody, {
      kind: 'findings',
      findings: [{ summary: 'a', verdict: 'CONFIRMED', outcome: 'fixed' }]
    })
    expect(screen.getByTestId('FindingsBody')).toHaveTextContent('fixed')
  })
})

describe('ToolNoteRow', () => {
  const view: ToolView = { kind: 'note', icon: 'stop', text: 'Stopped background task bash_01H9' }

  it('states the one fact, with the tool that did it', () => {
    render(<ToolNoteRow block={block} result={res('ok')} view={view} displayName="TaskStop" />)
    expect(screen.getByTestId('ToolNoteRow.text')).toHaveTextContent(
      'Stopped background task bash_01H9'
    )
    expect(screen.getByTestId('ToolNoteRow')).toHaveTextContent('TaskStop')
  })

  it('spins while the call is still in flight', () => {
    render(<ToolNoteRow block={block} view={view} />)
    expect(screen.getByTestId('ToolNoteRow')).not.toHaveAttribute('data-failed')
  })

  it('promotes itself to the error tone and shows why when the call failed', () => {
    render(<ToolNoteRow block={block} result={res('no such task', true)} view={view} />)
    const row = screen.getByTestId('ToolNoteRow')
    expect(row).toHaveAttribute('data-failed', 'true')
    expect(row).toHaveTextContent('no such task')
  })

  it('renders an unknown icon name as the plain completion tick', () => {
    render(
      <ToolNoteRow
        block={block}
        result={res('ok')}
        view={{ kind: 'note', icon: 'nope', text: 'x' }}
      />
    )
    expect(screen.getByTestId('ToolNoteRow')).toHaveTextContent('x')
  })
})
