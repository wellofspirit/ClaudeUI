# Architectural Decision Registry

| ADR | Description |
|-----|-------------|
| [001](adr-001_preserve-at-mentions-in-user-prompt.md) | Preserve `@` file mentions in user prompt text sent to SDK |
| [002](adr-002_always-mount-terminal-panel.md) | Always mount TerminalPanel to preserve xterm scrollback buffers |
| [003](adr-003_per-cwd-terminal-grouping.md) | Group terminal tabs by session cwd with 10-minute cold cleanup |
| [004](adr-004_plugin-system.md) | VS Code-style plugin system for extensibility |
| [005](adr-005_plugin-session-api.md) | Plugin session API — sessionId-based events and history |
| [006](adr-006_rebundle-bun-binary.md) | Rebundle Bun standalone binary instead of running cli.js under Node |
| [007](adr-007_remote-mockup-http-transport.md) | Serve mockup previews over HTTP with a sandboxed iframe for the remote web client |
| [008](adr-008_typecheck-remote-web-client.md) | Type-check the remote web client (`src/web`) against `ClaudeAPI` |
| [009](adr-009_claude-settings-vs-uisettings.md) | Store cli.js-consumed settings in Claude's settings.json, not UISettings |
| [010](adr-010_fork-session-via-native-cli-flags.md) | Fork ("branch off") sessions via cli.js's native `--resume-session-at` + `--fork-session` |
