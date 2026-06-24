# Follow-up — Settings IA refactor: tabbed scopes (Option A) + Anthropic vendor editable

> Kickoff spec, **phase 1 of 2**. Implementing agent: **Sonnet, `general-purpose`**. Main model (Opus)
> reviews and owns correctness. Do **not** commit, `git add`, branch, or `bun install`. Leave the tree
> for review; report deltas, exact verify-gate output, deviations.

This is the settings refactor toward ROADMAP **#6** + **#12**, split into two kickoffs (user decision).
**This phase = the IA refactor that fixes the breakage + folds in the small #6 win** (make the Anthropic
vendor section editable). Phase 2 (separate) = ModelRef-derived vendor at spawn, #12 capability-gating,
and new opencode settings.

## 0. The breakage (root cause)

`SECTIONS` (settings-sections.tsx) is one flat array rendered in a **single unified scroll** (View.tsx),
and the left `NAV_GROUPS` tree only *scroll-spies / scrolls-to* into it. But the flat `SECTIONS` **order
diverged from the tier grouping** as sections were added: e.g. `mockup` (an App section) sits at array
index ~16 *between* Claude's `permissions` and `sandbox`; `accounts`/`vendor-*` interleave Claude's
`sandbox`/`proxy`. So the unified scroll renders unrelated groups interleaved, and the nav's
scroll-to/scroll-spy lands in the wrong place — the dialog reads as "broken, the left panel doesn't
filter." The fix is **tabs that actually filter**: render only the active scope's sections, in explicit
order, one focused section at a time. (Chosen design = **Option A**, mockup `c4e1fbaa`.)

## 1. Target design — Option A

A 3-pane dialog:
- **Top tab bar** = three scopes: **Common · Claude · opencode**. Selecting a scope swaps the left list +
  content. Always render all three tabs (opencode sections self-gate their content — see §3).
- **Left list** (scoped to the active tab) = that scope's sections, under subgroup headers (e.g. Claude →
  "Engine" / "Vendor · Anthropic" / "Account"). Clicking a section selects it.
- **Right pane** = the **single selected section's** content. No unified cross-section scroll; the pane
  scrolls only if that one section overflows.
- **Search** (keep it) winnows the **left list within the active scope** (a section shows if its label or
  any of its items' label/keywords match). If the selected section is filtered out, auto-select the first
  match. Scope-local for this phase.
- Footer version line stays.

Scope → section mapping (reuse the existing `*_SECTION_IDS` sets; **order within each scope is now
explicit** — that's the bug fix):
- **common**: `APP_SECTION_IDS` — appearance, chat, session, tool-output, diff, git, status-line, usage,
  logging, voice, remote, mockup. (Single flat group, no subgroup headers needed.)
- **claude**: Engine = permissions, sandbox, proxy (`ENGINE_CLAUDE_SECTION_IDS`); Vendor · Anthropic =
  vendor-anthropic, effortDefaults (`VENDOR_ANTHROPIC_SECTION_IDS`); Account = accounts
  (`ACCOUNTS_SECTION_IDS`).
- **opencode**: Engine = opencode-automode (`ENGINE_OPENCODE_SECTION_IDS`); Vendor = vendor-opencode
  (`VENDOR_OPENCODE_SECTION_IDS`).

## 2. Verified facts (don't re-discover)

- **Per-item render contract is UNCHANGED.** Each `SettingItem.render(settings, update, engineConfig,
  updateEngineConfig, vendorConfig, updateVendorConfig)` (settings-sections.tsx:43-50) stays exactly the
  same. The refactor only changes the **shell** (which section is shown where) — so every section's
  content is behavior-preserving except the Anthropic vendor section (§4). This is the key low-risk lever:
  **do not touch the 2400 lines of section content** beyond the SCOPES wiring + the Anthropic section.
- **Current shell:** `SettingsDialog.tsx` (FC: loads `loadEngineConfig('claude')` + `loadVendorConfig('anthropic')`,
  holds `search`/`activeSection`, builds `filteredSections` from `SECTIONS`), `View.tsx` (renders
  `NAV_GROUPS` tree + unified scroll + scroll-spy via `contentRef`/`sectionRefs`/`isScrollingFromClick`).
- **`SCOPES` replaces `NAV_GROUPS`.** `NAV_GROUPS` (settings-sections.tsx:2428) + `getSectionsForIds`
  (:2424) + the `*_SECTION_IDS` sets (:2400-2422) are the inputs. Build a `SCOPES` structure from them.
- **opencode sections self-gate:** `OpencodeAutoModeSection` (~:423) and `VendorOpencodeSection` (~:564)
  probe opencode internally and render "opencode is not installed…" (lines 449, 696) when absent. So the
  opencode TAB is always shown; no install-probe wiring needed in the shell. Preserve this.
- **Controls:** `settings-controls.tsx` exports `SettingsToggle`, `SettingsSlider`, `SettingsSelect`,
  `SettingsTextarea`. There's no exported text-input — the `proxy` section uses raw styled `<input>`s;
  reuse that pattern (or add a small local `SettingsTextInput`) for the Anthropic form.
- **Tests today:** `__tests__/settings-tier-tree.unit.test.tsx` (asserts NAV_GROUPS = 4 groups, Engines›Claude,
  Vendors›Anthropic, every SECTION covered by exactly one group, search filtering) and
  `__tests__/SettingsDialog.component.test.ts` (mocks `../View`, asserts getVersionInfo on mount, Escape→onClose,
  updateSettings wiring, versionInfo passed through). Both need updating for the new shell.

## 3. The work

### 3a. `SCOPES` structure (settings-sections.tsx)
Add (next to / replacing `NAV_GROUPS`):
```ts
export type SettingsScope = 'common' | 'claude' | 'opencode'
export interface ScopeSubgroup { id: string; label?: string; sections: Section[] }  // label undefined = no header (flat)
export interface ScopeDef { id: SettingsScope; label: string; icon: React.JSX.Element; subgroups: ScopeSubgroup[] }
export const SCOPES: ScopeDef[]
```
Populate from the existing `*_SECTION_IDS` sets via `getSectionsForIds`, in the order in §1. Common = one
subgroup (no label). Claude = three labelled subgroups. opencode = two labelled subgroups. Keep `SECTIONS`
itself as-is (the source of section objects). Export a helper `scopeOfSection(id): SettingsScope` (or a
`Map`) for search/selection logic. **You may keep `NAV_GROUPS` exported if anything else imports it — grep
first; if only the dialog + its test use it, replace it.**

### 3b. `View.tsx` — the Option-A shell
Rewrite the body layout:
- Header: title + a **tab bar** (the three `SCOPES`, active highlighted) + close button. (Match the mockup
  `c4e1fbaa`: a segmented control feel; reuse existing theme classes — `bg-accent/…`, `text-accent`,
  `border-border`.)
- Left `<nav>`: the active scope's subgroups → optional `<header>` + section buttons; active section
  highlighted; disabled/dimmed when filtered out by search.
- Right pane: render the **selected** section only — its header (icon + label) + its items mapped through
  the existing `item.render(...)` six-arg call (copy the call from the current View `:236-247`).
- **Delete** scroll-spy machinery (`contentRef` scroll listener, `sectionRefs`, `isScrollingFromClick`,
  `scrollToSection`). Keep `overlayRef` click-to-close + the Escape handling (in the FC).
- Keep the search input; wire it to winnow the left list (§1).
- New `SettingsDialogViewProps`: `activeScope`, `onSelectScope`, `activeSectionId`, `onSelectSection`,
  `scopes` (or import `SCOPES` directly), `search`, `onSearchChange`, plus the existing `settings`/`update`/
  engine+vendor config/handlers/`versionInfo`/`onClose`. Drop `filteredSections`/`onScrollTo`.

### 3c. `SettingsDialog.tsx` (FC)
- State: `activeScope` (default `'common'`), `activeSectionId` (default = first section of `'common'`),
  `search`. Switching scope → set `activeSectionId` to that scope's first (visible) section. Keep the
  engine/vendor config load + `handleUpdateEngineConfig`/`handleUpdateVendorConfig` (already wired to
  `saveEngineConfig`/`saveVendorConfig`). Keep version fetch + Escape handler. Pass the new prop shape to
  the View.

### 3d. #6 (this phase's scope) — Anthropic vendor **editable**
Replace `VendorAnthropicDisplaySection` (display-only, self-loads its own `vendorCfg`) with an **editable**
form that consumes the dialog's `vendorConfig` + `updateVendorConfig` (the render already receives them as
args 5-6 — switch the section item to use them):
- **Endpoint** (`vendorConfig.endpoint`: `{ enabled, baseUrl, authToken }`): a `SettingsToggle` for
  `enabled`, then `baseUrl` + `authToken` (password) inputs (gated/dimmed when disabled). On change call
  `updateVendorConfig({ endpoint: { ...current, [field]: value } })`.
- **Model override** (`vendorConfig.modelOverride`: `{ enabled, model, sonnetModel, opusModel, haikuModel }`):
  a toggle + the five model-id inputs, same pattern.
- Use sensible defaults when fields are absent (mirror `DEFAULT_…` patterns already in the file). Keep a
  one-line note that changes apply on next session start (values still flow to spawn via the existing
  `vendors/anthropic.json` path). **ModelRef-derived vendor at spawn stays Phase 2 — do not touch
  `session.ipc.ts` spawn wiring here.**

## 4. Out of scope (Phase 2 / do NOT do here)
- ModelRef-derived vendor at spawn (the rest of #6); any `session.ipc.ts` / spawn changes.
- #12 capability-gating (adding `sandbox`/`proxy`/vendor flags to `EngineCapabilities`; gating sections on
  caps). For now sections are assigned to scopes statically.
- New opencode settings (custom-provider base URL, default model, opencode engine launch params).
- Any change to section CONTENT other than the Anthropic vendor section.
- `bun install` / deps.

## 5. Tests
- Replace `settings-tier-tree.unit.test.tsx` with `settings-scopes.unit.test.tsx`: `SCOPES` has exactly
  3 scopes (common/claude/opencode); **every section in `SECTIONS` is assigned to exactly one scope**
  (no orphans, no duplicates — this guards the bug class); common contains the app sections; claude
  contains permissions+sandbox+proxy+vendor-anthropic+effortDefaults+accounts; opencode contains
  opencode-automode+vendor-opencode; assert the intended **order** of a scope's sections.
- Update `SettingsDialog.component.test.ts` for the new View prop shape (activeScope/onSelectScope/
  activeSectionId/onSelectSection); keep the getVersionInfo / Escape→onClose / updateSettings / versionInfo
  assertions.
- Add a focused test for the editable Anthropic form: toggling endpoint `enabled` (or typing a baseUrl)
  calls `updateVendorConfig` with the expected patch (prove it round-trips, would fail against the old
  display-only section).

## 6. Verify gates (report exact output)
`bun run typecheck && bun run test && bun run lint && bun run build` — 0 lint errors (3 pre-existing
exhaustive-deps warnings OK). Leave the tree dirty; list every changed file + one-line rationale. Do NOT
app-shot — the main model drives the real app.

## 7. Gotchas
- **Behavior-preservation is mostly free** because the per-item `render(...)` contract is unchanged —
  resist rewriting section content. The only content change is the Anthropic vendor form.
- Section **order within a scope is the fix** — list them intentionally (the old flat-array order was the
  bug). Don't reintroduce a single flat scroll.
- opencode tab is always present; its sections self-gate ("not installed"). Don't add install-probe
  gating to the shell (Phase-2 #12 territory).
- The Anthropic `updateVendorConfig` must **merge** (`{ ...current.endpoint, [field]: v }`), not replace —
  or you'll wipe sibling fields. `handleUpdateVendorConfig` shallow-merges the top level only.
- Keep Escape-to-close + overlay-click-to-close.
- Grep for other importers of `NAV_GROUPS`/`getSectionsForIds` before removing them.

## 8. Suggested commit (main model writes it after review)
```
feat(v2/settings): tabbed scope IA (Common/Claude/opencode) + editable Anthropic vendor

Replace the broken unified-scroll + tier-tree nav (whose flat SECTIONS order had diverged from the
grouping, so the left panel no longer filtered) with a tab-scoped, single-section layout: Common /
Claude / opencode tabs, a scoped section list, and one focused section pane. Section content is
unchanged (per-item render contract preserved); only the shell + the Anthropic vendor section change.
Make the Anthropic vendor endpoint + model-override editable (ROADMAP #6, UI half) via the existing
saveVendorConfig round-trip. ModelRef-derived vendor at spawn, #12 capability-gating, and new opencode
settings are Phase 2.
```
