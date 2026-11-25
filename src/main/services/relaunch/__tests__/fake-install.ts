/**
 * Fake ClaudeUI installs for the relaunch tests: a marker-bearing `.app`
 * layout under a temp root whose "executable" is a copy of `/bin/bash`, so a
 * running fake shows up as a process whose executable is under the install
 * (what the helper looks for). Its launch runs `fake.sh`, which records the
 * launch and, when healthy, writes a health record after a short delay.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { INSTALL_MARKER_PRODUCT } from '../../../../shared/install-marker'

export type FakeMode = 'healthy' | 'silent'

const FAKE_SH = `#!/bin/bash
app=$1
v=$(cat "$app/Contents/Resources/version.txt")
mode=$(cat "$app/Contents/Resources/mode.txt")
echo "$v $$" >> "$FAKE_LAUNCHES"
if [ "$mode" = healthy ]; then
  sleep 1.2
  mkdir -p "$FAKE_STATE/health"
  f="$FAKE_STATE/health/$FAKE_KEY.json"
  printf '{"version":"%s","buildId":"b","pid":%s,"at":%s}' "$v" "$$" "$(( $(date +%s) * 1000 ))" > "$f.tmp"
  mv -f "$f.tmp" "$f"
fi
sleep 20
true
`

export function makeFakeApp(
  dir: string,
  version: string,
  mode: FakeMode,
  /**
   * `markerVersion`: the version the install marker carries (default `version`; null: none).
   * `buildId`: the marker's build id (none by default).
   */
  opts: { marker?: boolean; markerVersion?: string | null; buildId?: string } = {}
): string {
  const res = path.join(dir, 'Contents', 'Resources')
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true })
  fs.mkdirSync(res, { recursive: true })
  fs.copyFileSync('/bin/bash', path.join(dir, 'Contents', 'MacOS', 'ClaudeUI'))
  fs.chmodSync(path.join(dir, 'Contents', 'MacOS', 'ClaudeUI'), 0o755)
  fs.writeFileSync(path.join(res, 'fake.sh'), FAKE_SH)
  fs.writeFileSync(path.join(res, 'version.txt'), version)
  fs.writeFileSync(path.join(res, 'mode.txt'), mode)
  if (opts.marker !== false)
    fs.writeFileSync(
      path.join(res, 'claudeui-install.json'),
      JSON.stringify({
        schema: 1,
        product: INSTALL_MARKER_PRODUCT,
        kind: 'desktop',
        entries: [],
        ...(opts.markerVersion === null ? {} : { version: opts.markerVersion ?? version }),
        ...(opts.buildId ? { buildId: opts.buildId } : {})
      })
    )
  return dir
}

export const fakeLaunch = [
  '{app}/Contents/MacOS/ClaudeUI',
  '{app}/Contents/Resources/fake.sh',
  '{app}'
]

export const versionOf = (dir: string): string =>
  fs.readFileSync(path.join(dir, 'Contents', 'Resources', 'version.txt'), 'utf8')

/** `version pid` lines, in launch order. */
export function launches(file: string): Array<{ version: string; pid: number }> {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [version, pid] = line.split(' ')
      return { version, pid: Number(pid) }
    })
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitFor<T>(
  probe: () => T | null | undefined | false,
  timeoutMs: number,
  what: string
): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
