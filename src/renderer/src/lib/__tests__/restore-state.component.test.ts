/**
 * Picking up after a relaunch (`lib/restore-state.ts`): collect the open
 * session and drafts, put them back once, skip sessions nobody lists.
 * `openSessionById` and the transcript load are stubbed; they have their own specs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openSessionById = vi.hoisted(() => vi.fn(async (_id: string) => {}))
const ensureTranscriptLoaded = vi.hoisted(() =>
  vi.fn(async (_id: string): Promise<string> => 'unlisted')
)
vi.mock('../session-links', () => ({ openSessionById }))
vi.mock('../session-history-load', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session-history-load')>()),
  ensureTranscriptLoaded
}))

import { useSessionStore } from '../../stores/session-store'
import { resetReplicaSeam, seedSession } from '@test/helpers/replica-seed'
import {
  applyRestoreState,
  collectRestoreState,
  resetRestoreForTests,
  restoreAfterRelaunch
} from '../restore-state'

const INITIAL = useSessionStore.getState()
const store = () => useSessionStore.getState()

beforeEach(() => {
  useSessionStore.setState(INITIAL, true)
  resetReplicaSeam()
  resetRestoreForTests()
  openSessionById.mockClear()
  ensureTranscriptLoaded.mockReset().mockResolvedValue('unlisted')
})

describe('collectRestoreState', () => {
  it('takes the active session and every non-empty draft', () => {
    seedSession('a')
    seedSession('b')
    seedSession('c')
    store().setDraftText('draft a', 'a')
    store().setDraftText('draft b', 'b')
    useSessionStore.setState({ activeSessionId: 'c' })
    expect(collectRestoreState()).toEqual({
      activeSessionId: 'c',
      drafts: { a: 'draft a', b: 'draft b' }
    })
  })
})

describe('applyRestoreState', () => {
  it('opens the session and puts drafts back on the sessions it knows', async () => {
    seedSession('a')
    await applyRestoreState({ activeSessionId: 'a', drafts: { a: 'hello' } })
    expect(openSessionById).toHaveBeenCalledWith('a')
    expect(store().sessions.a.draftText).toBe('hello')
  })

  it('loads a listed session to put its draft back, and skips an unknown one', async () => {
    ensureTranscriptLoaded.mockImplementation(async (id: string) => {
      if (id !== 'listed') return 'unlisted'
      seedSession('listed')
      return 'loaded'
    })
    await applyRestoreState({ activeSessionId: null, drafts: { listed: 'x', gone: 'y' } })
    expect(openSessionById).not.toHaveBeenCalled()
    expect(store().sessions.listed.draftText).toBe('x')
    expect(store().sessions.gone).toBeUndefined()
  })

  it('a draft typed since the restart wins', async () => {
    seedSession('a')
    store().setDraftText('new', 'a')
    await applyRestoreState({ activeSessionId: null, drafts: { a: 'old' } })
    expect(store().sessions.a.draftText).toBe('new')
  })
})

describe('restoreAfterRelaunch', () => {
  it('takes the record once and applies it once', async () => {
    seedSession('a')
    const takeRestore = vi.fn(async () => ({ activeSessionId: 'a', drafts: { a: 'kept' } }))
    ;(globalThis as any).window.api = { takeRestore }
    await restoreAfterRelaunch()
    await restoreAfterRelaunch()
    expect(takeRestore).toHaveBeenCalledTimes(1)
    expect(openSessionById).toHaveBeenCalledTimes(1)
    expect(store().sessions.a.draftText).toBe('kept')
  })

  it('nothing to take: nothing happens', async () => {
    ;(globalThis as any).window.api = { takeRestore: vi.fn(async () => null) }
    await restoreAfterRelaunch()
    expect(openSessionById).not.toHaveBeenCalled()
  })
})
