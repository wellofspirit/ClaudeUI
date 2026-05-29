# ADR-007: Serve mockup previews over HTTP with a sandboxed iframe for the remote web client

**Status:** Accepted
**Date:** 2026-05-30

## Context

Mockup previews render Claude-generated HTML (plus sibling assets — images,
CSS, JS) inside an iframe in two places: the inline `MockupPreviewCard` and the
`MockupPanel` side panel.

On the desktop this works via a privileged Electron custom protocol,
`mockup-asset://` (`src/main/services/mockup-protocol.ts`,
`protocol.registerSchemesAsPrivileged` + `protocol.handle`). The handler:

- serves the mockup's `index.html` with a serve-time-injected bridge script
  (the "omelette" — console/error forwarding, auto-resize, parent-triggered
  reload) and a Content-Security-Policy,
- serves sibling assets from disk with path-traversal + extension-allow-list
  validation,
- gives **each mockup its own sub-origin** (`mockup-asset://<id>.m`), so a
  mockup's scripts are isolated from the app and from each other, and
  `localStorage`/cookies are scoped per-mockup.

The renderer points the iframe `src` at that scheme and drives in-place reloads
by `postMessage`-ing the iframe at its `mockup-asset://<id>.m` origin.

**None of this exists in a browser.** When the same renderer code runs in the
remote web client (`src/web`), `mockup-asset://` is not a registered scheme, so:

- the iframe `src` can't load, and
- `iframe.contentWindow.postMessage(msg, 'mockup-asset://<id>.m')` throws
  `Invalid target origin` — a hard, uncaught crash during render.

This surfaced as a production crash when launching a session with remote
control (`Uncaught SyntaxError: Failed to execute 'postMessage' on 'Window':
Invalid target origin 'mockup-asset://…'`).

A second, structural issue compounded it: the remote web-client API surface
(`src/web/api-adapter.ts`) is a hand-maintained mirror of the desktop preload's
`ClaudeAPI`, and `src/web` was excluded from both `tsconfig.*.json`, so missing
methods were never caught at build time. (That blind spot was closed separately
by adding `src/web/**` to `tsconfig.web.json`; this ADR covers the mockup
transport.)

### Options considered

1. **srcdoc stopgap** — render the already-fetched HTML via `iframe.srcdoc`
   with a sandbox. No server changes, stops the crash, but `srcdoc` has no base
   URL so **relative-path sibling assets don't load** — only fully
   self-contained mockups (inline CSS/JS, CDN, `data:` URIs) render.
2. **Serve over HTTP from the existing remote server + sandboxed iframe** —
   full asset fidelity, reuses the desktop serving logic, but introduces a new
   authenticated HTTP surface and a same-origin isolation problem.
3. **Disable preview on web** — hide the iframe, offer "copy HTML / open on
   desktop". Zero risk, no feature.

## Decision

**Serve mockups over HTTP from the remote server's existing HTTP listener,
reusing the desktop serving logic, and render them in an iframe sandboxed
*without* `allow-same-origin`.**

### Transport-agnostic serving core

`mockup-protocol.ts` was refactored so the routing/validation/serving logic is
shared by both transports (DRY — one set of security checks):

- `routeMockupParts(id, segments, searchParams)` — the pure core: id-regex,
  base64url cwd decode, cwd-absoluteness, path-traversal, extension allow-list.
- `routeAndValidate(url)` — protocol-scheme wrapper (id from `<id>.m` hostname).
- `routeHttpMockup(pathname, searchParams)` — HTTP wrapper (id from the path:
  `/mockup/<id>/<b64cwd>/[<subpath>]`).
- `serveMockup(decision, selfSource): { status, headers, body }` — reads from
  the filesystem (`fs.promises`, not Electron `net`), injects the bridge +
  CSP for HTML, returns normalized bytes/headers. The Electron protocol handler
  and the HTTP route both call it.
- `buildMockupCsp(settings, selfSource)` — `selfSource` is `mockup-asset:` for
  the protocol and the **server's concrete origin** for HTTP (see below).

### HTTP route

`remote-server.ts` serves `/mockup/<id>/<b64cwd>/…`, reusing
`routeHttpMockup` + `serveMockup`. The CSP `selfSource` is derived per-request
from `x-forwarded-proto` (the tunnel terminates TLS and forwards over http) +
`Host`. The web client builds the iframe URL with `buildMockupHttpUrl` against
`window.location.origin`.

### Isolation — sandboxed opaque origin

The remote server serves the web client over plain HTTP from its own origin, so
serving mockups from that **same** origin without isolation would let a mockup's
arbitrary scripts (`script-src` allows `'unsafe-inline'`/`'unsafe-eval'` for the
Tailwind Play CDN) read the web client's `localStorage` / `window.api` — i.e.
steal the WebSocket auth token.

The web iframe is therefore sandboxed `allow-scripts` **without**
`allow-same-origin`. That gives the document an **opaque origin** (`"null"`),
isolated from the web client even though it's served from the same host. This
changes the postMessage contract on web (captured in
`src/renderer/src/components/mockup-transport.ts`):

| | Desktop | Web |
|---|---|---|
| iframe `sandbox` | `allow-scripts allow-same-origin` | `allow-scripts` |
| parent→iframe reload target | `mockup-asset://<id>.m` | `'*'` |
| bridge expected `event.origin` | `mockup-asset://<id>.m` | `'null'` |

The bridge's primary trust check (`event.source === iframe.contentWindow`)
holds in both modes; the origin check is defense-in-depth.

### Mockup-scoped token (NOT the WS token)

Because the iframe URL is readable by the mockup's own scripts
(`location.search`), it must not carry the WS token. The server generates a
**separate `mockupToken`** at start and injects it into the served web-client
HTML as `window.__MOCKUP_TOKEN__` — but **only when the request carries a valid
WS token** (`/remote?t=<wsToken>`). The `/mockup` route validates `?token=`
against `mockupToken`.

Blast radius if a hostile mockup exfiltrates its scoped token: reading
extension-allow-listed files under `.claude/ui/mockups/<id>/` for guessable
cwds. It grants **nothing** on the WS / Claude control plane.

### Platform abstraction

A new `ClaudeAPI.getMockupPreviewUrl(cwd, directory, { dark? })` returns the
iframe `src` — `mockup-asset://…` from the desktop preload,
`buildMockupHttpUrl(...)` from the web adapter. Both `MockupPreviewCard` and
`MockupPanel` call it instead of `buildMockupUrl` directly.

## Consequences

### New

- HTTP route `/mockup/<id>/<b64cwd>/…` on the remote server, token-gated.
- `routeHttpMockup`, `routeMockupParts`, `serveMockup`, `ServedMockup`,
  `buildMockupCsp(settings, selfSource)` in `mockup-protocol.ts`.
- `buildMockupHttpUrl` / `MOCKUP_HTTP_PREFIX` in `shared/mockup-url.ts`.
- `ClaudeAPI.getMockupPreviewUrl` (desktop preload + web adapter impls).
- `src/renderer/src/components/mockup-transport.ts` — per-platform sandbox attr,
  reload target, expected origin.
- `useMockupBridge` takes an optional `expectedOrigin` (defaults to the desktop
  sub-origin).
- The desktop protocol handler now reuses `serveMockup` (reads via
  `fs.promises` instead of `net.fetch(pathToFileURL(...))`) — behaviorally
  identical.

### Trade-offs

- **`localStorage`/`sessionStorage` in mockups break on web.** The opaque
  sandbox origin makes web storage throw. Desktop's per-mockup sub-origin keeps
  it working. Accepted: most mockups don't use storage, and the alternative
  (`allow-same-origin`) would defeat the token isolation that is the whole point.
- **New authenticated HTTP surface.** Mitigated by a dedicated low-privilege
  token, gated behind WS-token possession at injection time.
- **CSP `selfSource` over the tunnel** depends on `x-forwarded-proto`. If a
  future proxy doesn't set it, the mockup's own `script`/`style` assets could be
  CSP-blocked (img/media/connect already allow `https:` broadly). Acceptable;
  refine if a proxy misbehaves.
- **Cookie-based auth was rejected** in favor of the URL token. An `HttpOnly`
  cookie would be strictly unreadable by mockup scripts, but relies on
  browser-specific behavior for sending cookies to a sandboxed same-site iframe.
  The scoped-token-in-URL is predictable and its blast radius is already bounded.

### Security posture

Layered: opaque-origin sandbox (the real isolation wall) + per-document CSP
(defense-in-depth) + path-traversal/extension allow-list (shared with the
desktop protocol) + a scoped token that grants nothing on the control plane.
This mirrors the desktop posture (sub-origin wall + CSP) adapted to the browser,
where a real per-mockup sub-origin isn't available.
