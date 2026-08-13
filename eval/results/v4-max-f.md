# Findings — Should We Split Bundles?

Date: 2026-08-13

## Context

`bun run build:web` emits a Vite warning: chunks > 500 kB after minification. The question asked:
does it make sense to code-split?

The `src/web` client is a **remote-access companion surface** served by the desktop app over an
E2E-encrypted WebSocket to phones/other devices. It reuses the desktop renderer tree via the
`@renderer` alias (`vite.web.config.ts:10`), so it pays the full renderer bundle cost over the wire.

## Measured state (fresh `build:web` + `build`)

`out/web`: **5.4 MB / 69 assets**. `out/renderer` (Electron): **10 MB** total, main entry 3.9 MB.

| Chunk | Raw | gzip | Note |
|---|---|---|---|
| `App-*.js` (web) | 2,142,566 | 551 KB | entire renderer App, lazy-loaded by web shell |
| `cynefin-*.js` | 687,888 | 150 KB | mermaid layout engine |
| `cytoscape.esm-*.js` | 443,036 | 138 KB | mermaid |
| `katex-*.js` | 259,053 | 75 KB | mermaid |
| `index-*.js` | 236,741 | 74 KB | web shell entry |
| `index-*.js` (renderer) | 3,900,000 | — | desktop monolith |

Mermaid already code-splits itself into ~45 diagram chunks (cynefin, cytoscape, katex, per-diagram
definitions) — the good kind of splitting, already happening. But its top-level module is in the
critical path because `MermaidDiagram.tsx:2` does a static `import mermaid from 'mermaid'`.

Zero `React.lazy` anywhere in `src/renderer/src`. The only dynamic `import()`s in the codebase are in
`src/web/main.tsx` (App + session-store).

## Key finding: two cost models, one source tree

1. **Web/remote** — downloads the bundle over HTTP(S). Critical-path size and chunk count matter.
2. **Desktop renderer** — reads from local disk. Size is irrelevant; only startup parse/execute matters.

The warning fires on the web build, but the heavy libs sit in the initial critical path for **both**.

## Key finding: `manualChunks` is the wrong tool

The warning's own suggestion (`manualChunks`) only relabels file boundaries. With a static
`import mermaid from 'mermaid'`, rollup evaluates mermaid eagerly at startup regardless of chunk
layout. A `mermaid.js` chunk silences the warning but changes nothing about when the code is parsed
or downloaded. On desktop, a 4.1 MB monolith vs. three 1.4 MB chunks parses identically fast.

The exception that proves the rule: a plain `vendor` split for react/react-dom/zustand is the *only*
manual chunking that helps (stable hash → long-lived browser cache). Feature-carved manual chunks are
misguided — that job belongs to `React.lazy`.

## Key finding: deferral beats splitting

Heavy deps pulled in by the entry tree, each used conditionally:

| Dep | Site | Weight | Needed when |
|---|---|---|---|
| mermaid | `MermaidDiagram.tsx` | ~1.3 MB gzip of chunks | a message contains a diagram |
| xterm | `XTermInstance.tsx` | core + fit addon | a terminal pane is open |
| qrcode | `RemoteAccessModal.tsx` | small | remote-access modal opens |
| prism-react-renderer | `CodeView.tsx` | ~40 KB | not worth touching |

Fix: `React.lazy` / dynamic `import()` at component boundaries so each module is fetched **and
parsed** only on first use. Mermaid is the dominant win — `await import('mermaid')` inside the
render path.

## Expected impact

- **Web**: first load drops from ~2.4 MB to ~640 KB of gzip-of-chunks. Major for mobile.
- **Desktop**: startup parse time drops meaningfully (10 MB total tree).
- **One investment, two wins**: because the web build reuses renderer components, every lazy boundary
  added in renderer land automatically applies to the web client too.
- Common case costs nothing extra: diagrams arrive mid-stream, so the dynamic import resolves during
  message streaming before the diagram card paints. First-ever diagram shows a skeleton briefly — the
  only UX trade-off.

## Recommendation

1. Lazy-load mermaid (highest ROI, one file).
2. Lazy-load xterm and qrcode if the panes are not always mounted (verify mount conditions first).
3. Do **not** add `manualChunks`. After deferral, the remaining large chunk is the app shell itself —
   genuinely all critical path. If the warning persists, adjust `chunkSizeWarningLimit` with that
   reasoning, not as a blanket silence.
4. Leave the Electron renderer monolith unsplit — file:// load makes it a non-issue.

## Open questions / to verify before implementing

- **Cache headers on the tunnel/remote-server**: do served assets get long-cache / HTTP2 settings that
  would make chunk-splitting actually pay off on repeat visits? (Needs checking in `remote-server.ts`
  before committing to the plan.)
- Is `XTermInstance` mounted unconditionally, or only when a terminal panel is opened?
- Is `RemoteAccessModal`'s QR rendered before user interaction?
- Mermaid theme handling (`mermaid.initialize`) must be preserved under the dynamic import — the
  render function becomes async at the call site.
- Loading/skeleton UX for the first diagram (Suspense boundary or per-card state).
