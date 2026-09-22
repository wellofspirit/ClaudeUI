/**
 * @vitest-environment node
 *
 * tmp-dir fixture tests for pi-session-list.ts. Real files under a temp
 * directory (never ~/.pi/**) — `os.homedir()` is redirected there via a
 * hoisted mock so piAgentDir() resolves inside the fixture tree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  existsSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const homedirHolder = vi.hoisted(() => ({ current: '' }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => homedirHolder.current,
    default: { ...actual, homedir: () => homedirHolder.current }
  }
})

// The status line prices history under the vendor's billing type. Mocked so a
// developer's own ~/.pi/agent/auth.json never decides what these assert (the
// homedir redirect above already points the real reader at the fixture tree).
const { mockProbe, mockBuildPiAccountRef } = vi.hoisted(() => ({
  mockProbe: vi.fn(),
  mockBuildPiAccountRef: vi.fn()
}))
vi.mock('../../../core/auth/PiAuthProvider', () => ({
  piAuthProvider: { probe: mockProbe, buildPiAccountRef: mockBuildPiAccountRef }
}))

import {
  listPiSessionsGlobal,
  loadPiSessionHistory,
  findPiSessionFile,
  deletePiSession,
  resolvePiForkAnchor
} from '../../../core/services/pi-session-list'
import { PI_FORK_CLONE_LATEST_SENTINEL } from '../../../core/services/fork-anchor'

let testHome: string

function sessionsRoot(): string {
  return join(testHome, '.pi', 'agent', 'sessions')
}

/** Write a session .jsonl file (header + entry lines) under a project dir. */
function writeSessionFile(projectDirName: string, fileName: string, lines: unknown[]): string {
  const dir = join(sessionsRoot(), projectDirName)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, fileName)
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
  return file
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'pi-session-list-test-'))
  homedirHolder.current = testHome
  mockProbe.mockReset().mockResolvedValue({})
  mockBuildPiAccountRef.mockReset().mockReturnValue(null)
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('listPiSessionsGlobal', () => {
  it('prefers the LAST session_info name over the first-user-message fallback', async () => {
    writeSessionFile('--proj-fork--', '2024-01-01T00-00-00_sess-fork-1.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-fork-1',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/fork'
      },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2024-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'First message here', timestamp: 1 }
      },
      {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2024-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
          api: 'a',
          provider: 'p',
          model: 'm',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop',
          timestamp: 2
        }
      },
      {
        type: 'session_info',
        id: 'einfo',
        parentId: 'e2',
        timestamp: '2024-01-01T00:00:03.000Z',
        name: 'Renamed Session'
      }
    ])

    const result = await listPiSessionsGlobal()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      sessionId: 'sess-fork-1',
      cwd: '/proj/fork',
      projectKey: '-proj-fork',
      title: 'Renamed Session',
      engineId: 'pi'
    })
  })

  it('falls back to the first user message (first line, trimmed) when there is no session_info', async () => {
    writeSessionFile('--proj-b--', 'x_sess-b.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-b',
        timestamp: '2024-01-02T00:00:00.000Z',
        cwd: '/proj/b'
      },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2024-01-02T00:00:01.000Z',
        message: { role: 'user', content: '  Fix the login bug\nmore context here  ', timestamp: 1 }
      }
    ])
    const infos = await listPiSessionsGlobal()
    expect(infos[0].title).toBe('Fix the login bug')
  })

  it('falls back to "Untitled" when there is neither a session_info nor a user message', async () => {
    writeSessionFile('--proj-c--', 'x_sess-c.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-c',
        timestamp: '2024-01-03T00:00:00.000Z',
        cwd: '/proj/c'
      }
    ])
    const infos = await listPiSessionsGlobal()
    expect(infos[0].title).toBe('Untitled')
  })

  it('sorts newest-first by file mtime, across multiple project directories', async () => {
    const older = writeSessionFile('--proj-old--', 'x_sess-old.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-old',
        timestamp: '2020-01-01T00:00:00.000Z',
        cwd: '/proj/old'
      }
    ])
    const newer = writeSessionFile('--proj-new--', 'x_sess-new.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-new',
        timestamp: '2025-01-01T00:00:00.000Z',
        cwd: '/proj/new'
      }
    ])
    const oldTime = new Date('2020-01-01T00:00:00.000Z')
    const newTime = new Date('2025-06-01T00:00:00.000Z')
    utimesSync(older, oldTime, oldTime)
    utimesSync(newer, newTime, newTime)

    const infos = await listPiSessionsGlobal()
    expect(infos.map((i) => i.sessionId)).toEqual(['sess-new', 'sess-old'])
  })

  it('returns [] when ~/.pi/agent/sessions does not exist (pi never run)', async () => {
    expect(await listPiSessionsGlobal()).toEqual([])
  })

  it('skips a row with no cwd rather than throwing', async () => {
    writeSessionFile('--no-cwd--', 'x_sess-nocwd.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-nocwd',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: ''
      }
    ])
    expect(await listPiSessionsGlobal()).toEqual([])
  })

  it('derives the LAST session_info rename even when a large image message sits after the first user message', async () => {
    // The list-row reader skips JSON.parsing big message lines (item 13 perf
    // fix) but MUST keep scanning to end of file for a later session_info
    // rename (last wins). A 200KB base64 image line between the first user
    // message and the rename exercises exactly that skip-but-keep-scanning path.
    const bigBase64 = 'A'.repeat(200_000)
    writeSessionFile('--proj-img--', 'x_sess-img.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-img',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/img'
      },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2024-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'First user prompt', timestamp: 1 }
      },
      {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2024-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'image', image: bigBase64, mimeType: 'image/png' }],
          timestamp: 2
        }
      },
      {
        type: 'session_info',
        id: 'einfo',
        parentId: 'e2',
        timestamp: '2024-01-01T00:00:03.000Z',
        name: 'Renamed After Image'
      }
    ])

    const result = await listPiSessionsGlobal()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ sessionId: 'sess-img', title: 'Renamed After Image' })
  })
})

describe('loadPiSessionHistory — active-branch walk (fork)', () => {
  const HEADER = {
    type: 'session',
    version: 3,
    id: 'sess-fork-2',
    timestamp: '2024-01-01T00:00:00.000Z',
    cwd: '/proj/fork2'
  }
  const userEntry = (id: string, parentId: string | null, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user', content: text, timestamp: 1 }
  })
  const assistantEntry = (id: string, parentId: string, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'a',
      provider: 'p',
      model: 'm',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: 2
    }
  })

  it("follows the LAST entry's parentId chain — the abandoned branch is absent", async () => {
    // e1 -> e2 -> (fork: e3 abandoned, e4 -> e5 active, e5 is LAST in file)
    writeSessionFile('--proj-fork2--', 'x_sess-fork-2.jsonl', [
      HEADER,
      userEntry('e1', null, 'root message'),
      assistantEntry('e2', 'e1', 'root reply'),
      userEntry('e3', 'e2', 'ABANDONED branch message'),
      userEntry('e4', 'e2', 'active branch message'),
      assistantEntry('e5', 'e4', 'active branch reply')
    ])

    const { messages } = await loadPiSessionHistory('sess-fork-2')
    expect(messages.map((m) => m.id)).toEqual(['e1', 'e2', 'e4', 'e5'])
    const allText = JSON.stringify(messages)
    expect(allText).not.toContain('ABANDONED')
    expect(allText).toContain('active branch message')
    expect(allText).toContain('active branch reply')
  })

  it('pairs a toolCall with its later toolResult entry in the SAME assistant message', async () => {
    writeSessionFile('--proj-tool--', 'x_sess-tool.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-tool',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/tool'
      },
      userEntry('u1', null, 'run ls'),
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2024-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }],
          api: 'a',
          provider: 'p',
          model: 'm',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'toolUse',
          timestamp: 2
        }
      },
      {
        type: 'message',
        id: 'tr1',
        parentId: 'a1',
        timestamp: '2024-01-01T00:00:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'file1.txt' }],
          isError: false,
          timestamp: 3
        }
      }
    ])

    const { messages } = await loadPiSessionHistory('sess-tool')
    // toolResult is folded into the assistant message — NOT its own ChatMessage.
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    const assistantMsg = messages.find((m) => m.id === 'a1')!
    expect(assistantMsg.content).toEqual([
      { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 'call_1', toolResult: 'file1.txt', isError: false }
    ])
  })

  it("carries a toolResult's image content onto the folded tool_result block", async () => {
    // pi's read tool on an image returns `{type:'image', data, mimeType}` content
    // blocks alongside (or instead of) text; the replay used to keep only text.
    writeSessionFile('--proj-toolimg--', 'x_sess-toolimg.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-toolimg',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/toolimg'
      },
      userEntry('u1', null, 'read the png'),
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2024-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call_img', name: 'read', arguments: { path: '/x.png' } }
          ],
          api: 'a',
          provider: 'p',
          model: 'm',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'toolUse',
          timestamp: 2
        }
      },
      {
        type: 'message',
        id: 'tr1',
        parentId: 'a1',
        timestamp: '2024-01-01T00:00:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_img',
          toolName: 'read',
          content: [
            { type: 'text', text: 'Image read' },
            { type: 'image', data: 'PIIMG', mimeType: 'image/png' },
            { type: 'image', data: 'DROPME', mimeType: 'image/svg+xml' }
          ],
          isError: false,
          timestamp: 3
        }
      }
    ])

    const { messages } = await loadPiSessionHistory('sess-toolimg')
    const result = messages
      .find((m) => m.id === 'a1')!
      .content.find((b) => b.type === 'tool_result')
    expect(result).toEqual({
      type: 'tool_result',
      toolUseId: 'call_img',
      toolResult: 'Image read',
      isError: false,
      // image/svg+xml is outside the modelled media types — dropped, not widened.
      images: [{ mediaType: 'image/png', base64Data: 'PIIMG' }]
    })
  })

  it('converts a compaction entry to a compact_separator system message', async () => {
    writeSessionFile('--proj-compact--', 'x_sess-compact.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-compact',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/compact'
      },
      userEntry('u1', null, 'hi'),
      {
        type: 'compaction',
        id: 'c1',
        parentId: 'u1',
        timestamp: '2024-01-01T00:00:01.000Z',
        summary: 'Summary line one.\nMore detail.',
        firstKeptEntryId: 'u1',
        tokensBefore: 500
      }
    ])
    const { messages } = await loadPiSessionHistory('sess-compact')
    const compactMsg = messages.find((m) => m.id === 'c1')
    expect(compactMsg).toMatchObject({
      role: 'system',
      // The WHOLE summary, not its first line (F20) — the amber card reveals
      // the body only when the user opens it.
      content: [{ type: 'compact_separator', text: 'Summary line one.\nMore detail.' }]
    })
  })

  it('returns no messages and no status line for an unknown sessionId', async () => {
    expect(await loadPiSessionHistory('does-not-exist')).toEqual({
      messages: [],
      statusLine: null
    })
  })

  // S1d — the line the reopened session paints before pi is ever spawned.
  it('builds the status line AFTER the auth probe, so the bill is resolved', async () => {
    // The probe is what turns `unknown` into `subscription`; building the line
    // before it lands would report a null bill for a covered session.
    mockProbe.mockImplementation(async () => {
      mockBuildPiAccountRef.mockReturnValue({ billingType: 'subscription' })
      return {}
    })
    writeSessionFile('--proj-status--', 'x_sess-status.jsonl', [
      { ...HEADER, id: 'sess-status' },
      userEntry('e1', null, 'prompt'),
      {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2024-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          usage: {
            input: 1_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop',
          timestamp: 2
        }
      }
    ])

    const { statusLine } = await loadPiSessionHistory('sess-status')
    expect(mockProbe).toHaveBeenCalled()
    expect(statusLine?.billedCostUsd).toBe(0)
    // $3/MTok input, and pi's own zero is not what a subscription is worth.
    expect(statusLine?.totalCostUsd).toBeCloseTo(3, 10)
    expect(statusLine?.totalInputTokens).toBe(1_000_000)
  })

  it('still returns the transcript and a line when the probe rejects', async () => {
    mockProbe.mockRejectedValue(new Error('auth.json is unreadable'))
    writeSessionFile('--proj-probefail--', 'x_sess-probefail.jsonl', [
      { ...HEADER, id: 'sess-probefail' },
      userEntry('e1', null, 'prompt'),
      assistantEntry('e2', 'e1', 'reply')
    ])

    const { messages, statusLine } = await loadPiSessionHistory('sess-probefail')
    expect(messages.map((m) => m.id)).toEqual(['e1', 'e2'])
    expect(statusLine).not.toBeNull()
  })

  it('a cyclic parentId chain resolves without hanging — the `seen` guard breaks the loop (best-effort branch)', async () => {
    // e1 <-> e2 point at EACH OTHER — no root is ever reached. activeBranchEntries'
    // `seen` set must stop the walk the second time it revisits an id rather
    // than looping forever.
    writeSessionFile('--proj-cycle--', 'x_sess-cycle.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-cycle',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/cycle'
      },
      userEntry('e1', 'e2', 'first'),
      userEntry('e2', 'e1', 'second')
    ])

    const { messages } = await loadPiSessionHistory('sess-cycle')
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.length).toBeLessThanOrEqual(2)
  })

  it('skips a single corrupt mid-file JSONL line — every entry before and after it still parses', async () => {
    const dir = join(sessionsRoot(), '--proj-corrupt--')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'x_sess-corrupt.jsonl')
    const header = JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-corrupt',
      timestamp: '2024-01-01T00:00:00.000Z',
      cwd: '/proj/corrupt'
    })
    const goodEntry1 = JSON.stringify(userEntry('e1', null, 'before the corrupt line'))
    const corruptLine = '{not valid json at all'
    const goodEntry2 = JSON.stringify(userEntry('e2', 'e1', 'after the corrupt line'))
    writeFileSync(file, [header, goodEntry1, corruptLine, goodEntry2].join('\n') + '\n', 'utf-8')

    const { messages } = await loadPiSessionHistory('sess-corrupt')
    expect(messages.map((m) => m.id)).toEqual(['e1', 'e2'])
  })
})

describe('resolvePiForkAnchor', () => {
  const userEntry = (id: string, parentId: string | null, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user', content: text, timestamp: 1 }
  })
  const assistantEntry = (id: string, parentId: string, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'a',
      provider: 'p',
      model: 'm',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: 2
    }
  })
  const modelChangeEntry = (id: string, parentId: string) => ({
    type: 'model_change',
    id,
    parentId,
    timestamp: '2024-01-01T00:00:00.000Z',
    provider: 'anthropic',
    modelId: 'claude-x'
  })

  it('forking an earlier assistant returns the id of the following user entry — a model_change entry in between is skipped', () => {
    writeSessionFile('--proj-fork-anchor--', 'x_sess-anchor-1.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-anchor-1',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/anchor1'
      },
      userEntry('u1', null, 'first question'),
      assistantEntry('a1', 'u1', 'first answer'),
      modelChangeEntry('mc1', 'a1'),
      userEntry('u2', 'mc1', 'second question'),
      assistantEntry('a2', 'u2', 'second answer')
    ])

    // messages (as convertPiSessionEntries would build them) are [u1, a1, u2, a2] —
    // model_change never produces a ChatMessage, so it never occupies a slot.
    // Forking a1 (index 1) should drop u2 onward.
    expect(resolvePiForkAnchor('sess-anchor-1', 1)).toEqual({ anchorUuid: 'u2' })
  })

  it('forking the latest assistant message returns the clone-latest sentinel', () => {
    writeSessionFile('--proj-fork-anchor--', 'x_sess-anchor-2.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-anchor-2',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/anchor2'
      },
      userEntry('u1', null, 'only question'),
      assistantEntry('a1', 'u1', 'only answer')
    ])

    expect(resolvePiForkAnchor('sess-anchor-2', 1)).toEqual({
      anchorUuid: PI_FORK_CLONE_LATEST_SENTINEL
    })
  })

  it('returns transcript-not-found for an unknown sessionId', () => {
    expect(resolvePiForkAnchor('does-not-exist', 0)).toEqual({
      anchorUuid: null,
      reason: 'transcript-not-found'
    })
  })

  it('returns message-not-found when the index is out of range', () => {
    writeSessionFile('--proj-fork-anchor--', 'x_sess-anchor-3.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-anchor-3',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/anchor3'
      },
      userEntry('u1', null, 'q')
    ])

    expect(resolvePiForkAnchor('sess-anchor-3', 5)).toEqual({
      anchorUuid: null,
      reason: 'message-not-found'
    })
  })
})

describe('findPiSessionFile', () => {
  it('finds a file by its `_<sessionId>.jsonl` suffix', () => {
    const file = writeSessionFile('--proj-find--', '2024-01-01T00-00-00_find-me-123.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'find-me-123',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/find'
      }
    ])
    expect(findPiSessionFile('find-me-123')).toBe(file)
  })

  it('returns null when no file matches', () => {
    expect(findPiSessionFile('nope')).toBeNull()
  })
})

describe('deletePiSession', () => {
  it('unlinks the session file and prunes the now-empty parent dir', async () => {
    const projectDir = join(sessionsRoot(), '--proj-del--')
    const file = writeSessionFile('--proj-del--', '2024-01-01T00-00-00_del-me.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'del-me',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/del'
      }
    ])
    expect(existsSync(file)).toBe(true)

    await deletePiSession('del-me')

    expect(existsSync(file)).toBe(false)
    expect(existsSync(projectDir)).toBe(false)
  })

  it('does not prune the parent dir when other session files remain', async () => {
    const projectDir = join(sessionsRoot(), '--proj-multi--')
    writeSessionFile('--proj-multi--', 'a_keep-me.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'keep-me',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/multi'
      }
    ])
    writeSessionFile('--proj-multi--', 'b_del-me-2.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'del-me-2',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/multi'
      }
    ])

    await deletePiSession('del-me-2')

    expect(existsSync(projectDir)).toBe(true)
    expect(readdirSync(projectDir)).toEqual(['a_keep-me.jsonl'])
  })

  it('resolves without throwing when the session does not exist (best-effort)', async () => {
    await expect(deletePiSession('never-existed')).resolves.toBeUndefined()
  })
})

/**
 * F20 — a pi `custom_message` entry is context an extension injected into the
 * model's prompt. It was dropped entirely, so the transcript disagreed with
 * what the model actually saw.
 */
describe('loadPiSessionHistory — custom_message entries', () => {
  const userEntry = (id: string, parentId: string | null, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user', content: text, timestamp: 1 }
  })

  it('renders a displayed custom_message as a context_note titled by its extension', async () => {
    writeSessionFile('--proj-custom--', 'x_sess-custom.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-custom',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/custom'
      },
      userEntry('u1', null, 'hi'),
      {
        type: 'custom_message',
        id: 'cm1',
        parentId: 'u1',
        timestamp: '2024-01-01T00:00:02.000Z',
        customType: 'my-extension',
        content: 'Injected context the model saw.',
        display: true
      }
    ])
    const { messages } = await loadPiSessionHistory('sess-custom')
    expect(messages.find((m) => m.id === 'cm1')).toMatchObject({
      role: 'system',
      content: [
        {
          type: 'context_note',
          title: 'my-extension',
          fragments: [{ text: 'Injected context the model saw.' }]
        }
      ]
    })
  })

  it('joins the text parts of an array-shaped content and skips image parts', async () => {
    writeSessionFile('--proj-custom2--', 'x_sess-custom2.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-custom2',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/custom2'
      },
      userEntry('u1', null, 'hi'),
      {
        type: 'custom_message',
        id: 'cm2',
        parentId: 'u1',
        timestamp: '2024-01-01T00:00:02.000Z',
        customType: 'ext',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'text', text: 'line two' }
        ],
        display: true
      }
    ])
    const { messages } = await loadPiSessionHistory('sess-custom2')
    expect(messages.find((m) => m.id === 'cm2')).toMatchObject({
      content: [{ type: 'context_note', fragments: [{ text: 'line one\nline two' }] }]
    })
  })

  it('skips a hidden custom_message and one with no text at all', async () => {
    writeSessionFile('--proj-custom3--', 'x_sess-custom3.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-custom3',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/custom3'
      },
      userEntry('u1', null, 'hi'),
      {
        type: 'custom_message',
        id: 'hidden',
        parentId: 'u1',
        timestamp: '2024-01-01T00:00:02.000Z',
        customType: 'ext',
        content: 'not for the user',
        display: false
      },
      {
        type: 'custom_message',
        id: 'blank',
        parentId: 'hidden',
        timestamp: '2024-01-01T00:00:03.000Z',
        customType: 'ext',
        content: '',
        display: true
      }
    ])
    const { messages } = await loadPiSessionHistory('sess-custom3')
    expect(messages.find((m) => m.id === 'hidden')).toBeUndefined()
    expect(messages.find((m) => m.id === 'blank')).toBeUndefined()
  })
})

/**
 * R1b — a pi session this app never ran has no model persisted on our side, so
 * the transcript's own last assistant message is where the reopened session's
 * model comes from.
 */
describe('loadPiSessionHistory — lastModel', () => {
  const userEntry = (id: string, parentId: string | null, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user', content: text, timestamp: 1 }
  })
  const assistantEntry = (id: string, parentId: string, provider: string, model: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2024-01-01T00:00:01.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      api: 'a',
      provider,
      model,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: 2
    }
  })

  it('names the model the LAST assistant message answered on', async () => {
    writeSessionFile('--proj-lm--', 'x_sess-lm.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-lm',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/lm'
      },
      userEntry('u1', null, 'hi'),
      assistantEntry('a1', 'u1', 'openai', 'gpt-old'),
      userEntry('u2', 'a1', 'again'),
      assistantEntry('a2', 'u2', 'alicloud', 'qwen-x')
    ])

    const { lastModel } = await loadPiSessionHistory('sess-lm')
    expect(lastModel).toEqual({ engineId: 'pi', vendorId: 'alicloud', modelId: 'qwen-x' })
  })

  it('names none when no assistant message does', async () => {
    writeSessionFile('--proj-lm2--', 'x_sess-lm2.jsonl', [
      {
        type: 'session',
        version: 3,
        id: 'sess-lm2',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/proj/lm2'
      },
      userEntry('u1', null, 'hi')
    ])

    const { lastModel } = await loadPiSessionHistory('sess-lm2')
    expect(lastModel).toBeNull()
  })
})
