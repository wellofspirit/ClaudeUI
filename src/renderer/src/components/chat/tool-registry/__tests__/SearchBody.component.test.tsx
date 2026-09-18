/**
 * SearchBody — the body search finally has.
 *
 * Two things are under test: a result that IS a list of places renders as one,
 * and a result that is not declines to the plain terminal view instead of being
 * forced into a table. The second half is the important one — search output is
 * engine-specific prose often enough that a parser willing to guess would
 * regularly render nonsense.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../TerminalView', () => ({
  TerminalView: (p: { text: string }) => <div data-testid="TerminalView" data-text={p.text} />
}))

import { SearchBody, groupSearchResult } from '../kinds/SearchBody'
import type { ContentBlock } from '../../../../../../shared/types'
import type { ToolView } from '../../../../../../shared/tool-kinds'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

const view: ToolView = { kind: 'search', query: 'needle' }
const block: ToolUseBlock = {
  type: 'tool_use',
  toolUseId: 'tu-1',
  toolName: 'Grep',
  toolInput: { pattern: 'needle', path: 'src' }
}
const res = (text: string, isError = false): ToolResultBlock => ({
  type: 'tool_result',
  toolUseId: 'tu-1',
  toolResult: text,
  isError
})

function renderBody(result?: ToolResultBlock, hideToolInput = false) {
  return render(
    <SearchBody
      view={view}
      block={block}
      result={result}
      expanded
      hideToolInput={hideToolInput}
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

describe('groupSearchResult', () => {
  it('groups content-mode output by file, keeping line numbers', () => {
    const grouped = groupSearchResult(
      'src/a.ts:12:const x = 1\nsrc/a.ts:40:const y = 2\nsrc/b.ts:3:z'
    )
    expect(grouped).toEqual([
      {
        path: 'src/a.ts',
        lines: [
          { line: '12', text: 'const x = 1' },
          { line: '40', text: 'const y = 2' }
        ]
      },
      { path: 'src/b.ts', lines: [{ line: '3', text: 'z' }] }
    ])
  })

  it('drops the "Found N files" header and the -- separators', () => {
    const grouped = groupSearchResult('Found 2 files\nsrc/a.ts\n--\nsrc/b.ts')
    expect(grouped?.map((h) => h.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('declines prose rather than rendering it as a file row', () => {
    expect(groupSearchResult('No matches found for that pattern')).toBeNull()
    expect(groupSearchResult('')).toBeNull()
  })

  it('declines a bare token that does not look like a path', () => {
    expect(groupSearchResult('needle\nhaystack')).toBeNull()
  })
})

describe('SearchBody', () => {
  it('renders one row per file with its hit count, and no JSON input dump', () => {
    renderBody(res('src/a.ts:12:const x = 1\nsrc/a.ts:40:const y = 2\nsrc/b.ts:3:z'))
    expect(screen.getAllByTestId('SearchBody.file')).toHaveLength(2)
    expect(screen.getByTestId('SearchBody.results')).toHaveTextContent('src/a.ts')
    expect(screen.queryByTestId('SearchBody.input')).not.toBeInTheDocument()
  })

  it('caps the matched lines per file and says how many are left', () => {
    const many = Array.from({ length: 8 }, (_, i) => `src/a.ts:${i + 1}:hit ${i}`).join('\n')
    renderBody(res(many))
    expect(screen.getByTestId('SearchBody.results')).toHaveTextContent('+3 more in this file')
  })

  it('falls back to the terminal view when the output is not a list of places', () => {
    renderBody(res('No matches found for that pattern'))
    expect(screen.getByTestId('TerminalView')).toHaveAttribute(
      'data-text',
      'No matches found for that pattern'
    )
    // The input dump comes back with the fallback — it is the only context left.
    expect(screen.getByTestId('SearchBody.input')).toBeInTheDocument()
  })

  it('renders an error result as an error, never as rows', () => {
    renderBody(res('grep: invalid pattern', true))
    expect(screen.queryByTestId('SearchBody.results')).not.toBeInTheDocument()
    expect(screen.queryByTestId('TerminalView')).not.toBeInTheDocument()
  })

  it('renders nothing but the rows while the result is still absent', () => {
    renderBody(undefined)
    expect(screen.queryByTestId('SearchBody.results')).not.toBeInTheDocument()
    expect(screen.getByTestId('SearchBody.input')).toBeInTheDocument()
  })
})
