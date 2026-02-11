import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { v4 as uuid } from 'uuid'
import { readFile } from 'fs/promises'
import type { BrowserWindow } from 'electron'
import type {
  ChatMessage,
  ContentBlock,
  SessionStatus,
  ApprovalDecision,
  PendingApproval
} from '../../shared/types'
import { parseBackgroundJsonl } from './jsonl-parser'

interface ApprovalResult {
  decision: ApprovalDecision
  answers?: Record<string, string>
}

interface PendingApprovalEntry {
  resolve: (result: ApprovalResult) => void
}

interface BackgroundTaskEntry {
  outputFile: string
  agentId: string
  toolUseId: string
  pollInterval: ReturnType<typeof setInterval>
  lastContent: string
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
const OUTPUT_FILE_RE = /output_file:\s*(\S+)/
const TASK_ID_RE = /task_id:\s*(\S+)/

export class ClaudeSession {
  private sessionId: string | null = null
  private abortController: AbortController | null = null
  private isProcessing = false
  private pendingApprovals = new Map<string, PendingApprovalEntry>()
  private backgroundTasks = new Map<string, BackgroundTaskEntry>()
  private win: BrowserWindow
  private cwd: string
  private totalCostUsd = 0
  private messageChannel: MessageChannel<unknown> | null = null

  constructor(win: BrowserWindow, cwd: string) {
    this.win = win
    this.cwd = cwd
    this.sendStatus()
  }

  get status(): SessionStatus {
    return {
      state: this.isProcessing ? 'running' : 'idle',
      sessionId: this.sessionId,
      model: 'claude-sonnet-4-5-20250929',
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
      console.log('[run] Pushing message to existing channel')
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
      console.log('[run] Starting SDK query in streaming input mode')
      const q = sdkQuery({
        prompt: channel as AsyncIterable<never>,
        options: {
          cwd: this.cwd,
          permissionMode: 'default',
          abortController: this.abortController,
          includePartialMessages: true,
          thinking: { type: 'enabled', budgetTokens: 10000 },
          stderr: (text: string) => {
            // SDK debug output — only log interesting lines
            if (text.includes('streamInput') || text.includes('endInput') || text.includes('result') || text.includes('exit')) {
              console.log(`[SDK stderr] ${text.trim()}`)
            }
          },
          ...(this.sessionId ? { resume: this.sessionId } : {}),
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
            return { behavior: 'deny' as const, message: 'User denied' }
          }
        }
      })

      for await (const message of q) {
        if (!message || typeof message !== 'object') continue

        const msg = message as Record<string, unknown>
        const type = msg.type as string

        // Capture session_id from first message
        if ('session_id' in msg && msg.session_id && !this.sessionId) {
          this.sessionId = msg.session_id as string
          this.sendStatus()
        }

        // Debug: log ALL SDK messages
        if (type === 'stream_event') {
          const evt = (msg.event as Record<string, unknown>)?.type
          console.log(`[SDK msg] type=stream_event event.type=${evt}`)
        } else {
          console.log(`[SDK msg] type=${type} subkeys=[${Object.keys(msg).join(',')}]`, JSON.stringify(msg).substring(0, 500))
        }

        // Any assistant or stream content means we're processing
        if ((type === 'assistant' || type === 'stream_event') && !this.isProcessing) {
          this.isProcessing = true
          this.sendStatus()
        }

        if (type === 'assistant') {
          const chatMsg = this.transformAssistantMessage(msg)
          if (chatMsg) this.send('session:message', chatMsg)
        } else if (type === 'user') {
          await this.handleUserMessage(msg)
        } else if (type === 'stream_event') {
          const event = msg.event as Record<string, unknown> | undefined
          if (event) {
            const eventType = event.type as string
            if (eventType === 'content_block_delta') {
              const delta = event.delta as Record<string, unknown> | undefined
              if (delta) {
                if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                  this.send('session:stream', { type: 'text', text: delta.text })
                } else if (
                  delta.type === 'thinking_delta' &&
                  typeof delta.thinking === 'string'
                ) {
                  this.send('session:stream', { type: 'thinking', text: delta.thinking })
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
          if (subtype === 'task_notification') {
            const taskId = (msg.task_id as string) || ''
            const outputFile = (msg.output_file as string) || ''
            console.log(`[SDK task_notification] taskId=${taskId} status=${msg.status} activeBgTasks=[${[...this.backgroundTasks.keys()].join(',')}]`)

            // Correlate with background task by agentId/taskId
            let matchedToolUseId: string | null = null
            for (const [tuId, entry] of this.backgroundTasks) {
              if (entry.agentId === taskId) {
                matchedToolUseId = tuId
                console.log(`[SDK task_notification] matched toolUseId=${tuId}`)
                // Do a final poll before stopping
                await this.pollBackgroundOutput(tuId)
                clearInterval(entry.pollInterval)
                this.backgroundTasks.delete(tuId)
                break
              }
            }

            if (!matchedToolUseId) {
              console.log(`[SDK task_notification] no match found — task may have been auto-resolved by poll`)
            }

            this.send('session:task-notification', {
              taskId,
              toolUseId: matchedToolUseId,
              status: (msg.status as string) || 'completed',
              outputFile,
              summary: (msg.summary as string) || ''
            })
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
              this.send('session:error', errors.join('; '))
            }
          }

          this.send('session:result', {
            totalCostUsd: this.totalCostUsd,
            durationMs: (msg.duration_ms as number) || 0,
            result: (msg.result as string) || ''
          })
          this.sendStatus()
          console.log(`[run] Result received (subtype=${subtype}), isProcessing=false, loop continues waiting for more messages`)
        }
      }
      console.log('[run] for-await loop ended (SDK generator completed — CLI process exited)')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[run] catch: ${errorMsg}`)
      if (!errorMsg.includes('abort')) {
        this.send('session:error', errorMsg)
      }
    } finally {
      console.log(`[run] finally: cleaning up session (bgTasks=${this.backgroundTasks.size})`)
      this.messageChannel?.end()
      this.messageChannel = null
      this.abortController = null
      this.isProcessing = false
      this.sendStatus()
    }
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

    // Stop all background task polling
    this.clearBackgroundPolling()

    // End the message channel before aborting so the SDK's streamInput
    // loop can unblock and the CLI subprocess exits cleanly
    this.messageChannel?.end()
    this.abortController?.abort()
    this.abortController = null
    this.isProcessing = false
    this.sendStatus()
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

    const content = messageParam.content

    // Case 1: Array content — extract tool_result blocks
    if (Array.isArray(content)) {
      this.extractToolResultsFromContent(content)
      return
    }

    // Case 2: String content — check for task notification
    if (typeof content === 'string' && content.includes('<task-notification>')) {
      await this.handleTaskNotificationUserMessage(msg, content)
    }
  }

  private extractToolResultsFromContent(content: Array<Record<string, unknown>>): void {
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

      // Detect background task launch patterns
      this.detectBackgroundTask(toolUseId, resultText)

      this.send('session:tool-result', {
        toolUseId,
        result: resultText,
        isError: !!(b.is_error)
      })
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

    console.log(`[task-notification user msg] taskId=${taskId} status=${status} summary=${summary}`)

    if (taskId) {
      // Correlate with background task by agentId
      let matchedToolUseId: string | null = null
      for (const [tuId, entry] of this.backgroundTasks) {
        if (entry.agentId === taskId) {
          matchedToolUseId = tuId
          console.log(`[task-notification user msg] matched toolUseId=${tuId}`)
          // Do a final poll before stopping
          await this.pollBackgroundOutput(tuId)
          clearInterval(entry.pollInterval)
          this.backgroundTasks.delete(tuId)
          break
        }
      }

      this.send('session:task-notification', {
        taskId,
        toolUseId: matchedToolUseId,
        status,
        outputFile,
        summary
      })
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

  private detectBackgroundTask(toolUseId: string, resultText: string): void {
    const outputMatch = resultText.match(OUTPUT_FILE_RE)
    if (!outputMatch) return

    const outputFile = outputMatch[1]
    const agentMatch = resultText.match(AGENT_ID_RE)
    const taskIdMatch = resultText.match(TASK_ID_RE)
    const agentId = agentMatch?.[1] || taskIdMatch?.[1] || ''

    if (!agentId) return

    console.log(`[detectBackgroundTask] toolUseId=${toolUseId} agentId=${agentId} outputFile=${outputFile}`)
    // Notify renderer this is a background task
    this.send('session:background-task-started', { toolUseId, outputFile, agentId })

    // Start polling the output file
    const entry: BackgroundTaskEntry = {
      outputFile,
      agentId,
      toolUseId,
      lastContent: '',
      pollInterval: setInterval(() => this.pollBackgroundOutput(toolUseId), 2000)
    }
    this.backgroundTasks.set(toolUseId, entry)

    // Also do an immediate poll
    this.pollBackgroundOutput(toolUseId)
  }

  private async pollBackgroundOutput(toolUseId: string): Promise<void> {
    const entry = this.backgroundTasks.get(toolUseId)
    if (!entry) return

    try {
      const content = await readFile(entry.outputFile, 'utf-8')
      if (content !== entry.lastContent) {
        entry.lastContent = content
        const parsed = parseBackgroundJsonl(content)
        this.send('session:background-output', {
          toolUseId,
          messages: parsed.messages,
          outputFile: entry.outputFile
        })
      }
    } catch {
      // File may not exist yet — that's fine
    }
  }

  private clearBackgroundPolling(): void {
    for (const [, entry] of this.backgroundTasks) {
      clearInterval(entry.pollInterval)
    }
    this.backgroundTasks.clear()
  }

  private send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, data)
    }
  }

  private sendStatus(): void {
    this.send('session:status', this.status)
  }
}
