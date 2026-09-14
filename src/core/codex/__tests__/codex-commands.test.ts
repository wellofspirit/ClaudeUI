import { describe, expect, it, vi } from 'vitest'
import { codexCommands, CODEX_CHANNELS } from '../../ipc/codex-commands'
import { CommandRegistry, hostConnection } from '../../ipc/command-registry'
import type { SessionManager } from '../../services/session-manager'

vi.mock('../../auth/CodexAuthProvider', () => ({
  codexAuthProvider: {
    status: vi.fn(),
    loginStart: vi.fn(),
    loginStatus: vi.fn(),
    loginCancel: vi.fn()
  }
}))
vi.mock('../../services/db', () => ({ appendAuditLog: vi.fn() }))
vi.mock('../codex-config', () => ({
  readCodexConfig: vi.fn(async () => {
    throw new Error('Codex is not installed')
  }),
  writeCodexConfig: vi.fn(async () => ({ status: 'ok', version: 'v2' }))
}))
vi.mock('../rules-sync', () => ({
  codexRulesStatus: vi.fn(() => ({
    path: '/tmp/claudeui.rules',
    rules: 2,
    skipped: 0,
    syncedAt: null,
    upToDate: false
  })),
  syncCodexRulesFile: vi.fn(() => ({ wrote: true, path: '/tmp/claudeui.rules', skipped: [] }))
}))
vi.mock('../codex-mcp-bridge', () => ({
  collectClaudeMcpForCodex: vi.fn(() => ({ servers: { docs: {} }, skipped: ['legacy'] }))
}))

function fixture(engineId = 'codex') {
  const session = {
    engineId,
    resolveCodexApproval: vi.fn()
  }
  const manager = {
    get: (id: string) => (id === 'native-root' ? session : undefined)
  } as unknown as SessionManager
  const registry = new CommandRegistry()
  for (const command of codexCommands(manager))
    for (const transport of ['desktop', 'remote'] as const)
      registry.register({ ...command, transport })
  return { session, registry }
}

describe('native command authorization', () => {
  it('registers exactly the native approval + auth channels', () => {
    const { registry } = fixture()
    // Model and effort now travel over the engine-neutral `session:set-model` /
    // `session:set-effort` commands, so no native settings channel survives.
    // ADR-068 §1 deleted the native device-code login from the product, and with
    // it the three `codex:login-*` channels; `codex:auth-status` stays as the
    // availability + model-count query.
    expect([...CODEX_CHANNELS]).toEqual([
      'session:codex-approval',
      'codex:auth-status',
      // Slice 5a: Codex's own config.toml, read/written through the app-server.
      'codex-config:read',
      'codex-config:write',
      'codex:recompile-rules'
    ])
    expect(registry.channels('remote')).toEqual([...CODEX_CHANNELS].sort())
  })

  it('answers native approvals with `chat`, and keeps the auth read behind `config`', async () => {
    const { registry, session } = fixture()
    const connection = { ...hostConnection(), grants: new Set(['chat'] as const) }
    await registry.dispatch(
      'session:codex-approval',
      'remote',
      ['native-root', 'pending', 'cancel'],
      connection
    )
    expect(session.resolveCodexApproval).toHaveBeenCalledExactlyOnceWith('pending', 'cancel')
    // A chat-only connection must not reach the account surface.
    await expect(registry.dispatch('codex:auth-status', 'remote', [], connection)).rejects.toThrow(
      'config'
    )
  })

  it.each(['desktop', 'remote'] as const)(
    'validates the native approval reply and engine on %s',
    async (transport) => {
      const { registry } = fixture()
      await expect(
        fixture('claude').registry.dispatch(
          'session:codex-approval',
          transport,
          ['native-root', 'pending', 'accept'],
          hostConnection()
        )
      ).rejects.toThrow('live Codex')
      await expect(
        registry.dispatch(
          'session:codex-approval',
          transport,
          ['native-root', 'pending', { acceptWithExecpolicyAmendment: {} }],
          hostConnection()
        )
      ).rejects.toThrow('Invalid')
      await expect(
        registry.dispatch('session:codex-approval', transport, [''], hostConnection())
      ).rejects.toThrow('routing ID')
    }
  )
})

describe('Codex config commands (Slice 5a)', () => {
  it('answers a failed read as a STATE the page renders, never as a throw', async () => {
    const { registry } = fixture()
    // The Codex page self-gates exactly as the pi and opencode panes do, so an
    // absent binary must come back as data. It still carries the rules status
    // and the inherited MCP list, which do not need Codex to be installed.
    const result = (await registry.dispatch(
      'codex-config:read',
      'desktop',
      [],
      hostConnection()
    )) as {
      config: unknown
      error?: string
      rules: { rules: number }
      mcp: { inherited: string[]; skipped: string[] }
    }
    expect(result.config).toBeNull()
    expect(result.error).toContain('not installed')
    expect(result.rules.rules).toBe(2)
    expect(result.mcp).toEqual({ inherited: ['docs'], skipped: ['legacy'] })
  })

  it('refuses a malformed write at the perimeter, before the binary is reached', async () => {
    const { registry } = fixture()
    const { writeCodexConfig } = await import('../codex-config')
    for (const args of [
      [[], 'v1'],
      [[{ keyPath: '', value: 1 }], 'v1'],
      [[{ keyPath: 'a', value: 1 }], ''],
      [Array.from({ length: 65 }, () => ({ keyPath: 'a', value: 1 })), 'v1']
    ]) {
      await expect(
        registry.dispatch('codex-config:write', 'desktop', args, hostConnection())
      ).rejects.toThrow(/Invalid Codex config/)
    }
    expect(writeCodexConfig).not.toHaveBeenCalled()

    await registry.dispatch(
      'codex-config:write',
      'desktop',
      [[{ keyPath: 'model_verbosity', value: 'high' }], 'v1'],
      hostConnection()
    )
    expect(writeCodexConfig).toHaveBeenCalledExactlyOnceWith(
      [{ keyPath: 'model_verbosity', value: 'high' }],
      'v1'
    )
  })

  it('recompiles the rule file FORCED and answers the fresh status', async () => {
    const { registry } = fixture()
    const { syncCodexRulesFile } = await import('../rules-sync')
    const status = await registry.dispatch('codex:recompile-rules', 'desktop', [], hostConnection())
    // Forced: the reason to press Recompile is that the file on disk is not what
    // ClaudeUI wrote, which the content hash alone would not catch.
    expect(syncCodexRulesFile).toHaveBeenCalledExactlyOnceWith({ force: true })
    expect(status).toMatchObject({ rules: 2 })
  })

  it('keeps both config channels behind `config`, out of reach of a chat-only client', async () => {
    const { registry } = fixture()
    const connection = { ...hostConnection(), grants: new Set(['chat'] as const) }
    for (const channel of ['codex-config:read', 'codex-config:write', 'codex:recompile-rules']) {
      await expect(registry.dispatch(channel, 'remote', [], connection)).rejects.toThrow('config')
    }
  })
})
