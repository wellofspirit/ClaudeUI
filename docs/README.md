# ClaudeUI Documentation Index

Read the doc that matches your task — don't load them speculatively.

- [architecture/](architecture/README.md) — how the app is put together, split by concern: source layout + services, the multi-engine seam, IPC & data flow, persistence/settings planes, UI, the remote layer as built ([remote.md](architecture/remote.md)), the remote security model as built ([security.md](architecture/security.md)), and the accepted target design for sync ([sync-core.md](architecture/sync-core.md)). **Start at its README for any structural question.**
- [protocol/](protocol/README.md) — the cli.js wire manual: every stream-json message, control subtype, CLI flag, MCP hosting, cancellation, the extract→patch→rebundle build pipeline (01-transport §1.12) and patch registry. **Authoritative — consult before theorizing about cli.js behavior or touching `src/main/sdk/` / `patch/`.**
- [adr/adr.md](adr/adr.md) — index of all Architectural Decision Records. Read the relevant ADR before changing a documented seam; ADR-026 is the development workflow.
- [testing-strategy.md](testing-strategy.md) — the four-layer test architecture (unit/component/e2e/git/integration), what belongs in each layer, test infra.
- [component-guide.md](component-guide.md) — React component patterns and conventions for testability.
- [plugin-development.md](plugin-development.md) — writing ClaudeUI plugins (VS Code-style, ADR-004/005).
- [model-capabilities.md](model-capabilities.md) — the capability model reference (engine × model → resolved).
- [cli-message-loop-internals.md](cli-message-loop-internals.md) — deep reverse-engineering of cli.js's message loop, output queue, steer handling.
- [mockup-sandbox-research.md](mockup-sandbox-research.md) — research notes behind the mockup preview sandbox (ADR-007).
