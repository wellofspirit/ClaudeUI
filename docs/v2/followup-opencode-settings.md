# Follow-up — opencode settings in the UI (no-JSON) + ModelRef vendor-at-spawn

> Kickoff spec, **settings refactor phase 2** (ROADMAP #6 remainder + the opencode-settings goal). Agent:
> **Sonnet, `general-purpose`**. Main model (Opus) reviews + owns correctness. Do **not** commit, `git add`,
> branch, or `bun install`. Leave the tree for review; report deltas, exact verify-gate output, deviations.

Builds on `v2-followup-settings-ia` (phase 1 — the tabbed Common/Claude/opencode scopes). This phase fills
the **opencode** tab with real settings so users stop hand-editing opencode JSON, and finishes #6's
vendor-at-spawn. **#12 capability-gating is deferred to a separate quick follow.**

## 0. Scope (locked with the user)
**IN — surface these opencode settings in the opencode tab + inject via `OPENCODE_CONFIG_CONTENT`:**
1. **Default model + small model** (`model` / `small_model`, format `provider/model`).
2. **Custom providers** — OpenAI-compatible / self-hosted: per-provider `baseURL` + model list
   (`provider[id].options.baseURL` + `provider[id].models`). API keys stay in auth.json (existing
   vendor-opencode auth UI) — do NOT inject `apiKey`.
3. **Disabled / enabled providers** (`disabled_providers` / `enabled_providers`).
4. **Per-agent overrides** (`agent[name]`: model + temperature).

Plus **#6 remainder — vendor-at-spawn**: derive the Claude vendor id from the active model's ModelRef
instead of hardcoding `'anthropic'` (structure-ready; no behavior change for Claude).

**OUT (do NOT do):** #12 capability-gating (caps flags + section gating — separate follow); writing
opencode `auth.json` / API-key management (the existing vendor-opencode section already does OAuth/keys);
opencode `permission`/`keybinds`/`theme` config; any Claude-side behavior change.

## 1. Verified facts (grounded — opencode source @ D:\WorkPlace\opencode-src)
- **`OPENCODE_CONFIG_CONTENT` deep-merges** into opencode's config (remeda `mergeDeep`), at priority just
  **above** project `opencode.json` and below console-managed config. So our injected JSON **adds/overrides
  only the keys we set** and never replaces the user's `opencode.jsonc`. ⇒ inject **only fields the user
  actually set** (spread-if-present), so unset fields don't clobber the user's own config; a SET field
  intentionally overrides their project config (UI = source of truth when set).
- **Injectable keys** (no credentials): `model`, `small_model` (strings `provider/model`);
  `disabled_providers`, `enabled_providers` (string[]); `provider` (`Record<id, { name?, options?: {
  baseURL? }, models?: Record<modelId, { name? }> }>`); `agent` (`Record<name, { model?, temperature?,
  … }>`). **Credentials (`apiKey`, OAuth) must stay in auth.json** — never inject.
- **Current injection:** `OpencodeServerManager.ts` `buildOpencodeConfigContent(mcpPort, mcpToken)` (line 92)
  emits only `{ mcp: { claudeui: {…} } }`, used in `spawnServer` (line 127), driven by `acquire(cwd)` (line
  301). The server is **per-cwd, ref-counted** — settings are captured at first spawn for that cwd.
- **Engine config store:** `loadEngineConfig('opencode')` / `saveEngineConfig('opencode', cfg)` (ui-config,
  `engines/opencode.json`). `EngineConfig` (shared/types.ts:265) currently `{ sandbox?, proxy?, autoMode? }`
  — `autoMode` is the existing opencode field (ClaudeUI's gatekeeper concept, ADR-023).
- **opencode model list for the UI:** `window.api.getEngineModels()` → groups; filter `g.engineId ===
  'opencode'`, `flatMap(g.models)` (each a `ModelInfo`). `available = oc.length > 0`. This is the exact
  pattern `OpencodeAutoModeSection` (settings-sections.tsx:425-466) uses — **mirror it** (load config +
  models on mount, self-gate "opencode is not installed", save via `saveEngineConfig('opencode', next)`).
- **Vendor-at-spawn today:** `session.ipc.ts` `session:create` (:769-778) — for non-opencode it loads
  `loadVendorConfig('anthropic')` and applies proxy/endpoint/model env; opencode SKIPS this block (its
  vendor config goes via `OPENCODE_CONFIG_CONTENT`, this spec). Comment flags the ModelRef derivation as a
  Phase-5 TODO.

## 2. The work

### 2a. Types (`src/shared/types.ts`)
Add the opencode-config passthrough as a nested blob on `EngineConfig` (keep `autoMode` flat — it's a
ClaudeUI concept; the new fields are opencode-native passthrough, so nest them under `opencodeConfig`):
```ts
export interface OpencodeProviderSettings { name?: string; baseURL?: string; models?: { id: string; name?: string }[] }
export interface OpencodeAgentSettings { model?: string; temperature?: number }
export interface OpencodeConfigSettings {
  model?: string         // "provider/model"
  smallModel?: string    // "provider/model"
  disabledProviders?: string[]
  enabledProviders?: string[]
  providers?: Record<string, OpencodeProviderSettings>  // keyed by provider id
  agents?: Record<string, OpencodeAgentSettings>        // keyed by agent name
}
export interface EngineConfig { sandbox?: SandboxSettings; proxy?: ProxySettings; autoMode?: AutoModeConfig; opencodeConfig?: OpencodeConfigSettings }
```

### 2b. Injection (`OpencodeServerManager.ts`)
- `buildOpencodeConfigContent(mcpPort, mcpToken, cfg?: OpencodeConfigSettings): string` — start from the
  existing `{ mcp: {…} }` and **spread-in only set fields**:
  - `cfg.model` → `model`; `cfg.smallModel` → `small_model`.
  - `cfg.disabledProviders?.length` → `disabled_providers`; same for `enabled_providers`.
  - `cfg.providers` (non-empty) → `provider: { [id]: { ...(name && {name}), ...(baseURL && { options: {
    baseURL } }), ...(models?.length && { models: Object.fromEntries(models.map(m => [m.id, m.name ?
    { name: m.name } : {}])) }) } }`. (opencode wants `models` as an **object keyed by model id**, not an
    array — map it.)
  - `cfg.agents` (non-empty) → `agent: { [name]: { ...(model && {model}), ...(temperature != null &&
    {temperature}) } }`.
- Thread the settings to the spawn: in `acquire(cwd)` (or `resolveHandle`/`spawnServer`), read
  `loadEngineConfig('opencode').opencodeConfig` (import `loadEngineConfig` from ui-config) and pass it to
  `spawnServer` → `buildOpencodeConfigContent`. Document that the per-cwd server **captures settings at
  spawn** (changing them needs a fresh server — mirror the existing auth-caching note).

### 2c. UI — new opencode sections (`settings-sections.tsx` + SCOPES)
Add three sections (mirror `OpencodeAutoModeSection`'s load/save/self-gate pattern; reuse `SettingsSelect`,
`SettingsSlider`, `SettingsToggle`, and the proxy section's raw `<input>` styling):
- **`opencode-models`** (opencode → Engine subgroup): two `SettingsSelect`s — Default model + Small model,
  options from the opencode `getEngineModels()` list (value = `provider/model`, plus a "Default" empty
  option). Save to `opencodeConfig.model` / `.smallModel`.
- **`opencode-providers`** (opencode → Vendor subgroup, alongside the existing `vendor-opencode` auth
  section): (a) a **custom-provider editor** — a list of provider rows `{ id, name, baseURL, models[] }`
  with add/remove + a per-row model-id list editor; (b) **disabled/enabled providers** — a toggle list of
  the known provider ids (derive the known set from the unique `provider` prefixes of the discovered
  opencode models, or a providers list if one's exposed). Save to `opencodeConfig.providers` /
  `.disabledProviders` / `.enabledProviders`. Note that API keys for these providers are set in the
  existing "opencode Vendors" auth section.
- **`opencode-agents`** (opencode → a new "Agents" subgroup): a row editor — agent name (free text or a
  select of the common primaries: `build`, `plan`, `general`, `explore`) + model select + temperature
  slider (0–2). Save to `opencodeConfig.agents`.
- Register the new ids: extend `ENGINE_OPENCODE_SECTION_IDS` (add `opencode-models`),
  `VENDOR_OPENCODE_SECTION_IDS` (add `opencode-providers`), and add an agents set; wire them into the
  `SCOPES` opencode subgroups (spec phase-1 §3a) in intended order (Engine: Auto mode, Models · Vendor:
  Vendors auth, Providers · Agents: Agents).
- All new sections **self-gate** on "opencode not installed" (reuse the `available` check).

### 2d. #6 vendor-at-spawn (`session.ipc.ts`)
Replace the hardcoded `loadVendorConfig('anthropic')` (:774) with a vendor id derived from the active
`model`'s ModelRef (use the existing `claudeModel(...)` / model→ModelRef helper; for Claude this resolves
to `'anthropic'` so it's a no-op, but it removes the hardcode + the Phase-5 TODO). The opencode branch is
unchanged (its vendor config flows via `OPENCODE_CONFIG_CONTENT`, §2b).

## 3. Tests
- `buildOpencodeConfigContent`: (i) no cfg → `{ mcp }` only (unchanged); (ii) each field set → correct
  opencode key (`model`/`small_model`/`disabled_providers`/`provider`/`agent`); (iii) **unset fields
  absent** (no empty `provider: {}` etc. — guards the clobber-safety contract); (iv) provider `models`
  array → object-keyed-by-id mapping.
- `OpencodeConfigSettings` round-trips through `engines/opencode.json` (load/save).
- Section render/save tests: selecting a default model → `saveEngineConfig('opencode', { …, opencodeConfig:
  { model } })`; adding a provider row; setting an agent override.
- `session:create` derives `'anthropic'` for a Claude model (no regression to endpoint/model/proxy env).

## 4. Verify gates (report exact output)
`bun run typecheck && bun run test && bun run lint && bun run build` — 0 lint errors (3 pre-existing
exhaustive-deps warnings OK). Leave the tree dirty; list every changed file + one-line rationale. Do NOT
app-shot — main model drives the real app. **If you create throwaway probe scripts, put them in a temp dir
or `rm` them — never leave files in `scripts/`.**

## 5. Gotchas
- **Clobber-safety:** inject ONLY set fields (spread-if-present). A `provider: {}` or `disabled_providers:
  []` would deep-merge harmlessly but is noise — omit empties. The unit test must assert unset fields are
  absent from the emitted JSON.
- **Never inject `apiKey`** — credentials live in auth.json (existing vendor-opencode UI). The provider
  editor here is base URL + models + name only.
- opencode `provider[id].models` is an **object keyed by model id**, not an array — map our
  `{id,name}[]` → `{ [id]: { name? } }`.
- `model`/`small_model` value format is `provider/model` (e.g. `anthropic/claude-sonnet-4-6`) — the
  dropdown options come straight from the opencode `getEngineModels()` ids.
- Per-cwd server captures settings at spawn; a settings change applies to the **next** cwd spawn.
- Don't touch `autoMode` (existing) — add `opencodeConfig` alongside it.
- New sections self-gate on opencode-installed exactly like `OpencodeAutoModeSection`.

## 6. Suggested commit (main model writes it after review)
```
feat(v2/settings): opencode settings in the UI (model/providers/agents) + ModelRef vendor-at-spawn

Fill the opencode settings tab with native opencode config so users stop hand-editing JSON: default +
small model, custom OpenAI-compatible providers (base URL + model list), disabled/enabled providers,
and per-agent model/temperature overrides. Stored in engines/opencode.json (opencodeConfig) and merged
into opencode at spawn via OPENCODE_CONFIG_CONTENT (deep-merge; only set fields injected, so the user's
own opencode.jsonc is never clobbered; credentials stay in auth.json). Also derive the Claude vendor at
spawn from the active model's ModelRef instead of the hardcoded 'anthropic' (rest of #6; no-op for
Claude). #12 capability-gating remains a separate follow.
```
