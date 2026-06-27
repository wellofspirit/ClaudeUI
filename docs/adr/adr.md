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
| [016](adr-016_provider-abstraction.md)                            | Provider abstraction — ISession / BaseSession / ProviderRegistry (Strategy B)                       |
| [017](adr-017_codex-app-server-backend.md)                        | Codex backend via app-server protocol — bundled binary, generated types, delegated auth *(superseded by 019)* |
| [018](adr-018_v2-engine-vendor-account-model.md)                  | V2 multi-engine model — engine/vendor/account split + computed capability model *(supersedes 016)*  |
| [019](adr-019_opencode-engine-backend.md)                         | opencode engine backend — shared HTTP/SSE server, legacy API, tool maps *(supersedes 017)*          |
| [020](adr-020_v2-persistence-and-config-plane.md)                 | V2 persistence & config-plane — files for config, SQLite for operational data *(amends 009/011)*    |
| [021](adr-021_neutral-auth-account-model.md)                      | Neutral auth/account model — EngineAuthProvider, per-vendor probe *(amends 014/015)*                |
| [022](adr-022_opencode-permission-mapping.md)                     | opencode permission model — autonomy-mode → last-match-wins ruleset mapping *(relates to 018/019)*  |
| [023](adr-023_opencode-automode-classifier.md)                    | opencode auto-mode — LLM permission gatekeeper, configurable judge model *(relates to 022)* |
| [024](adr-024_opencode-interaction-parity.md)                     | opencode interaction-feature parity — slash commands, skills, side-questions, queue/steer, subagents *(relates to 019/022/023)* |
| [025](adr-025_project-key-identity-and-engine-neutral-delete.md)  | projectKey as a derived lossy render-identity + engine-neutral persisted-session delete dispatcher *(relates to 018/019/020)* |
| [026](adr-026_development-workflow.md)                            | Development workflow — Opus orchestrates + reviews every line, Sonnet implements, gates + real-app verify before commit *(relates to 027)* |
| [027](adr-027_test-data-attributes.md)                           | Test data attributes — two-tier `data-testid` convention + DOM-assert-before-screenshot verification *(relates to 026/008)* |
