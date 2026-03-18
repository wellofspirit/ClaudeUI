/**
 * Lazy on-demand SDK session for control messages (e.g., getUsage).
 *
 * Only spawns a CLI subprocess when explicitly requested (i.e., when the
 * direct API call in UsageFetcher fails and needs a fallback). The process
 * stays alive via an AsyncIterable prompt that never yields — no API tokens
 * are consumed. If the process exits, it is NOT auto-restarted; it will be
 * lazily re-spawned on the next getUsage() call.
 *
 * Lifecycle: spawned on first getUsage() call, stays alive until app quit
 * or process crash. Consumes zero API tokens.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { getSdkExecutableOpts } from './claude-session'
import { PERSISTED_SESSIONS_DIR } from './persisted-sessions-dir'
import { logger } from './logger'

/**
 * Creates an AsyncIterable<string> that never yields.
 * The SDK reads from this as its prompt input — since it never produces a
 * value, the CLI starts and waits for input indefinitely without making any
 * API call. The process stays alive for control messages (getUsage, etc.).
 */
function createHangingInput(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          // Return a promise that never resolves — keeps the CLI alive
          return new Promise<IteratorResult<string>>(() => {})
        }
      }
    }
  }
}

class ServiceSession {
  private activeQuery: {
    getUsage(): Promise<Record<string, unknown>>
  } | null = null

  private abortController: AbortController | null = null
  private spawning = false

  /** Stop the service session and clean up. */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    this.activeQuery = null
  }

  /**
   * Fetch usage via the service session's CLI process.
   * Lazily spawns the CLI on first call. Returns null if spawn fails.
   */
  async getUsage(): Promise<Record<string, unknown> | null> {
    if (!this.activeQuery) {
      await this.ensureSpawned()
    }
    if (!this.activeQuery) return null
    try {
      return await this.activeQuery.getUsage()
    } catch (err) {
      logger.debug('ServiceSession', `getUsage failed: ${err}`)
      // Process likely died — clear state so next call re-spawns
      this.activeQuery = null
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async ensureSpawned(): Promise<void> {
    if (this.activeQuery || this.spawning) return
    this.spawning = true

    try {
      const ac = new AbortController()
      this.abortController = ac

      const q = sdkQuery({
        prompt: createHangingInput() as AsyncIterable<never>,
        options: {
          ...getSdkExecutableOpts(),
          cwd: PERSISTED_SESSIONS_DIR,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          persistSession: false,
          settingSources: [],
          abortController: ac,
        },
      })

      // Cast to access patched getUsage()
      this.activeQuery = q as unknown as {
        getUsage(): Promise<Record<string, unknown>>
      }

      logger.debug('ServiceSession', 'Service session spawned (lazy, no prompt)')

      // Drain in background — if the process exits, clear state
      this.drain(q, ac).catch(() => {})
    } finally {
      this.spawning = false
    }
  }

  private async drain(q: AsyncIterable<unknown>, ac: AbortController): Promise<void> {
    try {
      for await (const _msg of q) {
        // Consume messages (shouldn't get any since we never send a prompt)
      }
    } catch (err) {
      if (ac.signal.aborted) return
      logger.debug('ServiceSession', `Service session error: ${err}`)
    } finally {
      if (this.abortController === ac) {
        this.activeQuery = null
        this.abortController = null
      }
    }
  }
}

/** Singleton service session */
export const serviceSession = new ServiceSession()
