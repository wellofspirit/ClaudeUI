# Bundle Splitting Analysis — Web Build Chunk Warning

Date: 2026-08-13

## Context

The web build (`bun run build:web`) emits a Vite warning: chunks > 500 kB after minification.

The `src/web` client is a **remote-access companion surface**, served by the desktop app's
`RemoteServer` over an E2E-encrypted WebSocket to phones/other devices (ADR-048). It reuses the
desktop renderer tree (`@renderer` alias → `src/renderer/src`), so it pays the full renderer bundle
cost over the wire. It is not a standalone deployment target — nothing in the repo serves `out/web`
standalone.

## Current state (measured after a fresh `bun run build:web`)

Total `out/web`: **5.4 MB / 69 assets**.

| Chunk | Raw | gzip | Note |
|---|---|---|---|
| `App-*.js` | 2,142,566 | 551 KB | renderer app, already lazy-loaded by web shell |
| `cynefin-*.js` | 687,888 | 150 KB | mermaid layout engine |
| `cytoscape.esm-*.js` | 443,036 | 138 KB | mermaid |
| `katex-*.js` | 259,053 | 75 KB | mermaid |
| `index-*.js` | 236,741 | 74 KB | web shell entry |
| `session-store-*.js` | 49,405 | 13 KB | lazy-loaded store |
| CSS `index-*.css` | 87,167 | — | |

Mermaid splits itself into ~45 diagram chunks, but its top-level module is pulled into the
critical path by a static `import mermaid from 'mermaid'` at `src/renderer/src/components/chat/MermaidDiagram.tsx:2`.

Existing code splitting: zero `React.lazy` anywhere in production code. Two dynamic `import()`s in
`src/web/main.tsx` only (App + session-store). The desktop renderer is a 4.1 MB monolithic entry chunk
(10 MB total `out/renderer`).

## Two cost models, one source tree

1. **Web/remote build** — downloads the bundle. Size and count of chunks in the critical path matter.
2. **Desktop renderer** — reads from local disk. Size is irrelevant; only **parse/execute at startup** matters.

The warning is emitted for the web build, but the heavy libs are in the initial critical path for both.

## Why `manualChunks` is the wrong tool

The warning's suggestion (`build.rollupOptions.output.manualChunks`) only relabels file boundaries.
With a static `import mermaid from 'mermaid'`, rollup evaluates mermaid eagerly at startup regardless
of chunk layout. Splitting into a `mermaid.js` chunk changes nothing about when it is parsed or
downloaded — it just silences the warning. On desktop, a 4.1 MB monolith vs. three 1.4 MB chunks
parses identically fast.

## What actually helps: deferral, not splitting

Heavy deps pulled by the entry tree, each used conditionally:

| Dep | Site | gzip-ish weight | Needed when |
|---|---|---|---|
| mermaid | `MermaidDiagram.tsx` | ~3.5 MB raw / ~1.3 MB gzip of chunks | a message contains a diagram |
| xterm | `XTermInstance.tsx` | large (core + fit addon) | a terminal pane is open |
| qrcode | `RemoteAccessModal.tsx` | small but zero-use-case-gated | the remote-access modal opens |
| prism-react-renderer | `CodeView.tsx`, `highlight.ts` | ~40 KB | not worth touching |

Fix: `React.lazy` / dynamic import at component boundaries so each module is fetched **and parsed**
only on first use. Mermaid is the dominant win: `await import('mermaid')` inside the render path.

## Expected impact

- **Web**: first load drops from ~2.4 MB to ~640 KB of gzip-of-chunks. Major for mobile.
- **Desktop**: startup parse time drops meaningfully (10 MB total tree).
- Common case costs nothing extra: diagrams arrive mid-stream, so the dynamic import resolves during
  message streaming, before the diagram card paints. First-ever diagram shows a skeleton briefly —
  the only UX trade-off.

## Recommendation

1. Lazy-load mermaid (highest ROI, one file).
2. Lazy-load xterm and qrcode if the panes are not always mounted (quick wins — verify mount
   conditions first).
3. Do **not** add `manualChunks`. After deferral, the remaining large chunk is the app shell itself,
   which is genuinely all critical path and doesn't deserve splitting. If the warning persists,
   adjust `chunkSizeWarningLimit` with that reasoning, not as a blanket silence.

## Open questions / to verify before implementing

- Is `XTermInstance` mounted unconditionally, or only when a terminal panel is opened?
- Is `RemoteAccessModal`'s QR rendered before user interaction?
- Mermaid theme handling (`mermaid.initialize`) must be preserved under the dynamic import —
  the render function becomes async at the call site.
- Loading/skeleton UX for the first diagram (Suspense boundary or per-card state).
