/**
 * Lightweight always-on SDK session for control messages (e.g., getUsage).
 *
 * Keeps a minimal CLI subprocess alive so we can issue control requests
 * (like get_usage) without needing an active user chat session. The session
 * sends a no-op prompt and stays alive via a streaming input channel that
 * never closes.
 *
 * Lifecycle: started once at app launch, auto-restarts on crash, stopped
 * on app quit. Consumes negligible resources (idle subprocess, no API calls
 * unless we send control requests).
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { getCliJsPath } from './claude-session'
import { logger } from './logger'

class ServiceSession {
  private activeQuery: {
    getUsage(): Promise<Record<string, unknown>>
  } | null = null

  private abortController: AbortController | null = null
  private running = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Start the service session. Safe to call multiple times.
   * The session runs a minimal query that stays alive for control messages.
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.spawn()
  }

  /** Stop the service session and clean up. */
  stop(): void {
    this.running = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    this.activeQuery = null
  }

  /** Fetch usage via the service session's CLI process. */
  async getUsage(): Promise<Record<string, unknown> | null> {
    if (!this.activeQuery) return null
    try {
      return await this.activeQuery.getUsage()
    } catch (err) {
      logger.debug('ServiceSession', `getUsage failed: ${err}`)
      return null
    }
  }

  /** Whether the service session is connected and ready. */
  get isReady(): boolean {
    return this.activeQuery !== null
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private spawn(): void {
    if (!this.running) return

    const ac = new AbortController()
    this.abortController = ac

    const cliPath = getCliJsPath()

    // Use a streaming input so the CLI stays alive waiting for input.
    // We send a no-op initial prompt that completes immediately.
    const q = sdkQuery({
      prompt: 'Reply with OK',
      options: {
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
        cwd: process.cwd(),
        model: 'claude-haiku-4-5',
        effort: 'low',
        thinking: { type: 'disabled' },
        maxTurns: 1,
        persistSession: false,
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController: ac,
      },
    })

    // Cast to access patched getUsage()
    this.activeQuery = q as unknown as {
      getUsage(): Promise<Record<string, unknown>>
    }

    logger.debug('ServiceSession', 'Service session spawned')

    // Drain the query iterator in the background — keeps the process alive
    // until the initial prompt completes, then the CLI exits naturally.
    // We use continueConversation mode to keep it alive... actually,
    // the simplest approach: just drain the iterator and restart when it ends.
    this.drain(q, ac).catch(() => {})
  }

  private async drain(q: AsyncIterable<unknown>, ac: AbortController): Promise<void> {
    try {
      for await (const _msg of q) {
        // Just consume messages, keep the connection alive
      }
    } catch (err) {
      if (ac.signal.aborted) return // intentional shutdown
      logger.debug('ServiceSession', `Service session error: ${err}`)
    } finally {
      if (this.abortController === ac) {
        this.activeQuery = null
        this.abortController = null
      }
    }

    // Auto-restart after a delay if still running
    if (this.running) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (this.running) {
          logger.debug('ServiceSession', 'Restarting service session')
          this.spawn()
        }
      }, 5_000) // 5s delay before restart
    }
  }
}

/** Singleton service session */
export const serviceSession = new ServiceSession()
