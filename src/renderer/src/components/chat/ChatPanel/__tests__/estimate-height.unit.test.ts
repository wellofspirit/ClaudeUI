/**
 * Layer 1: the height estimate's arithmetic. Each case is a property of the
 * components' layout that the estimate must keep (wrapping scales with width,
 * code does not wrap, a result box is capped, collapsed cards are one header...);
 * estimate-height.browser.test.tsx checks the absolute numbers against real
 * renders.
 */
import { describe, it, expect } from 'vitest'
import {
  bucketColumnWidth,
  defaultColumnWidth,
  estimateMarkdownHeight,
  estimateMessageHeight,
  wrappedLineCount,
  COLUMN_BUCKET_PX,
  MIN_COLUMN_PX,
  type EstimateOptions
} from '../estimate-height'
import type { ChatMessage, ContentBlock } from '../../../../../../shared/types'
import { assistant, user, prose } from './estimate-samples'

const W = 700
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const tool = (
  name: string,
  input: Record<string, unknown>,
  result?: string,
  isError = false
): ContentBlock[] => [
  { type: 'tool_use', toolUseId: `${name}-1`, toolName: name, toolInput: input },
  ...(result === undefined
    ? []
    : ([
        { type: 'tool_result', toolUseId: `${name}-1`, toolResult: result, isError }
      ] as ContentBlock[]))
]
const lines = (n: number, make: (i: number) => string = (i) => `line ${i}`): string =>
  Array.from({ length: n }, (_, i) => make(i)).join('\n')
const est = (m: ChatMessage, width = W, options: Partial<EstimateOptions> = {}): number =>
  estimateMessageHeight(m, width, options)

describe('wrappedLineCount', () => {
  it('counts explicit lines, each at least one, and wraps long ones', () => {
    expect(wrappedLineCount('', 10)).toBe(0)
    expect(wrappedLineCount('a\n\nb', 10)).toBe(3)
    expect(wrappedLineCount('x'.repeat(25), 10)).toBe(3)
  })
})

describe('assistant prose', () => {
  it('one line is one 13px/1.6 line', () => {
    expect(est(assistant(text('Done.')))).toBe(21)
  })

  it('a narrower column is taller, a wider one shorter', () => {
    const m = assistant(text(prose(6)))
    expect(est(m, 300)).toBeGreaterThan(est(m, 700))
    expect(est(m, 700)).toBeGreaterThan(est(m, 1100))
  })

  it('scales roughly with the amount of text', () => {
    expect(est(assistant(text(prose(12))))).toBeGreaterThan(3 * est(assistant(text(prose(3)))))
  })

  it('an empty text block renders nothing', () => {
    expect(est(assistant(text('')))).toBe(0)
  })

  it('paragraphs are separated by the 8px paragraph margin only', () => {
    const one = est(assistant(text('first')))
    const two = est(assistant(text('first\n\nsecond')))
    expect(two).toBe(Math.round(one * 2 + 8))
  })

  it('the 8px gap between content items (flex gap-2) is counted', () => {
    const a = est(assistant(text('a')))
    expect(est(assistant(text('a'), { type: 'thinking', text: 'x' }))).toBeGreaterThan(a + 8)
  })
})

describe('markdown blocks', () => {
  it('a code fence does NOT wrap: its height ignores the column width and the line length', () => {
    const code = '```\n' + lines(10, () => 'x'.repeat(400)) + '\n```'
    expect(estimateMarkdownHeight(code, 200)).toBe(estimateMarkdownHeight(code, 1000))
    // ...unlike the same characters as prose.
    const asProse = lines(10, () => 'x'.repeat(400))
    expect(estimateMarkdownHeight(asProse, 200)).toBeGreaterThan(
      estimateMarkdownHeight(asProse, 1000)
    )
  })

  it('a code fence is lines x 17.6 + padding/border (26) + 8px margins either side', () => {
    expect(estimateMarkdownHeight('```\n' + lines(10) + '\n```', W)).toBeCloseTo(
      10 * 17.6 + 26 + 8 + 8,
      5
    )
  })

  it('a paragraph then a fence collapse their margins instead of adding them', () => {
    const p = estimateMarkdownHeight('para', W)
    const fence = estimateMarkdownHeight('```\nx\n```', W)
    const both = estimateMarkdownHeight('para\n\n```\nx\n```', W)
    // para + max(8, 8) + the fence's body + its trailing 8; not 8 + 8 between.
    expect(both).toBeCloseTo(p + 8 + (fence - 16) + 8, 5)
  })

  it('a list indents (20px per level) and so wraps earlier than a paragraph', () => {
    const item = prose(2)
    expect(estimateMarkdownHeight(`- ${item}`, 400)).toBeGreaterThanOrEqual(
      estimateMarkdownHeight(item, 400)
    )
    expect(estimateMarkdownHeight(`- ${item}\n  - ${item}`, 300)).toBeGreaterThan(
      estimateMarkdownHeight(`- ${item}`, 300) * 1.5
    )
  })

  it('every shape has a height: heading, quote, hr, table, ordered list', () => {
    for (const src of [
      '# Title',
      '> quoted',
      '---',
      '| a | b |\n| - | - |\n| 1 | 2 |',
      '1. one\n2. two'
    ]) {
      expect(estimateMarkdownHeight(src, W)).toBeGreaterThan(0)
    }
  })

  it('a table grows with its rows', () => {
    const table = (rows: number): string =>
      '| a | b |\n| - | - |\n' + lines(rows, (i) => `| ${i} | x |`)
    expect(estimateMarkdownHeight(table(10), W)).toBeGreaterThan(
      estimateMarkdownHeight(table(2), W)
    )
  })

  it('link and emphasis markup does not count as text', () => {
    const plain = 'word '.repeat(60).trim()
    const marked = '[word](https://example.com/a/very/long/url/that/is/not/shown) '
      .repeat(60)
      .trim()
    expect(estimateMarkdownHeight(marked, 300)).toBe(estimateMarkdownHeight(plain, 300))
  })
})

describe('user messages', () => {
  it('a short message is one line in a padded bubble', () => {
    expect(est(user(text('hi')))).toBe(Math.round(20 + 20.8))
  })

  it('wraps at 85% of the column minus the bubble padding', () => {
    const m = user(text('x'.repeat(300)))
    expect(est(m, 400)).toBeGreaterThan(est(m, 1000))
  })

  it('attachments add a row, and a plan renders as the plan card', () => {
    const plain = est(user(text('see this')))
    const withImage = est(
      user({ type: 'image', mediaType: 'image/png', blobId: 'b', bytes: 1 }, text('see this'))
    )
    expect(withImage).toBeGreaterThan(plain + 100)
    const plan = { ...user(text('')), planContent: '# Plan\n\n- a\n- b' }
    expect(est(plan)).toBeGreaterThan(80)
  })
})

describe('thinking', () => {
  const think = (n: number): ChatMessage =>
    assistant({ type: 'thinking', text: prose(n) }, text('ok'))

  it('collapsed (the default) is one toggle row whatever the thought length', () => {
    expect(est(think(2))).toBe(est(think(80)))
  })

  it('expanded grows with the text and stops at the 320px cap', () => {
    const o = { expandThinking: true }
    expect(est(think(8), W, o)).toBeGreaterThan(est(think(1), W, o))
    expect(est(think(200), W, o)).toBe(est(think(400), W, o))
    expect(est(think(200), W, o)).toBeLessThan(est(think(2), W) + 340)
  })
})

describe('tool cards', () => {
  it('collapsed cards (expandToolCalls off) are just the header', () => {
    const m = assistant(...tool('Bash', { command: 'ls' }, lines(50)))
    expect(est(m, W, { expandToolCalls: false })).toBe(40)
  })

  it('an expanded card is taller than its header, and its result box stops at the 172px cap', () => {
    const open = (n: number): number => est(assistant(...tool('Bash', { command: 'ls' }, lines(n))))
    expect(open(5)).toBeGreaterThan(40)
    expect(open(100)).toBeGreaterThan(open(5))
    expect(open(100)).toBe(open(1000))
  })

  it('a grep/diff/JSON result is boxed at 260 instead (OutputView)', () => {
    const diff = 'diff --git a/x b/x\n@@ -1 +1 @@\n' + lines(100, () => '+x')
    const heightOf = (out: string): number =>
      est(assistant(...tool('Bash', { command: 'git diff' }, out)))
    expect(heightOf(diff)).toBeGreaterThan(heightOf(lines(100)))
  })

  it('Read is collapsed by default and opens with expandReadResults', () => {
    const read = assistant(...tool('Read', { file_path: 'a.ts' }, lines(60)))
    expect(est(read)).toBe(40) // header + the success border
    expect(est(read, W, { expandReadResults: true })).toBeGreaterThan(60 * 14)
  })

  it('a Read body has no height cap but follows toolOutputMaxChars', () => {
    const read = assistant(
      ...tool(
        'Read',
        { file_path: 'a.ts' },
        lines(2000, () => 'abcdefghij')
      )
    )
    const o = { expandReadResults: true }
    expect(est(read, W, { ...o, toolOutputMaxChars: 20000 })).toBeGreaterThan(
      est(read, W, { ...o, toolOutputMaxChars: 1000 }) * 5
    )
  })

  it('an error result has no height cap (the red pre is only trunc-ed to 2000 chars)', () => {
    const err = (n: number): number =>
      est(assistant(...tool('Bash', { command: 'make' }, lines(n), true)))
    expect(err(100)).toBeGreaterThan(err(10))
  })

  it('hideToolInput drops the labels', () => {
    const m = assistant(...tool('Bash', { command: 'ls' }, 'a'))
    expect(est(m, W, { hideToolInput: true })).toBeLessThan(est(m))
  })

  it('calls in one run share a bordered group; the group adds chrome and gaps', () => {
    const one = assistant(...tool('Bash', { command: 'ls' }, 'a'))
    const two = assistant(...tool('Bash', { command: 'ls' }, 'a'), {
      type: 'tool_use',
      toolUseId: 'b2',
      toolName: 'Bash',
      toolInput: { command: 'ls' }
    })
    expect(est(two)).toBeGreaterThan(est(one) + 18)
  })

  it('a hidden tool (TaskCreate) is not a row', () => {
    expect(est(assistant(...tool('TaskCreate', { subject: 's' }, 'ok')))).toBe(0)
  })

  it('one-row cards (todo) and the collapsed task card have fixed heights', () => {
    expect(
      est(assistant(...tool('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] }, 'ok')))
    ).toBe(28)
    expect(est(assistant(...tool('Task', { description: 'd', prompt: 'p' }, 'launched')))).toBe(70)
  })

  it('an edit grows with its diff rows', () => {
    const edit = (n: number): number =>
      est(
        assistant(
          ...tool('Edit', { file_path: 'a.ts', old_string: lines(n), new_string: lines(n) }, 'ok')
        )
      )
    // 18 more lines on each side = 36 more 16px rows.
    expect(edit(20) - edit(2)).toBe(36 * 16)
  })

  it('search results are one row per file', () => {
    const grep = (files: number): number =>
      est(
        assistant(
          ...tool(
            'Grep',
            { pattern: 'x' },
            lines(files, (i) => `src/f${i}.ts:${i + 1}:x`)
          )
        )
      )
    expect(grep(10)).toBeGreaterThan(grep(2) * 3)
  })

  it('a card is the same height at every column width when its text fits on a line', () => {
    const m = assistant(...tool('Bash', { command: 'ls' }, 'a'))
    expect(est(m, 400)).toBe(est(m, 1000))
  })
})

describe('system messages and the rest', () => {
  const sys = (...content: ContentBlock[]): ChatMessage => ({
    id: 's',
    role: 'system',
    content,
    timestamp: 1
  })

  it('compact separators and API errors are one short row', () => {
    expect(est(sys({ type: 'compact_separator' }))).toBeLessThan(40)
    expect(est(sys({ type: 'api_error', errorType: 'rate_limit', errorMessage: 'x' }))).toBe(38)
  })

  it('an unknown role falls back to 100', () => {
    expect(est({ ...assistant(text('x')), role: 'other' as never })).toBe(100)
  })

  it('the fork row adds a constant, only when asked', () => {
    const m = assistant(text('hello'))
    expect(est(m, W, { forkRow: true })).toBeGreaterThan(est(m))
    expect(est(m, W, { forkRow: true }) - est(m)).toBeLessThan(30)
  })

  it('is deterministic and an integer', () => {
    const m = assistant(text(prose(5)), ...tool('Bash', { command: 'ls' }, lines(30)))
    expect(est(m)).toBe(est(m))
    expect(Number.isInteger(est(m))).toBe(true)
  })

  it('never blows up on a degenerate column', () => {
    expect(est(assistant(text(prose(3))), 0)).toBeGreaterThan(0)
    expect(est(assistant(text(prose(3))), -50)).toBeGreaterThan(0)
  })
})

describe('column width', () => {
  it('buckets to 50px steps, with a floor', () => {
    expect(bucketColumnWidth(724)).toBe(700)
    expect(bucketColumnWidth(726)).toBe(750)
    expect(bucketColumnWidth(10)).toBe(MIN_COLUMN_PX)
    expect(COLUMN_BUCKET_PX).toBe(50)
  })

  it('a resize inside a bucket changes no estimate', () => {
    const m = assistant(text(prose(8)))
    expect(est(m, bucketColumnWidth(710))).toBe(est(m, bucketColumnWidth(735)))
  })

  it('has a default from the chat width settings before anything is measured', () => {
    expect(defaultColumnWidth({ isMobile: false, mode: 'px', px: 740 })).toBe(700)
    expect(defaultColumnWidth({ isMobile: false, mode: 'percent', px: 740 })).toBe(700)
    expect(defaultColumnWidth({ isMobile: false, mode: 'px', px: 1100 })).toBe(1050)
    expect(defaultColumnWidth({ isMobile: true, mode: 'px', px: 740 })).toBeLessThan(450)
  })
})
