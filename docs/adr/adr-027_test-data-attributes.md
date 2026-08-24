# ADR-027 — Test data attributes (`data-testid`) for DOM-assertable verification

**Status:** Accepted
**Relates to:** ADR-026 (workflow — this is the structural tier of its "verify against the real app"
step), ADR-008 (the remote web client is type-checked against the same renderer)

## Context

The surface for a renderer change is pixels in the running Electron window, and our evidence protocol
(`verifier-electron` / `scripts/app-shot.mjs`) ends in a screenshot. But a screenshot is a slow,
lossy, last-resort check: it can't tell you _which component_ rendered (only what a region looks
like), it can't be asserted on programmatically, and reading a PNG is the most expensive verification
step we have. app-shot's only structural probe was a free-text needle count, which hits user _data_
(session titles, chat text) as often as UI chrome.

We also drive the app by clicking — and the only selectors available were brittle ones: `text=...`
(breaks when copy changes; ambiguous — `text=opencode` matched several nodes and intercepted the wrong
one during the opencode-provider verification), CSS classes (churn with Tailwind), or `title=`
attributes that exist only incidentally.

There was no deliberate, stable hook for either purpose. A few components already carried
`data-testid="<ComponentName>"` — but almost entirely as **test-file mocks** stubbing children; real
components barely self-stamped, and the one that did used an ad-hoc kebab id. No convention existed.

## Decision

Adopt a **two-tier `data-testid` convention** across the renderer (`src/renderer`) and the web client
(`src/web`), and make **DOM-by-testid assertion the first verification tier — before screenshots.**

`data-testid` is the attribute (the Testing Library default and Playwright's `getByTestId` default, so
it serves both jsdom component tests and the app-shot Playwright drive with no extra config).

### Tier 1 — component identity (PascalCase)

Every renderable component stamps its **outermost DOM element** with
`data-testid="<ComponentName>"`, where `<ComponentName>` is the React component's PascalCase name.

```tsx
function ModelAllowlistDialog(...) {
  return <div data-testid="ModelAllowlistDialog" className="...">…</div>
}
```

This makes "what is on screen" a structural fact: dumping the set of `[data-testid]` values present in
the DOM is the rendered-component inventory. It also lines up with the existing test-mock pattern (a
parent's mock of `TaskCard` already asserts `data-testid="TaskCard"`; now the real component matches).

### Tier 2 — interactive parts (dot-namespaced)

Interactive sub-elements that are **not** their own component (buttons, inputs, selects, tabs, toggles,
menu items) get `data-testid="<ComponentName>.<partName>"`, `<partName>` in camelCase naming the
role/action:

```tsx
<input  data-testid="ModelAllowlistDialog.search" … />
<button data-testid="ModelAllowlistDialog.save" … />
<button data-testid="VendorOpencodeSection.addProvider" … />
```

The dot namespace keeps part ids unique per component and self-documenting at the call site.

### Dynamic / repeated instances — stable testid + discriminator

A list row keeps a **stable** testid (the row component/wrapper name) and carries the dynamic identity
in a **separate** `data-id` attribute — never interpolated into the testid string:

```tsx
<div data-testid="OpencodeProviderRow" data-id={provider.id}>…</div>
<div data-testid="SessionItem" data-id={session.sessionId}>…</div>
```

Selectors target the pair: `[data-testid="SessionItem"][data-id="<id>"]`. This keeps the testid set
finite and enumerable (one entry per component type, not per instance) while still allowing a specific
instance to be located.

### Shared control components forward the id

A `data-testid` placed on a custom React component is dropped unless that component forwards it to a
DOM node. Shared controls (`SettingsToggle`, `SettingsSelect`, `SettingsSlider`, `ApprovalButtons`, …)
therefore accept an optional `testid?: string` prop and render it as `data-testid` on their root DOM
element. Callers pass a Tier-2 id; the control forwards it. Never spread `data-testid` onto a component
that doesn't explicitly forward it.

### Rules

- **Stable & semantic.** A testid is part of the verification contract — derived from the component's
  identity/role, never from copy text or styling. Renaming a component updates its testid and any
  selectors that target it.
- **One Tier-1 id per rendered component instance type;** uniqueness of a _specific_ instance comes
  from `data-id`, not from minting per-instance testids.
- **Every DOM-producing render path carries the id** — including `loading` / `empty` / `error` /
  `not-installed` early-return branches, so a component is assertable in those states too (not only
  when fully loaded). Such early returns are mutually exclusive with the main return, so reusing the
  same id never duplicates. Only a literal `return null` is exempt; a loading/empty message _nested
  inside an already-stamped root_ doesn't need its own copy.
- **Kept in all builds.** No production stripping. This is a desktop app (DOM size is a non-issue), the
  app-shot drive runs the _built_ app, and the ids aid remote-support debugging. The earlier ad-hoc
  kebab id (`mockup-console-entries`) is migrated to the convention.
- **Not a styling or behavior hook.** `data-testid` is read-only metadata; never key CSS or logic off
  it.

### Verification tier (app-shot)

`scripts/app-shot.mjs` gains structural probes used **before** the PNG:

- `--testids` — print the sorted set of `[data-testid]` values present (with counts) = the rendered
  inventory.
- `--assert-testid <id>` (repeatable) — exit non-zero if any named id is absent.

The protocol becomes: **assert the expected components/parts by testid first; drive via testid
selectors; read the PNG last** to confirm the visual. The screenshot stays the final visual judge, not
the first resort.

## Consequences

- **"Did it render?" is answerable structurally and cheaply** — a testid dump, not a PNG read. Faster,
  deterministic, and immune to user-data false positives.
- **Robust driving.** `getByTestId` / `[data-testid=…]` selectors replace brittle `text=`/CSS
  selectors (which mis-targeted during the opencode-provider verification).
- **Component tests and the real-app drive share one selector vocabulary** — a testid asserted in a
  jsdom test is the same one app-shot drives.
- **Cost:** every component must self-stamp (a broad, mostly-mechanical sweep) and shared controls grow
  a `testid` prop. Negligible per-component, but it touches most of the renderer — rolled out per the
  ADR-026 loop (one Sonnet agent per area, every line reviewed).

## Alternatives considered

- **Flat kebab-case ids everywhere** (`model-allowlist-dialog`, `…-save`). Rejected: would migrate the
  existing PascalCase mock pattern for no gain; PascalCase ties the id directly to the component name,
  making the rendered inventory self-describing.
- **Interpolating the dynamic id into the testid** (`SessionItem-<uuid>`). Rejected: explodes the
  testid set and makes "is a SessionItem present?" unanswerable without knowing every id; `data-id`
  keeps the type finite.
- **Rely on the existing `text=`/CSS selectors.** Rejected: brittle and ambiguous (the documented
  mis-target), and they don't give a rendered-component inventory.
- **Strip testids in production.** Rejected: breaks the app-shot drive (built app) for no real benefit
  in a desktop app.
