import type { InvokeProgress } from '../../remote-protocol'
import type { DirEntry, ListPlacesResult } from '../files'
import type {
  WorktreeInfo,
  WorktreeInspection,
  WorktreeInventory,
  WorktreeRemoveResult,
  WorktreeSize,
  WorktreeStatus
} from '../worktree'

export interface FileAPI {
  listDir(dirPath: string): Promise<{ entries: DirEntry[]; isRoot: boolean; resolvedPath: string }>
  /** Rail shortcuts for the directory picker — home, hostname, drive roots (ADR-046). */
  listPlaces(): Promise<ListPlacesResult>
  openInVSCode(cwd: string): Promise<void>
  /**
   * Open a local file with the OS default handler. Optional: only the desktop
   * preload provides it — the remote web client has no local filesystem, so
   * callers must guard with `window.api?.openPath?.(…)` and hide the
   * affordance when it is absent. Resolves with `{ error }` on failure.
   */
  openPath?(filePath: string): Promise<{ error?: string }>
  /** Reveal a local file in the OS file manager. Optional — see {@link FileAPI.openPath}. */
  showInFolder?(filePath: string): Promise<{ error?: string }>
  /**
   * Resolve an image `src` for a file delivered by `SendUserFile` (ADR-043 §4).
   * One member, two transports:
   *  - desktop preload → IPC that reads the file and returns a `data:` URL;
   *  - web adapter → an authenticated same-origin `/sent-file?...&inline=1` URL.
   *
   * `sessionKey` is the session's routingId: the remote transport needs it to
   * look up that session's allowlisted files server-side. The desktop transport
   * ignores it — `filePath` is already the cwd-resolved absolute path and main
   * re-validates it. Optional, like the shell members: callers must probe.
   */
  getSentFilePreview?(
    sessionKey: string,
    filePath: string
  ): Promise<{ src: string } | { error: string }>
  /**
   * `opts.base`: `'head'` (default) branches from HEAD; `'default'` from the remote's default
   * branch (HEAD when there is none).
   */
  createWorktree(
    cwd: string,
    name: string,
    opts?: { base?: 'head' | 'default' }
  ): Promise<WorktreeInfo>
  getWorktreeStatus(worktreePath: string, originalHead: string): Promise<WorktreeStatus>
  /**
   * Legacy single-path removal (session-delete cleanup modal). Same mechanics as
   * {@link removeWorktrees}, live holders ENFORCED: a held worktree comes back `refused`.
   * Never throws for a refusal; throws only for a path that is not a worktree of any repo.
   */
  removeWorktree(
    worktreePath: string,
    branch: string,
    gitRoot: string
  ): Promise<WorktreeRemoveResult>
  /** Every linked worktree of the repo `cwd` belongs to, plus orphan folders (ADR-112). Ids are wire keys. */
  inventoryWorktrees(cwd: string): Promise<WorktreeInventory>
  /** Uncommitted files and commits that exist only on this entry's branch. */
  inspectWorktree(cwd: string, id: string): Promise<WorktreeInspection>
  /** Size of one entry; `onProgress` reports `{done: files, total: null, phase: 'measuring'}`. */
  measureWorktree(
    cwd: string,
    id: string,
    onProgress?: (progress: InvokeProgress) => void
  ): Promise<WorktreeSize>
  /**
   * Remove entries by id: one result per id, in order. `onProgress` reports
   * `{done, total, phase}` per entry and per walked batch. Holders are enforced.
   */
  removeWorktrees(
    cwd: string,
    ids: string[],
    onProgress?: (progress: InvokeProgress) => void
  ): Promise<WorktreeRemoveResult[]>
}
