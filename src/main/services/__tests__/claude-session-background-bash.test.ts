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
 *      later task_updated lookup succeeds regardless of tool_result timing,
 *      AND relays `session:task-started` to the renderer — the "this task
 *      is running" signal the async-agent Stop-button fix depends on
 *      (Claude 2.1.219+ makes Agent/Task background-by-default and usually
 *      omits `run_in_background`, so tool input alone can't tell the
 *      renderer whether a task is still running).
 *
 *   3. task_updated with a terminal patch.status drives markBackgroundDone
 *      and emits session:task-notification, which is how the renderer flips
 *      a background bash card from "running" to "done".
 *
 *   4. handleTaskNotification (the task_notification subtype handler, distinct
 *      from task_updated above) falls back to the wire's own `tool_use_id`
 *      when the taskIdMap reverse-lookup misses.
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

  handleTaskStarted(msg: { task_id?: string; tool_use_id?: string; task_type?: string }): void {
    const taskId = msg.task_id || ''
    const toolUseId = msg.tool_use_id || ''
    if (!taskId || !toolUseId) return
    this.taskIdMap.set(taskId, toolUseId)

    this.send('session:task-started', {
      toolUseId,
      taskId,
      taskType: msg.task_type || ''
    })
  }

  handleTaskNotification(msg: {
    task_id?: string
    tool_use_id?: string
    output_file?: string
    status?: string
    summary?: string
    usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number } | null
  }): void {
    const taskId = msg.task_id || ''
    const outputFile = msg.output_file || ''
    // Fallback: the wire's own tool_use_id (docs/protocol-cc/04-system-subtypes.md
    // §4.4) covers the case where the taskIdMap reverse-lookup misses (e.g.
    // task_started never arrived, or the mapping was already evicted).
    const matchedToolUseId = this.taskIdMap.get(taskId) || msg.tool_use_id || null
    if (matchedToolUseId) {
      this.markedDone.push(matchedToolUseId)
      this.taskIdMap.delete(taskId)
    }

    const rawUsage = msg.usage
    const usage = rawUsage
      ? {
          totalTokens: rawUsage.total_tokens || 0,
          toolUses: rawUsage.tool_uses || 0,
          durationMs: rawUsage.duration_ms || 0
        }
      : undefined

    this.send('session:task-notification', {
      taskId,
      toolUseId: matchedToolUseId,
      status: msg.status || 'completed',
      outputFile,
      summary: msg.summary || '',
      usage
    })
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
      usage: undefined
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
        'Command running in background with ID: abc123. Output is being written to: /tmp/abc123.output'
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
        'Command running in background with ID: xyz. Output is being written to: /tmp/xyz.output'
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
      expect(session.sent).toEqual([])
    })

    it('relays session:task-started with taskId/toolUseId/taskType (async-agent Stop-button fix)', () => {
      session.handleTaskStarted({ task_id: 'task-42', tool_use_id: 'tu-42', task_type: 'local_agent' })

      expect(session.sent).toHaveLength(1)
      expect(session.sent[0]).toEqual({
        channel: 'session:task-started',
        args: [{ toolUseId: 'tu-42', taskId: 'task-42', taskType: 'local_agent' }]
      })
    })

    it('defaults taskType to empty string when the wire omits it', () => {
      session.handleTaskStarted({ task_id: 'task-43', tool_use_id: 'tu-43' })

      const payload = session.sent[0].args[0] as { taskType: string }
      expect(payload.taskType).toBe('')
    })
  })

  describe('task_updated (completion)', () => {
    it('marks bg done and emits session:task-notification on completed', () => {
      session.handleTaskStarted({ task_id: 't1', tool_use_id: 'tu-bg' })
      session.backgroundFilePaths.set('tu-bg', '/tmp/bg.output')
      session.sent = [] // discard the task-started emission — only asserting task_updated's own emit here

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
        usage: undefined
      })
    })

    it('normalizes killed → stopped (SDK vocabulary)', () => {
      session.handleTaskStarted({ task_id: 't2', tool_use_id: 'tu-k' })
      session.sent = []

      session.handleTaskUpdated({ task_id: 't2', patch: { status: 'killed' } })

      const payload = session.sent[0].args[0] as { status: string }
      expect(payload.status).toBe('stopped')
    })

    it('forwards failed unchanged', () => {
      session.handleTaskStarted({ task_id: 't3', tool_use_id: 'tu-f' })
      session.sent = []

      session.handleTaskUpdated({ task_id: 't3', patch: { status: 'failed' } })

      const payload = session.sent[0].args[0] as { status: string }
      expect(payload.status).toBe('failed')
    })

    it('ignores non-terminal statuses (running, backgrounded)', () => {
      session.handleTaskStarted({ task_id: 't4', tool_use_id: 'tu-r' })
      session.sent = []

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
      session.sent = []

      session.handleTaskUpdated({ task_id: 't5' })
      session.handleTaskUpdated({ task_id: 't5', patch: {} })

      expect(session.markedDone).toEqual([])
      expect(session.sent).toEqual([])
    })
  })

  describe('task_notification (tool_use_id fallback hardening)', () => {
    it('resolves via taskIdMap when present (normal path)', () => {
      session.handleTaskStarted({ task_id: 'ta1', tool_use_id: 'tu-mapped' })
      session.sent = []

      session.handleTaskNotification({ task_id: 'ta1', status: 'completed' })

      expect(session.markedDone).toEqual(['tu-mapped'])
      expect(session.taskIdMap.has('ta1')).toBe(false)
      expect(session.sent[0].args[0]).toMatchObject({ toolUseId: 'tu-mapped' })
    })

    it('falls back to the wire tool_use_id when the taskIdMap reverse-lookup misses', () => {
      // No handleTaskStarted call — taskIdMap has no entry for 'ta-unmapped'.
      session.handleTaskNotification({
        task_id: 'ta-unmapped',
        tool_use_id: 'tu-from-wire',
        status: 'completed'
      })

      expect(session.markedDone).toEqual(['tu-from-wire'])
      expect(session.sent[0].args[0]).toMatchObject({
        taskId: 'ta-unmapped',
        toolUseId: 'tu-from-wire',
        status: 'completed'
      })
    })

    it('prefers the taskIdMap match over the wire tool_use_id when both are present', () => {
      session.handleTaskStarted({ task_id: 'ta2', tool_use_id: 'tu-authoritative' })
      session.sent = []

      // A stale/mismatched wire tool_use_id must not override the known mapping.
      session.handleTaskNotification({
        task_id: 'ta2',
        tool_use_id: 'tu-stale',
        status: 'completed'
      })

      expect(session.sent[0].args[0]).toMatchObject({ toolUseId: 'tu-authoritative' })
    })

    it('emits toolUseId: null when neither taskIdMap nor the wire has one', () => {
      session.handleTaskNotification({ task_id: 'ta-totally-unknown', status: 'completed' })

      expect(session.markedDone).toEqual([])
      expect(session.sent[0].args[0]).toMatchObject({ toolUseId: null })
    })
  })
})
