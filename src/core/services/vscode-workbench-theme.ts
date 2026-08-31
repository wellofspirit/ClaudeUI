/**
 * Making the proxied workbench open in the REMOTE CLIENT's colour scheme
 * (ADR-064 polish).
 *
 * ## Why this is a proxy-side HTML rewrite and not anything nicer
 *
 * `serve-web` serves a profile that lives on the HOST, so its theme is whatever
 * the host's VS Code profile last stored — for a fresh profile that is the
 * upstream default, which is not necessarily the scheme the operator's ClaudeUI
 * client is running. Nothing in the entry URL reaches the workbench's theme
 * service (`?folder=` is the only query the workbench reads), and we cannot
 * write the host's profile — it is the user's own VS Code configuration, shared
 * with any manual `serve-web` use.
 *
 * The one seam left is the workbench root HTML, which our proxy already serves:
 * `vs/code/browser/workbench` reads its whole
 * {@link https://github.com/microsoft/vscode `IWorkbenchConstructionOptions`}
 * out of the `vscode-workbench-web-configuration` meta tag's `data-settings`
 * attribute, and that options object has both fields we need. So the transform
 * is here, on exactly ONE response per workbench load.
 *
 * ## Why BOTH fields
 *
 * `initialColorTheme` is what the theme service uses before any theme data has
 * been persisted for the profile (it is what paints the very first frame), while
 * `configurationDefaults['workbench.colorTheme']` is the DEFAULT VALUE of the
 * setting the theme service resolves afterwards. Setting only the first gives a
 * correct first paint that flips back a moment later; setting only the second
 * leaves the first paint upstream's colour. Both were verified together against
 * a real `serve-web` workbench in both directions.
 *
 * ## The semantics we deliberately keep
 *
 * `configurationDefaults` is a DEFAULT: an operator who picks a theme inside the
 * workbench writes a real user setting, which outranks it on every later load.
 * That is the intended behaviour — match the client when the operator has said
 * nothing, never fight an explicit choice.
 *
 * ## Fail OPEN, always
 *
 * Every function here answers `null` rather than throwing, and the proxy streams
 * the upstream bytes through untouched on `null`. A themed IDE is polish; an IDE
 * that will not load because upstream changed its markup is a regression.
 */

import type { IdeThemeKind } from '../../shared/remote-protocol'

/**
 * The workbench-configuration meta tag, whose `data-settings` attribute is
 * HTML-entity-encoded JSON (verified live against VS Code 1.135.0).
 *
 * Anchored on the `id`, which is the workbench's own lookup key — it reads the
 * tag by `document.getElementById('vscode-workbench-web-configuration')`, so
 * that id is exactly as stable as the mechanism itself. The attribute value is
 * matched as "everything up to the next quote", which is safe precisely BECAUSE
 * the value is entity-encoded: a `"` inside the JSON is `&quot;` and can never
 * terminate the match early.
 */
const WORKBENCH_CONFIG_META =
  /(<meta\s+id="vscode-workbench-web-configuration"\s+data-settings=")([^"]*)(")/

/** The five named entities VS Code's own attribute encoder produces. */
const ENTITY_TO_CHAR: Record<string, string> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  '#39': "'"
}

const CHAR_TO_ENTITY: Record<string, string> = {
  '"': '&quot;',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;'
}

/**
 * Decode in ONE pass, deliberately.
 *
 * Sequential `replace` calls would decode `&amp;quot;` — a literal `&quot;` in
 * the JSON's own data — twice and hand back a quote that was never there. A
 * single alternation consumes each entity exactly once, so the round trip is
 * lossless for any payload.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(quot|amp|lt|gt|#39);/g, (whole, name: string) =>
    name in ENTITY_TO_CHAR ? ENTITY_TO_CHAR[name] : whole
  )
}

/** The inverse, also one pass (which is what keeps `&` from being re-encoded). */
export function encodeHtmlEntities(text: string): string {
  return text.replace(/["&<>']/g, (ch) => CHAR_TO_ENTITY[ch])
}

/**
 * Normalize a client-supplied `themeKind` (ADR-064 polish).
 *
 * COSMETIC, so it never throws and never refuses a mint: an unknown value is
 * simply "the client did not say", and an unthemed workbench is the pre-polish
 * behaviour rather than a failure. The client half of the mapping (ClaudeUI's
 * `monokai` is a dark scheme) lives in the renderer; the wire carries only the
 * two values a VS Code colour scheme actually has.
 */
export function normalizeIdeThemeKind(value: unknown): IdeThemeKind | undefined {
  return value === 'dark' || value === 'light' ? value : undefined
}

/**
 * Inline `<body>` style for the interstitial pages WE serve around the
 * workbench (the "Starting VS Code" page, and the substituted download
 * interstitial), matching the client's scheme so the whole opening sequence
 * reads as one surface. The colours are the workbench's own editor background
 * pair. `null` (an un-themed session, an older client) stays dark — the
 * pre-polish behaviour, and the majority scheme.
 */
export function ideInterstitialStyle(themeKind: IdeThemeKind | null): string {
  return themeKind === 'light'
    ? 'background:#ffffff;color:#333333'
    : 'background:#1e1e1e;color:#cccccc'
}

/**
 * Rewrite the workbench root HTML so it opens in `themeKind`, or answer `null`
 * when this is not markup we recognize.
 *
 * `null` is the fail-open signal and covers every surprise: no meta tag, an
 * attribute that is not JSON, JSON that is not an object. The caller streams the
 * original bytes on `null`.
 */
export function injectWorkbenchTheme(html: string, themeKind: IdeThemeKind): string | null {
  try {
    const match = WORKBENCH_CONFIG_META.exec(html)
    if (!match) return null
    const parsed: unknown = JSON.parse(decodeHtmlEntities(match[2]))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const config = parsed as Record<string, unknown>
    const existingDefaults = config.configurationDefaults
    config.configurationDefaults = {
      // Spread FIRST so a default upstream already ships survives, and ours is
      // the only key this rewrite is allowed to decide.
      ...(existingDefaults !== null && typeof existingDefaults === 'object'
        ? (existingDefaults as Record<string, unknown>)
        : {}),
      'workbench.colorTheme':
        themeKind === 'light' ? 'Default Light Modern' : 'Default Dark Modern'
    }
    config.initialColorTheme = { themeType: themeKind }
    const encoded = encodeHtmlEntities(JSON.stringify(config))
    return (
      html.slice(0, match.index) +
      match[1] +
      encoded +
      match[3] +
      html.slice(match.index + match[0].length)
    )
  } catch {
    // Includes the JSON.parse throw. Nothing here is worth failing a page load
    // over — see the module note on failing open.
    return null
  }
}
