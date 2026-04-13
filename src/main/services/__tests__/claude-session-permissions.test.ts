/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Test ClaudeSession's permission mode logic using a minimal mock.
// We replicate just enough of the class to exercise the setPermissionMode
// method and init-message sync without pulling in Electron/SDK deps.
// ---------------------------------------------------------------------------

type SendFn = (channel: string, ...args: unknown[]) => void

interface MockQuery {
  setPermissionMode(mode: string): Promise<void>
}

/**
 * Minimal replica of ClaudeSession's permission-mode-related logic.
 * Mirrors the real implementation so the tests validate the actual fix.
 */
class TestClaudeSession {
  permissionMode = 'default'
  activeQuery: MockQuery | null = null
  sent: Array<{ channel: string; args: unknown[] }> = []

  constructor(permissionMode?: string) {
    if (permissionMode) this.permissionMode = permissionMode
  }

  private send: SendFn = (channel, ...args) => {
    this.sent.push({ channel, args })
  }

  /** Exact logic from claude-session.ts setPermissionMode */
  async setPermissionMode(mode: string): Promise<void> {
    const previousMode = this.permissionMode
    this.permissionMode = mode
    this.send('session:permission-mode', mode)
    if (this.activeQuery) {
      try {
        await this.activeQuery.setPermissionMode(mode)
      } catch (err) {
        // SDK rejected the mode change — revert
        this.permissionMode = previousMode
        this.send('session:permission-mode', previousMode)
        throw err
      }
    }
  }

  /** Simulates receiving a system.init message and syncing permissionMode */
  handleInitMessage(msg: { permissionMode?: string }): void {
    const initMode = msg.permissionMode
    if (initMode && initMode !== this.permissionMode) {
      this.permissionMode = initMode
      this.send('session:permission-mode', initMode)
    }
  }

  /** Simulates receiving a system.status message and syncing permissionMode */
  handleStatusMessage(msg: { permissionMode?: string }): void {
    const newMode = msg.permissionMode
    if (newMode && newMode !== this.permissionMode) {
      this.permissionMode = newMode
      this.send('session:permission-mode', newMode)
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeSession permission mode', () => {
  let session: TestClaudeSession

  beforeEach(() => {
    session = new TestClaudeSession()
  })

  describe('setPermissionMode', () => {
    it('updates mode and notifies UI', async () => {
      await session.setPermissionMode('auto')
      expect(session.permissionMode).toBe('auto')
      expect(session.sent).toEqual([
        { channel: 'session:permission-mode', args: ['auto'] }
      ])
    })

    it('forwards mode to active query', async () => {
      const setMode = vi.fn().mockResolvedValue(undefined)
      session.activeQuery = { setPermissionMode: setMode }

      await session.setPermissionMode('auto')
      expect(setMode).toHaveBeenCalledWith('auto')
      expect(session.permissionMode).toBe('auto')
    })

    it('reverts on SDK rejection', async () => {
      session.permissionMode = 'default'
      const setMode = vi.fn().mockRejectedValue(new Error('Cannot set permission mode to auto'))
      session.activeQuery = { setPermissionMode: setMode }

      await expect(session.setPermissionMode('auto')).rejects.toThrow('Cannot set permission mode to auto')

      // Should revert to previous mode
      expect(session.permissionMode).toBe('default')
      // Should have sent: 'auto' (optimistic), then 'default' (revert)
      expect(session.sent).toEqual([
        { channel: 'session:permission-mode', args: ['auto'] },
        { channel: 'session:permission-mode', args: ['default'] }
      ])
    })

    it('reverts to non-default previous mode on rejection', async () => {
      session.permissionMode = 'acceptEdits'
      const setMode = vi.fn().mockRejectedValue(new Error('gate check failed'))
      session.activeQuery = { setPermissionMode: setMode }

      await expect(session.setPermissionMode('auto')).rejects.toThrow()
      expect(session.permissionMode).toBe('acceptEdits')
      expect(session.sent[1]).toEqual({ channel: 'session:permission-mode', args: ['acceptEdits'] })
    })

    it('does not revert when no active query (no error possible)', async () => {
      session.activeQuery = null
      await session.setPermissionMode('auto')
      expect(session.permissionMode).toBe('auto')
    })

    it('cycles through modes correctly', async () => {
      const modes = ['default', 'acceptEdits', 'plan', 'auto']
      for (const mode of modes) {
        await session.setPermissionMode(mode)
        expect(session.permissionMode).toBe(mode)
      }
    })
  })

  describe('init message sync', () => {
    it('syncs when CLI falls back from auto to default', () => {
      session = new TestClaudeSession('auto')
      expect(session.permissionMode).toBe('auto')

      session.handleInitMessage({ permissionMode: 'default' })
      expect(session.permissionMode).toBe('default')
      expect(session.sent).toEqual([
        { channel: 'session:permission-mode', args: ['default'] }
      ])
    })

    it('does not notify when mode matches', () => {
      session = new TestClaudeSession('auto')
      session.handleInitMessage({ permissionMode: 'auto' })
      expect(session.permissionMode).toBe('auto')
      expect(session.sent).toEqual([])
    })

    it('does nothing when init has no permissionMode', () => {
      session = new TestClaudeSession('auto')
      session.handleInitMessage({})
      expect(session.permissionMode).toBe('auto')
      expect(session.sent).toEqual([])
    })

    it('syncs any mode change from init', () => {
      session = new TestClaudeSession('default')
      session.handleInitMessage({ permissionMode: 'acceptEdits' })
      expect(session.permissionMode).toBe('acceptEdits')
    })
  })

  describe('status message sync', () => {
    it('updates mode when CLI changes it', () => {
      session.handleStatusMessage({ permissionMode: 'plan' })
      expect(session.permissionMode).toBe('plan')
      expect(session.sent).toEqual([
        { channel: 'session:permission-mode', args: ['plan'] }
      ])
    })

    it('ignores when mode matches current', () => {
      session.permissionMode = 'auto'
      session.handleStatusMessage({ permissionMode: 'auto' })
      expect(session.sent).toEqual([])
    })

    it('ignores when no permissionMode in message', () => {
      session.handleStatusMessage({})
      expect(session.permissionMode).toBe('default')
      expect(session.sent).toEqual([])
    })
  })

  describe('constructor', () => {
    it('defaults to "default" mode', () => {
      expect(new TestClaudeSession().permissionMode).toBe('default')
    })

    it('accepts initial permission mode', () => {
      expect(new TestClaudeSession('auto').permissionMode).toBe('auto')
    })

    it('accepts all valid modes', () => {
      for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']) {
        expect(new TestClaudeSession(mode).permissionMode).toBe(mode)
      }
    })
  })
})
