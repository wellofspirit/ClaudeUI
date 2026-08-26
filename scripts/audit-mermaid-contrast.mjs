#!/usr/bin/env node
/**
 * audit-mermaid-contrast.mjs
 *
 * Measures WCAG text/background contrast for every mermaid diagram type, in
 * every ClaudeUI app theme, in real Chromium. It exists because the palettes in
 * `src/renderer/src/components/chat/mermaid-themes.ts` override only a subset of
 * mermaid's ~300 theme variables — everything else is *derived* by mermaid's
 * theme classes from our seeds, using derivations written for mermaid's own
 * seeds. Some of those derivations produce black-on-black or white-on-white text
 * (the `cScaleLabel* = "black"` on dark `cScale*` fills is the canonical case).
 *
 * Nothing about that class of bug is visible from reading the palette: the
 * offending colour never appears in our config. It has to be measured on the
 * rendered SVG. Hence this script — same posture as `probe-opencode-caps.mjs`:
 * **re-run it on every mermaid version bump** (the vendored version is pinned by
 * `package.json#mermaid`), and after every edit to `mermaid-themes.ts`. A bump
 * can change a derivation, a default, or a diagram's DOM structure, and the only
 * honest answer is a fresh measurement.
 *
 * Usage:
 *   bun scripts/audit-mermaid-contrast.mjs
 *   bun scripts/audit-mermaid-contrast.mjs --theme dark
 *   bun scripts/audit-mermaid-contrast.mjs --shots
 *   bun scripts/audit-mermaid-contrast.mjs --json .cache/mermaid-audit.json
 *   bun scripts/audit-mermaid-contrast.mjs --all           (list every pair, not just failures)
 *
 * Exit codes:
 *   0  clean — nothing below the 3.0 hard floor, every diagram rendered and
 *      measured at least one text node
 *   1  contrast violation — at least one pair below 3.0
 *   2  harness failure — a diagram failed to render, or rendered with zero
 *      measurable text. Either means that type was NOT audited, which must never
 *      be reported as "0 violations"
 *
 * How the measurement works (and why it is done this way):
 *  - The page body is painted with the app theme's real `--color-bg-primary`.
 *    Every theme config sets mermaid's `background: 'transparent'`, so the
 *    canvas colour behind the diagram is part of the contrast maths, not a
 *    detail. Values are mirrored from `src/renderer/src/assets/main.css`.
 *  - mermaid is loaded from the vendored `node_modules/mermaid/dist/mermaid.min.js`
 *    (a plain script that assigns `globalThis.mermaid`), and initialized with
 *    `buildMermaidInitConfig()` imported from the app's own module. Measuring a
 *    differently-configured mermaid would be fiction.
 *  - Backgrounds are resolved by hit-testing (`document.elementsFromPoint`) at
 *    three points across each text node's box, compositing every translucent
 *    layer down to the body colour, and taking the WORST of the three. A single
 *    centre sample misses text that straddles two fills (gantt section bands,
 *    pie slice edges, journey rows).
 *  - Alpha matters: pie slices paint at `pieOpacity` (0.7 by default), so their
 *    effective fill is a blend toward the canvas that no hex in the config shows.
 *  - Hit-testing is viewport-relative, so each text node is scrolled into view
 *    (`scrollIntoView({block:'center', inline:'center'})`) before it is sampled.
 *    That removes any dependency on the window being as large as the diagram —
 *    a 4000px-wide gantt is measured as accurately as a five-node flowchart.
 *
 * Why Electron and not `chromium.launch()`: the renderer this palette ships in
 * *is* Electron's Chromium, and `node_modules/electron` is already vendored,
 * whereas Playwright's own browser download is a separate ~150 MB artifact that
 * a plain `bun install` does not fetch. Driving Electron keeps the harness
 * runnable straight from a fresh checkout and measures the exact engine the app
 * uses. The host app is a throwaway two-file Electron app generated into
 * `.cache/` on each run — it loads no ClaudeUI code, so nothing about the real
 * app's state or IPC can perturb a measurement.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SELF), '..')

/**
 * Playwright's `_electron` driver does not work under bun: `electron.launch()`
 * spawns Electron and attaches the inspector, then never resolves (verified on
 * bun 1.3.14 / playwright 1.62.1 — it times out after 180 s). `app-shot.mjs`
 * carries the same "Node-only" caveat for the same driver.
 *
 * The rest of this script wants to be a bun script — it imports the app's
 * `mermaid-themes.ts` directly — so instead of picking one, re-exec under node,
 * which strips the types itself. `bun scripts/audit-mermaid-contrast.mjs` and
 * `node scripts/audit-mermaid-contrast.mjs` therefore both work, and neither
 * silently hangs.
 */
if (typeof globalThis.Bun !== 'undefined') {
  const r = spawnSync(
    process.execPath.includes('bun') ? 'node' : process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SELF, ...process.argv.slice(2)],
    { stdio: 'inherit', cwd: ROOT }
  )
  process.exit(r.status ?? 2)
}

const { _electron: electron } = await import('playwright')
const { THEME_CONFIGS, buildMermaidInitConfig } =
  await import('../src/renderer/src/components/chat/mermaid-themes.ts')

const MERMAID_DIST = join(ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
const HOST_DIR = join(ROOT, '.cache', 'mermaid-audit-host')

// ── Thresholds ───────────────────────────────────────────────────────────────
/** Hard floor. Anything below this is a bug and fails the run. */
const HARD_FLOOR = 3.0
/** Target for real labels (WCAG AA for normal-size text). */
const TARGET = 4.5

// ── App canvas colours ───────────────────────────────────────────────────────
/**
 * `--color-bg-primary` per app theme, mirrored from
 * src/renderer/src/assets/main.css (`@theme` = dark, `[data-theme='light']`,
 * `[data-theme='monokai']`). Duplicated rather than parsed because the CSS is a
 * Tailwind v4 `@theme` block, not something a script should try to interpret —
 * but it is only three values, and if they drift the shots make it obvious.
 */
const THEME_CANVAS = {
  dark: '#0d1117',
  light: '#f0f0f0',
  monokai: '#272822'
}

// ── Sample set ───────────────────────────────────────────────────────────────
/**
 * One source per diagram type, deliberately exercising the variable-heavy
 * features — the ones whose colours come from derived variables we do not set.
 * Keep these in sync with what mermaid supports; a type that stops parsing shows
 * up as a render failure (exit 2), never as a silent pass.
 */
const DIAGRAMS = [
  {
    name: 'flowchart',
    // subgraph → clusterBkg/clusterBorder + the subgraph title; edge labels →
    // edgeLabelBackground; shaped nodes → mainBkg/nodeBorder/nodeTextColor.
    source: `flowchart TD
  A[Client request] -->|authenticated| B{Route?}
  B -->|/api| C[API handler]
  B -->|/ws| D[WS upgrade]
  subgraph Backend
    C --> E[(Database)]
    D --> F[[Session broker]]
  end
  E -->|rows| G[/Response/]
  F -.->|stream| G
  G --> H((done))`
  },
  {
    name: 'sequence',
    // autonumber → sequenceNumberColor; loop/alt → labelBoxBkgColor +
    // loopTextColor; notes → noteBkgColor/noteTextColor; activations →
    // activationBkgColor.
    source: `sequenceDiagram
  autonumber
  participant U as User
  participant A as App
  participant S as Server
  U->>A: click send
  activate A
  A->>S: POST /message
  Note right of S: validates the payload<br/>then persists it
  loop every 500ms
    S-->>A: stream chunk
  end
  alt accepted
    S-->>A: 200 OK
  else rejected
    S-->>A: 422 Unprocessable
  end
  deactivate A
  A-->>U: rendered reply
  Note over U,A: end of turn`
  },
  {
    name: 'class',
    // Member/method rows are painted with `classText`; relationship labels with
    // the edge label styles.
    source: `classDiagram
  class Session {
    +String id
    +ThemeId theme
    -Engine engine
    +start(prompt: String) Promise
    +abort() void
  }
  class Engine {
    <<interface>>
    +send(msg) void
  }
  class ClaudeEngine {
    +String binaryPath
    +send(msg) void
  }
  Session "1" --> "1" Engine : delegates to
  Engine <|.. ClaudeEngine : implements
  Session ..> ThemeId : reads
  class ThemeId {
    <<enumeration>>
    dark
    light
    monokai
  }`
  },
  {
    name: 'state',
    // Composite states → compositeBackground/compositeTitleBackground/
    // altBackground; notes → noteBkgColor; transitions → transitionLabelColor.
    source: `stateDiagram-v2
  [*] --> Idle
  Idle --> Streaming : prompt sent
  state Streaming {
    [*] --> Assistant
    Assistant --> ToolUse : tool_use block
    ToolUse --> Assistant : tool_result
    Assistant --> [*] : stop
  }
  Streaming --> Idle : result
  Streaming --> Aborted : user abort
  note right of Aborted : partial transcript<br/>is still persisted
  Aborted --> [*]`
  },
  {
    name: 'er',
    // Attribute rows → attributeBackgroundColorOdd/Even, which mermaid derives
    // from `background` — and every config sets that to 'transparent'.
    source: `erDiagram
  PROJECT ||--o{ SESSION : contains
  SESSION ||--o{ MESSAGE : has
  SESSION }o--|| ENGINE : "runs on"
  PROJECT {
    string id PK
    string path
    string name
    datetime created_at
  }
  SESSION {
    string id PK
    string project_id FK
    string engine
    string title
    boolean archived
  }
  MESSAGE {
    string id PK
    string role
    string content
    int token_count
  }
  ENGINE {
    string name PK
    string version
  }`
  },
  {
    name: 'gantt',
    // done/active/crit bars → doneTaskBkgColor/activeTaskBkgColor/critBkgColor,
    // with taskText*Color for the labels inside and outside the bars; section
    // rows alternate sectionBkgColor/altSectionBkgColor.
    source: `gantt
  title Release train
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  section Engine layer
    stream-json harness      :done,    h1, 2026-01-05, 12d
    opencode transport       :done,    h2, after h1, 8d
    pi rpc transport         :active,  h3, after h2, 10d
  section Renderer
    diagram viewer           :active,  r1, 2026-02-01, 9d
    theme palette audit      :         r2, after r1, 6d
  section Ship
    release candidate        :crit,    s1, after r2, 4d
    store submission         :crit, milestone, s2, after s1, 0d`
  },
  {
    name: 'pie',
    // Slice labels → pieSectionTextColor over pie1..12 fills painted at
    // pieOpacity; legend → pieLegendTextColor over the body canvas.
    source: `pie showData
  title Tokens by engine
  "claude-code" : 4210
  "opencode" : 2870
  "pi" : 1640
  "codex" : 980
  "other" : 415
  "cached" : 3305`
  },
  {
    name: 'gitGraph',
    // Commit labels → commitLabelColor on commitLabelBackground; branch labels →
    // gitBranchLabel0..7 on git0..7 (two of which default to inverted text);
    // tags → tagLabelColor on tagLabelBackground.
    source: `gitGraph
  commit id: "init"
  commit id: "engine-layer"
  branch develop
  checkout develop
  commit id: "opencode"
  commit id: "pi-rpc"
  checkout main
  merge develop tag: "v0.9.0"
  branch release
  checkout release
  commit id: "rc1"
  checkout main
  merge release tag: "v1.0.0"`
  },
  {
    name: 'journey',
    // Task rows sit on cScale*/section fills with cScaleLabel* text; the actor
    // faces and section titles use the same series palette.
    source: `journey
  title Debugging a failed session
  section Reproduce
    Open the session: 5: Dev
    Replay transcript: 3: Dev, QA
    Spot the stall: 1: Dev
  section Fix
    Read the wire log: 3: Dev
    Patch the transport: 4: Dev
    Add a guard test: 5: Dev, QA`
  },
  {
    name: 'timeline',
    // Section headers and event bubbles are cScale*/cScaleLabel* — the pairing
    // mermaid's dark base resolves to black-on-dark.
    source: `timeline
  title ClaudeUI engine support
  section 2025
    Q3 : Claude Code harness : stream-json
    Q4 : Session persistence
  section 2026
    Q1 : opencode over HTTP+SSE : pi over stdio JSONL
    Q2 : Multi-engine session layer : Remote access`
  },
  {
    name: 'mindmap',
    // Every branch level takes a cScale*/cScaleLabel* pair.
    source: `mindmap
  root((ClaudeUI))
    Engines
      Claude Code
        stream-json
      opencode
      pi
    Renderer
      React 19
      Diagram viewer
    Persistence
      better-sqlite3
      Transcript store
    Remote
      Tailscale serve`
  },
  {
    name: 'quadrantChart',
    // quadrant1..4Fill with quadrant1..4TextFill, plus point/axis/title fills —
    // all derived by nudging primaryColor/primaryTextColor by a few RGB steps.
    source: `quadrantChart
  title Engine capability vs effort
  x-axis Low effort --> High effort
  y-axis Narrow capability --> Broad capability
  quadrant-1 Invest
  quadrant-2 Quick wins
  quadrant-3 Deprioritise
  quadrant-4 Reconsider
  Claude Code: [0.75, 0.9]
  opencode: [0.6, 0.7]
  pi: [0.35, 0.45]
  Codex: [0.55, 0.3]
  Legacy shim: [0.2, 0.15]`
  },
  {
    name: 'requirement',
    // requirementBackground/requirementTextColor plus relationLabelBackground
    // and relationLabelColor on the arrow labels.
    source: `requirementDiagram
  requirement session_persistence {
    id: 1
    text: sessions survive an app restart
    risk: high
    verifymethod: test
  }
  functionalRequirement transcript_replay {
    id: 1.1
    text: transcripts replay in order
    risk: medium
    verifymethod: demonstration
  }
  element sqlite_store {
    type: module
    docref: src/main/persistence
  }
  session_persistence - contains -> transcript_replay
  sqlite_store - satisfies -> session_persistence`
  },
  {
    name: 'xychart',
    // xyChart.* (axis labels/titles/ticks + plot palette) — a nested config
    // object, so a flat themeVariable cannot reach it; only `xyChart` can.
    source: `xychart-beta
  title "Renderer bundle size by release"
  x-axis [v0.6, v0.7, v0.8, v0.9, v1.0]
  y-axis "kB (gzip)" 200 --> 520
  bar [480, 452, 410, 366, 318]
  line [480, 452, 410, 366, 318]`
  }
]

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}

const onlyTheme = opt('theme', null)
const themes = onlyTheme ? [onlyTheme] : Object.keys(THEME_CONFIGS)
for (const t of themes) {
  if (!THEME_CONFIGS[t]) {
    console.error(`[audit] unknown theme "${t}" — known: ${Object.keys(THEME_CONFIGS).join(', ')}`)
    process.exit(2)
  }
}
const wantShots = flag('shots')
const showAll = flag('all')
const jsonOut = opt('json', null)
const shotsDir = join(ROOT, '.cache', 'screenshots', 'mermaid-audit')

// ── In-page measurement ──────────────────────────────────────────────────────
/**
 * Serialized into the browser once per page and reused for every diagram. Kept
 * as a string (rather than a `page.evaluate` closure per diagram) so the helper
 * definitions live in exactly one place and are readable as ordinary code.
 */
/**
 * The in-page measurement routine.
 *
 * Written as a real function and shipped to the page via `.toString()` rather
 * than as a template string: a string would not be parsed, linted or formatted
 * by anything, and nested template literals inside it would silently terminate
 * the outer literal. It closes over nothing from module scope.
 */
function measureFactory() {
  const HTML_NS = 'http://www.w3.org/1999/xhtml'
  /** SVG elements that actually paint a fill we can treat as a background. */
  const SVG_PAINTERS = new Set([
    'rect',
    'circle',
    'ellipse',
    'path',
    'polygon',
    'polyline',
    'line',
    'use',
    'image'
  ])

  function parsePaint(str) {
    if (!str) return null
    const s = String(str).trim()
    if (s === 'none' || s === 'transparent' || s === '') return null
    if (s.startsWith('url(')) return { unresolved: true }
    const m = /^rgba?\(([^)]+)\)$/.exec(s)
    if (!m) return null
    // Comma, whitespace or the `/` of the modern `rgb(r g b / a)` syntax.
    const p = m[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number)
    if (p.length < 3 || p.slice(0, 3).some((n) => Number.isNaN(n))) return null
    const a = p.length > 3 && !Number.isNaN(p[3]) ? p[3] : 1
    if (a === 0) return null
    return { r: p[0], g: p[1], b: p[2], a }
  }

  /** Product of `opacity` from el up to <body> — group opacity is inherited-ish. */
  function cumulativeOpacity(el) {
    let o = 1
    let cur = el
    while (cur && cur !== document.body && cur.nodeType === 1) {
      const v = parseFloat(getComputedStyle(cur).opacity)
      if (!Number.isNaN(v)) o *= v
      cur = cur.parentElement
    }
    return o
  }

  /** The background this element contributes at a hit-test point, or null. */
  function backgroundPaint(el) {
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') return null
    if (el.namespaceURI === HTML_NS) {
      const c = parsePaint(cs.backgroundColor)
      if (!c || c.unresolved) return c
      return { ...c, a: c.a * cumulativeOpacity(el) }
    }
    const tag = el.tagName.toLowerCase()
    if (tag === 'svg') {
      // Only a CSS background can paint here; mermaid's `background` variable
      // is 'transparent' in every ClaudeUI config, so this is normally null.
      const c = parsePaint(cs.backgroundColor)
      if (!c || c.unresolved) return c
      return { ...c, a: c.a * cumulativeOpacity(el) }
    }
    if (!SVG_PAINTERS.has(tag)) return null // g / defs / text / tspan / foreignObject
    const c = parsePaint(cs.fill)
    if (!c || c.unresolved) return c
    const fo = parseFloat(cs.fillOpacity)
    const a = c.a * (Number.isNaN(fo) ? 1 : fo) * cumulativeOpacity(el)
    return a === 0 ? null : { ...c, a }
  }

  function over(top, bottom) {
    const a = top.a
    return {
      r: top.r * a + bottom.r * (1 - a),
      g: top.g * a + bottom.g * (1 - a),
      b: top.b * a + bottom.b * (1 - a),
      a: 1
    }
  }

  function relLum(c) {
    const f = (v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }

  function ratio(a, b) {
    const la = relLum(a)
    const lb = relLum(b)
    const hi = Math.max(la, lb)
    const lo = Math.min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
  }

  const hex = (c) =>
    '#' +
    [c.r, c.g, c.b]
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')

  /**
   * Resolve the effective background under one point: walk the hit-test stack
   * top-down, keep every translucent layer until an opaque one, then composite
   * the kept layers back down onto the body colour.
   */
  function bgAt(x, y, bodyColor) {
    const stack = document.elementsFromPoint(x, y)
    if (!stack.length) return { color: bodyColor, unresolved: false, empty: true }
    const layers = []
    let unresolved = false
    for (const el of stack) {
      const paint = backgroundPaint(el)
      if (!paint) continue
      if (paint.unresolved) {
        // A gradient/pattern fill. Recorded rather than guessed — a fabricated
        // colour here would turn into a fabricated pass or fail.
        unresolved = true
        continue
      }
      layers.push(paint)
      if (paint.a >= 0.999) break
    }
    let acc = bodyColor
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc)
    return { color: acc, unresolved, empty: false }
  }

  /**
   * Every visible text carrier in `root`, measured. Leaf-only: a <text> whose
   * glyphs live in <tspan> children is represented by the tspans, not both.
   */
  return function measure(root, bodyColorStr) {
    const bodyColor = parsePaint(bodyColorStr) || { r: 255, g: 255, b: 255, a: 1 }
    const candidates = Array.from(
      root.querySelectorAll('text, tspan, foreignObject div, foreignObject span, foreignObject p')
    ).filter((el) => (el.textContent || '').trim().length > 0)
    const leaves = candidates.filter((el) => !candidates.some((o) => o !== el && el.contains(o)))

    const measured = []
    // Every skipped node is recorded with a reason. A bare count would let a
    // measurement gap ("we never looked at those 8 labels") masquerade as a pass.
    const skipped = []
    let invisible = 0
    let offscreen = 0
    let unresolvedFg = 0
    const skip = (el, reason) => {
      if (skipped.length < 40) {
        skipped.push({
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30),
          cls: (typeof el.className === 'string' ? el.className : el.getAttribute('class')) || '',
          reason
        })
      }
    }

    for (const el of leaves) {
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') {
        invisible++
        skip(el, 'display/visibility')
        continue
      }
      if (el.getBoundingClientRect().width <= 0) {
        invisible++
        skip(el, 'zero width')
        continue
      }

      // Hit-testing is viewport-relative: bring the node into view first, then
      // re-read its box at the new scroll offset. Without this, everything below
      // the fold reports the bare body colour as its background — a silent pass.
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        invisible++
        skip(el, 'zero box')
        continue
      }
      if (
        rect.bottom < 0 ||
        rect.right < 0 ||
        rect.top > window.innerHeight ||
        rect.left > window.innerWidth
      ) {
        // Larger than the window in one axis and unscrollable to — recorded, not
        // silently dropped.
        offscreen++
        skip(el, 'unreachable by scroll')
        continue
      }

      const isHtml = el.namespaceURI === HTML_NS
      const fgRaw = parsePaint(isHtml ? cs.color : cs.fill)
      if (!fgRaw || fgRaw.unresolved) {
        unresolvedFg++
        skip(el, `unresolvable text paint (${isHtml ? cs.color : cs.fill})`)
        continue
      }
      const fillOpacity = isHtml
        ? 1
        : Number.isNaN(parseFloat(cs.fillOpacity))
          ? 1
          : parseFloat(cs.fillOpacity)
      const fgAlpha = fgRaw.a * fillOpacity * cumulativeOpacity(el)
      if (fgAlpha <= 0.02) {
        invisible++
        skip(el, `alpha ${fgAlpha.toFixed(3)}`)
        continue
      }

      const cy = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2))
      const xs = [
        rect.left + rect.width * 0.25,
        rect.left + rect.width * 0.5,
        rect.left + rect.width * 0.75
      ].map((x) => Math.min(window.innerWidth - 1, Math.max(0, x)))

      let worst = null
      for (const x of xs) {
        const bg = bgAt(x, cy, bodyColor)
        // The text's own alpha composites onto whatever is behind it before the
        // ratio — faded text is genuinely lower contrast, not just "grey".
        const fg = over({ ...fgRaw, a: fgAlpha }, bg.color)
        const r = ratio(fg, bg.color)
        if (!worst || r < worst.ratio) {
          worst = { ratio: r, fg: hex(fg), bg: hex(bg.color), unresolvedLayer: bg.unresolved, x }
        }
      }

      const fontSize = parseFloat(cs.fontSize) || 0
      const fontWeight = cs.fontWeight
      measured.push({
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30),
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : el.getAttribute('class')) || '',
        fg: worst.fg,
        bg: worst.bg,
        ratio: Math.round(worst.ratio * 100) / 100,
        fontSize: Math.round(fontSize * 10) / 10,
        fontWeight,
        unresolvedLayer: worst.unresolvedLayer
      })
    }

    return { measured, skipped, invisible, offscreen, unresolvedFg, leafCount: leaves.length }
  }
}

const PAGE_HTML = (canvas) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: ${canvas}; }
  body { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }
  #stage { padding: 16px; }
  .diagram { margin: 0 0 8px 0; }
  h2.heading { font-size: 13px; margin: 18px 0 6px 0; opacity: .75; }
</style></head><body><div id="stage"></div></body></html>`

// ── Electron host app ────────────────────────────────────────────────────────
/**
 * Generate the throwaway Electron app the measurements run in.
 *
 * Written fresh on every run so it can never drift from this script. The window
 * is shown (a hidden window produces no compositor frames, so `--shots` would
 * capture nothing) but parked far off the virtual desktop and kept out of the
 * taskbar, and shown *inactive*, so an audit never steals focus or covers the
 * screen — the same trick `scripts/app-shot.mjs` documents for CLAUDEUI_HEADLESS.
 */
function writeHostApp() {
  mkdirSync(HOST_DIR, { recursive: true })
  writeFileSync(
    join(HOST_DIR, 'package.json'),
    JSON.stringify({ name: 'mermaid-audit-host', version: '0.0.0', main: 'main.js' }, null, 2)
  )
  writeFileSync(
    join(HOST_DIR, 'main.js'),
    `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1100,
    x: -20000,
    y: -20000,
    show: false,
    skipTaskbar: true,
    // No preload, no node integration: the page is pure DOM + the vendored
    // mermaid bundle. Nothing from ClaudeUI is loaded.
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  })
  win.loadURL('about:blank')
  win.showInactive()
})
app.on('window-all-closed', () => app.quit())
`
  )
  return HOST_DIR
}

// ── Per-theme run ────────────────────────────────────────────────────────────
async function auditTheme(page, theme) {
  const canvas = THEME_CANVAS[theme]
  if (!canvas) throw new Error(`no --color-bg-primary mirrored for theme "${theme}"`)
  const config = buildMermaidInitConfig(THEME_CONFIGS[theme])

  const consoleErrors = []
  const onPageError = (e) => consoleErrors.push(`pageerror: ${e.message}`)
  page.on('pageerror', onPageError)
  await page.setContent(PAGE_HTML(canvas))
  await page.addScriptTag({ path: MERMAID_DIST })
  await page.evaluate(`window.__measure = (${measureFactory.toString()})()`)

  // Render every sample with the app's exact config. Failures are captured per
  // diagram; a throw here would hide which types DID render.
  const rendered = await page.evaluate(
    async ({ config, diagrams }) => {
      window.mermaid.initialize(config)
      const out = []
      for (const d of diagrams) {
        try {
          const { svg } = await window.mermaid.render(`audit-${d.name}`, d.source)
          out.push({ name: d.name, ok: true, svg })
        } catch (err) {
          out.push({
            name: d.name,
            ok: false,
            error: err && err.message ? err.message : String(err)
          })
        } finally {
          // mermaid leaves its scratch container behind on failure.
          document.getElementById(`daudit-${d.name}`)?.remove()
        }
      }
      return out
    },
    { config, diagrams: DIAGRAMS }
  )

  const results = []
  for (const r of rendered) {
    if (!r.ok) {
      results.push({ diagram: r.name, renderError: r.error, measured: [] })
      continue
    }

    // One diagram at a time — the measurement scrolls each text node into view,
    // so a lone diagram in the stage keeps the scroll maths trivial and stops a
    // neighbouring diagram from ever landing under a hit-test point.
    const m = await page.evaluate(
      ({ svg, bodyColor }) => {
        const stage = document.getElementById('stage')
        stage.innerHTML = `<div class="diagram">${svg}</div>`
        const el = stage.querySelector('svg')
        // Mermaid's own max-width style can shrink the diagram; measure it at its
        // intrinsic size, exactly as the app's viewport shows it at zoom 1.
        if (el) el.style.maxWidth = 'none'
        return window.__measure(stage, bodyColor)
      },
      { svg: r.svg, bodyColor: canvas }
    )

    results.push({ diagram: r.name, ...m })
  }

  // ── Optional screenshot sheet ──────────────────────────────────────────────
  /**
   * Chromium refuses to composite a surface past roughly 16384 px in one axis; a
   * `fullPage` shot of the whole stacked sheet came back 17692 px tall with a
   * corrupted, duplicated tail — the last diagram silently replaced by a repeat
   * of the first. Since a wrong screenshot is worse than a smaller one, the sheet
   * is scaled to fit under the cap, and the scale is logged so nobody reads font
   * sizes off it.
   *
   * The cap is in DEVICE pixels: on a 2x display the sheet measured ~8846 CSS px
   * and still blew the limit, so comparing `scrollHeight` alone silently does
   * nothing on exactly the machines where it matters.
   */
  const SHEET_MAX_DEVICE_PX = 15000
  let shot = null
  let shotScale = 1
  let shotFullHeight = 0
  if (wantShots) {
    const sheet = await page.evaluate(
      ({ items, textColor, maxPx }) => {
        const stage = document.getElementById('stage')
        stage.style.zoom = ''
        stage.innerHTML = items
          .map((i) =>
            i.ok
              ? `<h2 class="heading" style="color:${textColor}">${i.name}</h2><div class="diagram">${i.svg}</div>`
              : `<h2 class="heading" style="color:#f87171">${i.name} — RENDER FAILED: ${i.error}</h2>`
          )
          .join('')
        const dpr = window.devicePixelRatio || 1
        const full = stage.scrollHeight
        const fullDevice = full * dpr
        const scale = fullDevice > maxPx ? maxPx / fullDevice : 1
        if (scale < 1) stage.style.zoom = String(scale)
        return { fullHeight: full, fullDeviceHeight: Math.round(fullDevice), dpr, scale }
      },
      {
        items: rendered,
        // Headings only label the sheet; they are not part of the audit.
        textColor: theme === 'light' ? '#000000' : '#d1d5db',
        maxPx: SHEET_MAX_DEVICE_PX
      }
    )
    mkdirSync(shotsDir, { recursive: true })
    shot = join(shotsDir, `${theme}.png`)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: shot, fullPage: true })
    shotScale = sheet.scale
    shotFullHeight = sheet.fullDeviceHeight
  }

  page.off('pageerror', onPageError)
  return { theme, canvas, results, consoleErrors, shot, shotScale, shotFullHeight }
}

// ── Reporting ────────────────────────────────────────────────────────────────
function report(themeRuns) {
  let hardFails = 0
  let softFails = 0
  let harnessFails = 0
  let totalMeasured = 0

  console.log('')
  console.log(`mermaid contrast audit — hard floor ${HARD_FLOOR}, target ${TARGET}`)
  console.log('='.repeat(78))

  for (const run of themeRuns) {
    const pairs = []
    const renderErrors = []
    const emptyDiagrams = []
    let themeMeasured = 0

    for (const r of run.results) {
      if (r.renderError) {
        renderErrors.push(`${r.diagram}: ${r.renderError}`)
        continue
      }
      if (!r.measured || r.measured.length === 0) {
        // Honesty guard: a diagram with zero measured text was NOT audited.
        emptyDiagrams.push(
          `${r.diagram} (leaves=${r.leafCount}, invisible=${r.invisible}, offscreen=${r.offscreen}, unresolvedFg=${r.unresolvedFg})`
        )
        continue
      }
      themeMeasured += r.measured.length
      if (r.offscreen > 0) {
        // Text that could not be scrolled into view was not measured — say so
        // rather than let the diagram look fully audited.
        console.log(
          `  ! ${run.theme}/${r.diagram}: ${r.offscreen} text node(s) could not be brought into view; NOT measured`
        )
        harnessFails++
      }
      for (const t of r.measured) pairs.push({ diagram: r.diagram, ...t })
    }

    totalMeasured += themeMeasured
    const hard = pairs.filter((p) => p.ratio < HARD_FLOOR).sort((a, b) => a.ratio - b.ratio)
    const soft = pairs
      .filter((p) => p.ratio >= HARD_FLOOR && p.ratio < TARGET)
      .sort((a, b) => a.ratio - b.ratio)
    hardFails += hard.length
    softFails += soft.length
    harnessFails += renderErrors.length + emptyDiagrams.length

    console.log('')
    console.log(`── ${run.theme} (canvas ${run.canvas}) ──`)
    console.log(
      `   diagrams: ${run.results.length}   rendered: ${run.results.length - renderErrors.length}   text nodes measured: ${themeMeasured}`
    )
    console.log(
      `   below ${HARD_FLOOR}: ${hard.length}    [${HARD_FLOOR}, ${TARGET}): ${soft.length}`
    )

    // Skipped nodes, with reasons. Always printed: "N measured" is only
    // trustworthy alongside "and here is what we did not measure, and why".
    const skippedTotal = run.results.reduce((n, r) => n + (r.skipped?.length ?? 0), 0)
    if (skippedTotal > 0) {
      console.log(`   skipped text nodes: ${skippedTotal} (not measured — reasons below)`)
      for (const r of run.results) {
        if (!r.skipped?.length) continue
        const grouped = new Map()
        for (const s of r.skipped) grouped.set(s.reason, (grouped.get(s.reason) ?? 0) + 1)
        const summary = [...grouped].map(([reason, n]) => `${n}× ${reason}`).join(', ')
        console.log(`     · ${r.diagram}: ${summary}`)
      }
    }

    if (renderErrors.length) {
      console.log(`   RENDER FAILURES (${renderErrors.length}) — these types were NOT audited:`)
      for (const e of renderErrors) console.log(`     ✗ ${e}`)
    }
    if (emptyDiagrams.length) {
      console.log(`   ZERO TEXT MEASURED (${emptyDiagrams.length}) — measurement bug, not a pass:`)
      for (const e of emptyDiagrams) console.log(`     ✗ ${e}`)
    }
    if (run.consoleErrors.length) {
      console.log(`   page errors: ${run.consoleErrors.length}`)
      for (const e of run.consoleErrors.slice(0, 5)) console.log(`     · ${e}`)
    }

    const show = showAll ? pairs.slice().sort((a, b) => a.ratio - b.ratio) : [...hard, ...soft]
    if (show.length) {
      console.log('')
      console.log(
        `   ${'ratio'.padStart(6)}  ${'diagram'.padEnd(14)} ${'fg'.padEnd(8)} ${'bg'.padEnd(8)} ${'px'.padStart(4)} ${'wt'.padStart(4)}  text`
      )
      for (const p of show) {
        const mark = p.ratio < HARD_FLOOR ? '✗' : p.ratio < TARGET ? '~' : ' '
        console.log(
          `  ${mark}${p.ratio.toFixed(2).padStart(5)}  ${p.diagram.padEnd(14)} ${p.fg.padEnd(8)} ${p.bg.padEnd(8)} ${String(p.fontSize).padStart(4)} ${String(p.fontWeight).padStart(4)}  ${JSON.stringify(p.text)}${p.unresolvedLayer ? '  [gradient layer skipped]' : ''}`
        )
      }
    }
    if (run.shot) {
      const scaled =
        run.shotScale < 1
          ? ` (scaled ${(run.shotScale * 100).toFixed(0)}% — the unscaled sheet is ${run.shotFullHeight} device px, past Chromium's capture limit)`
          : ''
      console.log(`   shot: ${run.shot}${scaled}`)
    }
  }

  console.log('')
  console.log('='.repeat(78))
  console.log(
    `TOTALS  measured: ${totalMeasured}   below ${HARD_FLOOR}: ${hardFails}   [${HARD_FLOOR}, ${TARGET}): ${softFails}   harness failures: ${harnessFails}`
  )
  if (harnessFails > 0)
    console.log('RESULT: HARNESS FAILURE — some diagram types were not audited (exit 2)')
  else if (hardFails > 0)
    console.log(`RESULT: FAIL — ${hardFails} pair(s) below the ${HARD_FLOOR} hard floor (exit 1)`)
  else console.log('RESULT: CLEAN — nothing below the hard floor (exit 0)')

  return { hardFails, softFails, harnessFails, totalMeasured }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[audit] mermaid: ${MERMAID_DIST}`)
  console.log(`[audit] themes: ${themes.join(', ')}`)
  const hostDir = writeHostApp()
  console.log(`[audit] electron host: ${hostDir}`)
  const app = await electron.launch({ args: [hostDir], cwd: ROOT })
  const runs = []
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    for (const theme of themes) runs.push(await auditTheme(page, theme))
  } finally {
    await app.close()
  }

  const totals = report(runs)

  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true })
    writeFileSync(jsonOut, JSON.stringify({ totals, runs }, null, 2))
    console.log(`[audit] json: ${jsonOut}`)
  }

  if (totals.harnessFails > 0) return 2
  if (totals.hardFails > 0) return 1
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n[audit] ERROR: ${err?.stack || err}`)
    process.exit(2)
  })
