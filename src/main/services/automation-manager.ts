import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { v4 as uuid } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Notification, type BrowserWindow } from 'electron'
import { CronExpressionParser } from 'cron-parser'
import { getCliJsPath } from './claude-session'
import { loadClaudePermissions } from './claude-settings'
import { loadSessionHistory } from './session-history'
import { logger } from './logger'
import type { Automation, AutomationRun, ChatMessage, ContentBlock } from '../../shared/types'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const AUTOMATION_DIR = path.join(os.homedir(), '.claude', 'ui', 'automation')
/** @deprecated Legacy single-file storage — migrated to per-file on first load */
const LEGACY_AUTOMATIONS_FILE = path.join(AUTOMATION_DIR, 'automations.json')

function automationFile(id: string): string {
  return path.join(AUTOMATION_DIR, `${id}.json`)
}

function runsDir(automationId: string): string {
  return path.join(AUTOMATION_DIR, 'runs', automationId)
}

function runsIndexFile(automationId: string): string {
  return path.join(runsDir(automationId), 'runs.json')
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
// AutomationManager
// ---------------------------------------------------------------------------

export class AutomationManager {
  private win: BrowserWindow
  private automations: Automation[] = []
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private activeRuns = new Map<string, AbortController>()
  private sessionIds = new Map<string, string>()
  private currentRunIds = new Map<string, string>()
  private processingAutomations = new Set<string>()
  private fileWatcher: fs.FSWatcher | null = null
  private watchDebounce: ReturnType<typeof setTimeout> | null = null
  /** Flag to ignore file-change events triggered by our own writes */
  private suppressWatch = false

  constructor(win: BrowserWindow) {
    this.win = win
  }

  // ---- Persistence --------------------------------------------------------

  load(): void {
    ensureDir(AUTOMATION_DIR)
    this.migrateFromLegacy()
    this.automations = this.readAllFromDisk()
    this.startFileWatcher()
  }

  /** Migrate from legacy single-file automations.json to per-file storage */
  private migrateFromLegacy(): void {
    if (!fs.existsSync(LEGACY_AUTOMATIONS_FILE)) return
    const legacy = readJson<Automation[]>(LEGACY_AUTOMATIONS_FILE)
    if (!legacy || legacy.length === 0) {
      fs.unlinkSync(LEGACY_AUTOMATIONS_FILE)
      return
    }
    this.suppressWatch = true
    for (const auto of legacy) {
      const file = automationFile(auto.id)
      if (!fs.existsSync(file)) {
        writeJson(file, auto)
      }
    }
    fs.unlinkSync(LEGACY_AUTOMATIONS_FILE)
    setTimeout(() => { this.suppressWatch = false }, 100)
    logger.info('AutomationManager', `Migrated ${legacy.length} automation(s) from legacy automations.json`)
  }

  /** Read all {id}.json files from the automation directory */
  private readAllFromDisk(): Automation[] {
    const automations: Automation[] = []
    try {
      for (const entry of fs.readdirSync(AUTOMATION_DIR)) {
        if (!entry.endsWith('.json') || entry === 'automations.json') continue
        const auto = readJson<Automation>(path.join(AUTOMATION_DIR, entry))
        if (auto && auto.id) automations.push(auto)
      }
    } catch (err) {
      logger.warn('AutomationManager', 'Failed to read automation directory', err)
    }
    return automations
  }

  /** Watch the automation directory for external changes (e.g. another app instance) */
  private startFileWatcher(): void {
    if (this.fileWatcher) return

    try {
      this.fileWatcher = fs.watch(AUTOMATION_DIR, (_event, filename) => {
        if (this.suppressWatch) return
        if (!filename || !filename.endsWith('.json') || filename === 'automations.json') return
        if (this.watchDebounce) clearTimeout(this.watchDebounce)
        this.watchDebounce = setTimeout(() => this.reloadFromDisk(), 500)
      })
    } catch (err) {
      logger.warn('AutomationManager', 'Failed to watch automation directory', err)
    }
  }

  /** Reload automations from disk and reconcile with in-memory state */
  private reloadFromDisk(): void {
    const diskAutomations = this.readAllFromDisk()
    const oldIds = new Set(this.automations.map((a) => a.id))
    const newIds = new Set(diskAutomations.map((a) => a.id))

    // Cancel schedules for removed automations
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        this.cancelSchedule(id)
      }
    }

    // Reschedule changed/new automations
    for (const auto of diskAutomations) {
      const old = this.automations.find((a) => a.id === auto.id)
      if (!old || old.enabled !== auto.enabled || old.schedule.cronExpression !== auto.schedule.cronExpression || old.schedule.intervalMs !== auto.schedule.intervalMs) {
        this.cancelSchedule(auto.id)
        if (auto.enabled && !this.activeRuns.has(auto.id)) {
          this.scheduleNext(auto)
        }
      }
    }

    this.automations = diskAutomations
    this.notifyAutomationsChanged()
    logger.info('AutomationManager', `Reloaded ${diskAutomations.length} automation(s) from disk`)
  }

  /** Save a single automation to its own file */
  private saveAutomation(automation: Automation): void {
    this.suppressWatch = true
    writeJson(automationFile(automation.id), automation)
    setTimeout(() => { this.suppressWatch = false }, 100)
  }

  /** Delete a single automation file from disk */
  private deleteAutomationFile(id: string): void {
    this.suppressWatch = true
    const file = automationFile(id)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    setTimeout(() => { this.suppressWatch = false }, 100)
  }

  private loadRuns(automationId: string): AutomationRun[] {
    return readJson<AutomationRun[]>(runsIndexFile(automationId)) ?? []
  }

  private saveRuns(automationId: string, runs: AutomationRun[]): void {
    writeJson(runsIndexFile(automationId), runs)
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
    this.saveAutomation(automation)
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
    this.deleteAutomationFile(id)
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
    this.saveAutomation(auto)
    if (enabled) {
      this.scheduleNext(auto)
    } else {
      this.cancelSchedule(id)
    }
    this.notifyAutomationsChanged()
  }

  /** Check if an automation has an active session (sessionId captured, can send follow-ups) */
  hasActiveSession(id: string): boolean {
    return this.sessionIds.has(id)
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
    // Stop file watcher
    if (this.fileWatcher) {
      this.fileWatcher.close()
      this.fileWatcher = null
    }
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce)
      this.watchDebounce = null
    }
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
    this.sessionIds.delete(id)
    this.currentRunIds.delete(id)
    this.processingAutomations.delete(id)
  }

  /** Mark a specific run as stopped — for runs not managed by this instance
   *  (e.g. started by another app instance, or orphaned after app exit) */
  dismissRun(automationId: string, runId: string): void {
    const runs = this.loadRuns(automationId)
    const run = runs.find((r) => r.id === runId)
    if (!run || run.status !== 'running') return
    run.status = 'error'
    run.error = 'Manually stopped'
    run.finishedAt = run.finishedAt || Date.now()
    this.saveRuns(automationId, runs)
    this.notifyRunUpdate(automationId, run)
  }

  /** Send a follow-up message to a running automation by resuming the SDK session */
  sendMessage(automationId: string, prompt: string): void {
    const sessionId = this.sessionIds.get(automationId)
    if (!sessionId) throw new Error('No active session for this automation')
    if (this.activeRuns.has(automationId)) throw new Error('A turn is already in progress')

    const automation = this.automations.find((a) => a.id === automationId)
    if (!automation) throw new Error(`Automation ${automationId} not found`)

    // Emit user message to renderer for live display
    const userMsg: ChatMessage = {
      id: uuid(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      timestamp: Date.now()
    }
    this.emitRunMessage(automationId, userMsg)

    // Resume the session with a one-shot sdkQuery
    this.runOneShotQuery(automation, prompt, sessionId).catch((err) => {
      logger.error('AutomationManager', `sendMessage failed for ${automationId}: ${err}`)
    })
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
    this.currentRunIds.set(automation.id, runId)

    try {
      const result = await this.runOneShotQuery(automation, automation.prompt)
      run.totalCostUsd += result.costUsd
      run.status = 'success'
      run.resultSummary = result.lastText.slice(0, 200) || undefined
    } catch (err) {
      run.status = 'error'
      run.error = err instanceof Error ? err.message : String(err)
      logger.error('AutomationManager', `Automation "${automation.name}" run error: ${run.error}`)
    } finally {
      run.finishedAt = Date.now()
      this.currentRunIds.delete(automation.id)
      // Keep sessionId alive so user can send follow-up messages

      // Update automation metadata
      automation.lastRunAt = run.startedAt
      automation.lastRunStatus = run.status === 'running' ? 'error' : run.status
      this.saveAutomation(automation)

      // Update run index — merge into the disk entry to preserve fields
      // (like sessionId/projectKey) that were set during runOneShotQuery
      const updatedRuns = this.loadRuns(automation.id)
      const idx = updatedRuns.findIndex((r) => r.id === runId)
      if (idx >= 0) {
        updatedRuns[idx] = { ...updatedRuns[idx], ...run }
      }
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

  /** Run a single one-shot sdkQuery turn. Used for both initial runs and follow-up messages.
   *  If resumeSessionId is provided, resumes an existing session instead of creating a new one. */
  private async runOneShotQuery(
    automation: Automation,
    prompt: string,
    resumeSessionId?: string
  ): Promise<{ costUsd: number; lastText: string }> {
    const abortController = new AbortController()
    this.activeRuns.set(automation.id, abortController)
    this.processingAutomations.add(automation.id)

    let totalCostUsd = 0
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
        prompt,
        options: {
          ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
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

        // Capture session_id from the SDK and persist to run metadata.
        // Always update — each executeRun creates a fresh session with a new id.
        if ('session_id' in msg && msg.session_id && msg.session_id !== this.sessionIds.get(automation.id)) {
          const sid = msg.session_id as string
          this.sessionIds.set(automation.id, sid)
          // Update run metadata with sessionId
          const runId = this.currentRunIds.get(automation.id)
          if (runId) {
            const runsForUpdate = this.loadRuns(automation.id)
            const sidx = runsForUpdate.findIndex((r) => r.id === runId)
            if (sidx >= 0) {
              runsForUpdate[sidx].sessionId = sid
              this.saveRuns(automation.id, runsForUpdate)
            }
          }
        }

        if (type === 'assistant') {
          const chatMsg = this.transformAssistantMessage(msg)
          if (chatMsg) {
            this.emitRunMessage(automation.id, chatMsg)
            lastAssistantMsg = chatMsg
            const textBlock = chatMsg.content.find((b) => b.type === 'text')
            if (textBlock?.text) lastAssistantText = textBlock.text
          }
        } else if (type === 'user') {
          const messageParam = msg.message as Record<string, unknown> | undefined
          if (messageParam && Array.isArray(messageParam.content) && lastAssistantMsg) {
            const toolResults = this.extractToolResults(messageParam.content as Array<Record<string, unknown>>)
            if (toolResults.length > 0) {
              lastAssistantMsg.content.push(...toolResults)
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
          totalCostUsd += costUsd
          this.processingAutomations.delete(automation.id)
          this.emitProcessing(automation.id, false)

          // Update cost in run index and notify renderer with the real run object
          const runId = this.currentRunIds.get(automation.id)
          if (runId) {
            const updatedRuns = this.loadRuns(automation.id)
            const idx = updatedRuns.findIndex((r) => r.id === runId)
            if (idx >= 0) {
              updatedRuns[idx].totalCostUsd = (updatedRuns[idx].totalCostUsd || 0) + costUsd
              this.saveRuns(automation.id, updatedRuns)
              this.notifyRunUpdate(automation.id, updatedRuns[idx])
            }
          }
        }
      }

      return { costUsd: totalCostUsd, lastText: lastAssistantText }
    } finally {
      this.activeRuns.delete(automation.id)
      this.processingAutomations.delete(automation.id)
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

  async loadRunMessages(automationId: string, runId: string): Promise<ChatMessage[]> {
    // Find the run to get sessionId
    const runs = this.loadRuns(automationId)
    const run = runs.find((r) => r.id === runId)
    if (!run) return []

    // New runs have sessionId — find the SDK's project JSONL on disk
    if (run.sessionId) {
      // Always scan filesystem for the correct projectKey — cached values may be
      // stale/wrong due to path normalization differences (e.g. POSIX vs Windows)
      const discoveredKey = this.findProjectKeyForSession(run.sessionId)
      const projectKey = discoveredKey || run.projectKey
      if (projectKey) {
        try {
          const { messages } = await loadSessionHistory(run.sessionId, projectKey)
          // Update cached projectKey if it was missing or wrong
          if (discoveredKey && run.projectKey !== discoveredKey) {
            run.projectKey = discoveredKey
            const allRuns = this.loadRuns(automationId)
            const idx = allRuns.findIndex((r) => r.id === runId)
            if (idx >= 0) {
              allRuns[idx] = { ...run }
              this.saveRuns(automationId, allRuns)
            }
          }
          return messages
        } catch (err) {
          logger.warn('AutomationManager', `Failed to load session history for run ${runId}: ${err}`)
        }
      }
    }

    // Legacy fallback: old runs may have a dedicated JSONL in the automation runs dir
    const legacyFile = path.join(runsDir(automationId), `${runId}.jsonl`)
    if (!fs.existsSync(legacyFile)) return []
    const lines = fs.readFileSync(legacyFile, 'utf-8').split('\n').filter(Boolean)
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

  /** Find the projectKey directory containing a given sessionId JSONL file.
   *  Scans ~/.claude/projects/ since the SDK's path normalization (POSIX on Windows)
   *  makes it unreliable to compute the projectKey from the cwd ourselves. */
  private findProjectKeyForSession(sessionId: string): string | null {
    try {
      if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null
      const jsonlName = `${sessionId}.jsonl`
      for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
        const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, jsonlName)
        if (fs.existsSync(candidate)) return dir
      }
    } catch {
      // ignore scan errors
    }
    return null
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
