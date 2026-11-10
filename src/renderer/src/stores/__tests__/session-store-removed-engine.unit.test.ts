/**
 * An engine string persisted by an older build (`codex`) must not reach a table
 * keyed by EngineId: `engineMeta()` throws on it. The welcome screen restores the
 * last pick from localStorage, so that read is validated and falls back to Claude.
 *
 * Pure store transitions, no React.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, loadLastSelectedEngineId } from '../session-store'
import { resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

beforeEach(() => {
  resetReplicaSeam()
  localStorage.clear()
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn()
  }
})

describe('loadLastSelectedEngineId — a stored engine this build no longer has', () => {
  it('falls back to claude for a stored `codex`, under either key', () => {
    localStorage.setItem('lastSelectedEngineId', 'codex')
    localStorage.setItem('lastSelectedProvider', 'codex')
    expect(loadLastSelectedEngineId()).toBe('claude')

    localStorage.removeItem('lastSelectedEngineId')
    expect(loadLastSelectedEngineId()).toBe('claude')
  })

  it('keeps a stored engine that still exists, and defaults to claude when nothing is stored', () => {
    expect(loadLastSelectedEngineId()).toBe('claude')
    localStorage.setItem('lastSelectedEngineId', 'pi')
    expect(loadLastSelectedEngineId()).toBe('pi')
  })

  it('a new session started from the restored value is a claude session and does not throw', () => {
    localStorage.setItem('lastSelectedEngineId', 'codex')
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      sessionEngines: {},
      lastSelectedEngineId: loadLastSelectedEngineId()
    })
    mirrorStoreIntoReplica()
    expect(() => useSessionStore.getState().createNewSession('r-1', '/tmp/proj')).not.toThrow()
    expect(useSessionStore.getState().sessions['r-1']?.selectedEngineId).toBe('claude')
  })
})
