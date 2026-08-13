# Bundle Splitting Analysis — v4

Verdict on the `[web build]` chunk-size warning: **split, yes — but for the right reason, and only two targeted splits are worth doing.** `manualChunks` is not.

## Why the warning threshold doesn't matter here

This is an Electron app; the renderer loads over `file://` from disk. There is no network download, no HTTP compression, no cache-granularity concern. Chunk size only affects:

- parse + compile time at window startup
- idle renderer memory

The `500 kB` threshold in the Vite warning is a web-app heuristic. Ignore it (or silence it with `chunkSizeWarningLimit`).

## Current bundle composition (measured from `out/renderer/assets`)

Entry chunk `index-*.js` is **4.1 MB minified**, with **zero `React.lazy`** anywhere in the renderer — everything is eager.

| Contributor | Est. size | Import path |
|---|---|---|
| `mermaid` core + `d3` + `dagre` | ~1–1.5 MB | `MermaidDiagram.tsx:2` → `DiagramBody` → tool registry |
| `@xterm/xterm` + addon-fit | ~400 KB | `SessionView.tsx:13` → `TerminalPanel` (eager even though panel is collapsed by default) |
| `react-markdown` + remark/rehype/unified stack | ~300 KB | `MarkdownRenderer.tsx:2` — genuinely on the critical path (every message) |
| react + react-dom | ~180 KB | `main.tsx` |
| `dompurify`, `prism-react-renderer`, `diff`, app code | rest | various |

Already lazy, courtesy of mermaid's internal `import()`:

- `cynefin` (1.3 MB), `cytoscape` (960 KB), `katex` (480 KB) — loaded only when that diagram type renders.

So the *diagram-type* chunks are already deferred; it's the mermaid **core** that bloats the entry.

## Recommendation

1. **`React.lazy` the `MermaidDiagram`** (usage site in `DiagramBody`), with a Suspense fallback.
   Mermaid core + d3 + dagre + in-component `prism-react-renderer` leave the entry and load only when a tool result is actually a diagram. Biggest single win — ~1–1.5 MB off the eager parse.

2. **`React.lazy` the `TerminalPanel`** (`SessionView.tsx:13`).
   xterm is only needed when the panel is opened; ~400 KB of eager cost for a collapsed-by-default panel.

3. **Don't touch `react-markdown`.** It's on the critical path by nature; splitting adds a Suspense boundary around every message for zero startup benefit.

4. **Skip `manualChunks`.** It optimizes cache/parallel-download behavior that doesn't exist in this model. It would only reshuffle the same eager bytes.

**Expected payoff:** ~1.5–2 MB of a 4.1 MB eager bundle deferred — roughly 150–300 ms of startup parse on typical hardware, plus lower idle memory. Real but not night-and-day; startup is likely dominated by engine spawn + config hydration.

## Caveats

- Dynamic `import()` under `file://` is already proven in this exact app (mermaid's own diagram chunks), so CSP / electron-vite are not a concern.
- Tests import `MermaidDiagram` directly — keep the named export and wrap only the usage site.
- Watch the Suspense fallback flash for diagram cards; keep it small.
