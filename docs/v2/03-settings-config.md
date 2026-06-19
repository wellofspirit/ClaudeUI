# Foundation 3 — Settings & Config

> **Status: DRAFT for discussion.** Re-scopes today's Claude-shaped settings monolith into
> tiers (app / engine / vendor / session) and, crucially, assigns each setting a **config
> plane** (who stores and consumes it). Builds on [01-data-model.md](01-data-model.md),
> [02-capability-model.md](02-capability-model.md) (capabilities gate which sections appear),
> and [persistence.md](persistence.md) (config = files). Grounded in a full code inventory of
> the current surface (see discussion); this doc is the design on top.

## 1. Current state

Settings are split across three stores today, with **tiers mixed together** in each:

- **`~/.claude/ui/settings.json`** (the flat `AppSettings` object, ~40 fields) — holds cosmetic
  UI *and* engine-behavior *and* vendor *and* session settings, undifferentiated.
- **Claude's own `settings.json`** (user/project/local scopes) + **`.mcp.json`** — permissions,
  MCP servers, cleanup period. cli.js reads these directly (ADR-009).
- **`~/.claude/ui/sessions.json`** (`UISessionConfig`) — sidebar/session state.

Plus a category that lives in *no* file: settings ClaudeUI turns into **spawn env vars / flags**
when it launches cli.js — `proxy`, `anthropicEndpoint`, `modelOverride`, `sandbox`. These are
ClaudeUI's launch decisions, not shared with the standalone `claude` CLI.

The problem: every engine-behavior knob is named, shaped, and applied for cli.js specifically
(`ANTHROPIC_*` env, Seatbelt/bwrap sandbox, Claude tool-name permission rules).

## 2. Two orthogonal axes

Every setting answers **two** questions in V2, not one:

**Axis A — tier (who it conceptually belongs to):**

| Tier | What | Examples |
| --- | --- | --- |
| **APP** | Cosmetic + ClaudeUI's *own* behavior | theme, fonts, layout, diff view, status line, **logging, refresh intervals, mockup CSP** |
| **ENGINE** | The agent harness's behavior | sandbox, proxy, permissions, MCP, custom endpoint, cleanup |
| **VENDOR** | The model-maker | per-vendor endpoint/keys, model aliasing, per-model effort defaults |
| **SESSION** | Per-session runtime | current model, autonomy mode, effort, idle timeout |

**Axis B — config plane (who stores and consumes it):**

| Plane | Stored where | Consumed by | This is the ADR-009 question, generalized |
| --- | --- | --- | --- |
| **① App store** | ClaudeUI's app settings file | ClaudeUI only | cosmetic + ClaudeUI behavior |
| **② Engine-native config** | the engine's own files (Claude `settings.json`/`.mcp.json`; opencode `opencode.json`) | the engine **and** its standalone CLI | ClaudeUI is just an *editor*; shared, hand-editable |
| **③ Launch params** | ClaudeUI's per-engine store | the engine, applied by ClaudeUI at spawn (env/flags/injected config) | ClaudeUI-specific launch decisions, **not** shared with the standalone CLI |

The **core principle (generalized ADR-009):** *ClaudeUI keeps no private copy of config the
engine consumes natively — it reads/writes the engine's own files (plane ②).* ClaudeUI's app
store (plane ①) holds only what ClaudeUI itself consumes. Plane ③ is the narrow exception:
launch-time overrides that are inherently ClaudeUI's decision (proxy routing, custom endpoint,
our hosted MCP injection).

## 3. Re-scoping the current settings → (tier, plane)

Highlights (full field list in the inventory). The interesting moves:

| Setting(s) today | V2 tier | V2 plane | Note |
| --- | --- | --- | --- |
| theme, fonts, diff, layout, status line, chat width, mockup CSP | APP | ① | unchanged in spirit |
| **logLevel, logFilter, usageRefreshSecs, analyticsRefreshSecs** | **APP** | ① | **reclassified** — these control ClaudeUI, not the engine; they were mis-shelved as engine concerns |
| permissions (allow/deny/ask, modes), cleanupPeriodDays | ENGINE | ② | Claude: `settings.json`. opencode: `opencode.json` `permission`. ClaudeUI edits the native file |
| MCP servers | ENGINE | ② (+③ for our hosted servers) | user servers → native config file; mermaid/mockup → injected at spawn |
| sandbox.* | ENGINE | ③ | cli.js launch config; capability-gated (opencode has its own sandbox model) |
| proxy.* | ENGINE | ③ | applied as env at spawn; `proxySubprocesses` is cli.js-specific |
| anthropicEndpoint.* | **VENDOR** | ③ | generalizes to **per-vendor endpoint** config (anthropic / openai / …) |
| modelOverride.* (`ANTHROPIC_*` aliases) | **VENDOR** | ③ | Anthropic-specific today; per-vendor model aliasing in V2 |
| modelEffortDefaults | VENDOR | ① or session | per-model default reasoning; structure generic, keys are model-specific |
| sessionTimeoutMins, voice*, current model/mode/effort | SESSION | ① / runtime (DB) | voice gated on engine capability (02) |
| sessionProviders map | SESSION | DB | becomes per-session `{engineId, model}` (01 §7), moves to the operational DB |

**Engine/vendor settings only render for installed engines + capable models** — the settings
UI is itself capability-gated (foundation 2). A Claude-only install shows no opencode section;
a session on a no-sandbox engine hides the sandbox panel.

## 4. Permissions — the thorny one

The permission *model* is engine-specific and cannot be one shared schema:

- **Claude**: `allow`/`deny`/`ask` lists of tool-name patterns + `defaultMode`
  (`default`/`acceptEdits`/`plan`/`auto`/`localAuto`), in `settings.json` (ADR-009).
- **opencode**: per-tool glob rulesets (`allow`/`ask`/`deny`) + `build`/`plan` agents, in
  `opencode.json`.

Design: a **neutral autonomy mode** the UI presents uniformly, mapped to each engine's native
config; plus an **engine-specific advanced rules editor** for the raw rules. Two rules govern it:

- **ClaudeUI owns the display labels** — engine-agnostic, plain-language. Internal IDs are
  `'plan' | 'ask' | 'autoEdit' | 'full'` (`AutonomyMode`); the user-facing labels are ours to
  tune, decoupled from any engine's raw term (`untrusted`, `acceptEdits`, …).
- **The available set is engine-gated** via `EngineCapabilities.autonomyModes` (02 §3.1) — not
  every engine exposes every mode.

| AutonomyMode (id) | Claude | opencode |
| --- | --- | --- |
| `plan` (Read-only / Plan) | `plan` mode | `plan` agent (read-mostly) |
| `ask` | `default` (+ ask rules) | `build` + tools = `ask` |
| `autoEdit` | `acceptEdits` | **not exposed in v1** — opencode has no auto-accept-edit mode (verify vs its permission config) |
| `full` | `auto`/`bypassPermissions` | `build` + `*` `allow` |

So opencode exposes `[plan, ask, full]` in v1; Claude exposes all four. The neutral mode is the
per-session control (SESSION tier); the raw rules are ENGINE/plane ②. This is the clean version
of the mapping the (now-removed) Codex backend got wrong.

## 5. MCP, skills, slash commands

All engine-scoped config, capability-gated (foundation 2):

- **MCP** — user servers live in the engine's native config (plane ②: `.mcp.json` /
  `opencode.json` `mcp`); ClaudeUI's **hosted** servers (mermaid/mockup) are injected at spawn
  (plane ③: cli.js MCP config / opencode `OPENCODE_CONFIG_CONTENT`). Gated on
  `hostedMcp && toolCalling`.
- **Skills** — Claude-only concept (`SKILL.md`); gated on `capabilities.skills`. Hidden for
  engines without it (opencode has commands/agents instead).
- **Slash commands** — engine-specific command sets; the menu is sourced per engine.

## 6. SettingsDialog IA redesign

Reorganize the dialog from a flat section list into the tier model:

```
Settings
├── App            (plane ①: appearance, chat, diff, status line, logging, usage refresh, mockups)
├── Engines
│   ├── Claude     (permissions/modes, sandbox, proxy, MCP, cleanup, custom endpoint)
│   └── opencode   (permissions, MCP, …)            ← only if installed
├── Vendors                                          ← only for multi-vendor engines
│   ├── Anthropic  (endpoint, model aliasing, effort defaults)
│   └── OpenAI     (…)
└── Accounts       (foundation 4)
```

Engine and Vendor branches are populated from installed engines + their exposed vendors, each
section capability-gated. App tier is always present and engine-agnostic.

## 7. Migration

- Split the flat `AppSettings`: APP-tier fields stay in the app store; ENGINE/VENDOR launch
  params (plane ③) move to a per-engine sub-store; engine-native settings (plane ②) are read
  from / written to the engine's own files (no migration — they already live there for Claude).
- `sessionProviders` → per-session metadata in the DB (01 §7).
- The reclassified APP-tier fields (logging, refresh) need no move (already in the app store) —
  just re-labeled in the UI.

## 8. Decisions

1. **Config-plane principle** ✓ — engine-native config stays in the engine's own JSON files
   (`settings.json`/`.mcp.json`, `opencode.json`); ClaudeUI surfaces and edits them through the UI
   but keeps **no separate copy**. Plane ③ (launch params) is the narrow ClaudeUI-only exception.
2. **Settings IA** ✓ — App / Engines / Vendors / Accounts; engine+vendor branches gated to what's
   installed + capabilities (§6).
3. **Neutral autonomy modes** ✓ — ClaudeUI owns the display labels; the available set is
   engine-gated via `EngineCapabilities.autonomyModes`. opencode exposes `[plan, ask, full]`
   (no `autoEdit`); Claude all four (§4).
4. **Reclassification** ✓ — `logLevel`/`logFilter`/`usageRefreshSecs`/`analyticsRefreshSecs` →
   APP tier; `anthropicEndpoint`/`modelOverride` → VENDOR tier.
5. **Vendor endpoint editing** ✓ — **display-only in v1** (surface vendor endpoint/config
   read-only); full per-vendor editing is a future release.
