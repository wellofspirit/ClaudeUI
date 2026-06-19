# ClaudeUI V2 — Multi-Engine Redesign

> **Status: design in progress.** These are working design docs, not yet locked.
> Nothing here is implemented. Claude continues to work unchanged throughout.

## Why this exists

ClaudeUI was built as a **desktop client for Claude Code**. Every subsystem assumes
the backend is Claude: usage analytics speak Anthropic's subscription API, settings
configure cli.js behavior, permissions/MCP/skills read and write Claude's config files,
auth is Anthropic OAuth, persistence parses Claude's JSONL transcripts.

Adding **opencode** as a second engine (and keeping **Codex** as a dormant fallback) is
therefore **not** a "provider plug-in." Only the session/chat layer has a real seam
(`ISession`, ADR-016). The other ~80% of the app hard-codes Claude. This is a **V2
re-platform**.

## The spine: three layers

ClaudeUI collapses three independent concepts into the single word "Claude." V2 must
separate them — almost every feature is coupled because it assumes all three at once.

| Layer | What it is | Owns |
| --- | --- | --- |
| **Engine** | The harness running the agent loop (Claude Code cli.js, opencode, [codex]) | Session protocol, tool set, permission system, config plane, persistence format, slash commands, skills, MCP wiring |
| **Vendor** | Who makes the model (Anthropic, OpenAI, Google, local) — *opencode calls these "providers"* | Model list, model capabilities (thinking/effort/vision/context), token accounting |
| **Account** | How you authenticate and are metered (Anthropic Max subscription w/ 5h windows, Anthropic API key, ChatGPT plan, OpenAI key, free local) | Usage semantics, auth, rate-limit display |

Today these are fused: one engine, one vendor, one account, all "Claude." opencode
detonates the fusion — **one engine spanning many vendors and many metering models**,
where switching the model *mid-session* changes vendor, capabilities, and billing at once.

So **"multi-vendor" is the wrong term — it's multi-engine, where some engines are
themselves multi-vendor.** Engine is the primary axis; vendor is a sub-axis under engines
like opencode. This is the top-level organizing principle for the whole UI.

> **Terminology note:** our current `ProviderId` means *engine*. opencode's "provider"
> means *vendor*. To avoid a permanent collision when reading opencode code/responses,
> V2 renames our concept to **engine** and reserves **vendor** for the model-maker. See
> [01-data-model.md](01-data-model.md) §Naming.

## Guiding principle: design fully, build incrementally

Design the entire target architecture on paper so we don't paint ourselves into corners,
then land it behind the abstractions **one foundation at a time**. Claude keeps working at
every step. **Design-completeness ≠ big-bang rewrite.**

## Foundations (design order — dependency-driven, not feature-driven)

The order is what each foundation *depends on*, not how user-visible it is.

| # | Foundation | Why here | Doc & status |
| --- | --- | --- | --- |
| 1 | **Data model** | Entities + identity for engine / vendor / account / model / session. Anchors the vocabulary everything else references. | [01-data-model.md](01-data-model.md) — ✅ locked |
| 2 | **Capability model** | What each engine×model *can do* — defines which features the app can offer and gives meaning to the data model. | [02-capability-model.md](02-capability-model.md) — ✅ locked |
| 3 | **Settings & config** | Controlling each engine's behavior. Can't scope it until capability says what's controllable. | [03-settings-config.md](03-settings-config.md) — ✅ locked |
| 4 | **Auth & accounts** | Per-engine login + a neutral "is this engine/vendor usable?" state. Precedes metering — metering hangs off the account. | [04-auth-accounts.md](04-auth-accounts.md) — 📝 draft (in-app: API-key + paste-code; loopback delegated) |
| 5 | **Metering & usage** | Tokens are universal; cost/windows are per-vendor API hookups. The easy one. | [05-metering-usage.md](05-metering-usage.md) — ✅ locked |
| 6 | **Tool rendering** | Engine-keyed tool→renderer registry. Last — and the current Claude coverage needs rework, not just a port. | [06-tool-rendering.md](06-tool-rendering.md) — ✅ locked |

## ADRs & implementation

The locked foundations are recorded as ADRs:

- [ADR-018](../adr/adr-018_v2-engine-vendor-account-model.md) — engine/vendor/account + capability model *(supersedes ADR-016)*
- [ADR-019](../adr/adr-019_opencode-engine-backend.md) — opencode engine backend *(supersedes ADR-017)*
- [ADR-020](../adr/adr-020_v2-persistence-and-config-plane.md) — persistence & config-plane *(amends ADR-009/011)*
- [ADR-021](../adr/adr-021_neutral-auth-account-model.md) — neutral auth/account model *(amends ADR-014/015)*

Rollout sequencing (design fully, build incrementally): **[implementation-plan.md](implementation-plan.md)**.

## Decision log (the pivot)

- **Codex → opencode pivot.** opencode is a meta-harness that runs OpenAI/Anthropic/Google/
  local models, so it subsumes "access to Codex models" while being a better harness. The
  direct `codex app-server` backend becomes a **dormant fallback** (insurance if OpenAI ever
  de-supports opencode). Codex backend code is removed (recoverable from `codex-sup` git
  history); ADR-017 marked superseded rather than deleted.
- **opencode engine decisions** (from earlier design discussion): shared ref-counted
  `opencode serve` per cwd (multiplexes sessions; dissolves the cold-spawn perf problem);
  legacy/v1 API + event family (complete: has abort/fork/delete); auth delegated in v1.
- **Persistence split** (foundation 1): human-editable **config stays in plain-text files**
  (settings, permission rules, MCP config, slash commands); **operational/derived data → a DB
  (SQLite)** (usage, account info, engine/model capability cache, session metadata);
  **credentials stay file-based** (ADR-015). See [persistence.md](persistence.md).
- **Eager rename** `provider`→`engine` across the codebase — `provider` is ambiguous and
  collides with opencode's term for *vendor* (foundation 1 §8).
- **Mid-session switching**: `engineId` is immutable per session; the **model** is switchable
  in-place on the live engine (no respawn), bounded by what the engine offers.
