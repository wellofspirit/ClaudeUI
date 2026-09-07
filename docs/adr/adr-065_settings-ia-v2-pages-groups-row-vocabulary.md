# ADR-065 — Settings IA v2: pages, groups, and one row vocabulary

**Status:** Accepted (2026-09-07), implementation in progress on branch `settings-v2`
**Supersedes:** the "scope tabs" settings IA described in `docs/architecture/persistence.md` § Settings & config (Common / Claude / opencode / pi tabs over 43 sections)
**Relates to:** ADR-023 (auto mode), ADR-027 (test data attributes), ADR-033 (cross-engine dispatch), ADR-036 (unified auth vault), ADR-048 (mobile surface pattern)

## Context

An audit of the settings dialog on 2026-09-07 (every one of the 43 sections screenshotted from the
real app) found the dialog organised by **which file a setting is saved to**, not by what the user
is doing: "Common" was ClaudeUI's settings.json, "Engine" was `engines/*.json`, "Configuration" was
the engine's own config file, "Vendor" was `vendors/*.json`. Consequences:

- The same concept had several homes. Auto-mode judge appeared under opencode and under pi with
  identical trust lists; cross-engine dispatch appeared twice; "Tool output" existed in Common
  (rendering) and opencode (truncation); model defaults lived in four sections; providers were split
  three ways, and the pi Providers pane told the user to go to Common for ChatGPT.
- Roughly 20 of the 43 sections had three rows or fewer, so the right pane was mostly empty, while
  Remote was three screens tall and the dispatch pane held a 13-toggle list. The fixed 760×540 box
  was wrong in both directions.
- Six row grammars coexisted (Common rows without descriptions, opencode `LeafRow`/`StackedRow`,
  pi rows, the Anthropic form, the sandbox form, three card styles), with three select styles,
  three segmented-control sizes, and five phrasings of "applies on restart".
- Helper text (10px, `text-muted/60`) measured 1.6:1 on the dark theme, 2.0:1 on Monokai and
  2.6:1 on light. WCAG AA is 4.5:1.
- Search was scope-local and label-only.

Two shell directions and two grouping options were mocked and reviewed with the owner
(design canvas "ClaudeUI Settings Redesign"). Decisions below are the ratified outcome.

## Decision

### Shell: a larger modal, not a full-window view

The dialog stays a modal (Direction A). It grows to `min(1040px, 92vw)` × `min(700px, 88vh)`.
Header: title, a centred global search field (`Ctrl+,` / `Cmd+,` focuses it), close. Body: a 204px
rail on the left, one scrolling page on the right. The version footer is gone; versions live under
Advanced › About. A full-window settings view (Direction B) was rejected: it reads like VS Code.

### Information architecture: 11 pages in 3 rail groups

| Rail group | Pages |
|---|---|
| App | Appearance · Chat · Sessions & autonomy · Advanced |
| Features | Models & providers · Cross-engine dispatch · Mockups · Remote access |
| Engines | Claude · opencode · pi |

"Features" holds what ClaudeUI adds on top of the engines; each is a first-class page. "Engines"
holds each engine's own configuration file, curated (Option 1). The alternative of dissolving every
engine-internal knob into topic pages (Option 2) was rejected: pages grew to eight groups with four
independent engine segments, so one page could show the judge for opencode and compaction for pi at
the same time.

A page is a title, a one-line description, and an ordered list of **groups**. A group is a card of
**rows** with a header that may carry: an engine segment, a badge, a storage tag, one action. The
rail shows the active page's groups as sub-entries (scroll-spy), so a long page never needs a third
column.

### Engine scoping: two rules, no tabs

1. **Engine segment** on a group whose *values* differ per engine (default models, the auto-mode
   judge, dispatch targets). The group declares one item list per engine; the segment defaults to
   the active session's engine.
2. **Engine chip** on a row when a setting exists for only some engines (Claude's permission rules
   on the Sessions page). A group where two of three engines would show nothing gets one dimmed
   explanatory row, never an empty segment.

A setting has exactly one home. The Sessions page cross-links to the Claude sandbox rather than
repeating its master toggle.

### One row vocabulary

Every setting renders through `SettingRow`: label (13px, text-primary), optional description
(12px, text-secondary — the contrast fix), optional config key (11px mono, text-muted), a 240px
right-aligned control column, and inline state badges. Wide controls (text, lists, chip sets) go
under the label at full width. Controls: toggle, select, number with unit, segmented (≤5 options),
slider with value, text, list editor, chip set, radio row, action row. Buttons: filled = the one
primary action on a page, tinted = secondary, link = tertiary, red = destructive.

State vocabulary: an accent dot after the label = changed from default (hover reveals Reset;
AppSettings compare against `DEFAULT_SETTINGS`, engine-native keys are modified when present in the
file); a badge for "applies later" with exactly three values — **Next session**, **Next server
start**, **Next launch** — replacing the five prose footers; a lock badge for values ClaudeUI forces
(the Managed keys pattern); dependent rows nest one level and stay readable when disabled.

Storage is a small tag on the group header (`opencode.jsonc`, `engines/pi.json`), shown only when
the group does not write ClaudeUI's own settings. It is information, never navigation.

### Search

Global across all pages; matches page, group and item labels plus keywords. Results replace the
page as a flat list grouped by page › group, rows editable in place. The mobile view already
searched wide; the predicate becomes one shared helper.

### Shared trust lists

`trustedDomains`, `trustedRegistries` and `protectedPatterns` move out of `engines/<engine>.json#autoMode`
into one shared file, `~/.claude/ui/automode.json`, and are **derived** into each engine's judge
environment at session start (OpencodeSession, PiSession). Claude runs cli.js's own classifier and
cannot consume them; the UI badge says "opencode · pi". A read-time migration in the config-plane
migrator unions the two existing lists once, since dropping a trusted host from one engine would
silently weaken its judge. Judge model, two-stage mode and the master switch stay per engine.

### Cross-engine dispatch into pi

Core has accepted pi as a dispatch target since M4c (`resolveAndRunPi`, reads `engines/pi.json#dispatch`).
The settings UI never gained the pane; the Dispatch page carries a Claude / opencode / pi segment.
The allowed-model list is a chip set, not a toggle list.

### Providers: one list

The three provider surfaces (the shared vault, opencode's catalog + `auth.json`, pi's API keys +
`models.json`) become one list on Models & providers: one row per provider with a credential badge
and chips for the engines it is enabled on. **Manage** opens a sheet with the credential once,
an enable toggle per engine, and model curation for the picker. **Add** offers subscriptions, the
models.dev catalog with per-engine availability, and custom OpenAI-compatible endpoints. A core
provider registry maps one provider identity onto the three backing stores; a credential is written
into each *enabled* engine's own auth store and never copied between engines without that toggle.
This is the last phase of the arc; the three existing surfaces re-homed as three groups is the
fallback if it slips.

### Mobile

The same page/group/item model renders on a phone as a page list with drill-in and groups as
accordions (ADR-048's content-takeover pattern), wide search kept. Until that phase lands, the mobile
view stays on the legacy scope model behind an adapter so it keeps working on the branch.

## Phases (one commit each on `settings-v2`, merged by PR at the end)

1. Page model, shell, row primitive, App pages converted; every other page re-homed with its
   existing bodies wrapped; deep links re-routed; mobile on the legacy adapter.
2. Engine pages: opencode, pi, Claude group internals onto the row primitive.
3. Features pages: Default models per engine, dispatch with pi, Mockups, Remote groups.
4. Shared trust lists: storage, migration, session derivation, the Trust & protection group.
5. Mobile on the page model.
6. Provider unification.
7. Cleanup: delete the scope model and legacy controls, rationalise the quick popover, inventory
   guard that every pre-arc item key exists exactly once.

## Consequences

- One mental model for the user: pages by task, engine only where the engine matters.
- One primitive for the code: new settings are a declaration, not a new row style. The three row
  systems and their tests collapse into one.
- The `open-settings` deep-link detail changes shape (`{ page, group? }`); every caller is in-app.
- Storage location stops being navigation, so future config moves do not reshuffle the UI.
- The trust-list file is a new persistence surface with a migration; ADR-023's per-engine
  `autoMode` block loses three keys.

## Alternatives considered

- **Direction B, full-window settings view** (a content-area view like Automations, with a
  right-hand table of contents). Rejected by the owner: too close to VS Code's settings feel.
- **Option 2, dissolve engine pages entirely into topic pages.** Rejected: mixed-engine pages with
  independent segments, and engine-only groups needing "opencode only" badges throughout.
- **Command-palette-first settings.** Not mocked; discoverability too poor for a first-time user.
