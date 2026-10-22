/**
 * Decision 4's harness fact (P2b item 3): is the action now under review a retry
 * of a call the harness already refused? Pure, so the whole matrix — identical,
 * whitespace, subset, superset, outcome gating, most-recent-wins, truncation,
 * edit `edits` arrays, quoting — runs without a model or an engine.
 */
import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
import { slimTranscript } from '../classifier'
import {
  RETRY_CALL_MAX_CHARS,
  editPathsOf,
  renderToolCall,
  retryFactOf,
  splitShellSegments
} from '../retry-match'

let seq = 0
function assistantToolCall(
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): ChatMessage {
  return {
    id: `m${seq++}`,
    role: 'assistant',
    content: [{ type: 'tool_use', toolUseId, toolName, toolInput }],
    timestamp: 0
  }
}

function bashCall(command: string, workdir?: string): Record<string, unknown> {
  return workdir === undefined ? { command } : { command, workdir }
}

/** One prior bash call with the given outcome, as `retryFactOf` reads it. */
function prior(
  command: string,
  outcome: 'ok' | 'error' | 'automode-blocked' | 'rejected-by-user' | 'unanswered',
  id = 'c1'
): { messages: ChatMessage[]; outcomes: Record<string, typeof outcome> } {
  return {
    messages: [assistantToolCall(id, 'bash', { command })],
    outcomes: { [id]: outcome }
  }
}

describe('renderToolCall', () => {
  it('is exactly the line slimTranscript renders for the same call', () => {
    const messages = [
      assistantToolCall('c1', 'bash', { command: 'rm -rf build', workdir: '/repo' })
    ]
    expect(slimTranscript(messages)).toBe(
      renderToolCall('bash', { command: 'rm -rf build', workdir: '/repo' })
    )
    expect(slimTranscript(messages)).toBe('bash {"command":"rm -rf build","workdir":"/repo"}')
  })

  it('renders a missing input as an empty object', () => {
    expect(renderToolCall('bash', undefined)).toBe('bash {}')
  })
})

describe('retryFactOf — identical', () => {
  it('reports the earlier blocked call exactly as the transcript renders it', () => {
    const { messages, outcomes } = prior('rm -rf build', 'automode-blocked')
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { toolName: 'bash', input: { command: 'rm -rf build' } }
      })
    ).toEqual({
      match: 'identical',
      outcome: 'automode-blocked',
      call: 'bash {"command":"rm -rf build"}'
    })
  })

  it('compares a shell command after whitespace normalisation (a formatting variant is still a retry)', () => {
    const { messages, outcomes } = prior('rm  -rf\tbuild\n', 'automode-blocked')
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { toolName: 'bash', input: { command: '  rm -rf build ' } }
      })?.match
    ).toBe('identical')
  })

  it('requires the same workdir', () => {
    const action = { toolName: 'bash', input: bashCall('bun run build', '/repo/a') }
    const same = prior('bun run build', 'automode-blocked')
    same.messages[0] = assistantToolCall('c1', 'bash', bashCall('bun run build', '/repo/a'))
    expect(retryFactOf({ ...same, action })?.match).toBe('identical')

    const other = prior('bun run build', 'automode-blocked')
    other.messages[0] = assistantToolCall('c1', 'bash', bashCall('bun run build', '/repo/b'))
    expect(retryFactOf({ ...other, action })).toBeUndefined()
  })

  it('ignores the keys that do not change a shell call’s effect (a reworded description, a timeout)', () => {
    const { messages, outcomes } = prior('x', 'automode-blocked')
    messages[0] = assistantToolCall('c1', 'bash', {
      command: 'rm -rf build',
      description: 'Remove build output'
    })
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: {
          toolName: 'bash',
          input: { command: 'rm -rf build', description: 'Clean the build dir', timeout: 60000 }
        }
      })?.match
    ).toBe('identical')
  })

  it('ignores key order (deep equality, not string equality)', () => {
    const { messages, outcomes } = prior('x', 'automode-blocked')
    messages[0] = assistantToolCall('c1', 'bash', { workdir: '/repo', command: 'x' })
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { toolName: 'bash', input: { command: 'x', workdir: '/repo' } }
      })?.match
    ).toBe('identical')
  })

  it('is not a fact for a non-shell input that merely shares the tool name', () => {
    const { messages, outcomes } = prior('x', 'automode-blocked')
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { toolName: 'edit', input: { path: 'a.ts', oldText: 'x', newText: 'y' } }
      })
    ).toBeUndefined()
  })

  it('matches an edit call with a deep-equal input (pi path / opencode filePath)', () => {
    const messages = [
      assistantToolCall('c1', 'edit', { path: 'src/a.ts', oldText: 'a', newText: 'b' })
    ]
    const outcomes = { c1: 'rejected-by-user' as const }
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { toolName: 'edit', input: { path: 'src/a.ts', oldText: 'a', newText: 'b' } }
      })
    ).toEqual({
      match: 'identical',
      outcome: 'rejected-by-user',
      call: 'edit {"path":"src/a.ts","oldText":"a","newText":"b"}'
    })
  })
})

describe('retryFactOf — subset', () => {
  const current = (command: string): Parameters<typeof retryFactOf>[0]['action'] => ({
    toolName: 'bash',
    input: { command }
  })

  it('matches a segment of an earlier blocked command that was refused', () => {
    const { messages, outcomes } = prior('rm -rf build && git push origin main', 'automode-blocked')
    expect(retryFactOf({ messages, outcomes, action: current('git push origin main') })).toEqual({
      match: 'subset',
      outcome: 'automode-blocked',
      call: 'bash {"command":"rm -rf build && git push origin main"}'
    })
  })

  it('matches several segments, in any order', () => {
    const { messages, outcomes } = prior('a; b\nc', 'automode-blocked')
    expect(retryFactOf({ messages, outcomes, action: current('c && a') })?.match).toBe('subset')
  })

  it('requires the same workdir (the same segment elsewhere is a different action)', () => {
    const { messages, outcomes } = prior('x', 'automode-blocked')
    messages[0] = assistantToolCall('c1', 'bash', bashCall('rm -rf build && git push', '/repo/a'))
    const action = { toolName: 'bash', input: bashCall('rm -rf build', '/repo/b') }
    expect(retryFactOf({ messages, outcomes, action })).toBeUndefined()
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { ...action, input: bashCall('rm -rf build', '/repo/a') }
      })?.match
    ).toBe('subset')
  })

  it('does NOT match a SUPERSET (the current call does more than the refused one)', () => {
    const { messages, outcomes } = prior('git push origin main', 'automode-blocked')
    expect(
      retryFactOf({ messages, outcomes, action: current('rm -rf build && git push origin main') })
    ).toBeUndefined()
  })

  it('does not match a near-miss segment (subset means the same segment text)', () => {
    const { messages, outcomes } = prior('rm -rf build && git push origin main', 'automode-blocked')
    expect(
      retryFactOf({ messages, outcomes, action: current('rm -rf build && git push') })
    ).toBeUndefined()
  })

  it('does not split on a pipe (a pipeline is one action, not a subset)', () => {
    const { messages, outcomes } = prior('ls build | grep x', 'automode-blocked')
    expect(retryFactOf({ messages, outcomes, action: current('grep x') })).toBeUndefined()
  })

  it('does not split inside quotes', () => {
    const { messages, outcomes } = prior('echo "a && b" && git push', 'automode-blocked')
    expect(retryFactOf({ messages, outcomes, action: current('git push') })?.match).toBe('subset')
    // …and a separator inside quotes is text, not a boundary.
    expect(splitShellSegments('echo "a && b"')).toEqual(['echo "a && b"'])
  })

  it('an unbalanced quote yields no subset fact (never a false one)', () => {
    const { messages, outcomes } = prior('echo "x && rm -rf build', 'automode-blocked')
    expect(retryFactOf({ messages, outcomes, action: current('rm -rf build') })).toBeUndefined()
  })

  it('matches an edit `edits` array subset on the same path', () => {
    const messages = [
      assistantToolCall('c1', 'edit', {
        filePath: 'src/a.ts',
        edits: [
          { old: 'a', new: 'b' },
          { old: 'c', new: 'd' }
        ]
      })
    ]
    const outcomes = { c1: 'automode-blocked' as const }
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: {
          toolName: 'edit',
          input: { filePath: 'src/a.ts', edits: [{ old: 'c', new: 'd' }] }
        }
      })?.match
    ).toBe('subset')
    // A different path is not a subset.
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: {
          toolName: 'edit',
          input: { filePath: 'src/b.ts', edits: [{ old: 'c', new: 'd' }] }
        }
      })
    ).toBeUndefined()
    // An edit the earlier list did not carry is not a subset.
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: {
          toolName: 'edit',
          input: { filePath: 'src/a.ts', edits: [{ old: 'e', new: 'f' }] }
        }
      })
    ).toBeUndefined()
  })
})

describe('retryFactOf — outcome gating', () => {
  it.each([['ok'], ['error'], ['unanswered']] as const)(
    'no fact when the earlier call ended %s',
    (outcome) => {
      const { messages, outcomes } = prior('rm -rf build', outcome)
      expect(
        retryFactOf({
          messages,
          outcomes,
          action: { toolName: 'bash', input: { command: 'rm -rf build' } }
        })
      ).toBeUndefined()
    }
  )

  it('a rejected-by-user call is as much a refusal as an automode block', () => {
    const { messages, outcomes } = prior('rm -rf build', 'rejected-by-user')
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { toolName: 'bash', input: { command: 'rm -rf build' } }
      })?.outcome
    ).toBe('rejected-by-user')
  })

  it('no outcomes at all → no fact (absence is not a refusal)', () => {
    const { messages } = prior('rm -rf build', 'automode-blocked')
    expect(
      retryFactOf({
        messages,
        action: { toolName: 'bash', input: { command: 'rm -rf build' } }
      })
    ).toBeUndefined()
  })

  it('a different tool name with the same input is not a retry', () => {
    const messages = [assistantToolCall('c1', 'shell', { command: 'rm -rf build' })]
    const outcomes = { c1: 'automode-blocked' as const }
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { toolName: 'bash', input: { command: 'rm -rf build' } }
      })
    ).toBeUndefined()
  })

  it('folds tool-name case (engine spelling drift still matches)', () => {
    const messages = [assistantToolCall('c1', 'Bash', { command: 'rm -rf build' })]
    const outcomes = { c1: 'automode-blocked' as const }
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { toolName: 'bash', input: { command: 'rm -rf build' } }
      })?.call
    ).toBe('Bash {"command":"rm -rf build"}')
  })
})

describe('retryFactOf — which refusal wins', () => {
  it('the MOST RECENT matching refusal wins', () => {
    const messages = [
      assistantToolCall('c1', 'bash', { command: 'bun run build' }),
      assistantToolCall('c2', 'bash', { command: 'bun run  build' })
    ]
    const outcomes = { c1: 'rejected-by-user' as const, c2: 'automode-blocked' as const }
    expect(
      retryFactOf({
        messages,
        outcomes,
        action: { toolName: 'bash', input: { command: 'bun run build' } }
      })
    ).toEqual({
      match: 'identical',
      outcome: 'automode-blocked',
      call: 'bash {"command":"bun run  build"}'
    })
  })

  it('a later call that was NOT refused does not erase an earlier refusal', () => {
    const messages = [
      assistantToolCall('c1', 'bash', { command: 'a && b' }),
      assistantToolCall('c2', 'bash', { command: 'a && b' })
    ]
    const outcomes = { c1: 'automode-blocked' as const, c2: 'ok' as const }
    expect(
      retryFactOf({ messages, outcomes, action: { toolName: 'bash', input: { command: 'a' } } })
        ?.call
    ).toBe('bash {"command":"a && b"}')
  })

  it('reads assistant messages only', () => {
    const userRow: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: [
        { type: 'tool_use', toolUseId: 'c1', toolName: 'bash', toolInput: { command: 'a' } }
      ],
      timestamp: 0
    }
    expect(
      retryFactOf({
        messages: [userRow],
        outcomes: { c1: 'automode-blocked' },
        action: { toolName: 'bash', input: { command: 'a' } }
      })
    ).toBeUndefined()
  })
})

describe('retryFactOf — the call is cut', () => {
  it('keeps the transcript line whole up to 300 chars, then cuts and marks it', () => {
    const long = `echo ${'a'.repeat(400)}`
    const { messages, outcomes } = prior(long, 'automode-blocked')
    const fact = retryFactOf({
      messages,
      outcomes,
      action: { toolName: 'bash', input: { command: long } }
    })
    expect(fact).toBeDefined()
    expect(fact!.call.length).toBe(RETRY_CALL_MAX_CHARS + 1)
    expect(fact!.call.endsWith('…')).toBe(true)
    expect(fact!.call.slice(0, RETRY_CALL_MAX_CHARS)).toBe(
      `bash {"command":"echo ${'a'.repeat(400)}"}`.slice(0, RETRY_CALL_MAX_CHARS)
    )
  })

  it('leaves a call of exactly 300 chars untouched', () => {
    const exact = 'a'.repeat(300 - 'bash {"command":""}'.length)
    const { messages, outcomes } = prior(exact, 'automode-blocked')
    const fact = retryFactOf({
      messages,
      outcomes,
      action: { toolName: 'bash', input: { command: exact } }
    })
    expect(fact!.call.length).toBe(RETRY_CALL_MAX_CHARS)
    expect(fact!.call.endsWith('…')).toBe(false)
  })
})

describe('splitShellSegments', () => {
  it('splits at top-level &&, ||, ; and newlines, never at |', () => {
    expect(splitShellSegments('a && b || c ; d\ne | f')).toEqual(['a', 'b', 'c', 'd', 'e | f'])
  })

  it('keeps quotes and backslash escapes intact', () => {
    expect(splitShellSegments("echo 'a; b' && echo \\;")).toEqual(["echo 'a; b'", 'echo \\;'])
  })

  it('drops empty segments', () => {
    expect(splitShellSegments(';; \n && ')).toEqual([])
  })
})

describe('editPathsOf', () => {
  it('is empty for a non-edit tool', () => {
    expect(editPathsOf('bash', { command: 'x' })).toEqual([])
  })

  it('reads pi path / file_path and opencode filePath', () => {
    expect(editPathsOf('edit', { path: 'a.ts' })).toEqual(['a.ts'])
    expect(editPathsOf('edit', { file_path: 'a.ts' })).toEqual(['a.ts'])
    expect(editPathsOf('write', { filePath: 'a.ts' })).toEqual(['a.ts'])
  })

  it('reads every apply_patch file header (add / update / delete / move)', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: notes.md',
      '+hi',
      '*** Update File: .git/config',
      '*** Move to: hooks/post-checkout',
      '*** Delete File: old.txt',
      '*** End Patch'
    ].join('\n')
    expect(editPathsOf('apply_patch', { patchText })).toEqual([
      'notes.md',
      '.git/config',
      'hooks/post-checkout',
      'old.txt'
    ])
  })

  it('a patch whose paths cannot be read is null (fail toward review)', () => {
    expect(editPathsOf('apply_patch', { patchText: 'not a patch' })).toBeNull()
    expect(editPathsOf('patch', {})).toBeNull()
    expect(editPathsOf('apply_patch', { patchText: '*** Update File:   ' })).toBeNull()
  })

  it('an edit with no path at all writes nothing, so it is not a target', () => {
    expect(editPathsOf('edit', { oldText: 'a', newText: 'b' })).toEqual([])
  })
})
