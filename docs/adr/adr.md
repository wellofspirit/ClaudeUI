# Architectural Decision Registry

| ADR                                                               | Description                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [001](adr-001_preserve-at-mentions-in-user-prompt.md)             | Preserve `@` file mentions in user prompt text sent to SDK                                         |
| [002](adr-002_always-mount-terminal-panel.md)                     | Always mount TerminalPanel to preserve xterm scrollback buffers                                    |
| [003](adr-003_per-cwd-terminal-grouping.md)                       | Group terminal tabs by session cwd with 10-minute cold cleanup                                     |
| [004](adr-004_plugin-system.md)                                   | VS Code-style plugin system for extensibility                                                      |
| [005](adr-005_plugin-session-api.md)                              | Plugin session API — sessionId-based events and history                                            |
| [006](adr-006_rebundle-bun-binary.md)                             | Rebundle Bun standalone binary instead of running cli.js under Node                                |
| [007](adr-007_remote-mockup-http-transport.md)                    | Serve mockup previews over HTTP with a sandboxed iframe for the remote web client                  |
| [008](adr-008_typecheck-remote-web-client.md)                     | Type-check the remote web client (`src/web`) against `ClaudeAPI`                                   |
| [009](adr-009_claude-settings-vs-uisettings.md)                   | Store cli.js-consumed settings in Claude's settings.json, not UISettings                           |
| [010](adr-010_fork-session-via-native-cli-flags.md)               | Fork ("branch off") sessions via cli.js's native `--resume-session-at` + `--fork-session`          |
| [011](adr-011_canonical-usage-windows-and-account-attribution.md) | Canonical 5h-window identity from `resets_at` + time-based account attribution for usage analytics |
| [012](adr-012_mermaid-html-labels-and-theming.md)                 | Mermaid HTML labels (`antiscript` + DOMPurify `html` profile) and dark-theme ER contrast           |
| [013](adr-013_eslint-flat-config-and-prettier-decoupling.md)      | ESLint flat-config rework — Prettier decoupling, scoped React rules, pragmatic strictness          |
| [014](adr-014_native-anthropic-oauth.md)                          | Native Anthropic OAuth via cli.js control requests, hosted on the service session                  |
| [015](adr-015_multi-account-file-credentials.md)                  | Multiple-account support via file-based credentials (SKIP_SECURESTORAGE patch)                      |
