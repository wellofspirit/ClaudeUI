/**
 * A foreground Bash card swaps its live output box for the result box when the
 * command finishes. The two must cap at the same height, or the card shrinks by
 * the difference at that instant and a chat pinned to the bottom drops then
 * jumps back (a 300 px live box under a 172 px result box moved it 150-375 px).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CommandBody } from '../kinds/CommandBody'
import { ClaudeEngineToolMap } from '../ClaudeEngineToolMap'
import { TERMINAL_BOX_MAX_HEIGHT } from '../../terminal-box'
import type { ContentBlock } from '../../../../../../shared/types'
import type { KindBodyProps } from '../kinds/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

const COMMAND = 'seq 1 200'
const OUTPUT = Array.from({ length: 200 }, (_, i) => String(i + 1)).join('\n')

const block: ToolUseBlock = {
  type: 'tool_use',
  toolUseId: 'toolu_box',
  toolName: 'Bash',
  toolInput: { command: COMMAND }
}

function renderBody(extra: Partial<KindBodyProps>): ReturnType<typeof render> {
  return render(
    <CommandBody
      view={ClaudeEngineToolMap.normalize('command', { command: COMMAND })}
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
      {...extra}
    />
  )
}

const maxHeightOf = (el: HTMLElement): string => el.style.maxHeight

describe('Bash card — the live box and the result box share one height cap', () => {
  it('the running card and the finished card cap their output box at the same height', () => {
    const running = renderBody({
      isForegroundBashRunning: true,
      bashOutput: { output: OUTPUT, totalLines: 200, totalBytes: OUTPUT.length }
    })
    const live = screen.getByTestId('LiveBashOutput').querySelector('pre')
    if (!live) throw new Error('live box missing')
    const liveCap = maxHeightOf(live)
    running.unmount()

    const result: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: 'toolu_box',
      toolResult: OUTPUT,
      isError: false
    }
    renderBody({ result })
    const finished = maxHeightOf(screen.getByTestId('TerminalView'))

    expect(liveCap).toBe(`${TERMINAL_BOX_MAX_HEIGHT}px`)
    expect(finished).toBe(liveCap)
  })
})
