/**
 * A fake `scripts/build.mjs build:stage -v` for the rebuild specs: a CommonJS
 * script node runs (write it to a temp file). It prints what build.mjs prints
 * and, by `FAKE_BUILD_MODE`:
 *   ok        writes out/build-info.json in the tree and a marked app
 *             (`FAKE_MARKER`) into CLAUDEUI_BUILD_OUT for `FAKE_PLATFORM`;
 *   unmarked  the same app without a marker;
 *   fail      prints a failed stage and exits 3;
 *   hang      writes its pid to ./pid and waits (stubborn: ignores SIGTERM too).
 * `FAKE_SAY`, when set, is printed as one more output line while packaging.
 */
export const FAKE_BUILD = String.raw`
const fs = require('fs')
const path = require('path')
const out = process.env.CLAUDEUI_BUILD_OUT
const mode = process.env.FAKE_BUILD_MODE
const say = (s) => process.stdout.write(s + '\n')
say('[1/4] typecheck:node ‖ typecheck:web ‖ electron-vite build')
say('  ✓ typecheck:node (0.1s)')
if (mode === 'hang' || mode === 'stubborn') {
  if (mode === 'stubborn') process.on('SIGTERM', () => say('ignoring SIGTERM'))
  say('[2/4] stamp build-info')
  fs.writeFileSync(path.join(process.cwd(), 'pid'), String(process.pid))
  setInterval(() => {}, 1000)
  return
}
if (mode === 'fail') {
  say('[2/4] stamp build-info')
  process.stderr.write('could not write ' + out + '\n')
  say('  ✗ stamp build-info failed (exit 3)')
  process.exit(3)
}
say('[2/4] stamp build-info')
fs.mkdirSync('out', { recursive: true })
fs.writeFileSync(path.join('out', 'build-info.json'), JSON.stringify({
  schema: 1, kind: 'local', version: process.env.FAKE_VERSION, builtAt: '2026-11-25T00:00:00.000Z',
  git: { describe: null, baseTag: null, ahead: null, commit: 'feedface00112233', dirty: false, branch: 'x' }
}))
say('[3/4] electron-builder --dir')
if (process.env.FAKE_SAY) say(process.env.FAKE_SAY)
const darwin = process.env.FAKE_PLATFORM === 'darwin'
const app = darwin ? path.join(out, 'mac-arm64', 'ClaudeUI.app') : path.join(out, 'win-unpacked')
const res = darwin ? path.join(app, 'Contents', 'Resources') : path.join(app, 'resources')
fs.mkdirSync(res, { recursive: true })
if (darwin) {
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'ClaudeUI'), 'exe')
} else fs.writeFileSync(path.join(app, 'ClaudeUI.exe'), 'exe')
if (mode !== 'unmarked') fs.writeFileSync(path.join(res, 'claudeui-install.json'), process.env.FAKE_MARKER)
say('[4/4] stamp install-marker')
say('build:stage ✓ (4 stages, 0.1s)')
`
