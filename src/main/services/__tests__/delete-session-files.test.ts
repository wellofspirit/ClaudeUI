/**
 * @vitest-environment node
 *
 * Tests for the filesystem delete helpers AND the IPC handler wrapper that
 * consumes them. Exercises both the fs-level behavior (happy path, missing
 * files, path-traversal guard) and the Electron IPC calling convention —
 * specifically that handlers skip the leading `event` argument. The original
 * bug (`fs.rm` receiving an IpcMainInvokeEvent as its path) is guarded by
 * the "IPC handler signature contract" suite below.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { deleteSessionFiles, deleteProjectFiles } from '../../../core/services/delete-session-files'

let root: string

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-delete-test-'))
})

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true })
})

async function seedProject(projectKey: string, sessionIds: string[]): Promise<string> {
  const projectDir = path.join(root, projectKey)
  await fs.promises.mkdir(projectDir, { recursive: true })
  for (const id of sessionIds) {
    await fs.promises.writeFile(path.join(projectDir, `${id}.jsonl`), '{}\n')
    const subDir = path.join(projectDir, id)
    await fs.promises.mkdir(subDir, { recursive: true })
    await fs.promises.writeFile(path.join(subDir, 'tool-result.json'), '{}')
  }
  return projectDir
}

describe('deleteSessionFiles', () => {
  it('removes the JSONL and the subagent directory', async () => {
    const projectDir = await seedProject('-Users-x-proj', ['s1'])
    await deleteSessionFiles('s1', '-Users-x-proj', root)
    expect(fs.existsSync(path.join(projectDir, 's1.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(projectDir, 's1'))).toBe(false)
  })

  it('leaves sibling sessions alone', async () => {
    const projectDir = await seedProject('-Users-x-proj', ['s1', 's2'])
    await deleteSessionFiles('s1', '-Users-x-proj', root)
    expect(fs.existsSync(path.join(projectDir, 's2.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(projectDir, 's2'))).toBe(true)
  })

  it('is idempotent when files do not exist', async () => {
    await seedProject('-Users-x-proj', [])
    await expect(deleteSessionFiles('ghost', '-Users-x-proj', root)).resolves.toBeUndefined()
  })

  it('rejects traversal in sessionId', async () => {
    await expect(deleteSessionFiles('../escape', 'proj', root)).rejects.toThrow(/Invalid/)
  })

  it('rejects traversal in projectKey', async () => {
    await expect(deleteSessionFiles('s1', '../escape', root)).rejects.toThrow(/Invalid/)
  })

  it('rejects empty sessionId or projectKey', async () => {
    await expect(deleteSessionFiles('', 'proj', root)).rejects.toThrow(/required/)
    await expect(deleteSessionFiles('s1', '', root)).rejects.toThrow(/required/)
  })
})

describe('deleteProjectFiles', () => {
  it('removes the entire project directory', async () => {
    const projectDir = await seedProject('-Users-x-proj', ['s1', 's2'])
    await deleteProjectFiles('-Users-x-proj', root)
    expect(fs.existsSync(projectDir)).toBe(false)
  })

  it('is idempotent when project does not exist', async () => {
    await expect(deleteProjectFiles('nonexistent', root)).resolves.toBeUndefined()
  })

  it('rejects traversal in projectKey', async () => {
    await expect(deleteProjectFiles('../escape', root)).rejects.toThrow(/Invalid/)
  })

  it('rejects empty projectKey', async () => {
    await expect(deleteProjectFiles('', root)).rejects.toThrow(/required/)
  })
})

// ---------------------------------------------------------------------------
// IPC handler argument-slot contract
//
// Regression test for an argument-slot shift: if the sessionId slot receives
// the wrong value, fs.rm blows up with "The 'path' argument must be of type
// string" — or worse, deletes the wrong tree. Since the SyncCore phase-1 port
// the registry hands the handler ONLY the caller's arguments (session.ipc.ts's
// `handleIpc` swallows the Electron event in the transport adapter), so the
// contract inverted: these handlers must NOT declare a leading `_e`, and the
// first parameter must be `sessionId` / `projectKey`.
// ---------------------------------------------------------------------------

describe('IPC handler argument slots (session:delete-session, session:delete-project)', () => {
  // Lift the same closures the IPC file registers. Kept minimal: we want to
  // lock in the argument-slot contract, not re-test the whole IPC module.
  const makeSessionHandler =
    () =>
    async (sessionId: string, projectKey: string): Promise<void> => {
      await deleteSessionFiles(sessionId, projectKey, root)
    }
  const makeProjectHandler =
    () =>
    async (projectKey: string): Promise<void> => {
      await deleteProjectFiles(projectKey, root)
    }

  it('session handler takes (sessionId, projectKey) with no event slot', async () => {
    const projectDir = await seedProject('-Users-x-proj', ['s1'])
    const handler = makeSessionHandler()
    await expect(handler('s1', '-Users-x-proj')).resolves.toBeUndefined()
    expect(fs.existsSync(path.join(projectDir, 's1.jsonl'))).toBe(false)
  })

  it('project handler takes (projectKey) with no event slot', async () => {
    const projectDir = await seedProject('-Users-x-proj', ['s1'])
    const handler = makeProjectHandler()
    await expect(handler('-Users-x-proj')).resolves.toBeUndefined()
    expect(fs.existsSync(projectDir)).toBe(false)
  })

  it('only ever passes strings to fs.rm (a leaked event object would reject)', async () => {
    const spy = vi.spyOn(fs.promises, 'rm')
    const handler = makeSessionHandler()
    await seedProject('-Users-x-proj', ['s1'])
    await handler('s1', '-Users-x-proj')
    // Every fs.rm call got a string — not an Event object
    for (const call of spy.mock.calls) {
      expect(typeof call[0]).toBe('string')
    }
    spy.mockRestore()
  })

  // Source-level guard: asserts the real session.ipc.ts registrations declare
  // the caller's first argument in the first slot — and no `_e`. The in-memory
  // closures above prove the contract; this check binds it to the actual file
  // we ship. A noisier alternative would be to load session.ipc.ts under the
  // electron shim, but the import graph is too heavy for a single regression
  // test.
  it('session.ipc.ts registrations put the real first argument in slot 0', async () => {
    const src = await fs.promises.readFile(
      path.resolve(__dirname, '../../ipc/session.ipc.ts'),
      'utf8'
    )
    const sessionRegistration =
      /channel: 'session:delete-session',[\s\S]{0,200}?handler: safeHandler\(\s*async\s*\(\s*sessionId\s*:/
    const projectRegistration =
      /channel: 'session:delete-project',[\s\S]{0,200}?handler: safeHandler\(\s*async\s*\(\s*projectKey\s*:/
    expect(src).toMatch(sessionRegistration)
    expect(src).toMatch(projectRegistration)
    // No handler in the file may reclaim the event slot.
    expect(src).not.toMatch(/handler:\s*(?:safeHandler\(\s*)?(?:async\s*)?\(\s*_e(?:vent)?[,:)\s]/)
  })
})
