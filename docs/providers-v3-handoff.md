# Provider surfaces v3 — handoff (ADR-074)

Resume doc for the ADR-074 arc. Read [ADR-074](adr/adr-074_provider-surfaces-v3.md) first; it holds the
decisions. This file holds the slice status, the kickoff specs, and anything learnt while building.
Workflow: ADR-026 (main model specs/reviews/commits; an Opus implementer writes the code; a separate
Opus verifier drives the real app).

Mockups (owner-approved 2026-09-23), under `.claude/ui/mockups/<id>/index.html`:
`829a066c` A · Subscriptions · `7eeb6bff` B · Models in the picker · `4a21c0c4` C · Claude defaults
& endpoint · `42e09418` D · API providers & shared keys.

## Status

| #   | Slice                                                                       | State                                                |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | §4 keyless placeholder + "No key needed"                                    | committed `e5960915`; real-app verified              |
| 2   | §1 per-provider pi allowlist + migration; §5 pi diagnosis                   | committed `406d6692`; real-app verified with 1 and 3 |
| 3   | §9 Anthropic endpoint → Claude page (mockup C right)                        | committed `f1d27e67`; real-app verified              |
| 4   | §8 Claude defaults from `supportedModels()` + default model (mockup C left) | committed `6bca2a5c`; real-app check pending         |
| 5   | §2 engine-generic curation + undo; pi page dialog removed (mockup B)        | implementing                                         |
| 6   | §3 linked lists (mockup B)                                                  | specced                                              |
| 7   | §6 one key per provider — core (catalog definitions, delivery, migration)   | specced (core seam map inline)                       |
| 8   | §7 Subscriptions / API providers IA, Manage sheet, Add flow (mockups A, D)  | to spec as 8a Subscriptions / 8b API providers       |

## Standing constraints for every implementer

- Never commit, `git add`, branch, stash, or run `bun install` / `bun add` / `bun remove`.
- Never read or print credential values (`~/.pi/agent/auth.json`, `~/.local/share/opencode/auth.json`,
  `~/.claude/ui/auth-vault.json`, any `apiKey`). Tests use fixtures in temp dirs.
- Never write to the real `~/.pi`, `~/.claude`, `~/.local/share/opencode` from tests — inject paths.
- Match the surrounding code's comment density and idiom; ADR-027 testids on new UI.
- Gates to run and report verbatim: `bun run typecheck`, `bun run lint`, and the focused vitest files
  you touched (`bunx vitest run <files>`), then `bun run test`.
- Report: files changed, what each change does, exact gate output, any deviation from the spec.

---

## Slice 1 — keyless custom providers are visible to pi (ADR-074 §4)

### Verified facts (do not re-derive)

- pi 0.87.1 omits a `models.json` provider with no usable credential from `get_available_models`;
  any literal `apiKey` makes it appear (probed with `PI_CODING_AGENT_DIR` in a scratch dir;
  `vendor/pi-cli/pi/docs/models.md` line ~64). Credential precedence in pi: `--api-key`, then
  `auth.json`, then `models.json` `apiKey`, then env. So a real key vended to `auth.json` wins over a
  placeholder in `models.json`.
- `src/core/shared-providers/PiSharedProviderAdapter.ts`: `compileProvider` builds
  `{ baseUrl, api, models }`; `mergeProvider(existing, compiled)` spreads `existing` then `compiled`;
  `managedProviderProjection` / `sameManagedProvider` compare only `baseUrl`, `api` and the six model
  fields — **`apiKey` is already outside the equality**, so adding it to the written entry does not
  trip "changed outside ClaudeUI" for entries written before this change. Keep it that way.
- The shared-provider vault key for a custom provider is vended to pi's `auth.json` by `vendApiKey`
  (via `PiAuthProvider.setVendorApiKey`). `hasCredential` reads `auth.json` ids. Do NOT put the
  placeholder in `auth.json`.
- `src/core/shared-providers/provider-registry.ts` `sharedCredential(definition, status, accounts)`
  returns `'none'` when `!status?.connected` — which is what makes a keyless custom provider read
  "Not connected". `ProviderCredential` is in `src/shared/provider-registry.ts:39`; its labels and chip
  classes are in `ProviderSheet.tsx` (`CREDENTIAL_LABEL`-style maps near lines 115–135 — find them).

### Changes

1. **Placeholder.** In `mergeProvider` (or the write path in `applyDefinition`, whichever keeps it one
   place), when the resulting entry has no `apiKey` (absent, or not a non-empty string), set
   `apiKey` to a fixed placeholder constant, e.g. `CLAUDEUI_KEYLESS_PLACEHOLDER = 'claudeui-no-key'`,
   with a doc comment citing the pi behaviour above. An existing `apiKey` of any value (a literal,
   `$ENV`, `!command`) is preserved untouched. `compileProvider` stays key-free (the managed
   projection must not include `apiKey`).
2. **Credential state.** Add `'keyless'` to `ProviderCredential`. In `sharedCredential`, a
   `kind: 'custom'` definition with no stored key returns `'keyless'` instead of `'none'`. Everything
   else unchanged. Wire the label **"No key needed"** and a neutral-positive chip style (same family as
   `free`) wherever `ProviderCredential` is mapped (grep for the `'free'` case in the renderer —
   `ProviderSheet.tsx`, `ProviderList.tsx`, `SignInDialog`/`InlinePickers` if they switch on it; the
   typechecker will find exhaustive switches).
3. **Key row copy.** In `ProviderSheet.tsx`'s key row for a shared custom provider with no key, the
   description reads "Optional — this endpoint is used without a key." instead of "Not set". In
   `ProviderForm.tsx` the API key field's placeholder becomes "API key (optional)" when not
   `idLocked`, keeping "Set or replace the key" when locked.

### Tests

- `src/core/shared-providers/__tests__/PiSharedProviderAdapter*.test.ts` (find the existing file):
  (a) a custom definition applied to an empty models.json writes `apiKey: <placeholder>`;
  (b) an existing entry with `apiKey: '$MY_KEY'` keeps `'$MY_KEY'` after re-apply;
  (c) an entry written by the OLD code (no `apiKey`) re-applies with `previouslyManaged = true` without
  throwing "changed outside ClaudeUI", and gains the placeholder;
  (d) `removeDefinition` still removes an entry that now carries the placeholder.
- `provider-registry` test: custom definition, status `connected: false` → credential `'keyless'`;
  subscription with no status → still `'none'`.
- Prove (a) fails on the pre-change code (stash-free: temporarily revert your one-line guard, run, restore
  — report the failing output).

### Out of scope

pi-native providers declared through `PiCustomProviders` (the user's own models.json editor) — not
projected by this adapter; leave them. opencode behaviour — unchanged.

---

## Slice 2 — per-provider pi allowlist + truthful pi diagnosis (ADR-074 §1, §5)

### Verified facts

- `PiConfig.modelAllowlist?: string[]` (`src/shared/types.ts:~767`) of `<provider>/<modelId>` values.
  pi model ids can contain `/` (`openrouter/deepseek/deepseek-v4-flash-0731` → provider `openrouter`,
  id `deepseek/deepseek-v4-flash-0731`): split on the FIRST `/` only.
- Readers: `src/core/pi/model-discovery.ts` `discoverPiModels` (~line 128);
  `src/core/shared-providers/provider-registry.ts` (`piModelAllowlist` source + `engineCounts` pi
  branch ~line 454); `src/renderer/src/components/SettingsDialog/PiConfigPanes.tsx` (~705–860:
  `defaultExcluded`, `saveAllowlist`, the Manage button label, `PiModelAllowlistDialog`);
  `src/shared/model-references.ts` (check whether it reads the pi allowlist — adapt if so);
  `src/core/shared-providers/SharedProviderService.ts`. Grep `modelAllowlist` and `piConfig` across
  `src/` to confirm nothing else.
- opencode's map (`OpencodeConfigSettings.modelAllowlist?: Record<string, string[]>`, bare model ids,
  key-presence gated, `[]` = none) is the rule to copy. `loadEngineConfig(engineId)` in
  `src/core/services/ui-config.ts:434` is a bare JSON read — the renderer reads engine config through
  IPC that calls it, so normalising there covers every reader.
- `SharedProviderService.diagnoseRoute` (~line 516) returns `'no-models-discovered'` for pi
  unconditionally; `SharedProviderRouteDiagnosis` is in `src/shared/shared-provider.ts:~98`;
  `diagnosisText` in `ProviderList.tsx:~79`. opencode's analogue is
  `OpencodeSharedProviderAdapter.diagnoseZeroModels` — read it for shape.
- pi's unfiltered catalog: `getPiModelCatalog()` / `getPiModelCatalogGroups()` in `model-discovery.ts`
  (cached, [] on failure). `PiSharedProviderAdapter`'s `nativeProviderId(definition)` gives the pi id
  (`openai-codex` for ChatGPT).

### Changes

1. **Type.** `PiConfig.modelAllowlist?: Record<string, string[]>` with the opencode doc comment
   (absent key = all of that provider's models; `[]` = none; bare model ids).
2. **Migration (normaliser).** A pure `normalizePiModelAllowlist(raw: unknown): Record<string,
string[]> | undefined` in a small module (e.g. `src/core/pi/pi-allowlist.ts`, exported for tests):
   - `undefined` → `undefined`; a record → itself (drop non-array values, non-string entries);
   - a `string[]` → group by provider on the first `/`; entries without `/` are dropped; **providers
     not in the old list get no key** (ADR-074 ruling: show all). An empty old array (`[]`, which
     meant "nothing anywhere") therefore becomes `{}`: every provider is unlisted, so every provider
     shows all. This is a deliberate meaning change; say so in the comment.
     Apply it in `loadEngineConfig` for `engineId === 'pi'` only (keep `loadEngineConfig` generic —
     a per-engine normaliser map is fine). Do not rewrite the file on read; the next save persists the
     new shape.
3. **Discovery.** `discoverPiModels` filters with `allowlist?.[m.provider]` → absent: keep;
   present: `includes(m.id)`. `resolvePiSpawnModel` needs no change (it uses the filtered groups).
4. **Registry.** `ProviderRegistrySources.piModelAllowlist` becomes the record; `engineCounts` pi branch
   mirrors opencode's: key present → `{ modelCount: list.length, curated: true }`; absent → the
   fallback count, not curated.
5. **Diagnosis.** Add `'no-credential'` to `SharedProviderRouteDiagnosis` (doc: the engine reports no
   models for this provider id — no usable key, or a broken entry). Give `PiSharedProviderAdapter`
   (or a function next to it) a `diagnoseZeroModels(definition, catalog: PiModel[], allowlist)`:
   allowlist key present and filters every catalog model of that provider out → `models-restricted`;
   catalog non-empty but no model of that provider → `no-credential`; catalog empty →
   `no-models-discovered`. `diagnoseRoute` becomes async if needed (it is only called from
   `getStatus`, already async) and calls it with `getPiModelCatalog()` and the loaded allowlist. Keep
   the existing try/catch fallback. `diagnosisText` gains:
   `'no-credential'` → "pi reports no models for this provider — check its key, or its entry in
   ~/.pi/agent/models.json." (keep the "cause first" style of the neighbours).
6. **pi engine page (interim — slice 5 replaces it).** `PiModelAllowlistDialog` keeps its flat UI but
   reads/writes the record: seed `checked` from the record (absent key → all that provider's catalog
   models checked); on save, per provider: all of its catalog models checked → **omit the key**;
   otherwise key = the checked bare ids (possibly `[]`). `defaultExcluded` uses the new rule. The
   Manage button label shows `all` when the record is absent or empty, else
   `<n> providers curated`.

### Tests

- `pi-allowlist` normaliser: array→record grouping, first-slash split for ids containing `/`,
  unlisted providers absent, `[]` → `{}`, record passthrough, junk dropped.
- `model-discovery` filter: the owner's real case — old list of two openrouter ids + a catalog with
  openrouter (3 models) and openai-codex (8) → openrouter shows 2, openai-codex shows 8.
  Guard-check this one against the pre-change code and report the failure.
- registry `engineCounts` pi branch: curated vs uncurated.
- diagnosis: the three outcomes.
- `PiModelAllowlistDialog` component test: saving with every model of a provider checked omits its key.

### Out of scope

Opencode's curation, the Manage sheet's curation group (slice 5), linked lists (slice 6).

### Suggested commit subjects

1. `fix(pi): keyless custom providers get a placeholder apiKey so pi can see them`
2. `fix(pi): per-provider model allowlist; name why a pi route is empty`

---

## Slice 3 — the Anthropic endpoint moves to the Claude page (ADR-074 §9, mockup C right)

Open the mockup to see the target: `.claude/ui/mockups/4a21c0c4/index.html` (right column). You can
screenshot it with the Electron helper described at the end of this section.

### Verified facts

- Page model: `src/renderer/src/components/SettingsDialog/settings-pages.tsx`. The group lives on
  page `models` as `{ id: 'anthropic', label: 'Anthropic endpoint', storage: 'vendors/anthropic.json',
appliesOn: 'next-session', note: 'Applies to new Claude sessions.', items:
itemsOf('vendor-anthropic') }` (~line 537). The Claude page is `{ id: 'claude', ... groups: [sandbox,
proxy] }` (~line 660).
- Items: `settings-sections.tsx` section `id: 'vendor-anthropic'` (~line 2799) with one item
  `vendorAnthropicEndpoint` rendering `VendorAnthropicEditableForm` (~line 1451). Item renders receive
  `(settings, update, engineConfig, updateEngineConfig, vendorConfig, updateVendorConfig, ctx)`;
  `vendorConfig` is ALWAYS the anthropic vendor config (`SettingsDialog.tsx` loads
  `loadVendorConfig('anthropic')`), so moving the group to another page needs no plumbing.
- Storage types (`src/shared/types.ts`): `AnthropicEndpointSettings { enabled, baseUrl, authToken }`;
  `ModelOverrideSettings { enabled, model, sonnetModel, opusModel, haikuModel }` (~line 447).
- Application: `src/core/providers/claude-spawn-prep.ts` `applyEndpointEnv` / `applyModelEnv`
  (~lines 90–126) write module-scoped slots (`sdk/endpoint-env.ts`, `sdk/model-env.ts`) that only
  cli.js spawns read. `applyModelEnv` sets all four env vars when `enabled` and any field is non-empty;
  empty strings are skipped by `buildEnv()`. It is also called from `handlers-core.ts` on settings
  change (~line 874).
- Tests referencing the old names: `__tests__/settings-sections.unit.test.tsx`,
  `__tests__/models-page-rows.component.test.tsx`. There may be a page-inventory guard test — grep
  `vendorAnthropicEndpoint` and `'anthropic'` group ids in `__tests__/`.

### Changes

1. **Two switches for the two jobs.** `ModelOverrideSettings` gains optional `pinEnabled?: boolean`
   and `renameEnabled?: boolean`. Effective pin = `pinEnabled ?? enabled`; effective rename =
   `renameEnabled ?? enabled` (a config written by an older build keeps behaving the same). Put that
   derivation in one exported pure helper in `src/shared/` (e.g. `effectiveModelOverride(mo)` →
   `{ pin: string | null, sonnet, opus, haiku }`) and use it in `applyModelEnv`: `ANTHROPIC_MODEL` only
   when pin is on and `model` non-empty; the three alias vars only when rename is on. The UI writes
   both new flags and keeps `enabled = pinEnabled || renameEnabled` for older builds.
2. **New form, split in two items.** Replace `VendorAnthropicEditableForm` with a new file
   `ClaudeEndpointSettings.tsx` exporting two components:
   - `ClaudeEndpointSection` — "Claude sends requests to" as two choice cards: **Anthropic**
     ("api.anthropic.com, with your Claude sign-in.") / **A custom gateway** ("An Anthropic-compatible
     proxy or gateway."), bound to `endpoint.enabled`. The Base URL and Auth token rows (with
     Reveal/Hide, reveal not persisted) render **only** when the gateway is chosen, followed by a hint
     row: "Sent as `Authorization: Bearer`. Leave empty to send your Claude sign-in instead." Choosing
     Anthropic keeps the stored URL/token (so switching back restores them).
   - `ClaudeModelMappingSection` — **Pin one model for every session** (switch; description "Overrides
     the model picker and the default model." plus the env var name `ANTHROPIC_MODEL` in mono), with
     its model field shown only when on; **Rename the model aliases** (switch; "For gateways that call
     Claude's models something else. An empty field keeps Claude's own name."), with three rows shown
     only when on: alias chip (`sonnet` / `opus` / `haiku`), text field, env var name
     (`ANTHROPIC_DEFAULT_SONNET_MODEL` …) in small mono.
     Add a reusable `ChoiceCards` control to `settings-controls.tsx` (radio semantics:
     `role="radiogroup"` / `role="radio"` + `aria-checked`, keyboard arrows, testids
     `<testid>` + `<testid>.option` with `data-id`); slice 5 reuses it. Match the mockup's look with the
     app's tokens (`border-border`, `bg-accent/…`, etc.), not the mockup's hex values.
3. **Page model.** Remove the `anthropic` group from page `models`. Add two groups at the TOP of page
   `claude`: `{ id: 'endpoint', label: 'Endpoint', storage: 'vendors/anthropic.json', appliesOn:
'next-session', note: 'Applies to new Claude sessions. Never reaches opencode or pi.' }` and
   `{ id: 'model-mapping', label: 'Model mapping', storage: 'vendors/anthropic.json', appliesOn:
'next-session', note: 'Applies to new Claude sessions.' }`, then the existing sandbox and proxy
   groups. Rename the section to reflect it (e.g. `claude-endpoint`) with two items
   (`claudeEndpoint`, `claudeModelMapping`) carrying search keywords that include the old ones
   (anthropic, endpoint, gateway, base url, token, model override, alias, sonnet, opus, haiku). Update
   the Claude page description if it no longer fits.
4. **Delete** `VendorAnthropicEditableForm` and its `MODEL_OVERRIDE_FIELDS` / defaults if nothing else
   uses them (grep).

### Tests

- `effectiveModelOverride` / `applyModelEnv`: legacy `{enabled:true, model:'x', sonnetModel:'s'}` →
  both set; `{pinEnabled:true, renameEnabled:false, ...}` → only `ANTHROPIC_MODEL`; rename only → only
  alias vars; `enabled:false` legacy → nothing. Guard-check one against the pre-change code.
- Component: gateway fields hidden on Anthropic, shown on gateway; choosing Anthropic keeps the stored
  URL; rename rows hidden until on; toggling writes both flags and `enabled`.
- Page model: `anthropic` group gone from `models`; `endpoint` + `model-mapping` first on `claude`.
- Update the two existing tests that referenced the old form/group.

### Screenshot helper (optional, for comparing against the mockup)

`/private/tmp/claude-501/-Users-daniel-liu-work-ClaudeUI/f014786f-c75e-4136-a8e2-21b10415cf09/scratchpad/shot.sh <abs html path> <out.png> [width] [height] [js…]`
renders an HTML file offscreen in Electron. Real-app verification is done by a separate verifier, not
you.

### Suggested commit subject

`feat(settings): the Anthropic endpoint moves to the Claude page, with pin and rename as two switches`

---

## Slice 4 — Claude's defaults come from Claude (ADR-074 §8, mockup C left)

Depends on slice 3 (`effectiveModelOverride`). Target design: `.claude/ui/mockups/4a21c0c4/index.html`,
left column.

### Verified facts

- Today: `settings-sections.tsx` `EFFORT_MODELS` (~line 344) is a hard-coded list of five ids; the
  `effortDefaults` section (~line 3500) maps it to one `ModelEffortRow` item per model plus a footer
  item `effortDefaultsFooter`. The page model puts it in `settings-pages.tsx` group `defaults`,
  `byEngine.claude: itemsOf('effortDefaults')`. Saved values: `AppSettings.modelEffortDefaults:
Partial<Record<string, EffortLevel>>` (ClaudeUI settings.json), keyed by canonical id.
- The only consumer: `InputBox.tsx:~542`
  `state.settings.modelEffortDefaults?.[canonicalizeModelValue(modelInfo?.value)]`.
  `canonicalizeModelValue` (`src/shared/model-capabilities.ts:69`) hard-codes `opus` →
  `claude-opus-5-5` etc.; the private `normaliseModelId` (line 46) extracts `claude-…`, drops a date
  suffix and anything outside the match (so `[1m]` is dropped).
- The live list: `session:get-engine-models` returns Claude's `supportedModels()` rows stamped
  `engineId: 'claude'` (`session.ipc.ts:~819`); the renderer holds them in
  `useSessionStore.availableModels`. Each Claude row may carry `resolvedModel`
  (`docs/protocol-cc/09-initialize.md` "models[].resolvedModel": `default` → `claude-opus-5[1m]`,
  `sonnet` → `claude-sonnet-5`, `haiku` → `claude-haiku-4-5-20251001`; two rows may share one) and
  `supportedEffortLevels` (authoritative). `dedupeResolvedModels` (`InputBox/utils.ts`) is how the
  composer picker collapses rows sharing a `resolvedModel` — reuse it for the default-model select so
  both show the same entries.
- Default model seeding: `session-store.ts` `resolveEngineDefaultModel` (~line 225) has codex /
  opencode / pi branches with a `*DefaultModelConfigured` flag (ADR-059: configured but missing →
  `null` → "Select a model" + banner); the Claude branch returns `engineMeta('claude')
.defaultModelValue()` = `'default'`. Codex's config pattern: `EngineConfig.codexConfig.defaultModel`
  (`types.ts:~746`), loaded into the store near line ~675 (`codexDefaultModel`,
  `codexDefaultModelConfigured`).

### Changes

1. **One effort key.** Export `claudeEffortKey(model: { value: string; resolvedModel?: string } |
undefined): string` from `model-capabilities.ts`: `normaliseModelId(resolvedModel)` when
   `resolvedModel` is present and yields a `claude-` id, else `canonicalizeModelValue(value)`. Use it in
   `InputBox.tsx` and in the new section, so the row a user edits is the row a session reads.
2. **Default model (new).** `EngineConfig.claudeConfig?: { defaultModel?: string }` (engines/claude.json,
   doc comment: ClaudeUI's own, never written to `~/.claude/settings.json`, so the terminal `claude` is
   unaffected — ADR-074 §8). Store: `claudeDefaultModel` + `claudeDefaultModelConfigured`, loaded like
   Codex's; a setter mirroring `setPiDefaultModel`. `resolveEngineDefaultModel` Claude branch: configured
   and the Claude catalog non-empty → the value if present, else `null` (ADR-059); otherwise
   `'default'` as today. **Check every caller handles `null` for Claude** (the Codex/pi null path exists;
   Claude never produced null before) — "Don't break Claude" (ADR-026): with nothing configured,
   behaviour must be byte-identical to today.
3. **The section.** Replace the `effortDefaults` items with ONE item rendering a new
   `ClaudeDefaultsSection` component (new file), keywords covering the old ones plus "default model".
   It renders, from `availableModels` filtered to Claude:
   - **Start new sessions on** — a select (reuse the themed picker the pi/opencode default-model rows
     use, `ModelPicker variant="field"`) over the deduped Claude rows, plus an empty option
     "Default (recommended) → <display name the `default` row resolves to>". Writes
     `claudeConfig.defaultModel` (blank = unset) through the engine-config writer the other panes use.
   - **Starting effort per model** — a table: one row per distinct `claudeEffortKey`, name = the
     display name of the concrete (non-alias) row if present else the first row's, the key in mono under
     it, a "Picked as" column listing the aliases (row `value`s other than the key itself) as chips, and a
     select of that model's `supportedEffortLevels` (fallback `supportedEffortLevels(key)`) with
     "Default (<level>)" first (`defaultEffort(key)`), a "reset" link when set. A model with no effort
     support shows "No effort control". Mark the row the default model resolves to with a "starts here"
     chip.
   - **Saved for models no longer offered** — keys in `modelEffortDefaults` not in the table, folded
     (count in the summary), each with Remove.
   - A **banner** when `effectiveModelOverride(vendorConfig.modelOverride)` pins a model ("Every Claude
     session is pinned to X on Claude › Endpoint — the default model and the picker are ignored until
     that is turned off.", link navigating to `{ page: 'claude', group: 'model-mapping' }`, and the
     default-model row dimmed) or renames aliases (lists the renames; efforts still apply by alias).
   - Empty/unloaded catalog: one row "Claude's model list isn't loaded yet — it arrives when Claude
     starts, or Refresh." with a Refresh link (`useSessionStore.getState().reloadModels()`), and the
     orphan list still reachable.
   - Footer line: "The effort chip in the composer always wins for the session you are in."
4. **Delete** `EFFORT_MODELS`, `ModelEffortRow` if unused, and the footer item.
5. `DEFAULT_MODEL_NOTES.claude` (settings-pages) — update if it still describes effort-only.

### Tests

- `claudeEffortKey`: `default` with `resolvedModel: 'claude-opus-5[1m]'` → `claude-opus-5`; `haiku`
  with a dated resolvedModel → `claude-haiku-4-5`; no resolvedModel → canonicalize fallback. Guard: the
  InputBox consumer picks up a user default for an alias row whose `resolvedModel` the old
  canonicalizer mapped elsewhere (fails on the old code — report it).
- `resolveEngineDefaultModel` Claude: unset → `'default'`; configured & present → it; configured &
  missing with a non-empty catalog → `null`; configured with an empty catalog → passes through.
- Component: rows built from a fixture catalog (dedupe by key, aliases column, levels from the row),
  orphan fold + Remove, pin banner dims the default-model row, empty catalog state.
- Update/replace tests referencing `EFFORT_MODELS` / `ModelEffortRow` / `effortDefault_*` keys (grep
  `__tests__`), including `models-page-rows.component.test.tsx`.

### Suggested commit subject

`feat(settings): Claude's default model and per-model effort come from Claude's own model list`

---

## Slice 5 — engine-generic curation in the Manage sheet, and a way back to "all" (ADR-074 §2, mockup B)

Depends on slice 2 (pi allowlist is a per-provider record). Target design:
`.claude/ui/mockups/7eeb6bff/index.html` in its **"Separate per engine"** state (the one-list choice
cards are slice 6 — do not build them yet).

### Verified facts

- Today's curation: `ProviderSheet.tsx` `OpencodeModelCuration` (~line 1233 on) reads
  `getOpencodeProviderModels(providerId)`, `loadOpencodeSettings()`, `getEngineModels()` and every
  engine's config; writes with `saveOpencodeSettings({...cfg, modelAllowlist: {...,[id]: next}})`.
  It renders only when `curatable` (opencode facts) is true, under a group with an opencode chip.
- **Bug to fix**: `config:save-opencode-settings` (`src/core/ipc/config-commands.ts:~470`) treats an
  EMPTY `modelAllowlist` (`{}`) as "not provided" and keeps the old one — so un-curating the last
  curated opencode provider silently reverts.
- The list UI is `ModelCurationList.tsx` (+ `ModelCurationActions`, `visibleModels`): grouped by vendor
  prefix, facets (`selected`/`free`/`reasoning`/`tools`), sort, bulk; it owns no state of record and its
  only writer is `onSet(next)`. Reuse it; extend its props rather than rewriting it.
- Orphan guard: `src/shared/model-references.ts` `findModelReferences(sources, removedValues)` scans
  EVERY engine's config for the removed picker values. opencode and pi picker values share a namespace
  (`openrouter/z-ai/glm-5.3` is valid in both), so today unticking an opencode model is blocked by pi's
  default of the same string — a false positive.
- pi catalog per provider: `window.api.getPiModelCatalogGroups()` (unfiltered, grouped by
  `vendorId`). opencode per provider: `window.api.getOpencodeProviderModels(id)` (`OpencodeCatalogModel`
  with `releaseDate`/`free`/`reasoning`/`toolCalling`).
- Registry engine facts (`ProviderEngineFacts`, `src/shared/provider-registry.ts:45`) carry `enabled`,
  `modelCount`, `curated`, `native` but NOT the engine-native provider id; the sheet re-derives it
  (`opencodeId`, `entry.piBuiltinId`, `nativeId`).
- The pi page's global dialog: `PiModelAllowlistDialog.tsx` + the "Model list" row in
  `PiConfigPanes.tsx` (~line 826), adapted to the record shape in slice 2.
- Add-sheet anti-flood seeding: `ProviderAddSheet.tsx` `seedOpencodeAllowlist` writes `[]` for every
  newly added opencode catalog provider.

### Changes

1. **One core writer.** New IPC command `models:set-provider-allowlist(engine: 'opencode' | 'pi',
providerId: string, models: string[] | null)` (capability `config`; register in the same place as
   the other `config:` commands; preload + `window.api.setProviderModelAllowlist`). `null` deletes the
   key (All models); an array sets it. For opencode it edits only `engines/opencode.json`
   `opencodeConfig.modelAllowlist` (dropping `opencodeConfig` when the map becomes empty) and calls
   `invalidateOpencodeModelCache()`; for pi only `engines/pi.json` `piConfig.modelAllowlist` and
   `invalidatePiModelCache()`. Validate `providerId` with the existing id-segment guard. Also fix the
   `{}` bug in `config:save-opencode-settings`: an explicitly provided `modelAllowlist` (even `{}`) is
   authoritative; only `undefined` keeps the stored one.
2. **Per-engine provider id on the facts.** Add `providerId?: string` to `ProviderEngineFacts`,
   filled by the registry for opencode and pi (the id that engine's catalog and allowlist key the
   provider by: `opencodeProviderId(definition)` / `piNativeProviderId(definition)` for shared rows, the
   native id for native rows). The sheet uses it instead of re-deriving.
3. **Scoped orphan guard.** `findModelReferences` gains an optional `engine?: EngineId`: when set, only
   references that target that engine are considered — `sources.engines[engine]` (default model, judge,
   dispatch default/allowed) and, for `opencode`, the opencode native default/small model. Without it,
   today's behaviour. Also make it return, per reference, a short `where` the UI can show in a tooltip
   (e.g. "Default model for pi — Models & providers › Default models › pi").
4. **Curation component.** Replace `OpencodeModelCuration` with a `ModelCuration` component (own file)
   driven by an adapter per engine:
   ```ts
   interface CurationAdapter {
     engine: 'opencode' | 'pi'
     providerId: string
     loadCatalog(): Promise<CurationModel[]> // per provider
     loadSelection(): Promise<string[] | undefined> // undefined = All models
     save(next: string[] | null): Promise<void> // → models:set-provider-allowlist
     pickerValue(modelId: string): string // `${providerId}/${modelId}`
   }
   ```
   UI, per mockup B (separate-per-engine state):
   - **Engine tabs** when the provider is enabled and curatable on both engines (tab label + count
     `all 8` / `6 of 8`); none when only one engine.
   - **Show in the <engine> picker**: a two-option segmented control **All models** / **Only the ones I
     pick · n**, with one line under it: All → "Every model <provider> offers is shown, including ones
     added later."; Only → "New models from <provider> stay out of the <engine> picker until you pick
     them."
   - The list: `ModelCurationList`, with new optional props: `locked?: Record<modelId, string>` (lock
     marker + tooltip; the row cannot be unticked while picked; Select/Clear skip it) and `allMode?:
boolean` (rows render checked-but-soft). Unticking a row in All mode switches to Only with every
     other model picked and shows an inline toast "Switched to Only the ones I pick — everything but this
     model is picked." with **Undo** (restores the previous selection). Choosing All with a selection
     writes `null`. Choosing Only from All seeds with every model picked, except catalogs over 50 which
     seed empty.
   - Locks come from the scoped `findModelReferences` over the provider's discovered values for that
     engine. A blocked edit still refuses and shows the reference sentence (existing behaviour).
   - Group trailing: the engine chip(s) and counts; the group renders when at least one engine is
     curatable. **pi curatable** = pi facts enabled AND pi's catalog has ≥1 model for the provider id;
     otherwise the pi tab shows slice 2's diagnosis sentence instead of a list.
5. **pi page.** Delete `PiModelAllowlistDialog.tsx` (and its test). The "Model list" row becomes a
   summary: "Curated per provider in Models & providers — <n> of <m> pi providers curated." with a link
   button **Providers ›** navigating to `{ page: 'models', group: 'providers' }` (the row has `ctx
.navigate`; check how other rows navigate). Keep `defaultExcluded` working with the record.
6. **Anti-flood seeding, engine-generic.** Replace `seedOpencodeAllowlist` with a helper that, for each
   engine the new provider was enabled on, seeds `[]` via `setProviderModelAllowlist` only when that
   engine's catalog for the provider has more than 50 models (and the key is absent). Otherwise leaves
   it absent (All).

### Tests

- IPC writer: set, clear (`null` deletes; last key drops `opencodeConfig`), pi and opencode, cache
  invalidation called. The `{}` save bug: guard-check against pre-change code.
- `findModelReferences` scoped: an opencode removal is not blocked by a pi default with the same
  value; unscoped behaviour unchanged.
- `ModelCuration` component: tabs appear only with two curatable engines; All→Only seeding (≤50 all,
  > 50 empty); untick-in-All toast + Undo; lock prevents untick; pi tab with an empty catalog shows the
  > diagnosis; save calls the adapter with `null` for All.
- `ModelCurationList`: `locked` and `allMode` props.
- pi page row: summary counts + navigation; dialog gone.
- Update ProviderSheet tests that asserted the opencode-only group/testids (keep `ProviderSheet.models`
  / `ProviderSheet.curate` testids working where reasonable; list any renamed).

### Suggested commit subject

`feat(providers): curate any engine's models in the Manage sheet, with All models as a real choice`

---

## Slice 6 — one model list per provider, split on request (ADR-074 §3, mockup B)

Depends on slice 5 (`ModelCuration`, `models:set-provider-allowlist`). Target design:
`.claude/ui/mockups/7eeb6bff/index.html` — the "Which engines use this list" choice, the join panel,
the shared list with `oc` / `pi` marks. Applies to SHARED definitions enabled on both opencode and pi
(ChatGPT, custom, and — after slice 7 — catalog). Native single-engine rows never show the choice.

### Design

- **Record.** `SharedProviderDefinition.curation?: { linked: boolean; models?: string[] }` — `models`
  are CANONICAL model ids (the definition's model ids; for ChatGPT and catalog the bare ids both
  engines share); `models` absent = All models. Repository validation: `linked` boolean, `models`
  string array without duplicates.
- **Effective state when `curation` is absent** (no migration write): linked iff the two engines'
  allowlist entries for this provider are equal (both absent counts as equal); the shared list is then
  that common value. A pure helper `effectiveCuration(definition, lists: { opencode?: string[]; pi?:
string[] }, idMap)` in `src/shared/` so the sheet and any core reader agree.
- **Projection.** New `SharedProviderService.setCuration(id, curation)` persists the record and, when
  `linked`, writes each enabled engine's allowlist through the slice-5 core writer: `models` mapped to
  that engine's ids (`harnessOverrides.<engine>.id ?? id` for custom; identity for ChatGPT/catalog),
  `null` when `models` is absent. Models only one engine offers are written to both (an allowlist entry
  for a model an engine lacks is inert). When `linked: false`, it only persists the flag (each engine's
  list is then edited per engine as in slice 5). Enabling a second engine route while linked projects
  the list to it (hook `setRouteEnabled`). IPC `shared-provider:set-curation(id, curation)`.
- **UI** (extends `ModelCuration`): above the tabs, `ChoiceCards` (slice 3) "Which engines use this
  list": **One list for all engines** ("opencode and pi offer the same models.") / **Separate per
  engine** ("Each engine keeps its own list."). One list → no tabs; the list is the UNION of both
  engines' catalogs by canonical id, each row carrying `oc` / `pi` availability marks (dim when that
  engine lacks the model; tooltip says so); "Show in the pickers: All models / Only the ones I pick";
  header chips show each engine's effective count. Switching to One list when the two lists differ
  opens the inline join panel instead: three options with consequences — "opencode's list (n)" /
  "pi's list (n)" / "Both combined (n)" (union; `all` if either is All) — each with its per-engine
  effect sentence ("pi changes from 2 to 4 models."), **Use one list** / **Keep separate**; tabs hidden
  while it is open. Separate → copies the shared list into both engines (no visible change until an
  edit). Locks in the shared list = union of both engines' scoped references.

### Tests

`effectiveCuration` (absent record with equal/unequal lists; id mapping for custom overrides);
`setCuration` projection (linked writes both engines in their ids, `null` for All; unlinked writes
nothing; enabling a route while linked projects); repository validation; component: choice cards, join
panel options and effects, union list marks, separate copies the list. Guard-check one projection test.

### Suggested commit subject

`feat(providers): one model list per provider by default, split per engine on request`

---

## Slice 7 — one key per provider: catalog definitions (ADR-074 §6) — core only

The UI for it (Add flow, merged row, key-conflict panel) is slice 8; this slice ships the core, the
IPC, and the minimum renderer changes needed so nothing breaks (Remove allowed, detail text, Add
sheet creating a definition). Seam map gathered 2026-09-23 (read-only explorer); the facts below are
from it — re-check a line number before relying on it.

### Verified facts

- `SharedProviderDefinition.kind: 'subscription' | 'custom'` (`src/shared/shared-provider.ts:70`).
  `validateSharedProviderId` (`:127`, `/^[a-z0-9][a-z0-9-]{0,62}$/`) is also what the vault uses.
- `SharedProviderRepository.validateDefinition` (`:139`) throws on any other kind at `:143`, and
  `list()` SILENTLY SKIPS invalid files (`:48-51`) — a new kind unknown to validation disappears.
  `custom` requires `protocol` + `baseUrl` (`:157-163`).
- `SharedProviderService`: `saveDefinition` throws for non-custom (`:105`); `setApiKey` throws for
  non-custom (`:220`); `vendRouteCredential` (`:436`) vends `vault.loadCredential(id)` of
  `type:'api_key'` to each enabled route via `pi.vendApiKey` / `opencode.vendApiKey`;
  `removeDefinition` (`:136`) removes config + credentials from both engines and the vault; most
  special-casing is on `id === 'chatgpt'`, not kind.
- Vault (`src/core/auth/vault/AuthVault.ts`): `credentials[id] = { type: 'api_key', key }`; plaintext
  JSON 0600 in 0700, atomic writes. `loadCredential` / `saveCredential` / `removeCredential`.
- `OpencodeSharedProviderAdapter`: `applyDefinitionRoute` (`:90`), `removeDefinitionRoute` (`:144`) and
  `inspectCollision` (`:85`) only short-circuit for `subscription`, so a new kind would reach
  `compileProvider` (`:221`, throws without protocol/baseUrl). `vendApiKey`, `removeCredential`,
  `hasDefinition`, `hasCredential` already work. opencode's `setVendorApiKey`
  (`OpencodeAuthProvider.ts:210`) is `PUT /auth/{id}` via a server, then `recycleAll()`.
- `PiSharedProviderAdapter`: `applyDefinition` / `removeDefinition` / `hasDefinition` already act only
  on `custom`; `vendApiKey` throws for non-custom (`:150`); the built-in collision guard applies only
  to `custom`, so a catalog `openrouter` is correctly NOT rejected.
- **No guard against two definitions claiming the same native id.** A catalog `openai` definition with
  ChatGPT's opencode route (`openai`) enabled would write an API key over ChatGPT's OAuth entry.
- Registry (`provider-registry.ts`): `ownedNativeIds` (`:420`) already folds `opencode:<id>` and
  `pi:<id>` native rows into a definition whose ENABLED routes resolve to those ids — no change needed
  for dedupe. `sharedDetail` (`:505`) says "<name> subscription · shared with …" for any non-custom
  kind — wrong for catalog. `sharedPiBuiltinId` (`:344`) gives a catalog `openrouter` a `piBuiltinId`,
  so "pi overrides" appears — desired.
- Key comparison without reading keys into the renderer: `piAuthProvider.accountIdentity(vendorId)`
  and `opencodeAuthProvider.accountIdentity(vendorId)` return `accountKey = "<vendor>:key:<hex16>"`
  (`apiKeyAccountKey`, `src/core/services/account-key-hash.ts:34`, SHA-256 of
  `"claudeui-account-key-v1:<vendor>:<key>"`, engine-independent) for api-key entries, cached on
  mtime+size. `apiKeyAccountKey(vendorId, vaultKey)` compares a vault key the same way. No exported
  function returns a raw native key; reading one requires `resolveOpencodeAuthJsonPath()` /
  `piAuthProvider.authFilePath()` + JSON parse, main process only.
- Renderer: `ProviderSheet.tsx:~815` allows Remove only for `custom`; the Add sheet's catalog
  `onSave` loops `vendorAuthSetKey(engine, id, key)` (`ProviderAddSheet.tsx:~424`); `registryIdFor`
  builds `<engine>:<id>`; `Candidate { id; name; engines; oauthLabel? }` has one id (opencode and pi
  candidates merge only on equal ids). Tests pinning the per-engine loop:
  `ProviderAddSheet.component.test.tsx:~373-436`.

### Changes

1. **Kind.** `kind: 'subscription' | 'custom' | 'catalog'`. A catalog definition: `id` = the catalog
   vendor id, `name`, `models: []`, no `protocol` / `baseUrl`, `routes.<engine>.providerId` optional
   (defaults to `id`), `managed: true`. Repository validation accepts it (and rejects
   protocol/baseUrl on it). Grep every `kind === 'custom'` / `kind !== 'custom'` / `'subscription'`
   branch (list in the seam map, and `ProviderSheet.tsx`) and decide each explicitly.
2. **Service.** `saveDefinition` and `setApiKey` accept `catalog`. `setRouteDefaultModel` is not
   offered for catalog (no models list) — keep it refusing, and hide the Default-model rows for catalog
   in the sheet. **Native-id collision guard** in `saveDefinition` and `setRouteEnabled(…, true)`:
   refuse when another definition has an ENABLED route on the same engine resolving to the same native
   id (message names the other provider). Covers ChatGPT's `openai` / `openai-codex`.
3. **Adapters.** opencode: `applyDefinitionRoute`, `removeDefinitionRoute`, `inspectCollision` return
   early for `catalog` (no projection). pi: `vendApiKey` accepts `catalog`. Nothing else.
4. **Adoption (migration).** New `SharedProviderService.adoptNativeKeys()` (or a small module beside it)
   run at boot after `syncAll()` and exposed as IPC `shared-provider:adopt-native(id, keep?: 'opencode'
| 'pi')`:
   - Candidates: a vendor id with an `api`-type credential in BOTH engines' auth stores
     (`listVendorCredentialIds`), not owned by any enabled definition route, and known to BOTH engines'
     catalogs (pi `PI_API_KEY_VENDOR_IDS`; opencode's provider catalog).
   - Same `accountIdentity(...).accountKey` in both → **silent adoption**: read the key once from one
     engine's auth file (main process), `vault.saveCredential(id, {type:'api_key', key})`, save a catalog
     definition with both routes enabled, then `syncDefinition` (idempotent). Log the adoption by id,
     never the key.
   - Different → do nothing at boot; the registry entry for the pair gets a
     `keyConflict: { opencode: string; pi: string }` of last-four hints (computed main-side; only four
     characters ever leave the main process). `adopt-native(id, keep)` resolves it by adopting the kept
     engine's key and delivering it to both.
   - Single-engine api keys and anything OAuth are left native (ADR-074 §6: engine-owned sign-ins stay
     engine-specific; adopting a single-engine key is a slice 8 affordance, via the same IPC with
     `keep` = that engine).
   - Must be safe to run repeatedly and never throw at boot (log and continue).
5. **Registry.** `sharedDetail` branch for `catalog` (e.g. "Catalog · shared with opencode, pi", or
   nothing and let chips speak). `keyConflict` surfaced on the pair's entries (both native rows still
   render until resolved; mark both). Credential for catalog: `api-key` when the vault holds one,
   `none` otherwise.
6. **Renderer minimum.** Remove allowed for `catalog` (removes key from vault + every engine; footer
   copy "Removing deletes the key from ClaudeUI and from every engine."). Add sheet catalog path with an
   API key: create the catalog definition with routes enabled for the chosen engines
   (`saveSharedProvider`), then `setSharedProviderApiKey` (one call), then open the sheet on the
   definition id; keep the OAuth path native. Update the pinned tests.

### Tests

- Repository: catalog validates; catalog with baseUrl rejected; list() keeps it.
- Service: save/setApiKey for catalog; vend to both engines once; disabling pi removes only pi's key;
  collision guard (catalog `openai` vs ChatGPT opencode route) — guard-check it fails without the
  guard; removeDefinition clears vault + both engines.
- Adapters: opencode catalog apply/remove no-ops; pi vendApiKey accepts catalog.
- Adoption: identical digests → definition + vault record created, idempotent on re-run; different →
  nothing written, conflict hints exposed; keep='pi' resolves; OAuth/single-engine untouched; a thrown
  read is logged, not propagated. Fixtures in temp dirs only.
- Registry: catalog definition absorbs both native rows (existing dedupe) and shows catalog detail.
- Add sheet: one `saveSharedProvider` + one `setSharedProviderApiKey`, no `vendorAuthSetKey` loop.

### Suggested commit subject

`feat(providers): a catalog provider's key is stored once and delivered to every engine`

---

## Log

- 2026-09-23 — ADR-074 written; slices 1–7 specced. Slice 1 and 3 committed. Found while specifying: `config:save-opencode-settings` keeps the old allowlist when sent `{}` (fix in slice 5); `findModelReferences` is not engine-scoped, so a pi default blocks an opencode untick of the same value (fix in slice 5); the vault is plaintext 0600, not encrypted (ADR-074 corrected).
- 2026-09-23 — Slices 1–3 verified in the real app (read-only verifier; built from the exact commit,
  not the working tree). **Incident:** pi's `~/.pi/agent/auth.json` lost its `openrouter` api_key
  some time between the owner's 10:50 OpenRouter use and 14:41:51 (the file's last write, the boot
  OAuth feed, which preserves other entries). No ClaudeUI path removes a vendor it does not own
  (every `removeVendorAuth` caller checked; tests run in a sandboxed HOME; pi's discovery probe
  reproduced with dummy creds does not drop it). Cause undetermined; `663a1633` now logs every
  removal with its call path. The owner must re-add the key.
- 2026-09-23 — Slice 4 open question for the owner: a user's last-picked Claude model (sticky) still
  wins over the configured "Start new sessions on" default, as it does for opencode/pi/Codex.
