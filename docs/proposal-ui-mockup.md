# UI Mockup Preview — Proposal

Two complementary solutions for previewing UI mockups within ClaudeUI, unified by a shared file-backed architecture: an HTML-based approach for quick prototyping, and a React-based approach for interactive, stateful prototypes.

---

## Core Architecture: File-Backed Mockups

Both solutions share a persistent, file-backed model. Mockups live on disk in the project repo, enabling delta modifications instead of full regeneration.

### Mockup Directory

```
<project-root>/.claude/ui/mockups/
  <random-id>/          # e.g., a3f8c1d2/
    index.html          # Solution 1: HTML mockup entry point
    App.jsx             # Solution 2: React mockup entry point (future)
    Header.jsx          # Solution 2: additional components (future)
```

- **Per-repo** — mockups are project-scoped, can be committed if desired
- Each mockup gets a random directory name (8-char hex)
- `.claude/ui/mockups/` should be gitignored by default (add to `.gitignore` recommendation on first use)

### MCP Tools

**Tool 1: `create_mockup`**

```
create_mockup(html: string, title?: string) → { directory: string, path: string }
```

- Creates `.claude/ui/mockups/<random-id>/`
- Writes `index.html` with the passed HTML body wrapped in a Tailwind-enabled template
- Returns the directory name so Claude can reference it for future edits
- Renders as a preview card in chat

**Tool 2: `show_mockup`**

```
show_mockup(directory: string) → renders current state from disk
```

- Reads `.claude/ui/mockups/<directory>/index.html` (or entry file)
- Renders the same preview card as `create_mockup`
- Used after Claude has made several `Edit` tool calls and wants to show the updated result

**Modifications**: Claude uses its standard `Edit` tool on `.claude/ui/mockups/<id>/index.html` for delta changes. No special update tool needed — just normal file editing, which is token-efficient and leverages Claude's existing edit capabilities.

### Workflow

```
1. User: "Mock up a settings page"
2. Claude calls create_mockup(html, title="Settings Page")
   → creates .claude/ui/mockups/a3f8c1d2/index.html
   → returns { directory: "a3f8c1d2", path: ".claude/ui/mockups/a3f8c1d2" }
   → chat shows preview card
3. User: "Make the sidebar narrower and add a save button"
4. Claude uses Edit tool on .claude/ui/mockups/a3f8c1d2/index.html
   → targeted diff, not full regeneration
5. Claude calls show_mockup(directory="a3f8c1d2")
   → chat shows updated preview card
```

---

## Solution 1: HTML Mockup (Quick Prototyping)

### Goal

Fast visual mockups with zero build step. Claude generates HTML + Tailwind, rendered in a sandboxed iframe. Modifications are surgical file edits.

### Styling: Bundled Tailwind CSS

Bundle a **full pre-built Tailwind CSS** stylesheet (~300KB minified) as a static asset. No CDN, no JIT, no trimming.

Rationale:
- **ClaudeUI already uses Tailwind** — mockup utility classes match real app code exactly
- **Zero mockup→implementation gap** — `class="flex gap-4 p-6"` in the mockup becomes `className="flex gap-4 p-6"` in JSX, done
- **No component library mismatch** — no third-party classes to rewrite when shipping
- **Claude generates Tailwind extremely well** — better than any component library
- **300KB in a 300MB desktop app is noise** — no need to optimize
- **Zero maintenance** — no custom builds, no pruning, just drop the file in

The `create_mockup` tool wraps the user's HTML in a template that includes the bundled Tailwind CSS via `<style>` injection in the iframe's `srcdoc`. The on-disk `index.html` contains only the user's markup — the Tailwind CSS wrapper is applied at render time.

### Rendering

**Inline (chat)**: Sandboxed iframe using `srcdoc`, fixed preview height (~300px), with title bar showing the mockup title and buttons:
- **Expand** — opens in right panel
- **Copy HTML** — copies the raw HTML to clipboard
- **Open directory** — reveals the mockup directory in finder/explorer

Sandbox attributes: `sandbox` only (no `allow-scripts` needed — pure CSS, no JS).

**Expanded (right panel)**: New right panel mode `rightPanel: 'mockup'`. Full-height iframe with:
- Device frame toggle: mobile (375px) / tablet (768px) / desktop (100%)
- Zoom controls
- "Copy HTML" button
- Theme toggle (light/dark via Tailwind `dark:` variants)

### Architecture

```
create_mockup(html, title)
  → mockup-tool.ts:
    1. Generate random 8-char hex ID
    2. mkdir .claude/ui/mockups/<id>/
    3. Write index.html with the HTML content
    4. Return { directory: id, path: "..." }
  → Tool result in chat → MockupPreviewCard
    → Read index.html from disk
    → Wrap in srcdoc template with inlined Tailwind CSS
    → Render sandboxed iframe
    → Expand button → setRightPanel('mockup') + store mockup directory in session state

show_mockup(directory)
  → mockup-tool.ts:
    1. Verify .claude/ui/mockups/<directory>/index.html exists
    2. Return { directory, path: "..." }
  → Same rendering path as create_mockup

Edit tool on index.html (standard Claude behavior)
  → File changes on disk
  → show_mockup() to display updated state
```

### New Files

| File | Purpose |
|------|---------|
| `src/main/services/mockup-tool.ts` | MCP tool server (`create_mockup`, `show_mockup`) |
| `src/renderer/src/components/chat/MockupPreviewCard.tsx` | Inline chat card with iframe preview |
| `src/renderer/src/components/MockupPanel.tsx` | Right panel full-size preview with device frames |
| `src/renderer/src/assets/tailwind-full.css` | Pre-built full Tailwind CSS (static asset) |

### Store Changes

```ts
// session-store.ts additions
rightPanel: 'none' | 'task' | 'git' | 'plan' | 'mockup'
mockupDir: string | null          // current expanded mockup directory ID
mockupTitle: string | null
```

### Pros
- Token-efficient — initial creation + surgical edits, no full regeneration
- Persistent on disk — survives session restarts, browsable in file explorer
- Tailwind classes translate directly to real implementation
- No network dependency — everything bundled locally
- Simple mental model — it's just files

### Cons
- Limited interactivity (no JS in sandbox — pure visual mockups)
- Requires `show_mockup` call after edits to refresh the preview (no live file watching in Phase 1)

---

## Solution 2: React Live Preview (Future — Phase 2)

### Goal

Claude writes React + Tailwind JSX files to the same mockup directory structure. The app renders them live with hot-reload-like behavior. Supports stateful interactive prototypes, component composition, and version control.

### Delivery Mechanism

Same directory structure as Solution 1, but with `.jsx`/`.tsx` files instead of (or alongside) `index.html`:

```
.claude/ui/mockups/<id>/
  App.jsx              # Entry component
  Sidebar.jsx          # Additional components
  index.html           # Optional: HTML version for quick preview
```

`create_mockup` gains a `mode: 'html' | 'react'` parameter. React mode writes `App.jsx` as the entry point.

### Runtime

**react-live** (MIT, by Formidable Labs):
- Takes JSX string → transpiles with Sucrase → renders in React tree
- ~200KB added dependency (Sucrase)
- Built-in error boundary — bad JSX shows error message, not crash
- Supports `useState`, `useEffect`, `useRef` out of the box

### Scope & Context

Provide a curated scope of available components/hooks to the renderer:

```ts
const scope = {
  useState, useEffect, useRef, useCallback, useMemo,
  // Our Tailwind is already available (rendered in our React tree)
};
```

Since this renders in our React tree, our own Tailwind styles apply — no separate CSS bundle needed. The mockup looks and behaves exactly like the real app would.

### Rendering

**Inline (chat)**: Same `MockupPreviewCard`, but using react-live renderer instead of iframe when mode is `react`.

**Right panel**: Extends `MockupPanel` with:
- Code editor pane (side-by-side or toggle) for manual tweaks — changes render live
- Component file selector (if multiple files in mockup dir)
- File watcher — edits from Claude or external editor trigger re-render

### New Dependencies

| Package | Size | Purpose |
|---------|------|---------|
| `react-live` | ~50KB | JSX string → live React render |
| `sucrase` | ~200KB | Fast JSX transpilation (peer dep of react-live) |

### New Files (Phase 2 additions)

| File | Purpose |
|------|---------|
| `src/main/services/mockup-watcher.ts` | File watcher for mockup directory |
| `src/renderer/src/components/MockupEditor.tsx` | Code editor pane for live editing |
| `src/renderer/src/lib/mockup-scope.ts` | react-live scope definition |

### Store Changes (extends Phase 1)

```ts
mockupMode: 'html' | 'react'     // which renderer to use
mockupFiles: string[]             // list of files in current mockup dir
mockupActiveFile: string | null   // currently selected file in editor
```

### Pros
- Stateful interactive prototypes (useState, effects)
- File-backed = persistent, version-controlled, editable in external tools
- Uses our own Tailwind — styling is 1:1 with real app
- Live editing in the panel — user and Claude can both iterate
- Composable — can build multi-component prototypes

### Cons
- More complex implementation
- react-live has limitations (no imports, single-file scope)
- Need to define and maintain the component scope

---

## Implementation Order

### Phase 1: HTML Mockup (file-backed)
1. Generate and bundle full Tailwind CSS as static asset
2. `mockup-tool.ts` — MCP tool server with `create_mockup` + `show_mockup`
3. `MockupPreviewCard.tsx` — inline chat card with sandboxed iframe + inlined Tailwind
4. Right panel `mockup` mode with device frame toggles
5. Store additions for mockup state

### Phase 2: React Live Preview
1. Add `react-live` + `sucrase` dependencies
2. Extend `create_mockup` with `mode: 'react'`
3. `MockupEditor.tsx` — code editor with live preview
4. `mockup-watcher.ts` — file watcher for live reload
5. Define component scope (`mockup-scope.ts`)
6. Extend right panel with code editor + file selector

### Phase 3: Polish
1. Device frame presets with smooth transitions
2. Export mockup as standalone HTML / React component
3. Mockup history — browse previous mockup directories
4. Live file watching for HTML mode (auto-refresh on edit without `show_mockup`)
5. Optional: component library panel (browse available primitives)
