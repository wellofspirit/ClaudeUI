/**
 * @vitest-environment node
 *
 * `getCliVersion()` (ADR-082 Consequences): the resolution's version wins
 * when it has one (a System install carries what `--version` printed at
 * detection); otherwise the `version.json` beside the binary, else `unknown`.
 * It never spawns anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedHarness } from '../../../shared/harness-types'

const resolved = vi.hoisted(() => ({ current: null as ResolvedHarness | null }))
vi.mock('../../harness/resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness/resolve')>()
  return { ...actual, resolveHarness: () => resolved.current }
})
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('getCliVersion must not spawn')
  })
}))

import { getCliVersion } from '../harness'
import { invalidateHarness } from '../../harness/resolve'

let dir: string
let bin: string

function resolution(version: string | null): ResolvedHarness {
  return {
    id: 'claude',
    path: bin,
    launch: { command: bin, args: [] },
    dir,
    source: 'system',
    version
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-version-'))
  bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, '')
  invalidateHarness('claude')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  invalidateHarness('claude')
})

describe('getCliVersion', () => {
  it("prefers the resolution's version over version.json", () => {
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '2.1.280' }))
    resolved.current = resolution('2.1.283')
    expect(getCliVersion()).toBe('2.1.283')
  })

  it('reads version.json when the resolution has no version', () => {
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '2.1.280' }))
    resolved.current = resolution(null)
    expect(getCliVersion()).toBe('2.1.280')
  })

  it('is unknown with neither', () => {
    resolved.current = resolution(null)
    expect(getCliVersion()).toBe('unknown')
  })
})
