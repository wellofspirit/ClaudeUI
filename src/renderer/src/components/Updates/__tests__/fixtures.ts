/**
 * Shared fixtures for the Updates panel's specs: an app-update view and a
 * harness updates view in the mockup's states (tabs A–E).
 */
import type { AppUpdateView } from '../../../../../shared/types/app-update'
import type { HarnessUpdatesView } from '../../../../../shared/harness-types'

export const CHECKED = '2026-11-24T10:00:00.000Z'

/** A pre-release build with 3.9.1-pre.14 on offer, not downloaded (ask mode). */
export function appView(patch: Partial<AppUpdateView> = {}): AppUpdateView {
  return {
    supported: true,
    current: {
      kind: 'release',
      version: '3.9.1-pre.13',
      comparisonVersion: '3.9.1-pre.13',
      channel: 'pre-release',
      commit: 'aaaaaaa',
      dirty: false,
      ahead: 0
    },
    eligibility: { ok: true },
    settings: { channel: 'auto', effectiveChannel: 'pre-release', mode: 'ask' },
    check: { running: false, lastCheckedAt: CHECKED },
    available: {
      version: '3.9.1-pre.14',
      tag: 'v3.9.1-pre.14',
      notesUrl: 'https://github.com/wellofspirit/ClaudeUI/releases/tag/v3.9.1-pre.14',
      size: 228_000_000,
      claudeCodeVersion: '2.1.341',
      publishedAt: CHECKED
    },
    download: { phase: 'idle' },
    rebuild: { phase: 'idle' },
    rebuildAvailable: false,
    sourceConfigured: false,
    ...patch
  }
}

/** Tab A: downloaded and staged. */
export const stagedView = (patch: Partial<AppUpdateView> = {}): AppUpdateView =>
  appView({ download: { phase: 'staged', version: '3.9.1-pre.14' }, ...patch })

/** The full SHA a local build records (`build-info.json`'s `git.commit`). */
export const BUILD_COMMIT = 'e4f1a2c9b8d7c6e5f4a3b2c1d0e9f8a7b6c5d4e3'

/**
 * Tab C: a local build 5 commits past pre.13, with uncommitted changes, that
 * can rebuild. Its version is the package's (`app.getVersion()`).
 */
export function localView(patch: Partial<AppUpdateView> = {}): AppUpdateView {
  return appView({
    current: {
      kind: 'local',
      version: '3.9.0',
      comparisonVersion: '3.9.1-pre.13',
      commit: BUILD_COMMIT,
      dirty: true,
      ahead: 5
    },
    rebuildAvailable: true,
    ...patch
  })
}

/** Tab D: a rebuild running. */
export function buildingView(patch: Partial<AppUpdateView> = {}): AppUpdateView {
  return localView({
    rebuild: {
      phase: 'building',
      tree: { name: 'auto-update', branch: 'feat/auto-update', commit: 'e4f1a2c', dirty: 3 },
      startedAt: '2026-11-24T10:00:00.000Z',
      // The labels `scripts/build.mjs build:stage` prints on macOS.
      stages: [
        {
          label: 'typecheck:node ‖ typecheck:web ‖ electron-vite build',
          state: 'done',
          elapsedMs: 21_000
        },
        { label: 'stamp build-info', state: 'done', elapsedMs: 1_000 },
        { label: 'electron-builder --mac --dir', state: 'running', elapsedMs: 47_000 },
        { label: 'stamp install-marker', state: 'pending' },
        { label: 'codesign', state: 'pending' },
        { label: 'xattr -cr', state: 'pending' }
      ],
      lastLine: '• packaging platform=win32 arch=x64 electron=45.0.1'
    },
    ...patch
  })
}

/** As `git worktree list` gives them: the main checkout first, then the worktree this build is from. */
export const TREES = [
  {
    id: 'fedcba9876543210',
    name: 'main checkout',
    branch: 'pre-release',
    commit: 'abc1234',
    dirty: 0
  },
  {
    id: '0123456789abcdef',
    name: 'auto-update',
    branch: 'feat/auto-update',
    commit: 'e4f1a2c',
    dirty: 3
  }
]

/** Ask me: opencode and pi each have an update. */
export function harnessView(patch: Partial<HarnessUpdatesView> = {}): HarnessUpdatesView {
  return {
    mode: 'ask',
    available: [
      { id: 'opencode', from: '2.4.1', to: '2.5.0', choice: 'latest' },
      { id: 'pi', from: '0.71.0', to: '0.72.1', choice: 'tested' }
    ],
    status: { running: false, lastCheckedAt: CHECKED, results: [] },
    skipped: {},
    ...patch
  }
}
