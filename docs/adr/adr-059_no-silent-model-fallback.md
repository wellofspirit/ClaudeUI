# ADR-059 — Configured model references fail loudly: no silent fallback

**Status:** Accepted (owner ruling 2026-08-21) — implemented in `fceecca`
**Relates to:** ADR-023 (its "unavailable judge → human" rule now includes a catalog-stale configured judge, said out loud), ADR-030 (capability honesty — a substitute model silently changes the capability story the UI just told), ADR-033 (cross-engine dispatch — `dispatch.defaultModel`/`allowedModels` are references under this rule)

## Context

Model catalogs churn underneath configuration that names models by id. opencode's zen
gateway rotates free models, provider allowlists get curated, providers get disabled,
and a vendor retires ids (`openai/gpt-5.5`). Before this ruling, every resolution
chokepoint answered a stale reference the same way: pick something else quietly —
`resolveOpencodeSpawnModel` swapped to a free zen model with a `logger.warn` nobody
reads, `resolvePiSpawnModel` swapped to `PI_DEFAULT_MODEL` or the first catalog entry,
the renderer's default-model resolution substituted the first free model into new
sessions, and pi's judge transport degraded a broken configured judge model to "keep
pi's own default" via a `catch → null`.

The 2026-08-21 image-paste regression showed why the substitute is not a smaller
version of the requested model. The user's configured opencode default had vanished;
the silent fallback landed on a NO-vision model; every new opencode session seeded
`capabilities.vision:false` from it; and since pre-spawn model switches never re-seeded
the sealed `status.capabilities` (fixed in the same commit), the attach menu hid and
pasted images were dropped — three layers of quiet accommodation compounding into a
"paste is broken" report with the actual cause (a stale config string) nowhere in
sight. A substitute model differs in capabilities, cost, and behavior; for the
auto-mode judge it silently changes _which model holds the security keys_.

## Decision

**An EXPLICIT user-configured model reference that is no longer available must produce
an error at the point of use, never a silent substitute. BUILT-IN heuristic defaults —
where the user configured nothing — may keep falling back quietly.** Configured-ness is
the boundary: an error is only owed where there was intent to violate.

What counts as a configured reference: opencode's native `model`/`smallModel`, pi's
`piConfig.defaultModel`, `autoMode.judgeModel` (any engine), `dispatch.defaultModel`
and `dispatch.allowedModels` entries (any engine), and a per-session requested model
(the picker pick persisted on the session slot). What does not: the builtin
`OPENCODE_DEFAULT_MODEL`/`PI_DEFAULT_MODEL` constants, and the per-engine last-picked
stickiness (`lastSelectedModelByEngine`) — both are ClaudeUI heuristics, and a stale
entry falls through to the next rung silently.

Enforcement, per surface:

1. **Spawn** — `resolveOpencodeSpawnModel`/`resolvePiSpawnModel` throw
   `ModelUnavailableError` (`shared/model-errors.ts`, user-readable message naming the
   model and the owning settings surface) for a requested model absent from a
   **non-empty** catalog. The rejection rides the existing create-session path to the
   send-error banner, draft preserved. No-request calls keep the heuristic ladder
   (agent-generate depends on it).
2. **Renderer seeding** — `opencodeDefaultModelConfigured`/`piDefaultModelConfigured`
   split user config from the builtin constant. A stale configured default seeds
   `selectedModel: ''` (the picker's "Select a model" row), banners once via
   `addError`, is never encoded into `sessionEngines`, and send is blocked until a
   model is picked. The engine does NOT flip to claude — that guard remains reserved
   for "no models at all".
3. **Judge** — a configured `autoMode.judgeModel` absent from the engine's catalog
   emits one `session:error` per session and fails CLOSED to human approval. Never a
   substitute judge, and specifically never `?? this._model` — promoting the session's
   own model to security judge is not what "I picked a cheaper/stronger judge" asked
   for. (Extends ADR-023's unavailable-judge rule; the unset case still defaults to the
   session's own model, which is parity, not fallback.)
4. **Settings edits** — the orphan guard (`shared/model-references.ts`
   `findModelReferences`, scanning ALL engines' configs because claude's cross-engine
   dispatch legitimately names opencode models) REFUSES an allowlist save or a provider
   disable/remove that would strand a configured reference, naming it inline. Refusing
   beats applying-and-warning: after the write the reference is already broken and the
   config that names it is a different dialog away. Stale values already saved render
   verbatim with an "(unavailable)" marker — never collapsed to the empty label.

**Validation requires a non-empty catalog.** An empty or failed discovery cannot
distinguish "removed" from "not discovered yet", so every check passes the value
through unvalidated rather than erroring on ignorance — the same epistemic line the
spawn resolvers already drew.

## Consequences

- A stale config string surfaces at its first use, named, with the settings surface
  that owns it — instead of as a capability mystery three layers downstream.
- A session slot remembering a since-removed model now errors at spawn where it
  previously swapped silently (release-note-worthy behavior change; the picker
  converges the slot on real picks, so it is rare).
- Allowlist curation is stricter: `dispatch.allowedModels` orphaning is a hard block.
  If that proves annoying in practice, downgrading just that reference kind to a
  warning is a one-line change at `findModelReferences`' call sites.
- Known race: the opencode judge pre-check is cache-only (`peekOpencodeModels`), so a
  gated approval racing a cold discovery cache validates nothing and uses the
  configured judge. `eagerConnect` awaits discovery, which makes the window small;
  switching to the async form would put a discovery await on the approval path.
- Fresh-install UX is unchanged: with nothing configured, the builtin ladders still
  pick a working model without ceremony.
