/**
 * The command card a Codex `commandExecution` produces, end to end from the wire
 * shape the app server sends to the text on screen.
 *
 * Codex is the one engine whose `command` is a shell-quoted JOIN of argv, so on
 * Windows the wire string carries DOUBLED path separators. Both surfaces that
 * show it — the header summary and the `$` line in the body — come from the same
 * `ToolView.command`, so both are asserted here, and the sibling engines are
 * asserted NOT to be transformed: their command is the literal script the model
 * wrote, and unescaping it would eat its backslashes.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../TerminalView', () => ({
  TerminalView: (p: { text: string }) => <div data-testid="TerminalView" data-text={p.text} />
}))

import { CommandBody } from '../kinds/CommandBody'
import { CodexEngineToolMap } from '../CodexEngineToolMap'
import { ClaudeEngineToolMap } from '../ClaudeEngineToolMap'
import { OpencodeEngineToolMap } from '../OpencodeEngineToolMap'
import { PiEngineToolMap } from '../PiEngineToolMap'
import { summarizeTool } from '../summary'
import type { ContentBlock } from '../../../../../../shared/types'
import type { ToolView } from '../../../../../../shared/tool-kinds'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

/** What the app server puts on the wire for a Windows pwsh exec. */
const WIRE = '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command ls'
/** What a human would have typed, and what the card must show. */
const TYPED = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ls'

function codexView(command: string) {
  return CodexEngineToolMap.normalize('command', { command, cwd: 'D:\\WorkPlace' })
}

function renderBody(view: ToolView, toolName: string, command: string) {
  const block: ToolUseBlock = {
    type: 'tool_use',
    toolUseId: 'item-1',
    toolName,
    toolInput: { command, cwd: 'D:\\WorkPlace' }
  }
  return render(
    <CommandBody
      view={view}
      block={block}
      expanded
      hideToolInput={false}
      theme="dark"
      isError={false}
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

const renderCodexBody = (command: string) =>
  renderBody(codexView(command), 'commandExecution', command)

describe('CommandBody — Codex commandExecution', () => {
  it('shows single backslashes on the body $ line', () => {
    renderCodexBody(WIRE)
    expect(screen.getByTestId('ShellCode').textContent).toBe(`$ ${TYPED}`)
    expect(screen.getByTestId('ShellCode').textContent).not.toContain('\\\\')
  })

  it('shows the same string in the card header summary', () => {
    // `summarizeTool('command', …)` is what ToolCard puts in the header, so the
    // header and the `$` line cannot disagree: one transform, one field.
    expect(summarizeTool('command', codexView(WIRE))).toBe(TYPED)
  })

  it('renders an unbalanced wire string exactly as it arrived', () => {
    const broken = '"C:\\\\Program Files\\\\pwsh.exe -Command ls'
    renderCodexBody(broken)
    expect(screen.getByTestId('ShellCode').textContent).toBe(`$ ${broken}`)
  })
})

describe('CommandBody — the other engines are left alone', () => {
  // A literal Windows path in a script the model wrote. Nothing escaped it, so
  // unescaping it would eat the `\` in front of the `n`.
  const script = 'dir C:\\new'
  const maps = [
    ['Claude', ClaudeEngineToolMap],
    ['opencode', OpencodeEngineToolMap],
    ['pi', PiEngineToolMap]
  ] as const

  it.each(maps)('%s keeps its bash command verbatim through normalize', (_name, map) => {
    expect(map.normalize('command', { command: script })).toMatchObject({
      kind: 'command',
      command: script
    })
  })

  it.each(maps)('%s keeps its bash command verbatim on screen', (_name, map) => {
    // Rendered as well as normalized: the shared card components must not grow a
    // transform of their own, which a normalize-only assertion would miss.
    renderBody(map.normalize('command', { command: script }), 'Bash', script)
    expect(screen.getByTestId('ShellCode').textContent).toBe(`$ ${script}`)
  })
})
