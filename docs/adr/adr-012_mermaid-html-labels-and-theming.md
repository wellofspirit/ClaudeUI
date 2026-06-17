# ADR-012: Mermaid HTML labels (`antiscript` + DOMPurify `html` profile) and dark-theme ER contrast

**Status:** Accepted
**Date:** 2026-06-12

## Context

`MermaidDiagram.tsx` renders LLM-generated Mermaid source to SVG via
`mermaid.render()`, then injects the result with `dangerouslySetInnerHTML`. Two
problems surfaced:

1. **No HTML in labels.** Diagrams could not use `<br/>` line breaks or inline
   markup (`<b>`, `<i>`, `<span style>`) in node/edge labels. The config used
   `securityLevel: 'strict'`, which _encodes_ HTML tags — so `<br/>` rendered
   as literal text rather than a line break, and `htmlLabels` was effectively
   off.

2. **White-text-on-light-box in dark themes (esp. Monokai).** ER-diagram
   attribute rows rendered with white fills under our `dark` and `monokai`
   palettes, leaving the theme's light text unreadable. Root cause: Mermaid's
   `dark` base theme hardcodes `attributeBackgroundColorOdd = "#ffffff"` /
   `attributeBackgroundColorEven = "#f2f2f2"` **regardless of dark mode**
   (verified in the bundled theme source — shared constants at
   `chunk-*.mjs:834-835`, consumed in the dark-theme block where
   `background="#333"`). The other auto-generated colour scales (pie `pie1..12`,
   journey `fillType0..7`, git branches) all derive from `primaryColor`, which
   is dark in our palettes, so their light text reads fine — ER was the only
   offender.

These render in the desktop renderer **and** in the remote web client, and the
source is model-generated (semi-trusted), so any security-level relaxation must
keep a sanitization backstop.

## Decision

**Enable HTML labels via `securityLevel: 'antiscript'` + root `htmlLabels: true`,
and keep a DOMPurify pass that includes the `html` profile. Override the ER
attribute-row fills in our dark and monokai palettes.**

Concretely in `MermaidDiagram.tsx`:

- `mermaid.initialize({ securityLevel: 'antiscript', htmlLabels: true, … })`.
  `antiscript` allows HTML markup (so `<br/>` and inline styling render) while
  still stripping `<script>` tags and click handlers. We chose it over `'loose'`
  (which additionally allows click callbacks and arbitrary HTML) — we need
  markup in labels, not interactivity.
- **The DOMPurify call needs BOTH the `html` profile AND a
  `HTML_INTEGRATION_POINTS` override:**

  ```ts
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true }
  })
  ```

  With `htmlLabels` on, Mermaid emits labels as
  `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">…<br/></div></foreignObject>`.
  Two distinct things would otherwise strip that inner HTML:
  1. **Profile** — the `svg`-only profile doesn't allow `div`/`span`/`p`/`br`.
     The `html` profile does (while still removing `<script>` and `on*`).
  2. **Namespace check** — this was the actual cause of the "boxes/labels
     disappeared" regression. DOMPurify 3.x's `_checkValidNamespace` only treats
     `annotation-xml` as an HTML integration point by default; `foreignobject`
     is **not** in the default set. So an XHTML `<div>` whose parent is
     `<foreignObject>` (SVG namespace) fails the SVG→HTML transition check and is
     removed — _even with the `html` profile and the correct `xmlns`_. Adding
     `foreignobject` to `HTML_INTEGRATION_POINTS` (keeping `annotation-xml` so we
     don't regress MathML) fixes it. Verified empirically: the override preserves
     `div`/`span`/`p`/`br` while `<script>` and `javascript:` hrefs are still
     stripped.

  All three (`antiscript`, `html` profile, `HTML_INTEGRATION_POINTS`) are the
  defence-in-depth stack — none is sufficient alone.

- **All downstream SVG parsing uses the HTML parser, never `image/svg+xml`.**
  This was the _actual_ cause of the "nodes/boxes gone" report (sanitization
  above was correct — the breakage was further down the pipeline). DOMPurify
  HTML-serializes void tags as bare `<br>` (not `<br/>`). `MermaidDiagram` then
  re-parses the sanitized string in two places — `normalizedSvg` (strip
  width/height, add viewBox) and `svgToPngBlob` (read dimensions). Both used
  `DOMParser(..., 'image/svg+xml')`, whose **strict XML parse errors on the
  unclosed `<br>` — and Chromium then truncates the SVG at the first `<br>`,
  silently dropping every node/label after it** (which is why nodes with `<br/>`
  labels vanished while a plain edge label survived). Both now use a shared
  `parseSvgElement()` that parses as `text/html` (tolerant of `<br>`, handles
  SVG foreign content correctly).
- **Rasterization (copy/export to PNG) re-serializes to XML via
  `svgElementToXml()`.** `<img src="data:image/svg+xml">` always parses as
  strict XML, so the bare `<br>` would break the image too. We serialize the
  parsed element with `XMLSerializer` (which self-closes void tags → `<br/>`),
  first stripping the redundant literal `xmlns` attribute Mermaid puts on the
  foreignObject `<div>` — otherwise it collides with the serializer's own
  namespace declaration and produces invalid XML.
- ER attribute-row overrides in `THEME_CONFIGS`:
  - **dark:** `attributeBackgroundColorEven: '#152540'`, `…Odd: '#0d1117'`
  - **monokai:** `attributeBackgroundColorEven: '#1a3a42'`, `…Odd: '#1e1f1a'`
- Raised the render caps for large LLM diagrams: `maxTextSize: 90000`
  (default 50000), `maxEdges: 2000` (default 500). These are local-render DoS
  guards, irrelevant for trusted local content, and lifting them turns silent
  render failures into successful renders.

## Consequences

- **`antiscript`, the `html` profile, and `HTML_INTEGRATION_POINTS` are coupled
  — none is independently safe to change.** Tightening back to
  `strict`/`svg`-only silently kills `<br/>` and inline markup; dropping the
  `HTML_INTEGRATION_POINTS` override silently empties every HTML label (the
  regression that prompted this ADR); loosening to `'loose'` without
  re-examining DOMPurify would re-admit click callbacks. Treat them as one unit;
  this ADR + the inline comments are the guardrail.
- **`htmlLabels` makes the SVG an HTML/XML hybrid; never parse it as
  `image/svg+xml` again.** The bare-`<br>` truncation is silent and
  catastrophic (loses content with no error). Any new code that touches the
  rendered SVG string must go through `parseSvgElement()` (display/DOM work) or
  `svgElementToXml()` (strict-XML consumers like `<img>`).
- **Regression coverage:** `sanitizeMermaidSvg.unit.test.ts` pins both failure
  modes — (a) HTML label content survives sanitization (catches a DOMPurify
  namespace-handling change), and (b) a multi-node SVG with a bare `<br>` in the
  first node does not truncate and re-serializes to valid XML (catches a
  regression to `image/svg+xml` parsing).
- **HTML labels work in both desktop and remote clients** — same component, same
  sanitization, no transport-specific divergence.
- **ER diagrams are readable in all three app themes.** Light theme is left at
  Mermaid's default white rows (black-on-white reads fine); only the dark
  palettes needed overriding.
- **Explicit Mermaid theme settings (`dark`/`forest`/etc.) are NOT patched.**
  `resolveThemeConfig` intentionally returns the pure Mermaid base theme with no
  variable overrides when the user picks an explicit theme rather than `auto`,
  so the native white-ER behaviour returns there. This is a deliberate "native
  theme as-is" escape hatch; the contrast fix applies only to our `auto`-mapped
  palettes.
- **`flowchart.htmlLabels` is deliberately not set.** It's deprecated since
  Mermaid 11.12.3 in favour of the root-level `htmlLabels`, which is what we use.

## Alternatives considered

- **Keep `securityLevel: 'strict'` and rely on Mermaid's own `<br>` handling.**
  Rejected: strict encodes the tags, so `<br/>` shows literally and inline
  styling is impossible — it does not meet the requirement.
- **`securityLevel: 'loose'`.** Rejected: grants more than we need (click
  callbacks, unrestricted HTML) for no benefit over `antiscript`, widening the
  attack surface on model-generated source.
- **Post-process the SVG to recolour ER rows ourselves** (DOM-walk the rendered
  output). Rejected: brittle string/DOM surgery against Mermaid's markup; the
  theme-variable override is the supported, version-stable mechanism.
- **Override the entire auto-generated colour-scale set** (pie/journey/git).
  Rejected as over-engineering: those scales derive from `primaryColor` (dark)
  and already contrast correctly; only ER's hardcoded white needed fixing.
