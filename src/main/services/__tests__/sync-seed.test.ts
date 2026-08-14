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

const { loadSettings, loadSessionConfig, loadSlashCommands, loadClaudePermissions, listDirectories } =
  vi.hoisted(() => ({
    loadSettings: vi.fn(),
    loadSessionConfig: vi.fn(),
    loadSlashCommands: vi.fn(),
    loadClaudePermissions: vi.fn(),
    listDirectories: vi.fn()
  }))

vi.mock('../ui-config', () => ({ loadSettings, loadSessionConfig, loadSlashCommands }))
vi.mock('../claude-settings', () => ({ loadClaudePermissions }))
vi.mock('../session-history', () => ({ listDirectories }))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { seedCanonicalAppState, refreshCanonicalDirectories } from '../sync-seed'
import { syncCore } from '../sync-host'

const DIRS = [{ path: '/repo', name: 'repo', sessions: [] }]

beforeEach(() => {
  vi.clearAllMocks()
  syncCore.resetCanonicalForTests()
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
    // Seeding is not an emission: nothing entered the ring.
    expect(syncCore.getAfter(0)).toEqual([])
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
  it('re-reads the listing the session:directories-changed notify tells clients to refetch', async () => {
    await refreshCanonicalDirectories()
    expect(syncCore.getSnapshot().directories).toEqual(DIRS)

    listDirectories.mockResolvedValue([])
    await refreshCanonicalDirectories()
    expect(syncCore.getSnapshot().directories).toEqual([])
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
