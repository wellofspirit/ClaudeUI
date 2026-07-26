/**
 * Build argv for spawning cli.js.
 *
 * Mirrors the upstream SDK's arg builder (sdk.mjs). We only emit flags for
 * options we actually use — the CLI accepts many more, but they're gated
 * behind feature paths that aren't exercised here.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QueryOptions, McpServerConfig, SdkMcpServer } from './types'
import { getProxyEnv, getProxyAllSubprocesses } from './proxy'
import { getEndpointEnv } from './endpoint-env'
import { getModelEnv } from './model-env'
import { getSecurestorageEnv } from './securestorage-env'

/** Strip in-process `type: 'sdk'` servers from an mcpServers map — those are
 *  hosted locally and are NOT written to --mcp-config (the CLI treats them
 *  specially via the `initialize` control_request). */
export function splitMcpServers(servers?: Record<string, McpServerConfig>): {
  cliServers: Record<string, Exclude<McpServerConfig, SdkMcpServer>>
  sdkServers: Record<string, SdkMcpServer>
} {
  const cliServers: Record<string, Exclude<McpServerConfig, SdkMcpServer>> = {}
  const sdkServers: Record<string, SdkMcpServer> = {}
  if (!servers) return { cliServers, sdkServers }

  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg && (cfg as { type?: string }).type === 'sdk') {
      sdkServers[name] = cfg as SdkMcpServer
    } else {
      cliServers[name] = cfg as Exclude<McpServerConfig, SdkMcpServer>
    }
  }
  return { cliServers, sdkServers }
}

/**
 * Build the CLI argv list. Order and semantics mirror the upstream SDK's
 * arg-builder at sdk.mjs ~char 222824 — some options only take effect if
 * emitted in exactly the shape cli.js expects.
 */
export function buildArgs(options: QueryOptions): string[] {
  const args: string[] = [
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json'
  ]

  // --- Thinking ------------------------------------------------------------
  //   enabled + no budget   → --thinking adaptive
  //   enabled + budget      → --max-thinking-tokens N   (no --thinking flag)
  //   disabled              → --thinking disabled
  //   adaptive              → --thinking adaptive
  //   + display (!disabled) → --thinking-display <display>
  // Passing --thinking enabled literally makes cli.js silently drop the flag
  // so thinking deltas never stream.
  if (options.thinking) {
    const t = options.thinking
    switch (t.type) {
      case 'enabled':
        if (t.budgetTokens === undefined) args.push('--thinking', 'adaptive')
        else args.push('--max-thinking-tokens', String(t.budgetTokens))
        break
      case 'disabled':
        args.push('--thinking', 'disabled')
        break
      case 'adaptive':
        args.push('--thinking', 'adaptive')
        if (typeof t.budgetTokens === 'number') {
          args.push('--max-thinking-tokens', String(t.budgetTokens))
        }
        break
      default:
        args.push('--thinking', t.type)
        if (typeof t.budgetTokens === 'number') {
          args.push('--max-thinking-tokens', String(t.budgetTokens))
        }
    }
    if (t.type !== 'disabled' && t.display) {
      args.push('--thinking-display', t.display)
    }
  }

  // --- Turn / budget limits ------------------------------------------------
  if (options.effort) args.push('--effort', options.effort)
  if (typeof options.maxTurns === 'number') args.push('--max-turns', String(options.maxTurns))
  if (typeof options.maxBudgetUsd === 'number') {
    args.push('--max-budget-usd', String(options.maxBudgetUsd))
  }
  if (options.taskBudget) args.push('--task-budget', String(options.taskBudget.total))

  // --- Model / agent / betas ----------------------------------------------
  if (options.model) args.push('--model', options.model)
  if (options.agent) args.push('--agent', options.agent)
  if (Array.isArray(options.betas) && options.betas.length > 0) {
    args.push('--betas', options.betas.join(','))
  }

  // --- JSON schema ---------------------------------------------------------
  if (options.jsonSchema !== undefined) {
    args.push('--json-schema', JSON.stringify(options.jsonSchema))
  }

  // --- Debug flags ---------------------------------------------------------
  if (options.debugFile) args.push('--debug-file', options.debugFile)
  else if (options.debug) args.push('--debug')
  if (process.env.DEBUG_CLAUDE_AGENT_SDK) args.push('--debug-to-stderr')

  // --- Permission prompt tool ---------------------------------------------
  if (options.canUseTool) {
    if (options.permissionPromptToolName) {
      throw new Error(
        'canUseTool callback cannot be used with permissionPromptToolName. Use one or the other.'
      )
    }
    args.push('--permission-prompt-tool', 'stdio')
  } else if (options.permissionPromptToolName) {
    args.push('--permission-prompt-tool', options.permissionPromptToolName)
  }

  // --- Session control -----------------------------------------------------
  if (options.continueConversation) args.push('--continue')
  if (options.resume) args.push('--resume', options.resume)
  if (options.assistant) args.push('--assistant')
  if (Array.isArray(options.channels) && options.channels.length > 0) {
    args.push('--channels', ...options.channels)
  }

  // --- Tool lists ----------------------------------------------------------
  if (Array.isArray(options.allowedTools) && options.allowedTools.length) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }
  if (Array.isArray(options.disallowedTools) && options.disallowedTools.length) {
    args.push('--disallowedTools', options.disallowedTools.join(','))
  }
  if (options.tools !== undefined) {
    if (Array.isArray(options.tools)) {
      // `[]` → `--tools ""` (no tools at all); populated → csv.
      args.push('--tools', options.tools.length ? options.tools.join(',') : '')
    } else {
      // Non-array truthy value (e.g. 'default') → --tools default
      args.push('--tools', 'default')
    }
  }

  // --- MCP servers + settings ---------------------------------------------
  const { cliServers } = splitMcpServers(options.mcpServers)
  if (Object.keys(cliServers).length > 0) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: cliServers }))
  }
  // SDK emits setting-sources as a single `--setting-sources=csv` arg.
  if (options.settingSources !== undefined) {
    args.push(`--setting-sources=${options.settingSources.join(',')}`)
  }
  if (options.strictMcpConfig) args.push('--strict-mcp-config')

  // --- Permissions & fallback ---------------------------------------------
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode)
  if (options.allowDangerouslySkipPermissions) {
    args.push('--allow-dangerously-skip-permissions')
  }
  if (options.fallbackModel) {
    if (options.model && options.fallbackModel === options.model) {
      throw new Error(
        'fallbackModel cannot be the same as model. Please specify a different model for fallbackModel.'
      )
    }
    args.push('--fallback-model', options.fallbackModel)
  }

  // --- Hook / stream / session flags --------------------------------------
  if (options.includeHookEvents) args.push('--include-hook-events')
  if (options.includePartialMessages) args.push('--include-partial-messages')
  if (options.sessionMirror) args.push('--session-mirror')

  // --- Additional dirs & plugins ------------------------------------------
  for (const dir of options.additionalDirectories ?? []) args.push('--add-dir', dir)
  for (const plugin of options.plugins ?? []) {
    if (plugin.type !== 'local') {
      throw new Error(`Unsupported plugin type: ${(plugin as { type: string }).type}`)
    }
    args.push('--plugin-dir', plugin.path)
  }

  // --- Session-id / resume-at / fork --------------------------------------
  if (options.forkSession) args.push('--fork-session')
  if (options.resumeSessionAt) args.push('--resume-session-at', options.resumeSessionAt)
  if (options.sessionId) args.push('--session-id', options.sessionId)
  if (options.persistSession === false) args.push('--no-session-persistence')

  // --- systemPrompt --------------------------------------------------------
  // String systemPrompt is sent via the `initialize` control request, not as
  // a CLI flag. Preset/append variants are handled the same way. No-op here.

  // --- Settings + sandbox + extraArgs flag-bag -----------------------------
  // Mirrors sdk.mjs QV() — sandbox merges into `settings`, settings may be
  // a JSON object (emitted as --settings <json>) or path string (--settings
  // <path>). extraArgs is a {flag: value|null} bag flattened to --<flag> args.
  const flagBag = mergeSettingsAndSandbox(options)
  for (const [k, v] of Object.entries(flagBag)) {
    if (v === null || v === undefined) args.push(`--${k}`)
    else args.push(`--${k}`, v)
  }

  return args
}

/**
 * Port of the SDK's QV() helper. Folds `sandbox` into `settings`, then
 * returns a flat flag-bag ready for --<flag> <value> emission.
 */
function mergeSettingsAndSandbox(options: QueryOptions): Record<string, string | null> {
  const bag: Record<string, string | null> = { ...(options.extraArgs ?? {}) }

  const hasSandbox = options.sandbox && Object.keys(options.sandbox).length > 0
  const hasSettings = options.settings !== undefined

  if (hasSandbox) {
    // SDK defaults failIfUnavailable=true when enabled and not explicitly set.
    const sb = options.sandbox as Record<string, unknown>
    const sandbox =
      sb.enabled === true && sb.failIfUnavailable === undefined
        ? { ...sb, failIfUnavailable: true }
        : sb

    const existing = options.settings
    if (typeof existing === 'string') {
      throw new Error(
        'Cannot use both a settings file path and the sandbox option. Include the sandbox configuration in your settings file instead.'
      )
    }
    const merged = { ...(existing ?? {}), sandbox }
    bag.settings = JSON.stringify(merged)
  } else if (hasSettings) {
    const s = options.settings
    bag.settings = typeof s === 'string' ? s : JSON.stringify(s)
  }

  return bag
}

/**
 * Find the app's node_modules directory so cli.js's require() calls can
 * resolve external deps (`ws`, `undici`, `yaml`, `node-fetch`, `ajv`, etc.).
 *
 * Under Bun, cli.js's compiled binary has these as runtime built-ins. Under
 * Node, it needs filesystem resolution — but cli.js sits at
 * vendor/claude-cli/cli.js (dev) or Resources/claude-cli/cli.js (prod),
 * neither of which is inside a node_modules tree for Node's walk-up to work.
 *
 * We resolve the correct node_modules path at spawn time and inject it via
 * NODE_PATH. The search order covers dev (project root) and production
 * (app.asar where electron-builder places deps).
 */
function resolveAppNodeModules(): string | null {
  const candidates: string[] = []
  // Dev: walk up from this module's location looking for a node_modules dir.
  // In a built app, __dirname is inside out/main or app.asar.
  let cur = __dirname
  for (let i = 0; i < 8; i++) {
    const nm = path.join(cur, 'node_modules')
    if (fs.existsSync(nm)) candidates.push(nm)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return candidates[0] ?? null
}

let cachedNodeModules: string | null | undefined

export function buildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  if (env.DEBUG_CLAUDE_AGENT_SDK) env.DEBUG = '1'
  // We do NOT force CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC here. It is not a
  // subscription-vs-API billing signal (attribution rides on
  // CLAUDE_CODE_ENTRYPOINT=claude-desktop + OAuth + interactive stream-json mode,
  // none of which this touches). The official Claude Desktop app leaves it UNSET
  // on its main/interactive sessions and only sets it on throwaway `-p` background
  // jobs — and ClaudeUI has no `-p` spawns (every cli.js launch goes through the
  // stream-json harness in query.ts). Forcing it here suppressed cli.js's bootstrap
  // fetch (GET /api/claude_cli/bootstrap), which is what discovers gated models like
  // Fable and writes them to ~/.claude.json's additionalModelOptionsCache. Mirror
  // Desktop: leave it to whatever the inherited env specifies (default: unset).
  delete env.NODE_OPTIONS

  // Override so that a developer running `bun run dev` from inside a Claude
  // Code session doesn't inherit the parent's `sdk-cli` entrypoint, which
  // would re-tier the spawned cli.js as Agent SDK usage.
  env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'

  // Scoped proxy: overlay proxy env vars only onto this spawn, not the main
  // Electron process. If `proxyAllSubprocesses` is off (default), the
  // subprocess-proxy-strip patch in cli.js removes these from Bash/MCP/LSP
  // child env so only cli.js's own API traffic is proxied.
  const proxy = getProxyEnv()
  if (proxy) {
    env.HTTP_PROXY = proxy.HTTP_PROXY
    env.HTTPS_PROXY = proxy.HTTPS_PROXY
    env.ALL_PROXY = proxy.ALL_PROXY
    if (getProxyAllSubprocesses()) env.CLAUDEUI_PROXY_SUBPROCESSES = '1'
    else delete env.CLAUDEUI_PROXY_SUBPROCESSES
  } else {
    // No in-app proxy configured: do NOT delete inherited HTTP_PROXY/HTTPS_PROXY/
    // ALL_PROXY. cli.js honors an env-configured proxy for its own API traffic
    // (docs/protocol/01-transport §1.5); deleting them left a user behind a
    // corporate/env proxy with no connectivity (M-CL4). Only clear our own
    // marker so the default subprocess-proxy-strip behavior applies.
    delete env.CLAUDEUI_PROXY_SUBPROCESSES
  }

  // Scoped Anthropic endpoint: overlay base URL + auth token only onto this
  // spawn so user-supplied gateway credentials never leak into PTYs, simple-git
  // subprocesses, or plugin hosts.
  const endpoint = getEndpointEnv()
  if (endpoint) {
    env.ANTHROPIC_BASE_URL = endpoint.ANTHROPIC_BASE_URL
    env.ANTHROPIC_AUTH_TOKEN = endpoint.ANTHROPIC_AUTH_TOKEN
  }
  // No in-app endpoint configured: do NOT delete inherited ANTHROPIC_BASE_URL/
  // ANTHROPIC_AUTH_TOKEN. A user routing through a gateway/LiteLLM via their own
  // env relies on them and the stock CLI supports them (M-CL4). These inherited
  // values are the user's own shell env — the Codex/vault path never writes
  // ANTHROPIC_* to process.env, so this cannot leak vault tokens into Claude.

  // Scoped model override: each field is set only when non-empty so partial
  // overrides leave cli.js's defaults intact for the unset families.
  const model = getModelEnv()
  if (model) {
    if (model.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = model.ANTHROPIC_MODEL
    else delete env.ANTHROPIC_MODEL
    if (model.ANTHROPIC_DEFAULT_SONNET_MODEL)
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model.ANTHROPIC_DEFAULT_SONNET_MODEL
    else delete env.ANTHROPIC_DEFAULT_SONNET_MODEL
    if (model.ANTHROPIC_DEFAULT_OPUS_MODEL)
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model.ANTHROPIC_DEFAULT_OPUS_MODEL
    else delete env.ANTHROPIC_DEFAULT_OPUS_MODEL
    if (model.ANTHROPIC_DEFAULT_HAIKU_MODEL)
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model.ANTHROPIC_DEFAULT_HAIKU_MODEL
    else delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  } else {
    delete env.ANTHROPIC_MODEL
    delete env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete env.ANTHROPIC_DEFAULT_OPUS_MODEL
    delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }

  // Multi-account credential storage (ADR-015). Precedence: an explicit
  // per-spawn override (options.env, already merged into `env` — used by
  // add-account login into a specific dir) wins; else the active account's dir
  // from module state; else clear so single-account Keychain mode is restored.
  if (env.SKIP_SECURESTORAGE) {
    // explicit per-spawn override — leave SKIP_SECURESTORAGE + dir as provided
  } else {
    const ss = getSecurestorageEnv()
    if (ss) {
      env.SKIP_SECURESTORAGE = '1'
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR = ss.dir
    } else {
      delete env.SKIP_SECURESTORAGE
      delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR
    }
  }

  // Inject our app's node_modules into NODE_PATH so cli.js can resolve
  // `ws`, `undici`, etc. even though it lives outside any node_modules tree.
  if (cachedNodeModules === undefined) cachedNodeModules = resolveAppNodeModules()
  if (cachedNodeModules) {
    const sep = process.platform === 'win32' ? ';' : ':'
    const existing = env.NODE_PATH ? env.NODE_PATH + sep : ''
    env.NODE_PATH = existing + cachedNodeModules
  }
  return env
}
