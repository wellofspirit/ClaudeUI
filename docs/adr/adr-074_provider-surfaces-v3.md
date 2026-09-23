# ADR-074 — Provider surfaces v3: subscriptions vs API providers, one key and one model list per provider, pi curation that works

**Status:** Accepted (2026-09-23), owner-ruled from mockups `829a066c` (A · Subscriptions), `7eeb6bff` (B · Models in the picker), `4a21c0c4` (C · Claude defaults & endpoint), `42e09418` (D · API providers & shared keys)
**Amends:** [ADR-065](adr-065_settings-ia-v2-pages-groups-row-vocabulary.md) § "Providers: one list" (one list becomes two groups; the Accounts group folds into Subscriptions; the Anthropic endpoint leaves Models & providers) · [ADR-068](adr-068_chatgpt-identity-vault-owned-codex-injection.md) §2 as amended by F14 (accounts move from the Accounts group onto each subscription card; the workspace explainer row becomes a tooltip)
**Relates to:** [ADR-009](adr-009_claude-settings-vs-uisettings.md) (which store a setting lives in), [ADR-027](adr-027_test-data-attributes.md) (testids), [ADR-035](adr-035_pi-engine-backend.md) (pi wire), [ADR-059](adr-059_no-silent-model-fallback.md) (the spawn gate and the orphan guard this keeps), [ADR-036](adr-036_unified-auth-vault.md) (the vault that now holds catalog keys)

## Context

The owner reported that pi did not show the models ClaudeUI shares with it, and that the provider
sheet presents model curation as an opencode-only feature. Fact-checking that report against the
code, the owner's config and the pinned pi 0.87.1 binary found four independent defects, and a
settings layout that hides all of them.

1. **pi's allowlist is global and closed.** `piConfig.modelAllowlist` is one `string[]` of
   `<provider>/<model>` values (`src/core/pi/model-discovery.ts:128`). Once it exists, every provider
   without an entry in it shows nothing — including providers authenticated or shared _after_ the list
   was written. It gates the picker AND the spawn chokepoint (`resolvePiSpawnModel`, rung 2 errors on
   an explicit model outside it), so typing a model id does not get past it either. The owner's list
   named two OpenRouter models; the ChatGPT route (`openai-codex`, 8 models pi reports as available)
   and the `spark` endpoint were invisible.
2. **The UI has no way back to "all".** `PiModelAllowlistDialog` can only save an explicit list:
   Clear saves `[]` (nothing), Cancel closes. Removing the key requires hand-editing
   `engines/pi.json`. opencode's curation has the same one-way trap (every save writes an explicit
   list for the provider).
3. **pi hides keyless providers.** `compileProvider` (`PiSharedProviderAdapter.ts`) never writes an
   `apiKey`, and pi omits a `models.json` provider with no usable credential from
   `get_available_models` (verified in an isolated `PI_CODING_AGENT_DIR`: no key → `[]`, a dummy key →
   the model appears; `vendor/pi-cli/pi/docs/models.md`: "The dummy key makes the model available").
   A shared endpoint added with the key left blank — the normal case for a self-hosted server — is
   written to pi in a form pi can never discover, with no warning.
4. **pi's empty-route diagnosis is hard-coded.** `SharedProviderService.diagnoseRoute` returns
   `no-models-discovered` for pi unconditionally ("pi has neither concept"), so the ChatGPT row read
   _"The engine reported no models — check it is installed and reachable"_ while the real cause was
   the allowlist.

The layout compounds them: the curation group in the Manage sheet renders only for opencode; pi's
curation is a separate global dialog on the pi engine page; a catalog provider added "for both
engines" becomes two unrelated native rows (`OpenRouter` for opencode, `openrouter` for pi) with two
keys to rotate separately; subscriptions and API keys share one list; the ChatGPT accounts live in a
different group from the ChatGPT row, reached by a link that closes the sheet and scrolls to the
bottom of the page; the Claude "Default models" segment is a hard-coded list of five models that
already lacks the model `opus` resolves to (`claude-opus-5-5`); and the Anthropic endpoint — which
only ever reaches Claude (`sdk/endpoint-env.ts` holds it for cli.js spawns; opencode and pi never
see it) — sits on the cross-engine page.

## Decision

### 1. pi's allowlist is per provider, with opencode's rule

`piConfig.modelAllowlist` becomes `Record<providerId, string[]>` with the key-presence rule opencode
already uses: **no key → every model that provider reports; `[]` → none; a list → those.** Values are
bare model ids, as in opencode's map. A one-shot normaliser migrates the old `string[]` by grouping it
on the provider prefix; **a provider with no entries in the old list gets no key, i.e. shows all**
(owner ruling). `discoverPiModels`, `engineCounts` and every other reader apply the new rule. The spawn
gate (ADR-059) is unchanged in kind: a model a curated provider does not list still errors at spawn.

### 2. Curation is engine-generic, lives in the provider's Manage sheet, and can be undone

One curation component over a per-engine adapter (catalog for a provider, read and write the
selection, the values the orphan guard checks) replaces `OpencodeModelCuration`. The pi engine page's
global dialog is deleted; its "Model list" row becomes a summary linking to Providers. Both engines'
lists gain the missing direction: **"All models" vs "Only the ones I pick"** is one control, and
choosing All deletes the provider's key. Unticking a model while on All switches to "Only the ones I
pick" with everything else picked and says so (Undo). Models an engine names as a default, dispatch
or judge model show a lock and cannot be unticked (the existing orphan guard, shown before the click).

### 3. One model list per provider by default, split on request

For a provider enabled on both opencode and pi, the default is **one list for all engines**, keyed by
model id (native catalog providers share ids across engines; ChatGPT is already aggregated by id in
`aggregateChatgptModels`; custom providers map through `harnessOverrides.<engine>.id`). A model only
one engine offers stays in the list, marked, and applies to that engine only. **"Separate per engine"**
restores per-engine lists. The provider-level record (`linked` + the shared list) is the source of
truth while linked and is projected into each engine's allowlist, which discovery and the spawn gate
keep reading unchanged.

Migration: engines whose lists already agree start linked; engines whose lists differ start split.
Linking lists that differ is an explicit choice — opencode's list, pi's list, or both combined — shown
with what each would do to each engine. Going from linked to split copies the shared list into both.

A newly added provider starts on **All models**, except a catalog over **50 models**, which starts on
"Only the ones I pick" with nothing picked and an empty-state prompt (the anti-flood rule
`seedOpencodeAllowlist` carried, now engine-generic). _(Threshold adopted from the proposal; the owner
may revisit.)_

### 4. Keyless custom providers are visible to pi

The pi projection writes a placeholder `apiKey` into a custom provider's `models.json` entry **only
when the entry has none**, so a hand-set `$ENV` / `!command` key is never overwritten. `apiKey` is
excluded from the managed-projection equality (`sameManagedProvider`), so entries written before this
change do not trip "changed outside ClaudeUI". A real key is still vended to `auth.json`, which pi reads
first, and it wins. The placeholder never goes into `auth.json` (that would make `hasCredential` report
a keyless provider as connected). A keyless custom provider reads **"No key needed"**, never "Not
connected"; the key field is labelled optional.

### 5. pi reports why a route is empty

`diagnoseRoute` asks the pi adapter the same question it asks opencode's: `models-restricted` (the
allowlist filters every model out), `no-credential` (pi reports nothing for the provider id — no usable
key, or a broken `models.json` entry), or `no-models-discovered` (pi reported nothing at all). The pi
engine row in the sheet names the cause and where to fix it.

### 6. One key per provider

A key belongs to the provider, not to an engine. Catalog providers become vault-backed shared
definitions (like custom providers already are): the key is entered once, stored once in ClaudeUI's
vault, and delivered to each enabled engine's own `auth.json` under the id that engine uses. Enabling an
engine delivers the stored key; disabling removes it from that engine only; Replace rotates it
everywhere. The sheet shows delivery per engine, so a failed write is shown where it happened.

Migration of existing native pairs (the same catalog id configured in both engines): the main process
compares the two stored keys without sending either to the renderer. **Identical → adopted silently.
Different → the row is marked and the sheet asks which to keep** (each identified only by its last four
characters), or keep them separate. A key added outside ClaudeUI (`opencode auth login`) is offered for
adoption, never adopted automatically, since after adoption ClaudeUI overwrites that file on rotation.
Engine-owned OAuth credentials (GitHub Copilot via opencode, pi's OAuth vendors) cannot be shared and
stay engine-specific _(where they are listed — Subscriptions or API providers — is deferred; they stay
under API providers)_.

### 7. Models & providers: Subscriptions and API providers

The one Providers list becomes two groups.

- **Subscriptions** (Anthropic, ChatGPT): one card per subscription — header (identity, health), the
  account list (Set active with an inline confirm that counts the sessions it disconnects; Remove
  confirms in place; per-account re-auth), and one **Engines** row of engine pills with model counts.
  On ChatGPT the row has **Manage**, opening the same sheet an API provider uses minus its Key section
  (the accounts are the credential): Codex (built in), opencode and pi route toggles with delivery
  state, the model-list summary linking to curation, Codex models linking to the Codex page, pi
  overrides. Options (Multiple accounts with its plaintext-storage notice; per-session Codex pinning)
  fold under each card. Logos are the Claude and Codex marks (`@lobehub/icons-static-svg`, MIT). The
  **Accounts** group is removed; F14's link row and its "closes the sheet, lands at the bottom" hop go
  with it.
- **API providers**: one row per provider identity (keyed catalog vendors, custom endpoints, free
  tiers), engine pills with counts, **Manage** opening the sheet: Key, Engines, Models in the picker
  (summary + editor), Endpoint (custom), engine-specific editors, Remove. The Add flow is provider →
  one key + engines → models.

### 8. Claude's defaults come from Claude

The Claude segment of **Default models** becomes two settings, both built from cli.js's live
`supportedModels()` for the signed-in account rather than a hard-coded list: **Start new sessions on**
(a real default model; stored in ClaudeUI's `engines/claude.json`, not `~/.claude/settings.json`, so the
terminal `claude` is unaffected — ADR-009's "cli.js-consumed" rule does not apply because ClaudeUI
passes the model itself) and **Starting effort per model**: one row per resolved model, a "picked as"
column listing the aliases that reach it, effort levels from the model's own `supportedEffortLevels`.
A saved effort for a model the account no longer offers is listed, folded, with Remove. When the
Claude page pins one model or renames aliases, a banner here says so.

### 9. The Anthropic endpoint moves to the Claude page

`vendors/anthropic.json`'s endpoint and model mapping become **Claude › Endpoint**: first "Claude
sends requests to Anthropic / a custom gateway" (gateway fields only once chosen), then **Model
mapping** split into its two jobs — _Pin one model_ (`ANTHROPIC_MODEL`) and _Rename aliases_
(`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`), each field naming its env var. Storage is unchanged.

## Slices

Each is one commit, in this order (1–3 unblock pi without waiting for the redesign):

1. §4 keyless placeholder.
2. §1 per-provider pi allowlist + migration; §5 pi diagnosis.
3. §9 endpoint to the Claude page.
4. §8 Claude defaults from the live model list.
5. §2 engine-generic curation + undo; pi page dialog removed.
6. §3 linked lists.
7. §6 one key per provider (core: catalog definitions, delivery, migration).
8. §7 Subscriptions / API providers IA, Manage sheet, Add flow.

## Consequences

- pi stops silently hiding providers: a newly shared or authenticated provider shows all its models
  until curated, and a keyless endpoint appears.
- One place curates models for every engine, and every curation can be undone from the UI.
- Rotating a provider's key is one action. The vault now holds catalog API keys that previously lived
  only in each engine's `auth.json`; the vault's existing encryption and redaction rules (ADR-036)
  apply to them.
- The Manage sheet stops branching origin × engine inline: each engine contributes a section adapter
  (engine row, curation adapter, model-setup links), which is what made "the pi half" easy to forget.

## Alternatives considered

- **Keep pi's global list and add a "hidden models" banner.** Rejected: it explains the trap without
  removing it, and a newly shared provider would still start hidden.
- **One list per provider with no split option.** Rejected by the owner: engines can legitimately want
  different subsets.
- **Placeholder only for localhost URLs.** Rejected by the owner: keyless servers on the LAN or behind a
  tunnel are common.
- **Put the placeholder in `auth.json`.** Rejected: `hasCredential` would then report a keyless
  provider as connected.
- **Store the Claude default model in `~/.claude/settings.json`.** Rejected (proposal adopted): it would
  change the terminal CLI's default as a side effect.
