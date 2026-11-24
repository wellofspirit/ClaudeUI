/** @vitest-environment node */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBuildInfo } from '../build-info'

const stamp = {
  schema: 1,
  kind: 'local',
  version: '3.9.1',
  git: { describe: null, baseTag: null, ahead: null, commit: null, dirty: null, branch: null },
  builtAt: '2026-11-24T10:00:00.000Z'
}
let dir: string
const write = (text: string) => {
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'out', 'build-info.json'), text)
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('readBuildInfo', () => {
  it('reads the stamp of a packaged build', () => {
    write(JSON.stringify(stamp))
    expect(readBuildInfo(dir, true)).toMatchObject({ kind: 'local', version: '3.9.1' })
  })
  it('is dev when unpackaged, even with a stale file present', () => {
    write(JSON.stringify(stamp))
    expect(readBuildInfo(dir, false)).toEqual({ kind: 'dev' })
  })
  it('is dev when packaged without a file', () => {
    expect(readBuildInfo(dir, true)).toEqual({ kind: 'dev' })
  })
  it('is dev for corrupt JSON and for an invalid shape', () => {
    write('{nope')
    expect(readBuildInfo(dir, true)).toEqual({ kind: 'dev' })
    write(JSON.stringify({ ...stamp, schema: 9 }))
    expect(readBuildInfo(dir, true)).toEqual({ kind: 'dev' })
  })
})
