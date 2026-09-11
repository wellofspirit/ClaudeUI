import { describe, expect, it } from 'vitest'
import { codexItemId, mapCodexDelta, mapCodexItem } from '../event-mapper'
import { selectCodexModel } from '../model-selection'
import type { ThreadItem } from '../protocol/v2/ThreadItem'
import type { Model } from '../protocol/v2/Model'

describe('Codex item mapping', () => {
  it('does not turn an interrupted in-progress command into a successful result', () => {
    const output = mapCodexItem(
      'root',
      'turn',
      {
        type: 'commandExecution',
        id: 'active',
        command: 'sleep',
        cwd: '/tmp',
        status: 'inProgress',
        exitCode: null,
        aggregatedOutput: 'partial'
      } as ThreadItem,
      true,
      1
    )
    expect(output[1]).toMatchObject({
      kind: 'toolResult',
      isError: true,
      result: expect.stringContaining('did not report completion')
    })
  })
  it('scopes item ids across turns and threads without delimiter collisions', () => {
    expect(
      new Set([
        codexItemId('a:b', 'c', 'd'),
        codexItemId('a', 'b:c', 'd'),
        codexItemId('a', 'b', 'c:d')
      ]).size
    ).toBe(3)
  })
  it('maps authoritative command output and file diffs', () => {
    const command = mapCodexItem(
      'root',
      'turn',
      {
        type: 'commandExecution',
        id: '1',
        command: 'pwd',
        cwd: '/tmp',
        status: 'failed',
        exitCode: 1,
        aggregatedOutput: 'failure'
      } as ThreadItem,
      true,
      123
    )
    expect(command[1]).toMatchObject({ kind: 'toolResult', result: 'failure', isError: true })
    const file = mapCodexItem(
      'root',
      'turn',
      {
        type: 'fileChange',
        id: '1',
        status: 'completed',
        changes: [
          { path: 'a.ts', diff: '@@\n-old\n+new', kind: { type: 'update', move_path: null } }
        ]
      },
      true,
      123
    )
    expect(file[1]).toMatchObject({
      kind: 'toolResult',
      fileDiffs: [{ path: 'a.ts', patch: '@@\n-old\n+new' }],
      isError: false
    })
  })
  it('keeps native ultra effort and config defaults separate from Claude aliases', () => {
    const catalog = [
      { model: 'default-native', isDefault: true },
      { model: 'configured' }
    ] as Model[]
    expect(selectCodexModel(catalog, 'configured')).toBe('configured')
    expect(selectCodexModel([], null, 'unknown-explicit')).toBe('unknown-explicit')
    expect(selectCodexModel([], null)).toBeUndefined()
    expect(() => selectCodexModel(catalog, null, 'default')).toThrow('unavailable')
  })
  it('maps reasoning and command deltas without clocks', () => {
    expect(
      mapCodexDelta('item/reasoning/summaryTextDelta', {
        threadId: 'r',
        turnId: 't',
        itemId: 'i',
        delta: 'thought'
      })
    ).toEqual([{ kind: 'stream', delta: { type: 'thinking', text: 'thought' } }])
    expect(
      mapCodexDelta('item/commandExecution/outputDelta', {
        threadId: 'r',
        turnId: 't',
        itemId: 'i',
        delta: 'out'
      })[0]
    ).toMatchObject({ kind: 'commandDelta', delta: 'out' })
  })
})
