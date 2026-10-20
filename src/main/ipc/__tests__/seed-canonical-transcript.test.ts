/**
 * @vitest-environment node
 *
 * Canonical's resume seed reads a NON-FORK Claude transcript content-first
 * (`deferStatusLine`): the cost pass is most of a big transcript's read time, and
 * `sendPrompt` waits on this seed. The totals reach canonical through the resumed
 * `ClaudeSession`'s own seed instead (see `claude-session-resume-seed`). A fork
 * has no such seed — its totals come only from this anchored read — so a fork,
 * and every other engine, reads in full.
 *
 * Only the seam is driven: `readSessionHistory` is the spy, and the options it is
 * handed are the assertion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../core/services/claude-transcript-locator', () => ({
  claudeProjectKeyFor: () => '-r-repo'
}))
const { readSessionHistory } = vi.hoisted(() => ({
  readSessionHistory: vi.fn(
    async (
      _id: string,
      _key: string,
      _anchor?: string,
      _engine?: string,
      _options?: { deferStatusLine?: boolean }
    ) => ({
      messages: [],
      taskNotifications: [],
      customTitle: null,
      statusLine: null as unknown,
      agentIdToToolUseId: {},
      warnings: []
    })
  )
}))
vi.mock('../../../core/services/engine-history', () => ({ readSessionHistory }))

// Import AFTER mocks.
import { seedCanonicalTranscript } from '../../../core/ipc/seed-canonical-transcript'
import { syncCore } from '../../../core/services/sync-host'
import type { EngineId, StatusLineData } from '../../../shared/types'

const RID = 'rid-seed'
const optionsOf = (): unknown => readSessionHistory.mock.calls[0]?.[4]

afterEach(() => {
  syncCore.resetCanonicalForTests()
  vi.clearAllMocks()
})

describe('seedCanonicalTranscript — content-first for a non-fork Claude resume', () => {
  it('defers the status line for a Claude resume with no anchor', async () => {
    await seedCanonicalTranscript(RID, 'sess', '/r/repo', undefined, 'claude')
    expect(optionsOf()).toEqual({ deferStatusLine: true })
  })

  it('a caller that omits engineId is Claude too (the legacy default)', async () => {
    await seedCanonicalTranscript(RID, 'sess', '/r/repo')
    expect(optionsOf()).toEqual({ deferStatusLine: true })
  })

  it('reads a FORK in full: its totals come only from this anchored read', async () => {
    await seedCanonicalTranscript(RID, 'sess', '/r/repo', 'anchor-uuid', 'claude')
    expect(optionsOf()).toBeUndefined()
    expect(readSessionHistory.mock.calls[0]?.[2]).toBe('anchor-uuid')
  })

  it.each<EngineId>(['codex', 'opencode', 'pi'])('leaves %s on the unchanged read', async (id) => {
    await seedCanonicalTranscript(RID, 'sess', '/r/repo', undefined, id)
    expect(readSessionHistory.mock.calls[0]?.slice(0, 4)).toEqual([
      'sess',
      '-r-repo',
      undefined,
      id
    ])
    expect(optionsOf()).toBeUndefined()
  })

  it('a deferred (null) status line does not overwrite the one canonical already holds', async () => {
    const held = { totalCostUsd: 1.5, totalInputTokens: 7 } as StatusLineData
    syncCore.emit('session:created', [RID, { cwd: '/r/repo', resumeSessionId: 'sess' }])
    syncCore.emit('session:status-line', [RID, held])
    await seedCanonicalTranscript(RID, 'sess', '/r/repo', undefined, 'claude')
    expect(syncCore.getCanonicalState().sessions[RID].statusLine).toEqual(held)
  })
})
