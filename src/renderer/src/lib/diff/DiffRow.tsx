import { memo, type ReactNode } from 'react'
import type { DiffLine } from './types'
import type { SyntaxToken } from './highlight'

/** Shared content renderer for a single line's cells */
function LineCells({
  line,
  tokens,
  wrapLines,
  isPureAdd,
  isPureDel,
  Cell,
}: {
  line: DiffLine
  tokens?: SyntaxToken[]
  wrapLines: boolean
  isPureAdd?: boolean
  isPureDel?: boolean
  Cell: 'td' | 'div'
}): React.JSX.Element {
  const indicatorChar = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
  const indicatorClass =
    line.type === 'add'
      ? 'diff-indicator-add'
      : line.type === 'del'
        ? 'diff-indicator-del'
        : ''

  return (
    <>
      {/* Old line number */}
      {!isPureAdd && (
        <Cell
          className="diff-gutter diff-gutter-old"
          {...(line.oldLineNumber != null ? { 'data-line-old-num': line.oldLineNumber } : {})}
        >
          {line.oldLineNumber ?? ''}
        </Cell>
      )}
      {/* New line number */}
      {!isPureDel && (
        <Cell
          className="diff-gutter diff-gutter-new"
          {...(line.newLineNumber != null ? { 'data-line-new-num': line.newLineNumber } : {})}
        >
          {line.newLineNumber ?? ''}
        </Cell>
      )}
      {/* +/- indicator */}
      <Cell className={`diff-indicator ${indicatorClass}`}>
        {indicatorChar}
      </Cell>
      {/* Content with syntax highlighting */}
      <Cell
        className={`diff-content ${wrapLines ? 'diff-content-wrap' : 'diff-content-nowrap'}`}
      >
        {tokens ? (
          tokens.map((token, i) => (
            <span key={i} style={token.color ? { color: token.color } : undefined}>
              {token.content}
            </span>
          ))
        ) : (
          line.content
        )}
        {/* Ensure empty lines have height */}
        {(!tokens || tokens.length === 0) && !line.content && '\u00a0'}
      </Cell>
    </>
  )
}

interface Props {
  line: DiffLine
  tokens?: SyntaxToken[]
  wrapLines: boolean
  isPureAdd?: boolean
  isPureDel?: boolean
  highlighted?: boolean
  afterRow?: ReactNode
}

/** Div-based diff row for virtualized tables */
export const DiffRow = memo(function DiffRow({
  line,
  tokens,
  wrapLines,
  isPureAdd,
  isPureDel,
  highlighted,
  afterRow,
}: Props): React.JSX.Element {
  const rowClass =
    line.type === 'add'
      ? 'diff-row-add'
      : line.type === 'del'
        ? 'diff-row-del'
        : ''

  return (
    <>
      <div
        className={`diff-row ${rowClass}${highlighted ? ' diff-row-highlighted' : ''}`}
        role="row"
      >
        <LineCells line={line} tokens={tokens} wrapLines={wrapLines} isPureAdd={isPureAdd} isPureDel={isPureDel} Cell="div" />
      </div>
      {afterRow}
    </>
  )
})

/** Table-row diff row for StaticDiffTable — eliminates sub-pixel gaps */
export const DiffRowTr = memo(function DiffRowTr({
  line,
  tokens,
  wrapLines,
  isPureAdd,
  isPureDel,
  highlighted,
  afterRow,
}: Props): React.JSX.Element {
  const rowClass =
    line.type === 'add'
      ? 'diff-row-add'
      : line.type === 'del'
        ? 'diff-row-del'
        : ''

  return (
    <>
      <tr
        className={`diff-row ${rowClass}${highlighted ? ' diff-row-highlighted' : ''}`}
      >
        <LineCells line={line} tokens={tokens} wrapLines={wrapLines} isPureAdd={isPureAdd} isPureDel={isPureDel} Cell="td" />
      </tr>
      {afterRow && (
        <tr className="diff-after-row">
          <td colSpan={99}>{afterRow}</td>
        </tr>
      )}
    </>
  )
})

interface SplitCellProps {
  line: DiffLine | null
  tokens?: SyntaxToken[]
  wrapLines: boolean
  highlighted?: boolean
  cellSide: 'old' | 'new'
}

/** Render one side (left or right) of a split diff row */
export const SplitDiffCell = memo(function SplitDiffCell({
  line,
  tokens,
  wrapLines,
  highlighted,
  cellSide,
}: SplitCellProps): React.JSX.Element {
  if (!line) {
    return <div className="diff-split-side diff-row-empty flex" role="cell" />
  }

  const bgClass =
    line.type === 'add'
      ? 'diff-row-add'
      : line.type === 'del'
        ? 'diff-row-del'
        : ''

  const indicatorChar = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
  const indicatorClass =
    line.type === 'add'
      ? 'diff-indicator-add'
      : line.type === 'del'
        ? 'diff-indicator-del'
        : ''

  const lineNum = line.type === 'del' ? line.oldLineNumber : line.newLineNumber
    ?? line.oldLineNumber ?? line.newLineNumber

  const gutterAttr = cellSide === 'old'
    ? (line.oldLineNumber != null ? { 'data-line-old-num': line.oldLineNumber } : {})
    : (line.newLineNumber != null ? { 'data-line-new-num': line.newLineNumber } : {})

  return (
    <div
      className={`diff-split-side flex ${bgClass}${highlighted ? ' diff-row-highlighted' : ''}`}
      role="cell"
    >
      <div className="diff-gutter shrink-0" role="cell" {...gutterAttr}>
        {lineNum ?? ''}
      </div>
      <div className={`diff-indicator shrink-0 ${indicatorClass}`} role="cell">
        {indicatorChar}
      </div>
      <div
        className={`diff-content flex-1 min-w-0 ${wrapLines ? 'diff-content-wrap' : 'diff-content-nowrap'}`}
        role="cell"
      >
        {tokens ? (
          tokens.map((token, i) => (
            <span key={i} style={token.color ? { color: token.color } : undefined}>
              {token.content}
            </span>
          ))
        ) : (
          line.content
        )}
        {(!tokens || tokens.length === 0) && !line.content && '\u00a0'}
      </div>
    </div>
  )
})
