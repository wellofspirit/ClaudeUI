/**
 * A `harness:state` snapshot for renderer tests (ADR-082): every harness
 * installed at a tested version and running, except the ones named missing
 * (ClaudeUI's copy selected, not installed, installable here).
 */
import type { HarnessId, HarnessStateEntry, HarnessStateSnapshot } from '../../shared/harness-types'

export const TEST_TESTED: Record<HarnessId, string> = {
  claude: '2.1.280',
  opencode: '1.18.32',
  pi: '0.87.4',
  codex: '0.156.0'
}

export function harnessEntry(id: HarnessId, running = true): HarnessStateEntry {
  const tested = TEST_TESTED[id]
  return {
    id,
    manifest: { tested, floor: tested, ceiling: '9.0.0' },
    selection: id === 'claude' ? { source: 'bundled' } : { source: 'managed', version: 'tested' },
    resolved: {
      source: id === 'claude' ? 'bundled' : 'managed',
      version: running ? tested : null,
      path: running ? `/store/${id}/${tested}/${id}` : null,
      ...(running ? {} : { reason: `${id} ${tested} is not installed` }),
      available: running
    },
    system: { detectedAt: null, installs: [], choice: { kind: 'fallback', reason: 'none' } },
    managed: running
      ? [{ version: tested, verified: 'reviewed', installedAt: '2026-09-29T00:00:00.000Z' }]
      : [],
    installable: id !== 'claude'
  }
}

export function harnessSnapshot(
  missing: readonly HarnessId[] = [],
  patch: Partial<HarnessStateSnapshot> = {}
): HarnessStateSnapshot {
  const of = (id: HarnessId): HarnessStateEntry => harnessEntry(id, !missing.includes(id))
  return {
    harnesses: { claude: of('claude'), opencode: of('opencode'), pi: of('pi'), codex: of('codex') },
    detection: { running: false },
    installs: [],
    updates: { mode: 'ask', available: [], status: { running: false, results: [] } },
    upgradePrompt: { pending: false, candidates: [] },
    ...patch
  }
}
