# ADR-099: The desktop and web clients are one UI build

**Status:** Accepted (2026-10-07). Built on branch `one-ui-bundle`, verified on the dev build, a
packaged `build:unpack` (the web client served from inside `app.asar`) and the headless bundle.
**Amends:** [ADR-058](adr-058_core-extraction-and-claudeui-server.md) §5 and
[ADR-061](adr-061_ci-build-gates-and-release-artifact-matrix.md) (the headless layout carries
`out/renderer`, not `out/web`; no CI step builds the web client separately),
[ADR-008](adr-008_typecheck-remote-web-client.md) (its `build:web` / `vite.web.config.ts` no longer
exist; the type-check it adds is unchanged), [ADR-095](adr-095_sidebar-status-dot-ripple.md) (the
shared `app.css` its rules live in).

## Context

The UI was built twice. electron-vite built the desktop renderer into `out/renderer`; a second Vite
project, `vite.web.config.ts`, built the remote web client into `out/web`, which electron-builder
shipped separately as `resources/web` and `RemoteServer` served. The second build dates from the
first remote-control feature, when the web client was a side project.

Nothing in either build was platform-specific. Both ran the same `react()` and `tailwindcss()`
plugins over the same `@renderer` tree with the same alias; neither had a `define` or an env flag. The
shared code decides its platform at runtime (`isWebClient()` is `window.api?.platform === 'web'`). The
genuine differences were all at the edges: the startup script (preload IPC and the desktop sync port,
or a WebSocket adapter plus the password, passkey, enrolment and step-up flows), the HTML (a CSP meta
for `file://` and a desktop iframe scheme, or a viewport tuned for phones, with the CSP sent as headers),
and the page background (transparent for Electron's vibrancy or acrylic window, solid in a browser tab).

Two builds of one app drifted the way two copies drift:

- **The stylesheet.** `src/web/main.css` was a hand-kept copy of the renderer's. By 2026-10-07 the web
  client lacked the find-in-chat highlights and flash, the agent-type colour tokens (ADR-094), the
  session icon backdrop, the slide-in animation and every status-dot rule (ADR-095), so the web dot was
  transparent. A shared `app.css` imported by two entry stylesheets fixed the content but not the
  structure: each entry was still its own Tailwind root and compiled its own copy.
- **The pipeline.** The release workflows built the web client with a raw `vite build` and never ran
  `compress-web-assets.mjs`, so every released desktop app served uncompressed JS to phones; only local
  package targets and the headless leg compressed.
- **Staleness.** `bun run build` did not rebuild `out/web`, so a verification against the web client
  could silently test yesterday's bundle.

## Decision

**One renderer build serves both clients.** electron-vite's renderer build has three HTML inputs:
`index.html` (desktop), `log-viewer.html` (desktop) and `web.html` (the web client, whose script is
`src/web/main.tsx`). Rollup splits shared chunks across all three, so the desktop and web pages
reference the same hashed JS chunks and the same CSS file. There is no `out/web`, no
`vite.web.config.ts` and no `build:web`.

**One stylesheet.** `app.css` is the only Tailwind root; both startup scripts import it. The one
platform difference, the page background, is keyed on `<html data-shell="desktop|web">`, set
statically in each HTML file, so it sits where the other platform differences (CSP, viewport) already
live and no per-platform CSS file exists. A unit test fails if a second file imports Tailwind or an
entry stops importing `app.css`.

**`RemoteServer` serves `out/renderer`.** In dev and in a packaged app alike: packaged, that is
`app.asar/out/renderer`, which the server reads through Electron's asar-aware `fs` because it runs in
the main process. It serves `web.html` at `/` and `/remote` and only `/assets/*` besides, confined to
the `assets` directory (with a separator, so a sibling sharing the prefix cannot pass), so the desktop
`index.html` and `log-viewer.html` beside it are never reachable over HTTP. The old catch-all for any
`.js`/`.css` path is gone.

**Compression is part of the build.** A renderer-build plugin writes the `.br`/`.gz` siblings into
`out/renderer/assets` after every build, so every path (local, CI, release) ships them.

**Minified, with linked source maps.** electron-vite leaves the renderer unminified by default, which
was fine for a `file://` load; now the same chunks go to phones, so the build minifies (the App chunk
is 389 kB brotli minified, 545 kB not). Desktop stacks become minified as web ones already were, so
the build emits linked source maps that ship and are served like any other asset: the repository is
public, so a map reveals nothing that is not already published, and DevTools only fetches one while it
is open. Chromium never applies maps to `Error.stack`, so stacks that reach the logs stay minified;
`scripts/decode-stack.mjs` rewrites them against the maps (a packaged app's are inside `app.asar`).

**The headless server copies `out/renderer`.** `build-server.mjs` stages it beside the bundle or
executable, and `resolveAppPath()` looks for `out/renderer/web.html`.

## Alternatives considered

- **One HTML page that picks its platform at runtime**, lazy-loading the desktop or web startup code.
  Fewer files, but a single CSP meta would have to allow what either platform needs (`ws:`/`wss:` for
  web, the mockup scheme for desktop), weakening both; doing it properly means moving desktop from
  `file://` to a custom protocol that sends per-platform headers. A larger change for no gain over
  separate HTML entries, which keep each platform's CSP declarative.
- **Keep two builds and share only the stylesheet.** The state on 2026-10-07 morning. It stops CSS
  drift but keeps two pipelines that can drift, the duplicate package payload and the stale-bundle trap.

## Consequences

- The package no longer carries `resources/web` (about 9.4 MB). The linked maps add about 22 MB inside
  the asar (about 4 MB once the installer compresses them), and `out/renderer` gains the compressed
  siblings. A web client's first load is unchanged (95 kB → 96 kB brotli, two requests → four), and the
  shared App chunk is byte-for-byte the size the separate web build produced.
- `electron-builder.yml` keeps excluding `out/web/**`, so a stale pre-one-bundle `out/web` left in an
  old checkout cannot ride into the asar (it did, in the first packaged test).
- Each client's bundle includes the other's startup chunks. They are lazy or entry-only and never
  loaded by the other client; the cost is bytes on disk.
- In dev, the web client is still served from the BUILT `out/renderer` (`bun run build`), not from the
  Vite dev server. Proxying the dev server would give the web client hot reload, but its HMR socket does
  not survive a phone on the LAN; left as a follow-up.
- A hand-assembled headless layout with `out/web` stops resolving. Layouts produced by
  `build-server.mjs` regenerate on the next build.
- A stale `out/web` left in a checkout is inert: nothing reads it.
