# ADR-009: Store cli.js-consumed settings in Claude's settings.json, not UISettings

**Status:** Accepted
**Date:** 2026-06-03

## Context

ClaudeUI has two distinct settings stores:

- **UISettings** — ClaudeUI's own config under `~/.claude/ui/`, read/written via
  `ui-config.ts` and the `config:load-settings` / `config:save-settings` IPC
  channels. Surfaced in the renderer as the Zustand `AppSettings` slice and
  edited through `SettingsDialog` via `(settings, updateSettings)`.
- **Claude Code's settings.json** — `~/.claude/settings.json` (+ project/local
  scopes), the file the bundled `cli.js` itself reads. ClaudeUI touches this
  today only for permission rules, via `claude-settings.ts` and the
  `claude:load-permissions` / `claude:save-permissions` channels.

The trigger was adding a UI toggle for `cleanupPeriodDays` — the transcript
retention window that drives Claude Code's startup cleanup sweep (`rs()` →
`FkO()` in `cli.js`, default 30 days). The sweep deletes `~/.claude/projects/**`
transcripts older than the window. The question: which store does this setting
belong in?

A tempting precedent is `sandbox`, which **is** mirrored into UISettings
(`s.sandbox`) and edited through the normal `updateSettings` flow. But sandbox
is a special case: it is never written to `settings.json` at all — ClaudeUI
passes it to `cli.js` as a **per-spawn inline overlay** in
`claude-session.ts` (the `sandbox: {...}` block on the `sdkQuery` options).
That overlay only affects ClaudeUI-spawned sessions and is reconstructed on
every spawn.

`cleanupPeriodDays` is different. The cleanup sweep runs on `cli.js` process
startup and reads its value from the merged settings sources — and ClaudeUI
already spawns `cli.js` with `settingSources: ['user', 'project', 'local']`.
The same `~/.claude/settings.json` is also read by the user's **native** CLI.
So the value has exactly one correct home.

## Decision

**Settings whose behavior is implemented inside `cli.js` (i.e. that `cli.js`
reads via `settingSources`) are stored in `~/.claude/settings.json` and
read/written through `claude-settings.ts` — never mirrored into UISettings.**

Concretely for `cleanupPeriodDays`:

- `claude-settings.ts` gains `loadCleanupPeriodDays()` / `saveCleanupPeriodDays()`,
  mirroring the existing permissions helpers (preserve other top-level keys,
  write mode `0o600`, clamp to the upstream-valid integer ≥ 1).
- IPC channels `claude:get-cleanup-period` / `claude:set-cleanup-period`
  (desktop in `session.ipc.ts`, remote in `remote-handlers.ts`), exposed on
  `ClaudeAPI` via preload + the web `api-adapter.ts`.
- The `SettingsDialog` control (`ChatRetentionSetting`) is **self-contained**:
  it manages its own state via `window.api`, rather than going through the
  `(settings, updateSettings)` UISettings flow — because the value does not
  live in `AppSettings`.

UISettings remains the home for purely cosmetic/behavioral ClaudeUI state that
`cli.js` has no knowledge of (theme, fonts, diff view, terminal grouping, etc.).

## Consequences

- **Single source of truth.** Both the native CLI and ClaudeUI honor the same
  value; no UISettings↔settings.json divergence to reconcile.
- **No new mirroring/sync code.** We reuse the permissions plumbing pattern
  verbatim, so the surface area is two helpers + two channels per setting.
- **`set` hot-reloads running sessions** via `session.notifySettingsChanged()`
  (empty `apply_flag_settings({})`), matching the permissions-save behavior.
  The cleanup _sweep_ itself still only fires on `cli.js` startup (throttled to
  once / 24h via `.last-cleanup`), so a changed retention takes effect on the
  next launch — acceptable and non-surprising.
- **Auto-delete OFF writes `3650` (≈ 10 years), not `0`.** Upstream marks
  `cleanupPeriodDays: 0` as schema-invalid (min 1) and steers users toward a
  large window or `--no-session-persistence`. `0` _would_ disable the sweep
  (cli.js's `pkO()` gate skips cleanup when an explicitly-set value carries a
  validation error), but at the cost of a startup validation warning on every
  launch and a schema-invalid `settings.json`. We use `3650` instead: it keeps
  `settings.json` valid, produces no warning, and is effectively "never" for
  any real session. The control treats `0` (and any value ≥ 3650) as OFF on
  load, so hand-edited or legacy `0` values still render correctly.
- **Self-contained controls are a sanctioned pattern.** SettingsDialog items
  may ignore `(settings, updateSettings)` and own their IPC state when the
  underlying value is not part of `AppSettings` (precedent: `ProxyTestButton`).
- **Future settings** that `cli.js` consumes (e.g. `autoCompactWindow`,
  `includeCoAuthoredBy`) should follow this ADR rather than the sandbox
  mirroring pattern, unless they genuinely need to be a per-spawn overlay.

## Alternatives considered

- **Mirror into UISettings like `sandbox`.** Rejected: the cleanup sweep reads
  `settings.json`, not UISettings, so the toggle would write a file the feature
  never reads, and would silently disagree with the native CLI.
- **Inject via the per-spawn `settings`/overlay in `claude-session.ts`.**
  Rejected: only covers ClaudeUI-spawned sessions, is transient, and wouldn't
  reflect or respect a value the user set through the native CLI.
