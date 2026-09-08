# ADR-065 — Settings IA v2: pages, groups, and one row vocabulary

**Status:** **Implemented** (2026-09-08) — the seven phases below landed on branch `settings-v2`; see § As built for what the implementation changed about this decision.
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

| Rail group | Pages                                                                |
| ---------- | -------------------------------------------------------------------- |
| App        | Appearance · Chat · Sessions & autonomy · Advanced                   |
| Features   | Models & providers · Cross-engine dispatch · Mockups · Remote access |
| Engines    | Claude · opencode · pi                                               |

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

1. **Engine segment** on a group whose _values_ differ per engine (default models, the auto-mode
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
into each _enabled_ engine's own auth store and never copied between engines without that toggle.
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

## As built (2026-09-08)

Nine commits landed the phases, in the order 1, 2, 3B, 4, 3A, 5, 6a, 6b, 6c; the phase-7 close-out
is the tenth. The decision above stands; these are the points where building it changed or extended
it, each carried by the phase that found it.

1. **The group model grew four fields the design did not have.** `note` + `appliesOn` (phase 2)
   put the applies-later badge and its one sentence UNDER the card, retiring the five per-pane
   prose footers the Context complains about. Both may be **functions of the selected engine**
   (phase 3A): Default models applies on the next opencode SERVER start but the next Claude
   SESSION, so one static string would be wrong for two engines out of three. `engineFrom`
   (phase 3A) names a sibling group whose segment a `byEngine` group FOLLOWS instead of drawing
   its own — the Dispatch page's Limits card is the same target as the card above it, and two
   segments on one page would let the user put them out of step. A group header's one optional
   `action` (phase 6b) carries an **event name, not a callback**, because a group definition is a
   static module-level object while the state the action drives lives in the pane it renders.

2. **Cross-engine dispatch is two groups, and Limits wears no badge and no file tag.** The
   dispatcher re-reads `loadEngineConfig(engine).dispatch` on every dispatch call, so a changed
   cap or timeout binds the very next one — "Next session" would be a false promise — and a
   follower group's storage tag would only repeat the one on the card directly above it.

3. **Two panes over one engine config need ONE config object.** `config:save-engine-config`
   replaces the whole file, so the Dispatch-into and Limits bodies each holding their own copy
   silently reverted each other's edits. They share a small reference-counted external store
   (phase 3A), guarded in both dispatch suites.

4. **Providers went further than "one list".** Phase 6a added a core READ MODEL,
   `provider-registry:list` — one row per provider IDENTITY over the shared vault, opencode's
   catalog + `auth.json` and pi's `auth.json` / `models.json`, with the credential per origin and
   the engine facts projected — and no new write channel: every write still goes to the store
   that owns it. Rows are the providers the user HAS; an unconfigured catalog entry is an
   Add-sheet candidate, not a row (the live walk showed 230 "Not connected" rows before that
   filter). The three old surfaces (`SharedProviders`, `PiVendors`, `VendorOpencodeSection`) and
   `ModelAllowlistDialog` are deleted rather than re-homed, so the fallback in § Providers was
   not needed.

5. **The phone is tabs = RAIL GROUPS and pages = ACCORDIONS**, not the page list with drill-in
   this ADR predicted (phase 5; recorded as an amendment on ADR-048). Several pages may be open
   at once, the open set survives tab switches and search, and inside an open page the phone
   draws the same group cards the desktop does — including the engine segment, the `engineFrom`
   followers and the per-engine note and badge. The legacy adapter (`targetToLegacy`) went with
   that phase; there is no second settings model on the branch.

6. **`SECTION_TARGET` stopped being navigation.** With the mobile adapter gone nothing renders
   from it; it stays as the COVERAGE map the inventory guard walks to prove that no pre-arc
   section lost its home. `SECTIONS` remains the item source, so the guard is an exact bijection
   between the legacy item keys plus the three page-local rows and what `PAGES` reaches.

7. **`SettingRow` gained state the boards implied but did not name:** `locked` (the Managed keys
   badge), `errorTestid` (the engine panes namespace their errors), `labelBadge`, `inputMode`,
   ADR-027 `dataId` discriminators on the primitives, and — on the phone — a control column that
   keeps its 240px on `md` and up but sizes to content below.

8. **Search results are LIVE rows, so they are capped.** A one-character query matches 47 groups
   and every bucket shown mounts a real pane, several of which fetch on mount. Both views bucket
   and cap through one shared reducer (`bucketSearchHits`, eight buckets) and say how many groups
   they are holding back.

9. **The shell divides its viewport caps by `uiFontScale`.** SessionView applies that scale as CSS
   `zoom`, and a fixed overlay inside a zoomed subtree resolves `vw`/`vh` in the zoomed space — a
   plain `92vw` cap grew the dialog past the window at 115%.

### Phase 7 close-out

The scope model is **deleted**, not deprecated: `SCOPES`, `ScopeDef`, `SettingsScope`,
`SECTION_SCOPE_MAP`, `SECTION_CAPABILITY`, `firstSectionOfScope`, `scopeCapabilities`,
`isSectionVisible`, `getSectionsForIds` and the nine per-scope id sets are gone from
`settings-sections.tsx` with their unit suite, which leaves that file holding render bodies and
nothing else. `groupKey` and the search bucketing move to the two modules both views import, so
neither can drift. `InfoTooltip` is deleted — the ⓘ had no call site left once every phase had
converted its explanations into visible descriptions. `SheetFrame` closes only the TOPMOST sheet
on Escape (the Manage sheet mounts a second frame for Edit endpoint, and one press used to close
both), and `useIsMobile` is `< 768` rather than `<= 768` so that the fork it chooses and the
`max-md:` layout inside it agree at exactly 768px.

**Residual for the owner:** editing `providers.<builtin>.modelOverrides` for a built-in pi vendor
that has no pi-native row of its own has no entry point. It belonged to the `PiCustomProviders`
pane, which 6c stopped mounting and phase 7 deleted; `PiModelEditor` still takes
`variant="override"`, so whichever surface takes that job next has its editor. An "Overrides" row
on the pi provider's Manage sheet is the obvious home if the owner wants one.

## Alternatives considered

- **Direction B, full-window settings view** (a content-area view like Automations, with a
  right-hand table of contents). Rejected by the owner: too close to VS Code's settings feel.
- **Option 2, dissolve engine pages entirely into topic pages.** Rejected: mixed-engine pages with
  independent segments, and engine-only groups needing "opencode only" badges throughout.
- **Command-palette-first settings.** Not mocked; discoverability too poor for a first-time user.
