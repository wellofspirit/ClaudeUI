# Phase 3b — Config-plane refactor + SettingsDialog re-IA

> Second half of Phase 3 (3a stood up the DB). Implements [03-settings-config.md](03-settings-config.md):
> split the flat settings monolith into **tiers** (App/Engine/Vendor/Session) and **planes**
> (① app-store / ② engine-native files / ③ launch-params), re-IA the SettingsDialog, add neutral
> autonomy modes. **User chose: FULL storage restructure + vendor display-only (§8.5).**

## Scope decisions (chosen — do exactly this)

1. **FULL storage restructure** — split `AppSettings` (`~/.claude/ui/settings.json`) by tier/plane
   into separate stores (below). Not a UI-only re-label.
2. **Vendor endpoint/modelOverride = display-only** (03 §8.5) — the new Vendors › Anthropic section
   shows current values **read-only**; the editable forms are removed. Values migrate to the per-vendor
   store and **still apply at spawn**; users change them by hand-editing the file until full vendor
   editing ships. (This is a deliberate, accepted regression of the current edit form.)
3. **Behavior otherwise preserved** — every setting must still take effect (esp. sandbox/proxy/endpoint/
   modelOverride at spawn). The risk of this phase is a launch param silently not applying after the move.

## Storage model (planes)

| Store (file) | Plane | Holds |
| --- | --- | --- |
| `~/.claude/ui/settings.json` (existing app store) | ① | APP-tier: theme, fonts, diff, layout/chat-width, status line, git panel, mermaid, mockup CSP, **logLevel/logFilter/usageRefreshSecs/analyticsRefreshSecs** (reclassified APP), remoteFollowActions; SESSION-tier app-consumed: sessionTimeoutMins, voiceEnabled/voiceLanguage, modelEffortDefaults. **REMOVE** sandbox/proxy/anthropicEndpoint/modelOverride from here. |
| `~/.claude/ui/engines/<engineId>.json` (new, per-engine launch store) | ③ | ENGINE launch params: `{ sandbox, proxy }` (e.g. `engines/claude.json`). |
| `~/.claude/ui/vendors/<vendorId>.json` (new, per-vendor store) | ③ | VENDOR launch params: `{ endpoint, modelOverride }` (e.g. `vendors/anthropic.json`). |
| Claude `settings.json` / `.mcp.json` (engine-native, ADR-009) | ② | permissions (allow/deny/ask + defaultMode), MCP user servers, cleanupPeriodDays — **already** edited in place via `claude-settings.ts`/`claude-mcp.ts`. Formalize: ClaudeUI keeps no private copy (it already doesn't). |

**Migration (read-time, one-time):** on load, if `settings.json` still has `sandbox`/`proxy` → write to
`engines/claude.json` and delete from settings.json; `anthropicEndpoint`/`modelOverride` → write to
`vendors/anthropic.json` and delete. Idempotent (skip if target exists). Keep settings.json otherwise.

## Spawn rewiring (the behavior-critical part)

Today `session.ipc.ts` (~line 729) reads `settings.sandbox/proxy/anthropicEndpoint/modelOverride` from
the flat store and applies them (`sandboxConfig`, `applyProxyEnv`, `applyEndpointEnv`, `applyModelEnv`).
Rewire to read from the new stores:
- `sandbox`, `proxy` ← `engines/claude.json` (the session's engineId).
- `anthropicEndpoint`, `modelOverride` ← `vendors/anthropic.json` (the current model's vendorId).
- The `sdk/{endpoint-env,model-env,proxy}.ts` consumers are unchanged — only the SOURCE of the values
  changes. **Verify the env still gets set identically** (a test + the smoke).

New `ui-config` API: `loadEngineConfig(engineId)`/`saveEngineConfig(engineId, cfg)`,
`loadVendorConfig(vendorId)`/`saveVendorConfig(vendorId, cfg)` + IPC + preload + web-adapter + the
renderer settings reads/writes. (Vendor save is internal/migration-only in v1 since the UI is display-only.)

## SettingsDialog re-IA

Reorganize the flat `SECTIONS` (appearance, chat, session, diff, git, usage, logging, voice, remote,
permissions, accounts, mockup, sandbox, proxy) into the tier tree (capability-gated; Engines/Vendors
populated from installed engines + their vendors — just Claude/Anthropic now):

```
Settings
├── App         appearance, chat, diff, git, status line, usage, logging, mockups, remote, (voice, session timeout)
├── Engines
│   └── Claude  permissions (neutral autonomy modes + advanced rules), sandbox, proxy, MCP, cleanup
├── Vendors
│   └── Anthropic   endpoint (display-only), model override (display-only), effort defaults
└── Accounts    (existing accounts section)
```

- Keep the existing search-filter behavior across the new tree.
- Each engine/vendor branch is **capability-gated** (foundation 2): only render an engine if installed;
  gate sandbox on the engine's sandbox capability, MCP on `canUseMcp`, skills (if present) on `skills`, etc.
- Reuse the existing section render functions; this is mostly re-grouping + new nav, not rewriting each control.

## Neutral autonomy modes (03 §4)

- ClaudeUI owns the labels; internal ids `'plan'|'ask'|'autoEdit'|'full'` (`AutonomyMode`, already in
  `model-capabilities.ts` from Phase 2 as `EngineCapabilities.autonomyModes`).
- Map AutonomyMode ↔ Claude permission mode: `plan↔plan`, `ask↔default`, `autoEdit↔acceptEdits`,
  `full↔auto`/bypass. Surface the neutral labels in the permissions section + the in-session mode
  picker; available set gated by `capabilities.autonomyModes` (Claude exposes all four).
- This generalizes the mode picker so opencode (Phase 5, `[plan,ask,full]`) drops in.

## Step-by-step

1. **Branch** `v2-phase-3b-config-plane` (already created off 3a). Don't commit; leave for review.
2. New stores + `ui-config` API (engines/<id>.json, vendors/<id>.json) + migration from settings.json.
3. Rewire spawn (session.ipc.ts) + any other reader to source launch params from the new stores.
4. `AppSettings`/`UISettings` type: remove the moved fields; add the new config types/IPC.
5. SettingsDialog re-IA into the tier tree (capability-gated) + neutral autonomy modes + vendor display-only.
6. Tests: migration (settings.json → engine/vendor stores, idempotent); spawn still applies sandbox/proxy/
   endpoint/modelOverride (env set identically); autonomy-mode mapping; the settings UI renders each tier.
7. **CLAUDE.md** (deferred from 3a + this): the operational DB (3a), the persistence split, the config-plane
   model (planes ①②③), the new SettingsDialog IA. Update the structure tree + settings notes.
8. Sweep: no reader still pulls sandbox/proxy/endpoint/modelOverride from the flat `settings.*`.

## Verify

```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
**Runtime smoke (verifier-electron) — drive the new Settings IA:** open Settings, screenshot each branch
(App, Engines › Claude, Vendors › Anthropic, Accounts); confirm the tree renders, sections are reachable,
the Vendors fields are read-only, and the autonomy-mode picker shows the neutral labels. **Critically**,
confirm a launch param still applies — e.g. set a proxy/sandbox value in `engines/claude.json` and verify
it reaches the spawn (or assert via a test that the env is set from the new store). Read the screenshots.

## Gotchas

- **Launch params must still apply.** The #1 risk: after moving sandbox/proxy/endpoint/modelOverride to
  the new stores, the spawn reads the old empty `settings.*` → they silently stop working. Test the spawn
  path reads the new stores; smoke a proxy/sandbox value.
- **Migration is one-time + idempotent.** Don't re-migrate over user edits to the new stores.
- **Vendor display-only** = remove the edit form, keep the value display + the at-spawn application.
- **Capability-gating** the settings tree uses Phase-2 `ResolvedCapabilities`/`EngineCapabilities` — for
  Claude everything shows.
- **DB note:** session metadata is already DB-backed (3a). 3b does NOT move settings into the DB —
  config stays in plain-text files (persistence.md). Only the *operational* data is in the DB.

## Commit
Branch off `v2-phase-3a-db-substrate`; no AI attribution. Suggested:
`refactor(v2): config-plane (tier/plane split) + SettingsDialog re-IA (Phase 3b)`.
