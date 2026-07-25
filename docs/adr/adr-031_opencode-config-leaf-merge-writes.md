# ADR-031: opencode config writes are diff-driven leaf merges, never subtree replacements

**Status:** Accepted
**Date:** 2026-07-07
**Refines:** [ADR-028](adr-028_opencode-native-config-in-place.md) (stays Accepted — this narrows *how* the in-place write reconciles)
**Relates to:** [ADR-020](adr-020_v2-persistence-and-config-plane.md), [ADR-019](adr-019_opencode-engine-backend.md), [ADR-029](adr-029_opencode-custom-agent-crud.md)

## Context

ADR-028 established that ClaudeUI writes opencode's six engine-native keys (`model`,
`small_model`, `disabled_providers`, `enabled_providers`, `provider`, `agent`) **in place** into
the user's own `~/.config/opencode/opencode.{jsonc,json}`, comment-safe via `jsonc-parser`. It said
"reconcile only the six managed keys (set when present, delete when emptied)" — and the first
implementation took that literally: `writeOpencodeNativeConfig()` wholesale-**replaced** each of the
six keys with a value rebuilt from ClaudeUI's in-memory projection `NativeOpencodeFields`.

That projection is **lossy**. It models only `{name?, baseURL?, models: {id, name?}[]}` per provider
and `{model?, temperature?}` per agent. opencode's own config schema (ConfigV1) is far richer:
model-level `attachment`, `modalities`, `tool_call`, `cost`, `limit`, `reasoning`; provider-level
`npm`, `options.apiKey`, other `options.*`; arbitrary agent-entry fields (`prompt`, `mode`,
`permission`). Any of these that a user hand-adds is **invisible** to the projection — so a
subtree-replacing write silently deleted them.

Real-world repro: a user hand-adds `"qwen3.6:27b": { "attachment": true }` to a custom provider to
enable image input. The very next save from the settings UI (even one that only renamed the
provider's display label) rebuilt the whole `provider` object from the projection and wiped
`attachment` — image input silently broke. This is a round-trip clobber: read (lossy) → edit → write
(full-replace) destroys everything the read dropped.

opencode itself avoids exactly this: its `Config.updateGlobal` uses `jsonc-parser` `modify()` **leaf**
patches on `.jsonc` files. Leaf-merge is the engine's own write discipline; ClaudeUI diverged from it.

## Decision

**Writes are diff-driven leaf merges. ClaudeUI touches only the keys it models AND that actually
changed, and never deletes a key it does not model.**

`writeOpencodeNativeConfig(fields)` keeps its signature and its read/write symmetry with
`readOpencodeNativeConfig()` (same resolved file, jsonc-first precedence). New algorithm:

1. Read the current file text and project it to `NativeOpencodeFields` through the **same** mapping
   the reader uses (`projectNativeToFields`, now the single source of the read projection).
2. Diff incoming `fields` against that projection and emit `jsonc-parser` `modify()` edits **only for
   changed leaves**:
   - `model` / `small_model` — set when changed; delete when emptied and currently present.
   - `disabled_providers` / `enabled_providers` — atomic arrays; replace when different, delete when
     emptied.
   - `provider`, per id: **added** → set `['provider', id]` to the native shape; **removed** → delete
     `['provider', id]` (the whole subtree — a removed provider IS user intent); **kept** → per-field
     leaf edits only: `name`, `['provider', id, 'options', 'baseURL']` (never the whole `options`
     object, so sibling `apiKey` survives), and per model id `['provider', id, 'models', modelId]`
     (add/remove) touching only `…, 'name'` when the display name changed. `npm`, `options.apiKey`,
     and every unmodelled model field (`attachment`, `modalities`, `tool_call`, `cost`, `limit`, …)
     are never referenced.
   - `agent`, per name: same pattern — leaf-edit `model` / `temperature` only; unknown entry fields
     (`prompt`, `mode`, `permission`, …) preserved; delete `['agent', name]` only when the name
     disappears from incoming.
3. **No-op save = zero edits.** The result is only written when it differs byte-for-byte from the
   original. EOL detection, 2-space formatting, and `mkdir` behavior are unchanged.

**Diff-base caveat (preserved):** the projection is computed from the same file we write. A provider
declared only in the *other* global file (json vs jsonc split — see `readDeclaredProviderIds`) is
invisible to both the projection and the UI's incoming set, so it appears in neither side of the diff
and is therefore never deleted.

**Single-writer ownership of opencode.json top-level keys** (who is allowed to write each):

| Key(s)                                                                                   | Owner / mechanism                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `model`, `small_model`, `disabled_providers`, `enabled_providers`, `provider`, `agent`   | **This writer** — diff-driven leaf merges (settings UI + migration)   |
| `mcp.claudeui`                                                                            | Ephemeral `OPENCODE_CONFIG_CONTENT` at spawn (ADR-028) — never persisted |
| agent markdown files (`agent/*.md`, full agent definitions)                              | Agent CRUD (ADR-029)                                                  |
| Everything else (`theme`, `keybinds`, `permission`, user `mcp.*`, comments, …)           | **User-owned — ClaudeUI never writes it**                             |

## Consequences

- Hand-edited opencode config is **durable** across ClaudeUI saves. The qwen `attachment` repro is
  fixed; `apiKey`, `npm`, agent `prompt`, and all model capability fields survive UI edits.
- A no-op save is a true no-op (no rewrite, no reformat churn, no comment reflow).
- The migration path (`migrateOpencodeConfigToNative` → `computeMigrationPatch` writes
  `{...existingNative, ...additions}`) now diffs to **pure additions** for already-present keys, so it
  can no longer clobber hand-edits it re-reads through the lossy projection.
- Groundwork for the **schema-driven settings editor**: once the UI can edit raw opencode fields
  (attachment, modalities, cost, …), it writes them through this same leaf-merge writer — the diff
  discipline scales to any modelled key without special-casing.

## Relation to existing ADRs

- **Refines ADR-028** — ADR-028 stays Accepted; it decided *where* opencode config is written (the
  engine's own files, comment-safe). ADR-031 narrows *how* the reconcile happens (per-leaf diff, never
  subtree replacement) to honor ADR-028's own "leaves every other key byte-preserved" promise for
  fields ClaudeUI doesn't model.
