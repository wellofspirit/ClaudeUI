# Follow-up — opencode engine-native config written to opencode's OWN files in place

> Kickoff spec. Agent: **Sonnet, `general-purpose`**. The main model (Opus) orchestrates, reviews every
> line, runs gates, and commits. **You (the implementer) must NOT:** commit, `git add`, branch,
> `bun install`/`bun add`/`bun remove`, or self-certify. Leave the working tree dirty for review; report
> every changed file + a one-line rationale, exact gate output, and any deviation. `jsonc-parser@3.3.1`
> is **already installed** (the orchestrator added it + ran `rebuild:native`) — just import it.

## 0. Why (the decision — do not relitigate)
Today ClaudeUI persists opencode's engine-native config in its **private** `~/.claude/ui/engines/opencode.json`
(`opencodeConfig`) and injects it **ephemerally** via the `OPENCODE_CONFIG_CONTENT` spawn env var. So a
user who launches `opencode` standalone sees **none** of it. This **violates the ADR-020 config-plane
principle** ("ClaudeUI keeps no private copy of config an engine consumes natively — it reads/writes the
engine's own files, incl. `opencode.json`; the narrow exception is launch params + hosted-MCP injection").
This phase moves the engine-native fields into opencode's **own global config file, edited in place**
(mirroring how `claude-settings.ts` edits `~/.claude/settings.json`). Claude already complies; this brings
opencode to parity.

**Scope of THIS phase:** `model`, `small_model`, `provider`, `disabled_providers`, `enabled_providers`,
**and `agent`** (model+temperature overrides) → opencode native config. `modelAllowlist` (a ClaudeUI-side
picker filter, never injected) and `autoMode` (ADR-023) **stay** ClaudeUI-private. The hosted-MCP
`mcp.claudeui` block **stays** ephemeral in `OPENCODE_CONFIG_CONTENT`. Permissions/skills are untouched
(separate planes). The full custom-agent CRUD UI is a LATER phase — here `agent` keeps its current
`{model?, temperature?}` shape.

## 1. Verified facts (grounded — file:line; do NOT re-discover)
- **opencode global config dir** (`vendor/opencode-src/packages/core/src/global.ts:13,26,64`): uses
  `xdg-basedir@5.1.0`. Effective dir = `process.env.OPENCODE_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME
  ?? path.join(os.homedir(), '.config'), 'opencode')` — **on all platforms** (xdg-basedir 5 does NOT special-case
  Windows; it's `XDG_CONFIG_HOME || ~/.config`).
- **File precedence** (`config/config.ts:258-260`): `config.json` < `opencode.json` < `opencode.jsonc`
  (later overrides earlier via mergeDeep). ⇒ to be authoritative we must write the **highest-precedence file
  that exists**: prefer `opencode.jsonc` if present, else `opencode.json`, else create `opencode.json`.
- **Agent + provider native shapes** (already implemented in the current injector — copy the transforms):
  `OpencodeServerManager.ts:108-139`. provider: `{id, name?, baseURL?, models?:{id,name?}[]}` → `provider[id] =
  { name?, options?:{baseURL?}, models?: Record<modelId,{name?}> }`. agent: `{model?, temperature?}` →
  `agent[name] = { model?, temperature? }` (omit unset).
- **Current persistence**: `loadEngineConfig('opencode')` / `saveEngineConfig('opencode', cfg)` (ui-config.ts:254-265,
  `engines/opencode.json`, full `EngineConfig`). `EngineConfig = { sandbox?, proxy?, autoMode?, opencodeConfig? }`
  (`shared/types.ts:354-361`). `OpencodeConfigSettings` (`shared/types.ts:288`) = `{ model?, smallModel?,
  disabledProviders?, enabledProviders?, providers?, agents?, modelAllowlist? }`.
- **Injector**: `buildOpencodeConfigContent(mcpPort, mcpToken, cfg?)` (`OpencodeServerManager.ts:103-165`) is the
  ONLY thing emitting these fields; called in `spawnServer` (`:188`); `cfg` sourced in `resolveHandle`
  (`:332` `loadEngineConfig('opencode').opencodeConfig`).
- **Readers of `opencodeConfig` (main)**: `model-discovery.ts:45` reads `.modelAllowlist` (STAYS private — leave
  untouched); `OpencodeServerManager.ts:332` (REMOVE). No other main-side readers.
- **Boot seed (renderer)**: `session-store.ts:312-318` `Promise.all([... loadEngineConfig('opencode') ...])` →
  `:362` `opencodeDefaultModel: opencodeEngineConfig?.opencodeConfig?.model || OPENCODE_DEFAULT_MODEL`.
- **Settings UI**: `settings-sections.tsx` — `OpencodeModelsSection` (model/smallModel), `OpencodeProvidersSection`
  (providers + modelAllowlist via `ModelAllowlistDialog`), `OpencodeAgentsSection` (agents). Each currently
  `loadEngineConfig('opencode')` + `saveEngineConfig('opencode', fullEngineConfig)`. `OpencodeAutoModeSection`
  manages `autoMode` the same way — **leave it on loadEngineConfig/saveEngineConfig**.
- **jsonc-parser@3.3.1** API: `import { parse, modify, applyEdits, type FormattingOptions } from 'jsonc-parser'`.
  `parse(text)` is comment/trailing-comma tolerant → JS value. `modify(text, jsonPath, value, { formattingOptions })`
  → `Edit[]`; `applyEdits(text, edits)` → new string (preserves comments/formatting elsewhere). Pass `value:
  undefined` to **delete** a key. Chain multiple edits: re-run `modify`+`applyEdits` per key on the updated text.

## 2. The work

### 2a. NEW `src/main/opencode/opencode-config.ts`
Owns opencode's native config file — read, comment-safe write, and the one-time migration. **Plain functions**
(no class). Use `node:fs`, `node:os`, `node:path`, and `jsonc-parser`.

- `opencodeConfigDir(): string` — env-aware resolution (see §1; honor `OPENCODE_CONFIG_DIR`, then
  `XDG_CONFIG_HOME`, then `~/.config`, `+ '/opencode'`).
- `resolveOpencodeConfigFile(): { path: string; existed: boolean }` — `opencode.jsonc` if it exists, else
  `opencode.json` if it exists, else `{ path: <dir>/opencode.json, existed: false }`.
- `readOpencodeNativeConfig(): Pick<OpencodeConfigSettings,'model'|'smallModel'|'providers'|'disabledProviders'|'enabledProviders'|'agents'>`
  — read+`parse` the resolved file (return `{}` if absent/unparseable); map native keys → ClaudeUI shape
  (**reverse** the provider transform: `provider[id].options.baseURL`→`baseURL`, `models` object→`{id,name?}[]`;
  `small_model`→`smallModel`, `disabled_providers`→`disabledProviders`, `enabled_providers`→`enabledProviders`).
- `writeOpencodeNativeConfig(fields: <same Pick>)` — comment-safe reconcile of the **six managed keys only**,
  leaving every other key in the file untouched:
  - base text = current file contents, or `'{}'` if it doesn't exist (ensure the dir exists via `fs.mkdirSync(..,{recursive:true})`).
  - for each managed native key: if the field is present & non-empty → `modify` to its mapped value; if
    absent/empty (`''`, `[]`, `{}`, or `undefined`) → `modify(..., undefined, ...)` to **delete** it (so removing
    a provider in the UI removes it from the file). Apply edits sequentially.
  - `formattingOptions: { insertSpaces: true, tabSize: 2 }` (detect `eol` from existing content, default `'\n'`).
  - write back to the **resolved path** (same file we read — never create a second file when `.jsonc` exists).
- `migrateOpencodeConfigToNative(): void` — one-time, **process-guarded** (module bool), idempotent:
  - read `loadEngineConfig('opencode').opencodeConfig`; collect the six native-bound fields. If none present, return.
  - read native; for each field **only if the native key is ABSENT** (non-clobber — respect hand-edits), include it
    in a `writeOpencodeNativeConfig` patch (merge with existing native values you keep).
  - then strip those six keys from the private config: `saveEngineConfig('opencode', { ...engineCfg, opencodeConfig:
    keepOnly(modelAllowlist) })` — **preserve `autoMode`, `sandbox`, `proxy`** and `modelAllowlist`. (If
    `opencodeConfig` ends up empty, set it `undefined`.)
  - Idempotency comes for free: after the first run the six keys are gone from the private file, so re-runs find
    nothing. The **installed-gate is applied by the caller** (§2b) — this fn assumes it should run.
  - Structure the field-mapping + strip as a **pure helper** (`(priv, existingNative) → { nativePatch, strippedPriv }`)
    so it's unit-testable without touching real files.

### 2b. IPC + preload
- `session.ipc.ts`: add `config:load-opencode-settings` and `config:save-opencode-settings` (use the existing
  `safeHandler` envelope pattern). Register the two channel strings wherever `config:load-engine-config` /
  `config:save-engine-config` are registered (same remote exposure — mirror them exactly, incl. any
  `SESSION_IPC_CHANNELS` / remote blocklist membership).
  - **load** handler: `if (opencodeServerManager.isBinaryAvailable()) migrateOpencodeConfigToNative()` (guarded
    once), then return a merged `OpencodeConfigSettings` = `{ ...readOpencodeNativeConfig(), modelAllowlist:
    loadEngineConfig('opencode').opencodeConfig?.modelAllowlist }`.
  - **save** handler `(settings: OpencodeConfigSettings)`: `writeOpencodeNativeConfig(settings)` for the six native
    fields; then route `modelAllowlist` to the private file — `loadEngineConfig('opencode')`, set
    `opencodeConfig.modelAllowlist` (drop it if empty), `saveEngineConfig` — **preserving `autoMode`/`sandbox`/`proxy`**.
- `preload/index.ts`: `loadOpencodeSettings: () => Promise<OpencodeConfigSettings>` and
  `saveOpencodeSettings: (settings: OpencodeConfigSettings) => Promise<void>` (unwrap like the neighbors). Add the
  matching signatures to the `ClaudeAPI` interface in `shared/types.ts`. Mirror in `web/api-adapter.ts` /
  `remote-handlers.ts` only if those mirror `loadEngineConfig` today (check — keep parity, don't add net-new
  remote surface beyond what engine-config has).

### 2c. `OpencodeServerManager.ts`
- `buildOpencodeConfigContent(mcpPort, mcpToken)` — **drop the `cfg` param**; return JSON with ONLY the
  `mcp.claudeui` block (delete all model/small_model/provider/disabled/enabled/agent logic).
- `SpawnServerFn` type + `spawnServer` — drop the `cfg` param.
- `resolveHandle` — delete the `loadEngineConfig('opencode').opencodeConfig` read (`:332`) and the `loadEngineConfig`
  import if now unused; pass nothing extra to `spawnFn`.

### 2d. Renderer boot seed (`session-store.ts`)
- In the boot `Promise.all` (`:312-318`), replace the `window.api.loadEngineConfig('opencode').catch(...)` entry with
  `window.api.loadOpencodeSettings().catch(() => ({}))`; rename the destructured var (e.g. `opencodeSettings`).
- `:362` → `opencodeDefaultModel: opencodeSettings?.model || OPENCODE_DEFAULT_MODEL`.

### 2e. Settings sections (`settings-sections.tsx`)
- `OpencodeModelsSection`, `OpencodeProvidersSection`, `OpencodeAgentsSection`: switch their load from
  `loadEngineConfig('opencode')`→`loadOpencodeSettings()` (the returned object IS the `OpencodeConfigSettings`;
  drop the `.opencodeConfig` indirection) and their save from `saveEngineConfig('opencode', fullEngineConfig)`→
  `saveOpencodeSettings(nextOpencodeConfig)`.
  - Keep `OpencodeModelsSection`'s store mirror (`setOpencodeDefaultModel(...)` + `reloadModels()`) on model change.
  - In `OpencodeProvidersSection`, the `ModelAllowlistDialog` `onSave` (`modelAllowlist`) now flows through
    `saveOpencodeSettings` too (the handler routes it to the private file). So this section saves a single merged
    `OpencodeConfigSettings` (providers + modelAllowlist) in one call.
- **Do NOT touch `OpencodeAutoModeSection`** (autoMode stays on loadEngineConfig/saveEngineConfig).
- Check `opencode-provider-manager` / `VendorOpencodeSection` and the two opencode-provider settings tests — if any
  reads/writes `opencodeConfig` via engine-config, re-point it the same way.

## 3. Tests (Vitest; focus on real bugs, not coverage)
- **`opencode-config.test.ts`** (NEW, node project): drive `OPENCODE_CONFIG_DIR` → a `fs.mkdtemp` tmp dir.
  - path resolution: `OPENCODE_CONFIG_DIR` wins; `XDG_CONFIG_HOME` next; `.jsonc` > `.json` > create-`.json`.
  - read maps native→ClaudeUI shape (provider object→array, `small_model`→`smallModel`, etc.).
  - write **sets** present fields and **deletes** emptied ones; **preserves comments + unrelated keys** (seed a
    `.jsonc` with a `// comment`, a `theme` key, and an `mcp` block; modify `model`; assert the comment, `theme`,
    and `mcp` survive byte-wise and `model` is updated).
  - migration pure-helper: maps private→nativePatch + strippedPriv; **non-clobber** (a native key already set is NOT
    overwritten); strip keeps `autoMode` + `modelAllowlist`.
- **`buildOpencodeConfigContent.test.ts`**: rewrite — now emits ONLY `{ mcp: { claudeui: {...port/token...} } }`;
  delete the model/provider/agent/clobber-safety cases. Update `OpencodeServerManager.test.ts` fake `spawnFn` to the
  new (no-`cfg`) signature.
- **IPC**: load returns merged native+modelAllowlist and triggers migration once (when installed); save writes native
  six fields and routes modelAllowlist to the private file while **preserving autoMode**.
- **Section tests**: model select → `saveOpencodeSettings({..., model})`; provider add; agent add — assert the new
  IPC is called (mock `window.api.loadOpencodeSettings/saveOpencodeSettings`). Fix any existing opencode section/
  provider-manager tests that mocked `loadEngineConfig/saveEngineConfig`.

## 4. Verify gates (report EXACT output, do not commit)
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
0 lint errors (3 pre-existing exhaustive-deps warnings OK). **No `bun install`.** Leave the tree dirty; list every
changed file + one-line rationale + any deviation. Do NOT app-shot (the orchestrator drives the real app).
If you make throwaway probe scripts, put them in a temp dir or `rm` them — never leave files in `scripts/`.

## 5. Gotchas
- **Write the file you read** — if `opencode.jsonc` exists, edit IT (don't create `opencode.json`, which opencode
  would shadow since `.jsonc` wins). Comment-safe via `jsonc-parser` `modify`/`applyEdits`, never `JSON.stringify`
  the whole file (that nukes comments).
- **Reconcile, don't replace** — touch only the six managed keys; every other key (theme, keybinds, permission,
  mcp, plugins, the user's own agents) must be byte-preserved. Deleting an emptied managed key is intended
  (UI is the source of truth for those six when set).
- **Migration: non-clobber + preserve siblings** — only fill native keys that are absent; when stripping the
  private file, keep `autoMode`/`sandbox`/`proxy`/`modelAllowlist`. Gate the migration on
  `opencodeServerManager.isBinaryAvailable()` (caller side) — never create opencode config files if opencode isn't
  installed. Reading when not installed must be harmless (return `{}`, create nothing).
- **`modelAllowlist` stays private** — never write it to the native file; it's a ClaudeUI picker filter opencode
  doesn't understand.
- **`buildOpencodeConfigContent` is now mcp-only** — and `resolveHandle` no longer reads engine config. Double-check
  no integration test (`opencode-server.integration.test.ts`, `opencode-mcp.integration.test.ts`) passes `cfg`.
- **Precedence note (expected, not a bug)** — native global config is LOWER precedence than the user's *project*
  `opencode.json`; that's the correct user-defaults semantic. Don't try to "fix" it back to env-injection.
- **Don't touch** permissions (`permission-compiler.ts`/`applyPermissionMode`), skills, or Claude paths.
