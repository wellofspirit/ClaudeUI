/**
 * Mermaid theme palettes + the exact init config the renderer feeds
 * `mermaid.initialize`.
 *
 * Why this is its own module, free of React/zustand imports: the palettes are
 * audited by `scripts/audit-mermaid-contrast.mjs`, which drives real mermaid in
 * real Chromium and measures text/background contrast per diagram type. That
 * harness has to run mermaid with *exactly* the app's config, or its
 * measurements describe a diagram nobody ever sees. So the config object lives
 * here as data + one builder, imported by both the component and the script
 * (bun imports this .ts directly). `ThemeId` is an `import type`, erased at
 * runtime, so importing this file never pulls the session store into a bun
 * process.
 *
 * ## The class of bug the extra overrides below exist to prevent
 *
 * mermaid derives hundreds of variables from a handful of seeds (see
 * `node_modules/mermaid/dist/mermaid.js`, `src/themes/theme-dark.js` /
 * `theme-default.js`). Anything we do not override is derived — by formulas
 * written for mermaid's own seeds, not ours. Worse, `Theme.calculate()` applies
 * our overrides, runs `updateColors()`, then re-applies our overrides: any
 * variable *derived from* one we override is computed from mermaid's default,
 * and keeps that value. `taskTextDarkColor = invert(doneTaskBkgColor)` is the
 * clearest case — it is computed from mermaid's light-grey default, not from our
 * dark `doneTaskBkgColor`, so gantt "done" bars ended up with #2c2c2c text on a
 * #0f2a20 bar (measured ratio 1.10).
 *
 * None of that is visible from reading this file: the offending colour never
 * appears in it. So every override here is either "a seed we chose" or "a
 * derived variable a measurement proved wrong" — and the measurement is
 * `scripts/audit-mermaid-contrast.mjs`, which renders every diagram type in
 * every theme in real Chromium and reports WCAG contrast per text node.
 *
 * Re-run that audit after any edit here, and after every mermaid bump.
 */

import type { MermaidConfig } from 'mermaid'
import type { ThemeId } from '../../stores/session-store'

/** The mermaid base themes we build on. */
export type MermaidTheme = 'dark' | 'default' | 'neutral' | 'forest'

/**
 * Base mermaid theme + variable overrides, keyed by app theme.
 *
 * Values are mostly colour strings, but a few mermaid theme variables are nested
 * objects (`xyChart`, and upstream also `packet`, `radar`, `wardley`, `cynefin`),
 * hence the union. Nested groups are all-or-nothing: `Theme.calculate()` applies
 * our overrides, derives the full object in `updateColors()`, then re-applies our
 * overrides on top — so a *partial* `xyChart` replaces the derived one and leaves
 * its other keys `undefined`. For `xyChart` that is not merely a wrong colour:
 * the renderer calls `plotColorPalette.split(',')`, which throws. Any nested
 * group listed below therefore spells out every key mermaid defines for it.
 */
export interface MermaidThemeConfig {
  base: MermaidTheme
  variables: Record<string, string | Record<string, string>>
}

/**
 * Custom mermaid theme palettes matched to our app themes.
 * Each uses 'base' as the mermaid base theme, then overrides variables
 * to match the app's color palette.
 */
export const THEME_CONFIGS: Record<ThemeId, MermaidThemeConfig> = {
  // Dark theme — cool blue tones matching #0d1117 bg
  dark: {
    base: 'dark',
    variables: {
      background: 'transparent',
      // Nodes — blue-tinted fills that stand out from the dark canvas
      primaryColor: '#152540',
      primaryTextColor: '#d1d5db',
      primaryBorderColor: '#6c9eff',
      lineColor: '#6c9eff', // blue edges for visibility
      secondaryColor: '#1a1535', // purple tint for variety
      tertiaryColor: '#0f2a20', // green tint
      textColor: '#d1d5db',
      mainBkg: '#152540',
      nodeBorder: '#6c9eff',
      clusterBkg: '#0d1117',
      clusterBorder: '#343a46',
      titleColor: '#d1d5db',
      edgeLabelBackground: '#111318',
      nodeTextColor: '#d1d5db',
      // Sequence diagram
      actorTextColor: '#d1d5db',
      actorBkg: '#152540',
      actorBorder: '#6c9eff',
      actorLineColor: '#4b5261',
      signalColor: '#d1d5db',
      signalTextColor: '#d1d5db',
      // Autonumber digits. mermaid's dark base hardcodes `sequenceNumberColor:
      // "black"` and draws the number straight onto the canvas — measured 1.11.
      sequenceNumberColor: '#d1d5db',
      // Notes — subtle warm tint
      noteBkgColor: '#1f1a10',
      noteBorderColor: '#fbbf24',
      noteTextColor: '#d1d5db',
      // Labels
      labelBoxBkgColor: '#152540',
      labelBoxBorderColor: '#6c9eff',
      labelTextColor: '#d1d5db',
      loopTextColor: '#8b929e',
      // Sections
      sectionBkgColor: '#152540',
      altSectionBkgColor: '#111318',
      sectionBkgColor2: '#0d1117',
      // Tasks
      taskBkgColor: '#152540',
      taskTextColor: '#d1d5db',
      taskBorderColor: '#6c9eff',
      activeTaskBkgColor: '#0f2a20',
      activeTaskBorderColor: '#4ade80',
      doneTaskBkgColor: '#0f2a20',
      doneTaskBorderColor: '#4ade80',
      critBkgColor: '#2a1015',
      critBorderColor: '#f87171',
      // gantt done/active bars use `.doneText*`/`.activeText*`, which are
      // `fill: taskTextDarkColor !important` — so they beat the `taskTextColor`
      // above. taskTextDarkColor is derived as invert(doneTaskBkgColor) from
      // mermaid's light-grey *default* bar, landing on #2c2c2c: dark text on our
      // dark bars (measured 1.10). Same story for text that overflows the bar
      // (taskTextOutsideColor). Both pinned light.
      taskTextDarkColor: '#d1d5db',
      taskTextOutsideColor: '#d1d5db',
      // ER diagrams — mermaid's 'dark' base hardcodes attribute-row fills to
      // #ffffff / #f2f2f2 (white) regardless of dark mode, which leaves the
      // theme's light text unreadable. Override to dark fills.
      attributeBackgroundColorEven: '#152540',
      attributeBackgroundColorOdd: '#0d1117',
      // ── gitGraph + mindmap root ───────────────────────────────────────────
      // git0..7 fill the commit dots AND the branch-label pills; gitBranchLabel*
      // colours the pill text. mermaid derives the pills by lightening our dark
      // seeds, which lands them at mixed lightness, and then sets
      // gitBranchLabel0 = invert(labelTextColor) (dark) while other indices fall
      // through to a hardcoded `lightgrey` — so branch 0 measured 1.30 and
      // branch 2 measured 2.50 in the same diagram. Fixing one label colour
      // cannot satisfy both, so the fills are pinned to a light, mutually
      // distinct set (they also read better as commit dots on a dark canvas) and
      // every label is dark-on-light. mindmap's root node uses git0 /
      // gitBranchLabel0 too, so it is fixed by the same pair.
      git0: '#8fb3f0', // blue
      git1: '#b39ae8', // purple
      git2: '#7fd4a8', // green
      git3: '#e8c07a', // amber
      git4: '#7fd0e0', // cyan
      git5: '#f0949f', // red
      git6: '#a8b6d9', // slate
      git7: '#8fd9c8', // teal
      gitBranchLabel0: '#0d1117',
      gitBranchLabel1: '#0d1117',
      gitBranchLabel2: '#0d1117',
      gitBranchLabel3: '#0d1117',
      gitBranchLabel4: '#0d1117',
      gitBranchLabel5: '#0d1117',
      gitBranchLabel6: '#0d1117',
      gitBranchLabel7: '#0d1117',
      // ── xychart ───────────────────────────────────────────────────────────
      // Bars and lines are fills, so the contrast audit cannot see them — which
      // is exactly why they are pinned rather than derived. `plotColorPalette`
      // otherwise falls through to a fixed ten-colour list that belongs to no
      // theme here (and on the 'default' base starts with #ECECFF, invisible on
      // a light canvas). Series reuse the git0..7 hues so gitGraph, mindmap and
      // xychart share one recognisable set; the renderer indexes it modulo its
      // length, so eight entries is safe. Every other key is spelled out because
      // a partial nested object loses the rest — see MermaidThemeConfig.
      xyChart: {
        backgroundColor: 'transparent',
        titleColor: '#d1d5db',
        dataLabelColor: '#d1d5db',
        xAxisTitleColor: '#d1d5db',
        xAxisLabelColor: '#d1d5db',
        xAxisTickColor: '#4b5261',
        xAxisLineColor: '#4b5261',
        yAxisTitleColor: '#d1d5db',
        yAxisLabelColor: '#d1d5db',
        yAxisTickColor: '#4b5261',
        yAxisLineColor: '#4b5261',
        plotColorPalette: '#8fb3f0,#b39ae8,#7fd4a8,#e8c07a,#7fd0e0,#f0949f,#a8b6d9,#8fd9c8'
      }
    }
  },

  // Light theme — clean with blue accents on #f0f0f0 bg
  light: {
    base: 'default',
    variables: {
      background: 'transparent',
      primaryColor: '#dce6f5',
      primaryTextColor: '#000000',
      primaryBorderColor: '#3a6fd8',
      lineColor: '#4b5060',
      secondaryColor: '#e8ecf2',
      tertiaryColor: '#f0f3f8',
      textColor: '#000000',
      mainBkg: '#dce6f5',
      nodeBorder: '#3a6fd8',
      clusterBkg: '#dddfe3',
      clusterBorder: '#9a9ea8',
      titleColor: '#000000',
      edgeLabelBackground: '#dddfe3',
      nodeTextColor: '#000000',
      // Autonumber digits — the 'default' base hardcodes white, drawn onto the
      // light canvas (measured 1.14).
      sequenceNumberColor: '#000000',
      // ── Series label colours (timeline / mindmap / journey) ───────────────
      // cScaleLabel0..11 default to `labelTextColor`, except 0 and 3 which the
      // 'default' base sets to invert(labelTextColor) — i.e. white — over the
      // mid-tone cScale* fills (mindmap measured 2.57, timeline 3.06). The fills
      // themselves are left to mermaid: only the text needed to change. All
      // twelve indices plus `scaleLabelColor` (the fallback for anything past 11)
      // are pinned black, and `labelTextColor` is pinned so the two inverted
      // indices cannot reintroduce white.
      labelTextColor: '#000000',
      scaleLabelColor: '#000000',
      cScaleLabel0: '#000000',
      cScaleLabel1: '#000000',
      cScaleLabel2: '#000000',
      cScaleLabel3: '#000000',
      cScaleLabel4: '#000000',
      cScaleLabel5: '#000000',
      cScaleLabel6: '#000000',
      cScaleLabel7: '#000000',
      cScaleLabel8: '#000000',
      cScaleLabel9: '#000000',
      cScaleLabel10: '#000000',
      cScaleLabel11: '#000000',
      // ── gantt ─────────────────────────────────────────────────────────────
      // The 'default' base ships white task text on a #8a90dd bar (measured
      // 2.95) and white on a pure-'red' crit bar (4.00), plus a
      // rgba(102,102,255,.49)/#fff400 section banding that belongs to no theme
      // here. Bars become light tints of the app palette and every task text
      // colour is pinned black — including the two derived ones
      // (taskTextDarkColor, taskTextOutsideColor) that `.doneText*`/
      // `.taskTextOutside*` apply with !important.
      sectionBkgColor: '#dce6f5',
      altSectionBkgColor: '#f0f0f0',
      sectionBkgColor2: '#e8ecf2',
      excludeBkgColor: '#dddfe3',
      taskBkgColor: '#c3d5ef',
      taskBorderColor: '#3a6fd8',
      taskTextColor: '#000000',
      taskTextLightColor: '#000000',
      taskTextDarkColor: '#000000',
      taskTextOutsideColor: '#000000',
      activeTaskBkgColor: '#bfe4c8',
      activeTaskBorderColor: '#15803d',
      doneTaskBkgColor: '#dfe2e6',
      doneTaskBorderColor: '#6b7080',
      critBkgColor: '#f6c9c9',
      critBorderColor: '#b91c1c',
      gridColor: '#9a9ea8',
      todayLineColor: '#b91c1c',
      // ── gitGraph + mindmap root ───────────────────────────────────────────
      // gitBranchLabel0 is invert(labelTextColor); pinning labelTextColor black
      // above would have flipped it to white on a light pill, so the pills get a
      // mid-tone set (visible as commit dots against #f0f0f0) and every label is
      // black. mindmap's root node shares git0 / gitBranchLabel0.
      git0: '#6f9be0', // blue
      git1: '#9b83d6', // purple
      git2: '#5cb883', // green
      git3: '#d9a441', // amber
      git4: '#4fb3cc', // cyan
      git5: '#dd7f8e', // red
      git6: '#8899c4', // slate
      git7: '#4fbfae', // teal
      gitBranchLabel0: '#000000',
      gitBranchLabel1: '#000000',
      gitBranchLabel2: '#000000',
      gitBranchLabel3: '#000000',
      gitBranchLabel4: '#000000',
      gitBranchLabel5: '#000000',
      gitBranchLabel6: '#000000',
      gitBranchLabel7: '#000000',
      // ── quadrantChart ─────────────────────────────────────────────────────
      // The four quadrant fills derive by nudging primaryColor by +5/+10/+15 on
      // each RGB channel — imperceptible, and on this theme all four land
      // near-white on a near-white canvas, so the quadrant boundaries read as
      // nothing. Spread them into four light tints of the app palette (blue plus
      // neighbours) that stay far enough apart to be seen while keeping black
      // labels well past 4.5. The point fill is pinned too: it derives from
      // quadrant1Fill, so moving that would have moved the dots with it.
      quadrant1Fill: '#d3e2f7', // blue
      quadrant2Fill: '#dcd7f2', // purple
      quadrant3Fill: '#d5eadd', // green
      quadrant4Fill: '#f5e6cc', // amber
      quadrant1TextFill: '#000000',
      quadrant2TextFill: '#000000',
      quadrant3TextFill: '#000000',
      quadrant4TextFill: '#000000',
      quadrantPointFill: '#3a6fd8',
      quadrantPointTextFill: '#000000',
      quadrantXAxisTextFill: '#000000',
      quadrantYAxisTextFill: '#000000',
      quadrantInternalBorderStrokeFill: '#6b7080',
      quadrantExternalBorderStrokeFill: '#3a6fd8',
      quadrantTitleFill: '#000000',
      // ── xychart ───────────────────────────────────────────────────────────
      // See the dark theme's note. The 'default' base's palette begins #ECECFF —
      // near-white bars on a #f0f0f0 canvas, the blind spot that prompted this.
      // Series reuse the git0..7 hues (mid-tone, so they read against the light
      // canvas); ticks and axis lines are the app's muted border colour.
      xyChart: {
        backgroundColor: 'transparent',
        titleColor: '#000000',
        dataLabelColor: '#000000',
        xAxisTitleColor: '#000000',
        xAxisLabelColor: '#000000',
        xAxisTickColor: '#6b7080',
        xAxisLineColor: '#6b7080',
        yAxisTitleColor: '#000000',
        yAxisLabelColor: '#000000',
        yAxisTickColor: '#6b7080',
        yAxisLineColor: '#6b7080',
        plotColorPalette: '#6f9be0,#9b83d6,#5cb883,#d9a441,#4fb3cc,#dd7f8e,#8899c4,#4fbfae'
      }
    }
  },

  // Monokai — warm tones matching the iconic Monokai palette on #272822 bg
  // Signature colors: Pink #f92672, Green #a6e22e, Yellow #e6db74,
  //                   Cyan #66d9ef, Purple #ae81ff, Orange #fd971f
  monokai: {
    base: 'dark',
    variables: {
      background: 'transparent',
      // Nodes — tinted cyan bg so they clearly stand out from the dark canvas
      primaryColor: '#1a3a42', // dark cyan-tinted fill
      primaryTextColor: '#f8f8f2',
      primaryBorderColor: '#66d9ef', // cyan border
      // Edges — orange (Monokai keyword-like) for good contrast
      lineColor: '#fd971f',
      // Secondary/tertiary — purple and green tinted fills for variety
      secondaryColor: '#2a2540', // purple tint
      tertiaryColor: '#1a3020', // green tint
      textColor: '#f8f8f2',
      mainBkg: '#1a3a42',
      nodeBorder: '#66d9ef',
      clusterBkg: '#1e1f1a',
      clusterBorder: '#75715e',
      titleColor: '#e6db74', // yellow titles
      edgeLabelBackground: '#272822',
      nodeTextColor: '#f8f8f2',
      // Sequence diagram actors — cyan theme
      actorTextColor: '#f8f8f2',
      actorBkg: '#1a3a42',
      actorBorder: '#66d9ef',
      actorLineColor: '#75715e',
      signalColor: '#f8f8f2',
      signalTextColor: '#f8f8f2',
      // Autonumber digits — hardcoded 'black' in the dark base, drawn onto the
      // canvas (measured 1.41).
      sequenceNumberColor: '#f8f8f2',
      // Notes — yellow tint (Monokai string color)
      noteBkgColor: '#3a3520',
      noteBorderColor: '#e6db74',
      noteTextColor: '#f8f8f2',
      // Labels
      labelBoxBkgColor: '#1a3a42',
      labelBoxBorderColor: '#66d9ef',
      labelTextColor: '#f8f8f2',
      loopTextColor: '#a6a69c',
      // Sections — alternating tinted shades
      sectionBkgColor: '#1a3a42',
      altSectionBkgColor: '#272822',
      sectionBkgColor2: '#1e1f1a',
      // Tasks — cyan fill, green for done, pink for crit
      taskBkgColor: '#1a3a42',
      taskTextColor: '#f8f8f2',
      taskBorderColor: '#66d9ef',
      activeTaskBkgColor: '#2a4a20', // green tint
      activeTaskBorderColor: '#a6e22e',
      doneTaskBkgColor: '#1a3020',
      doneTaskBorderColor: '#a6e22e',
      critBkgColor: '#3a1525', // pink tint
      critBorderColor: '#f92672',
      // gantt done/active bars: `.doneText*`/`.activeText*` are
      // `taskTextDarkColor !important`, derived as invert(mermaid's light-grey
      // default bar) = #2c2c2c — dark text on our dark bars (measured 1.01).
      taskTextDarkColor: '#f8f8f2',
      taskTextOutsideColor: '#f8f8f2',
      // ER diagrams — override mermaid's white (#ffffff / #f2f2f2) attribute-row
      // fills (the cause of white-text-on-light-box) with dark Monokai tints.
      attributeBackgroundColorEven: '#1a3a42', // cyan tint, matches nodes
      attributeBackgroundColorOdd: '#1e1f1a', // canvas tint
      // ── gitGraph + mindmap root ───────────────────────────────────────────
      // Same derivation trap as the dark theme (branch 0 measured 1.78 with
      // inverted dark text, branch 2 measured 2.50 with the hardcoded lightgrey
      // fallback). Here the pills get the actual Monokai accents — cyan, pink,
      // green, yellow, purple, orange, then two muted repeats — with dark labels.
      git0: '#66d9ef', // cyan
      git1: '#f92672', // pink
      git2: '#a6e22e', // green
      git3: '#e6db74', // yellow
      git4: '#ae81ff', // purple
      git5: '#fd971f', // orange
      git6: '#7fd4c8', // muted cyan/teal
      git7: '#f9a2c0', // muted pink
      gitBranchLabel0: '#000000',
      gitBranchLabel1: '#000000',
      gitBranchLabel2: '#000000',
      gitBranchLabel3: '#000000',
      gitBranchLabel4: '#000000',
      gitBranchLabel5: '#000000',
      gitBranchLabel6: '#000000',
      gitBranchLabel7: '#000000',
      // ── xychart ───────────────────────────────────────────────────────────
      // See the dark theme's note. Series are the Monokai accents, matching
      // git0..7, so a bar chart looks like the rest of the theme instead of
      // mermaid's generic flat-UI palette.
      xyChart: {
        backgroundColor: 'transparent',
        titleColor: '#e6db74',
        dataLabelColor: '#f8f8f2',
        xAxisTitleColor: '#f8f8f2',
        xAxisLabelColor: '#f8f8f2',
        xAxisTickColor: '#75715e',
        xAxisLineColor: '#75715e',
        yAxisTitleColor: '#f8f8f2',
        yAxisLabelColor: '#f8f8f2',
        yAxisTickColor: '#75715e',
        yAxisLineColor: '#75715e',
        plotColorPalette: '#66d9ef,#f92672,#a6e22e,#e6db74,#ae81ff,#fd971f,#7fd4c8,#f9a2c0'
      }
    }
  }
}

/**
 * Resolve the mermaid theme config based on the user's setting and app theme.
 * 'auto' picks the config matching the current app theme.
 * Explicit mermaid themes (dark/default/neutral/forest) use that base with no custom overrides.
 */
export function resolveThemeConfig(
  setting: MermaidTheme | 'auto',
  appTheme: ThemeId
): MermaidThemeConfig {
  if (setting === 'auto') return THEME_CONFIGS[appTheme]
  // Explicit override — use the selected mermaid theme with no custom variables
  return { base: setting, variables: { background: 'transparent' } }
}

/**
 * The one and only `mermaid.initialize` payload.
 *
 * Both the renderer and `scripts/audit-mermaid-contrast.mjs` call this; if the
 * two ever diverge, the audit measures a diagram the app never renders.
 */
export function buildMermaidInitConfig(themeConfig: MermaidThemeConfig): MermaidConfig {
  return {
    startOnLoad: false,
    // 'antiscript' (not 'strict') so HTML labels render: <br/> line breaks,
    // <b>/<i>/<span style> inline styling. It still strips <script> tags and
    // click handlers; the renderer's DOMPurify pass is the second line of defence.
    securityLevel: 'antiscript',
    theme: themeConfig.base,
    // Render labels as HTML (foreignObject) instead of flat SVG <text>, so
    // <br/> and inline markup in node/edge labels are honoured.
    htmlLabels: true,
    // LLM-generated diagrams can be large; lift the default caps (50000 chars
    // / 500 edges) so big diagrams render instead of failing silently.
    maxTextSize: 90000,
    maxEdges: 2000,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    themeVariables: themeConfig.variables
  }
}
