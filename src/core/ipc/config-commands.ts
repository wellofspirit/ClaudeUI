/**
 * The config / worktree command surface — ONE declaration, both transports.
 *
 * Every entry here used to be an inline `handleIpc({...})` in `session.ipc.ts`
 * with no remote twin, which made it desktop-only by omission rather than by
 * decision. The headless ruling (2026-08-17) is that **everything is changeable
 * from the remote UI** except host-PHYSICAL verbs, so these had to reach the
 * WebSocket transport — and the ADR-008/051 one-implementation rule says they
 * must reach it as the SAME function, not a mirrored copy.
 *
 * So they moved here, as transport-agnostic registrations in the
 * `stream-watch.ts` / `git-watch.ts` shape: `session.ipc.ts` spreads them with
 * `handleIpc`, `remote-handlers.ts` with `handleRemote`, and both spread the SAME
 * DECLARATION — one factory, one body per channel, written once. (The factory is
 * called once per registrar, so the two transports hold distinct closures over
 * the same code; unlike `AUTOMATION_COMMANDS`, which is a module constant and
 * therefore literally the same handler object. What guarantees they cannot
 * DISAGREE is the registry's declaration-conflict throw, and this file is why
 * that throw stays unreachable rather than merely un-triggered.)
 *
 * Six families, and why each one is remote-reachable:
 *
 *  - `worktree:*` (`git`) — creating/removing a worktree is `git` work on the
 *    host's repos, exactly like the `git:*` mutations that have been remote for
 *    a while. Nothing here opens a picker or a window.
 *  - `config:*` engine/vendor/opencode settings (`config`) — the same class of
 *    setting as `config:save-settings`, which has always been on both surfaces.
 *  - `opencode-agents:*` (`config`, except `generate`) — agent files under the
 *    opencode config dirs. `generate` is `chat`: it spends model tokens.
 *  - `mcp:*` writes (`config`) — MCP server config and the live per-session
 *    toggles. The read half (`mcp:load-servers`, `mcp:read-disabled`,
 *    `mcp:status`) was already remote; splitting read from write across
 *    transports was the accident.
 *  - `proxy:test-connection` (`config`) — a probe, not a mutation, but it is
 *    the button next to the proxy fields and those are remote-editable.
 *  - `usage:refresh-prices` (`config` since ADR-056) — spawns a LOCAL opencode
 *    server to read its price table. Host-side work, but not host-PHYSICAL: no
 *    window, no dialog, no console.
 *
 * **Transport-agnostic, and free of the transport half of Electron.**
 * `remote-handlers.ts` imports this module and the src/core extraction (S2)
 * carries it into a headless server, so nothing here touches `ipcMain`, `dialog`,
 * `BrowserWindow` or an `IpcMainInvokeEvent` — the envelope wrapper lives in
 * `safe-handler.ts` for the same reason. It is NOT Electron-free at runtime,
 * though, and saying so would be a lie the S2 seam work would trip over: two
 * imports still reach `app` transitively — `opencode/OpencodeServerManager` and
 * `pi/model-discovery` → `pi/pi-locate`, both for `app.getPath`-class lookups of
 * the vendored binaries. Those are S2's seam to cut, not this series'.
 *
 * **Caller-supplied ids are validated HERE, at the perimeter** (`engineId`,
 * `vendorId`, agent `name`) — see {@link assertSafeIdSegment}. The services that
 * build the paths re-check containment themselves; this is the first of the two
 * layers, and it is the one that turns a traversal into a refusal before any
 * service is entered at all.
 *
 * NOT here, deliberately: `session:pick-folder`, `app:open-in-vscode`,
 * `window:*` (host-physical, capability `host`), and the vendor/account
 * credential surfaces (`auth:*`, `account:*`, `vendor-auth:*`,
 * `shared-provider:*` writes) — those land with their remote OAuth handling in
 * a later series and stay desktop-registered until then.
 */

import type { SessionManager } from '../services/session-manager'
import { safeHandler } from './safe-handler'
import type { CommandRegistration } from './command-registry'
import {
  saveSlashCommands,
  loadEngineConfig,
  saveEngineConfig,
  loadVendorConfig,
  saveVendorConfig
} from '../services/ui-config'
import type { SlashCommandCache } from '../services/ui-config'
import {
  saveMcpServers,
  removeMcpServer,
  readDisabledMcpServers,
  writeDisabledMcpServers
} from '../services/claude-mcp'
import {
  createWorktree,
  getWorktreeStatus,
  removeWorktree,
  listWorktrees
} from '../services/worktree'
import { invalidateOpencodeModelCache } from '../opencode/model-discovery'
import { invalidatePiModelCache } from '../pi/model-discovery'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import {
  readOpencodeNativeConfig,
  writeOpencodeNativeConfig,
  migrateOpencodeConfigToNative
} from '../opencode/opencode-config'
import { readOpencodeNativeRaw, patchOpencodeNativeRaw } from '../opencode/opencode-native-raw'
import {
  listAgents,
  readAgent,
  saveAgent,
  deleteAgent,
  setAgentDisabled
} from '../opencode/opencode-agents'
import type { OpencodeAgentInput } from '../opencode/opencode-agents'
import { generateAgent } from '../opencode/agent-generate'
import { refreshPrices } from '../services/opencode-pricing'
import { socks5Connect } from '../services/socks-bridge'
import { assertSafeIdSegment } from '../services/path-containment'
import type {
  EngineConfig,
  VendorConfig,
  OpencodeConfigSettings,
  ProxySettings,
  RawConfigPatch
} from '../../shared/types'

// ---------------------------------------------------------------------------
// Proxy connectivity probe
// ---------------------------------------------------------------------------

/**
 * Test proxy connectivity by making a real HTTPS request through the proxy
 * to api.anthropic.com. A 401 (Unauthorized) proves the proxy works — we're
 * testing the tunnel, not the API key.
 */
async function testProxyConnection(
  proxy: ProxySettings
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const http = await import('node:http')
  const tls = await import('node:tls')

  const start = Date.now()
  const TARGET_HOST = 'api.anthropic.com'
  const TARGET_PORT = 443
  const TIMEOUT_MS = 10_000

  /** Upgrade a raw socket to TLS, send a GET, and check the HTTP status. */
  function verifyThroughTls(
    rawSocket: import('node:net').Socket
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        tlsSocket.destroy()
        resolve({ ok: false, latencyMs: Date.now() - start, error: 'TLS handshake timed out' })
      }, TIMEOUT_MS)

      const tlsSocket = tls.connect({ socket: rawSocket, servername: TARGET_HOST }, () => {
        // TLS established — send a minimal HTTP request
        tlsSocket.write(
          `GET /v1/models HTTP/1.1\r\nHost: ${TARGET_HOST}\r\nConnection: close\r\n\r\n`
        )
      })

      tlsSocket.once('data', (chunk: Buffer) => {
        clearTimeout(timer)
        tlsSocket.destroy()
        const head = chunk.toString('utf8', 0, Math.min(chunk.length, 128))
        const statusMatch = head.match(/^HTTP\/\d\.\d (\d{3})/)
        if (statusMatch) {
          // Any HTTP response (even 401) means the proxy routed traffic successfully
          resolve({ ok: true, latencyMs: Date.now() - start })
        } else {
          resolve({
            ok: false,
            latencyMs: Date.now() - start,
            error: 'Unexpected response from server'
          })
        }
      })

      tlsSocket.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, latencyMs: Date.now() - start, error: `TLS error: ${err.message}` })
      })
    })
  }

  if (proxy.type === 'socks5') {
    // SOCKS5 handshake (RFC 1928) → connect to target → TLS verify.
    // LOW-RW5: the handshake is socks-bridge.ts's socks5Connect. The hand-rolled
    // copy that used to live here assumed one SOCKS5 message per TCP chunk, so a
    // split greeting/CONNECT reply failed the proxy test spuriously.
    return new Promise((resolve) => {
      let settled = false
      // The outer 10s budget stays authoritative (socks5Connect's own 15s
      // internal timeout would otherwise outlive it).
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ ok: false, latencyMs: Date.now() - start, error: 'Connection timed out (10s)' })
      }, TIMEOUT_MS)

      socks5Connect(
        {
          socksHost: proxy.hostname,
          socksPort: proxy.port,
          username: proxy.username,
          password: proxy.password
        },
        TARGET_HOST,
        TARGET_PORT
      )
        .then(async ({ socket, leftover }) => {
          if (settled) {
            // Outer timeout already answered — drop the late tunnel.
            socket.destroy()
            return
          }
          settled = true
          clearTimeout(timer)
          // For TLS the client speaks first, so the proxy should not have sent
          // anything past the CONNECT reply — but never drop bytes if it did.
          if (leftover.length > 0) socket.unshift(leftover)
          resolve(await verifyThroughTls(socket))
        })
        .catch((err: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ ok: false, latencyMs: Date.now() - start, error: err.message })
        })
    })
  }

  // HTTP proxy: CONNECT tunnel → TLS verify
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy()
      resolve({ ok: false, latencyMs: Date.now() - start, error: 'Connection timed out (10s)' })
    }, TIMEOUT_MS)

    const authHeader = proxy.username
      ? {
          'Proxy-Authorization':
            'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
        }
      : {}

    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 8080,
      method: 'CONNECT',
      path: `${TARGET_HOST}:${TARGET_PORT}`,
      headers: authHeader
    })

    req.on('connect', async (res, socket) => {
      clearTimeout(timer)
      if (res.statusCode !== 200) {
        socket.destroy()
        resolve({
          ok: false,
          latencyMs: Date.now() - start,
          error: `Proxy returned HTTP ${res.statusCode}`
        })
        return
      }
      // Tunnel open — verify with TLS
      const result = await verifyThroughTls(socket)
      resolve(result)
    })

    req.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, latencyMs: Date.now() - start, error: err.message })
    })

    req.end()
  })
}

// ---------------------------------------------------------------------------
// The registrations
// ---------------------------------------------------------------------------

/**
 * Every channel in this family, transport-agnostic.
 *
 * Takes the `SessionManager` explicitly (the three live MCP verbs address a
 * running session) rather than closing over module state, so each transport
 * registrar passes the manager it owns — the same convention `handlers-core.ts`
 * follows.
 */
export function configCommands(
  manager: SessionManager
): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    // -----------------------------------------------------------------------
    // Worktrees
    // -----------------------------------------------------------------------
    {
      channel: 'worktree:create',
      capability: 'git',
      kind: 'command',
      handler: safeHandler(async (cwd: string, name: string) => {
        return await createWorktree(cwd, name)
      })
    },
    {
      channel: 'worktree:status',
      capability: 'git',
      kind: 'query',
      handler: safeHandler(async (worktreePath: string, originalHead: string) => {
        return await getWorktreeStatus(worktreePath, originalHead)
      })
    },
    {
      channel: 'worktree:remove',
      capability: 'git',
      kind: 'command',
      handler: safeHandler(async (worktreePath: string, branch: string, gitRoot: string) => {
        await removeWorktree(worktreePath, branch, gitRoot)
      })
    },
    {
      channel: 'worktree:list',
      capability: 'git',
      kind: 'query',
      handler: safeHandler(async (cwd: string) => {
        return await listWorktrees(cwd)
      })
    },

    // -----------------------------------------------------------------------
    // UI / engine / vendor config (~/.claude/ui/)
    // -----------------------------------------------------------------------
    {
      channel: 'config:save-slash-commands',
      capability: 'config',
      kind: 'command',
      handler: (commands: SlashCommandCache[]) => saveSlashCommands(commands)
    },
    {
      channel: 'config:load-engine-config',
      capability: 'config',
      kind: 'query',
      handler: (engineId: string) => {
        assertSafeIdSegment(engineId, 'engineId')
        return loadEngineConfig(engineId)
      }
    },
    {
      channel: 'config:save-engine-config',
      capability: 'config',
      kind: 'command',
      handler: (engineId: string, cfg: EngineConfig) => {
        assertSafeIdSegment(engineId, 'engineId')
        saveEngineConfig(engineId, cfg)
        // Provider enable/disable + custom-provider edits change which models the
        // discovery server returns. Drop the cache so the next getEngineModels()
        // re-discovers (otherwise a disabled/re-enabled provider only reflects after
        // an app restart).
        if (engineId === 'opencode') invalidateOpencodeModelCache()
        if (engineId === 'pi') invalidatePiModelCache()
      }
    },
    {
      channel: 'config:load-vendor-config',
      capability: 'config',
      kind: 'query',
      handler: (vendorId: string) => {
        assertSafeIdSegment(vendorId, 'vendorId')
        return loadVendorConfig(vendorId)
      }
    },
    {
      channel: 'config:save-vendor-config',
      capability: 'config',
      kind: 'command',
      handler: (vendorId: string, cfg: VendorConfig) => {
        assertSafeIdSegment(vendorId, 'vendorId')
        saveVendorConfig(vendorId, cfg)
      }
    },

    // opencode engine-native settings — read/write opencode's OWN config file.
    // The load handler triggers the one-time migration from the private store when
    // the opencode binary is available. modelAllowlist stays ClaudeUI-private.
    {
      channel: 'config:load-opencode-settings',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(async () => {
        if (opencodeServerManager.isBinaryAvailable()) {
          migrateOpencodeConfigToNative()
        }
        const native = readOpencodeNativeConfig()
        const privCfg = loadEngineConfig('opencode')
        const modelAllowlist = privCfg.opencodeConfig?.modelAllowlist
        const result: OpencodeConfigSettings = {
          ...native,
          ...(modelAllowlist !== undefined ? { modelAllowlist } : {})
        }
        return result
      })
    },
    {
      channel: 'config:save-opencode-settings',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (settings: OpencodeConfigSettings) => {
        // Write the six native fields to opencode's own config file.
        const { modelAllowlist, ...nativeFields } = settings
        writeOpencodeNativeConfig(nativeFields)
        // Route modelAllowlist to the private EngineConfig, preserving autoMode/sandbox/proxy.
        // The private opencodeConfig only holds modelAllowlist now (six native fields moved to disk).
        const engCfg = loadEngineConfig('opencode')
        const nextOpencodeConfig: OpencodeConfigSettings | undefined =
          modelAllowlist !== undefined && Object.keys(modelAllowlist).length > 0
            ? { modelAllowlist }
            : engCfg.opencodeConfig?.modelAllowlist &&
                Object.keys(engCfg.opencodeConfig.modelAllowlist).length > 0
              ? { modelAllowlist: engCfg.opencodeConfig.modelAllowlist }
              : undefined
        saveEngineConfig('opencode', {
          ...engCfg,
          opencodeConfig: nextOpencodeConfig
        })
        // Provider changes affect the discoverable model set.
        invalidateOpencodeModelCache()
      })
    },

    // Raw (non-lossy) opencode config access for the schema-driven settings editor.
    // Reads opencode's own config file verbatim; patches literal opencode field
    // names as jsonc leaf edits (comment-safe). Unlike save-opencode-settings this
    // never projects — it writes exactly the paths the UI names.
    {
      channel: 'config:read-opencode-native-raw',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(async () => readOpencodeNativeRaw())
    },
    {
      channel: 'config:patch-opencode-native',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (patches: RawConfigPatch[]) => {
        patchOpencodeNativeRaw(patches)
        // Capability edits (attachment/modalities/…) change model discovery.
        invalidateOpencodeModelCache()
      })
    },

    // -----------------------------------------------------------------------
    // opencode agent CRUD — list/read/save/delete/disable custom + built-in agents
    // -----------------------------------------------------------------------
    {
      channel: 'opencode-agents:list',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(async (cwd?: string) => listAgents(cwd))
    },
    {
      channel: 'opencode-agents:read',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(async (name: string, scope: string, cwd?: string) => {
        assertSafeIdSegment(name, 'agent name')
        return readAgent(name, scope as 'global' | 'project', cwd)
      })
    },
    {
      channel: 'opencode-agents:save',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (input: OpencodeAgentInput, cwd?: string) => {
        assertSafeIdSegment(input?.name, 'agent name')
        return saveAgent(input, cwd)
      })
    },
    {
      channel: 'opencode-agents:delete',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (name: string, scope: string, cwd?: string) => {
        assertSafeIdSegment(name, 'agent name')
        return deleteAgent(name, scope as 'global' | 'project', cwd)
      })
    },
    {
      channel: 'opencode-agents:set-disabled',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(
        async (name: string, scope: string, cwd: string | undefined, disabled: boolean) => {
          assertSafeIdSegment(name, 'agent name')
          return setAgentDisabled(name, scope as 'global' | 'project', cwd, disabled)
        }
      )
    },
    // `chat`, not `config`: this one spends model tokens.
    {
      channel: 'opencode-agents:generate',
      capability: 'chat',
      kind: 'command',
      handler: safeHandler(async (description: string, cwd?: string) =>
        generateAgent(description, cwd)
      )
    },

    // -----------------------------------------------------------------------
    // MCP writes (Claude-only for the live verbs: capabilities.hostedMcp AND
    // method presence — opencode advertises hostedMcp:true but does not
    // implement the MCP methods)
    // -----------------------------------------------------------------------
    {
      channel: 'mcp:toggle',
      capability: 'config',
      kind: 'command',
      sessionIdArg: 0,
      handler: safeHandler(async (routingId: string, serverName: string, enabled: boolean) => {
        const session = manager.get(routingId)
        if (!session) throw new Error('No active session')
        if (!session.capabilities.hostedMcp || !session.mcpToggleServer)
          throw new Error('Provider does not support hosted MCP')
        await session.mcpToggleServer(serverName, enabled)
      })
    },
    {
      channel: 'mcp:reconnect',
      capability: 'config',
      kind: 'command',
      sessionIdArg: 0,
      handler: safeHandler(async (routingId: string, serverName: string) => {
        const session = manager.get(routingId)
        if (!session) throw new Error('No active session')
        if (!session.capabilities.hostedMcp || !session.mcpReconnectServer)
          throw new Error('Provider does not support hosted MCP')
        await session.mcpReconnectServer(serverName)
      })
    },
    {
      channel: 'mcp:set-servers',
      capability: 'config',
      kind: 'command',
      sessionIdArg: 0,
      handler: safeHandler(async (routingId: string, servers: Record<string, unknown>) => {
        const session = manager.get(routingId)
        if (!session) throw new Error('No active session')
        if (!session.capabilities.hostedMcp || !session.mcpSetServers)
          throw new Error('Provider does not support hosted MCP')
        return await session.mcpSetServers(servers)
      })
    },
    // MCP config file writes (direct file access, no session needed)
    {
      channel: 'mcp:save-servers',
      capability: 'config',
      kind: 'command',
      handler: (scope: string, servers: Record<string, unknown>, cwd?: string) =>
        saveMcpServers(scope as 'user' | 'project' | 'local', servers as never, cwd)
    },
    {
      channel: 'mcp:remove-server',
      capability: 'config',
      kind: 'command',
      handler: (scope: string, serverName: string, cwd?: string) =>
        removeMcpServer(scope as 'user' | 'project' | 'local', serverName, cwd)
    },
    // MCP disabled state (direct ~/.claude.json access, no session needed)
    {
      channel: 'mcp:toggle-disabled',
      capability: 'config',
      kind: 'command',
      handler: async (cwd: string, serverName: string, enabled: boolean) => {
        const disabled = readDisabledMcpServers(cwd)
        let updated: string[]
        if (enabled) {
          updated = disabled.filter((n) => n !== serverName)
        } else {
          updated = disabled.includes(serverName) ? disabled : [...disabled, serverName]
        }
        writeDisabledMcpServers(cwd, updated)
      }
    },

    // -----------------------------------------------------------------------
    // Proxy probe + opencode price refresh
    // -----------------------------------------------------------------------
    {
      channel: 'proxy:test-connection',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (proxy: ProxySettings) => {
        return await testProxyConnection(proxy)
      })
    },
    // Phase 9b: fetch opencode pricing from /config/providers, persist + register.
    // Spawns a LOCAL opencode server — host-side work, not host-physical, so it
    // rides the everything-remote ruling like the rest of this file.
    {
      channel: 'usage:refresh-prices',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async () => refreshPrices())
    }
  ]
}
