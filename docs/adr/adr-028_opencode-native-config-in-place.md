# ADR-028: opencode engine-native config written to opencode's own files in place

**Status:** Accepted
**Date:** 2026-06-29
**Implements:** [ADR-020](adr-020_v2-persistence-and-config-plane.md) (config-plane principle)
**Relates to:** [ADR-018](adr-018_v2-engine-vendor-account-model.md), [ADR-019](adr-019_opencode-engine-backend.md), [ADR-022](adr-022_opencode-permission-mapping.md), [ADR-024](adr-024_opencode-interaction-parity.md)

## Context

ADR-020's config-plane principle says ClaudeUI keeps **no private copy** of config an engine
consumes natively — it reads/writes the engine's own files (`settings.json`/`.mcp.json`,
**`opencode.json`**), with a narrow exception for **launch params** (proxy/endpoint/sandbox and
**hosted-MCP injection**) applied at spawn. Claude complies (`claude-settings.ts` edits
`~/.claude/settings.json` in place).

The opencode implementation had **drifted** from this: *all* opencode config — `model`,
`small_model`, providers, disabled/enabled providers, and the agent model/temperature overrides —
was stored in ClaudeUI's **private** `~/.claude/ui/engines/opencode.json` and injected
**ephemerally** via the `OPENCODE_CONFIG_CONTENT` spawn env var (a shortcut taken in the V2
opencode-settings follow-up). A user launching `opencode` standalone saw **none** of it.

The drift had a real cause worth naming: the **same `OPENCODE_CONFIG_CONTENT` channel legitimately
exists** for config that is genuinely neutral and/or dynamic — the hosted-MCP block (dynamic per-spawn
port + bearer token) and, via the session API, the compiled permission ruleset (ADR-022). Engine-native
user config got swept into that channel by convenience, even though it is neither neutral nor dynamic.

## Decision

**Classify every piece of config by ownership, not by engine, and persist accordingly:**

- **Engine-native config** (the engine owns it; no cross-engine meaning) → **written to the engine's
  own files, in place.** For opencode: `model`, `small_model`, `provider`, `disabled_providers`,
  `enabled_providers`, and `agent` overrides → opencode's **global config file**.
- **Neutral / dynamic config** (ClaudeUI owns it as one concept across engines; or changes per-session) →
  ClaudeUI-owned, **applied at runtime, never persisted into the engine's files.** Permissions/autonomy
  (Claude store is the single source, compiled per-engine — ADR-022, applied via `PATCH /session` for
  opencode) and the hosted-MCP `mcp.claudeui` block (dynamic port/token, `OPENCODE_CONFIG_CONTENT`).
  Standalone visibility is intentionally sacrificed — the config is not the engine's to own.
- **Skills** need no bridge: opencode natively scans `.claude/skills/**/SKILL.md`, so both engines read
  the same on-disk source.

**Concrete opencode mechanics** (`src/core/opencode/opencode-config.ts`, mirroring `claude-settings.ts`):

- **Target file** = opencode's global config dir, resolved exactly as opencode does
  (`OPENCODE_CONFIG_DIR` → `XDG_CONFIG_HOME` → `~/.config`, `+ /opencode`; all platforms). Write the
  **highest-precedence file that exists** — `opencode.jsonc` if present, else `opencode.json`, else
  create `opencode.json` (precedence is `config.json < opencode.json < opencode.jsonc`).
- **Comment-safe in-place edits** via `jsonc-parser` (`modify`/`applyEdits`): reconcile **only** the six
  managed keys (set when present, delete when emptied), leaving every other key (theme, keybinds, `mcp`,
  permissions, the user's own agents) and all comments byte-preserved.
- `modelAllowlist` (a ClaudeUI model-picker filter opencode doesn't understand) and `autoMode` (ADR-023)
  **stay ClaudeUI-private** in `engines/opencode.json`.
- `buildOpencodeConfigContent` now emits **only** the ephemeral `mcp.claudeui` block.
- **One-time, non-clobbering migration** moves the six fields from the private file into opencode's
  config (only where the native key is absent — respects hand-edits), then strips them from the private
  file. Idempotent; gated on opencode being installed.

## Consequences

- A standalone `opencode` launch now sees ClaudeUI-configured model/providers/agent overrides.
- **Precedence flips** (intended): opencode's global config is *lower* precedence than the user's
  **project** `opencode.json`, which now wins over ClaudeUI's defaults — the correct user-defaults
  semantic, vs the prior "env injection always wins."
- ClaudeUI now **writes the user's opencode config file** (merge-only, comment-safe, installed-gated) —
  on first launch (migration) and on each settings change. This is a deliberate, ADR-020-sanctioned
  write to an engine-owned file, not a private copy.
- The custom-agent **CRUD** feature (full agents as markdown files under `agents/`, scope toggle,
  AI-generation) builds on this mechanism and is deferred to its own ADR. Bridging the user's
  configured **MCP servers** (`.mcp.json` → opencode's `mcp` key) is a neutral-layer extension, also
  separate. A known latent issue — settings sections each save a full snapshot, allowing cross-section
  clobber within one dialog session — predates this change and is tracked for a follow-up.

## Relation to existing ADRs

- **Implements ADR-020** — realizes its config-plane principle for opencode and corrects the
  `followup-opencode-settings.md` all-ephemeral shortcut (a kickoff-spec decision, not an ADR).
- **Relates to ADR-022/024** — clarifies why permissions (compiled, per-session) and skills (shared
  `.claude` dir) correctly stay on the runtime/native-shared planes rather than being mirrored here.
