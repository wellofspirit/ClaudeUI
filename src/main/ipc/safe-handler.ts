/**
 * `safeHandler` — the `IpcResult` envelope wrapper both transports share.
 *
 * It lived in `session.ipc.ts` until the S1b registration sweep, which is where
 * it stopped being a desktop concern: the channels that sweep exposes on the
 * remote transport are registered from ONE transport-agnostic declaration
 * (`config-commands.ts`), so the envelope has to come from a module that has
 * nothing to do with Electron. Behaviour is unchanged — this is a move.
 *
 * Why an envelope at all: a rejected `ipcMain.invoke` loses the error type and
 * surfaces in the renderer as a mangled `Error: Error invoking remote method`,
 * so the throwing families (git, MCP, worktree, file IO) answer `{ok,data}` /
 * `{ok,error}` instead. `CommandRegistry.dispatch` reads that envelope back when
 * it decides a command's audit outcome (`outcomeOf`), and the web client's
 * `unwrap` reads it on the other side, so the shape is load-bearing on both
 * surfaces rather than a desktop convention.
 *
 * NOT for fire-and-forget handlers (`session:send`) or handlers that already
 * have their own error contract.
 */

import { logger } from '../services/logger'
import type { IpcResult } from '../../shared/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeHandler<T>(handler: (...args: any[]) => Promise<T>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]): Promise<IpcResult<T>> => {
    try {
      const data = await handler(...args)
      return { ok: true, data }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.error('IPC', error)
      return { ok: false, error }
    }
  }
}
