// The device profiles every mobile layout check measures against. ONE copy: the
// vitest `browser` project (vitest.config.ts) and `scripts/app-shot.mjs
// --profile` both import it, so the numbers the tests assert at and the numbers
// the real app is emulated at can never drift apart.
//
// `s25-ultra-edge` is the owner's phone: Samsung S25 Ultra, Edge on Android. The
// size is the VISIBLE viewport (browser chrome already subtracted), in CSS px.
// `fontScales` are the `uiFontScale` values a layout must hold at: 1 (default),
// 1.1 (the owner's setting) and 1.5 (the setting's maximum). SessionView renders
// the whole app under CSS `zoom: uiFontScale`, which is why the scale matters to
// geometry at all.

export const MOBILE_PROFILES = {
  's25-ultra-edge': {
    width: 412,
    height: 728,
    deviceScaleFactor: 2.625,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0',
    fontScales: [1, 1.1, 1.5]
  }
}
