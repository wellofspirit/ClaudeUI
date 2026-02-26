import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { v4 as uuid } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Notification, type BrowserWindow } from 'electron'
import { CronExpressionParser } from 'cron-parser'
import { getCliJsPath } from './claude-session'
import { loadClaudePermissions } from './claude-settings'
import { logger } from './logger'
import type { Automation, AutomationRun, ChatMessage, ContentBlock } from '../../shared/types'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const AUTOMATION_DIR = path.join(os.homedir(), '.claude', 'ui', 'automation')
const AUTOMATIONS_FILE = path.join(AUTOMATION_DIR, 'automations.json')

function runsDir(automationId: string): string {
  return path.join(AUTOMATION_DIR, 'runs', automationId)
}

function runsIndexFile(automationId: string): string {
  return path.join(runsDir(automationId), 'runs.json')
}

function runJsonlFile(automationId: string, runId: string): string {
  return path.join(runsDir(automationId), `${runId}.jsonl`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch (err) {
    logger.warn('AutomationManager', `Failed to read ${filePath}`, err)
    return null
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
}

/**
 * Simple glob-style pattern matching for permission rules.
 * Supports trailing * wildcards (e.g., "Bash(command:git*)", "Read", "Edit(src/**)").
 */
function matchesPattern(pattern: string, toolStr: string): boolean {
  // Exact match
  if (pattern === toolStr) return true
  // Trailing wildcard: "Bash(command:git*)" matches "Bash(command:git status)"
  if (pattern.endsWith('*')) {
    return toolStr.startsWith(pattern.slice(0, -1))
  }
  // Tool-name-only pattern: "Bash" matches "Bash(command:...)"
  if (!pattern.includes('(') && toolStr.startsWith(pattern + '(')) return true
  return false
}

function formatToolStr(toolName: string, input: Record<string, unknown>): string {
  // Format like "Bash(command:git status)" or "Read(file_path:/foo/bar)"
  const entries = Object.entries(input)
  if (entries.length === 0) return toolName
  const firstEntry = entries[0]
  return `${toolName}(${firstEntry[0]}:${String(firstEntry[1])})`
}

// ---------------------------------------------------------------------------
// MessageChannel — push-based async iterable for SDK streaming input
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AutomationManager
// ---------------------------------------------------------------------------

export class AutomationManager {
  private win: BrowserWindow
  private automations: Automation[] = []
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private activeRuns = new Map<string, AbortController>()
  private channels = new Map<string, MessageChannel<unknown>>()
  private sessionIds = new Map<string, string>()
  private currentRunIds = new Map<string, string>()
  private processingAutomations = new Set<string>()

  constructor(win: BrowserWindow) {
    this.win = win
  }

  // ---- Persistence --------------------------------------------------------

  load(): void {
    ensureDir(AUTOMATION_DIR)
    this.automations = readJson<Automation[]>(AUTOMATIONS_FILE) ?? []
  }

  private save(): void {
    writeJson(AUTOMATIONS_FILE, this.automations)
  }

  private loadRuns(automationId: string): AutomationRun[] {
    return readJson<AutomationRun[]>(runsIndexFile(automationId)) ?? []
  }

  private saveRuns(automationId: string, runs: AutomationRun[]): void {
    writeJson(runsIndexFile(automationId), runs)
  }

  private appendMessageToLog(automationId: string, runId: string, msg: ChatMessage): void {
    const logFile = runJsonlFile(automationId, runId)
    ensureDir(path.dirname(logFile))
    fs.appendFileSync(logFile, JSON.stringify(msg) + '\n')
  }

  // ---- CRUD ---------------------------------------------------------------

  list(): Automation[] {
    return this.automations
  }

  upsert(automation: Automation): void {
    const idx = this.automations.findIndex((a) => a.id === automation.id)
    if (idx >= 0) {
      this.automations[idx] = automation
    } else {
      this.automations.push(automation)
    }
    this.save()
    // Reschedule if enabled
    this.cancelSchedule(automation.id)
    if (automation.enabled) {
      this.scheduleNext(automation)
    }
    this.notifyAutomationsChanged()
  }

  delete(id: string): void {
    this.cancelSchedule(id)
    // Abort active run if any
    this.cancelRun(id)
    this.automations = this.automations.filter((a) => a.id !== id)
    this.save()
    // Clean up run history on disk
    const dir = runsDir(id)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    this.notifyAutomationsChanged()
  }

  toggle(id: string, enabled: boolean): void {
    const auto = this.automations.find((a) => a.id === id)
    if (!auto) return
    auto.enabled = enabled
    this.save()
    if (enabled) {
      this.scheduleNext(auto)
    } else {
      this.cancelSchedule(id)
    }
    this.notifyAutomationsChanged()
  }

  /** Check if an automation has an active channel (running session) */
  hasActiveSession(id: string): boolean {
    return this.channels.has(id)
  }

  // ---- Scheduling ---------------------------------------------------------

  startAll(): void {
    for (const auto of this.automations) {
      if (auto.enabled) {
        this.scheduleNext(auto)
      }
    }
    logger.info('AutomationManager', `Started ${this.automations.filter((a) => a.enabled).length} automation(s)`)
  }

  stopAll(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    for (const [id] of this.activeRuns) {
      this.cancelRun(id)
    }
    logger.info('AutomationManager', 'Stopped all automations')
  }

  private scheduleNext(automation: Automation): void {
    this.cancelSchedule(automation.id)

    let delayMs: number

    if (automation.schedule.type === 'cron' && automation.schedule.cronExpression) {
      try {
        const expr = CronExpressionParser.parse(automation.schedule.cronExpression)
        const nextDate = expr.next().toDate()
        delayMs = nextDate.getTime() - Date.now()
        if (delayMs < 0) delayMs = 0
      } catch (err) {
        logger.warn('AutomationManager', `Invalid cron expression for ${automation.name}: ${err}`)
        return
      }
    } else if (automation.schedule.type === 'interval' && automation.schedule.intervalMs) {
      delayMs = automation.schedule.intervalMs
    } else {
      logger.warn('AutomationManager', `No valid schedule for automation ${automation.name}`)
      return
    }

    const timer = setTimeout(() => {
      this.timers.delete(automation.id)
      // Skip if a run is already active for this automation
      if (this.activeRuns.has(automation.id)) {
        logger.info('AutomationManager', `Skipping ${automation.name}: previous run still active`)
        this.scheduleNext(automation)
        return
      }
      this.executeRun(automation).catch((err) => {
        logger.error('AutomationManager', `Run failed for ${automation.name}: ${err}`)
      })
    }, delayMs)

    this.timers.set(automation.id, timer)
  }

  private cancelSchedule(id: string): void {
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
  }

  // ---- Execution ----------------------------------------------------------

  async runNow(id: string): Promise<void> {
    const auto = this.automations.find((a) => a.id === id)
    if (!auto) throw new Error(`Automation ${id} not found`)
    if (this.activeRuns.has(id)) {
      logger.info('AutomationManager', `${auto.name} already running, skipping manual trigger`)
      return
    }
    await this.executeRun(auto)
  }

  cancelRun(id: string): void {
    this.activeRuns.get(id)?.abort()
    this.channels.get(id)?.end()
    this.channels.delete(id)
    this.sessionIds.delete(id)
    this.currentRunIds.delete(id)
    this.processingAutomations.delete(id)
  }

  sendMessage(automationId: string, prompt: string): void {
    const channel = this.channels.get(automationId)
    if (!channel) throw new Error('No active session for this automation')
    const sessionId = this.sessionIds.get(automationId) || ''
    const sdkMessage = {
      type: 'user' as const,
      session_id: sessionId,
      message: { role: 'user' as const, content: prompt },
      parent_tool_use_id: null
    }
    channel.push(sdkMessage)
    this.processingAutomations.add(automationId)
    this.emitProcessing(automationId, true)

    // Log the user message to JSONL and emit to renderer
    const runId = this.currentRunIds.get(automationId)
    if (runId) {
      const userMsg: ChatMessage = {
        id: uuid(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: Date.now()
      }
      this.appendMessageToLog(automationId, runId, userMsg)
      this.emitRunMessage(automationId, userMsg)
    }
  }

  private emitRunMessage(automationId: string, message: ChatMessage): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('automation:run-message', { automationId, message })
    }
  }

  private emitStreamEvent(automationId: string, type: string, text: string): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('automation:stream-event', { automationId, type, text })
    }
  }

  private emitProcessing(automationId: string, isProcessing: boolean): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('automation:processing', { automationId, isProcessing })
    }
  }

  private async executeRun(automation: Automation): Promise<void> {
    const runId = uuid()
    const run: AutomationRun = {
      id: runId,
      automationId: automation.id,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      totalCostUsd: 0,
      error: undefined,
      resultSummary: undefined
    }

    // Persist initial run state
    const runs = this.loadRuns(automation.id)
    runs.unshift(run)
    this.saveRuns(automation.id, runs)
    this.notifyRunUpdate(automation.id, run)

    const abortController = new AbortController()
    this.activeRuns.set(automation.id, abortController)
    this.currentRunIds.set(automation.id, runId)
    this.processingAutomations.add(automation.id)

    // Create MessageChannel for persistent session
    const channel = new MessageChannel<unknown>()
    this.channels.set(automation.id, channel)

    // Push the initial prompt as an SDK user message
    const sdkMessage = {
      type: 'user' as const,
      session_id: '',
      message: { role: 'user' as const, content: automation.prompt },
      parent_tool_use_id: null
    }
    channel.push(sdkMessage)

    let lastAssistantText = ''
    let lastAssistantMsg: ChatMessage | null = null

    try {
      const cliPath = getCliJsPath()

      // Build canUseTool from merged permissions (user + project + local, same as main chat)
      const userPerms = loadClaudePermissions('user')
      const projectPerms = automation.cwd ? loadClaudePermissions('project', automation.cwd) : { allow: [], deny: [] }
      const localPerms = automation.cwd ? loadClaudePermissions('local', automation.cwd) : { allow: [], deny: [] }
      const mergedPerms = {
        allow: [...userPerms.allow, ...projectPerms.allow, ...localPerms.allow],
        deny: [...userPerms.deny, ...projectPerms.deny, ...localPerms.deny]
      }
      const canUseTool = this.buildCanUseTool(automation, mergedPerms)

      const q = sdkQuery({
        prompt: channel as AsyncIterable<never>,
        options: {
          ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
          cwd: automation.cwd,
          model: automation.model || 'default',
          permissionMode: 'default' as const,
          settingSources: ['user', 'project', 'local'],
          abortController,
          includePartialMessages: true,
          thinking: { type: 'enabled', budgetTokens: 10000 },
          effort: (automation.effort as 'low' | 'medium' | 'high') || 'medium',
          canUseTool
        }
      })

      for await (const message of q) {
        if (!message || typeof message !== 'object') continue
        const msg = message as Record<string, unknown>
        const type = msg.type as string

        // Capture session_id from first message
        if ('session_id' in msg && msg.session_id && !this.sessionIds.has(automation.id)) {
          this.sessionIds.set(automation.id, msg.session_id as string)
        }

        if (type === 'assistant') {
          const chatMsg = this.transformAssistantMessage(msg)
          if (chatMsg) {
            this.appendMessageToLog(automation.id, runId, chatMsg)
            this.emitRunMessage(automation.id, chatMsg)
            lastAssistantMsg = chatMsg
            // Track last assistant text for summary
            const textBlock = chatMsg.content.find((b) => b.type === 'text')
            if (textBlock?.text) lastAssistantText = textBlock.text
          }
        } else if (type === 'user') {
          // Extract tool_result blocks from user messages and attach to last assistant message
          const messageParam = msg.message as Record<string, unknown> | undefined
          if (messageParam && Array.isArray(messageParam.content) && lastAssistantMsg) {
            const toolResults = this.extractToolResults(messageParam.content as Array<Record<string, unknown>>)
            if (toolResults.length > 0) {
              lastAssistantMsg.content.push(...toolResults)
              // Re-emit the updated assistant message (renderer upserts by id)
              this.appendMessageToLog(automation.id, runId, lastAssistantMsg)
              this.emitRunMessage(automation.id, lastAssistantMsg)
            }
          }
        } else if (type === 'stream_event') {
          const event = msg.event as Record<string, unknown> | undefined
          if (event) {
            const eventType = event.type as string
            if (eventType === 'content_block_delta') {
              const delta = event.delta as Record<string, unknown> | undefined
              if (delta) {
                if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                  this.emitStreamEvent(automation.id, 'text', delta.text)
                } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                  this.emitStreamEvent(automation.id, 'thinking', delta.thinking)
                }
              }
            }
          }
        } else if (type === 'result') {
          const costUsd = (msg.cost_usd as number) || (msg.totalCostUsd as number) || 0
          run.totalCostUsd += costUsd
          this.processingAutomations.delete(automation.id)

          // Update cost in run index
          const updatedRuns = this.loadRuns(automation.id)
          const idx = updatedRuns.findIndex((r) => r.id === runId)
          if (idx >= 0) {
            updatedRuns[idx] = { ...run }
            this.saveRuns(automation.id, updatedRuns)
          }
          // Notify cost update and that this turn is done (processing = false)
          this.emitProcessing(automation.id, false)
          this.notifyRunUpdate(automation.id, run)
        }
      }

      run.status = 'success'
      run.resultSummary = lastAssistantText.slice(0, 200) || undefined
    } catch (err) {
      run.status = 'error'
      run.error = err instanceof Error ? err.message : String(err)
      logger.error('AutomationManager', `Automation "${automation.name}" run error: ${run.error}`)
    } finally {
      run.finishedAt = Date.now()
      this.activeRuns.delete(automation.id)
      this.channels.delete(automation.id)
      this.sessionIds.delete(automation.id)
      this.currentRunIds.delete(automation.id)
      this.processingAutomations.delete(automation.id)

      // Update automation metadata
      automation.lastRunAt = run.startedAt
      automation.lastRunStatus = run.status === 'running' ? 'error' : run.status
      this.save()

      // Update run index
      const updatedRuns = this.loadRuns(automation.id)
      const idx = updatedRuns.findIndex((r) => r.id === runId)
      if (idx >= 0) updatedRuns[idx] = run
      this.saveRuns(automation.id, updatedRuns)

      // Notify renderer
      this.notifyRunUpdate(automation.id, run)
      this.notifyAutomationsChanged()

      // Native notification
      this.sendNativeNotification(automation, run)

      // Schedule next run if still enabled
      const current = this.automations.find((a) => a.id === automation.id)
      if (current?.enabled) {
        this.scheduleNext(current)
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildCanUseTool(
    automation: Automation,
    globalPerms: { allow: string[]; deny: string[] }
  ): any {
    const allowPatterns = [...globalPerms.allow, ...automation.permissions.allow]
    const denyPatterns = [...globalPerms.deny, ...automation.permissions.deny]

    return async (toolName: string, input: Record<string, unknown>) => {
      const toolStr = formatToolStr(toolName, input)

      // Check deny first (higher priority)
      for (const pattern of denyPatterns) {
        if (matchesPattern(pattern, toolStr) || matchesPattern(pattern, toolName)) {
          return { behavior: 'deny', message: `Denied by automation rule: ${pattern}` }
        }
      }

      // Check allow
      for (const pattern of allowPatterns) {
        if (matchesPattern(pattern, toolStr) || matchesPattern(pattern, toolName)) {
          return { behavior: 'allow', updatedInput: input }
        }
      }

      // Default: deny (headless — no user to ask)
      return { behavior: 'deny', message: 'Tool not in automation allow list' }
    }
  }

  // ---- Message Transform --------------------------------------------------

  private transformAssistantMessage(msg: Record<string, unknown>): ChatMessage | null {
    const betaMessage = msg.message as Record<string, unknown> | undefined
    if (!betaMessage) return null

    const id = (betaMessage.id as string) || uuid()
    const rawContent = betaMessage.content as Array<Record<string, unknown>> | undefined
    if (!rawContent || !Array.isArray(rawContent)) return null

    const content: ContentBlock[] = rawContent.map((block) => {
      const blockType = block.type as string
      if (blockType === 'text') {
        return { type: 'text' as const, text: (block.text as string) || '' }
      } else if (blockType === 'tool_use') {
        return {
          type: 'tool_use' as const,
          toolName: (block.name as string) || '',
          toolInput: (block.input as Record<string, unknown>) || {},
          toolUseId: (block.id as string) || ''
        }
      } else if (blockType === 'thinking') {
        return { type: 'thinking' as const, text: (block.thinking as string) || '' }
      }
      return { type: 'text' as const, text: '' }
    }).filter((b) => b.text !== '' || b.type !== 'text')

    return { id, role: 'assistant', content, timestamp: Date.now() }
  }

  private extractToolResults(content: Array<Record<string, unknown>>): ContentBlock[] {
    const results: ContentBlock[] = []
    for (const block of content) {
      if (typeof block !== 'object' || !block || block.type !== 'tool_result') continue
      const toolUseId = block.tool_use_id as string
      if (!toolUseId) continue

      let resultText = ''
      const blockContent = block.content
      if (typeof blockContent === 'string') {
        resultText = blockContent
      } else if (Array.isArray(blockContent)) {
        resultText = blockContent
          .map((c: Record<string, unknown>) => (c.text as string) || '')
          .join('\n')
      }

      results.push({
        type: 'tool_result',
        toolUseId,
        toolResult: resultText,
        isError: !!(block.is_error)
      })
    }
    return results
  }

  // ---- Run History --------------------------------------------------------

  listRuns(automationId: string): AutomationRun[] {
    return this.loadRuns(automationId)
  }

  loadRunMessages(automationId: string, runId: string): ChatMessage[] {
    const logFile = runJsonlFile(automationId, runId)
    if (!fs.existsSync(logFile)) return []
    const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean)
    const messages: ChatMessage[] = []
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as ChatMessage)
      } catch {
        // skip malformed lines
      }
    }
    return messages
  }

  // ---- Notifications ------------------------------------------------------

  private notifyRunUpdate(automationId: string, run: AutomationRun): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('automation:run-update', { automationId, run })
    }
  }

  private notifyAutomationsChanged(): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('automation:changed', this.automations)
    }
  }

  private sendNativeNotification(automation: Automation, run: AutomationRun): void {
    try {
      const status = run.status === 'success' ? 'completed' : 'failed'
      const summary = run.resultSummary ? `\n${run.resultSummary}` : ''
      new Notification({
        title: `Automation ${status}: ${automation.name}`,
        body: run.error || summary || `Finished in ${((run.finishedAt! - run.startedAt) / 1000).toFixed(0)}s`,
        silent: false
      }).show()
    } catch (err) {
      logger.warn('AutomationManager', 'Failed to show notification', err)
    }
  }
}
