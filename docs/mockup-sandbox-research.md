# Safe JS Execution in the Mockup Tool — How claude.ai Does It

Research date: 2026-04-22. Captured by inspecting a live artifact on `claude.ai/new`.

## 1. The setup claude.ai uses

The artifact preview is a single iframe injected into the main chat page. Captured from the live DOM:

```html
<iframe
  class="h-full w-full"
  sandbox="allow-scripts allow-same-origin"
  title="instrument.html"
  loading="lazy"
  src="https://www.claudeusercontent.com?domain=claude.ai
       &parentOrigin=https%3A%2F%2Fclaude.ai
       &errorReportingMode=parent
       &formattedSpreadsheets=true"
  allow="fullscreen; clipboard-write"
  referrerpolicy="no-referrer"
  style="zoom: 1;"
>
</iframe>
```

### Real boundary: origin isolation, not the sandbox attribute

The sandbox flags `allow-scripts allow-same-origin` would be dangerous if the iframe were same-origin with the host page — the artifact could read `parent.document`, exfiltrate cookies, etc. Anthropic defuses this by serving the iframe from **`claudeusercontent.com`**, a separate eTLD+1. Because the parent is `claude.ai`, the iframe is cross-origin; `allow-same-origin` just means "same as _claudeusercontent.com_," which gives the artifact:

- Its own cookie jar, localStorage, IndexedDB
- `fetch()` / `XMLHttpRequest` that actually work (CORS still applies to outbound calls)
- Web Workers and ServiceWorkers scoped to claudeusercontent.com
- **Zero access to claude.ai DOM, cookies, or auth tokens**

Verified empirically:

```js
// Run from https://claude.ai DevTools
document.querySelector('iframe').contentWindow.location.origin
// → Error: Blocked a frame with origin "https://claude.ai" from
//   accessing a cross-origin frame.
```

### Sandbox flags

`sandbox="allow-scripts allow-same-origin"` — minimal set. Notably **not** granted:

- `allow-forms`
- `allow-popups`
- `allow-popups-to-escape-sandbox`
- `allow-top-navigation`
- `allow-top-navigation-by-user-activation`
- `allow-modals`
- `allow-downloads`
- `allow-pointer-lock`
- `allow-orientation-lock`
- `allow-presentation`

### Permissions-Policy

`allow="fullscreen; clipboard-write"` — can enter fullscreen and write to clipboard. No mic, camera, geolocation, payment, USB, MIDI, accelerometer.

### Other iframe attributes

- `referrerpolicy="no-referrer"` — no Referer leak to the artifact
- `loading="lazy"` — defer until visible (unrelated to security)

## 2. Response headers on `claudeusercontent.com` (defense in depth)

```
content-security-policy:
  default-src https://www.claudeusercontent.com;
  script-src 'unsafe-eval' 'unsafe-inline' 'self'
             https://www.claudeusercontent.com
             https://cdnjs.cloudflare.com
             https://cdn.jsdelivr.net/pyodide/
             https://cdn.jsdelivr.net/gh/python-visualization/
             https://cdn.jsdelivr.net/npm/
             https://cdn.tailwindcss.com
             https://code.jquery.com;
  connect-src https://cdnjs.cloudflare.com
              https://cdn.jsdelivr.net/pyodide/
              https://cdn.jsdelivr.net/gh/python-visualization/
              https://cdn.jsdelivr.net/npm/
              https://cdn.tailwindcss.com
              https://code.jquery.com
              https://www.claudeusercontent.com;
  worker-src 'self' https://www.claudeusercontent.com blob:;
  style-src 'unsafe-inline' 'self' https://www.claudeusercontent.com
            https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/
            https://cdn.jsdelivr.net/gh/python-visualization/
            https://code.jquery.com https://fonts.googleapis.com
            https://anthropic.com https://*.anthropic.com;
  img-src https://*.tile.openstreetmap.org/ blob: data: 'self'
          https://www.claudeusercontent.com;
  font-src data: 'self' https://www.claudeusercontent.com
           https://anthropic.com https://*.anthropic.com
           https://fonts.gstatic.com;
  frame-src 'self' blob:;
  object-src 'none';
  base-uri https://www.claudeusercontent.com;
  form-action https://www.claudeusercontent.com;
  frame-ancestors 'self' https://www.claudeusercontent.com
                  *.anthropic.com anthropic.com *.ant.dev
                  https://claude.ai https://preview.claude.ai
                  https://claude.site https://feedback.anthropic.com
                  app://localhost;
  upgrade-insecure-requests;
  block-all-mixed-content;
  report-uri https://logs.browser-intake-us5-datadoghq.com/api/v2/logs?...

cross-origin-opener-policy: same-origin
x-content-type-options: nosniff
x-xss-protection: 1; mode=block
strict-transport-security: max-age=63072000; includeSubDomains; preload
anthropic-allowed-parent-domains: https://claude.ai
```

Reading the CSP:

| Directive                                              | Effect                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script-src 'unsafe-eval' 'unsafe-inline' + allowlist` | Inline `<script>` and `eval()` are **allowed** — needed because the generated artifact is essentially untrusted inline HTML. The allowlist pins external CDNs (jQuery, Tailwind CDN, Pyodide, cdnjs, jsDelivr/npm + gh/python-visualization). Mitigated solely by the origin wall. |
| `connect-src`                                          | Narrow CDN-only allowlist. Notably **`api.github.com` is NOT allowed** — that's why an artifact that calls `fetch("https://api.github.com/...")` fails with "Failed to fetch".                                                                                                     |
| `worker-src 'self' blob:`                              | Web Workers and blob-URL workers allowed.                                                                                                                                                                                                                                          |
| `object-src 'none'`                                    | No Flash / applets / plugins.                                                                                                                                                                                                                                                      |
| `base-uri` / `form-action` locked                      | Can't inject `<base>` or redirect a form.                                                                                                                                                                                                                                          |
| `frame-ancestors`                                      | Only approved parents can embed this content. Complements sandbox.                                                                                                                                                                                                                 |
| `report-uri` → Datadog                                 | CSP violations get reported (observability).                                                                                                                                                                                                                                       |
| `anthropic-allowed-parent-domains`                     | Anthropic's own runtime check on top of `frame-ancestors`.                                                                                                                                                                                                                         |

## 3. Parent ↔ artifact communication

- Parent origin is passed as URL query param (`parentOrigin=https%3A%2F%2Fclaude.ai`) so the iframe JS knows what targetOrigin to use for `postMessage`.
- `errorReportingMode=parent` suggests errors are forwarded up via postMessage (not to a remote logger).
- No way to message around this: without same-origin access, postMessage is the only channel, and both sides should validate `event.origin`.

## 4. Why the `sandbox` flag pair is clever

Think of it as two orthogonal defenses:

1. **Origin separation** (the real wall): served from `claudeusercontent.com`.
2. **Sandbox flags + CSP + Permissions-Policy** (belt-and-braces): even if attacker finds an origin bypass, they still can't open popups, navigate top, access mic, or hit `api.github.com`.

Dropping `allow-same-origin` would make it _even_ stricter (null origin) but then the artifact loses localStorage and usable fetch/WebSocket — too limiting for rich demos. So Anthropic chose "full power within its own sandbox domain" over "no power at all."

## 5. Applying this to ClaudeUI's mockup tool

Today the mockup preview (`mcp__claude-ui-mockup__create_mockup`) renders HTML with Tailwind but deliberately disables scripts. To safely flip JS on, we need an origin boundary.

### Option A — `<iframe sandbox="allow-scripts" srcdoc="…">` (no `allow-same-origin`)

- **Isolation:** browser assigns **null origin**. Strictly stronger than claude.ai's setup.
- **Can do:** run arbitrary JS, canvas, animations, CSS, inline JS frameworks, Tailwind via CDN.
- **Cannot do:** localStorage, IndexedDB, most cross-origin fetch (no CORS credentials), WebSockets to arbitrary endpoints (some browsers block), Service Workers.
- **Effort:** lowest. Edit the mockup host component to set `sandbox="allow-scripts"` and drop the script-stripping step. Add a meta-CSP inside the srcdoc for extra belt (script-src allowlist matching Claude's CDN list is a reasonable start).
- **Verdict:** best 80/20 trade-off for a mockup/prototype use case. 90% of demo UIs don't need localStorage; they need canvas, DOM events, and inline JS.

### Option B — Dedicated local origin via Electron custom protocol

- Register `mockup://` in the main process (`protocol.registerFileProtocol` or `protocol.handle` in newer Electron) pointing at a temp dir.
- Render the preview in a `<webview partition="persist:mockup">` with `sandbox="allow-scripts allow-same-origin"`.
- **Isolation:** separate Electron session + separate origin → like Claude's setup.
- **Can do:** everything Option A can plus localStorage, IndexedDB, fetch with CORS.
- **Effort:** medium. Needs protocol handler, webview plumbing, postMessage bridge.
- **Verdict:** use this if users start asking for persistent state or local asset loading.

### Option C — Full claude.ai mirror (bundled Next.js host, strict CSP, separate origin)

- Overkill for a mockup tool. Mentioned only for completeness.

### Recommendation

Start with **Option A**. Concretely:

```tsx
// Inside the mockup preview component
<iframe
  sandbox="allow-scripts"
  srcdoc={`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'unsafe-inline' 'unsafe-eval'
                            https://cdn.tailwindcss.com
                            https://cdnjs.cloudflare.com
                            https://cdn.jsdelivr.net;
                 style-src 'unsafe-inline'
                           https://cdn.tailwindcss.com
                           https://fonts.googleapis.com;
                 font-src https://fonts.gstatic.com data:;
                 img-src data: blob: https:;
                 connect-src https:;
                 frame-src 'none';">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
  ${userHtml}
</body>
</html>`}
  allow="fullscreen"
  referrerpolicy="no-referrer"
  style="width: 100%; height: 100%; border: 0"
/>
```

Key points:

- `sandbox="allow-scripts"` without `allow-same-origin` → null origin; cannot touch the Electron renderer's window, IPC, filesystem.
- Meta-CSP provides defense in depth; even if an `<iframe srcdoc>` somehow escaped the sandbox, it still can't pull arbitrary scripts.
- Tailwind CDN matches what Claude's artifacts use, so the same CSS class conventions work.
- Keep `referrerpolicy="no-referrer"` so file:// paths or dev URLs don't leak.
- Optionally add a postMessage bridge for resize events (content height → parent), mirroring Claude's pattern.

### Migration checklist

- [ ] Audit current mockup renderer for any same-origin assumptions.
- [ ] Flip to `srcdoc` + `sandbox="allow-scripts"`, drop script-stripping logic.
- [ ] Add meta-CSP with sensible CDN allowlist.
- [ ] Wire postMessage-based resize / error reporting (optional nicety).
- [ ] Add a unit test that injects `<script>parent.postMessage(...)</script>` and asserts the parent does NOT receive data from the sandboxed iframe on any sensitive channel (the null-origin postMessage will still arrive — the test is that we correctly reject any message whose `event.source` isn't the mockup iframe, and never eval the payload).

---

# Appendix — How `claude.ai/design` does it (richer model)

`claude.ai/design` (Anthropic Labs, "Research Preview") is a different app with a **different**, more interactive sandbox. Key differences from the `/new` artifact:

## A1. Per-project subdomain isolation

Each design project runs at its **own subdomain**:

```
https://<project-uuid>.claudeusercontent.com/v1/design/projects/<project-uuid>/serve/<filename>.html?t=<signed-token>
```

Example captured live:

```
https://e2e53345-9a71-44c6-a800-67587f53bc13.claudeusercontent.com
  /v1/design/projects/e2e53345-9a71-44c6-a800-67587f53bc13
  /serve/Organic%20Loaders.html
  ?t=a166851a7b61…
```

So **one project's iframe cannot read another project's cookies/storage** even within the same user workspace. Classic multi-tenant isolation: Anthropic owns `*.claudeusercontent.com`, so it can hand out subdomains on demand; cookie scoping is per-subdomain by default.

The `?t=` query param is a signed capability token — the bare URL returns 403 without it (confirmed via `curl`).

## A2. Parent iframe element attributes

Two iframes were captured on the same page (possibly thumbnail + full preview):

```html
<!-- thumbnail variant -->
<iframe
  sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
  allow="camera; microphone; geolocation"
>
  <!-- full preview variant -->
  <iframe
    sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-same-origin"
    allow="camera; microphone; geolocation"
  ></iframe
></iframe>
```

Much more permissive than `/new` (which was `allow-scripts allow-same-origin` + `fullscreen; clipboard-write`):

- `allow-forms`, `allow-popups`, `allow-modals`, `allow-downloads` all enabled
- Permissions-Policy grants **camera, microphone, geolocation** — full interactive prototypes

This is safe because each project has its own subdomain (A1).

## A3. Response headers — minimal CSP

Unlike `www.claudeusercontent.com` (huge CSP), the per-project subdomain returns:

```
content-security-policy: frame-ancestors 'self'
                                          https://claude.ai https://*.claude.ai
                                          https://claude.com https://*.claude.com
                                          https://claude-ai.staging.ant.dev
                                          https://*.claude-ai.staging.ant.dev
referrer-policy: no-referrer
x-content-type-options: nosniff
```

No `script-src`, no `connect-src` restrictions. The model here is: origin isolation + sandbox flags do the work; within its own subdomain sandbox, the design can do anything.

## A4. The "omelette" runtime (injected into every design HTML)

Every served design HTML gets two blocks auto-injected at the top:

```html
<style data-omelette-injected>
  html,
  body {
    background: transparent;
  }
</style>
<script data-omelette-injected>
  …
</script>
```

Decoded capabilities of the runtime (de-minified highlights):

### Parent-origin allowlist

```js
const PARENTS = [
  'https://claude.ai',
  'https://preview.claude.ai',
  'https://eap-omelette.claude.ai' // internal alpha?
]
```

All outgoing postMessages are targeted to these origins (broadcast to each); all incoming messages are filtered by both `event.origin ∈ PARENTS` **and** `event.source === window.parent`.

### 1. Babel JSX auto-hint

For any `<script type="text/babel">` or `type="text/jsx">`, the runtime adds `data-plugins="transform-react-jsx-source"` and sets `data-filename` to the src or `inline-N`. Enables React/JSX authoring with source maps in a live-edit flow (paired with an in-browser Babel Standalone).

### 2. Console + error forwarding to parent

```js
["log","warn","error"].forEach(level => {
  const orig = console[level];
  console[level] = (...args) => {
    const text = args.map(stringify).join(" ");
    parent.postMessage({__omelette_log: true, type: level, data: text}, "*");
    orig.apply(console, args);
  };
});

window.addEventListener("error", ev => {
  // forwards both JS errors and <img>/<script> resource-load failures
}, true);
window.addEventListener("unhandledrejection", …);
```

So the Design UI can show a real DevTools-like console for the sandbox.

### 3. Auto-resize

```js
const post = () =>
  parent.postMessage({ type: 'omelette:height', height: documentElement.scrollHeight }, '*')
window.addEventListener('load', post)
new ResizeObserver(post).observe(documentElement)
```

Parent reads `omelette:height` and resizes the iframe container. This is why the designs in the right panel fit flush without internal scrollbars.

### 4. `window.claude.complete(prompt)` — call Claude from inside the iframe

```js
window.claude = {
  complete(prompt) {
    return new Promise((resolve, reject) => {
      const id = `c${++seq}`;
      const timer = setTimeout(() => { reject(new Error("no data for 30s")); }, 30000);
      pending[id] = {resolve, reject, text: "", t: timer, arm: () => …};
      for (const parent of PARENTS) {
        window.parent.postMessage({__om_api: true, id, body: prompt}, parent);
      }
    });
  }
};

// Response handler (streaming):
window.addEventListener("message", ev => {
  if (!PARENTS.includes(ev.origin) || ev.source !== parent) return;
  const data = ev.data;
  if (data.__om_api_r) {
    if (data.chunk != null) { pending[id].text += data.chunk; … }  // streamed chunks
    else if (data.done)      { resolve(data.text ?? accumulated); }
  }
});
```

This is a **live RPC bridge**: the sandboxed design can ask Claude to complete arbitrary text (and receive it streamed back). The parent acts as a policy gate — it decides whether to forward each call to the real LLM.

### 5. `window.omelette.writeFile(path, content)` — iframe writes to project FS

```js
window.omelette = {
  writeFile: (path, content) =>
    new Promise((resolve, reject) => {
      const id = `f${++seq}`
      const timer = setTimeout(() => resolve(), 3000) // soft-fail
      for (const parent of PARENTS) {
        window.parent.postMessage({ __om_file: true, id, op: 'write', path, content }, parent)
      }
    })
}
```

Lets the iframe persist files (images generated on canvas, exported JSON, etc.) back into the project sidebar — a nice self-saving feature.

### 6. Parent-initiated eval (reverse direction)

```js
if (data.__om_eval) {
  const result = (0, eval)(data.code);  // indirect eval → runs in global scope of iframe
  if (result?.then) result.then(v => reply({ok:1, v: safeStringify(v)}), …);
  else               reply({ok:1, v: safeStringify(result)});
}
```

The parent Design UI can run arbitrary JS inside the iframe for inspection/commands. Used for live "Tweaks" / "Edit" features in the UI (I saw those buttons in the top bar of the preview).

## A5. Message protocol summary

| Direction       | Shape                                              | Purpose                  |
| --------------- | -------------------------------------------------- | ------------------------ |
| iframe → parent | `{__omelette_log, type, data}`                     | console/error forwarding |
| iframe → parent | `{type: "omelette:height", height}`                | auto-resize              |
| iframe → parent | `{__om_api: true, id, body}`                       | LLM completion request   |
| parent → iframe | `{__om_api_r: true, id, chunk/text/error/done}`    | LLM streaming response   |
| iframe → parent | `{__om_file: true, id, op:"write", path, content}` | save file                |
| parent → iframe | `{__om_file_r: true, id, ok/error}`                | file write ack           |
| parent → iframe | `{__om_eval: true, id, code}`                      | remote eval              |
| iframe → parent | `{__om_eval_r: 1, id, ok/v/e}`                     | eval result              |

## A6. Comparison

|                    | `/new` artifact                               | `/design` preview                                                                                       |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Host origin        | Single `www.claudeusercontent.com`            | Per-project `<uuid>.claudeusercontent.com`                                                              |
| Sandbox flags      | `allow-scripts allow-same-origin`             | + `allow-forms`, `allow-popups`, `allow-modals`, `allow-downloads`                                      |
| Permissions policy | `fullscreen; clipboard-write`                 | `camera; microphone; geolocation`                                                                       |
| Response CSP       | Full (script/connect/worker/etc. allowlisted) | Minimal (only `frame-ancestors`)                                                                        |
| connect-src        | Allowlist of CDNs only                        | Unrestricted (sandbox + subdomain is the control)                                                       |
| Injected runtime   | None visible                                  | "omelette" — console forwarding, auto-resize, `window.claude`, `window.omelette.writeFile`, eval bridge |
| Target use case    | Share-ready snippets                          | Full prototyping workspace with LLM calls, file I/O, hardware access                                    |

## A7. Takeaways for ClaudeUI

1. **Origin-per-tenant is a tier up from origin-per-product.** If ClaudeUI ever supports multiple independent mockups/designs per workspace, giving each a unique subdomain (or an Electron protocol with a unique host per doc) is the cleanest way to isolate their storage/cookies from each other, not just from the host app.

2. **The "omelette" pattern is worth stealing for the mockup tool.** Even a minimal version — inject a small script at the top of every mockup srcdoc that forwards `console.*` and `window.onerror` to the parent via postMessage — gives ClaudeUI a DevTools-like debug panel for mockups essentially for free. With a strict message schema + origin check it stays safe.

3. **`window.claude.complete` as in-iframe AI bridge** is a compelling UX primitive — designs that can regenerate parts of themselves without a full round-trip through the main chat. Could work in ClaudeUI by wiring a limited variant of the IPC bridge through postMessage + cli.js query.

4. **Auto-resize via `omelette:height` is the right default.** Avoids the awkward scrolling-inside-scrolling problem that most iframe-preview tools hit.

5. **The minimal response-CSP model only works if you truly have origin isolation.** For ClaudeUI's mockup tool, which renders in the same Electron renderer unless we introduce a separate origin, we should keep the response-CSP-heavy model from the `/new` artifact — not the minimal one from `/design`.

---

# Appendix B — How `/design` does _iterative_ updates

The really clever part of `/design` isn't the initial generation — it's how every subsequent change avoids a round-trip to the LLM. Three independent layers:

## B1. EDITMODE sentinels — AI marks up the file once, then never touches it again

When Claude generates a design, it wraps tweakable values in sentinel comments inside a JS block:

```js
// ---- Tweakable defaults ----
const TWEAKS = /*EDITMODE-BEGIN*/ {
  count: 20
} /*EDITMODE-END*/
```

The `/*EDITMODE-BEGIN*/ ... /*EDITMODE-END*/` pair marks a JSON-valued region the parent can safely substitute by pure string replacement — no AST, no AI call. The parent saves new values into the file by rewriting exactly the bytes between those markers.

Claude also injects a self-contained "Tweaks" panel into the HTML:

```html
<div id="tweaks" class="...">
  <div class="title">TWEAKS</div>
  <label>Loaders shown <span id="tw-count-val">20</span></label>
  <input id="tw-count" type="range" min="5" max="30" value="20" />
</div>
```

And the wiring that connects the panel to the DOM + file system:

```js
function applyCount(n) {
  document.querySelectorAll('.grid .cell').forEach((c, i) => {
    c.classList.toggle('hidden', i >= n)
  })
  document.getElementById('tw-count-val').textContent = n
  const slider = document.getElementById('tw-count')
  if (slider && +slider.value !== n) slider.value = n
}

applyCount(TWEAKS.count)

// Slider wiring
document.getElementById('tw-count').addEventListener('input', (e) => {
  const n = +e.target.value
  applyCount(n) // 1) live DOM update
  window.parent.postMessage(
    // 2) tell parent to save
    { type: '__edit_mode_set_keys', edits: { count: n } },
    '*'
  )
})
```

So dragging the slider does two things independently:

1. **Updates the DOM in-place** — zero network, zero AI.
2. **Posts `__edit_mode_set_keys` to the parent** — parent persists `count` into the JSON region between the EDITMODE markers on the server.

No file re-render, no iframe reload during interaction. On a subsequent cold load the new defaults come down.

## B2. Edit-mode protocol (postMessage)

Full protocol, all self-contained in the served HTML:

| Msg                                        | Direction       | Purpose                                                                                   |
| ------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------- |
| `{type:'__edit_mode_available'}`           | iframe → parent | On load. Announces the file supports edit-mode, so the "Tweaks" toggle is enabled.        |
| `{type:'__activate_edit_mode'}`            | parent → iframe | User flipped the Tweaks toggle ON. The iframe adds `.on` class to the panel (show).       |
| `{type:'__deactivate_edit_mode'}`          | parent → iframe | User flipped the toggle OFF. Panel hides.                                                 |
| `{type:'__edit_mode_set_keys', edits:{…}}` | iframe → parent | User interacted with a control; parent persists these keys into the EDITMODE JSON region. |

Observed from the wire (decoded from minified cli.js-style style):

```js
// In the generated HTML:
window.addEventListener('message', (e) => {
  const d = e.data || {}
  if (d.type === '__activate_edit_mode') {
    document.getElementById('tweaks').classList.add('on')
  } else if (d.type === '__deactivate_edit_mode') {
    document.getElementById('tweaks').classList.remove('on')
  }
})
window.parent.postMessage({ type: '__edit_mode_available' }, '*')
```

Notice this protocol is **orthogonal to** the `omelette` runtime (A4). The EDITMODE protocol is emitted _by Claude's generated file content_; the omelette runtime is injected _by the serving infra_ around it. Separation of concerns: infra handles log/resize/LLM bridge; generated content handles its own domain-specific tweak schema.

## B3. "Tweaks / Comment / Edit / Draw" — four distinct update loops

The preview toolbar exposes four orthogonal interaction modes:

### Tweaks

A toggle that shows/hides the EDITMODE panel from B1. The dropdown next to it ("Ask Claude to add sliders or options") is how the user **grows** the EDITMODE contract — prompts like "add a color picker for accent" tell Claude to:

1. Extend the EDITMODE JSON block with a new key (e.g. `"accent": "#000"`)
2. Add a matching control to the Tweaks panel HTML
3. Add an `applyAccent(hex)` function and wire it to the control
4. Re-post `__edit_mode_set_keys` with the new key on change

So Tweaks is an **additive, Claude-authored UI surface** that grows the interactive controls one at a time. Future drags of those controls are AI-free.

### Edit

Opens a right-hand properties panel that looks straight out of Figma:

```
PAGE
  Background  [swatch] #efece6
  Font                ui-monospace ▾
  Base size              16 px
```

These are _also_ EDITMODE values, but surfaced by the Design app's own UI (not injected by Claude). The Design app knows how to parse the EDITMODE block as JSON and render a schema-driven form. (I didn't observe element-level selection in Edit mode during this session — the right panel stayed on PAGE even when clicking individual cells — so Edit may be limited to well-known top-level keys for now.)

### Draw

A sketch/annotation overlay. Toolbar shows:

```
Draw ×1    Click ×2    [ Type anywhere to add a note ]    Queue
```

`×1`/`×2` are counters of pending annotations. The workflow:

1. User draws arrows, highlights, or clicks points on the preview, with free-text notes.
2. Counter increments.
3. User hits **Queue**.
4. All annotations are packaged into a natural-language description + screenshot (presumably) and sent to Claude as a single edit request.
5. Claude edits the HTML file via its server-side file-editing tools (observed in chat: "Reading", "Editing", "Done, Fork verifier agent").
6. The served file changes; the iframe reloads to pick it up ("Reload for new version" banner seen when auto-reload is off).

This is a much richer feedback channel than chat alone — visual pointing + text, batched into one prompt. The loop is:

```
  ┌────────────── no AI ──────────────┐
  │  Slider drag → applyCount() → postMessage → parent rewrites JSON  │
  └──────────────────────────────────────────────────────────────────┘
  ┌────────────── cheap AI (once per "grow") ─────────────────────────┐
  │  "Add a color picker" → Claude patches EDITMODE + panel HTML once  │
  └───────────────────────────────────────────────────────────────────┘
  ┌────────────── full AI loop ───────────────────────────────────────┐
  │  Draw annotations → Queue → Claude edits file → iframe reloads     │
  └───────────────────────────────────────────────────────────────────┘
```

### Comment

Standard comment threads on the preview — collaboration / review channel, doesn't trigger code changes.

## B4. Why this pattern is compelling

The interesting design idea is **deliberately layering cost/latency tiers**:

- **Tier 0 (free)** — direct DOM mutation via pure JS. Used for slider drags, color pickers, any EDITMODE key.
- **Tier 1 (cheap)** — parent rewrites a well-marked JSON region by byte substitution. No LLM.
- **Tier 2 (one-shot LLM)** — "grow the controls": Claude adds one more tweakable, which then becomes Tier 0 forever.
- **Tier 3 (full LLM)** — structural changes via chat or Draw annotations: Claude re-reads/edits the whole file.

Contrast this with the naive "every change is a chat turn" approach — which is what most AI design tools do, and which is what the **current ClaudeUI mockup tool would do** if we just turned on JS support.

## B5. Takeaways for ClaudeUI mockup tool

1. **Bake the EDITMODE pattern into the mockup tool.** When the model generates a mockup, prompt it to wrap tweakable values in `/*EDITMODE-BEGIN*/…/*EDITMODE-END*/` comments, generate a small Tweaks panel, and wire up `postMessage({type:'__edit_mode_set_keys', edits:{…}})`. The mockup renderer (parent) then:
   - Shows a Tweaks toggle on the preview toolbar.
   - On incoming `__edit_mode_set_keys`, substitutes bytes inside the EDITMODE region of the stored HTML and persists.
   - On reload, serves the updated HTML.

2. **Adopt the console + auto-resize runtime injection from Appendix A4.** Two small postMessage contracts:
   - `{__omelette_log: true, type, data}` → collect for a DevTools-style panel.
   - `{type: 'omelette:height', height}` → parent sets iframe container height.

3. **Skip Draw/annotation mode initially.** It's high value but requires substantial UI work. The Tweaks + chat loop already covers 80% of iteration needs.

4. **Consider the layered cost tiers as product strategy.** If JS-execution in mockups becomes a real feature, the goal shouldn't be "chat-edits-everything"; it should be "Claude plants controls that let the user iterate AI-free most of the time." Cheaper, faster, and reduces the "I changed one number and now it rewrote my whole file" problem.

5. **Don't let Draw/Comment lure us away from the security story.** All these modes rely on the origin-isolated iframe from Appendix A. None of them require relaxing the sandbox.
