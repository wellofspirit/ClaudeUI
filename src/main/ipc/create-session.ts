import type { BrowserWindow } from 'electron'
import type { SessionManager } from '../services/session-manager'
import { ClaudeSession } from '../services/claude-session'
import { loadEngineConfig, loadVendorConfig } from '../services/ui-config'
import { resolveOpencodeSpawnModel } from '../opencode/model-discovery'
import { startSocksBridge, stopSocksBridge } from '../services/socks-bridge'
import { setProxyEnv, setProxyAllSubprocesses } from '../sdk/proxy'
import { setEndpointEnv } from '../sdk/endpoint-env'
import { setModelEnv } from '../sdk/model-env'
import { logger } from '../services/logger'
import { claudeModel } from '../../shared/types'
import type {
  EngineId,
  ProxySettings,
  AnthropicEndpointSettings,
  ModelOverrideSettings
} from '../../shared/types'

// ---------------------------------------------------------------------------
// Proxy helpers
// ---------------------------------------------------------------------------

/** Build a proxy URL from proxy settings. */
function buildProxyUrl(proxy: ProxySettings): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : ''
  const scheme = proxy.type === 'socks5' ? 'socks5' : 'http'
  return `${scheme}://${auth}${proxy.hostname}:${proxy.port}`
}

/**
 * Apply or clear proxy settings for cli.js spawns.
 *
 * The proxy env vars are stored in an in-memory slot and overlaid by
 * `buildEnv()` onto each cli.js spawn's env — they are NOT written to the
 * Electron main process's `process.env`. That avoids leaking the proxy into
 * node-pty terminals, git-service subprocesses, plugin hosts, and our own
 * fetch() calls.
 *
 * - HTTP proxy: sets HTTP_PROXY directly (cli.js's bundled https-proxy-agent handles it)
 * - SOCKS5 proxy: starts a local HTTP CONNECT bridge that tunnels through SOCKS5,
 *   because cli.js has no native SOCKS5 support
 *
 * cli.js subprocess inheritance (Bash tool, MCP, LSP, shell-snapshot) is
 * controlled by `proxy.proxySubprocesses` — see `src/main/sdk/proxy.ts` and
 * `patch/subprocess-proxy-strip/`.
 */
/**
 * Apply custom Anthropic endpoint settings into the cli.js spawn env. Stores
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in module-scoped state that
 * `buildEnv()` overlays onto each spawn — never mutates the Electron main
 * process env, so PTYs / git / MCP / plugins stay clean.
 */
export function applyEndpointEnv(endpoint: AnthropicEndpointSettings | undefined): void {
  if (endpoint?.enabled && endpoint.baseUrl) {
    setEndpointEnv({
      ANTHROPIC_BASE_URL: endpoint.baseUrl,
      ANTHROPIC_AUTH_TOKEN: endpoint.authToken ?? ''
    })
    logger.info('Endpoint', `Custom Anthropic endpoint enabled: ${endpoint.baseUrl}`)
  } else {
    setEndpointEnv(null)
  }
}

/**
 * Apply model-override settings into the cli.js spawn env. Each field maps to
 * an Anthropic env var (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`).
 * Empty fields stay unset so cli.js's defaults apply to the unset families.
 */
export function applyModelEnv(model: ModelOverrideSettings | undefined): void {
  const anyValue =
    model?.enabled && (model.model || model.sonnetModel || model.opusModel || model.haikuModel)
  if (anyValue) {
    setModelEnv({
      ANTHROPIC_MODEL: model.model ?? '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: model.sonnetModel ?? '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: model.opusModel ?? '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model.haikuModel ?? ''
    })
    const parts: string[] = []
    if (model.model) parts.push(`model=${model.model}`)
    if (model.sonnetModel) parts.push(`sonnet=${model.sonnetModel}`)
    if (model.opusModel) parts.push(`opus=${model.opusModel}`)
    if (model.haikuModel) parts.push(`haiku=${model.haikuModel}`)
    logger.info('Model', `Model override enabled: ${parts.join(', ')}`)
  } else {
    setModelEnv(null)
  }
}

export async function applyProxyEnv(proxy: ProxySettings | undefined): Promise<void> {
  if (proxy?.enabled && proxy.hostname) {
    if (proxy.type === 'socks5') {
      // Start local HTTP bridge → SOCKS5
      try {
        const port = await startSocksBridge({
          socksHost: proxy.hostname,
          socksPort: proxy.port,
          username: proxy.username || undefined,
          password: proxy.password || undefined
        })
        const bridgeUrl = `http://127.0.0.1:${port}`
        setProxyEnv({ HTTP_PROXY: bridgeUrl, HTTPS_PROXY: bridgeUrl, ALL_PROXY: bridgeUrl })
        logger.info(
          'Proxy',
          `SOCKS5 proxy via bridge: socks5://${proxy.hostname}:${proxy.port} → ${bridgeUrl}`
        )
      } catch (err) {
        logger.error(
          'Proxy',
          `Failed to start SOCKS5 bridge: ${err instanceof Error ? err.message : err}`
        )
        setProxyEnv(null)
      }
    } else {
      // HTTP proxy: direct
      await stopSocksBridge()
      const url = buildProxyUrl(proxy)
      setProxyEnv({ HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url })
      logger.info('Proxy', `HTTP proxy enabled: ${proxy.hostname}:${proxy.port}`)
    }
    setProxyAllSubprocesses(proxy.proxySubprocesses === true)
  } else {
    await stopSocksBridge()
    setProxyEnv(null)
    setProxyAllSubprocesses(false)
  }
}

// ---------------------------------------------------------------------------
// Shared session:create implementation (desktop IPC + remote WebSocket)
// ---------------------------------------------------------------------------

export interface CreateSessionArgs {
  routingId: string
  cwd: string
  effort?: string
  resumeSessionId?: string
  permissionMode?: string
  model?: string
  thinkingMode?: string
  resumeSessionAt?: string
  forkSession?: boolean
  engineId?: EngineId
}

/**
 * Resolves engine/vendor config, applies proxy/endpoint/model env for Claude
 * (or resolves the spawn model for opencode), and creates the session —
 * shared by the desktop IPC handler and the remote WebSocket handler so both
 * surfaces spawn sessions identically.
 */
export async function prepareAndCreateSession(
  manager: SessionManager,
  win: BrowserWindow,
  args: CreateSessionArgs,
  opts: { notifyMainWindow: boolean }
): Promise<void> {
  const {
    routingId,
    cwd,
    effort,
    resumeSessionId,
    permissionMode,
    model,
    thinkingMode,
    resumeSessionAt,
    forkSession,
    engineId
  } = args

  const engineCfg = loadEngineConfig(engineId ?? 'claude')
  const sandboxConfig = engineCfg.sandbox
  let resolvedModel = model
  if (engineId !== 'opencode') {
    // Derive vendor id from the active model's ModelRef. claudeModel() maps
    // any Claude model to the 'anthropic' vendor (1:1 today; structured-ready
    // for multi-vendor Claude engines in future phases).
    const vendorId = claudeModel(model ?? '').vendorId
    const vendorCfg = loadVendorConfig(vendorId)
    await applyProxyEnv(engineCfg.proxy)
    applyEndpointEnv(vendorCfg.endpoint)
    applyModelEnv(vendorCfg.modelOverride)
  } else {
    // Authoritative guard: never spawn opencode with a model whose provider
    // is disabled/removed (the picker-vs-spawn desync). Resolves to a valid
    // available model (configured → Zen free → first), logging any swap.
    resolvedModel = await resolveOpencodeSpawnModel(model)
  }
  manager.create(
    routingId,
    win,
    cwd,
    effort,
    resumeSessionId,
    permissionMode,
    resolvedModel,
    sandboxConfig,
    thinkingMode,
    resumeSessionAt,
    forkSession,
    engineId
  )
  // Desktop (notifyMainWindow=false) notifies only extra windows: the initiating
  // renderer already knows locally. Remote (notifyMainWindow=true) also notifies
  // the main window because the request arrived over WebSocket, not IPC.
  if (opts.notifyMainWindow && !win.isDestroyed()) {
    win.webContents.send('session:created', routingId, { cwd, resumeSessionId })
  }
  for (const w of ClaudeSession.getExtraWindows()) {
    if (!w.isDestroyed()) w.webContents.send('session:created', routingId, { cwd, resumeSessionId })
  }
}
