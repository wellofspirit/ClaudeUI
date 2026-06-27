# Kickoff — `data-testid` rollout across the renderer

**Goal.** Attribute every renderer component with `data-testid` per **ADR-027** so the rendered UI is
structurally assertable (and driveable by stable selectors) before screenshot verification.

**You are a Sonnet implementer under the ADR-026 workflow.** Do **NOT** commit, `git add`, create
branches, or run `bun install`/`add`/`remove`. Make the edits, run the verify gates, and report your
deltas + exact gate output + any deviation. The main model reviews every line.

---

## Convention (ADR-027) — apply exactly

### Tier 1 — component identity (PascalCase), on every component

Stamp each component's **outermost DOM element** with `data-testid="<LogicalComponentName>"`.

- `<LogicalComponentName>` = the component's **logical** PascalCase name — i.e. the name you'd import
  it by — **not** the filename when they differ. This codebase uses a container/View split:
  `Foo/Foo.tsx` (container, wires hooks) renders `Foo/View.tsx` (the DOM). The **View** carries the
  testid, named after the **logical component** (`Foo`), NOT `"View"`.
  - Example: `git/GitCommitBox/View.tsx` root → `data-testid="GitCommitBox"`.
  - If the container (`Foo/Foo.tsx`) renders its own wrapper DOM around `<View/>`, leave the id on the
    View only (one id per logical component). If the container is the only one with a root element
    (no separate View), put it there.
- The outermost element must be a real **DOM element** (`div`, `button`, `section`, …). If the
  component's root is another React component (e.g. it returns `<SomeChild .../>`), pass the id via
  that child's `testid` prop if it forwards one (see Tier 3); otherwise wrap is NOT allowed if it
  changes layout — instead stamp the nearest DOM element the component itself renders. If a component
  returns a Fragment with multiple roots, stamp the most meaningful single child (the primary
  container), not every child.
- A component that returns `null` in a branch gets no id in that branch (fine).
- **Conditional / Fragment roots:** if a component returns a Fragment whose children are
  *mutually-exclusive conditional* sections (e.g. `{!hideInput && <div…>}` then `{showResult &&
  <div…>}`), make sure **exactly one rendered element carries the Tier-1 id in every render path** —
  not just the first child. Use a conditional id on the secondary element, e.g.
  `data-testid={hideInput ? 'FooBody' : undefined}`, so the id is present whether the first child
  rendered or not, but never duplicated when both render.

### Tier 2 — interactive parts (dot-namespaced)

Interactive sub-elements that are **not** their own component — buttons, inputs, selects, textareas,
tabs, toggles, menu items, clickable rows — get `data-testid="<ComponentName>.<partName>"`, `partName`
in camelCase naming the role/action:

```tsx
<button data-testid="GitCommitBox.commit">Commit</button>
<input  data-testid="ChatSearchOverlay.query" … />
<button data-testid="TopBar.newSession" … />
```

Cover the **primary** interactive controls of each component (the ones a test/drive would click or
type into). You don't need an id on every decorative `<span>` — focus on actionable elements and key
state-bearing nodes.

### Tier 3 — dynamic / repeated instances

A repeated row keeps a **stable** Tier-1 testid (the row's logical name) and puts the dynamic identity
in a **separate** `data-id` attribute — never interpolate the id into the testid string:

```tsx
{sessions.map((s) => (
  <div key={s.sessionId} data-testid="SessionItem" data-id={s.sessionId}>…</div>
))}
```

Selectors target the pair `[data-testid="SessionItem"][data-id="<id>"]`. Pick the natural stable id
(session id, provider id, file path, branch name, automation id, model value, …).

### Shared controls — forward, don't drop

A `data-testid` set on a custom React component is dropped unless that component forwards it to a DOM
node. For shared controls **inside your area** (e.g. an area-local button component), add an optional
`testid?: string` prop and render it as `data-testid` on the control's root DOM element; callers pass a
Tier-2 id. **Do NOT edit files outside your assigned list** — the cross-area shared controls
(`components/shared/*`) are handled separately and already forward a `testid` prop; just pass it.

---

## Hard constraints (out of scope — do NOT do)

- **No behavior, styling, layout, or logic changes.** This is attribute-only. Do not rename anything,
  reorder JSX, change classes, refactor, "improve", or touch hooks/handlers. The *only* deltas are
  added `data-testid` / `data-id` attributes and (where needed for a shared control inside your list)
  an optional `testid?` prop threaded to a DOM node.
- **Do not add a wrapping element** that changes the DOM structure/layout to host a testid. Use an
  element the component already renders.
- **Do not touch files outside your assigned list**, any `__tests__/`, or `components/shared/*`.
- **Do not remove or rename the existing `data-testid`s** (they may be relied on by tests). If a real
  component already has one, leave it; if it's ad-hoc kebab and trivially the component name, you may
  align it to the PascalCase convention ONLY if no test references the old value (grep first).
- Keep TypeScript happy: `data-testid` / `data-id` are valid on intrinsic DOM elements; a `testid`
  prop you add to a control must be typed in its props interface.

---

## Verify gates (run, report exact output)

```
bun run typecheck
bun run lint
bun run test
```

- typecheck: 0 errors.
- lint: 0 errors (pre-existing `exhaustive-deps` warnings in Sidebar/ExitPlanModeCard/ReviewBar are OK
  — do not introduce new warnings).
- test: all pass. If a snapshot/DOM test breaks because you stamped an id, the test was asserting on
  structure — STOP and report it (do not edit tests to make them pass).

Report: the list of files touched, a one-line note per component of the Tier-1 id you assigned, the
Tier-2 ids added, any component where the root was ambiguous (and your choice), and the exact gate
output. Do not commit.

---

## Naming reference (use these for the ambiguous ones)

- Container/View pair → the directory name (logical component): `GitCommitBox`, `GitFileTree`,
  `GitBranchDropdown`, `AutomationConfig`, `PlanReviewPanel`, `TerminalPanel`, `WelcomeScreen`,
  `WindowControls`, `TaskDetailPanel`, `SettingsDialog`, `PermissionsDialog`, `McpDialog`,
  `SkillsDialog`, `RemoteAccessModal`, `WorktreesModal`, `MockupPanel`, `ChatSearchOverlay`,
  `InputBox`, `ExitPlanModeCard`, `AskUserQuestionBlock`, `MockupPreviewCard`, `ReviewBar`, `GitPanel`.
- `settings-sections.tsx` exports many section sub-components (e.g. `VendorOpencodeSection`,
  `OpencodeModelsSection`, `ModelAllowlistDialog`, `OpencodeProvidersSection`, `OpencodeAgentsSection`,
  `VendorAnthropicEditableForm`, `OpencodeAutoModeSection`) — stamp each with its own function name.
- Tool-kind bodies → their component name: `CommandBody`, `DiagramBody`, `FileEditBody`,
  `FileReadBody`, `FileWriteBody`, `GenericBody`, `MockupBody`, `ExpandableText`, `BashOutput`
  (`bash-output.tsx`).
