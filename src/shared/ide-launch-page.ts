/**
 * The ONE "Launching VS Code…" page, shared by every surface that shows one
 * (ADR-064 polish follow-up): the tab the TopBar pre-opens while the mint
 * round-trips, the proxy's own "child not up yet" answer, and the substituted
 * download interstitial. One builder, so the three cannot drift apart in copy,
 * palette, or shape — a centred spinner with the label below it, in the
 * client's colour scheme.
 *
 * Lives in `src/shared` because both PROCESSES render it: the renderer writes
 * it into a `document`, the server sends it over HTTP — and neither may import
 * from the other's layer.
 *
 * Self-contained by construction: inline CSS, no assets, no fonts. The tab
 * variant (`mode: 'static'`) carries no script at all; the server variant
 * (`mode: 'poll'`) carries a tiny poller that re-fetches its own URL and
 * reloads the moment the answer stops being 503 — which keeps the spinner
 * SPINNING instead of restarting it with a visible flash every two seconds the
 * way a bare meta refresh does. The meta refresh survives inside `<noscript>`
 * as the no-JS fallback, so the page still makes progress everywhere.
 *
 * The literal strings `background:#1e1e1e` / `background:#ffffff` are asserted
 * by tests on the OUTPUT (not on this module), so they double as the contract
 * that a dark client never sees a white flash.
 */

export type IdeLaunchPageMode =
  /** The pre-opened tab: navigated by the caller, so no refresh machinery. */
  | 'static'
  /** A server answer: poll self and reload when the workbench is ready. */
  | 'poll'

const PALETTE = {
  dark: { background: '#1e1e1e', text: '#cccccc', track: 'rgba(255,255,255,0.16)' },
  light: { background: '#ffffff', text: '#333333', track: 'rgba(0,0,0,0.12)' }
} as const

/** VS Code's own product blue — legible on both grounds, and on-brand for what is loading. */
const ACCENT = '#0078d4'

export function ideLaunchPageHtml(
  themeKind: 'dark' | 'light' | null,
  mode: IdeLaunchPageMode
): string {
  // `null` (an un-themed session, an older client) stays dark — the majority
  // scheme, and the pre-polish behaviour of the server pages.
  const palette = themeKind === 'light' ? PALETTE.light : PALETTE.dark
  const poll =
    mode === 'poll'
      ? '<noscript><meta http-equiv="refresh" content="2"></noscript>' +
        '<script>(async function p(){try{var r=await fetch(location.href,{cache:"no-store"});' +
        'if(r.status!==503){location.reload();return}}catch(e){}setTimeout(p,1500)})()</script>'
      : ''
  return (
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Launching VS Code…</title>' +
    '<style>' +
    `html,body{height:100%;margin:0}` +
    `body{display:flex;align-items:center;justify-content:center;` +
    `font:13px/1.4 system-ui,sans-serif;background:${palette.background};color:${palette.text}}` +
    `.w{display:flex;flex-direction:column;align-items:center;gap:14px}` +
    `.s{width:28px;height:28px;border-radius:50%;border:3px solid ${palette.track};` +
    `border-top-color:${ACCENT};animation:r .8s linear infinite}` +
    '@keyframes r{to{transform:rotate(360deg)}}' +
    '</style>' +
    '<body><div class="w"><div class="s"></div><div>Launching VS Code…</div></div>' +
    poll +
    '</body>'
  )
}
