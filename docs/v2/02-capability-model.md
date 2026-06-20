# Foundation 2 — Capability Model

> **Status: DRAFT for discussion.** Defines the capability taxonomy that gives the data
> model meaning: which capabilities are engine-level, which are model-level, how they resolve
> onto a session, and which UI feature each one gates. Builds on [01-data-model.md](01-data-model.md).

## 1. Purpose

Capability answers *"what can this session actually do?"* — and therefore *"which features does
the UI show?"* Today that's a frozen 10-boolean constant per provider. V2 makes it a **computed
value**, because on a multi-vendor engine the answer changes **per model** and **mid-session**.

This is the foundation you flagged as defining "what features we can have." The deliverables:
the two capability levels, the resolution onto a session, the capability→feature gating map,
and the (real, non-speculative) data sources.

## 2. Current state

`SessionCapabilities` — 10 booleans, frozen per provider (`CLAUDE_CAPABILITIES`,
`CODEX_CAPABILITIES`), set once at creation. Three problems:

1. **Flat booleans** can't express effort *levels* or thinking *modes* — `effortLevels: true`
   says nothing about *which* levels.
2. **Per-provider** can't express per-model variation (the opencode reality).
3. It **mixes concerns**: engine (voice), model (effort), and billing (costUsd) in one bag.

## 3. The two levels

### 3.1 `EngineCapabilities` — the harness (vendor-independent)

```ts
type AutonomyMode = 'plan' | 'ask' | 'autoEdit' | 'full'  // neutral; display labels owned by ClaudeUI (see 03 §4)

interface EngineCapabilities {
  voice: boolean                // voice input
  hostedMcp: boolean            // can inject our in-process MCP servers (mermaid/mockup)
  backgroundTasks: boolean
  subagents: boolean            // delegated child agents
  plan: boolean                 // a plan / read-only mode exists
  fork: boolean                 // branch a session
  forkFromMessage: boolean      // branch from a specific message (turn-granular)
  steer: boolean                // inject input mid-turn
  queue: boolean                // queue a message while a turn runs
  slashCommands: boolean
  skills: boolean               // SKILL.md-style skills
  sideQuestion: boolean         // ask an out-of-band question
  interactiveApprovals: boolean // can pause and ask permission (vs all-or-nothing)
  autonomyModes: AutonomyMode[] // which neutral autonomy modes this engine can map (03 §4)
  auth: { canDriveLogin: boolean; multiAccount: boolean } // in-app login? selectable accounts? (04)
}
```

Static — a `Record<EngineId, EngineCapabilities>`. We know what each harness supports:

| capability | claude | opencode |
| --- | --- | --- |
| voice | ✓ | ✗ (v1) |
| hostedMcp | ✓ | ✓ (config injection) |
| backgroundTasks | ✓ | ✗ |
| subagents | ✓ | ✓ (child sessions via task tool) |
| plan | ✓ | ✓ (plan agent) |
| fork / forkFromMessage | ✓ / ✓ | ✓ / ✓ (native `fork {messageID}`) |
| steer | ✓ (queue-control) | ✓ (`delivery: steer`) |
| queue | ✓ | ✓ (`delivery: queue`) |
| slashCommands | ✓ | ✓ |
| skills | ✓ | ✗ (has agents/commands instead) |
| sideQuestion | ✓ | ✗ |
| interactiveApprovals | ✓ | ✓ |
| autonomyModes | plan, ask, autoEdit, full | plan, ask, full *(no autoEdit — verify)* |
| auth.canDriveLogin | ✓ | ✓ (API-key + paste-code OAuth; loopback OAuth delegated) |
| auth.multiAccount | ✓ | ✗ (one credential per vendor) |

> The opencode column is from the protocol research — verify against the binary during impl.

### 3.2 `ModelCapabilities` — the specific model (vendor/model-specific)

Crucially **not all booleans** — reasoning is a structured descriptor, because the UI needs to
know the *shape* and *levels* of the control, not just that it exists:

```ts
// Reasoning is TWO independent axes — a model may have BOTH (Claude: thinking modes AND effort
// tiers), one (OpenAI: effort only; Google: thinking only), or neither (local). A single-kind
// union can't represent Claude, which exposes both controls at once.
interface ReasoningCapability {
  thinking?: { modes: ThinkingMode[]; supportsBudget?: boolean }  // adaptive|enabled|disabled — anthropic, google
  effort?:   { levels: EffortLevel[] }                            // minimal…xhigh|max — anthropic, openai
}                                                                 // both absent ⇒ no reasoning controls

interface ModelCapabilities {
  reasoning: ReasoningCapability   // thinking picker iff .thinking; effort picker iff .effort
  vision: boolean                  // image input
  toolCalling: boolean             // function/tool calling — REQUIRED for agentic use
  contextWindow: number            // max input tokens (context-usage display)
  maxOutput: number                // max output tokens
  promptCaching: boolean           // affects metering display (05)
}
```

> `ThinkingMode`/`EffortLevel` reuse the existing `src/shared/model-capabilities.ts` types
> (`EffortLevel` gains `'minimal'` for OpenAI when opencode lands). **That module is the single
> source of truth** and becomes the **Claude normalizer** feeding this neutral shape (§5) — do not
> re-derive thinking/effort anywhere else.

### 3.3 `ResolvedCapabilities` — what the UI consumes

```ts
function resolveCapabilities(engine: EngineCapabilities, model: ModelCapabilities): ResolvedCapabilities
```

Mostly a field merge, but some resolved caps are an **AND of both levels**, because a feature
needs the engine *and* a capable model:

- `canUseMcp        = engine.hostedMcp && model.toolCalling`
- `canUseSubagents  = engine.subagents && model.toolCalling`
- `isAgentCapable   = model.toolCalling`   // a no-tool-calling model can't run the loop at all

When `isAgentCapable` is false (a no-tool-calling model, only reachable via opencode), the
session degrades to **chat-only**: we **keep** it (chatting with a "dumb" model is allowed) but
gate *all* tool-dependent UI off — MCP, subagents, permissions, tool cards — since there is
nothing to run, approve, or render. It's a first-class degraded mode, not an excluded model.

`ResolvedCapabilities` is what every capability-gated component reads, and it is **recomputed on
session start and on every model switch** (the behavioral change from 01 §6). This is the part
that makes the renderer audit necessary: components that read capabilities once today must
react to live changes.

## 4. Capability → feature gating map

This table **is** the answer to "what features can we have per engine/model." It's the contract
the renderer audits against.

| UI feature / affordance | gated by | level |
| --- | --- | --- |
| thinking-mode picker | `reasoning.thinking` (modes from it) | model |
| effort picker (+ its levels) | `reasoning.effort` (levels from it) | model |
| image-attach button | `vision` | model |
| context-usage meter | `contextWindow` (value) | model |
| voice button | `voice` | engine |
| MCP dialog + tool injection | `hostedMcp && toolCalling` | engine ∧ model |
| subagent / Task UI | `subagents && toolCalling` | engine ∧ model |
| plan mode in mode picker | `plan` | engine |
| fork action | `fork` | engine |
| fork-from-message action | `forkFromMessage` | engine |
| background-task affordances | `backgroundTasks` | engine |
| slash-command menu | `slashCommands` | engine |
| skills dialog | `skills` | engine |
| side-question UI | `sideQuestion` | engine |
| queue / steer controls | `queue` / `steer` | engine |
| cost (USD) display | **account billing, not a capability** — see §6 | account |

## 5. Data sources (not speculative)

- **EngineCapabilities** — static, hardcoded per engine (the §3.1 table → the registry).
- **ModelCapabilities** —
  - **Claude**: the existing `src/shared/model-capabilities.ts` is the source of truth (SDK
    `ModelInfo` fields + cli.js-mirroring heuristics). It becomes the **Claude normalizer** →
    map `modelSupportsAdaptiveThinking → reasoning.thinking`, `modelSupportedEffortLevels →
    reasoning.effort`, `resolveContextWindow → contextWindow`. **Reuse it — do not re-derive
    thinking/effort in a parallel module.**
  - **opencode**: `GET /config/providers` returns per-model metadata sourced from **models.dev**,
    which carries `reasoning`, `tool_call`, `attachment` (→ vision), `limit.context` /
    `limit.output`, `cost.*`. Normalize into `ModelCapabilities`.
  - Both feeds normalize into the one shape; the model picker tags each `ModelDescriptor` with
    its resolved caps. models.dev is, in effect, a maintained capability catalog we get for free
    via opencode.

## 6. Reclassifications from old `SessionCapabilities`

| old field | new home |
| --- | --- |
| `thinkingModes` | `ModelCapabilities.reasoning` (`anthropicThinking`) |
| `effortLevels` | `ModelCapabilities.reasoning` (`effortTiers`) |
| `voice`, `hostedMcp`, `backgroundTasks`, `subagents`, `plan`, `fork`, `sideQuestion` | `EngineCapabilities` |
| **`costUsd`** | **leaves capabilities entirely** → `Account.billingType` (metering, 05) |

The `costUsd` move is the notable one. `costUsd` today is **token-derived USD** (tokens ×
per-model price — cli.js's `result.total_cost_usd` accumulated per session; a hardcoded
`MODEL_PRICING` table in `block-usage.ts` for the analytics dashboard), **not** a subscription
fee and **not** an account billing-API total. It's *notional* for subscription accounts (you
aren't billed it — the real constraint is the 5h-window rate-limit %, ADR-011). So there are
three distinct notions — **tokens** (universal), **USD cost** (tokens × price, where pricing is
known), **subscription utilization %** (vendor API) — and which is meaningful depends on
`Account.billingType`. "Show USD" is therefore a metering output keyed on billingType + pricing
availability, not a capability. Hence it moves to foundation 5.

## 7. Migration

- Replace `SessionCapabilities` + `CLAUDE_/CODEX_CAPABILITIES` with: an `EngineCapabilities`
  registry, per-model `ModelCapabilities`, and `resolveCapabilities()`.
- `SessionStatus.capabilities` becomes `ResolvedCapabilities`, **re-emitted on model switch**.
- Capability-gated renderer components read `ResolvedCapabilities` — no logic change beyond the
  new shape + reacting to mid-session changes. An audit step enumerates every component that
  reads a capability today (the §4 rows) and confirms it tolerates live changes.

## 8. Decisions

1. **`reasoning` is two independent axes** ✓ (corrected during Phase-2 impl) — `{ thinking?, effort? }`,
   not a single-kind union: Claude exposes *both* thinking modes and effort tiers at once. Sourced
   from `src/shared/model-capabilities.ts` (the Claude normalizer); no parallel module (§3.2/§5).
2. **Tool-dependent resolution** ✓ — AND-logic (`engine ∧ model.toolCalling`). Non-tool-calling
   agents are rare today, but the gate is the correct guard.
3. **No-tool-calling models** ✓ — **keep, don't filter.** A no-tool-calling model (opencode-only)
   yields a **chat-only session**: `isAgentCapable=false` gates *all* tool-dependent UI off; the
   user can still chat (§3.3).
4. **`costUsd`** ✓ — leaves the capability model. It's token-derived USD (not subscription cost;
   notional under subscription), so it becomes a metering output keyed on `Account.billingType`
   + pricing availability (foundation 5, §6).
5. **models.dev ingest scope** ✓ — ingest the capability-gating fields now (reasoning,
   toolCalling, vision, contextWindow); defer pricing + caching to metering (05), where
   models.dev's `cost.*` becomes the multi-vendor pricing source.
