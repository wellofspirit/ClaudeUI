/**
 * Shared helper for short-lived Codex app-server interactions.
 *
 * `withCodexAppServer` spawns `codex app-server`, performs the minimum
 * handshake (initialize → initialized), calls the user-supplied function
 * with the connected client, then always closes the client and kills the
 * child process in the finally block.
 *
 * Design notes:
 * - Does NOT set CODEX_HOME — forcing $HOME breaks auth (see memory note).
 * - Times out after `timeoutMs` (default: 15 s) if the process or RPC hangs.
 * - Distinguishes spawn errors (binary not found / not executable) from
 *   runtime errors (process started but RPC failed).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { locateCodex } from './locate'
import { CodexAppServerClient } from './CodexAppServerClient'
import { logger } from '../services/logger'

const DEFAULT_TIMEOUT_MS = 15_000

export class CodexSpawnError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CodexSpawnError'
    if (cause instanceof Error) {
      this.stack = this.stack + '\nCaused by: ' + cause.stack
    }
  }
}

/**
 * Spawn a short-lived `codex app-server`, perform the initialize/initialized
 * handshake, invoke `fn(client)`, then always tear down.
 *
 * @throws {CodexSpawnError} if the binary cannot be spawned (not installed / not found).
 * @throws {Error} on RPC timeout or protocol failure.
 */
export async function withCodexAppServer<T>(
  cwd: string,
  fn: (client: CodexAppServerClient) => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const binPath = locateCodex()
  logger.debug('codexQuery', `spawning codex app-server from ${binPath}`)

  let child: ChildProcess
  try {
    child = spawn(binPath, ['app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Do NOT add CODEX_HOME — that breaks auth (see MEMORY.md).
      env: { ...process.env },
    })
  } catch (err) {
    throw new CodexSpawnError(
      `Failed to spawn codex app-server: ${err instanceof Error ? err.message : String(err)}`,
      err
    )
  }

  // Distinguish "binary not found" (ENOENT) from runtime errors
  await new Promise<void>((resolve, reject) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        reject(new CodexSpawnError(`codex binary not found or not executable: ${err.message}`, err))
      } else {
        reject(err)
      }
    })
    // If the stream opens without error, we're good to proceed
    child.stdout!.once('readable', resolve)
    // Also resolve if stdin/stdout are ready immediately (already readable)
    setImmediate(resolve)
  }).catch((err) => { throw err })

  const client = new CodexAppServerClient(child.stdin!, child.stdout!, {
    defaultTimeoutMs: timeoutMs,
  })

  let timedOut = false
  const timeoutHandle = setTimeout(() => {
    timedOut = true
    logger.warn('codexQuery', `codex app-server call timed out after ${timeoutMs}ms`)
    child.kill('SIGTERM')
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, 2000)
  }, timeoutMs)

  try {
    // 1. initialize
    await client.request('initialize', {
      clientInfo: { name: 'ClaudeUI', version: '1.0' },
      capabilities: { experimentalApi: true },
    })

    // 2. initialized notification
    client.notify('initialized', undefined)

    // 3. invoke the caller's function
    const result = await fn(client)
    clearTimeout(timeoutHandle)
    return result
  } catch (err) {
    clearTimeout(timeoutHandle)
    if (!timedOut) {
      logger.error('codexQuery', 'codex app-server call failed', err)
    }
    throw err
  } finally {
    client.close()
    // Give the process a moment to flush, then kill
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGTERM')
        resolve()
      }, 500)
    })
  }
}
