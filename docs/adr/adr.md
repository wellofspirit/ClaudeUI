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
| [028](adr-028_opencode-native-config-in-place.md)                | opencode engine-native config written to opencode's own files in place (jsonc, comment-safe) *(implements 020; relates to 019/022/024)* |
| [029](adr-029_opencode-custom-agent-crud.md)                     | opencode custom-agent CRUD — markdown agent files (global/project), opt-in permissions, AI-assisted authoring *(builds on 028; relates to 022/023/024)* |
| [030](adr-030_capability-honesty.md)                             | Capability honesty — a capability flag is true only when the full engine path works; opencode fork demoted *(relates to 018/019)* |
| [031](adr-031_opencode-config-leaf-merge-writes.md)              | opencode config writes are diff-driven leaf merges, never subtree replacements — preserves unmodelled hand-edits *(refines 028)* |
| [032](adr-032_opencode-tool-parity-no-fork.md)                   | opencode tool-experience parity from the wire — bash streaming, patch diffs, reasoned non-fatal denials; no fork *(amends 023; relates to 019/022/024/030/031)* |
| [033](adr-033_cross-engine-dispatch.md)                          | Cross-engine agent dispatch — hosted `dispatch_agent` tool, headless subtask-style targets, dispatcher-owned approval forwarding *(relates to 018/019/020/022/030/032)* |
| [034](adr-034_session-time-and-cost-accounting.md)               | Session time & per-model cost accounting — active-turn duration, base+overlay cost from cumulative wire fields, dispatched spend in breakdown only *(amends 033; relates to 011/020)* |
| [035](adr-035_pi-engine-backend.md)                              | pi engine backend — RPC stdio subprocess, bridge-extension approval gating + hosted tools + dispatch (no MCP/no server), shared `~/.claude` config *(implements 018; mirrors 019; relates to 021/022/024/025/030/033/034)* |
| [036](adr-036_unified-auth-vault.md)                             | Unified auth vault — ClaudeUI drives Codex OAuth once + feeds pi & opencode stores, sole-refresher + fs-watch resync; Claude Code excluded *(relates to 021/014/019/035/030)* |
| [037](adr-037_shared-provider-routing-and-plaintext-vault.md)    | Shared provider routing + plaintext vault — canonical providers/models with explicit pi/opencode routes, managed native projections, no Keychain *(amends 036; relates to 020/028/031/035)* |
| [038](adr-038_event-driven-approval-lifecycle.md)                | Approval lifecycle is event-driven — cards mirror main's pendingApprovals via request/dismiss events, never inferred from turn state; background subagents outlive the parent turn *(relates to 022/033)* |
| [039](adr-039_remote-auth-modes.md)                              | Remote auth modes — fragment token, replayable-proof password with transport-delegated confidentiality, and `tailscale serve` TLS with owner-only tailnet identity; Host allowlist, XFF-keyed throttling, funnel reject *(relates to 007/027/030)* |
| [040](adr-040_engine-neutral-task-lifecycle-events.md)           | Task lifecycle is event-driven — `session:task-started`/`session:task-notification` drive TaskCard running-state via per-session `activeTasks`; input/tool_result heuristic survives only as legacy fallback for engines without start events *(relates to 033/038)* |
| [041](adr-041_remote-resync-merge-semantics.md)                  | Remote re-sync merges into local view state — sync-full replaces wholesale only on first hydration; re-syncs preserve local `activeSessionId` and merge the sessions map so mobile navigation survives reconnects *(relates to 008/039/040)* |
| [042](adr-042_pinned-tailscale-https-port.md)                    | Pinned Tailscale HTTPS port (default 443, no fallback walk) — app-level serve-error banner with force re-serve; persisted `{httpsPort, localPort}` record reconciled at startup makes cleanup force-kill-proof *(amends 039; relates to 007)* |
| [043](adr-043_senduserfile-files-widget.md)                      | SendUserFile client integration — transcript-derived `SentFile[]`, floating Files widget, inline image preview, remote download *(relates to 027/039)* |
| [044](adr-044_opencode-provider-disable-vs-remove.md)            | opencode providers — Disable (a reversible veto) and Remove (destroys only what ClaudeUI owns) are separate, separately-gated actions over ONE merged provider list; removal clears its own `disabled_providers` entry *(relates to 027/028/031/036/037)* |
