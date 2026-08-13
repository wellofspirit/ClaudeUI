# ADR-050 — Auto mode as the default autonomy, owned by ClaudeUI

**Status:** Accepted (2026-08-13)
**Relates to:** ADR-022 (opencode permission mapping — "one config applies to all
harnesses"), ADR-023 (auto-mode classifier), ADR-037 (opencode fork: judge
endpoint + session sealing), ADR-035 (pi engine backend)

## Context

Claude Code made auto mode the default for Pro/Max/Team on 2026-08-14
(`claude.com/blog/auto-mode-default-in-claude-code`): new sessions launch in
auto, admins can force a mode via managed `defaultMode` or switch it off with
`disableAutoMode`, and — the part that shapes this ADR — **users with a pinned
default see no change**.

This is a rollout, not a code change: cli.js 2.1.231 still resolves the startup
mode as `defaultMode || "default"`, and it explicitly ignores
`defaultMode: "auto"` coming from project-scope settings (only policy/user/flag
settings may grant auto). ClaudeUI passes `--permission-mode` explicitly on every
spawn, so cli.js's own default never applies to us — whatever ClaudeUI decides is
what a session gets.

Before this change ClaudeUI derived the new-session mode from
`~/.claude/settings.json#permissions.defaultMode`, for **all three engines**.
Two problems with that, independent of the default's value:

- Claude Code's config silently governed opencode and pi sessions, which is
  backwards even under ADR-022's "one config applies to all harnesses" (that ADR
  is about permission *rules*, which genuinely are shared; the startup autonomy
  of a pi session is not Claude's business).
- The Settings picker *wrote* that file, so changing the default in ClaudeUI
  also changed how the user's bare `claude` CLI behaved.

## Decision

1. **`settings.defaultAutonomyMode` is a ClaudeUI-owned, engine-neutral setting,
   defaulting to `full` → the `auto` PermissionMode.** It is the single source of
   truth for the mode new sessions start in on Claude, opencode, and pi. The
   Settings → Autonomy mode picker reads and writes it and no longer touches
   `~/.claude/settings.json`.

2. **Claude's `permissions.defaultMode` seeds it exactly once.** This is how
   upstream's "pinned defaults are preserved" rule is honoured: a profile that
   already carried a `defaultMode` keeps that mode; a profile with nothing set
   adopts auto. Absence of the *key* (not a falsy value) marks a pre-upgrade
   profile, and the seed is persisted immediately so a later edit to Claude's
   file can never re-seed and clobber a deliberate ClaudeUI pick. A `defaultMode`
   with no ClaudeUI equivalent (`bypassPermissions`, `dontAsk`) seeds the new
   default instead — every such mode is *more* permissive than classifier-gated
   auto, so this only ever de-escalates.

3. **Auto is gated at session creation, not at spawn.** `createNewSession`
   downgrades `auto` → `default` when `autoModeAvailableForEngine()` says the
   engine/account can't do auto, or when Claude settings carry
   `disableAutoMode: "disable"`. With auto merely *available* this was
   defensive; with auto as the shipped default it is load-bearing — otherwise an
   account without auto spawns with `--permission-mode auto`, cli.js rejects it,
   and the user watches the mode snap back mid-session. The pre-existing
   post-spawn rejection fallback stays as the backstop.

4. **`disableAutoMode` is now read (and round-tripped) from Claude settings.**
   cli.js honours it both nested under `permissions` and at the top level; the
   loader normalizes both into one field. `saveClaudePermissions` rebuilds the
   `permissions` object from scratch, so it previously *dropped* this key on any
   permission edit — it now preserves the on-disk nested value verbatim. Only
   user-scope settings are consulted; a full managed/enterprise policy read is
   out of scope.

5. **All three engines default to auto, judge cost included.** opencode and pi
   route each non-read tool call through the ADR-023 classifier, which bills a
   judge call. That cost is accepted because the failure mode is safe: the
   classifier is fail-closed — no judge, an unavailable judge, or an unparseable
   verdict all degrade to *asking the human*, never to auto-approval — and
   read-only tools fast-path without a judge call at all. The 3-consecutive /
   20-total block caps the blog describes already exist engine-neutrally in
   `automode/denial-tracker.ts` (plus a stricter same-category cap), so no
   parity work was needed there.

## Consequences

- The Autonomy mode picker's labels change: `ask` is no longer "Ask (default)",
  and `full` is now "Full auto (default)".
- ClaudeUI and the bare `claude` CLI can now disagree about the startup mode.
  That is the point of decision 1, but it does mean the picker no longer doubles
  as a way to configure the CLI.
- A user whose `permissions.defaultMode` is explicitly `"default"` keeps
  manual approvals after upgrading, and must opt into auto in Settings. This
  matches upstream's pinned-defaults rule and is deliberate.
- `ClaudePermissions.disableAutoMode` is optional (absent ≡ `undefined`), so the
  many empty-ruleset construction sites across the opencode/pi permission
  engines did not have to change.
