/**
 * The Codex feature flags that describe the Codex DESKTOP APP, switched off on
 * every ClaudeUI thread.
 *
 * WHY. `codex-rs/features/src/lib.rs` (0.154.0, the pinned binary) ships these
 * nine as `Stage::Stable` with `default_enabled: true`, so a stock `~/.codex`
 * has all nine ON — and every one of them describes a surface only the desktop
 * app has: an in-app browser, an in-app chat pane, dictation, local automation,
 * in-app updates, browser use and computer use. ClaudeUI is none of those. A
 * GPT-6 turn under ClaudeUI was seen offering to verify a browser build through
 * an "in-app browser" and speaking as if it were inside the desktop app; these
 * flags are the state that says it has one.
 *
 * WHAT THIS DOES NOT DO. None of the nine gates a tool in
 * `core/src/tools/spec_plan.rs`, so switching them off removes nothing from a
 * ClaudeUI thread: their core consumers are `mcp_tool_call.rs`'s
 * `build_confirmation_policies_request_meta` (which forwards
 * `model_messages.confirmation_policies.browser_use` / `.computer_use` to the
 * `node_repl` / `cua_repl`-backed MCP servers the desktop app registers and
 * ClaudeUI never does), the guardian reviewer config,
 * `turn_metadata.rs`'s `computer_use_review_required`, and the config loader,
 * which reports them to clients through `config/read`. That claim is not taken
 * on trust: the second case of
 * `src/integration/codex/codex-desktop-entries.integration.test.ts` runs a
 * thread against the real binary from a home with NO `[features]` table and
 * asserts the override removes no tool the defaults offered — so a future binary
 * that DOES gate a tool on one of these is caught by that tripwire rather than
 * by a user whose tool silently disappeared.
 *
 * WHAT IT IS NOT. Not a write: this rides `thread/start` / `thread/resume` /
 * `thread/fork`'s per-thread `config` override (merged per key, probed in
 * `docs/codex-spike.md` Q3), so the user's own `config.toml` and the USER layer
 * a settings page reads are untouched.
 *
 * DELIBERATELY ABSENT: `apps`, `plugins`, `remote_plugin`, `skill_search`,
 * `tool_suggest`, `mentions_v2`, `goals` and `codex_hooks`. The TUI has those
 * too, they read the user's own `~/.codex` state, and they stay exactly as the
 * user configured them.
 */
export const CLAUDEUI_DISABLED_FEATURES: Readonly<Record<string, false>> = Object.freeze({
  /** The desktop app's embedded browser pane. */
  in_app_browser: false,
  /** The desktop app's chat-with-Codex surface beside the agent transcript. */
  in_app_chat: false,
  /** Voice dictation into the desktop app's composer. */
  in_app_dictation: false,
  /** Desktop-app automation of the local machine (its own app-level runner). */
  in_app_local_automation: false,
  /** The desktop app's self-update channel. */
  in_app_updates: false,
  /** Driving a browser, through the desktop app's `node_repl`-backed MCP server. */
  browser_use: false,
  /** Raw Chrome DevTools Protocol access for that browser. */
  browser_use_full_cdp_access: false,
  /** Attaching that browser control to a browser the user already has open. */
  browser_use_external: false,
  /** Screen/mouse/keyboard control, through the desktop app's `cua_repl` MCP server. */
  computer_use: false
})
