# Phase 2 — Capability model (implementation kickoff)

> **You are implementing Phase 2 of the V2 plan** ([implementation-plan.md](implementation-plan.md)).
> Replace the frozen `SessionCapabilities` constant with a **computed**
> `ResolvedCapabilities = resolve(EngineCapabilities, ModelCapabilities)`, recomputed on every model
> switch, and **gate every §4 feature** on it. **Behavior-preserving for Claude** — all caps resolve
> true, so the UX is identical. Read this fully, then [02-capability-model.md](02-capability-model.md)
> (the authoritative design) and [01-data-model.md](01-data-model.md) §6.

## Scope decisions (made — flagged for veto)

1. **Wire ALL §4 gates** (chosen): every feature in the capability→feature map (§ below) becomes
   gated on `ResolvedCapabilities`, not just the two already gated. For Claude every gate resolves
   **true**, so nothing changes visually — but the wiring must be exhaustive and correct.
2. **Consolidate reasoning into `src/shared/model-capabilities.ts`** (chosen): build
   `ReasoningCapability` + `ModelCapabilities` there, reusing the existing
   `modelSupportsAdaptiveThinking` / `modelSupportsEffort` / `modelSupportedEffortLevels` /
   `modelDefaultEffort` logic. Do **not** create a second source of thinking/effort truth.
3. **Claude-only values**: populate `EngineCapabilities` for `'claude'` and `ModelCapabilities` for
   Claude models. opencode's real values + models.dev ingest are **Phase 5** — don't fabricate them
   (a `'claude'`-only registry is fine; `resolveCapabilities` is only ever called for claude now).
4. **`costUsd` leaves capabilities** (design §6). Interim: the cost/status-line display stays on for
   Claude (it's the only engine; subscription → notional USD). Real billing-gating is **Phase 7**.
   Replace `capabilities.costUsd` reads with a constant `true` + a `// Phase 7: gate on
   Account.billingType` note. Do NOT wire account/metering here.
5. **`isAgentCapable=false` (chat-only degraded mode)**: implement the gate, but it never triggers
   for Claude (all Claude models are `toolCalling:true`). The tool-dependent gates (`canUseMcp`,
   `canUseSubagents`) AND in `model.toolCalling`, so they're all true for Claude.

## The capability types — in `src/shared/model-capabilities.ts`

```ts
type AutonomyMode = 'plan' | 'ask' | 'autoEdit' | 'full'

interface EngineCapabilities {           // vendor-independent, static per engine
  voice: boolean
  hostedMcp: boolean
  backgroundTasks: boolean
  subagents: boolean
  plan: boolean
  fork: boolean
  forkFromMessage: boolean
  steer: boolean
  queue: boolean
  slashCommands: boolean
  skills: boolean
  sideQuestion: boolean
  interactiveApprovals: boolean
  autonomyModes: AutonomyMode[]
  auth: { canDriveLogin: boolean; multiAccount: boolean }
}

// TWO independent axes (02 §3.2, corrected): a model may have BOTH (Claude: thinking modes AND
// effort tiers), one, or neither. NOT a single-kind union. ThinkingMode/EffortLevel come from
// src/shared/model-capabilities.ts — the single source of truth (don't redefine them).
interface ReasoningCapability {
  thinking?: { modes: ThinkingMode[]; supportsBudget?: boolean }  // adaptive|enabled|disabled
  effort?: { levels: EffortLevel[] }                              // low…xhigh|max ('minimal' added when opencode lands)
}                                                                 // both absent ⇒ no reasoning controls

interface ModelCapabilities {            // per (engine,vendor,model)
  reasoning: ReasoningCapability
  vision: boolean
  toolCalling: boolean
  contextWindow: number
  maxOutput: number
  promptCaching: boolean
}

interface ResolvedCapabilities extends EngineCapabilities {
  reasoning: ReasoningCapability
  vision: boolean
  toolCalling: boolean
  contextWindow: number
  maxOutput: number
  promptCaching: boolean
  // AND-of-both derived gates:
  canUseMcp: boolean        // hostedMcp && toolCalling
  canUseSubagents: boolean  // subagents && toolCalling
  isAgentCapable: boolean   // toolCalling
}

function resolveCapabilities(engine: EngineCapabilities, model: ModelCapabilities): ResolvedCapabilities
```

### Claude `EngineCapabilities` (all true — keeps Claude UX intact)
`voice, hostedMcp, backgroundTasks, subagents, plan, fork, forkFromMessage, steer, queue,
slashCommands, skills, sideQuestion, interactiveApprovals` → **all `true`**;
`autonomyModes: ['plan','ask','autoEdit','full']`; `auth: { canDriveLogin: true, multiAccount: true }`.

### Claude `ModelCapabilities` (derive, reuse existing helpers)
`model-capabilities.ts` is the **single source of truth** and becomes the **Claude normalizer** —
derive the neutral shape there, reusing its existing helpers (do NOT re-derive thinking/effort):
- `reasoning.thinking`: when `modelSupportsAdaptiveThinking(m)` → `{ modes: THINKING_MODES, supportsBudget: true }`; omit otherwise.
- `reasoning.effort`: when `modelSupportsEffort(m)` → `{ levels: modelSupportedEffortLevels(m) }`; omit otherwise.
- (Claude models commonly have **both**; a model with neither → `reasoning = {}`.)
- `vision: true`, `toolCalling: true`, `promptCaching: true` for Claude models.
- `contextWindow`/`maxOutput`: from `context-window.ts` (`getContextWindowSize`) / known per-model
  values; a sane default is fine if unknown (behavior-preserving — context meter already works today).

## Wiring `ResolvedCapabilities` onto the session

- `SessionStatus.capabilities: SessionCapabilities` → **`ResolvedCapabilities`** (`shared/types.ts`).
- Delete `SessionCapabilities`, `CLAUDE_CAPABILITIES`, and `capabilitiesFor()`. Replace their uses
  with `resolveCapabilities(engineCaps('claude'), modelCaps(currentModel))`.
- `ClaudeSession`: compute `ResolvedCapabilities` when building status, from its current model.
  **Re-emit status on `setModel`** so capabilities recompute mid-session (the new behavior — for
  Claude only `reasoning` can change across models; engine caps are constant).
- Store seeds (`EMPTY_SESSION_STATE`, `createNewSession`): seed `status.capabilities` with the
  resolved caps for the default model so gating is correct before spawn (as today).

## §4 gate-site map — wire each (all resolve true for Claude)

| Feature | Gate (`ResolvedCapabilities`) | Site(s) |
| --- | --- | --- |
| thinking-mode picker | `reasoning.thinking` present (modes from it) | `InputBox.tsx`, `InputBox/View.tsx` (migrate from `thinkingModes`) |
| effort picker (+ levels) | `reasoning.effort` present (levels from it) | `InputBox.tsx`, `InputBox/View.tsx` (migrate from `effortLevels`) |
| image-attach button | `vision` | `InputBox.tsx` / `FileAttachmentBar.tsx` |
| context-usage meter | `contextWindow > 0` | `InputBox/View.tsx` (StatusLine) |
| voice button | `voice` | `InputBox.tsx` (already gated) |
| MCP dialog + injection | `canUseMcp` | `ChatPanel/TopBar.tsx` (the MCP button/dialog) |
| subagent / Task UI | `canUseSubagents` | `MessageBubble.tsx`, `SubagentMessages.tsx`, `TaskCard.tsx`, `AgentTabBar` |
| plan mode in mode picker | `plan` | `InputBox/View.tsx` (mode picker — keep other modes) |
| fork action | `fork` | `MessageBubble.tsx` (already gated) |
| fork-from-message | `forkFromMessage` | `MessageBubble.tsx` |
| background-task affordances | `backgroundTasks` | `ToolCallBlock/*` (run-in-background), background output UI |
| slash-command menu | `slashCommands` | `InputBox.tsx` / `useSlashMenu` / `SlashCommandMenu` |
| skills dialog | `skills` | `ChatPanel/TopBar.tsx` (the Skills button/dialog) |
| side-question UI | `sideQuestion` | `BtwCard.tsx` (+ its trigger) |
| queue / steer controls | `queue` / `steer` | `InputBox.tsx` (+ `QueuedMessageCard`) |
| cost (USD) display | **constant `true`** (interim; `// Phase 7: Account.billingType`) | `InputBox.tsx`, `InputBox/View.tsx` (StatusLine) |

> **Invariant:** for Claude, every gate above must resolve **true** → no feature disappears. If a
> feature vanishes in the smoke test, the registry value or the gate is wrong.

## Step-by-step

1. **Branch** `v2-phase-2-capability-model` off `v2-phase-1-engine-rename` (already created). Don't
   commit; leave the tree modified for review.
2. `model-capabilities.ts`: add the types + the `claude` `EngineCapabilities` + a
   `claudeModelCapabilities(modelInfo)` deriver + `resolveCapabilities()`. Reuse existing helpers.
3. `shared/types.ts`: `SessionStatus.capabilities → ResolvedCapabilities`; delete
   `SessionCapabilities`/`CLAUDE_CAPABILITIES`/`capabilitiesFor`.
4. `bun run typecheck` → the broken sites are every capability consumer; fix to the new shape.
5. `ClaudeSession`: build + re-emit `ResolvedCapabilities` (on start and `setModel`). Store: seed
   resolved caps in `EMPTY_SESSION_STATE`/`createNewSession`.
6. Wire the §4 gate sites (table). Keep each feature visible for Claude.
7. Tests: a `resolveCapabilities` unit test (Claude engine × a thinking model and an effort model →
   correct `reasoning`, all engine gates true, `canUseMcp/Subagents/isAgentCapable` true); update
   capability assertions to the new shape; a test that a no-`toolCalling` model resolves
   `canUseMcp=false`/`isAgentCapable=false` (the degraded path, even though no Claude model hits it).
8. Update `CLAUDE.md` capability notes + the ADR/structure references.
9. Sweep: `rg "SessionCapabilities|CLAUDE_CAPABILITIES|capabilitiesFor|capabilities\.costUsd" src`
   returns nothing.

## Verify

```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
Then a **runtime smoke** via the `verifier-electron` skill — and because this phase gates real
features, drive/observe that for a Claude session **every §4 feature is still present**: open a
session, confirm the toolbar shows thinking/effort, voice, attach, slash menu; TopBar shows MCP +
Skills; the mode picker has plan; a message shows fork; the status line shows context + cost. Read
the screenshot(s). A missing feature = a gating regression.

## Gotchas

- **Behavior-preserving = every gate true for Claude.** The whole risk of "wire all gates" is a
  typo'd registry value silently hiding a feature. Smoke-test the feature list.
- **`reasoning` is two optional axes, not one union** — gate the thinking-mode picker on
  `reasoning.thinking` (modes from it) and the effort picker on `reasoning.effort` (levels from it).
  A Claude model can expose **both at once** (don't make them mutually exclusive). Preserve today's
  per-model behavior — same models → same two pickers.
- **Recompute on model switch** — `setModel` must re-emit `status.capabilities`. The renderer reads
  `status.capabilities` via reactive selectors, so it updates automatically once status re-emits.
- **Don't add account/metering** — `costUsd` interim is a constant `true`; no `AccountRef`/billing
  wiring (Phases 4/7).
- **opencode** stays type-only — no opencode capability values, no models.dev (Phase 5).

## Commit

Branch off `v2-phase-1-engine-rename`; no AI attribution. Suggested:
`refactor(v2): computed capability model — EngineCapabilities × ModelCapabilities (Phase 2)`.
