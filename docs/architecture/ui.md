# Views, design & gotchas

Part of [architecture/](README.md).

## Views & design

Four main views via the sidebar: **Chat**, **Usage** (5h blocks, daily charts, per-model/per-engine breakdown, delegated section), **Automations**, **Plugin** (embedded WebView). Three themes (dark/light/monokai) as CSS custom properties in `main.css`'s `@theme` block. Transparent window (`vibrancy` on macOS, acrylic on Windows). Resizable sidebar + main area + optional right panel (git/tasks/plan) + bottom terminal panel that is **always mounted** (`display: none`/`contents`) to preserve xterm scrollback (ADR-002).

Mobile/remote surfaces follow the content-slot takeover pattern (ADR-048).

## Gotchas

- **Tailwind v4 reset** — never add `* { margin: 0; padding: 0 }` after `@import "tailwindcss"` in main.css; it lands after the utility layer and silently kills padding/margin utilities. Preflight already handles it.
- **Tailwind source scanning** — the `@source "../../";` directive in main.css is required for the scanner to find renderer sources.
- **Electron transparency** — needs `transparent: true` + `vibrancy` on the BrowserWindow **and** transparent backgrounds on html/body/#root; any opaque background in the tree blocks it.
- **Usage utilization scales** — the `/api/oauth/usage` API returns 0–100, rate-limit headers return 0–1; both are stored as 0–100 in `RateWindow.usedPercent` (`toUsedPercent()` in usage-fetcher.ts).
- **Dev main-process staleness** — hot reload updates the renderer only; main-process changes need an app restart, or you get new UI labels over old main logic.
