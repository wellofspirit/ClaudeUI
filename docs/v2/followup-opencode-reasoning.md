# Follow-up — opencode reasoning picker (per-model effort variants)

> ROADMAP **#5**. opencode models that support reasoning expose per-model **effort variants** (NOT a
> single boolean): e.g. minimax → `none`/`thinking`, OpenAI → `none`/`low`/`medium`/`high`/`xhigh`,
> Anthropic-via-opencode → `low`/`medium`/`high`/`max`. These are in `model.variants` (exposed via
> `/config/providers`), gated on `model.capabilities.reasoning`. The prompt request accepts a `variant`.
> This surfaces a **per-model reasoning picker** in the input box for opencode models and wires the
> chosen variant into the prompt. **Claude untouched.** Branch `v2-followup-opencode-reasoning` (off
> `v2-followup-opencode-statusline`). opencode source ref: `D:\WorkPlace\opencode-src` (READ-ONLY).

## Verified facts (do NOT re-discover)

- **opencode reasoning = effort variants** (`opencode-src/provider/transform.ts` `variants(model)`,
  `:665`): returns `{}` unless `model.capabilities.reasoning`; otherwise an effort-name → providerOptions
  map (`none`/`thinking`, or `low`/`medium`/`high`/`xhigh`/`max`, model/provider-specific). The variant
  is selected by NAME on the request.
- **The model exposes `variants`** (`provider/provider.ts:1031` schema `variants:
  Record<string, Record<string, any>>`, populated from `ProviderTransform.variants(model)`), and
  `/config/providers` serializes it via `Provider.toPublicInfo` (`server/.../handlers/config.ts:27`).
  So ClaudeUI can read the available variant **keys** per model.
- **The prompt accepts a `variant`** (`opencode-src/session/prompt.ts:989,1518` `variant: input.variant`;
  `:661` falls back to the agent/model default when absent). No variant sent → opencode's default
  (reasoning models reason by default).
- **ClaudeUI gaps:**
  - `protocol/types.ts` `Model` has `capabilities.reasoning: boolean` + `limit`/`cost` but **no
    `variants`**; `PromptRequest` (`:81`) has **no `variant`**.
  - `model-discovery.ts:31-50` maps models (caps/name/limit) but drops `variants`. `ModelInfo`
    (`shared/types.ts:395`) has no reasoning-variant field.
  - `OpencodeSession.sendPrompt` (`:466`) posts `{model, agent, parts}` — no variant.
  - The InputBox `ThinkingPicker`/`EffortPicker` (`InputBox/View.tsx:506-516`) are Claude-specific
    (gated on `showThinkingPicker` = `capabilities.reasoning.thinking`, and `effortSupported`).
- **Per-session control pattern to mirror** (store): `effort` / `thinkingMode` fields
  (`session-store.ts:396-398`), setters `setEffort`/`setThinkingMode` (`:769-773`), persisted +
  snapshotted (`:1075-1076,1952-1953`); model is set via the `setModel` IPC (`InputBox.tsx:578` →
  `OpencodeSession.setModel`).

## Design (locked): per-model variant picker, renderer-driven

The renderer already has the model list (`getEngineModels`). Carry the variant keys on `ModelInfo` so
the InputBox can render the picker from the **selected** model; the main process just forwards the chosen
variant string in the prompt. No main-side variant lookup needed.

### Steps

1. **Protocol types** (`src/main/opencode/protocol/types.ts`): add `variants?: Record<string,
   Record<string, unknown>>` to `Model`; add `variant?: string` to `PromptRequest`.
2. **Discovery** (`model-discovery.ts`): for each model, compute `reasoningVariants = (m.capabilities?.reasoning
   && m.variants) ? Object.keys(m.variants) : []`; put it on the `ModelInfo`. Add
   `reasoningVariants?: string[]` to `ModelInfo` (`shared/types.ts`). (No separate main-side cache — the
   renderer reads it from the model list; the context-window cache from the prior branch is a separate
   concern, leave it.)
3. **Store** (`session-store.ts`): add per-session `reasoningVariant: string | null` (default null =
   send no variant = opencode default) to `PerSessionState` + `EMPTY_SESSION_STATE`; add
   `setReasoningVariant(variant: string | null, routingId?: string)` (updates the store AND calls the IPC
   for the active/target session, mirroring how the model picker calls `setModel`). Persist + snapshot it
   alongside `effort`/`thinkingMode` (config save + remote snapshot). **Reset `reasoningVariant` to null
   when the model changes** (in `setModel`/`setSelectedModel`) — a new model has different variants.
4. **IPC + OpencodeSession**:
   - New channel `session:set-reasoning-variant` (preload + `ClaudeAPI` + handler in `session.ipc.ts`)
     → `session.setReasoningVariant?.(variant)`. Add an OPTIONAL `setReasoningVariant(variant: string |
     null)` to `ISession` (default no-op in `BaseSession`; Claude ignores it).
   - `OpencodeSession`: `private reasoningVariant: string | null = null`; `setReasoningVariant(v)` stores
     it; `sendPrompt` adds `variant: this.reasoningVariant ?? undefined` to the `promptAsync` body. Reset
     to null in `setModel`. (`OpencodeClient.promptAsync` already spreads the `PromptRequest`; just
     ensure `variant` is included in the posted body.)
5. **UI** (`InputBox` + a picker): render a **Reasoning** picker when the selected model has
   `reasoningVariants.length > 0` (opencode reasoning models). Options = `["Default", ...reasoningVariants]`
   (Default = null variant). On select → `setReasoningVariant`. Reuse `EffortPicker` if it cleanly accepts
   an arbitrary options list + label; otherwise add a small dedicated `ReasoningPicker` mirroring
   `EffortPicker`'s styling. Gate it on the selected model's variants (renderer-side), independent of the
   Claude `ThinkingPicker`/`EffortPicker` (which stay gated on Claude capabilities). For Claude models
   `reasoningVariants` is undefined/empty → picker hidden → Claude UI unchanged.
6. **Capability note:** the model-level `reasoningVariants` is the source of truth for the picker; you do
   NOT need to change `OPENCODE_ENGINE_CAPABILITIES.reasoning` or `resolveOpencodeCapabilities` (those
   are engine-generic; per-model variants come from discovery). Leave the capability model as-is.

## Tests (mocked, no binary)

- **model-discovery**: a `/config/providers` fixture with a reasoning model (`capabilities.reasoning:true`
  + `variants:{none:{},thinking:{}}`) → `ModelInfo.reasoningVariants` = `['none','thinking']`; a non-
  reasoning model (or no variants) → `[]`/undefined.
- **store**: `setReasoningVariant('high')` sets the per-session field + calls the IPC; `setModel(newModel)`
  resets `reasoningVariant` to null; snapshot/persist round-trips the field.
- **OpencodeSession**: `setReasoningVariant('thinking')` then a prompt → `promptAsync` body includes
  `variant:'thinking'`; default (null) → body omits `variant`; `setModel` resets it so the next prompt
  omits `variant`.
- **OpencodeClient**: `promptAsync` includes `variant` in the POST body when present, omits when absent.
- **InputBox** (component): a selected opencode model with `reasoningVariants` → the Reasoning picker
  renders with those options; selecting one calls `setReasoningVariant`; a model with no variants (or a
  Claude model) → no picker. Claude `ThinkingPicker`/`EffortPicker` unaffected.
- Keep existing model-picker / InputBox / Claude tests green.

## Verify

```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- 0 lint errors (3 pre-existing warnings OK). **No `bun install`** (better-sqlite3 ABI).
- **Real-app (orchestrator-driven):** the orchestrator will screenshot the picker via the temp
  `__sessionStore` hook — inject a model list with an opencode reasoning model (variants) + select it →
  assert the Reasoning picker renders with the variant options; select one and confirm the store +
  (mocked) IPC. (A genuine live opencode reasoning turn is a manual check the user can do.) Agent: report
  unit/gate results.

## Gotchas

- **No variant sent = opencode default** (reasoning on for reasoning models). "Default" picker option =
  null = omit `variant`. Don't invent an "on" variant name — use the model's actual variant keys.
- **Reset `reasoningVariant` on model change** — variant keys differ per model; a stale variant would be
  rejected/ignored by opencode.
- **Renderer-driven** — the variant list rides on `ModelInfo` from discovery; the main process only
  forwards the selected string. Don't build a main-side variant lookup.
- **Claude byte-identical** — the new picker only shows for models with `reasoningVariants`; Claude
  models have none. `ISession.setReasoningVariant` is an optional no-op for Claude.
- opencode-src is READ-ONLY. No new deps.

## Out of scope
- Mapping opencode variants onto Claude's two-axis `reasoning` capability (kept separate).
- Per-variant providerOptions tuning (opencode owns that via transform.ts).
- Persisting a global default reasoning variant across sessions (per-session only, like effort).

## Commit (orchestrator, after review + shot)
One commit, no AI attribution. Suggested subject:
`feat(v2/opencode): per-model reasoning (effort variant) picker wired to the prompt`.
