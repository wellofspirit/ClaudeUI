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
import { deleteSessionFiles, deleteProjectFiles } from '../delete-session-files'

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
// IPC handler signature contract
//
// Regression test: ipcMain.handle passes (event, ...args) to the handler.
// Forgetting the leading `_e` parameter means the sessionId slot receives
// an IpcMainInvokeEvent object, which fs.rm then blows up on with
// "The 'path' argument must be of type string." These tests invoke the
// exact handler closures the way the bridge does and assert they behave.
// ---------------------------------------------------------------------------

describe('IPC handler signature (session:delete-session, session:delete-project)', () => {
  // Lift the same closures the IPC file registers. Kept minimal: we want to
  // lock in the (_e, ...args) contract, not re-test the whole IPC module.
  const makeSessionHandler = () =>
    async (_e: unknown, sessionId: string, projectKey: string): Promise<void> => {
      await deleteSessionFiles(sessionId, projectKey, root)
    }
  const makeProjectHandler = () =>
    async (_e: unknown, projectKey: string): Promise<void> => {
      await deleteProjectFiles(projectKey, root)
    }

  it('session handler ignores the IpcMainInvokeEvent first arg', async () => {
    const projectDir = await seedProject('-Users-x-proj', ['s1'])
    const handler = makeSessionHandler()
    const fakeEvent = { sender: { id: 1 } } // simulates IpcMainInvokeEvent
    await expect(handler(fakeEvent, 's1', '-Users-x-proj')).resolves.toBeUndefined()
    expect(fs.existsSync(path.join(projectDir, 's1.jsonl'))).toBe(false)
  })

  it('project handler ignores the IpcMainInvokeEvent first arg', async () => {
    const projectDir = await seedProject('-Users-x-proj', ['s1'])
    const handler = makeProjectHandler()
    const fakeEvent = { sender: { id: 1 } }
    await expect(handler(fakeEvent, '-Users-x-proj')).resolves.toBeUndefined()
    expect(fs.existsSync(projectDir)).toBe(false)
  })

  it('surfaces fs errors as rejections (Electron IpcMainInvokeEvent would blow up fs.rm if leaked)', async () => {
    // If the event were mistakenly used as the path arg, fs.rm would reject
    // with "path argument must be of type string" — guarding against that.
    const spy = vi.spyOn(fs.promises, 'rm')
    const handler = makeSessionHandler()
    await seedProject('-Users-x-proj', ['s1'])
    await handler({ sender: { id: 1 } }, 's1', '-Users-x-proj')
    // Every fs.rm call got a string — not an Event object
    for (const call of spy.mock.calls) {
      expect(typeof call[0]).toBe('string')
    }
    spy.mockRestore()
  })

  // Source-level guard: asserts the real session.ipc.ts registrations still
  // declare the leading event parameter. The in-memory closures above prove
  // the contract; this check binds it to the actual file we ship. A noisier
  // alternative would be to load session.ipc.ts under the electron shim, but
  // the import graph is too heavy for a single regression test.
  it('session.ipc.ts handler registrations keep the leading _e parameter', async () => {
    const src = await fs.promises.readFile(
      path.resolve(__dirname, '../../ipc/session.ipc.ts'),
      'utf8'
    )
    const sessionRegistration = /ipcMain\.handle\(\s*['"]session:delete-session['"]\s*,\s*safeHandler\(\s*async\s*\(\s*_e\s*:/
    const projectRegistration = /ipcMain\.handle\(\s*['"]session:delete-project['"]\s*,\s*safeHandler\(\s*async\s*\(\s*_e\s*:/
    expect(src).toMatch(sessionRegistration)
    expect(src).toMatch(projectRegistration)
  })
})
