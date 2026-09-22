/**
 * ShellCode + OutputView — highlighting a command and what it printed.
 *
 * The assertions are about CONTENT PRESERVATION and about which renderer was
 * chosen. Highlighting must never drop, reorder or rewrite a character of the
 * command — it is the text the user is being asked to trust — and the output
 * renderer must hand back to the plain terminal view for anything it cannot
 * name.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../TerminalView', () => ({
  TerminalView: (p: { text: string }) => <div data-testid="TerminalView" data-text={p.text} />
}))

import { ShellCode } from '../ShellCode'
import { OutputView } from '../OutputView'

describe('ShellCode', () => {
  it('renders the command verbatim, with the prompt', () => {
    render(<ShellCode command='rg -n "needle" src | head -20' />)
    expect(screen.getByTestId('ShellCode')).toHaveTextContent('$ rg -n "needle" src | head -20')
  })

  it('keeps every character of a heredoc, across the language boundary', () => {
    const cmd = "python - <<'PY'\nimport os\nprint(os.getcwd())\nPY"
    render(<ShellCode command={cmd} />)
    // Each line is its own element (that is what makes the line breaks), so the
    // block's textContent has no newlines: compare line by line instead.
    const rendered = (screen.getByTestId('ShellCode').textContent ?? '').replace('$ ', '')
    let cursor = 0
    for (const line of cmd.split('\n')) {
      const at = rendered.indexOf(line, cursor)
      expect(at, `line missing or out of order: ${line}`).toBeGreaterThanOrEqual(cursor)
      cursor = at + line.length
    }
    expect(rendered).toHaveLength(cmd.replace(/\n/g, '').length)
  })

  it('can render without the prompt', () => {
    render(<ShellCode command="ls" prompt={false} />)
    expect(screen.getByTestId('ShellCode').textContent).toBe('ls')
  })

  it('survives an empty command without throwing', () => {
    render(<ShellCode command="" />)
    expect(screen.getByTestId('ShellCode')).toBeInTheDocument()
  })
})

describe('OutputView', () => {
  it('renders grep output with its gutter split from its content', () => {
    render(<OutputView text={'src/a.ts:12:const x = 1\nsrc/a.ts:40:const y = 2'} />)
    const grep = screen.getByTestId('OutputView.grep')
    expect(grep).toHaveTextContent('src/a.ts:12:')
    expect(grep).toHaveTextContent('const x = 1')
    expect(screen.queryByTestId('TerminalView')).not.toBeInTheDocument()
  })

  it('renders a diff in the diff palette', () => {
    render(<OutputView text={'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new'} />)
    expect(screen.getByTestId('OutputView.diff')).toHaveTextContent('+new')
  })

  it('renders JSON that parses', () => {
    render(<OutputView text={'{"state": "MERGED"}'} />)
    expect(screen.getByTestId('OutputView.json')).toHaveTextContent('MERGED')
  })

  it('renders a single-file read in that file language', () => {
    render(<OutputView text={'const x = 1\nexport {}'} command="cat src/a.ts" />)
    expect(screen.getByTestId('OutputView.file')).toHaveTextContent('const x = 1')
  })

  it('hands plain text back to the terminal view untouched', () => {
    render(<OutputView text={'building...\ndone'} command="bun run build" />)
    expect(screen.getByTestId('TerminalView')).toHaveAttribute('data-text', 'building...\ndone')
  })

  it('hands ANSI output back to the terminal view rather than re-colouring it', () => {
    const coloured = '[32msrc/a.ts:1:hit[0m\nsrc/a.ts:2:hit\nsrc/a.ts:3:hit'
    render(<OutputView text={coloured} />)
    expect(screen.getByTestId('TerminalView')).toHaveAttribute('data-text', coloured)
  })

  it('preserves every output line it highlights', () => {
    const text = 'src/a.ts:1:one\nsrc/a.ts:2:two\nsrc/b.ts:3:three'
    render(<OutputView text={text} />)
    const rendered = screen.getByTestId('OutputView.grep').textContent ?? ''
    for (const line of text.split('\n')) expect(rendered).toContain(line)
  })
})
