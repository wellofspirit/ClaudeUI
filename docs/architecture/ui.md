# Views, design & gotchas

Part of [architecture/](README.md).

## Views & design

Four main views via the sidebar: **Chat**, **Usage** (5h blocks, daily charts, per-model/per-engine breakdown, delegated section), **Automations**, **Plugin** (embedded WebView). Three themes (dark/light/monokai) as CSS custom properties in `app.css`'s `@theme` block. Transparent window (`vibrancy` on macOS, acrylic on Windows). Resizable sidebar + main area + optional right panel (git/tasks/plan) + bottom terminal panel that is **always mounted** (`display: none`/`contents`) to preserve xterm scrollback (ADR-002).

Mobile/remote surfaces follow the content-slot takeover pattern (ADR-048).

## Gotchas

- **Tailwind v4 reset** — never add `* { margin: 0; padding: 0 }` after `@import "tailwindcss"` in `app.css`; it lands after the utility layer and silently kills padding/margin utilities. Preflight already handles it.
- **Tailwind source scanning** — the `@source` directives at the top of `app.css` (`"../../"` for the renderer, `"../../../web"` for the web client) are required for the scanner to find both source trees.
- **One UI build, one stylesheet** — electron-vite builds the renderer once into `out/renderer` (`index.html`, `log-viewer.html`, `web.html`, shared hashed chunks); `RemoteServer` serves `web.html` and `/assets/*` from that same directory, and the build writes the `.br`/`.gz` siblings itself. `src/renderer/src/assets/app.css` is the only Tailwind root and holds every rule; both `main.tsx` entries import it. The few platform differences (transparent Electron window vs. a solid browser-tab background) are `html[data-shell='desktop'|'web']` rules in `app.css`, keyed on the attribute each HTML entry sets. `single-stylesheet.unit.test.ts` fails when a second Tailwind root appears or an entry drops its `data-shell`. The build is minified with linked source maps that ship and are served like any other asset (the repo is public); DevTools applies them, but `Error.stack` stays minified, so `node scripts/decode-stack.mjs` decodes log stacks against them.
- **Electron transparency** — needs `transparent: true` + `vibrancy` on the BrowserWindow **and** transparent backgrounds on html/body/#root; any opaque background in the tree blocks it.
- **Usage utilization scales** — the `/api/oauth/usage` API returns 0–100, rate-limit headers return 0–1; both are stored as 0–100 in `RateWindow.usedPercent` (`toUsedPercent()` in usage-fetcher.ts).
- **Dev main-process staleness** — hot reload updates the renderer only; main-process changes need an app restart, or you get new UI labels over old main logic.
