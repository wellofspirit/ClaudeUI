# Views, design & gotchas

Part of [architecture/](README.md).

## Views & design

Four main views via the sidebar: **Chat**, **Usage** (5h blocks, daily charts, per-model/per-engine breakdown, delegated section), **Automations**, **Plugin** (embedded WebView). Three themes (dark/light/monokai) as CSS custom properties in `app.css`'s `@theme` block. Transparent window (`vibrancy` on macOS, acrylic on Windows). Resizable sidebar + main area + optional right panel (git/tasks/plan) + bottom terminal panel that is **always mounted** (`display: none`/`contents`) to preserve xterm scrollback (ADR-002).

Mobile/remote surfaces follow the content-slot takeover pattern (ADR-048).

## Gotchas

- **Tailwind v4 reset** — never add `* { margin: 0; padding: 0 }` after `@import "tailwindcss"` in `app.css` or an entry stylesheet; it lands after the utility layer and silently kills padding/margin utilities. Preflight already handles it.
- **Tailwind source scanning** — the `@source "../../";` directive in main.css is required for the scanner to find renderer sources.
- **One stylesheet for both clients** — every rule lives in `src/renderer/src/assets/app.css`. The entry files (`src/renderer/src/assets/main.css` for desktop, `src/web/main.css` for the web client) hold only the Tailwind import, `@source` lines, the `app.css` import, and their platform `html`/`body`/`#root` background rules (desktop is transparent for vibrancy/acrylic, web is solid). `main-css-entries.unit.test.ts` fails when a feature rule lands in an entry file.
- **Electron transparency** — needs `transparent: true` + `vibrancy` on the BrowserWindow **and** transparent backgrounds on html/body/#root; any opaque background in the tree blocks it.
- **Usage utilization scales** — the `/api/oauth/usage` API returns 0–100, rate-limit headers return 0–1; both are stored as 0–100 in `RateWindow.usedPercent` (`toUsedPercent()` in usage-fetcher.ts).
- **Dev main-process staleness** — hot reload updates the renderer only; main-process changes need an app restart, or you get new UI labels over old main logic.
