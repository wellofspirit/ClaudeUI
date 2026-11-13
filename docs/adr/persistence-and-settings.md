# Persistence, session identity and settings

Governs: `src/core/services/ui-config.ts`, `src/core/services/claude-settings.ts`, `src/core/services/claude-workspace-trust.ts`, `src/core/services/session-delete.ts`, `src/core/services/delete-session-files.ts`, `src/core/services/claude-transcript-locator.ts`, `src/core/services/pi-session-list.ts`, `src/core/services/opencode-session-list.ts`, `src/core/ipc/handlers-core.ts`, `src/shared/project-key.ts`, `src/shared/claude-project-delete.ts`, `src/renderer/src/components/SettingsDialog/`

Where state lives (files for config, SQLite for operational data), which settings store owns what, how a session is
identified in the sidebar and found on disk, what a session or project delete removes, and the settings dialog's
information architecture. Opencode's native config written in place is ADR-028/ADR-031 (opencode.md); the shared
provider vault is the second ADR-037 (providers-and-models.md); metering tables are ADR-071 (metering.md); the SQLite
driver seam is ADR-058 (core-and-hosts.md); worktree inventory and cleanup, which also touch project groups, are
ADR-112 (terminals-and-worktrees.md).

## Files for config, SQLite for operational data (ADR-020)

ClaudeUI keeps two stores, split by who edits the data:

- **Plain-text config files**: settings, permission rules, MCP config, slash commands, engine config. Human- and
  tool-editable without the app running. Config an engine consumes stays here.
- **Operational database**: usage time-series, account metadata (never secrets), engine/model capability cache,
  session metadata (the engine and model a session reopens on). Queryable, app-managed, never
  hand-edited. The desktop driver is `better-sqlite3`; it sits behind a seam so the headless server can use another (ADR-058).
- **Credentials are never in the database.** They stay file-based and engine-owned (ADR-015).

**Config-plane principle.** ClaudeUI keeps no private copy of config an engine consumes natively: it reads and writes
the engine's own files (`settings.json`, `.mcp.json`, `opencode.json`). The one exception is **launch params**
(proxy, custom endpoint, sandbox, hosted-MCP injection) that ClaudeUI applies at spawn through env or flags and that
the standalone CLI does not share (see ADR-009 below for the Claude-side rule).

**Settings tiers**: app, engine, vendor, session. Logging and refresh intervals are app settings; a custom endpoint or
model override is a vendor setting.

**App settings in core** (recorded 2026-11-13): core reads an app setting from canonical state through `appSetting`
(the saved value, else the one default in `src/shared/app-settings.ts`), never from disk and never with a default of
its own, and applies every side effect of a settings change in one place, from the settings event (`applySettings`,
at boot and after each change). Launch params are not app settings: the proxy, endpoint and model environment is
still re-applied where settings are saved.

## Settings that cli.js reads live in Claude's settings.json (ADR-009)

A setting whose behaviour is implemented inside cli.js (read through `settingSources`) is stored in
`~/.claude/settings.json` and read and written through `claude-settings.ts`. It is never mirrored into UISettings
(`~/.claude/ui/`, the `AppSettings` slice). Reason: the native CLI reads the same file, so one value serves both and
nothing has to be reconciled; a UISettings copy would be a file the feature never reads.

- `cleanupPeriodDays` is the model case (`claude:get-cleanup-period` / `claude:set-cleanup-period`, desktop and
  remote, `ChatRetentionSetting`). The helpers preserve other top-level keys, write mode `0o600` and clamp to an
  integer of at least 1. A save hot-reloads running sessions (`notifySettingsChanged()`), but cli.js's sweep only
  runs at startup (throttled to once a day), so a new window applies at the next launch.
- `disableAutoMode` is the second case (2026-11-12; `claude:set-disable-auto-mode`, desktop and remote, the
  "Disable auto mode" row on the Claude page; what it means is ADR-050 in `permissions.md`). There is no read
  command: the value is replicated state, and a save reaches every client as `config:claude-auto-mode-changed`.
  Its writer, `saveClaudeDisableAutoMode`, refuses to write over a settings file it cannot parse (an empty file or
  one with a byte-order mark is fine), where the two older writers replace such a file.
- **Auto-delete OFF writes `3650`, not `0`.** Upstream treats `0` as schema-invalid; writing it makes settings.json
  invalid and warns on every launch. The control reads `0` and any value of 3650 or more as OFF, so a hand-edited
  `0` still renders correctly.
- **Self-contained controls are sanctioned.** A settings item may own its IPC state and ignore
  `(settings, updateSettings)` when the value is not in `AppSettings` (`ProxyTestButton`, `ChatRetentionSetting`).
- **Per-spawn overlay exception.** A cli.js setting whose ClaudeUI default differs from the terminal's is stored in
  ClaudeUI's Claude engine config and passed per spawn as flag settings (`--settings`), like `sandbox`. Today:
  `idleCompaction` (ClaudeUI default off) and `enabledPlugins["cc-plugin-privacy@builtin"]`. A new cli.js setting
  follows the settings.json rule unless it genuinely needs this overlay.
- **Workspace trust** (`<globalConfig>#projects[K].hasTrustDialogAccepted`) is read and written by ClaudeUI
  (`claude-workspace-trust.ts`, the Permissions dialog toggle) the way cli.js's own dialog writes it: the same key,
  under cli.js's config lock, `false` to untrust. It is never mirrored into UISettings and never recorded for the
  home directory. Wire facts: `docs/protocol-cc/02-cli-flags.md`, "Workspace trust".

UISettings stays the home of state cli.js knows nothing about (theme, fonts, diff view, terminal grouping).

## `projectKey` is a derived, lossy grouping token (ADR-025)

`cwdToProjectKey(cwd)` (`src/shared/project-key.ts`) replaces every non-alphanumeric character with `-`, the same
encoding Claude Code uses for directory names under `~/.claude/projects/`. Every engine's sessions are grouped by it,
so one directory is one sidebar project.

- **Lossy and one-way.** `my.app` and `my-app` collide; the key is never reversed into a path. `\`, `/` and `:` all
  map to `-`, so `D:\x` and `D:/x` agree.
- **Backends keep their native identity.** opencode stores the real cwd and pi its own session files; the key is
  computed for the UI. `SessionInfo` carries `cwd` (real, for display and engine operations) and `projectKey`
  (derived, for grouping).
- The renderer's grouping of running sessions also keys on `cwdToProjectKey(cwd)`, with exact cwd kept as a fallback.

### Persisted-session delete is one engine-neutral dispatcher

`deleteSessionByEngine(sessionId, projectKey, engineId?)` (`session-delete.ts`) routes through `historyFor(engine)`;
both the desktop IPC handler and the remote dispatcher reach it through `deleteSession` (`handlers-core.ts`). It
resolves `false` when a best-effort engine could not delete (the session survives); a refusal throws. What each
engine's delete removes, exactly:

- **Claude** (`deleteSessionFiles`): `<projectsRoot>/<projectKey>/<sessionId>.jsonl` and the recursive
  `<projectsRoot>/<projectKey>/<sessionId>/` folder (subagents, tool results). `sessionId` and `projectKey` must pass
  the segment-traversal check and the resolved directory must stay under `~/.claude/projects`. Missing files are
  ignored; other fs errors propagate. Nothing else is touched.
- **opencode** (`deleteOpencodeSession`): `DELETE /api/session/{id}` on the shared server, by the engine-owned
  `sessionId` (global by id; the lossy key is unused). ClaudeUI never writes opencode's database. A 404 counts as
  deleted; a down server resolves `false` and logs. The sidebar row is dropped at once.
- **pi** (`deletePiSession`): unlinks the session's `.jsonl` found by id, then removes the parent `--<mangled-cwd>--`
  directory only if it is now empty (a plain `rmdir`). Host-run subagent children (ADR-089) reachable
  through the parent file's links are read first and deleted too, each by unlinking only its own files and a plain
  `rmdir` of its folder (anything else in the folder stays, never a recursive remove), except a child another pi
  session file still references (a fork or clone copies the links): those are confirmed by parsing and kept. When the file is gone, the session's scratchpad
  (`removePiScratchpad`, ADR-110) is removed with it, and only then. A file already absent counts as deleted.
- **After the engine accepts** (`deleted !== false`), `deleteSession` also deletes the session's engine/model row (`deleteSessionMeta`)
  and ends the session's X-Agents (ADR-105 §5). A survivor keeps its row, which it needs to reopen on the right
  engine, and keeps its X-Agents. The call first unwatches, cancels the live session and removes it from the
  replicated state; a `engineId` that disagrees with the persisted one is refused.

Project delete: see "A project delete removes what the project lists" under ADR-077 below.

Rejected: matching by normalized real cwd instead of the key (Claude's own file operations need the real directory
name); writing opencode's SQLite for delete (the engine owns the mechanism); an `EnginePersistenceProvider`
registry (over-engineered while `historyFor(engine).delete` is the seam).

## A session belongs to its home project; its transcript is found by id (ADR-077)

cli.js's `EnterWorktree` moves the live transcript (`<sid>.jsonl` and its `<sid>/` folder) into the project directory
of the worktree path and stamps a `relocated` line; `ExitWorktree` moves it back. The first user entry keeps the
original cwd. Four rules follow.

**Home grouping.** A Claude session's home is `cwdToProjectKey` of the cwd on its first user entry (falling back to
the directory the file lives in). `listDirectories` builds groups under the home key, so a session inside a worktree
stays in the project it started in. A home group can exist with all members moved away and no directory on disk. The
comparison is between keys and never goes through git. A session whose first prompt already ran in a worktree has
that worktree as its home.

**`SessionInfo.projectKey` is where the file IS; `DirectoryGroup.projectKey` is where the session BELONGS.** Anything
touching one session's file (load history, watch, rename, delete, remote-resume seed) uses the session's key, never
its group's. `writeCustomTitle` appends, so a group key would create a stray one-line transcript in the home
directory.

**Find a transcript by id.** `locateClaudeTranscript(sessionId, cwdHint)` checks the cwd-derived path (one stat), and
only on a miss scans `~/.claude/projects/*/<sid>.jsonl`; ids with separators, `..` or NUL are refused.
`claudeProjectKeyFor` gives callers that need a key the directory it found. A live session is re-located on every
call because the file can move mid-session. Building `~/.claude/projects/<cwdToProjectKey(cwd)>/...` directly is a
bug unless the file is about to be created.

**A resume target with no transcript spawns fresh.** `ClaudeSession`'s constructor drops the resume (with a warning)
when the target is not a fork and the locator finds nothing; cli.js mints a new id and the post-init rekey moves the
session onto it. A fork is exempt: a missing fork source is a real error.

### A project delete removes what the project lists, and nothing it doesn't

`deleteProject` (`handlers-core.ts`) resolves the project's scope from the canonical listing, never from the client:
the group, the linked-worktree groups folded into it (ADR-112) and the live sessions running in the group's
directory or a folded worktree's. Live sessions belong by directory, not by the lossy key (`liveProjectMembers`,
`src/shared/worktree-fold.ts`): the key decides only when the listing knows nothing for it (no group,
nothing folded in), and never for a session a listed group already claims, because two directories can share a key.
Order:
unwatch and cancel each; delete every non-Claude member through its own engine first (`allSettled`; a survivor is
logged and keeps its row), so a re-listing does not resurrect the group; then the Claude files per
`planClaudeProjectDelete` (`src/shared/claude-project-delete.ts`, the same rule the confirmation dialog describes):

- Members relocated out of the directory are deleted one by one under their own `projectKey`.
- The whole directory is removed (`deleteProjectFiles`, recursive) only for a real, unmarked group in the listing
  that no other project's relocated member lives in. A directory holding another project's member keeps itself and
  every member goes individually.
- A synthesised parent (no group of its own), a key the listing does not know, and a worktree group's own key never
  have their directory removed: it can hold Claude's per-repository `memory/` and unlisted transcripts.
- An emptied worktree project directory is removed only by a plain non-recursive `rmdir` (`removeEmptyProjectDir`).
  Worktree folders themselves are never touched.

Accepted gap: when a cwd is longer than 200 characters cli.js truncates and hashes the directory name and
`cwdToProjectKey` does not; those sessions group under an untruncated key with no directory on disk but still list and
delete correctly. Rejected: rooting a moved session's project at the worktree path (the group would break when the
worktree is removed); reading the `relocated` stamps to find the file (it means parsing the file being looked for);
guarding resume in each renderer call site (the renderer cannot see the disk).

## Settings are pages of groups of rows, with two engine-scoping rules (ADR-065)

The settings dialog is organised by task, not by which file a value is saved to. One page model is the only settings
model (`SettingsDialog/settings-pages.tsx` `PAGES`; the old scope model is deleted).

- **Shell.** A modal of `min(1040px, 92vw)` by `min(700px, 88vh)`, both caps divided by `uiFontScale` (the app
  renders under CSS `zoom`, and a fixed overlay in a zoomed subtree resolves `vw`/`vh` in zoomed space). Header: title,
  a centred global search (`Ctrl+,` / `Cmd+,` focuses it), close. A 204px rail with the active page's groups as
  scroll-spy sub-entries, one scrolling page on the right. A full-window view was rejected.
- **Pages in rail groups.** A page is a title, a description and ordered groups. Rail groups: App, Features, Engines.
  The page ids are `SETTINGS_PAGE_IDS` in `settings-target.ts` (appearance, chat, sessions, advanced, about, models,
  dispatch, mockups, remote, harnesses, claude, opencode, pi). The harness pages sit in the Engines group (ADR-082).
  A group is a card of rows whose header may carry an engine segment, a badge, a storage tag and one action. A
  deep link is `{ page, group? }` (`settingsTargetFromEvent`); an unknown page id opens Settings where it was, never
  throws. `GROUP_ALIASES` keeps a moved group's old deep link working.
- **A setting has exactly one home.** Sessions cross-links to the Claude sandbox instead of repeating its toggle. A
  dissolved-into-topics layout for engine pages (every engine knob on a topic page) was rejected: one page would
  show four independent engine segments.
- **Storage is information, not navigation.** A small tag on a group header (`opencode.jsonc`, `engines/pi.json`),
  shown only when the group does not write ClaudeUI's own settings.

### Engine scoping: a segment where values differ, a chip where only some engines have the setting

1. **Engine segment** on a group whose values differ per engine (default models, the auto-mode judge, dispatch
   targets): the group declares one item list per engine (`byEngine`) and the segment defaults to the active
   session's engine.
2. **Engine chip** on a row that exists for only some engines. A group where two of three engines would show nothing
   gets one dimmed explanatory row, never an empty segment.

A group may **follow** a sibling's segment (`engineFrom`) instead of drawing its own: two segments on one page would
let the user put two cards out of step (the Dispatch limits card follows the target card above it). The note and the
applies-later badge may be functions of the selected engine, because the same setting applies at a different time per
engine (default models: next opencode server start, next Claude session).

### One row vocabulary

Every setting renders through `SettingRow` (`settings-controls.tsx`): label, optional description (12px
`text-secondary`, the contrast fix; helper text at 10px `text-muted/60` failed WCAG AA at 1.6 to 2.6:1), optional
config key in mono, a content-sized control column at every width (a control that needs a width declares one), and
inline badges. Wide controls (text, lists, chip sets) go under the label. New settings are declarations, not new row
styles.

- **No persistent changed-from-default indicator.** A modified row reveals a hover-only Reset link and nothing else
  (AppSettings compare to `DEFAULT_SETTINGS`; engine-native keys are modified when present in the file).
- **Applies-later badge has exactly three values**: Next session, Next server start, Next launch
  (`settings-controls.tsx`). It sits with its one-sentence note under the card, replacing prose footers. Group-level
  `appliesOn` and `note` carry it. A group whose change binds the next call (dispatch limits are re-read per
  dispatch) wears no badge: "Next session" would be a false promise.
- A lock badge marks values ClaudeUI forces (managed keys); dependent rows nest one level and stay readable when
  disabled. Buttons: filled is the page's one primary action, tinted secondary, link tertiary, red destructive.
- A group header's action carries an **event name, not a callback**, because group definitions are static modules.
- **Two panes over one engine config share ONE config object** (a small reference-counted external store), because
  `config:save-engine-config` replaces the whole file and two private copies silently revert each other.

### Search

Global across all pages, matching page, group and item labels plus keywords. Results are live, editable rows grouped
page then group, capped: both views bucket through one shared reducer (`bucketSearchHits`, eight buckets) and say how
many groups are held back, because every bucket mounts real panes that fetch on mount. `useIsMobile` is `< 768`, so
the fork and the `max-md:` layout agree at 768px. `SheetFrame` closes only the topmost sheet on Escape.

### § Shared trust lists

`trustedDomains`, `trustedRegistries` and `protectedPatterns` live in one file, `~/.claude/ui/automode.json`
(channels `config:load-shared-automode` / `config:save-shared-automode`, `SharedAutoModeConfig`), edited once in the
"Trust & protection" group and derived into each engine's judge environment at session start (OpencodeSession,
PiSession). Claude runs cli.js's own classifier and cannot consume them; the badge reads "opencode · pi". Judge
model, two-stage mode and the master switch stay per engine in `engines/<engine>.json#autoMode`. A one-time
read-time migration unions the two old per-engine lists, because dropping a trusted host from one engine would
silently weaken its judge. The save is guarded by payload shape (three optional arrays of non-empty trimmed strings,
no other keys). Judge guidance is ADR-083 §4 (auto-mode-judge.md).

### § Cross-engine dispatch into pi

The Dispatch page carries a Claude / opencode / pi segment; core resolves pi targets from
`engines/pi.json#dispatch`. The allowed-model list is a chip set, not a toggle list. Dispatch is two groups (targets
and limits), with limits following the targets segment. Dispatch semantics are ADR-033 (dispatch.md).

### § Providers: one list

Models & providers shows one row per provider identity the user HAS, over the shared vault, opencode's catalog and
`auth.json`, and pi's `auth.json` / `models.json`. The read model is `provider-registry:list` (a `config` query; names,
counts and credential badges, no key material). It adds no write channel: a credential is written into each enabled
engine's own auth store and never copied between engines without that engine's toggle. An unconfigured catalog entry
is an Add-sheet candidate, not a row. Manage opens a sheet (credential once, enable per engine, model curation);
a built-in pi vendor's overrides open from a "pi overrides" row when the row has `piBuiltinId`. Stored accounts of a
subscription are not managed in the sheet; the sheet links to the Accounts page. The Subscriptions / API-providers
split and the Anthropic endpoint's move to the Claude page are ADR-074 (providers-and-models.md); ChatGPT accounts
are ADR-068 (auth-and-accounts.md).

### Mobile

The same page/group/item model renders on a phone: tabs are the rail groups and pages are accordions (several may be
open and the open set survives tab switches and search), drawing the same group cards including the engine segment,
`engineFrom` followers and per-engine notes. There is no second settings model. Presentation forks, machinery is
shared (ADR-048, ui.md).

### Coverage guard

`SECTION_TARGET` is not navigation any more: it is the coverage map an inventory test walks to prove every pre-ADR
setting key exists exactly once in `PAGES`. `itemsOf()` throws at module load on a mistyped key, so a dropped
setting fails the run instead of vanishing from the UI.

### Phase labels cited in source

Source cites these rollout phases of ADR-065; the rule each delivered is in the sections above.

- phase 2: engine pages onto the row primitive; Claude launch parameters; group `note` and `appliesOn`.
- phase 3A/3B: per-engine Default models, `engineFrom`, dispatch with pi, Remote access as four groups.
- phase 4: shared trust lists (§ Shared trust lists), the Trust & protection group, `config:*-shared-automode`.
- phase 5: mobile on the page model (tabs are rail groups, pages are accordions).
- phase 6, 6a: the `provider-registry:list` read model (§ Providers: one list).
- phase 6b: the provider list and Manage sheet, `SheetFrame`, a group action as an event name.
- phase 6c: the Add sheet and provider forms; pi vendors are `pi:<vendorId>` rows; the old `SharedProviders`,
  `PiVendors`, `VendorOpencodeSection` and allowlist dialog are deleted, not re-homed.
- phase 7: the scope model deleted, search reducer shared by both views, topmost-sheet Escape, `useIsMobile` at 768.
- amendment: `engineFrom` (a follower group has no segment of its own). "section now": `SECTION_TARGET` maps each
  pre-ADR section to where it lives now.
