/**
 * @vitest-environment node
 *
 * Behavioural tests for background-Bash plumbing in ClaudeSession:
 *
 *   1. watchBackground queues a pending watch when the poller is not yet
 *      registered, and the queued watch is drained the moment
 *      detectTaskMapping creates the poller. This closes the race where the
 *      renderer's tool_use-triggered watch landed before tool_result arrived.
 *
 *   2. task_started pre-registers taskIdMap (task_id ↔ tool_use_id) so the
 *      later task_updated lookup succeeds regardless of tool_result timing.
 *
 *   3. task_updated with a terminal patch.status drives markBackgroundDone
 *      and emits session:task-notification, which is how the renderer flips
 *      a background bash card from "running" to "done".
 *
 * We mirror the real methods into a tiny in-file replica (same approach as
 * claude-session-permissions.test.ts) to avoid pulling Electron / SDK deps.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type SendFn = (channel: string, ...args: unknown[]) => void

interface Poller {
  filePath: string
  lastSize: number
  done: boolean
  interval?: ReturnType<typeof setInterval>
}

const OUTPUT_FILE_RE = /Output is being written to:\s*(.+)/

class TestClaudeSession {
  sent: Array<{ channel: string; args: unknown[] }> = []
  taskIdMap = new Map<string, string>()
  backgroundFilePaths = new Map<string, string>()
  backgroundPollers = new Map<string, Poller>()
  pendingBackgroundWatches = new Set<string>()
  markedDone: string[] = []

  private send: SendFn = (channel, ...args) => {
    this.sent.push({ channel, args })
  }

  watchBackground(toolUseId: string): void {
    const poller = this.backgroundPollers.get(toolUseId)
    if (!poller) {
      this.pendingBackgroundWatches.add(toolUseId)
      return
    }
    if (poller.done) {
      this.send('session:background-output', { toolUseId, tail: '', totalSize: 0, done: true })
      return
    }
    // Normal start-polling path — just record that polling "started" for the test.
    if (!poller.interval) {
      poller.interval = setInterval(() => {}, 500)
    }
    this.send('session:background-output', { toolUseId, tail: '', totalSize: 0, done: false })
  }

  detectTaskMapping(toolUseId: string, resultText: string): void {
    const bgCmdMatch = resultText.match(/Command running in background with ID:\s*([\w-]+)/)
    if (bgCmdMatch) this.taskIdMap.set(bgCmdMatch[1], toolUseId)

    const outputMatch = resultText.match(OUTPUT_FILE_RE)
    if (outputMatch) {
      const filePath = outputMatch[1].trim()
      this.backgroundFilePaths.set(toolUseId, filePath)
      if (!this.backgroundPollers.has(toolUseId)) {
        this.backgroundPollers.set(toolUseId, { filePath, lastSize: 0, done: false })
        if (this.pendingBackgroundWatches.delete(toolUseId)) {
          this.watchBackground(toolUseId)
        }
      }
    }
  }

  handleTaskStarted(msg: { task_id?: string; tool_use_id?: string }): void {
    const taskId = msg.task_id || ''
    const toolUseId = msg.tool_use_id || ''
    if (!taskId || !toolUseId) return
    this.taskIdMap.set(taskId, toolUseId)
  }

  handleTaskUpdated(msg: { task_id?: string; patch?: { status?: string } }): void {
    const taskId = msg.task_id || ''
    const patch = msg.patch
    if (!taskId || !patch || typeof patch.status !== 'string') return

    const status = patch.status
    if (status !== 'completed' && status !== 'killed' && status !== 'failed') return

    const toolUseId = this.taskIdMap.get(taskId) || null
    if (!toolUseId) return

    this.markedDone.push(toolUseId)
    this.taskIdMap.delete(taskId)

    const normalized = status === 'killed' ? 'stopped' : status
    this.send('session:task-notification', {
      taskId,
      toolUseId,
      status: normalized,
      outputFile: this.backgroundFilePaths.get(toolUseId) || '',
      summary: '',
      usage: undefined,
    })
  }
}

describe('ClaudeSession background bash', () => {
  let session: TestClaudeSession

  beforeEach(() => {
    session = new TestClaudeSession()
    vi.useFakeTimers()
  })

  describe('watch/poller race', () => {
    it('queues a pending watch when the poller does not exist yet', () => {
      session.watchBackground('tu-1')

      expect(session.pendingBackgroundWatches.has('tu-1')).toBe(true)
      expect(session.sent).toEqual([])
    })

    it('drains the pending watch when detectTaskMapping later registers the poller', () => {
      session.watchBackground('tu-1')

      session.detectTaskMapping(
        'tu-1',
        'Command running in background with ID: abc123. Output is being written to: /tmp/abc123.output',
      )

      expect(session.pendingBackgroundWatches.has('tu-1')).toBe(false)
      expect(session.backgroundPollers.get('tu-1')?.interval).toBeDefined()
      // watchBackground emits an initial session:background-output on start.
      expect(session.sent).toHaveLength(1)
      expect(session.sent[0].channel).toBe('session:background-output')
      const payload = session.sent[0].args[0] as { toolUseId: string; done: boolean }
      expect(payload.toolUseId).toBe('tu-1')
      expect(payload.done).toBe(false)
    })

    it('does not queue a pending watch when the poller is already registered', () => {
      session.detectTaskMapping(
        'tu-2',
        'Command running in background with ID: xyz. Output is being written to: /tmp/xyz.output',
      )
      session.sent = []

      session.watchBackground('tu-2')

      expect(session.pendingBackgroundWatches.size).toBe(0)
      expect(session.sent).toHaveLength(1)
    })
  })

  describe('task_started', () => {
    it('pre-registers task_id → tool_use_id before tool_result arrives', () => {
      session.handleTaskStarted({ task_id: 'task-42', tool_use_id: 'tu-42' })

      expect(session.taskIdMap.get('task-42')).toBe('tu-42')
    })

    it('ignores messages missing either id', () => {
      session.handleTaskStarted({ task_id: '', tool_use_id: 'tu-x' })
      session.handleTaskStarted({ task_id: 'task-y', tool_use_id: '' })

      expect(session.taskIdMap.size).toBe(0)
    })
  })

  describe('task_updated (completion)', () => {
    it('marks bg done and emits session:task-notification on completed', () => {
      session.handleTaskStarted({ task_id: 't1', tool_use_id: 'tu-bg' })
      session.backgroundFilePaths.set('tu-bg', '/tmp/bg.output')

      session.handleTaskUpdated({ task_id: 't1', patch: { status: 'completed' } })

      expect(session.markedDone).toEqual(['tu-bg'])
      expect(session.taskIdMap.has('t1')).toBe(false)
      expect(session.sent).toHaveLength(1)
      expect(session.sent[0].channel).toBe('session:task-notification')
      expect(session.sent[0].args[0]).toEqual({
        taskId: 't1',
        toolUseId: 'tu-bg',
        status: 'completed',
        outputFile: '/tmp/bg.output',
        summary: '',
        usage: undefined,
      })
    })

    it('normalizes killed → stopped (SDK vocabulary)', () => {
      session.handleTaskStarted({ task_id: 't2', tool_use_id: 'tu-k' })

      session.handleTaskUpdated({ task_id: 't2', patch: { status: 'killed' } })

      const payload = session.sent[0].args[0] as { status: string }
      expect(payload.status).toBe('stopped')
    })

    it('forwards failed unchanged', () => {
      session.handleTaskStarted({ task_id: 't3', tool_use_id: 'tu-f' })

      session.handleTaskUpdated({ task_id: 't3', patch: { status: 'failed' } })

      const payload = session.sent[0].args[0] as { status: string }
      expect(payload.status).toBe('failed')
    })

    it('ignores non-terminal statuses (running, backgrounded)', () => {
      session.handleTaskStarted({ task_id: 't4', tool_use_id: 'tu-r' })

      session.handleTaskUpdated({ task_id: 't4', patch: { status: 'running' } })
      session.handleTaskUpdated({ task_id: 't4', patch: { status: 'backgrounded' } })

      expect(session.markedDone).toEqual([])
      expect(session.sent).toEqual([])
      // Mapping stays in place so the eventual terminal update can resolve it.
      expect(session.taskIdMap.get('t4')).toBe('tu-r')
    })

    it('ignores updates for unknown task_ids (no mapping registered)', () => {
      session.handleTaskUpdated({ task_id: 'unmapped', patch: { status: 'completed' } })

      expect(session.markedDone).toEqual([])
      expect(session.sent).toEqual([])
    })

    it('ignores malformed messages (missing patch or status)', () => {
      session.handleTaskStarted({ task_id: 't5', tool_use_id: 'tu-5' })

      session.handleTaskUpdated({ task_id: 't5' })
      session.handleTaskUpdated({ task_id: 't5', patch: {} })

      expect(session.markedDone).toEqual([])
      expect(session.sent).toEqual([])
    })
  })
})
