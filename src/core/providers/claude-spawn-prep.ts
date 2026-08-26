import { loadVendorConfig } from '../services/ui-config'
import { startSocksBridge, stopSocksBridge } from '../services/socks-bridge'
import { setProxyEnv, setProxyAllSubprocesses } from '../sdk/proxy'
import { setEndpointEnv } from '../sdk/endpoint-env'
import { setModelEnv } from '../sdk/model-env'
import { logger } from '../services/logger'
import { claudeModel } from '../../shared/types'
import type {
  ProxySettings,
  AnthropicEndpointSettings,
  ModelOverrideSettings
} from '../../shared/types'
import type { EngineSpawnPrep } from './SpawnPrepRegistry'

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

/**
 * HAZARD (module-global singletons): applyProxyEnv/applyEndpointEnv/applyModelEnv
 * write to module-scoped singleton env slots (sdk/proxy.ts, sdk/endpoint-env.ts,
 * sdk/model-env.ts) that buildEnv() overlays onto EVERY cli.js spawn. They are
 * applied at create time, NOT captured per-spawn — so with multiple concurrent
 * Claude sessions the LAST writer wins: a newer session's vendor endpoint/model/
 * proxy override the slots for all live sessions until the next create. Tolerable
 * today (single active Anthropic endpoint), and the reason multi-vendor Claude /
 * per-spawn env overlays are future work (engine-hardening-plan Item 4).
 */
export const claudeSpawnPrep: EngineSpawnPrep = async (model, engineConfig) => {
  // Derive vendor id from the active model's ModelRef. claudeModel() maps any
  // Claude model to the 'anthropic' vendor (1:1 today; structured-ready for
  // multi-vendor Claude engines in future phases).
  const vendorId = claudeModel(model ?? '').vendorId
  const vendorCfg = loadVendorConfig(vendorId)
  await applyProxyEnv(engineConfig.proxy)
  applyEndpointEnv(vendorCfg.endpoint)
  applyModelEnv(vendorCfg.modelOverride)
  return { resolvedModel: model }
}
