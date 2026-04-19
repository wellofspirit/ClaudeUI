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

/** Strip in-process `type: 'sdk'` servers from an mcpServers map — those are
 *  hosted locally and are NOT written to --mcp-config (the CLI treats them
 *  specially via the `initialize` control_request). */
export function splitMcpServers(
  servers?: Record<string, McpServerConfig>,
): {
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

export function buildArgs(options: QueryOptions): string[] {
  const args: string[] = [
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
  ]

  if (options.thinking) {
    const t = options.thinking
    args.push('--thinking', t.type)
    if (typeof t.budgetTokens === 'number') {
      args.push('--max-thinking-tokens', String(t.budgetTokens))
    }
  }

  if (options.effort) args.push('--effort', options.effort)
  if (typeof options.maxTurns === 'number') args.push('--max-turns', String(options.maxTurns))
  if (options.model) args.push('--model', options.model)
  if (options.agents) args.push('--agent', options.agents)

  if (options.canUseTool) {
    args.push('--permission-prompt-tool', 'stdio')
  }

  if (options.resume) args.push('--resume', options.resume)

  if (Array.isArray(options.allowedTools) && options.allowedTools.length) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }
  if (Array.isArray(options.disallowedTools) && options.disallowedTools.length) {
    args.push('--disallowedTools', options.disallowedTools.join(','))
  }
  if (Array.isArray(options.tools)) {
    args.push('--tools', options.tools.length ? options.tools.join(',') : '')
  }

  const { cliServers } = splitMcpServers(options.mcpServers)
  if (Object.keys(cliServers).length) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: cliServers }))
  }

  if (options.settingSources && options.settingSources.length) {
    args.push('--setting-sources', options.settingSources.join(','))
  }

  if (options.permissionMode) {
    args.push('--permission-mode', options.permissionMode)
  }

  if (options.includeHookEvents) args.push('--include-hook-events')
  if (options.includePartialMessages) args.push('--include-partial-messages')

  if (options.persistSession === false) args.push('--no-session-persistence')

  if (options.systemPrompt && typeof options.systemPrompt === 'string') {
    // String systemPrompt is sent via the `initialize` control request, not
    // as a CLI flag — the CLI doesn't have a `--system-prompt` string flag.
    // Preset/append variants are handled the same way. This branch is a
    // no-op; keep for clarity in case the CLI adds a flag later.
  }

  if (Array.isArray(options.extraArgs) && options.extraArgs.length) {
    args.push(...options.extraArgs)
  }

  return args
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
  if (!env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
  if (env.DEBUG_CLAUDE_AGENT_SDK) env.DEBUG = '1'
  delete env.NODE_OPTIONS

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
