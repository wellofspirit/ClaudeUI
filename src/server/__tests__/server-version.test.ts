/** @vitest-environment node */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveServerVersion } from '../server-version'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-version-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const writeStamp = (version: string) => {
  fs.mkdirSync(path.join(dir, 'out'))
  fs.writeFileSync(
    path.join(dir, 'out', 'build-info.json'),
    JSON.stringify({
      schema: 1,
      kind: 'release',
      version,
      channel: 'stable',
      git: { describe: null, baseTag: null, ahead: null, commit: null, dirty: null, branch: null },
      builtAt: 'x'
    })
  )
}
const writePkg = (version: string) =>
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }))

describe('resolveServerVersion', () => {
  it('prefers the stamp of a packaged server over package.json', () => {
    writeStamp('4.0.0')
    writePkg('1.0.0')
    expect(resolveServerVersion(dir, true)).toBe('4.0.0')
  })
  it('falls back to package.json (a source run ignores a stale stamp)', () => {
    writeStamp('4.0.0')
    writePkg('1.0.0')
    expect(resolveServerVersion(dir, false)).toBe('1.0.0')
  })
  it('falls back to package.json when packaged without a stamp', () => {
    writePkg('1.0.0')
    expect(resolveServerVersion(dir, true)).toBe('1.0.0')
  })
  it('is unknown with neither', () => {
    expect(resolveServerVersion(dir, true)).toBe('unknown')
  })
})
