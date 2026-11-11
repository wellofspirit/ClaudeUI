/**
 * @vitest-environment node
 *
 * M-CL5 regression for subagent-watcher: fs.watch emits an async 'error' on
 * Windows when the watched agent JSONL is deleted. Without an 'error' listener
 * that became an uncaughtException, and the dead entry kept
 * `watched.has(toolUseId)` true so re-watching was blocked.
 *
 * fs is real EXCEPT for `watch`, which is faked with a controllable
 * EventEmitter so the 'error' path is deterministic. All the discovery/parse
 * I/O runs against a real temp agent file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

class FakeWatcher extends EventEmitter {
  closed = false
  close(): void {
    this.closed = true
  }
}

const { testHome, created, watchMock } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watcher-err-'))
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  return { testHome: dir, created: [] as EventEmitter[], watchMock: vi.fn() }
})

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, watch: watchMock }
})
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { watchSubagent, unwatchSubagent } from '../subagent-watcher'

const PROMPT = 'Investigate the flaky login test and report the root cause'

async function seedAgentFile(projectKey: string, sessionId: string): Promise<void> {
  const dir = path.join(testHome, '.claude', 'projects', projectKey, sessionId, 'subagents')
  await fsp.mkdir(dir, { recursive: true })
  const line = JSON.stringify({ type: 'user', message: { content: PROMPT } })
  await fsp.writeFile(path.join(dir, 'agent-abc123.jsonl'), line + '\n')
}

describe('subagent-watcher fs.watch error handling (M-CL5)', () => {
  beforeEach(() => {
    created.length = 0
    watchMock.mockReset()
    watchMock.mockImplementation(() => {
      const w = new FakeWatcher()
      created.push(w)
      return w
    })
  })

  it("removes the dead watcher on 'error' so re-watch succeeds and error does not throw", async () => {
    const projectKey = '-p-' + Math.random().toString(36).slice(2, 8)
    const sessionId = 's-' + Math.random().toString(36).slice(2, 8)
    await seedAgentFile(projectKey, sessionId)

    watchSubagent('tool-1', sessionId, projectKey, PROMPT, vi.fn())
    expect(watchMock).toHaveBeenCalledTimes(1)
    const first = created[0] as FakeWatcher

    expect(() => first.emit('error', new Error('EPERM: watch failed'))).not.toThrow()
    expect(first.closed).toBe(true)

    // Re-watch the same toolUseId — the has() guard no longer blocks.
    watchSubagent('tool-1', sessionId, projectKey, PROMPT, vi.fn())
    expect(watchMock).toHaveBeenCalledTimes(2)

    unwatchSubagent('tool-1')
  })
})
