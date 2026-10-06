/**
 * @vitest-environment node
 *
 * The version classifier (ADR-082 §3): tested, untested (floor ≤ v < ceiling,
 * older-than-tested included), too old, incompatible (the next major, or not a
 * version at all). The tables run against fixed manifests, so a harness bump
 * does not rewrite them; the last test runs against the real ones.
 */
import { describe, it, expect, vi } from 'vitest'
import { HARNESS_IDS } from '../../../shared/harness-types'
import type { HarnessId, HarnessManifest } from '../../../shared/harness-types'

const { FIXED } = vi.hoisted(() => ({
  FIXED: {
    claude: { tested: '2.1.280', floor: '2.1.275', ceiling: '3.0.0' },
    opencode: { tested: '2.0.24', floor: '2.0.20', ceiling: '3.0.0' },
    pi: { tested: '0.87.1', floor: '0.87.1', ceiling: '1.0.0' },
    codex: { tested: '0.156.0', floor: '0.156.0', ceiling: '1.0.0' }
  } as Record<string, { tested: string; floor: string; ceiling: string }>
}))
let useReal = false

vi.mock('../manifests', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../manifests')>()
  return {
    harnessManifest: (id: HarnessId): HarnessManifest =>
      useReal ? actual.harnessManifest(id) : { id, platforms: {}, ...FIXED[id] }
  }
})

const { harnessManifest } = await import('../manifests')
const { classifyVersion, versionAccepted, versionReason } = await import('../version-gate')

describe('classifyVersion', () => {
  it.each([
    ['2.1.280', 'tested'],
    ['2.1.281', 'untested'],
    ['2.99.0', 'untested'],
    // Older than tested but at or above the floor.
    ['2.1.275', 'untested'],
    ['2.1.279', 'untested'],
    ['2.1.274', 'too-old'],
    ['2.1.211', 'too-old'],
    // A pre-release of the floor sorts below it.
    ['2.1.275-beta.1', 'too-old'],
    ['2.1.280+build.7', 'tested'],
    ['3.0.0', 'incompatible'],
    // A pre-release of the next major is that major, not "just below" it.
    ['3.0.0-beta.1', 'incompatible'],
    ['4.2.0', 'incompatible'],
    ['local', 'incompatible'],
    ['2.1', 'incompatible'],
    ['', 'incompatible'],
    ['v2.1.280', 'incompatible']
  ] as const)('claude %j is %s', (version, expected) => {
    expect(classifyVersion('claude', version)).toBe(expected)
  })

  it.each([
    ['2.0.24', 'tested'],
    ['2.0.20', 'untested'],
    ['2.1.0', 'untested'],
    ['2.0.19', 'too-old'],
    // opencode 1.x (`opencode-ai`) is the previous line: too old, not incompatible.
    ['1.18.34', 'too-old'],
    ['3.0.0', 'incompatible']
  ] as const)('opencode %j is %s', (version, expected) => {
    expect(classifyVersion('opencode', version)).toBe(expected)
  })

  it.each([
    ['0.156.0', 'tested'],
    ['0.159.2', 'untested'],
    ['0.155.9', 'too-old'],
    ['1.0.0', 'incompatible']
  ] as const)('codex %j is %s', (version, expected) => {
    expect(classifyVersion('codex', version)).toBe(expected)
  })

  it('explains a version below the floor, naming the major line when it is a whole one behind', () => {
    expect(versionReason('opencode', '2.0.19', 'too-old')).toBe(
      'opencode 2.0.19 is older than 2.0.20, the oldest ClaudeUI supports'
    )
    expect(versionReason('opencode', '1.18.34', 'too-old')).toBe(
      'opencode 1.18.34 is from the 1.x line; ClaudeUI uses opencode 2.x (2.0.20 or newer)'
    )
  })

  it.each(HARNESS_IDS)('%s (real manifest) accepts tested and floor, refuses the ceiling', (id) => {
    useReal = true
    try {
      const { tested, floor, ceiling } = harnessManifest(id)
      expect(classifyVersion(id, tested)).toBe('tested')
      expect(versionAccepted(id, floor)).toBe(true)
      expect(versionAccepted(id, ceiling)).toBe(false)
    } finally {
      useReal = false
    }
  })
})
