# Provider surfaces v3 — handoff (ADR-074)

Resume doc for the ADR-074 arc. Read [ADR-074](adr/adr-074_provider-surfaces-v3.md) first; it holds the
decisions. This file holds the slice status, the kickoff specs, and anything learnt while building.
Workflow: ADR-026 (main model specs/reviews/commits; an Opus implementer writes the code; a separate
Opus verifier drives the real app).

Mockups (owner-approved 2026-09-23), under `.claude/ui/mockups/<id>/index.html`:
`829a066c` A · Subscriptions · `7eeb6bff` B · Models in the picker · `4a21c0c4` C · Claude defaults
& endpoint · `42e09418` D · API providers & shared keys.

## Status

| #   | Slice                                                                       | State                           |
| --- | --------------------------------------------------------------------------- | ------------------------------- |
| 1   | §4 keyless placeholder + "No key needed"                                    | spec below — dispatched         |
| 2   | §1 per-provider pi allowlist + migration; §5 pi diagnosis                   | spec below — dispatched after 1 |
| 3   | §9 Anthropic endpoint → Claude page (mockup C right)                        | not started                     |
| 4   | §8 Claude defaults from `supportedModels()` + default model (mockup C left) | not started                     |
| 5   | §2 engine-generic curation + undo; pi page dialog removed (mockup B)        | not started                     |
| 6   | §3 linked lists (mockup B)                                                  | not started                     |
| 7   | §6 one key per provider — core (catalog definitions, delivery, migration)   | not started                     |
| 8   | §7 Subscriptions / API providers IA, Manage sheet, Add flow (mockups A, D)  | not started                     |

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

## Log

- 2026-09-23 — ADR-074 written; slices 1–2 specced.
