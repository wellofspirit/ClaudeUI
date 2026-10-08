# ADR-074 — Provider surfaces v3: subscriptions vs API providers, one key and one model list per provider, pi curation that works

**Status:** Implemented (2026-09-23, slices 1–10 — see § As built; §12 amended 2026-10-01; §8 amended 2026-10-05); accepted 2026-09-23, owner-ruled from mockups `829a066c` (A · Subscriptions), `7eeb6bff` (B · Models in the picker), `4a21c0c4` (C · Claude defaults & endpoint), `42e09418` (D · API providers & shared keys)
**Amends:** [ADR-065](adr-065_settings-ia-v2-pages-groups-row-vocabulary.md) § "Providers: one list" (one list becomes two groups; the Accounts group folds into Subscriptions; the Anthropic endpoint leaves Models & providers) · [ADR-068](adr-068_chatgpt-identity-vault-owned-codex-injection.md) §2 as amended by F14 (accounts move from the Accounts group onto each subscription card; the workspace explainer row becomes a tooltip)
**Amended by:** [ADR-086](adr-086_custom-endpoint-model-details-and-detect.md) (2026-09-30) — the custom-endpoint form (§7 "Endpoint (custom)") edits each model's context window, max output, vision and reasoning, with provenance badges, and a Detect button fills them from vLLM and SGLang; this is how the capabilities §11 projects into opencode get set.
**Amended by:** [ADR-092](adr-092_model-catalogs-per-engine-and-a-clean-boot.md) (2026-10-05) — the boot sync is idempotent: an unchanged key or token writes and invalidates nothing, removing an absent key is a no-op.
**Amended by:** [ADR-100](adr-100_claude-models-by-alias-only.md) (2026-10-09) — §8's Claude lists offer aliases only; Starting effort per model has one row per alias, and saved concrete picks map to their alias.
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

**Amended 2026-09-30 (owner ruling), effort keys follow the alias.** cli.js 2.1.285 moved `sonnet`
from Sonnet 5 to Sonnet 5.5, and a setting keyed on the resolved model stayed behind with the old
one. Starting effort is now keyed per family alias (`opus`, `sonnet`, `haiku`, `fable`, with `[1m]`
folded in). `default` shares the row of the alias that resolves to the same model. A row that
names a specific model id keys on that id. The table still shows the model each row runs on
today. A value a v3.5 build saved under the resolved id is read for its alias row, is not listed
as orphaned, and moves to the alias key when the row is edited (`claudeSavedEffort`,
`claudeLegacyEffortKey` in `src/shared/model-capabilities.ts`). The unset default is cli.js's
catalog `default_effort` for the resolved model (`medium` on Opus 5.5 and Sonnet 5.5).

**Amended 2026-10-05 (owner ruling), effort is remembered per model and is what the session runs.**
The owner set Opus to start at High and still saw new sessions, and remote clients watching a
session that ran High, read Medium: the composer's effort read `effort ?? modelDefaultEffort` and
skipped the starting effort that spawn applied, and an effort pick (a local write plus a respawn)
never reached canonical state. Four rules replace that:

- **One ladder.** A session's own effort, else the model's starting effort, else cli.js's
  `default_effort`, clamped to the model's levels (`resolveDesiredEffort` / `resolveSpawnEffort`
  in `src/shared/model-capabilities.ts`, `sessionSpawnEffort` in
  `src/renderer/src/lib/session-effort.ts`). The composer and every spawn path (first send,
  respawn, retry, plan "start fresh", review) read it over the same inputs. Automations run and
  display the same ladder (`resolveAutomationEffort`), judged against the Claude catalog the
  host last fetched on any transport; a model the catalog lacks is judged as the model its
  alias names.
- **A pick is remembered for its model.** Picking an effort in the composer also saves it as that
  model's starting effort, so the next session on the model starts there and Starting effort per
  model shows it. Claude writes the row this table edits (`modelEffortDefaults`, keys as above).
  pi remembers too, in its own map (`engineEffortDefaults.pi`, keyed by the model value as pi
  names it), because pi's `provider/model` values would otherwise land on Claude's keys. opencode
  (no effort) and Codex (native tiers, set live) do not remember. Like the model (§10), this
  follows "New sessions start on": with `configured-default` a pick changes only its session, the
  table stays as configured, and pi's remembered values (which have no table to show or clear
  them) are not applied (`carriesPicksIntoNewSessions`).
- **The starting effort is fixed at spawn.** `session:create` takes an optional `announce`; the
  host announces on `session:created` the effort the process is actually spawned with (`null` for
  a model known to take no effort, nothing for a model not yet in the catalog), and every replica
  adopts it as the session's own. A later change to a model's starting effort, by another
  session's pick or by this table, affects only sessions that have not started; one already
  running keeps showing what it runs. Canonical effort is not persisted, so after a host restart
  a resumed session re-resolves against the current starting effort (and runs it). A client that
  omits `announce` behaves as before.
- **Switching model.** Before a session has a process, switching model clears its effort so the
  new model's starting effort applies. A running session keeps its own, adjusted to the new
  model's levels.

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

## As built (2026-09-23)

Commits, in order: `e5960915` (§4), `406d6692` (§1, §5), `f1d27e67` (§9), `6bca2a5c` (§8), `615e8b5e`
(§2), `29f245ef` (§6 core), `e94222a3` (§7 Subscriptions), `63e550bd` (§3), `afe90f4e` (§6–7 API
providers), `fa5c7019` (§10 below), `8a0a316f` (§11 below). Each slice was fresh-reviewed and verified
in the real app; `docs/providers-v3-handoff.md` holds the specs and the log.

What the build changed about the decision:

1. **The vault is plaintext** (0600 in 0700), not encrypted — the same protection each engine's
   `auth.json` has. §Consequences corrected.
2. **`config:save-opencode-settings` no longer writes the allowlist at all.** Settings panes save the
   whole object they loaded at mount, which reverted curation the Manage sheet had just changed;
   `models:set-provider-allowlist` is the one writer for both engines.
3. **`findModelReferences` is engine-scoped**: opencode and pi picker values share a namespace, so an
   unscoped orphan guard let pi's default block an opencode untick of the same value.
4. **Adoption compares keys in the main process** (last-four hints are the only part that leaves it)
   and never touches OAuth or opencode `wellknown` entries. The first boot of the owner's build adopted
   OpenRouter (identical keys in both engines). "Use for both" on a single-engine key enables the other
   engine only when it holds no credential of its own.
5. **A catalog definition owns only the native keys of routes it has enabled**; a key under a disabled
   route is the user's and is never deleted by a sync.
6. **Models in the picker is a summary + a stacked editor** in the Manage sheet (mockup D), which re-reads
   the definition after every write so a split list never reopens as one.
7. **Removal logging**: every `removeVendorAuth` logs the vendor id and call path (never the key), after
   an unexplained loss of the owner's pi OpenRouter key during the arc.

**Amended 2026-10-01, stale rows and live model identity.** API providers' Remove action can remove
disabled-only stale opencode entries by clearing their native veto and ClaudeUI curation.
The ownership checks and conditional rediscovery of external providers are specified in
[ADR-044](adr-044_opencode-provider-disable-vs-remove.md).

Defaults and picker curation do not switch an existing session's model. When curation removes its
model, the composer retains its identity and reported live capabilities rather than substituting
a listed/default model. For live opencode/pi sessions the model badge follows `status.model`,
including while an explicit picker change awaits the backend acknowledgement. Status events
reconcile the shared selected model and per-session model record, as Codex already does. A delayed
historical load cannot overwrite the config or transcript of a session that has become live.

### 10. New sessions: last pick or configured default (owner ruling)

The last model picked on an engine still seeds new sessions ahead of the configured default, but
`AppSettings.newSessionModel` (`'last-picked'` default | `'configured-default'`), shown as "New
sessions start on" at the top of every Default models segment, turns that off. Every seeding path reads
the picks through `seedingModelPicks`. Default-model rows note "Used until you pick a model in the
composer." while the last pick wins.

### 11. Several keys for one provider, and an on/off switch (owner ruling, mockup `b90c7ea5`)

- **A second key is its own entry** — a custom definition (`derivedFrom`, `copiedAt`) pointing at the
  vendor's endpoint, with its own id in both engines (e.g. `openrouter-work`), so both keys are usable at
  once. Protocol and URL come from the catalog's SDK package and endpoint when every model agrees,
  otherwise the form asks; an id that is an opencode catalog vendor or a pi built-in is refused. Up to 50
  models, metadata copied from the catalog; "Refresh from catalog" re-copies what the catalog states and
  keeps the rest. Both engines accept `vendor/model` ids (verified).
- **opencode now receives custom models' capabilities** (reasoning, attachment/input modalities, tool
  calls, context and output limits), merged per leaf with hand edits kept; the managed check compares
  identity only. Previously opencode saw only a name, so custom models had no effort control, image
  input or compaction there.
- **On/off per shared API provider** (`disabled`). Off removes projections and delivered keys under the
  ownership rules and clears engine defaults pointing at it, keeping key, routes, curation and defaults;
  on restores them, refusing to replace a key an engine was given meanwhile unless confirmed. A key
  stranded by an interrupted switch-off is reclaimed by the next sync only while it equals the vault key.
- **A harness that is not installed** is given no key and not asked about; removals of ClaudeUI's own
  entries still happen at once (opencode's key as a direct file edit), a catalog route's removal
  takes out only ClaudeUI's key (the vault's, or the one it last delivered) and never an engine's
  own, and an automatic sync never replaces an
  engine's own key — told from ClaudeUI's earlier ones by fingerprint, with "Use the stored key" to
  replace it — see [ADR-082](adr-082_harness-sources-downloads-and-unbundling.md) §8 "As built
  (arc 3, S7d)".

### 12. A provider created in ClaudeUI is usable where a harness has its own key (owner ruling, 2026-10-01)

"When I create an OpenRouter provider in ClaudeUI, I want it to be usable in opencode/pi." Amends §6
and the Add sheet's candidate rule:

- **The Add sheet offers every catalog provider ClaudeUI does not manage yet**, with every running
  harness that offers it as a target, whether or not that harness holds its own key for the vendor
  (an authenticated opencode entry, a keyed pi vendor). Such a harness carries a note — "pi has its
  own key for OpenRouter". Only an id a shared definition already owns is left out. pi vendors are
  named by opencode's catalog name, else their id title-cased.
- **Creating asks before replacing an own key**, once, naming the harness(es): "pi already has its
  own OpenRouter key. Overwrite it and manage the key from ClaudeUI?" **Overwrite and manage from
  ClaudeUI** creates the provider for every picked harness and replaces that key with the stored one
  (`shared-provider:set-key` with `replaceOwn` naming the harnesses asked about); ClaudeUI manages
  the slot from then on (fingerprinted). **Keep pi’s own key** creates it for the other picked
  harnesses, with that harness's route off and its key untouched. Leaving the sheet writes nothing.
  Save asks the host who holds an own key before asking the user — read from the harnesses' auth
  files, never a cached catalog — so the question names every such harness as of then; so do "Use
  ClaudeUI’s … here instead" and switching a provider on. The confirmation is PER HARNESS: the service replaces an own key only in a harness
  `replaceOwn` names; any other keeps its own key and says so (`ownKeyKept`, "Use the stored key"),
  as an automatic delivery does — so Replace key on the Manage sheet no longer replaces one silently
  either, and switching a provider on refuses an own key the confirm did not name.
- **A harness's own credential is named for whose it is**: a native row that no ClaudeUI provider
  claims reads "OpenRouter · pi’s own key" (`ownedBy`, `providerEntryTitle`; "· opencode’s own key",
  "· pi’s own sign-in"), never the raw id. When a ClaudeUI provider for the same vendor exists but
  is off (switched off, or its route to that harness off), that row's sheet offers **Use ClaudeUI’s
  OpenRouter here instead**, which asks the same question and then turns the route on and the
  provider on with `replaceOwn` naming the harnesses it asked about.

See [ADR-082](adr-082_harness-sources-downloads-and-unbundling.md) §8 "As built (arc 3, S7f)".

## Consequences

- pi stops silently hiding providers: a newly shared or authenticated provider shows all its models
  until curated, and a keyless endpoint appears.
- One place curates models for every engine, and every curation can be undone from the UI.
- Rotating a provider's key is one action. The vault now holds catalog API keys that previously lived
  only in each engine's `auth.json`. The vault is plaintext JSON at mode 0600 in a 0700 directory
  (ADR-036) — the same protection those `auth.json` files have — so a key gains one more copy, not a
  weaker one; the renderer still never receives a key value (status reads are redacted).
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
