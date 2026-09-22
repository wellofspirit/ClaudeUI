/**
 * Which entries in the user's Codex config belong to the Codex DESKTOP APP.
 *
 * ## Why this exists
 *
 * The desktop app shares `~/.codex` with the CLI and writes its own entries into
 * the user's `config.toml`: MCP servers whose commands live inside the app
 * bundle (`[mcp_servers.node_repl]`, `[mcp_servers.cua_repl]`,
 * `[mcp_servers.computer-use]`) and plugins from the local `openai-bundled`
 * marketplace (`[plugins."browser@openai-bundled"] enabled = true`, and the same
 * for `codex-app-tools`, `computer-use`, `visualize`). Nothing gates those on
 * WHICH client opened the thread — `core-plugins/src/manager.rs` uses the
 * app-server client name only to filter install SUGGESTIONS, and the TUI merely
 * hides the marketplace from its menus — so an app-server started by ClaudeUI
 * loads them all, spawns the desktop app's MCP servers out of the app bundle,
 * and injects the plugins' skills into the prompt.
 *
 * That is where the "in-app browser" came from: the `browser@openai-bundled`
 * manifest tells the model to "Use Browser, the ChatGPT in-app browser, when the
 * user asks to open, inspect, navigate, test … local web targets". ClaudeUI has
 * no such browser, so the model was reaching for a surface that does not exist.
 *
 * ## Why detection is needed at all, rather than a fixed override
 *
 * The suppression channel is the per-thread `config` override, deep-merged key
 * by key onto the user layer (`config/src/merge.rs`), so
 * `{ mcp_servers: { node_repl: { enabled: false } } }` lands on the user's
 * EXISTING `[mcp_servers.node_repl]` and keeps its `command`. Sent to a user who
 * has NO such table, the same override CREATES one with no transport at all and
 * config load fails. So the override has to be computed from what the config
 * actually contains — which is what this function does, and why it is pure: the
 * one place this rule lives, unit-testable without a binary.
 *
 * ## The rules
 *
 * An MCP server counts when EITHER holds (union, not intersection):
 *
 *  - its name is one of {@link DESKTOP_MCP_SERVER_NAMES} — the names the
 *    binary's own bundled hooks pin (`plugin/src/bundled_hooks.rs` maps
 *    `browser`, `chrome*` and `computer-use` onto `node_repl`, and
 *    `unified-computer-use` onto `cua_repl`); or
 *  - its `command` path runs through a macOS application bundle
 *    (`.app/Contents/`), which is the desktop app's own install location and
 *    catches a renamed or future bundled server.
 *
 * The NAME rule is deliberately blunt: a user who hand-wrote their own
 * `[mcp_servers.node_repl]` with a plain command has it disabled on ClaudeUI
 * threads too. That is the safe direction — the name belongs to the desktop
 * app's runtime, the user's file is never modified, and the same server keeps
 * working in the desktop app and the TUI.
 *
 * A plugin counts when its id ends in `@openai-bundled`: every plugin in that
 * marketplace renders or drives something only the desktop app has, and it is
 * the one marketplace the CLI itself hides (`CLI_HIDDEN_PLUGIN_MARKETPLACES`).
 * `openai-primary-runtime` plugins (documents, pdf, spreadsheets, …) and every
 * other marketplace stay exactly as the user set them.
 */

/** The MCP server names the desktop app's own bundled hooks pin. */
export const DESKTOP_MCP_SERVER_NAMES: readonly string[] = ['node_repl', 'cua_repl', 'computer-use']

/** The local marketplace the desktop app installs its own plugins from. */
export const DESKTOP_PLUGIN_MARKETPLACE_SUFFIX = '@openai-bundled'

/** Path fragment of a macOS application bundle — where the desktop app's servers live. */
const MACOS_BUNDLE = '.app/contents/'

export interface CodexDesktopEntries {
  /** `mcp_servers` keys to disable, sorted. */
  mcpServers: string[]
  /** `plugins` keys to disable, sorted. */
  plugins: string[]
}

const table = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * Does this `[mcp_servers.<name>]` entry belong to the desktop app?
 *
 * The command is normalised to forward slashes before the bundle test so a
 * Windows-style `C:\...\Codex.app\Contents\...` would match too — though in
 * practice `.app` bundles are macOS only, which is exactly why a plain Windows
 * path (`C:\Users\me\tools\node_repl.exe`) must NOT match on the bundle rule.
 */
function isDesktopMcpServer(name: string, entry: unknown): boolean {
  if (DESKTOP_MCP_SERVER_NAMES.includes(name)) return true
  const command = table(entry)?.command
  return (
    typeof command === 'string' && command.replace(/\\/g, '/').toLowerCase().includes(MACOS_BUNDLE)
  )
}

/**
 * The desktop-app entries present in a Codex config table.
 *
 * `config` is the EFFECTIVE config `config/read` answers with (the merged
 * layers, which is what the app-server will actually load), but the function
 * cares only about the two tables and tolerates any shape: a missing table, a
 * scalar where a table belongs, or a non-object entry all yield nothing rather
 * than throwing. An override is not worth a failed session start.
 */
export function desktopAppEntries(config: unknown): CodexDesktopEntries {
  const root = table(config)
  const servers = table(root?.mcp_servers)
  const plugins = table(root?.plugins)
  return {
    mcpServers: Object.entries(servers ?? {})
      .filter(([name, entry]) => isDesktopMcpServer(name, entry))
      .map(([name]) => name)
      .sort(),
    plugins: Object.keys(plugins ?? {})
      .filter((id) => id.endsWith(DESKTOP_PLUGIN_MARKETPLACE_SUFFIX))
      .sort()
  }
}
