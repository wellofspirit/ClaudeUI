/**
 * Representative messages for the height estimate: one per block shape the
 * estimator models. Shared by the browser calibration test (real layout) so the
 * shapes it checks are the ones the unit tests reason about.
 */
import type { ChatMessage, ContentBlock } from '../../../../../../shared/types'
import type { EstimateOptions } from '../estimate-height'

const SENTENCE =
  'The scheduler keeps a ready queue per priority and wakes the worker when a task is enqueued, ' +
  'so a burst of small jobs does not pay for a context switch each time. '

export const prose = (sentences: number): string => SENTENCE.repeat(sentences).trim()

let counter = 0
const id = (): string => `m${++counter}`

export const assistant = (...content: ContentBlock[]): ChatMessage => ({
  id: id(),
  role: 'assistant',
  content,
  timestamp: 1
})
export const user = (...content: ContentBlock[]): ChatMessage => ({
  id: id(),
  role: 'user',
  content,
  timestamp: 1
})
const text = (t: string): ContentBlock => ({ type: 'text', text: t })

const lines = (n: number, make: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => make(i)).join('\n')

const call = (
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  result?: string,
  isError = false
): ContentBlock[] => [
  { type: 'tool_use', toolUseId, toolName, toolInput },
  ...(result === undefined
    ? []
    : ([{ type: 'tool_result', toolUseId, toolResult: result, isError }] as ContentBlock[]))
]

export interface Sample {
  name: string
  message: ChatMessage
  options?: Partial<EstimateOptions>
  fork?: boolean
  /** Ratio bounds (estimate / actual); the defaults are the suite-wide ones. */
  min?: number
  max?: number
}

export const SAMPLES: Sample[] = [
  { name: 'prose one line', message: assistant(text('Done.')) },
  { name: 'prose paragraph', message: assistant(text(prose(3))) },
  {
    name: 'prose three paragraphs',
    message: assistant(text([prose(2), prose(4), prose(3)].join('\n\n')))
  },
  {
    name: 'markdown mix',
    message: assistant(
      text(
        [
          '## Plan',
          prose(2),
          '- first item with some words in it',
          '- second item that is a little longer than the first one so that it wraps around',
          '- third',
          '```ts\n' + lines(12, (i) => `const value${i} = compute(${i})`) + '\n```',
          '> a quoted remark that the reviewer left on the change',
          '| name | value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n| c | 3 |',
          prose(2)
        ].join('\n\n')
      )
    )
  },
  {
    name: 'code fence 40 lines',
    message: assistant(text('```py\n' + lines(40, (i) => `print("line ${i}")`) + '\n```'))
  },
  { name: 'user short', message: user(text('please fix the failing test')) },
  { name: 'user long multiline', message: user(text(lines(6, () => prose(1)))) },
  {
    name: 'thinking collapsed',
    message: assistant({ type: 'thinking', text: prose(6) }, text('ok'))
  },
  {
    name: 'thinking expanded',
    message: assistant({ type: 'thinking', text: prose(30) }, text('ok')),
    options: { expandThinking: true }
  },
  {
    name: 'bash + short result',
    message: assistant(...call('b1', 'Bash', { command: 'ls -la src' }, 'a\nb\nc'))
  },
  {
    name: 'bash + 200-line result',
    message: assistant(
      ...call(
        'b2',
        'Bash',
        { command: 'git log --oneline' },
        lines(200, (i) => `abc${i} fix thing ${i}`)
      )
    )
  },
  {
    name: 'bash long heredoc command',
    message: assistant(
      ...call(
        'b3',
        'Bash',
        { command: "cat <<'EOF' > a.txt\n" + lines(30, (i) => `row ${i}`) + '\nEOF' },
        ''
      )
    )
  },
  {
    name: 'bash error result',
    message: assistant(
      ...call(
        'b4',
        'Bash',
        { command: 'make' },
        lines(15, (i) => `error: ${i}`),
        true
      )
    )
  },
  {
    name: 'read collapsed (default)',
    message: assistant(
      ...call(
        'r1',
        'Read',
        { file_path: 'src/a.ts' },
        lines(80, (i) => `${i + 1}→const x${i} = ${i}`)
      )
    )
  },
  {
    name: 'read expanded 80 lines',
    message: assistant(
      ...call(
        'r2',
        'Read',
        { file_path: 'src/a.ts' },
        lines(80, (i) => `${i + 1}→const x${i} = ${i}`)
      )
    ),
    options: { expandReadResults: true }
  },
  {
    name: 'edit diff',
    message: assistant(
      ...call(
        'e1',
        'Edit',
        {
          file_path: 'src/a.ts',
          old_string: lines(6, (i) => `old line ${i}`),
          new_string: lines(9, (i) => `new line ${i}`)
        },
        'The file src/a.ts has been updated.'
      )
    )
  },
  {
    name: 'write 25 lines',
    message: assistant(
      ...call(
        'w1',
        'Write',
        { file_path: 'src/new.ts', content: lines(25, (i) => `export const v${i} = ${i}`) },
        'File created successfully at: src/new.ts'
      )
    )
  },
  {
    name: 'grep results',
    message: assistant(
      ...call(
        'g1',
        'Grep',
        { pattern: 'foo', output_mode: 'content' },
        lines(12, (i) => `src/file${i}.ts:${i + 3}:const foo = ${i}`)
      )
    )
  },
  {
    name: 'webfetch',
    message: assistant(
      ...call('f1', 'WebFetch', { url: 'https://example.com', prompt: 'summarise' }, prose(4))
    )
  },
  {
    name: 'three tool calls grouped',
    message: assistant(
      ...call('t1', 'Bash', { command: 'ls' }, 'a\nb'),
      ...call('t2', 'Read', { file_path: 'a.ts' }, '1→x'),
      ...call('t3', 'Bash', { command: 'pwd' }, '/tmp')
    )
  },
  {
    name: 'todo write',
    message: assistant(
      ...call(
        'd1',
        'TodoWrite',
        { todos: [{ content: 'a', status: 'pending', activeForm: 'a' }] },
        'ok'
      )
    )
  },
  {
    name: 'text + bash + text',
    message: assistant(
      text(prose(2)),
      ...call(
        'x1',
        'Bash',
        { command: 'npm test' },
        lines(30, (i) => `ok ${i}`)
      ),
      text(prose(2))
    )
  },
  {
    name: 'glob path list',
    message: assistant(
      ...call(
        'g2',
        'Glob',
        { pattern: '**/*.ts' },
        lines(18, (i) => `src/dir/file${i}.ts`)
      )
    )
  },
  {
    name: 'mcp call',
    message: assistant(
      ...call(
        'm1',
        'mcp__github__get_issue',
        { owner: 'a', repo: 'b', number: 12 },
        lines(8, (i) => `field ${i}: value`)
      )
    )
  },
  {
    name: 'task card',
    message: assistant(
      ...call(
        'k1',
        'Task',
        { description: 'Explore the repo', prompt: 'look', subagent_type: 'Explore' },
        'Async agent launched successfully.'
      )
    )
  },
  {
    name: 'bash hidden inputs',
    message: assistant(
      ...call(
        'h1',
        'Bash',
        { command: 'ls' },
        lines(5, (i) => `f${i}`)
      )
    ),
    options: { hideToolInput: true }
  },
  {
    name: 'bash JSON output',
    message: assistant(
      ...call(
        'j1',
        'Bash',
        { command: 'cat package.json' },
        JSON.stringify(
          Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, i])),
          null,
          2
        )
      )
    )
  },
  {
    name: 'bash diff output',
    message: assistant(
      ...call(
        'j2',
        'Bash',
        { command: 'git diff' },
        'diff --git a/x b/x\n@@ -1,3 +1,3 @@\n' +
          lines(60, (i) => (i % 2 ? `+added ${i}` : `-removed ${i}`))
      )
    )
  },
  {
    name: 'bash collapsed (expandToolCalls off)',
    message: assistant(
      ...call(
        'c1',
        'Bash',
        { command: 'ls' },
        lines(5, (i) => `f${i}`)
      )
    ),
    options: { expandToolCalls: false }
  },
  {
    name: 'plan on a user message',
    message: { ...user(text('')), planContent: '# Plan\n\n' + lines(6, (i) => `- step ${i}`) }
  },
  { name: 'assistant with fork row', message: assistant(text(prose(2))), fork: true },
  {
    name: 'compact separator',
    message: { id: id(), role: 'system', content: [{ type: 'compact_separator' }], timestamp: 1 }
  },
  {
    name: 'api error',
    message: {
      id: id(),
      role: 'system',
      content: [{ type: 'api_error', errorType: 'rate_limit', errorMessage: 'slow down' }],
      timestamp: 1
    }
  }
]
