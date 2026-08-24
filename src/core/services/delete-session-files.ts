import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SEGMENT_TRAVERSAL } from './path-containment'

/**
 * Filesystem delete helpers for session / project data.
 *
 * Extracted from session.ipc.ts so they can be unit-tested without pulling in
 * the entire IPC module's import graph (SDK, proxy, MCP, services, etc.).
 */

function defaultProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

function resolveProjectDir(projectKey: string, root: string): string {
  const dir = path.resolve(root, projectKey)
  if (!dir.startsWith(root + path.sep)) throw new Error('Path traversal blocked')
  return dir
}

/**
 * Permanently delete a session's JSONL + its subagent directory.
 * Missing targets are ignored (force: true); other fs errors propagate.
 *
 * @param root — overrides ~/.claude/projects; used by tests.
 */
export async function deleteSessionFiles(
  sessionId: string,
  projectKey: string,
  root: string = defaultProjectsRoot()
): Promise<void> {
  if (!sessionId || !projectKey) throw new Error('sessionId and projectKey are required')
  if (SEGMENT_TRAVERSAL.test(sessionId) || SEGMENT_TRAVERSAL.test(projectKey)) {
    throw new Error('Invalid sessionId or projectKey')
  }
  const projectDir = resolveProjectDir(projectKey, root)
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`)
  const subagentDir = path.join(projectDir, sessionId)
  await fs.promises.rm(jsonlPath, { force: true })
  await fs.promises.rm(subagentDir, { recursive: true, force: true })
}

/**
 * Permanently delete an entire project directory (all sessions inside it).
 */
export async function deleteProjectFiles(
  projectKey: string,
  root: string = defaultProjectsRoot()
): Promise<void> {
  if (!projectKey) throw new Error('projectKey is required')
  if (SEGMENT_TRAVERSAL.test(projectKey)) throw new Error('Invalid projectKey')
  const projectDir = resolveProjectDir(projectKey, root)
  await fs.promises.rm(projectDir, { recursive: true, force: true })
}
