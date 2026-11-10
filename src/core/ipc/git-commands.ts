/**
 * The `git:*` working-tree channels — ONE declaration, both transports.
 *
 * `session.ipc.ts` spreads `gitCommands('desktop')` with `handleIpc` and
 * `remote-handlers.ts` spreads `gitCommands('remote')` with `handleRemote`. The
 * bodies are identical; the one thing that differs per transport is the envelope:
 * the desktop answers `{ ok, data }` / `{ ok: false, error }` (a rejected
 * `ipcMain.invoke` loses the error type, see `safe-handler.ts`), while the
 * WebSocket answers bare and lets a failure reject, which is what the web client
 * expects. Hence the `transport` parameter and `envelopeFor`.
 *
 * `git:watch` is not here: it is a shared constant (`git-watch.ts`).
 */

import { gitServiceManager } from '../services/git-service'
import type { CommandRegistration, Transport } from './command-registry'
import { envelopeFor } from './safe-handler'

/**
 * Acquire/release a per-cwd GitService around a call. The real logic lives in
 * `gitServiceManager`; this is the thin get/try-finally/release adapter.
 */
async function withGit<T>(
  cwd: string,
  fn: (svc: ReturnType<typeof gitServiceManager.get>) => Promise<T>
): Promise<T> {
  const svc = gitServiceManager.get(cwd)
  try {
    return await fn(svc)
  } finally {
    gitServiceManager.release(cwd)
  }
}

export function gitCommands(transport: Transport): Array<Omit<CommandRegistration, 'transport'>> {
  const env = envelopeFor(transport)
  return [
    {
      channel: 'git:check-repo',
      capability: 'git',
      kind: 'query',
      handler: env(async (cwd: string) => withGit(cwd, (s) => s.isGitRepo()))
    },
    {
      channel: 'git:status',
      capability: 'git',
      kind: 'query',
      handler: env(async (cwd: string) => withGit(cwd, (s) => s.getStatus()))
    },
    {
      channel: 'git:branches',
      capability: 'git',
      kind: 'query',
      handler: env(async (cwd: string) => withGit(cwd, (s) => s.getBranches()))
    },
    {
      channel: 'git:checkout',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string, branch: string) => withGit(cwd, (s) => s.checkout(branch)))
    },
    {
      channel: 'git:create-branch',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string, name: string, base?: string | null) =>
        withGit(cwd, (s) => s.createBranch(name, base))
      )
    },
    {
      channel: 'git:file-patch',
      capability: 'git',
      kind: 'query',
      handler: env(
        async (cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean) =>
          withGit(cwd, (s) => s.getFilePatch(filePath, staged, ignoreWhitespace))
      )
    },
    {
      channel: 'git:file-contents',
      capability: 'git',
      kind: 'query',
      handler: env(async (cwd: string, filePath: string, staged: boolean) =>
        withGit(cwd, (s) => s.getFileContents(filePath, staged))
      )
    },
    {
      channel: 'git:stage-file',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string, filePath: string) =>
        withGit(cwd, (s) => s.stageFile(filePath))
      )
    },
    {
      channel: 'git:unstage-file',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string, filePath: string) =>
        withGit(cwd, (s) => s.unstageFile(filePath))
      )
    },
    {
      channel: 'git:discard-file',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string, filePath: string) =>
        withGit(cwd, (s) => s.discardFile(filePath))
      )
    },
    {
      channel: 'git:stage-all',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string) => withGit(cwd, (s) => s.stageAll()))
    },
    {
      channel: 'git:unstage-all',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string) => withGit(cwd, (s) => s.unstageAll()))
    },
    {
      channel: 'git:commit',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string, message: string) => withGit(cwd, (s) => s.commit(message)))
    },
    {
      channel: 'git:push',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string) => withGit(cwd, (s) => s.push()))
    },
    {
      channel: 'git:push-with-upstream',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string, branch: string) =>
        withGit(cwd, (s) => s.pushWithUpstream(branch))
      )
    },
    {
      channel: 'git:pull',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string, mode?: 'merge' | 'rebase') =>
        withGit(cwd, (s) => s.pull(mode))
      )
    },
    {
      channel: 'git:stash-push',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string) => withGit(cwd, (s) => s.stashPush()))
    },
    {
      channel: 'git:stash-restore',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string, sha: string) => withGit(cwd, (s) => s.stashRestore(sha)))
    },
    {
      channel: 'git:fetch',
      capability: 'git',
      kind: 'command',
      handler: env(async (cwd: string) => withGit(cwd, (s) => s.fetch()))
    }
  ]
}
