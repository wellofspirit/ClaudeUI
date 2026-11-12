/**
 * @vitest-environment node
 *
 * Every `vi.mock('<path>')` / `vi.doMock('<path>')` in a test file whose path is
 * relative or aliased must name a file that exists. A mock of a moved or deleted
 * module replaces nothing: it stays green while the spec quietly exercises the
 * real module (GitHub issue #220). Bare packages (`electron`, `node:fs`) are not
 * checked. `vi.mock(import('./x'), …)` is checked by tsc, so only string
 * literals are scanned here.
 */

import { describe, it, expect } from 'vitest'
import {
  isTestFile,
  listSourceFiles,
  readSource,
  resolveSpecifier
} from '../../test/helpers/source-graph'

const MOCK_CALL = /\bvi\.(?:mock|doMock)\(\s*(['"])([^'"\n]+)\1/g
const isPathLike = (s: string): boolean =>
  s.startsWith('.') || s.startsWith('@renderer/') || s.startsWith('@test/')

describe('vi.mock targets', () => {
  const dead: string[] = []
  let scanned = 0
  for (const rel of listSourceFiles().filter(isTestFile)) {
    const text = readSource(rel)
    for (const m of text.matchAll(MOCK_CALL)) {
      if (!isPathLike(m[2])) continue
      scanned++
      if (resolveSpecifier(rel, m[2])) continue
      const line = text.slice(0, m.index).split('\n').length
      dead.push(`${rel}:${line} ${m[2]}`)
    }
  }

  it('scans a real set of mocks (non-vacuity)', () => {
    expect(scanned).toBeGreaterThan(1000)
  })

  it('every mocked relative or aliased path resolves to a file', () => {
    if (dead.length) {
      throw new Error(
        `\n${dead.length} vi.mock target(s) resolve to no file; repoint the mock at the module that exists or delete it:\n` +
          dead.map((d) => `  ${d}`).join('\n')
      )
    }
  })
})
