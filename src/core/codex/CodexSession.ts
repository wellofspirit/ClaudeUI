import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { HostWindowHandle } from '../host'
import { BaseSession } from '../providers/BaseSession'
import type { EngineSpawnOptions } from '../providers/ISession'
import type {
  ApprovalDecision,
  FileDiff,
  PendingApproval,
  PermissionSuggestion,
  SessionStatus,
  ChatMessage,
  MeteringSnapshot
} from '../../shared/types'
import type {
  CodexApprovalDecision,
  CodexSessionState,
  CodexSettings
} from '../../shared/codex-types'
import { mergeContentBlocks } from '../../shared/content-blocks'
import { isImageMediaType } from '../../shared/types'
import { parseCodexSettings, savedCodexOverrides, codexSandboxPolicy } from './settings'
import type { AskForApproval } from './protocol/v2/AskForApproval'
import type { ApprovalsReviewer } from './protocol/v2/ApprovalsReviewer'
import type { SandboxMode } from './protocol/v2/SandboxMode'
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy'
import {
  decideWithSource,
  mergedClaudeRulesFor,
  normalizeWhitespace,
  sessionAllowKey,
  type PermissionDecision,
  PI_TOOL_TO_CLAUDE_TOOL,
  PLAN_MODE_DENY_REASON
} from '../pi/permission-engine'
import { persistAllowSuggestions } from '../opencode/permission-compiler'
import type { ThreadSettings } from './protocol/v2/ThreadSettings'
import type { ThreadTokenUsage } from './protocol/v2/ThreadTokenUsage'
import { resolveCodexCapabilities } from '../../shared/model-capabilities'
import { CodexClient } from './CodexClient'
import type { CodexClientOptions, CodexTransportError } from './CodexAppServerClient'
import type { Model } from './protocol/v2/Model'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import type { Turn } from './protocol/v2/Turn'
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams'
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams'
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams'
import { assertCodexProvider, selectCodexModel } from './model-selection'
import { codexItemId, mapCodexDelta, mapCodexItem, type CodexMappedEvent } from './event-mapper'
import { BashStreamGate } from '../opencode/bash-stream-gate'
import {
  setSessionMeta,
  getCodexSessionOverrides,
  setCodexSessionOverrides,
  ensureCodexSessionOverrides
} from '../services/db'

const serverMethods = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval'
] as const
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

type Pending = {
  turnId: string
  choices: CodexApprovalDecision[]
  questions?: ToolRequestUserInputParams['questions']
  /** `sessionAllows` keys to add when a human answers `allowForSession`. */
  allowKeys: string[]
  settle: (value?: unknown) => void
}

/** One gated action inside a native request — one command, or one changed file. */
type Gated = { tool: string; input: Record<string, unknown>; path?: string }

/**
 * Per-turn native policy. Codex EXECUTES, ClaudeUI DECIDES (ADR-066 slice 3):
 * every turn but `auto` runs `untrusted`, the one policy the pinned binary asks
 * before running anything (docs/codex-spike.md, "Native approval surface probe"
 * answer B), so every command and file change arrives as a server request for
 * ClaudeUI's own permission engine to answer. `auto` is the exception — it hands
 * review to Codex's native `auto_review` subagent under `on-request`, and only
 * what that subagent escalates reaches us, gated exactly like `default`.
 *
 * The sandbox is the containment floor, not the decision: an ACCEPTED command
 * runs unsandboxed on this wire regardless (same probe, "Other observations").
 */
const TURN_POLICY: Record<
  string,
  { approvalPolicy: AskForApproval; sandbox: SandboxMode; approvalsReviewer: ApprovalsReviewer }
> = {
  plan: { approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' },
  default: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user' },
  acceptEdits: {
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    approvalsReviewer: 'user'
  },
  auto: {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    approvalsReviewer: 'auto_review'
  }
}

/** One root owns one one-shot client. No native queue, child adoption, or hosted tools. */
export class CodexSession extends BaseSession {
  readonly engineId = 'codex' as const
  readonly capabilities = resolveCodexCapabilities()
  private readonly client: CodexClient
  private readonly generation = randomUUID()
  private starting?: Promise<void>
  private closed = false
  private busy = false
  private sending = false
  private interruptRequested = false
  private settingsUpdating = false
  private deltas = new Map<string, ChatMessage>()
  private threadId: string | null = null
  private turnId: string | null = null
  private endedTurns = new Set<string>()
  private completedItems = new Map<string, string>()
  private catalog: Model[] = []
  private model?: string
  private effectiveModel?: string
  private effort?: string
  private native?: CodexSessionState
  private overrides: CodexSettings = {}
  private account: SessionStatus['account'] = null
  private permissionMode: string
  /** "Allow for this session" clicks, in the shared engine's key vocabulary. */
  private sessionAllows = new Set<string>()
  private pending = new Map<string, Pending>()
  private output = new Map<string, string>()
  private bashGate = new BashStreamGate((toolUseId, output) =>
    this.send('session:bash-output', { toolUseId, output })
  )

  constructor(
    routingId: string,
    win: HostWindowHandle | null,
    cwd: string,
    private readonly options: EngineSpawnOptions = {},
    transport: Pick<CodexClientOptions, 'env' | 'requestTimeoutMs' | 'killGraceMs'> = {},
    createClient: (options: CodexClientOptions) => CodexClient = (options) =>
      new CodexClient(options)
  ) {
    super(routingId, win, cwd)
    this.model = options.model
    this.effort = options.effort
    this.permissionMode = options.permissionMode ?? 'default'
    this.client = createClient({
      ...transport,
      cwd,
      serverMethods,
      onNotification: (method, params) => this.notification(method, params),
      onServerRequest: (method, params, context) => this.requestApproval(method, params, context),
      onDisconnect: (error) => this.disconnected(error)
    })
  }

  get willQueue(): boolean {
    return this.busy || this.sending || this.settingsUpdating
  }
  getSessionId(): string | null {
    return this.threadId
  }

  override enqueuePrompt(): void {
    throw new Error('Codex application queue is not implemented')
  }

  async run(
    prompt: string | null,
    attachments?: Array<{ mediaType: string; base64Data: string }>,
    clientUserMessageId = `msg-${randomUUID()}`
  ): Promise<void> {
    if (this.closed) throw new Error('Codex session is disconnected')
    if (
      attachments?.some(
        (attachment) =>
          !isImageMediaType(attachment.mediaType) ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.base64Data)
      )
    )
      throw new Error('Codex accepts inline PNG/JPEG/GIF/WebP image attachments only')
    if (this.willQueue && prompt !== null)
      throw new Error('Codex turn is already running; queue and steer are not implemented')
    if (prompt !== null) {
      this.sending = true
      this.clearInactivityTimer()
      this.status('running')
    }
    try {
      if (!this.starting) this.starting = this.start()
      await this.starting
      if (this.closed) throw new Error('Codex session is disconnected')
      if (prompt === null) return
      this.busy = true
      this.clearInactivityTimer()
      this.status('running')
      const result = await this.client.request('turn/start', {
        threadId: this.threadId!,
        clientUserMessageId,
        input: [
          { type: 'text', text: prompt, text_elements: [] },
          ...(attachments ?? []).map((attachment) => ({
            type: 'image' as const,
            url: `data:${attachment.mediaType};base64,${attachment.base64Data}`
          }))
        ],
        ...(this.model !== undefined ? { model: this.model } : {}),
        ...(this.effort !== undefined ? { effort: this.effort } : {}),
        ...this.turnPolicy()
      })
      if (this.closed) return
      if (!this.endedTurns.has(result.turn.id)) this.turnId = result.turn.id
      if (this.interruptRequested && this.turnId) await this.interrupt()
      if (result.turn.status !== 'inProgress') this.finishTurn(result.turn)
      // Native clientId reconciles the core-minted row with the persisted native item.
    } catch (error) {
      // A failed/ambiguous start must never become an automatic retry or native queued turn.
      if (!this.closed) {
        this.send('session:error', error instanceof Error ? error.message : 'Codex turn failed')
        this.dispose()
      }
      throw error
    } finally {
      if (prompt !== null) this.sending = false
    }
  }

  private async start(): Promise<void> {
    try {
      if (this.options.forkSession || this.options.resumeSessionAt)
        throw new Error('Codex fork is not implemented')
      const saved = this.options.resumeSessionId
        ? savedCodexOverrides(getCodexSessionOverrides(this.options.resumeSessionId))
        : {}
      this.overrides = { ...saved }
      if (this.model !== undefined) this.overrides.model = this.model
      else this.model = saved.model
      if (this.effort !== undefined) this.overrides.effort = this.effort
      else this.effort = saved.effort
      await this.client.start({
        clientInfo: { name: 'claudeui_session', title: 'Codex session', version: '1' },
        capabilities: { experimentalApi: true, requestAttestation: false }
      })
      const { config } = await this.client.request('config/read', {
        cwd: this.cwd,
        includeLayers: false
      })
      assertCodexProvider(config.model_provider)
      const account = (await this.client.request('account/read', { refreshToken: false })).account
      if (account?.type === 'chatgpt' || account?.type === 'apiKey')
        this.account = {
          engineId: 'codex',
          vendorId: 'openai',
          authState: 'authenticated',
          billingType: account.type === 'chatgpt' ? 'subscription' : 'apiKey'
        }
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; ; page++) {
        if (page === 100) throw new Error('Codex catalog page limit')
        const result = await this.client.request('model/list', {
          cursor,
          limit: 100,
          includeHidden: false
        })
        this.catalog.push(...result.data)
        if (!result.nextCursor) break
        if (cursors.has(result.nextCursor)) throw new Error('Codex repeated catalog cursor')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      this.model =
        this.options.resumeSessionId && this.model === undefined
          ? undefined
          : selectCodexModel(this.catalog, config.model, this.model)
      this.validateEffort(this.effort)
      // The thread BASELINE must agree with the per-turn override, so a turn
      // that somehow starts without one (native queue, a future steer path)
      // still runs under this mode's policy rather than the user's config.
      const { approvalPolicy, sandbox, approvalsReviewer } = this.modePolicy()
      const params = {
        cwd: this.cwd,
        ...(this.model !== undefined ? { model: this.model } : {}),
        approvalPolicy,
        sandbox,
        approvalsReviewer
      }
      const response = this.options.resumeSessionId
        ? await this.client.request('thread/resume', {
            ...params,
            threadId: this.options.resumeSessionId
          })
        : await this.client.request('thread/start', {
            ...params,
            allowProviderModelFallback: false,
            historyMode: 'paginated'
          })
      if (this.closed) return
      assertCodexProvider(response.modelProvider)
      if (this.options.resumeSessionId && response.thread.id !== this.options.resumeSessionId)
        throw new Error('Codex resumed a different native thread')
      if (response.thread.parentThreadId)
        throw new Error('Native child threads must be controlled by their owning root')
      if (this.model !== undefined && response.model !== this.model)
        throw new Error('Codex silently changed the requested model')
      this.threadId = response.thread.id
      this.model = response.model
      this.effectiveModel = response.model
      this.capabilities.vision =
        this.catalog
          .find((entry) => entry.model === this.model)
          ?.inputModalities?.includes('image') ?? false
      this.native = {
        modelProvider: response.modelProvider,
        reasoningEffort: response.reasoningEffort,
        effortOptions: this.effortOptions()
      }
      this.capabilities.reasoning = { nativeEffort: { options: this.native.effortOptions } }
      setSessionMeta(this.threadId, {
        engineId: 'codex',
        model: { engineId: 'codex', vendorId: response.modelProvider, modelId: response.model }
      })
      ensureCodexSessionOverrides(this.threadId)
      this.status('idle')
      if (this.effort !== undefined)
        await this.client.request('thread/settings/update', {
          threadId: this.threadId,
          effort: this.effort
        })
      setCodexSessionOverrides(this.threadId, this.overrides)
      this.resetInactivityTimer()
    } catch (error) {
      if (!this.closed) {
        this.send('session:error', error instanceof Error ? error.message : 'Codex startup failed')
        this.dispose()
      }
      throw error
    }
  }

  private effortOptions(): Array<{ value: string; description: string }> {
    return (
      this.catalog
        .find((entry) => entry.model === this.model)
        ?.supportedReasoningEfforts.map((option) => ({
          value: option.reasoningEffort,
          description: option.description
        })) ?? []
    )
  }

  private validateEffort(effort?: string): void {
    const options = this.effortOptions()
    if (
      effort !== undefined &&
      options.length &&
      !options.some((option) => option.value === effort)
    )
      throw new Error('Codex reasoning effort is unavailable for the selected model')
  }

  async setModel(model: string): Promise<void> {
    await this.setCodexSettings({ model })
  }

  /**
   * The single funnel both native settings writes take — `setModel` and
   * `setEffort` are the only callers, and the only channels that reach them are
   * the engine-neutral `session:set-model` / `session:set-effort`.
   */
  async setCodexSettings(value: CodexSettings): Promise<void> {
    const settings = parseCodexSettings(value)
    if (!this.starting) {
      if (settings.model !== undefined) this.model = settings.model
      if (settings.effort !== undefined) this.effort = settings.effort
      this.starting = this.start()
    }
    await this.starting
    if (this.closed) throw new Error('Codex session is disconnected')
    if (this.settingsUpdating) throw new Error('Codex settings update is already pending')
    if (settings.model !== undefined) selectCodexModel(this.catalog, undefined, settings.model)
    const model = this.catalog.find((entry) => entry.model === (settings.model ?? this.model))
    if (
      settings.effort !== undefined &&
      model &&
      !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === settings.effort)
    )
      throw new Error('Codex effort is unavailable for this model')
    this.settingsUpdating = true
    this.clearInactivityTimer()
    this.status('running')
    try {
      await this.client.request('thread/settings/update', {
        threadId: this.threadId!,
        ...settings
      })
      if (this.closed) throw new Error('Codex disconnected before settings could be saved')
      if (settings.model !== undefined) this.model = settings.model
      if (settings.effort !== undefined) this.effort = settings.effort
      const accepted = { ...this.overrides, ...settings }
      try {
        setCodexSessionOverrides(this.threadId!, accepted)
      } catch {
        throw new Error('Native settings were applied but could not be saved for reconnect')
      }
      this.overrides = accepted
      if (settings.model !== undefined)
        setSessionMeta(this.threadId!, {
          engineId: 'codex',
          model: {
            engineId: 'codex',
            vendorId: this.native!.modelProvider,
            modelId: settings.model
          }
        })
    } finally {
      this.settingsUpdating = false
      if (!this.closed) {
        this.status(this.busy ? 'running' : 'idle')
        if (!this.busy) this.resetInactivityTimer()
      }
    }
  }

  setEffort(effort: string): Promise<void> {
    this.validateEffort(effort)
    return this.setCodexSettings({ effort })
  }

  /**
   * Applies from the NEXT turn. A live turn is not re-policied mid-flight:
   * `turn/steer` is not implemented, and `thread/settings/update` acknowledges
   * out of band (docs/codex-spike.md answer F), so retro-fitting the running
   * turn would leave the mode and the in-flight approvals disagreeing.
   */
  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode
    this.send('session:permission-mode', mode)
  }

  /** The native policy this session's shared mode maps onto. Unknown modes fail toward asking. */
  private modePolicy(): (typeof TURN_POLICY)[string] {
    return TURN_POLICY[this.permissionMode] ?? TURN_POLICY.default
  }

  private turnPolicy(): {
    approvalPolicy: AskForApproval
    sandboxPolicy: SandboxPolicy
    approvalsReviewer: ApprovalsReviewer
  } {
    const { approvalPolicy, sandbox, approvalsReviewer } = this.modePolicy()
    return { approvalPolicy, sandboxPolicy: codexSandboxPolicy(sandbox), approvalsReviewer }
  }

  async interrupt(): Promise<void> {
    if (this.sending && !this.threadId) {
      this.dispose()
      return
    }
    if (this.willQueue) this.interruptRequested = true
    if (this.threadId && this.turnId && !this.closed)
      try {
        this.interruptRequested = false
        await this.client.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.turnId
        })
      } catch (error) {
        this.dispose()
        throw error
      }
  }

  cancel(): void {
    this.dispose()
  }
  dispose(): void {
    if (this.closed) return
    this.disconnected()
    this.client.dispose()
  }

  private disconnected(error?: CodexTransportError): void {
    if (this.closed) return
    this.closed = true
    this.busy = false
    this.sending = false
    this.turnId = null
    this.clearInactivityTimer()
    this.bashGate.cancelAll()
    this.output.clear()
    for (const pending of [...this.pending.values()]) pending.settle()
    if (error && error.code !== 'disposed') this.send('session:error', error.message)
    this.status('disconnected')
  }

  private status(state: SessionStatus['state']): void {
    if (state === 'idle' && this.settingsUpdating) state = 'running'
    this.send('session:status', {
      ...this.baseStatusFields(),
      state,
      sessionId: this.threadId,
      model:
        this.effectiveModel && this.native
          ? { engineId: 'codex', vendorId: this.native.modelProvider, modelId: this.effectiveModel }
          : null,
      cwd: this.cwd,
      totalCostUsd: 0,
      account: this.account,
      ...(this.native ? { codex: { ...this.native, overrides: { ...this.overrides } } } : {})
    } satisfies SessionStatus)
  }

  private notification(method: string, value: unknown): void {
    if (this.closed || !record(value) || value.threadId !== this.threadId || !this.threadId) return
    if (method === 'turn/started' && record(value.turn) && typeof value.turn.id === 'string') {
      if (this.endedTurns.has(value.turn.id)) return
      this.turnId = value.turn.id
      this.busy = true
      this.status('running')
      if (this.interruptRequested) void this.interrupt().catch(() => {})
    } else if (method === 'thread/settings/updated' && record(value.threadSettings)) {
      const settings = value.threadSettings as ThreadSettings
      assertCodexProvider(settings.modelProvider)
      this.model = this.effectiveModel = settings.model
      this.capabilities.vision =
        this.catalog
          .find((entry) => entry.model === this.model)
          ?.inputModalities?.includes('image') ?? false
      this.effort = settings.effort ?? undefined
      this.native = {
        modelProvider: settings.modelProvider,
        reasoningEffort: settings.effort,
        effortOptions: this.effortOptions()
      }
      this.capabilities.reasoning = { nativeEffort: { options: this.native.effortOptions } }
      setSessionMeta(this.threadId, {
        engineId: 'codex',
        model: { engineId: 'codex', vendorId: settings.modelProvider, modelId: settings.model }
      })
      this.status(this.busy ? 'running' : 'idle')
    } else if (method === 'thread/tokenUsage/updated' && record(value.tokenUsage)) {
      const usage = value.tokenUsage as ThreadTokenUsage
      if (usage.total && usage.last)
        this.send('session:metering', {
          engineId: 'codex',
          vendorId: this.native?.modelProvider ?? 'openai',
          billingType: this.account?.billingType ?? 'unknown',
          tokens: {
            input: usage.total.inputTokens,
            output: usage.total.outputTokens,
            cacheRead: usage.total.cachedInputTokens,
            cacheWrite: usage.total.cacheWriteInputTokens,
            total: usage.total.totalTokens
          },
          equivalentCostUsd: null,
          contextWindow: { used: usage.last.totalTokens, size: usage.modelContextWindow ?? 0 }
        } satisfies MeteringSnapshot)
      if (usage.total && usage.last)
        this.send('session:status-line', {
          totalCostUsd: 0,
          totalDurationMs: 0,
          totalApiDurationMs: 0,
          totalInputTokens: usage.total.inputTokens,
          totalOutputTokens: usage.total.outputTokens,
          cachedTokens: usage.total.cachedInputTokens,
          totalTokens: usage.total.totalTokens,
          contextWindowSize: usage.modelContextWindow ?? 0,
          usedPercentage: usage.modelContextWindow
            ? (usage.last.totalTokens / usage.modelContextWindow) * 100
            : null,
          remainingPercentage: usage.modelContextWindow
            ? Math.max(0, 100 - (usage.last.totalTokens / usage.modelContextWindow) * 100)
            : null
        })
    } else if (method === 'turn/completed' && record(value.turn)) {
      this.finishTurn(value.turn as Turn)
    } else if (typeof value.turnId === 'string' && !this.endedTurns.has(value.turnId)) {
      if (method === 'item/started' || method === 'item/completed') {
        if (!record(value.item) || typeof value.item.id !== 'string') return
        this.item(value.turnId, value.item as ThreadItem, method === 'item/completed')
      } else if (typeof value.itemId === 'string' && typeof value.delta === 'string') {
        for (const event of mapCodexDelta(method, {
          threadId: this.threadId,
          turnId: value.turnId,
          itemId: value.itemId,
          delta: value.delta
        })) {
          if (event.kind === 'stream') {
            const id = codexItemId(this.threadId, value.turnId, value.itemId)
            if (this.completedItems.has(id)) continue
            const previous = this.deltas.get(id)
            const block = previous?.content[0]
            const text =
              (block && (block.type === 'text' || block.type === 'thinking') ? block.text : '') +
              event.delta.text
            const message: ChatMessage = {
              id,
              role: 'assistant',
              timestamp: previous?.timestamp ?? Date.now(),
              content: [{ type: event.delta.type, text }]
            }
            this.deltas.set(id, message)
            this.dispatch({ kind: 'message', message })
          } else this.dispatch(event)
        }
      }
    }
  }

  private finishTurn(turn: Turn): void {
    if (!this.threadId || typeof turn.id !== 'string' || this.endedTurns.has(turn.id)) return
    for (const item of turn.items ?? []) this.item(turn.id, item, true, true)
    this.endedTurns.add(turn.id)
    this.client.abortServerRequests(this.threadId, turn.id)
    for (const pending of [...this.pending.values()]) {
      if (pending.turnId === turn.id) pending.settle()
    }
    if (this.turnId === turn.id || this.turnId === null) {
      this.turnId = null
      this.busy = false
      this.interruptRequested = false
      this.deltas.clear()
      this.bashGate.cancelAll()
      this.output.clear()
      if (turn.error)
        this.send(
          'session:error',
          'Codex turn failed. Check native account status and settings; no credentials were changed.'
        )
      this.status('idle')
      this.resetInactivityTimer()
    }
  }

  private item(turnId: string, item: ThreadItem, completed: boolean, authoritative = false): void {
    const id = codexItemId(this.threadId!, turnId, item.id)
    const fingerprint = completed
      ? createHash('sha256').update(JSON.stringify(item)).digest('hex')
      : undefined
    if (
      this.completedItems.has(id) &&
      (!authoritative || this.completedItems.get(id) === fingerprint)
    )
      return
    if (fingerprint !== undefined) this.completedItems.set(id, fingerprint)
    const timestamp =
      this.messageHistory.find((message) => message.id === id)?.timestamp ?? Date.now()
    for (const event of mapCodexItem(this.threadId!, turnId, item, completed, timestamp))
      this.dispatch(event)
  }

  private dispatch(event: CodexMappedEvent): void {
    switch (event.kind) {
      case 'stream':
        this.send('session:stream', event.delta)
        break
      case 'message': {
        const index = this.messageHistory.findIndex((message) => message.id === event.message.id)
        if (index < 0) this.messageHistory.push(event.message)
        else
          this.messageHistory[index] = {
            ...event.message,
            content: mergeContentBlocks(this.messageHistory[index].content, event.message.content)
          }
        this.send('session:message', event.message)
        break
      }
      case 'commandDelta': {
        const output = ((this.output.get(event.toolUseId) ?? '') + event.delta).slice(-256_000)
        this.output.set(event.toolUseId, output)
        this.bashGate.update(event.toolUseId, output)
        break
      }
      case 'toolResult':
        this.bashGate.cancel(event.toolUseId)
        this.output.delete(event.toolUseId)
        this.messageHistory = this.messageHistory.map((message) => {
          if (
            !message.content.some(
              (block) => block.type === 'tool_use' && block.toolUseId === event.toolUseId
            )
          )
            return message
          return {
            ...message,
            content: [
              ...message.content.filter(
                (block) => block.type !== 'tool_result' || block.toolUseId !== event.toolUseId
              ),
              {
                type: 'tool_result',
                toolUseId: event.toolUseId,
                toolResult: event.result,
                isError: event.isError,
                ...(event.fileDiffs ? { fileDiffs: event.fileDiffs } : {})
              }
            ]
          }
        })
        this.send('session:tool-result', {
          toolUseId: event.toolUseId,
          result: event.result,
          isError: event.isError,
          ...(event.fileDiffs ? { fileDiffs: event.fileDiffs } : {})
        })
        break
    }
  }

  private requestApproval(
    method: string,
    value: unknown,
    context: Parameters<NonNullable<CodexClientOptions['onServerRequest']>>[2]
  ): Promise<unknown> {
    if (
      this.closed ||
      context.signal.aborted ||
      !record(value) ||
      value.threadId !== this.threadId ||
      typeof value.turnId !== 'string' ||
      value.turnId !== this.turnId ||
      typeof value.itemId !== 'string' ||
      this.endedTurns.has(value.turnId)
    )
      return Promise.reject(new Error('Codex request has no live owning root turn'))
    const requestId = `codex-approval:${this.generation}:${codexItemId(this.threadId!, value.turnId, value.itemId)}:${JSON.stringify(context.id)}`
    if (this.pending.has(requestId)) return Promise.reject(new Error('Duplicate Codex approval'))
    if (method === 'item/permissions/requestApproval') {
      this.send(
        'session:error',
        'Native permission-profile grants are not enabled. This request was denied without granting additional permissions.'
      )
      return Promise.resolve({ permissions: {}, scope: 'turn' })
    }
    let choices: CodexApprovalDecision[] = []
    let questions: ToolRequestUserInputParams['questions'] | undefined
    let gated: Gated[] | undefined
    const card: PendingApproval = {
      requestId,
      toolUseId: codexItemId(this.threadId!, value.turnId, value.itemId),
      toolName: '',
      input: {}
    }
    if (method === 'item/commandExecution/requestApproval') {
      const params = value as CommandExecutionRequestApprovalParams
      const command = params.command ?? ''
      card.toolName = 'commandExecution'
      // `commandActions` is display-only (docs/codex-spike.md answer A: it
      // cannot even separate `pwd` from `echo hi`), so the command STRING is
      // what gets gated and what a suggested rule is built from.
      card.input = { command, cwd: params.cwd ?? '' }
      card.decisionReason = params.reason ?? undefined
      // NEVER suggest a rule for an empty command: `Bash(:*)` is a prefix rule
      // that matches every command ever run. An approval with no command string
      // (e.g. a `writeStdin` kind) gets no persistable suggestion — it still
      // asks, it just cannot be turned into a standing rule.
      const normalized = normalizeWhitespace(command)
      if (normalized) card.suggestions = this.buildApprovalSuggestions('bash', `${normalized}:*`)
      gated = [{ tool: 'bash', input: { command } }]
    } else if (method === 'item/fileChange/requestApproval') {
      const params = value as FileChangeRequestApprovalParams
      card.toolName = 'fileChange'
      // The request itself carries no changes (FileChangeRequestApprovalParams
      // is threadId/turnId/itemId/startedAtMs/reason/grantRoot only — probe:
      // "no `availableDecisions`, no `kind` and no `grantRoot` at all"), so the
      // paths come from the fileChange ITEM already mapped into the transcript.
      const tool = this.messageHistory
        .flatMap((message) => message.content)
        .find((block) => block.type === 'tool_use' && block.toolUseId === card.toolUseId)
      const files: FileDiff[] =
        tool?.type === 'tool_use' && Array.isArray(tool.toolInput?.files)
          ? (tool.toolInput!.files as FileDiff[])
          : []
      card.input = { files }
      card.decisionReason = params.reason ?? undefined
      if (files.length) card.suggestions = this.buildApprovalSuggestions('edit')
      gated = files.map((file) => ({
        // `add` is a Write, every other change type (update/move/delete) edits
        // a file that already exists — mirrors Claude's own Write/Edit split.
        tool: file.changeType === 'add' ? 'write' : 'edit',
        input: { path: file.path },
        path: file.path
      }))
    } else if (method === 'item/tool/requestUserInput') {
      const params = value as ToolRequestUserInputParams
      if (
        !Array.isArray(params.questions) ||
        params.questions.some((question) => question.isSecret)
      ) {
        this.send(
          'session:error',
          'Native secret question declined: secure secret entry is not supported. No answer was sent.'
        )
        return Promise.resolve({ answers: {} })
      }
      questions = params.questions
      card.toolName = 'requestUserInput'
      card.input = {
        questions: questions.map((question) => ({
          question: question.question,
          header: question.header,
          options: question.options ?? [],
          multiSelect: false
        }))
      }
      choices = ['cancel']
      card.codex = {
        routingId: this.routingId,
        decisions: choices,
        questions: questions.map((question) => ({
          id: question.id,
          question: question.question,
          header: question.header,
          options: question.options ?? [],
          allowOther: question.isOther
        }))
      }
    } else return Promise.reject(new Error('Unsupported Codex server request'))

    if (gated) {
      const verdict = this.gate(gated)
      if (verdict.decision === 'allow') return Promise.resolve({ decision: 'accept' })
      if (verdict.decision === 'deny') {
        // The native reply carries a decision and nothing else — neither
        // response type has a reason field — so a denial is invisible to both
        // the model and the user unless we say it out loud here.
        this.send('session:error', verdict.reason!)
        // `decline` is honoured on both paths despite never appearing in
        // `availableDecisions` (docs/codex-spike.md, "Other observations"), so
        // the advertised list is deliberately not consulted.
        return Promise.resolve({ decision: 'decline' })
      }
    }
    const allowKeys = (gated ?? []).map((entry) => sessionAllowKey(entry.tool, entry.input))
    return new Promise((resolve, reject) => {
      const abort = (): void => settle()
      const settle = (reply?: unknown): void => {
        if (!this.pending.delete(requestId)) return
        context.signal.removeEventListener('abort', abort)
        this.send('session:approval-dismiss', { requestId })
        if (reply === undefined) reject(new Error('Codex approval cancelled'))
        else resolve(reply)
      }
      this.pending.set(requestId, {
        turnId: value.turnId as string,
        choices: [...choices],
        questions,
        allowKeys,
        settle
      })
      context.signal.addEventListener('abort', abort, { once: true })
      this.send('session:approval-request', card)
    })
  }

  /**
   * Run the shared, engine-neutral permission engine over every action one
   * native request covers, and collapse the verdicts: any deny denies, else any
   * ask asks, else allow. A request with NOTHING resolvable to gate asks —
   * never allows.
   *
   * `auto` gates as `default`: under `auto_review` the native subagent has
   * already approved everything it was willing to, so whatever still reaches
   * this client is precisely what it escalated, and escalations belong to the
   * human, not to `acceptEdits`' silent base.
   */
  private gate(gated: Gated[]): { decision: PermissionDecision; reason?: string } {
    if (gated.length === 0) return { decision: 'ask' }
    const ctx = {
      mode: this.permissionMode === 'auto' ? 'default' : this.permissionMode,
      rules: mergedClaudeRulesFor(this.cwd),
      sessionAllows: this.sessionAllows,
      cwd: this.cwd
    }
    let decision: PermissionDecision = 'allow'
    for (const entry of gated) {
      const verdict = decideWithSource(entry.tool, entry.input, ctx)
      let step = verdict.decision
      // Composition-seam narrowing, NOT a change to the ladder: `acceptEdits`'
      // mode base allows fileEdit/fileWrite unconditionally, which for Codex
      // would silently auto-apply a patch anywhere on disk. Codex's own
      // workspaceWrite sandbox draws the line at the workspace and asks up
      // front for anything outside it, so a mode-base allow for a path outside
      // cwd is downgraded to a human ask. A user rule that named the path still
      // wins — only `source: 'mode-base'` verdicts are touched.
      if (
        step === 'allow' &&
        verdict.source === 'mode-base' &&
        entry.path !== undefined &&
        !this.insideWorkspace(entry.path)
      )
        step = 'ask'
      if (step === 'deny')
        return {
          decision: 'deny',
          reason:
            verdict.source === 'deny-rule' && verdict.rule
              ? `Denied by permission rule: ${verdict.rule}`
              : this.permissionMode === 'plan'
                ? PLAN_MODE_DENY_REASON
                : 'Denied by permission rules'
        }
      if (step === 'ask') decision = 'ask'
    }
    return { decision }
  }

  private insideWorkspace(target: string): boolean {
    const relative = path.relative(this.cwd, path.resolve(this.cwd, target))
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }

  /**
   * The three "always allow" destinations for this request, mirroring
   * `PiSession.buildApprovalSuggestions`: bash gets a PREFIX rule (the whole
   * command plus a trailing glob, which round-trips through the engine's bash
   * prefix matcher), a file change gets a bare `Edit` rule.
   */
  private buildApprovalSuggestions(tool: string, ruleContent?: string): PermissionSuggestion[] {
    const rule = {
      toolName: PI_TOOL_TO_CLAUDE_TOOL[tool],
      ...(ruleContent ? { ruleContent } : {})
    }
    return (['userSettings', 'projectSettings', 'localSettings'] as const).map((destination) => ({
      type: 'addRules',
      behavior: 'allow',
      destination,
      rules: [rule]
    }))
  }

  /** Native question cards only — their one reply is `cancel`. */
  resolveCodexApproval(requestId: string, decision: CodexApprovalDecision): void {
    const pending = this.pending.get(requestId)
    if (!pending?.questions || !pending.choices.includes(decision))
      throw new Error('Stale or unoffered Codex approval decision')
    pending.settle({ answers: {} })
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Error('Stale or unknown Codex approval')
    if (pending.questions) {
      if (decision !== 'allow' || !answers)
        throw new Error('Codex questions require explicit answers')
      const nativeAnswers: Record<string, { answers: string[] }> = Object.create(null)
      for (const question of pending.questions) {
        const duplicateText =
          pending.questions.filter((entry) => entry.question === question.question).length > 1
        const answer =
          answers[question.id] ?? (duplicateText ? undefined : answers[question.question])
        if (typeof answer !== 'string') throw new Error('Missing Codex question answer')
        if (
          question.options?.length &&
          !question.isOther &&
          !question.options.some((option) => option.label === answer)
        )
          throw new Error('Codex question answer is not an offered choice')
        nativeAnswers[question.id] = { answers: [answer] }
      }
      pending.settle({ answers: nativeAnswers })
      return
    }
    if (decision === 'allowForSession')
      for (const key of pending.allowKeys) this.sessionAllows.add(key)
    pending.settle({ decision: decision === 'deny' ? 'decline' : 'accept' })
    // No rules cache to invalidate here: `gate()` re-reads the merged rules per
    // request, so a newly persisted rule is honoured on the very next approval.
    if (updatedPermissions && updatedPermissions.length > 0)
      persistAllowSuggestions(updatedPermissions, this.cwd, 'CodexSession')
  }
}
