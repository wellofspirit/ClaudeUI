import { expect, it, vi } from 'vitest'
import { deleteSessionByEngine } from '../../services/session-delete'
import type { EngineId } from '../../../shared/types'

const remove = vi.hoisted(() => vi.fn())
const deleteCodexThread = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../services/delete-session-files', () => ({ deleteSessionFiles: remove }))
vi.mock('../../services/pi-session-list', () => ({ deletePiSession: vi.fn() }))
vi.mock('../../services/opencode-session-list', () => ({ deleteOpencodeSession: vi.fn() }))
vi.mock('../delete', () => ({ deleteCodexThread }))

it('never falls through to Claude deletion for an unknown engine', async () => {
  await expect(deleteSessionByEngine('native', 'project', 'unknown' as EngineId)).rejects.toThrow(
    /unsupported/i
  )
  expect(remove).not.toHaveBeenCalled()
})

/**
 * Codex used to be on that list — its `delete` threw `unsupported` outright.
 * It deletes natively now (slice G), and the invariant that survives is the one
 * that mattered: a Codex id must never reach Claude's `deleteSessionFiles`,
 * which would unlink `~/.claude/projects/<key>/<thread id>.jsonl` — a path that
 * belongs to a different engine's session if it exists at all.
 */
it('routes a codex delete to the native thread delete, never to Claude files', async () => {
  await deleteSessionByEngine('native', 'project', 'codex')
  expect(deleteCodexThread).toHaveBeenCalledExactlyOnceWith('native')
  expect(remove).not.toHaveBeenCalled()
})
