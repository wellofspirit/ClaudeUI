# ADR-019: opencode engine backend — shared HTTP/SSE server, legacy API, tool maps

**Status:** Accepted (V2 design; implementation complete. The detailed `docs/v2/` design docs were removed after V2 shipped — recoverable from git history.)
**Date:** 2026-06-19
**Supersedes:** [ADR-017](adr-017_codex-app-server-backend.md)

## Context

The V2 multi-engine model (ADR-018) needs a concrete second engine. We **pivot from Codex to
opencode**: opencode is a meta-harness that runs OpenAI/Anthropic/Google/local models, so it
_subsumes_ access to OpenAI's coding models while being a better harness, and exposes a documented
HTTP+SSE server with an official SDK. The direct `codex app-server` backend (ADR-017) becomes a
**dormant fallback** — insurance if OpenAI ever de-supports opencode. Integration surface verified
against opencode v1.17.x.

## Decision

- **Transport:** drive `opencode serve` over **HTTP + SSE** (`GET /event`), targeting the **legacy/
  v1 API family** (complete — has abort/fork/delete; the v2 `/api` family is mid-migration). Pin the
  binary (`opencodeCliVersion`) + snapshot the OpenAPI `/doc` per version; smoke-test the event-type
  strings and prompt/permission shapes (the v1↔v2 churn is the dependency risk).
- **Lifecycle:** a **shared, ref-counted `opencode serve` per cwd**, multiplexing all sessions in that
  folder (matches opencode's design and ClaudeUI's cwd grouping; dissolves the cold-spawn perf problem
  the Codex redesign fought). `OpencodeSession` attaches; `dispose()` decrements the refcount;
  last-out tears the server down. Port discovered from stdout.
- **Event→ContentBlock mapping:** `message.part.updated` (snapshot, upsert by part id) → blocks;
  `session.idle` → turn-complete; `permission.asked` → `PendingApproval`;
  `AssistantMessage.tokens/cost` → metering. Reuses the existing neutral `session:*` contract.
- **Bundling:** pinned prebuilt binary under `vendor/opencode-cli/` via `ensure-opencode` (mirrors the
  Codex vendoring pattern). MIT-licensed.
- **Tools:** opencode tool names map onto the neutral `ToolKind` registry (foundation 6).
- **Auth:** per ADR-021 — delegated + in-app (API-key via `PUT /auth`; OAuth paste-code in-app,
  loopback delegated).
- **Hosted MCP:** inject our mermaid/mockup servers via `OPENCODE_CONFIG_CONTENT` at spawn
  (`hostedMcp: true` for opencode — unlike Codex v1).
- **Codex removal:** delete `src/main/codex/`, `ensure-codex`, the generated protocol, `getCodexStatus`,
  `CODEX_CAPABILITIES`, `docs/codex/` (recoverable from `codex-sup` git history).

## Consequences

- New `src/main/opencode/`: server manager, legacy/v1 protocol client (HTTP+SSE), `OpencodeSession`,
  event mapper, tool→kind map, `OpencodeAuthProvider`.
- Maintenance parity with the Codex approach: `opencodeCliVersion` + a pinned spec snapshot move
  together; a smoke test guards the wire contract on bumps.
- opencode is multi-vendor, so one engine surfaces many vendors/accounts — handled by the
  engine/vendor/account model (ADR-018) and per-vendor auth (ADR-021).

## Relation to existing ADRs

- **Supersedes ADR-017** (Codex backend) — Codex demoted to dormant fallback.
- Implements the engine model of **ADR-018**; auth in **ADR-021**; persistence/config in **ADR-020**;
  tool rendering via the neutral ToolKind registry (`src/shared/tool-kinds.ts` + the per-engine tool
  maps under `src/renderer/src/components/chat/tool-registry/`).
