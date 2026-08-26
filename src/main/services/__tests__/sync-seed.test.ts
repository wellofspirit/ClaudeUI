/**
 * @vitest-environment node
 *
 * Canonical-freshness seeds — SyncCore phase 4b Part A (A3/A4).
 *
 * These four fields have no event to be built from: before the cutover the
 * snapshot came from the desktop renderer, which had read all of them during its
 * own hydration, so canonical never needed them. After the cutover a phone that
 * connects to a freshly-booted desktop gets whatever CORE knows — and "empty
 * sidebar, default theme, no recents" is what it would get without this module.
 *
 * The sources are mocked, so what is actually asserted is the CONTRACT: which
 * fields are seeded, from which reader, and that a failing read degrades to the
 * pre-4b empty value instead of taking app boot down with it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  loadSettings,
  loadSessionConfig,
  loadSlashCommands,
  loadClaudePermissions,
  listDirectories,
  listOpencodeSessionsGlobal,
  listPiSessionsGlobal
} = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  loadSessionConfig: vi.fn(),
  loadSlashCommands: vi.fn(),
  loadClaudePermissions: vi.fn(),
  listDirectories: vi.fn(),
  listOpencodeSessionsGlobal: vi.fn(),
  listPiSessionsGlobal: vi.fn()
}))

vi.mock('../../../core/services/ui-config', () => ({
  loadSettings,
  loadSessionConfig,
  loadSlashCommands
}))
vi.mock('../../../core/services/claude-settings', () => ({ loadClaudePermissions }))
vi.mock('../../../core/services/session-history', () => ({ listDirectories }))
// F6 moved the per-client three-query merge into this module, so both other
// engines' list sources are mocked here too — unmocked they read the real
// ~/.pi and the developer's own opencode server.
vi.mock('../../../core/services/opencode-session-list', () => ({ listOpencodeSessionsGlobal }))
vi.mock('../../../core/services/pi-session-list', () => ({ listPiSessionsGlobal }))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  seedCanonicalAppState,
  refreshCanonicalDirectories,
  listAllDirectories,
  resetDirectoryRefreshStateForTests
} from '../../../core/services/sync-seed'
import { syncCore } from '../../../core/services/sync-host'

const CLAUDE_SESSION = {
  sessionId: 'cl-1',
  cwd: '/repo',
  projectKey: '-repo',
  title: 'claude',
  timestamp: 1,
  lastActivityAt: 1,
  engineId: 'claude' as const
}
const DIRS = [{ cwd: '/repo', projectKey: '-repo', folderName: 'repo', sessions: [CLAUDE_SESSION] }]

const OPENCODE_SESSION = {
  sessionId: 'oc-1',
  cwd: '/repo',
  projectKey: '-repo',
  title: 'oc',
  timestamp: 1,
  lastActivityAt: 2,
  engineId: 'opencode' as const
}
const PI_SESSION = {
  sessionId: 'pi-1',
  cwd: '/other',
  projectKey: '-other',
  title: 'pi',
  timestamp: 1,
  lastActivityAt: 3,
  engineId: 'pi' as const
}

/**
 * The ring's seq at the start of the current test. The counter is monotonic
 * across `clearRing()` by design (a client must never see a seq go backwards),
 * so `getAfter(0)` reads as "too far behind, needs a full snapshot" — null —
 * once any earlier test has emitted. Every assertion below is relative to this.
 */
let startSeq = 0

/** Ring entries this test appended. */
function ringedSince(): Array<{ channel: string; args: unknown[] }> {
  return syncCore.getAfter(startSeq) ?? []
}

beforeEach(() => {
  vi.clearAllMocks()
  syncCore.resetCanonicalForTests()
  syncCore.clearRing()
  // The emit throttle is wall-clock; several refreshes inside one millisecond is
  // a test-only shape, so the seam forgets the window between cases.
  resetDirectoryRefreshStateForTests()
  startSeq = syncCore.currentSeq()
  listOpencodeSessionsGlobal.mockResolvedValue([])
  listPiSessionsGlobal.mockResolvedValue([])
  loadSettings.mockReturnValue({ theme: 'monokai', uiFontScale: 1.2 })
  loadSessionConfig.mockReturnValue({
    recentSessions: ['rid-a', 'rid-b'],
    pinnedSessions: ['rid-a'],
    customTitles: { 'rid-a': 'Named' },
    worktreeInfoMap: { 'rid-b': { originalCwd: '/repo', path: '/wt', branch: 'wt-x' } },
    hiddenSessions: ['rid-hidden'],
    hiddenProjects: ['/old'],
    sessionEngines: { 'rid-b': { engineId: 'pi' } }
  })
  loadSlashCommands.mockReturnValue([{ name: '/compact' }])
  loadClaudePermissions.mockReturnValue({ disableAutoMode: 'disable' })
  listDirectories.mockResolvedValue(DIRS)
})

describe('seedCanonicalAppState', () => {
  it('seeds every app-level snapshot field from the same readers the renderer uses', async () => {
    await seedCanonicalAppState()
    const snap = syncCore.getSnapshot()

    // Raw on-disk settings — every client merges its own defaults over the top,
    // so shipping a merged copy would bake THIS process's defaults into another
    // client's state.
    expect(snap.settings).toEqual({ theme: 'monokai', uiFontScale: 1.2 })
    expect(snap.recentSessionIds).toEqual(['rid-a', 'rid-b'])
    expect(snap.pinnedSessionIds).toEqual(['rid-a'])
    expect(snap.customTitles).toEqual({ 'rid-a': 'Named' })
    expect(snap.worktreeInfoMap).toEqual({
      'rid-b': { originalCwd: '/repo', path: '/wt', branch: 'wt-x' }
    })
    expect(snap.hiddenSessions).toEqual(['rid-hidden'])
    expect(snap.hiddenProjects).toEqual(['/old'])
    expect(snap.sessionEngines).toEqual({ 'rid-b': { engineId: 'pi' } })
    // ADR-050: the remote client cannot read ~/.claude/settings.json itself.
    expect(snap.autoModeDisabledBySettings).toBe(true)
    expect(snap.directories).toEqual(DIRS)
    // The directory listing IS an emission now (F6) — it is the only app-level
    // seed that is also replicated state clients must see change live. Every
    // other field here is still a plain `setAppState`, so exactly ONE event.
    expect(ringedSince().map((e) => e.channel)).toEqual(['session:directories-changed'])
  })

  it('leaves sdkSkillNames alone — the renderer does not seed it either', async () => {
    // It only ever arrives on `session:skills`, at engine spawn. Seeding it from
    // a scanner would make canonical DISAGREE with the replica it now sources.
    await seedCanonicalAppState()
    expect(syncCore.getCanonicalState().sdkSkillNames).toEqual([])
    // slashCommands, by contrast, IS a cached list the renderer loads at boot.
    expect(syncCore.getCanonicalState().slashCommands).toEqual([{ name: '/compact' }])
  })

  it('degrades to empty (never throws) when a source is unreadable', async () => {
    loadSettings.mockImplementation(() => {
      throw new Error('malformed settings.json')
    })
    listDirectories.mockRejectedValue(new Error('EPERM'))

    await expect(seedCanonicalAppState()).resolves.toBeUndefined()
    const snap = syncCore.getSnapshot()
    // The failed reads degrade to exactly the pre-4b value ("empty"), and the
    // healthy ones still landed — one bad file must not blank the rest.
    expect(snap.settings).toEqual({})
    expect(snap.directories).toEqual([])
    expect(snap.recentSessionIds).toEqual(['rid-a', 'rid-b'])
  })
})

describe('refreshCanonicalDirectories', () => {
  it('replicates the listing through session:directories-changed', async () => {
    await refreshCanonicalDirectories()
    expect(syncCore.getSnapshot().directories).toEqual(DIRS)
    // Canonical is updated BY the fold, not beside it — one value, one writer.
    expect(ringedSince().map((e) => e.channel)).toEqual(['session:directories-changed'])

    // A SECOND change inside the 5 s window is deferred, not dropped (R2) — so
    // reset the window rather than sleeping through it.
    resetDirectoryRefreshStateForTests()
    listDirectories.mockResolvedValue([])
    await refreshCanonicalDirectories()
    expect(syncCore.getSnapshot().directories).toEqual([])
  })

  /**
   * R2. The trigger is the debounced RECURSIVE watcher on `~/.claude/projects`,
   * and `lastActivityAt` comes from mtime — so every assistant chunk of a long
   * turn "changes" the listing. Unthrottled that is of the order of a thousand
   * full payloads into a 5000-entry ring per turn, evicting the transcript
   * history a reconnecting client actually needs.
   */
  it('does not emit a REORDER-only change inside the throttle window', async () => {
    await refreshCanonicalDirectories()
    const afterFirst = syncCore.currentSeq()

    // Same sessions, newer mtime — exactly the shape a transcript append makes.
    listDirectories.mockResolvedValue([
      { ...DIRS[0], sessions: [{ ...CLAUDE_SESSION, lastActivityAt: 999 }] }
    ])
    await refreshCanonicalDirectories()
    await refreshCanonicalDirectories()
    expect(syncCore.currentSeq()).toBe(afterFirst)
  })

  /**
   * S3. A rename (or a generated title landing) is a visible edit, not mtime
   * churn — classifying it as reorder-only left every OTHER client showing the
   * old name until the 30 s poll.
   */
  it('treats a TITLE change as membership, not reorder churn', async () => {
    vi.useFakeTimers()
    try {
      await refreshCanonicalDirectories()
      const afterFirst = syncCore.currentSeq()

      listDirectories.mockResolvedValue([
        { ...DIRS[0], sessions: [{ ...CLAUDE_SESSION, title: 'renamed by the user' }] }
      ])
      await refreshCanonicalDirectories()
      await vi.advanceTimersByTimeAsync(6_000)

      expect(syncCore.currentSeq()).toBeGreaterThan(afterFirst)
      expect(syncCore.getSnapshot().directories[0].sessions[0].title).toBe('renamed by the user')
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * S4. The floor gated the EMIT, but every watcher tick still ran the full
   * three-engine walk — a disk tree read plus an opencode HTTP call plus a
   * `~/.pi` read — and threw the result away. Once a trailing emit is booked
   * there is nothing a further walk could publish.
   */
  it('does not even WALK once a trailing emit is booked inside the window', async () => {
    vi.useFakeTimers()
    try {
      await refreshCanonicalDirectories()
      // Book a trailing emit with a membership change.
      listDirectories.mockResolvedValue([
        { ...DIRS[0], sessions: [CLAUDE_SESSION, { ...CLAUDE_SESSION, sessionId: 'cl-2' }] }
      ])
      await refreshCanonicalDirectories()
      const walksSoFar = listDirectories.mock.calls.length

      // Further watcher ticks inside the window: no walk at all.
      await refreshCanonicalDirectories()
      await refreshCanonicalDirectories()
      expect(listDirectories.mock.calls.length).toBe(walksSoFar)

      // The booked emit still lands, so nothing was lost by skipping the walks.
      await vi.advanceTimersByTimeAsync(6_000)
      expect(syncCore.getSnapshot().directories[0].sessions.map((x) => x.sessionId)).toEqual([
        'cl-1',
        'cl-2'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a MEMBERSHIP change inside the window is deferred, never dropped', async () => {
    vi.useFakeTimers()
    try {
      await refreshCanonicalDirectories()
      const afterFirst = syncCore.currentSeq()

      // A new session appears — user-visible, so the throttle may delay it but
      // must not swallow it.
      listDirectories.mockResolvedValue([
        {
          ...DIRS[0],
          sessions: [CLAUDE_SESSION, { ...CLAUDE_SESSION, sessionId: 'cl-2' }]
        }
      ])
      await refreshCanonicalDirectories()
      expect(syncCore.currentSeq()).toBe(afterFirst) // throttled…

      await vi.advanceTimersByTimeAsync(6_000)
      expect(syncCore.currentSeq()).toBeGreaterThan(afterFirst) // …then emitted
      expect(syncCore.getSnapshot().directories[0].sessions.map((x) => x.sessionId)).toEqual([
        'cl-1',
        'cl-2'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces overlapping walks so a STALE listing cannot land after a fresh one', async () => {
    // Two refreshes racing is not merely wasteful. The ring is ORDERED, so a slow
    // walk that finishes second replaces the newer listing with its older one and
    // nothing corrects it until the next change — the sidebar simply goes back in
    // time. The guard is what makes the second request a coalesced follow-up
    // instead of a concurrent walk.
    const STALE = DIRS
    const FRESH = [
      { ...DIRS[0], sessions: [CLAUDE_SESSION, { ...CLAUDE_SESSION, sessionId: 'cl-2' }] }
    ]
    let releaseStale: () => void = () => {}
    listDirectories
      // Call 1: the SLOW walk, holding the older listing.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStale = () => resolve(STALE)
          })
      )
      // Every later walk sees the world as it now is.
      .mockImplementation(async () => FRESH)

    const first = refreshCanonicalDirectories()
    const second = refreshCanonicalDirectories() // must NOT start its own walk
    releaseStale()
    await Promise.all([first, second])
    // Drain the coalesced follow-up and any trailing (throttled) emit.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))

    // The ORDER of emissions is the assertion, because the ring is ordered and a
    // client folds it in sequence. Coalesced: the slow walk's listing lands, then
    // the follow-up's newer one.
    //
    // PRE-FIX both walked concurrently, the FAST one emitted the two-session
    // listing first and the SLOW one then emitted the one-session listing on top
    // of it — the sidebar going backwards, permanently, until the next change.
    const emitted = ringedSince().map((e) =>
      (e.args[0] as Array<{ sessions: Array<{ sessionId: string }> }>)
        .flatMap((g) => g.sessions)
        .map((x) => x.sessionId)
    )
    // Never a listing that KNOWS LESS than one already on the ring.
    expect(emitted.some((ids, i) => i > 0 && ids.length < emitted[i - 1].length)).toBe(false)
    // And the slow walk's own listing is what landed — the follow-up's newer one
    // is deferred by the throttle, not lost (the membership guard owns that).
    expect(emitted).toEqual([['cl-1']])
  })

  it('emits nothing when the listing is unchanged (the 30 s poll must not flood the ring)', async () => {
    await refreshCanonicalDirectories()
    const afterFirst = syncCore.currentSeq()
    resetDirectoryRefreshStateForTests()
    await refreshCanonicalDirectories()
    await refreshCanonicalDirectories()
    expect(syncCore.currentSeq()).toBe(afterFirst)
  })

  it('keeps the previous listing when the walk fails', async () => {
    await refreshCanonicalDirectories()
    listDirectories.mockRejectedValue(new Error('EBUSY'))
    await refreshCanonicalDirectories()
    // A stale sidebar beats an empty one — and beats a rejected promise reaching
    // the watcher's fire-and-forget call site.
    expect(syncCore.getSnapshot().directories).toEqual(DIRS)
  })
})

/**
 * F6. The merge used to run in every CLIENT, over three separate queries,
 * writing the result into that client's own `directories` — while canonical held
 * the Claude-only subset that every `sync-full` then force-projected back over
 * it. One merge, main-side, is what makes canonical and the clients the same list.
 */
describe('listAllDirectories', () => {
  it('merges opencode and pi rows into the Claude listing', async () => {
    listOpencodeSessionsGlobal.mockResolvedValue([OPENCODE_SESSION])
    listPiSessionsGlobal.mockResolvedValue([PI_SESSION])
    const merged = await listAllDirectories()
    const byKey = Object.fromEntries(merged.map((g) => [g.projectKey, g]))
    expect(byKey['-repo'].sessions.map((s2) => s2.sessionId).sort()).toEqual(['cl-1', 'oc-1'])
    // pi's cwd has no Claude group at all — the merge creates one.
    expect(byKey['-other'].sessions.map((s2) => s2.sessionId)).toEqual(['pi-1'])
  })

  it('degrades to the engines that DID answer', async () => {
    listOpencodeSessionsGlobal.mockRejectedValue(new Error('server down'))
    listPiSessionsGlobal.mockResolvedValue([PI_SESSION])
    const merged = await listAllDirectories()
    expect(merged.map((g) => g.projectKey).sort()).toEqual(['-other', '-repo'])
    // The Claude rows survive an opencode outage — this is the failure mode the
    // client-side merge documented ("a Claude-only refresh wipes opencode").
    expect(merged.find((g) => g.projectKey === '-repo')?.sessions.map((x) => x.sessionId)).toEqual([
      'cl-1'
    ])
  })

  it('propagates a CLAUDE failure so the caller keeps the previous listing', async () => {
    listDirectories.mockRejectedValue(new Error('EPERM'))
    await expect(listAllDirectories()).rejects.toThrow('EPERM')
  })
})
