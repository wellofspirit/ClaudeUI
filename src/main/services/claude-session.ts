import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { v4 as uuid } from 'uuid'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { BrowserWindow } from 'electron'
import type {
  ChatMessage,
  ContentBlock,
  SessionStatus,
  ApprovalDecision,
  PendingApproval
} from '../../shared/types'

interface ApprovalResult {
  decision: ApprovalDecision
  answers?: Record<string, string>
}

interface PendingApprovalEntry {
  resolve: (result: ApprovalResult) => void
}

/**
 * Push-based async iterable for feeding user messages into the SDK's
 * streaming input mode. This keeps the CLI subprocess alive so background
 * agents can report back via task_notification.
 */
class MessageChannel<T> {
  private queue: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | null = null
  private isDone = false

  push(msg: T): void {
    if (this.isDone) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: msg, done: false })
    } else {
      this.queue.push(msg)
    }
  }

  end(): void {
    this.isDone = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false }
    }
    if (this.isDone) {
      return { value: undefined as T, done: true }
    }
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

const AGENT_ID_RE = /agentId:\s*(\S+)/
const TASK_ID_RE = /task_id:\s*(\S+)/
const BG_CMD_ID_RE = /Command running in background with ID:\s*([\w-]+)/
const OUTPUT_FILE_RE = /Output is being written to:\s*(.+)/

const TAIL_SIZE = 64 * 1024

interface BackgroundPoller {
  interval?: ReturnType<typeof setInterval>
  filePath: string
  lastSize: number
  done: boolean
}

export class ClaudeSession {
  private sessionId: string | null = null
  private abortController: AbortController | null = null
  private isProcessing = false
  private pendingApprovals = new Map<string, PendingApprovalEntry>()
  private taskIdMap = new Map<string, string>() // agentId → toolUseId
  private backgroundFilePaths = new Map<string, string>() // toolUseId → filePath (permanent)
  private backgroundPollers = new Map<string, BackgroundPoller>() // toolUseId → poller state
  private win: BrowserWindow
  readonly routingId: string
  private cwd: string
  private totalCostUsd = 0
  private messageChannel: MessageChannel<unknown> | null = null
  private activeQuery: {
    setPermissionMode(mode: string): Promise<void>
    setModel(model?: string): Promise<void>
    stopTask(taskId: string): Promise<void>
  } | null = null
  private slug: string | null = null
  private permissionMode: string = 'default'
  private effort: string
  private model: string = 'default'
  private resumeSessionId: string | undefined

  constructor(routingId: string, win: BrowserWindow, cwd: string, effort?: string, resumeSessionId?: string) {
    this.routingId = routingId
    this.win = win
    this.cwd = cwd
    this.effort = effort || 'medium'
    this.resumeSessionId = resumeSessionId
    this.sendStatus()
  }

  get status(): SessionStatus {
    return {
      state: this.isProcessing ? 'running' : 'idle',
      sessionId: this.sessionId,
      model: this.model,
      cwd: this.cwd,
      totalCostUsd: this.totalCostUsd
    }
  }

  async run(prompt: string): Promise<void> {
    this.isProcessing = true
    this.sendStatus()

    // SDK streaming input format — must match SDKUserMessage type
    // (session_id and parent_tool_use_id are required by the CLI parser)
    const sdkMessage = {
      type: 'user' as const,
      session_id: this.sessionId || '',
      message: { role: 'user' as const, content: prompt },
      parent_tool_use_id: null
    }

    if (this.messageChannel) {
      // Session already active — push to existing channel
      this.messageChannel.push(sdkMessage)
      return
    }

    // First run — start persistent session with streaming input mode.
    // Passing an AsyncIterable (instead of a string) keeps the CLI subprocess
    // alive so background agents can report back via task_notification.
    const channel = new MessageChannel<unknown>()
    this.messageChannel = channel
    channel.push(sdkMessage)
    this.abortController = new AbortController()

    try {
      const q = sdkQuery({
        prompt: channel as AsyncIterable<never>,
        options: {
          cwd: this.cwd,
          model: this.model,
          permissionMode: this.permissionMode as 'default',
          abortController: this.abortController,
          includePartialMessages: true,
          thinking: { type: 'enabled', budgetTokens: 10000 },
          effort: this.effort as 'low' | 'medium' | 'high',
          stderr: (chunk) => {
            // Log SDK stderr to help debug issues
            const text = chunk.toString().trim()
            if (text) console.error('[SDK stderr]', text)
          },
          ...(this.resumeSessionId ? { resume: this.resumeSessionId } : this.sessionId ? { resume: this.sessionId } : {}),
          canUseTool: async (toolName, input, opts) => {
            const requestId = uuid()
            const approval: PendingApproval = { requestId, toolName, input }
            this.send('session:approval-request', approval)

            const { decision, answers } = await new Promise<ApprovalResult>((resolve) => {
              this.pendingApprovals.set(requestId, { resolve })

              opts.signal.addEventListener('abort', () => {
                this.pendingApprovals.delete(requestId)
                resolve({ decision: 'deny' })
              })
            })

            this.pendingApprovals.delete(requestId)

            if (decision === 'allow') {
              const updatedInput = answers ? { ...input, answers } : input
              return { behavior: 'allow' as const, updatedInput }
            }
            const message = answers?.feedback || 'User denied'
            return { behavior: 'deny' as const, message }
          }
        }
      })

      this.activeQuery = q as unknown as {
        setPermissionMode(mode: string): Promise<void>
        setModel(model?: string): Promise<void>
        stopTask(taskId: string): Promise<void>
      }

      for await (const message of q) {
        if (!message || typeof message !== 'object') continue

        const msg = message as Record<string, unknown>
        const type = msg.type as string

        // Capture session_id from first message
        if ('session_id' in msg && msg.session_id && !this.sessionId) {
          this.sessionId = msg.session_id as string
          this.sendStatus()
        }

        // Capture slug for plan file resolution
        if ('slug' in msg && msg.slug && !this.slug) {
          this.slug = msg.slug as string
        }


        // Any assistant or stream content means we're processing
        if ((type === 'assistant' || type === 'stream_event') && !this.isProcessing) {
          this.isProcessing = true
          this.sendStatus()
        }

        if (type === 'assistant') {
          const parentToolUseId = msg.parent_tool_use_id as string | undefined
          const chatMsg = this.transformAssistantMessage(msg)
          if (chatMsg) {
            if (parentToolUseId) {
              this.send('session:subagent-message', { toolUseId: parentToolUseId, message: chatMsg })
            } else {
              this.send('session:message', chatMsg)
            }
          }
        } else if (type === 'user') {
          await this.handleUserMessage(msg)
        } else if (type === 'stream_event') {
          const parentToolUseId = msg.parent_tool_use_id as string | undefined
          const event = msg.event as Record<string, unknown> | undefined
          if (event) {
            const eventType = event.type as string
            if (eventType === 'content_block_delta') {
              const delta = event.delta as Record<string, unknown> | undefined
              if (delta) {
                if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                  if (parentToolUseId) {
                    this.send('session:subagent-stream', { toolUseId: parentToolUseId, type: 'text', text: delta.text })
                  } else {
                    this.send('session:stream', { type: 'text', text: delta.text })
                  }
                } else if (
                  delta.type === 'thinking_delta' &&
                  typeof delta.thinking === 'string'
                ) {
                  if (parentToolUseId) {
                    this.send('session:subagent-stream', { toolUseId: parentToolUseId, type: 'thinking', text: delta.thinking })
                  } else {
                    this.send('session:stream', { type: 'thinking', text: delta.thinking })
                  }
                }
              }
            }
          }
        } else if (type === 'tool_progress') {
          this.send('session:task-progress', {
            toolUseId: (msg.tool_use_id as string) || '',
            toolName: (msg.tool_name as string) || '',
            parentToolUseId: (msg.parent_tool_use_id as string) || null,
            elapsedTimeSeconds: (msg.elapsed_time_seconds as number) || 0
          })
        } else if (type === 'system') {
          const subtype = msg.subtype as string | undefined
          if (subtype === 'status') {
            const newMode = msg.permissionMode as string | undefined
            if (newMode && newMode !== this.permissionMode) {
              this.permissionMode = newMode
              this.send('session:permission-mode', newMode)
            }
          } else if (subtype === 'task_notification') {
            const taskId = (msg.task_id as string) || ''
            const outputFile = (msg.output_file as string) || ''
            // Correlate with task by agentId
            const matchedToolUseId = this.taskIdMap.get(taskId) || null
            if (matchedToolUseId) {
              this.markBackgroundDone(matchedToolUseId)
              this.taskIdMap.delete(taskId)
            }

            // Extract usage from the patched system message (task-notification-usage patch)
            const rawUsage = msg.usage as { total_tokens?: number; tool_uses?: number; duration_ms?: number } | null
            const usage = rawUsage ? {
              totalTokens: rawUsage.total_tokens || 0,
              toolUses: rawUsage.tool_uses || 0,
              durationMs: rawUsage.duration_ms || 0
            } : undefined

            const sysNotification = {
              taskId,
              toolUseId: matchedToolUseId,
              status: (msg.status as string) || 'completed',
              outputFile,
              summary: (msg.summary as string) || '',
              usage
            }
            this.send('session:task-notification', sysNotification)
          }
        } else if (type === 'control_response') {
          const response = msg.response as Record<string, unknown> | undefined
          if (response) {
            const subtype = response.subtype as string
            if (subtype === 'error') {
              console.error('[ClaudeSession] Control response error:', response.error)
            }
          }
        } else if (type === 'result') {
          const cost = (msg.total_cost_usd as number) || 0
          this.totalCostUsd += cost
          this.isProcessing = false

          // Handle error results
          const subtype = msg.subtype as string | undefined
          if (subtype && subtype !== 'success') {
            const errors = (msg.errors as string[]) || []
            if (errors.length) {
              console.error('[ClaudeSession] Result error:', errors.join('; '))
              this.send('session:error', errors.join('; '))
            }
          }

          this.send('session:result', {
            totalCostUsd: this.totalCostUsd,
            durationMs: (msg.duration_ms as number) || 0,
            result: (msg.result as string) || ''
          })
          this.sendStatus()
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      console.error('[ClaudeSession] SDK error:', errorMsg)
      if (stack) {
        console.error('[ClaudeSession] Stack:', stack)
      }
      if (!errorMsg.includes('abort')) {
        this.send('session:error', stack || errorMsg)
      }
    } finally {
      this.messageChannel?.end()
      this.messageChannel = null
      this.activeQuery = null
      this.abortController = null
      this.isProcessing = false
      this.sendStatus()
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode
    this.send('session:permission-mode', mode)
    if (this.activeQuery) {
      await this.activeQuery.setPermissionMode(mode)
    }
  }

  async setModel(model: string): Promise<void> {
    this.model = model
    if (this.activeQuery) {
      await this.activeQuery.setModel(model)
    }
  }

  setEffort(effort: string): void {
    this.effort = effort
  }

  getSessionLogPath(): string | null {
    if (!this.sessionId) return null
    // Project key is derived from cwd by replacing / with -
    const projectKey = this.cwd.replace(/\//g, '-')
    return path.join(os.homedir(), '.claude', 'projects', projectKey, `${this.sessionId}.jsonl`)
  }

  getPlanContent(): string | null {
    const plansDir = path.join(os.homedir(), '.claude', 'plans')

    // Try slug-based lookup first
    if (this.slug) {
      const planPath = path.join(plansDir, `${this.slug}.md`)
      try {
        return fs.readFileSync(planPath, 'utf-8')
      } catch {
        // Fall through to mtime-based lookup
      }
    }

    // Fallback: find the most recently modified .md file in plans dir
    try {
      const files = fs.readdirSync(plansDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const full = path.join(plansDir, f)
          return { path: full, mtime: fs.statSync(full).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)

      if (files.length > 0) {
        return fs.readFileSync(files[0].path, 'utf-8')
      }
    } catch {
      // Plans directory doesn't exist or is unreadable
    }

    return null
  }

  resolveApproval(requestId: string, decision: ApprovalDecision, answers?: Record<string, string>): void {
    const entry = this.pendingApprovals.get(requestId)
    if (entry) {
      entry.resolve({ decision, answers })
    }
  }

  cancel(): void {
    // Deny all pending approvals
    for (const [, entry] of this.pendingApprovals) {
      entry.resolve({ decision: 'deny' })
    }
    this.pendingApprovals.clear()

    this.stopAllBackgroundPollers()

    // End the message channel before aborting so the SDK's streamInput
    // loop can unblock and the CLI subprocess exits cleanly
    this.messageChannel?.end()
    this.abortController?.abort()
    this.abortController = null
    this.isProcessing = false
    this.sendStatus()
  }

  async stopTask(toolUseId: string): Promise<{ success: boolean; error?: string }> {
    // Reverse lookup: toolUseId → task_id
    let taskId: string | null = null
    for (const [tid, tuid] of this.taskIdMap.entries()) {
      if (tuid === toolUseId) {
        taskId = tid
        break
      }
    }

    if (!taskId) {
      return { success: false, error: 'Task ID not found. Task may not be a background task.' }
    }

    if (!this.activeQuery) {
      return { success: false, error: 'No active session' }
    }

    try {
      await this.activeQuery.stopTask(taskId)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  private transformAssistantMessage(msg: Record<string, unknown>): ChatMessage | null {
    const betaMessage = msg.message as Record<string, unknown> | undefined
    if (!betaMessage) return null

    const content = betaMessage.content as Array<Record<string, unknown>> | undefined
    if (!content || !Array.isArray(content)) return null

    const blocks: ContentBlock[] = content.map((block) => {
      const blockType = block.type as string
      if (blockType === 'text') {
        return { type: 'text' as const, text: block.text as string }
      } else if (blockType === 'tool_use') {
        return {
          type: 'tool_use' as const,
          toolName: block.name as string,
          toolInput: block.input as Record<string, unknown>,
          toolUseId: block.id as string
        }
      } else if (blockType === 'tool_result') {
        const resultContent = block.content
        let text = ''
        if (typeof resultContent === 'string') {
          text = resultContent
        } else if (Array.isArray(resultContent)) {
          text = resultContent
            .map((c: Record<string, unknown>) => (c.text as string) || '')
            .join('\n')
        }
        return {
          type: 'tool_result' as const,
          toolUseId: block.tool_use_id as string,
          toolResult: text,
          isError: block.is_error as boolean
        }
      } else if (blockType === 'thinking') {
        return { type: 'thinking' as const, text: block.thinking as string }
      }
      return { type: 'text' as const, text: JSON.stringify(block) }
    })

    // Use the BetaMessage id for deduplication of partial messages
    const messageId = (betaMessage.id as string) || (msg.uuid as string) || uuid()

    return {
      id: messageId,
      role: 'assistant',
      content: blocks,
      timestamp: Date.now()
    }
  }

  /**
   * Handle SDK user messages. Two cases:
   *
   * 1. Array content with tool_result blocks → extract tool results (normal flow)
   * 2. String content with <task-notification> XML → background agent completed.
   *    The SDK injects this as a synthetic user message so the model can respond.
   *    We parse the notification, resolve the background task, and insert the
   *    message into the conversation so the assistant's response has context.
   */
  private async handleUserMessage(msg: Record<string, unknown>): Promise<void> {
    const messageParam = msg.message as Record<string, unknown> | undefined
    if (!messageParam) return

    const parentToolUseId = msg.parent_tool_use_id as string | undefined
    const content = messageParam.content

    // Case 1: Array content — extract tool_result blocks
    if (Array.isArray(content)) {
      this.extractToolResultsFromContent(content, parentToolUseId)
      return
    }

    // Case 2: String content — check for task notification
    if (typeof content === 'string' && content.includes('<task-notification>')) {
      await this.handleTaskNotificationUserMessage(msg, content)
    }
  }

  private extractToolResultsFromContent(
    content: Array<Record<string, unknown>>,
    parentToolUseId?: string
  ): void {
    for (const block of content) {
      if (typeof block !== 'object' || !block) continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_result') continue

      const toolUseId = b.tool_use_id as string
      if (!toolUseId) continue

      let resultText = ''
      const blockContent = b.content
      if (typeof blockContent === 'string') {
        resultText = blockContent
      } else if (Array.isArray(blockContent)) {
        resultText = blockContent
          .map((c: Record<string, unknown>) => (c.text as string) || '')
          .join('\n')
      }

      // Record agentId→toolUseId mapping for task notifications
      if (!parentToolUseId) {
        this.detectTaskMapping(toolUseId, resultText)
      }

      if (parentToolUseId) {
        this.send('session:subagent-tool-result', {
          toolUseId: parentToolUseId,
          toolResultToolUseId: toolUseId,
          result: resultText,
          isError: !!(b.is_error)
        })
      } else {
        this.send('session:tool-result', {
          toolUseId,
          result: resultText,
          isError: !!(b.is_error)
        })
      }
    }
  }

  /**
   * When a background agent completes, the SDK injects a user message with
   * <task-notification> XML (see session log line 12 of 45d85f49-...).
   * We parse it to resolve the background task and insert the message
   * into the conversation.
   */
  private async handleTaskNotificationUserMessage(
    msg: Record<string, unknown>,
    content: string
  ): Promise<void> {
    const taskId = this.extractXmlTag(content, 'task-id')
    const status = this.extractXmlTag(content, 'status') || 'completed'
    const summary = this.extractXmlTag(content, 'summary') || ''
    const outputFile = ''

    // Extract <usage> block if present (background agents include this on completion)
    const usageBlock = this.extractXmlTag(content, 'usage')
    let usage: { totalTokens: number; toolUses: number; durationMs: number } | undefined
    if (usageBlock) {
      const getNum = (key: string): number => {
        const m = usageBlock.match(new RegExp(`${key}:\\s*(\\d+)`))
        return m ? Number(m[1]) : 0
      }
      usage = {
        totalTokens: getNum('total_tokens'),
        toolUses: getNum('tool_uses'),
        durationMs: getNum('duration_ms')
      }
    }

    if (taskId) {
      const matchedToolUseId = this.taskIdMap.get(taskId) || null
      if (matchedToolUseId) {
        this.markBackgroundDone(matchedToolUseId)
        this.taskIdMap.delete(taskId)
      }

      const notification = {
        taskId,
        toolUseId: matchedToolUseId,
        status,
        outputFile,
        summary,
        usage
      }
      this.send('session:task-notification', notification)
    }

    // Insert the synthetic user message into the conversation so the
    // assistant's response (which follows) has visible context
    const chatMsg: ChatMessage = {
      id: (msg.uuid as string) || uuid(),
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now()
    }
    this.send('session:message', chatMsg)
  }

  private extractXmlTag(xml: string, tag: string): string | null {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
    const match = xml.match(re)
    return match ? match[1].trim() : null
  }

  private detectTaskMapping(toolUseId: string, resultText: string): void {
    const agentMatch = resultText.match(AGENT_ID_RE)
    const taskIdMatch = resultText.match(TASK_ID_RE)
    const bgCmdMatch = resultText.match(BG_CMD_ID_RE)
    const agentId = agentMatch?.[1] || taskIdMatch?.[1] || bgCmdMatch?.[1] || ''

    if (agentId) {
      this.taskIdMap.set(agentId, toolUseId)
    }

    // Record output file path for background commands (permanent — survives completion).
    // This works for both Task tools (with agentId) and background Bash (may lack agentId).
    const outputMatch = resultText.match(OUTPUT_FILE_RE)
    if (outputMatch) {
      const filePath = outputMatch[1].trim()
      this.backgroundFilePaths.set(toolUseId, filePath)
      // Create dormant poller entry (no interval until watched)
      if (!this.backgroundPollers.has(toolUseId)) {
        this.backgroundPollers.set(toolUseId, { filePath, lastSize: 0, done: false })
      }
    }
  }

  /** Read the last TAIL_SIZE bytes from a file, returning { tail, totalSize } */
  private readTail(filePath: string): { tail: string; totalSize: number } {
    try {
      const stat = fs.statSync(filePath)
      const totalSize = stat.size
      if (totalSize <= TAIL_SIZE) {
        return { tail: fs.readFileSync(filePath, 'utf-8'), totalSize }
      }
      // Read only the last TAIL_SIZE bytes
      const fd = fs.openSync(filePath, 'r')
      try {
        const buf = Buffer.alloc(TAIL_SIZE)
        fs.readSync(fd, buf, 0, TAIL_SIZE, totalSize - TAIL_SIZE)
        return { tail: buf.toString('utf-8'), totalSize }
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return { tail: '', totalSize: 0 }
    }
  }

  watchBackground(toolUseId: string): void {
    const poller = this.backgroundPollers.get(toolUseId)
    if (!poller) return

    if (poller.done) {
      // Task already finished — single tail read, send with done: true
      const { tail, totalSize } = this.readTail(poller.filePath)
      this.send('session:background-output', { toolUseId, tail, totalSize, done: true })
      return
    }

    // Always send current tail immediately (even if already polling from another watcher)
    const { tail, totalSize } = this.readTail(poller.filePath)
    if (totalSize > 0) {
      poller.lastSize = totalSize
      this.send('session:background-output', { toolUseId, tail, totalSize, done: false })
    }

    // Start polling if not already active
    if (poller.interval) return
    poller.interval = setInterval(() => {
      this.pollBackgroundFile(toolUseId)
    }, 500)
  }

  unwatchBackground(toolUseId: string): void {
    const poller = this.backgroundPollers.get(toolUseId)
    if (!poller) return
    if (poller.interval) {
      clearInterval(poller.interval)
      poller.interval = undefined
    }
  }

  readBackgroundRange(toolUseId: string, offset: number, length: number): string {
    const filePath = this.backgroundFilePaths.get(toolUseId)
    if (!filePath) return ''
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        const buf = Buffer.alloc(length)
        const bytesRead = fs.readSync(fd, buf, 0, length, offset)
        return buf.toString('utf-8', 0, bytesRead)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return ''
    }
  }

  private pollBackgroundFile(toolUseId: string): void {
    const poller = this.backgroundPollers.get(toolUseId)
    if (!poller) return

    try {
      const stat = fs.statSync(poller.filePath)
      if (stat.size <= poller.lastSize) return
      poller.lastSize = stat.size

      const { tail, totalSize } = this.readTail(poller.filePath)
      this.send('session:background-output', { toolUseId, tail, totalSize, done: false })
    } catch {
      // File may not exist yet — ignore
    }
  }

  private markBackgroundDone(toolUseId: string): void {
    const poller = this.backgroundPollers.get(toolUseId)
    if (!poller) return

    poller.done = true
    if (poller.interval) {
      // User is watching — do final read and stop
      clearInterval(poller.interval)
      poller.interval = undefined
      const { tail, totalSize } = this.readTail(poller.filePath)
      this.send('session:background-output', { toolUseId, tail, totalSize, done: true })
    }
    // If dormant (user not watching), just mark done — next watchBackground will do single read
  }

  private stopAllBackgroundPollers(): void {
    this.backgroundPollers.forEach((poller) => {
      if (poller.interval) clearInterval(poller.interval)
    })
    this.backgroundPollers.clear()
    this.backgroundFilePaths.clear()
  }

  private send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, { routingId: this.routingId, data })
    }
  }

  private sendStatus(): void {
    this.send('session:status', this.status)
  }
}
