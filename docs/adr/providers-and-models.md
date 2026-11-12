# Providers and models

Governs: `src/core/shared-providers/`, `src/shared/provider-registry.ts`, `src/shared/shared-provider.ts`, `src/shared/model-references.ts`, `src/shared/model-errors.ts`, `src/shared/endpoint-detect.ts`, `src/shared/model-capabilities.ts`, `src/core/auth/vault/`, `src/core/ipc/engine-models.ts`, `src/core/pi/model-discovery.ts`, `src/core/pi/PiRpcClient.ts`, `src/core/opencode/model-discovery.ts`, `src/renderer/src/components/SettingsDialog/`

How ClaudeUI shares providers, credentials and model lists with the configurable harnesses (pi and opencode): the canonical definitions and the plaintext vault, the Settings surfaces (Subscriptions, API providers, curation), custom endpoints with Detect, the rule that a configured model never silently turns into another one, and how model catalogs load per engine. Accounts, sign-in and the ChatGPT identity are ADR-021, ADR-036, ADR-068, ADR-070, ADR-080 (`auth-and-accounts.md`). opencode provider Disable versus Remove is ADR-044 and native config writes are ADR-028, ADR-031 (`opencode.md`). Claude models by alias only is ADR-100 (`claude-engine.md`). The judge's model route is ADR-081 (`auto-mode-judge.md`). Capability honesty is ADR-030 (`engine-model.md`). The Settings information architecture is ADR-065 (`persistence-and-settings.md`). `docs/model-capabilities.md` is the capability reference.

## Shared provider routing and a plaintext credential vault (ADR-037)

This is the shared-provider-routing ADR-037, not the engine customization policy ADR-037 (`harness-installs.md`).

- **Scope.** ClaudeUI owns canonical shared-provider definitions for configurable multi-provider harnesses only:
  pi and opencode (`ConfigurableHarnessId`). Claude Code is excluded from shared-provider configuration and
  credential vending. A future harness registers a routing adapter, not another `EngineId` assumption.
- **Where things live.** Definitions are `~/.claude/ui/providers/<id>.json` (directory 0700, files 0600). Credentials
  are in the one central vault `~/.claude/ui/auth-vault.json`. A definition has shared models, with optional
  per-harness model id, enabled and default overrides; adding a model applies it to every enabled compatible route.
  Each provider has explicit pi and opencode enabled switches. ChatGPT is catalog-backed: shared id `chatgpt`,
  pi id `openai-codex`, opencode id `openai`. Custom definitions declare an endpoint, one protocol of
  `openai-completions`, `openai-responses` or `anthropic-messages`, models and an API-key credential.
- **Ownership.** Only ClaudeUI-managed providers are compiled, removed or credential-vended. Native and external
  providers and unknown fields are preserved; a provider-id collision is an error where practical. pi compilation
  targets only `~/.pi/agent/auth.json` and `~/.pi/agent/models.json` (intentionally extending ADR-035); opencode
  uses its native config through a targeted merge writer and its credential store for keys (ADR-097 §5).
- **The vault is plaintext, deliberately.** `auth-vault.json` is plain JSON, written atomically (temp file, then
  rename) with mode 0600 inside a 0700 `~/.claude/ui` (the chmods are skipped on Windows, which relies on the
  profile ACL). Electron `safeStorage` and the OS keychain are not used: the vault gives a credential the same
  protection pi's `auth.json` and opencode's own credential store already give it, so a key gains one more copy, not a weaker
  one. It holds ChatGPT OAuth accounts (ADR-068), the API keys of shared providers (§6 below) and disconnect
  markers. The renderer never receives a key or token value: status reads are redacted to presence and a
  last-four hint. Log lines name a vendor id, a value type and an owner, never a value or label.
- **Old encrypted vaults.** A v1 vault with `encrypted: true` is never decrypted or passed to `safeStorage`; it
  reads as disconnected and the user reconnects. A plaintext v1 vault migrates to the current format on read (its
  Codex-keyed entry becomes `chatgpt`). Reconciliation recovers a ChatGPT credential from the newest native pi or
  opencode copy when the vault lacks one.
- **Route off.** Disabling one route removes only its ClaudeUI-managed native config and credential and persists
  the disabled state so a later sync does not re-vend it. Global disconnect clears the central credential and every
  vended copy but keeps the non-secret definition. Status is token-free.

## Configured model references fail loudly: no silent fallback (ADR-059)

**An explicit user-configured model reference that is no longer available produces an error at the point of use,
never a silent substitute. Built-in heuristic defaults, where the user configured nothing, may keep falling back
quietly.** Configured-ness is the boundary: an error is owed only where there was intent to violate. A substitute
differs in capabilities, cost and behaviour (a vision-less fallback once hid image paste; for the judge it changes
which model holds the security keys), so the failure must name its cause instead of surfacing three layers later.

A configured reference is: opencode's native `model` / `smallModel`, pi's `piConfig.defaultModel`,
`autoMode.judgeModel` (any engine), `dispatch.defaultModel` and each `dispatch.allowedModels` entry (any engine),
and a per-session requested model (the picker pick persisted on the session slot). Not configured, so a stale
value falls through to the next rung silently: the builtin `OPENCODE_DEFAULT_MODEL` / `PI_DEFAULT_MODEL` constants
and the per-engine last-picked stickiness (`lastSelectedModelByEngine`).

Enforcement per surface:

1. **Spawn.** `resolveOpencodeSpawnModel` / `resolvePiSpawnModel` throw `ModelUnavailableError`
   (`src/shared/model-errors.ts`, a message naming the model and the settings surface that owns it) for a requested
   model absent from a non-empty catalog. It rides the create-session path to the send-error banner with the draft
   preserved. A call with no requested model keeps the heuristic ladder (agent-generate depends on it).
2. **Renderer seeding.** `opencodeDefaultModelConfigured` / `piDefaultModelConfigured` separate user config from the
   builtin constant. A stale configured default seeds `selectedModel: ''` (the "Select a model" row), banners once,
   is never encoded into `sessionEngines`, and blocks send until a model is picked. The engine does not flip to
   claude: that guard is reserved for "no models at all".
3. **Judge.** A configured `autoMode.judgeModel` absent from the engine's catalog emits one `session:error` per
   session and fails closed to human approval. Never a substitute judge and never `?? this._model`; the unset case
   still defaults to the session's own model (parity, not fallback; ADR-023).
4. **Settings edits.** The orphan guard (`findModelReferences` in `src/shared/model-references.ts`, engine-scoped
   because opencode and pi picker values share a namespace, but scanning every engine's config because Claude's
   cross-engine dispatch can name opencode models) refuses an allowlist save or a provider disable/remove that would
   strand a configured reference, naming it inline. Stale values already saved render verbatim with an
   "(unavailable)" marker, never collapsed to the empty label.

**Validation requires a non-empty catalog.** An empty or failed discovery cannot tell "removed" from "not discovered
yet", so every check passes the value through unvalidated.

Accepted costs: a session slot remembering a since-removed model errors at spawn (it used to swap silently).
`dispatch.allowedModels` orphaning is a hard block (downgrading it to a warning is a one-line change at
`findModelReferences`' call sites). The opencode judge pre-check is cache-only (`peekOpencodeModels`), so an approval
racing a cold discovery cache validates nothing and uses the configured judge. Fresh installs are unchanged: with
nothing configured the builtin ladders pick a working model.

## Provider surfaces: subscriptions and API providers, one key and one model list per provider (ADR-074)

One Providers list is two groups, a provider has one key and (by default) one model list across engines, and model
curation lives in the provider's Manage sheet for both engines and can always be undone. The numbered parts below
keep their labels.

### §1 pi's allowlist is per provider, with opencode's rule

`piConfig.modelAllowlist` is `Record<providerId, string[]>` of bare model ids, with opencode's key-presence rule:
**no key means every model the provider reports; `[]` means none; a list means those.** A provider without an entry
shows everything, including providers shared or authenticated after the list was written (the old global `string[]`
silently hid them). The old array form is migrated once by grouping on the provider prefix; a provider with no
entries in it gets no key. `discoverPiModels`, `engineCounts` and every reader apply the rule, and the spawn gate
(ADR-059) still errors on a model a curated provider does not list.

### §2 Curation is engine-generic, in the Manage sheet, and undoable

One curation component over a per-engine adapter serves both engines; pi has no separate global dialog (its engine
page row is a summary linking to Providers). **"All models" versus "Only the ones I pick"** is one control, and
choosing All deletes the provider's key. Unticking a model on All switches to "Only the ones I pick" with the rest
picked and offers Undo. Models named as a default, dispatch or judge model show a lock and cannot be unticked (the
orphan guard, shown before the click). `config:save-opencode-settings` never writes the allowlist: settings panes
save the whole object they loaded at mount, which reverted curation the sheet had just changed.
`models:set-provider-allowlist` is the one writer for both engines.

### §3 One model list per provider by default, split on request

For a provider enabled on both engines the default is one list for all engines, keyed by model id (native catalog
providers share ids; ChatGPT is aggregated by id in `aggregateChatgptModels`; custom providers map through
`harnessOverrides.<engine>.id`). A model only one engine offers stays in the list, marked, and applies to that engine
only. "Separate per engine" restores per-engine lists. The provider-level record (`linked` plus the shared list) is the
truth while linked and is projected into each engine's allowlist, which discovery and the spawn gate keep reading.
Migration: engines whose lists agree start linked, those that differ start split; linking differing lists is an
explicit choice (one, the other, or combined). Linked to split copies the shared list into both. A newly added
provider starts on All models, except a catalog over `LARGE_CATALOG` (50 models), which starts on "Only the ones I
pick" with nothing picked and an empty-state prompt (the anti-flood rule).

### §4 Keyless custom providers are visible to pi

pi omits a `models.json` provider with no usable credential from its model list. The pi projection therefore writes a
placeholder `apiKey` (`CLAUDEUI_KEYLESS_PLACEHOLDER`) into a custom provider's entry only when the entry has none, so
a hand-set `$ENV` or `!command` key is never overwritten. `apiKey` is excluded from the managed-projection equality
(`sameManagedProvider`), so older entries do not read as "changed outside ClaudeUI". A real key is still vended to
`auth.json`, which pi reads first. The placeholder never goes into `auth.json` (that would make `hasCredential` report
a keyless provider as connected). A keyless custom provider reads "No key needed", never "Not connected"; the key
field is labelled optional. Rejected: placeholder only for localhost URLs (LAN and tunnelled keyless servers are
common).

### §5 pi reports why a route is empty

`SharedProviderService.diagnoseRoute` asks the pi adapter as it asks opencode's: `models-restricted` (the allowlist
filters everything), `no-credential` (pi reports nothing for that provider id: no usable key, or a broken
`models.json` entry) or `no-models-discovered` (pi reported nothing at all). The sheet's engine row names the cause
and where to fix it.

### §6 One key per provider

A key belongs to the provider, not an engine. Catalog providers are vault-backed shared definitions like custom ones:
the key is entered once, stored once in the vault, and delivered to each enabled engine's own credential store (pi's `auth.json`, opencode's credential rows) under the id
that engine uses. Enabling an engine delivers the stored key, disabling removes it from that engine only, Replace
rotates it everywhere, and the sheet shows delivery per engine so a failed write is visible where it happened.

- **Adoption.** An existing native pair (same catalog id keyed in both engines) is compared in the main process; the
  renderer sees only last-four hints. Identical keys are adopted silently; different ones mark the row and ask which
  to keep (or keep separate). A key added outside ClaudeUI (`opencode auth login`) is offered for adoption, never
  adopted automatically: adoption makes ClaudeUI the keeper of that key, which it then vends as its own credential
  row and rotates (on opencode 2.x the user's own row stays theirs, ADR-097 §5). Adoption never touches
  OAuth or opencode `wellknown` entries. "Use for both" on a single-engine key enables the other engine only when it
  holds no credential of its own. Engine-owned OAuth credentials (GitHub Copilot via opencode, pi's OAuth vendors)
  cannot be shared and stay engine-specific, listed under API providers.
- **A catalog definition owns only the native keys of routes it has enabled.** A key under a disabled route is the
  user's and is never deleted by a sync. Every `removeVendorAuth` logs the vendor id and call path, never the key.
- **Not-installed harness.** It is given no key and not asked about; removals of ClaudeUI's own entries still happen
  at once. A route's removal takes out only ClaudeUI's key (the vault's, or the one it last delivered), never an
  engine's own, and an automatic sync never replaces an engine's own key: ClaudeUI's earlier keys are told from the
  engine's by fingerprint (`delivered-keys.ts`), with "Use the stored key" to replace deliberately (ADR-082 §8).

### §7 Models and providers: Subscriptions and API providers

- **Subscriptions** (Anthropic, ChatGPT): one card per subscription with identity and health, the account list (Set
  active with an inline confirm counting the sessions it disconnects, Remove confirming in place, per-account
  re-auth) and one Engines row of pills with model counts. ChatGPT's Manage opens the API-provider sheet minus its Key
  section (the accounts are the credential): opencode and pi route toggles with delivery state, the model-list
  summary linking to curation, pi overrides. Options (Multiple accounts with its plaintext-storage notice) fold under
  the card. There is no separate Accounts group.
- **API providers**: one row per provider identity (keyed catalog vendors, custom endpoints, free tiers), engine pills
  with counts, and Manage: Key, Engines, Models in the picker (a summary plus a stacked editor that re-reads the
  definition after every write, so a split list never reopens as one), Endpoint (custom), engine-specific editors,
  Remove. The Add flow is provider, then one key and engines, then models.
- The Manage sheet takes a section adapter per engine (engine row, curation adapter, model-setup links) instead of
  branching origin by engine inline, so no engine's half is forgotten.

### §8 Claude's defaults come from Claude

The Claude segment of Default models is built from cli.js's live `supportedModels()` for the signed-in account, never
a hard-coded list, and offers aliases only (ADR-100). **Start new sessions on** is a real default model stored in
ClaudeUI's `engines/claude.json`, not `~/.claude/settings.json`, so the terminal `claude` is unaffected.
**Starting effort per model** has one row per alias with effort levels from the model's own `supportedEffortLevels`; a
saved effort for a model the account no longer offers is listed, folded, with Remove. A banner says when the Claude
page pins one model or renames aliases.

- **Effort keys follow the alias.** Starting effort is keyed per family alias (`opus`, `sonnet`, `haiku`, `fable`,
  with `[1m]` folded in) so a setting does not stay behind when an alias moves to a newer model; `default` shares the
  row of the alias that resolves to the same model; a row naming a specific model id keys on that id. A value saved
  under a resolved id is read for its alias row and moves to the alias key when edited (`claudeSavedEffort`,
  `claudeLegacyEffortKey`). The unset default is the catalog's `default_effort` for the resolved model.
- **One ladder.** A session's own effort, else the model's starting effort, else cli.js's `default_effort`, clamped to
  the model's levels (`resolveDesiredEffort` / `resolveSpawnEffort` in `src/shared/model-capabilities.ts`,
  `sessionSpawnEffort` in `src/renderer/src/lib/session-effort.ts`). The composer and every spawn path (first send,
  respawn, retry, plan "start fresh", review) read it over the same inputs; automations run and show the same ladder
  (`resolveAutomationEffort`), judged against the Claude catalog the host last fetched.
- **A pick is remembered for its model.** An effort pick in the composer also saves as that model's starting effort
  (`modelEffortDefaults` for Claude; pi in its own `engineEffortDefaults.pi`, keyed by pi's model value). opencode (no
  effort) does not remember. This follows "New sessions start on" (§10): under `configured-default` a pick changes only
  its session and pi's remembered values are not applied (`carriesPicksIntoNewSessions`).
- **The starting effort is fixed at spawn.** `session:create` takes an optional `announce`; the host announces on
  `session:created` the effort the process actually spawned with (`null` for a model that takes none, nothing for one
  not yet in the catalog) and every replica adopts it. A later change to a model's starting effort affects only
  sessions not yet started. Canonical effort is not persisted: a resumed session after a host restart re-resolves.
- **Switching model.** Before a session has a process, switching model clears its effort so the new model's starting
  effort applies; a running session keeps its own, adjusted to the new model's levels.

### §9 The Anthropic endpoint lives on the Claude page

`vendors/anthropic.json`'s endpoint and model mapping are Claude › Endpoint: first "Claude sends requests to
Anthropic / a custom gateway" (gateway fields only once chosen), then Model mapping split into _Pin one model_
(`ANTHROPIC_MODEL`) and _Rename aliases_ (`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`), each field naming its env
var. The endpoint only ever reaches Claude (`sdk/endpoint-env.ts` holds it for cli.js spawns; opencode and pi never
see it), so it is not on the cross-engine page. Storage is unchanged.

### §10 New sessions: last pick or configured default

The last model picked on an engine seeds new sessions ahead of the configured default, unless
`AppSettings.newSessionModel` is `'configured-default'` (default `'last-picked'`), shown as "New sessions start on" at
the top of every Default models segment. Every seeding path reads picks through `seedingModelPicks`; default-model
rows say "Used until you pick a model in the composer." while the last pick wins. The last pick is a heuristic, not a
configured reference (ADR-059).

### §11 Several keys for one provider, and an on/off switch

- A second key is its own custom definition (`derivedFrom`, `copiedAt`) pointing at the vendor's endpoint with its own
  id in both engines (e.g. `openrouter-work`); protocol and URL come from the catalog when every model agrees, else the
  form asks; an id that is an opencode catalog vendor or a pi built-in is refused; up to 50 models, metadata copied
  from the catalog; "Refresh from catalog" re-copies what the catalog states and keeps the rest.
- opencode receives custom models' capabilities (reasoning, attachment/input modalities, tool calls, context and
  output limits), merged per leaf with hand edits kept; the managed check compares identity only.
- On/off per shared API provider (`disabled`): off removes projections and delivered keys under the ownership rules
  and clears engine defaults pointing at it, keeping key, routes, curation and defaults; on restores them, refusing to
  replace a key an engine was given meanwhile unless confirmed. A key stranded by an interrupted switch-off is
  reclaimed by the next sync only while it equals the vault key.

### §12 A provider created in ClaudeUI is usable where a harness has its own key

The Add sheet offers every catalog provider ClaudeUI does not manage yet, for every running harness that offers it,
whether or not that harness holds its own key (noted "pi has its own key for OpenRouter"). Creating asks before
replacing an own key, once, naming the harness(es): **Overwrite and manage from ClaudeUI** replaces it with the stored
key (`shared-provider:set-key` with `replaceOwn`) and ClaudeUI manages the slot from then on (fingerprinted); **Keep
pi's own key** creates the provider for the others with that route off and the key untouched. The host reads the
harnesses' auth files at Save time to know who holds an own key, never a cached catalog. The confirmation is per
harness: the service replaces an own key only in a harness `replaceOwn` names; any other keeps it and reports
`ownKeyKept` ("Use the stored key"). So Replace key and switching a provider on never replace an own key silently. A
native row no ClaudeUI provider claims reads "OpenRouter · pi's own key" (`ownedBy`, `providerEntryTitle`), and when a
ClaudeUI provider for the vendor exists but is off, that row's sheet offers "Use ClaudeUI's OpenRouter here instead",
asking the same question (ADR-082 §8).

### § As built: what the build changed about the decision

- **Plaintext vault.** The vault is plaintext (0600 in 0700), not encrypted: the same protection pi's `auth.json`
  and opencode's credential store have (ADR-037, above).
- **Adoption in the main process.** Keys are compared in the main process; only last-four hints leave it (§6).
- **Removal logging (amendment 7).** Every `removeVendorAuth` logs vendor id, value type, owner and call path, never a
  value or label (`src/core/opencode/credential-store.ts`).
- **Stale rows and live model identity.** API providers' Remove can remove disabled-only stale opencode entries by
  clearing ClaudeUI curation and the native disable (ownership checks in ADR-044). Defaults and picker curation never
  switch an existing session's model: when curation removes its model the composer keeps its identity and reported live
  capabilities rather than substituting. For live opencode and pi sessions the model badge follows `status.model`,
  including while a picker change awaits acknowledgement. A delayed historical load cannot overwrite the config or
  transcript of a session that has become live.

## Custom endpoints: per-model details in the form, filled by Detect (ADR-086)

The custom-endpoint form (Add provider › Custom endpoint, and the Manage sheet's Edit endpoint; ADR-074 §7) edits each
model's limits and capabilities, which is how the capabilities opencode receives (§11) get set. A blank model is
harmful: opencode gets `limit { context: 0, output: 0 }` (context 0 turns overflow detection off, so no auto-compact;
output 0 falls back to 32,000, so a context set alone on a small model leaves almost no usable window), and pi falls back
to 128,000 context and 16,384 output.

- **1. Details per model.** Each row keeps id, display name and Remove and expands to Context window and Max output
  (numbers; clearing means "the engine's default") and Vision and Reasoning (switches). Collapsed, a chip line
  summarises it. A dense grid was rejected: a SGLang process serves one base model and a vLLM endpoint usually one to
  three.
- **2. Provenance badges.** **server** (read and unchanged), **suggested** (ClaudeUI's number, never reported),
  **manual** (the user's), **default** (blank). Computed against a per-model `detected` record that holds what the last
  Detect read or suggested. `detected` is ClaudeUI-only: neither adapter projects it, and a guard test proves the
  projection is byte-identical with and without it.
- **3. Detect is a button, never automatic**, so a half-typed URL fires nothing. The host performs it
  (`shared-provider:probe`, `src/core/shared-providers/endpoint-probe.ts`): `GET {base}/models` (server kind from
  `owned_by`: `vllm`, `sglang`, else OpenAI-compatible; `max_model_len` becomes the context window); for SGLang also
  `GET {root}/model_info` (fallback `/get_model_info`, `{root}` = base without `/v1`): `has_image_understanding` is
  vision, a non-null `reasoning_parser` is reasoning, applied to every served model. A null `tool_call_parser` is a
  shown warning, not stored. If `/model_info` is unreadable, Detect still succeeds with the context and says so. On a
  fresh Add with blank rows the served models fill the list; otherwise "Import served models (N new)" adds the unlisted
  ones and a listed model the server no longer serves is marked "not served by this endpoint". Neither server reports a
  max output or (vLLM) vision or reasoning.
- **4. A detected context always brings a suggested max output**, `min(32,768, floor(context / 4))`, badged suggested
  (none for a context under 4 tokens). Independently, a row warns when its effective output (its own value, else the
  largest default among the running engines it is enabled for: opencode `OPENCODE_DEFAULT_MAX_OUTPUT` 32,000, pi
  `PI_DEFAULT_MAX_OUTPUT` 16,384) exceeds half its context, with a one-click Set {suggestion}.
- **5. Detect again never overwrites silently.** It fills blank fields; a value equal to the server's reading only
  refreshes the baseline; every other difference is a pending change (`{model} {field} {from} → {to}`, "you edited
  this" when the current value is the user's) with Apply and Ignore, persisted only by the sheet's Save. The suggested
  max output enters the diff only while the current value is still the suggestion and the context moved; a max output
  the user typed is never offered a replacement (the D4 warning speaks instead). The diff shows only changes that still
  hold and Apply skips stale ones. Changing the Base URL or protocol clears the last result and drops an in-flight
  answer, so one server's models never import into another endpoint.
- **6. The probe is host-side, capability-gated and never returns a key.** `shared-provider:probe` carries the
  `config` capability (same as saving a provider): it makes the host fetch a user-supplied URL, so a remote session
  that cannot configure providers must not use the host as a fetch proxy. Each request has a 5 s timeout, follows no
  redirect (a 3xx is reported with its target), and reads at most 2 MiB. The key is the one being typed, or, when
  editing, the vault key looked up host-side by provider id, but only for an existing custom definition and only when
  the typed URL has the same origin as its saved Base URL; otherwise the probe runs keyless and the failure says
  (`keyWithheld`) the saved key was withheld. Without this rule any provider id (a catalog one such as OpenRouter)
  could send its key to any typed address. The key goes as a Bearer token (plus `x-api-key` for the Anthropic-messages
  protocol) and appears in no result, error or log line. The result discriminates on `status` (`detected` | `failed`),
  never on an `ok` key.
- **Smaller rules.** Userinfo in a Base URL is refused, not stripped; duplicate served ids are dropped. "Enable for"
  offers only harnesses that run (ADR-082 §8) and the output warning measures only routes whose harness runs.
  Rules for fill, badges, diff and warning are pure functions in `src/shared/endpoint-detect.ts`; the form only
  renders them.
- Out of scope: detectors for LiteLLM or OpenRouter-shaped custom endpoints, a `toolCall` field on the model, changing
  the adapters' blank-field defaults, per-model capability configuration on Claude's Endpoint page.

## Model catalogs load per engine and survive boot; pi is ended through stdin (ADR-092)

Three rules that came from one bug (a pi composer showing a raw model value for a minute after restart).

### 1. One catalog request per engine

`getEngineModels(engineId?)` keeps its channel with an optional engine id: with one, only that engine's lookup runs;
without one (or `null`, since a JSON wire turns `undefined` into `null`) all engines run concurrently into one reply
(`listEngineModels` in `src/core/ipc/engine-models.ts`, shared by the desktop and remote handlers). The argument is
untrusted: an unknown id rejects, because `[]` would read as "this engine has no models". The composer sends one request
per engine; each answer replaces only that engine's slice of `availableModels` (`setEngineModels`), rebuilt in
`HARNESS_IDS` order whatever order answers arrive in, filtered to the requested engine, and carrying its own token so
one engine's reload never orphans another's in-flight answer. Reloads are per engine (`engineModelReloadNonces[engine]`,
`reloadEngineModels(engine)`; `reloadModels()` bumps all); a harness change (ADR-082 `followRunChanges`) and a recovered
catalog reload only their engine. The all-engines reply remains for callers that want everything and can afford the
slowest probe.

### 2. A degraded catalog heals itself and says so

pi discovery tells pi's own "no models" from a failed probe. A successful empty answer (no credentials) keeps the 60 s
negative cache. A failure (spawn error, `success:false`, timeout, exit) backs off 5 s (`FAILED_PROBE_BACKOFF_MS`) and
runs one background re-probe: unref'd, never stacked, re-armed by an invalidation while a degraded answer is
outstanding, never chained after its own failure (a broken pi is not polled). A probe cancelled by an invalidation is
not cached. When the catalog fills after a caller was given a degraded `[]`, main emits `engine:models-changed
{ engineId }` (replicated, like `harness:changed`) and every client reloads that engine. A warm-cache read never emits,
so the reload cannot loop.

### 3. The boot reconciliation is idempotent

Applying the configuration again changes nothing when nothing changed. pi's `setVendorApiKey` and
`feedOauthCredential` compare the entry they would write with `auth.json` as read at call time, never a remembered
copy (pi rotates its own tokens); an unchanged entry writes nothing and invalidates nothing, and `applyDefinition`
skips an unchanged `models.json` entry. pi's removal of an absent entry is a no-op. For opencode 2.x nothing is written
to `auth.json` and nothing is recycled; credentials go through `opencodeCredentialStore` (ADR-097 §5): a re-vend of an
unchanged key creates no new generation. `removeVendorAuth` is the explicit user Remove and deletes every credential row
opencode holds for the provider (ADR-044, `opencode.md`). Model-cache invalidation lives in the auth target and only on
a real change; the opencode adapter adds none. Equality reuses `deepEqual` (`src/shared/opencode-config-diff.ts`).

### 4. pi is ended through stdin, a signal only as a fallback

`PiRpcClient.dispose()` closes the child's stdin. pi finishes starting, sees EOF and shuts itself down, releasing its
`proper-lockfile` locks on `models-store.json` and `auth.json` and killing its own bash process tree. Only if the process
is still alive `PI_DISPOSE_GRACE_MS` (2 s) later does `killProcessTree` run; this is the same on Windows. Reason: pi
installs its SIGTERM handler only once RPC mode runs, so a SIGTERM during startup leaks a lock dir and every pi started
in the next 30 s blocks on it. `dispose()` stays synchronous and idempotent: pending requests reject at once, no events
are delivered after it but stdout keeps draining so pi's final flush cannot stall, `onExit` still fires on the real
exit, and `start()` after `dispose()` rejects rather than spawning an unowned pi. A pi may outlive `dispose()` by up to
2 s (callers key on `onExit`); the fallback timer is unref'd, so if the app quits within it and pi's shutdown hangs,
nothing force-kills that pi (the quit still closed its stdin). Rejected: keep SIGTERM and delete stale lock dirs first
(racy against a live pi, and deletes another program's state); raise the discovery timeout (hides the leak).
