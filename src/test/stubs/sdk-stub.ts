/**
 * SDK Stub — Configurable replacement for `sdkQuery()` from @anthropic-ai/claude-agent-sdk.
 *
 * Returns an async generator with control methods matching the real Query interface.
 * Used in component and E2E tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Represents an SDK message yielded by the query generator.
 * Kept as Record<string, unknown> since the SDK doesn't export concrete message types
 * and ClaudeSession also treats them as untyped records.
 */
export type SDKMessage = Record<string, unknown>

export interface SdkStubOptions {
  /** Event sequence to yield. */
  events: SDKMessage[]
  /** Delay (ms) between events. Default 0 (instant). */
  delayMs?: number
}

interface QueryControlMethods {
  interrupt(): Promise<void>
  setPermissionMode(mode: string): Promise<void>
  setModel(model?: string): Promise<void>
  stopTask(taskId: string): Promise<void>
  backgroundTask(taskId: string): Promise<unknown>
  dequeueMessage(value: string): Promise<{ removed: number }>
  askSideQuestion(question: string): Promise<string | null>
  getUsage(): Promise<Record<string, unknown>>
  mcpServerStatus(): Promise<unknown[]>
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>
  reconnectMcpServer(serverName: string): Promise<void>
  setMcpServers(servers: Record<string, unknown>): Promise<unknown>
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  voiceServerStart(): Promise<{ port: number }>
  voiceServerStop(): Promise<{ stopped: boolean }>
  supportedModels(): Promise<any[]>
  supportedCommands(): Promise<any[]>
  supportedAgents(): Promise<any[]>
  getContextUsage(): Promise<any>
}

/** Tracks calls made to control methods for test assertions */
export interface SdkStubCallTracker {
  interrupts: number
  permissionModes: string[]
  models: (string | undefined)[]
  stoppedTasks: string[]
  backgroundedTasks: string[]
  dequeuedMessages: string[]
  sideQuestions: string[]
}

function createCallTracker(): SdkStubCallTracker {
  return {
    interrupts: 0,
    permissionModes: [],
    models: [],
    stoppedTasks: [],
    backgroundedTasks: [],
    dequeuedMessages: [],
    sideQuestions: [],
  }
}

/**
 * Creates a mock sdkQuery function that yields the provided events.
 * Returns both the mock function and a call tracker for assertions.
 */
export function createSdkStub(options: SdkStubOptions): {
  queryFn: (params: any) => any
  tracker: SdkStubCallTracker
  /** Resolve to allow the generator to proceed (for canUseTool suspension) */
  canUseToolResponses: Array<{ behavior: string; updatedInput?: any; message?: string }>
} {
  const tracker = createCallTracker()
  const canUseToolResponses: Array<{ behavior: string; updatedInput?: any; message?: string }> = []
  let abortController: AbortController | null = null
  let interrupted = false

  const queryFn = (params: any): any => {
    abortController = params?.options?.abortController ?? null

    // Listen for abort
    abortController?.signal.addEventListener('abort', () => {
      interrupted = true
    })

    const events = options.events
    const delayMs = options.delayMs ?? 0

    async function* generate(): AsyncGenerator<SDKMessage, void, unknown> {
      for (const event of events) {
        if (interrupted) return
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        yield event
      }
    }

    const generator = generate()

    // Attach control methods to match Query interface
    const controlMethods: QueryControlMethods = {
      interrupt: async () => { tracker.interrupts++; interrupted = true },
      setPermissionMode: async (mode) => { tracker.permissionModes.push(mode) },
      setModel: async (model) => { tracker.models.push(model) },
      stopTask: async (taskId) => { tracker.stoppedTasks.push(taskId) },
      backgroundTask: async (taskId) => { tracker.backgroundedTasks.push(taskId); return {} },
      dequeueMessage: async (value) => { tracker.dequeuedMessages.push(value); return { removed: 1 } },
      askSideQuestion: async (question) => { tracker.sideQuestions.push(question); return null },
      getUsage: async () => ({}),
      mcpServerStatus: async () => [],
      toggleMcpServer: async () => {},
      reconnectMcpServer: async () => {},
      setMcpServers: async () => ({}),
      applyFlagSettings: async () => {},
      voiceServerStart: async () => ({ port: 0 }),
      voiceServerStop: async () => ({ stopped: true }),
      supportedModels: async () => [],
      supportedCommands: async () => [],
      supportedAgents: async () => [],
      getContextUsage: async () => ({}),
    }

    // Merge control methods onto the generator
    return Object.assign(generator, controlMethods)
  }

  return { queryFn, tracker, canUseToolResponses }
}
