import { expect, it, vi } from 'vitest'
import { deleteSessionByEngine } from '../../services/session-delete'
import type { EngineId } from '../../../shared/types'

const remove = vi.hoisted(() => vi.fn())
vi.mock('../../services/delete-session-files', () => ({ deleteSessionFiles: remove }))
vi.mock('../../services/pi-session-list', () => ({ deletePiSession: vi.fn() }))
vi.mock('../../services/opencode-session-list', () => ({ deleteOpencodeSession: vi.fn() }))

it.each(['codex', 'unknown'])('never falls through to Claude deletion for %s', async (engine) => {
  await expect(deleteSessionByEngine('native', 'project', engine as EngineId)).rejects.toThrow(
    /unsupported/i
  )
  expect(remove).not.toHaveBeenCalled()
})
