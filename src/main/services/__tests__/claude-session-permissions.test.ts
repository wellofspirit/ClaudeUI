/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Test ClaudeSession's permission mode logic using a minimal mock.
// We replicate just enough of the class to exercise the setPermissionMode
// method and init-message/status-message sync without pulling in Electron/SDK deps.
// ---------------------------------------------------------------------------

type SendFn = (channel: string, ...args: unknown[]) => void

interface MockQuery {
  setPermissionMode(mode: string): Promise<void>
}

/**
 * Minimal replica of ClaudeSession's permission-mode-related logic.
 * Mirrors the real implementation so the tests validate the actual behavior.
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

  /** Mirrors claude-session.ts setPermissionMode — including localAuto handling */
  async setPermissionMode(mode: string): Promise<void> {
    const previousMode = this.permissionMode

    // localAuto is our own mode — SDK runs as acceptEdits underneath
    if (mode === 'localAuto') {
      this.permissionMode = mode
      this.send('session:permission-mode', mode)
      if (this.activeQuery) {
        await this.activeQuery.setPermissionMode('acceptEdits')
      }
      return
    }

    this.permissionMode = mode
    this.send('session:permission-mode', mode)
    if (this.activeQuery) {
      try {
        await this.activeQuery.setPermissionMode(mode)
      } catch (err) {
        if (mode === 'auto') {
          // SDK rejected auto mode — fall back to local auto
          this.permissionMode = 'localAuto'
          this.send('session:permission-mode', 'localAuto')
          await this.activeQuery.setPermissionMode('acceptEdits')
          return
        }
        // Other mode changes that fail — revert to previous
        this.permissionMode = previousMode
        this.send('session:permission-mode', previousMode)
        throw err
      }
    }
  }

  /** Simulates receiving a system.init message and syncing permissionMode.
   *  Suppresses sync when in localAuto — SDK reports acceptEdits underneath. */
  handleInitMessage(msg: { permissionMode?: string }): void {
    const initMode = msg.permissionMode
    if (initMode && initMode !== this.permissionMode && this.permissionMode !== 'localAuto') {
      this.permissionMode = initMode
      this.send('session:permission-mode', initMode)
    }
  }

  /** Simulates receiving a system.status message and syncing permissionMode.
   *  Suppresses sync when in localAuto — SDK reports acceptEdits underneath. */
  handleStatusMessage(msg: { permissionMode?: string }): void {
    const newMode = msg.permissionMode
    if (newMode && newMode !== this.permissionMode && this.permissionMode !== 'localAuto') {
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
      await session.setPermissionMode('acceptEdits')
      expect(session.permissionMode).toBe('acceptEdits')
      expect(session.sent).toEqual([{ channel: 'session:permission-mode', args: ['acceptEdits'] }])
    })

    it('forwards mode to active query', async () => {
      const setMode = vi.fn().mockResolvedValue(undefined)
      session.activeQuery = { setPermissionMode: setMode }

      await session.setPermissionMode('plan')
      expect(setMode).toHaveBeenCalledWith('plan')
      expect(session.permissionMode).toBe('plan')
    })

    it('reverts non-auto modes on SDK rejection', async () => {
      session.permissionMode = 'default'
      const setMode = vi.fn().mockRejectedValue(new Error('unsupported mode'))
      session.activeQuery = { setPermissionMode: setMode }

      await expect(session.setPermissionMode('plan')).rejects.toThrow('unsupported mode')
      expect(session.permissionMode).toBe('default')
      expect(session.sent).toEqual([
        { channel: 'session:permission-mode', args: ['plan'] },
        { channel: 'session:permission-mode', args: ['default'] }
      ])
    })

    it('does not revert when no active query (no error possible)', async () => {
      session.activeQuery = null
      await session.setPermissionMode('plan')
      expect(session.permissionMode).toBe('plan')
    })

    it('cycles through standard modes correctly', async () => {
      const modes = ['default', 'acceptEdits', 'plan']
      for (const mode of modes) {
        await session.setPermissionMode(mode)
        expect(session.permissionMode).toBe(mode)
      }
    })
  })

  describe('localAuto fallback', () => {
    it('falls back to localAuto when SDK rejects auto', async () => {
      session.permissionMode = 'default'
      const setMode = vi
        .fn()
        .mockRejectedValueOnce(new Error('auto mode gate failed')) // rejects 'auto'
        .mockResolvedValue(undefined) // accepts 'acceptEdits'
      session.activeQuery = { setPermissionMode: setMode }

      // Should NOT throw — auto rejection is handled gracefully
      await session.setPermissionMode('auto')

      expect(session.permissionMode).toBe('localAuto')
      // Sent 'auto' optimistically, then 'localAuto' on fallback
      expect(session.sent).toEqual([
        { channel: 'session:permission-mode', args: ['auto'] },
        { channel: 'session:permission-mode', args: ['localAuto'] }
      ])
      // SDK was called with 'auto' (rejected), then 'acceptEdits' (accepted)
      expect(setMode).toHaveBeenCalledWith('auto')
      expect(setMode).toHaveBeenCalledWith('acceptEdits')
    })

    it('sets SDK to acceptEdits when directly entering localAuto', async () => {
      const setMode = vi.fn().mockResolvedValue(undefined)
      session.activeQuery = { setPermissionMode: setMode }

      await session.setPermissionMode('localAuto')

      expect(session.permissionMode).toBe('localAuto')
      expect(setMode).toHaveBeenCalledWith('acceptEdits')
      expect(setMode).not.toHaveBeenCalledWith('localAuto')
      expect(session.sent).toEqual([{ channel: 'session:permission-mode', args: ['localAuto'] }])
    })

    it('handles localAuto without active query (pre-session)', async () => {
      session.activeQuery = null
      await session.setPermissionMode('localAuto')
      expect(session.permissionMode).toBe('localAuto')
      expect(session.sent).toEqual([{ channel: 'session:permission-mode', args: ['localAuto'] }])
    })

    it('auto mode succeeds when SDK accepts it (paid Anthropic plans)', async () => {
      const setMode = vi.fn().mockResolvedValue(undefined)
      session.activeQuery = { setPermissionMode: setMode }

      await session.setPermissionMode('auto')

      // SDK accepted — stays as 'auto', not 'localAuto'
      expect(session.permissionMode).toBe('auto')
      expect(setMode).toHaveBeenCalledWith('auto')
      expect(setMode).toHaveBeenCalledTimes(1) // no fallback to acceptEdits
    })
  })

  describe('init message sync', () => {
    it('syncs when CLI falls back from auto to default', () => {
      session = new TestClaudeSession('auto')
      session.handleInitMessage({ permissionMode: 'default' })
      expect(session.permissionMode).toBe('default')
      expect(session.sent).toEqual([{ channel: 'session:permission-mode', args: ['default'] }])
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

    it('suppresses init sync when in localAuto mode', () => {
      session = new TestClaudeSession('localAuto')
      // SDK reports 'acceptEdits' (the underlying mode) — should be ignored
      session.handleInitMessage({ permissionMode: 'acceptEdits' })
      expect(session.permissionMode).toBe('localAuto')
      expect(session.sent).toEqual([])
    })

    it('suppresses init sync of default when in localAuto mode', () => {
      session = new TestClaudeSession('localAuto')
      session.handleInitMessage({ permissionMode: 'default' })
      expect(session.permissionMode).toBe('localAuto')
      expect(session.sent).toEqual([])
    })
  })

  describe('status message sync', () => {
    it('updates mode when CLI changes it', () => {
      session.handleStatusMessage({ permissionMode: 'plan' })
      expect(session.permissionMode).toBe('plan')
      expect(session.sent).toEqual([{ channel: 'session:permission-mode', args: ['plan'] }])
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

    it('suppresses status sync when in localAuto mode', () => {
      session.permissionMode = 'localAuto'
      // SDK reports 'acceptEdits' — should be ignored to preserve localAuto
      session.handleStatusMessage({ permissionMode: 'acceptEdits' })
      expect(session.permissionMode).toBe('localAuto')
      expect(session.sent).toEqual([])
    })

    it('suppresses any status sync when in localAuto mode', () => {
      session.permissionMode = 'localAuto'
      session.handleStatusMessage({ permissionMode: 'default' })
      expect(session.permissionMode).toBe('localAuto')
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

    it('accepts localAuto as initial mode', () => {
      expect(new TestClaudeSession('localAuto').permissionMode).toBe('localAuto')
    })

    it('accepts all valid modes', () => {
      for (const mode of [
        'default',
        'acceptEdits',
        'bypassPermissions',
        'plan',
        'dontAsk',
        'auto',
        'localAuto'
      ]) {
        expect(new TestClaudeSession(mode).permissionMode).toBe(mode)
      }
    })
  })
})
