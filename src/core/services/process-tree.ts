import { spawn as realSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/** Injectable seam so the platform-specific ordering is unit-testable without a
 *  real process (see __tests__/process-tree.test.ts). Both default to the real
 *  runtime values. */
export interface KillProcessTreeDeps {
  platform?: NodeJS.Platform
  spawn?: typeof realSpawn
}

/**
 * Kill a child process AND all of its descendants.
 *
 * Windows ordering (M-OC4 / M-PI3): `child.kill()` maps to `TerminateProcess`
 * on the ROOT only, and it runs SYNCHRONOUSLY. If it fires before
 * `taskkill /T /F` walks the tree, taskkill finds the root already gone and the
 * now-reparented descendants — LSP servers, formatters, `bash`-tool children —
 * are orphaned and survive app quit. So on Windows we let `taskkill /pid <pid>
 * /T /F` reap the WHOLE tree while the root is still alive; taskkill terminating
 * the root still fires the child's in-process `exit` event, so no separate
 * `child.kill()` is needed (the old "we still call child.kill() so exit fires"
 * comment was a misunderstanding — exit fires for ANY termination). Only if
 * taskkill can't even be spawned do we fall back to `child.kill()` so `exit`
 * still fires. This matches the already-correct `pi-subagent-source.ts`
 * `killTree`.
 *
 * Non-Windows: a plain `SIGTERM` (the caller's existing behavior); POSIX signal
 * delivery to the process group is out of scope here.
 */
export function killProcessTree(child: ChildProcess, deps: KillProcessTreeDeps = {}): void {
  const platform = deps.platform ?? process.platform
  const spawn = deps.spawn ?? realSpawn

  if (platform === 'win32' && child.pid != null) {
    try {
      const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      // ENOENT (taskkill somehow missing) surfaces async — fall back so `exit`
      // still fires and the root is not left running.
      tk.on('error', () => {
        try {
          child.kill()
        } catch {
          /* already dead */
        }
      })
    } catch {
      try {
        child.kill()
      } catch {
        /* already dead */
      }
    }
    return
  }

  child.kill('SIGTERM')
}
