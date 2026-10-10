/**
 * ADR-085 §3 — the over-approximating opencode globs for Bash deny/ask rules.
 * Oracle: the host port of opencode's own matcher (`../wildcard.ts`
 * `wildcardMatch`, ported from `vendor/opencode-src/packages/core/src/util/wildcard.ts`),
 * on both platforms (it folds case on win32 only). Synthetic rules only.
 */
import { describe, it, expect } from 'vitest'
import { broadBashGlobs } from '../broad-bash-globs'
import { wildcardMatch } from '../wildcard'

const PLATFORMS = ['linux', 'win32'] as const
const ANCHORS = ['', '* ', '*/', '*"', "*'"]

function hits(specifier: string, text: string, platform: NodeJS.Platform): boolean {
  return broadBashGlobs(specifier).some((glob) => wildcardMatch(text, glob, platform))
}

const TABLE: Array<[rule: string, matches: string[], misses: string[]]> = [
  [
    'git push --force:*',
    [
      'git push origin main --force',
      'git -C . push --force-with-lease',
      'sudo git push --force',
      '/usr/bin/git push -f origin main',
      'sh -c "git push --force"',
      'git push origin +main',
      'git push --force'
    ],
    ['git push origin main', 'git status', 'gitx push --force']
  ],
  [
    'rm -rf:*',
    ['rm -rf x', 'rm -fr x', 'rm -r -f x', 'rm -f -r x', 'sudo rm -rf /'],
    ['rm -r x', 'rm -f x']
  ],
  ['rm:*', ['rm', 'rm -rf x', 'xargs rm x'], ['rmdir x']],
  [
    'docker run:*',
    ['docker run alpine', 'docker run', 'docker --context x run alpine'],
    ['docker build -t runtime .', 'docker ps']
  ]
]

describe('broadBashGlobs — against opencode’s own matcher', () => {
  for (const [rule, matches, misses] of TABLE) {
    for (const platform of PLATFORMS) {
      it.each(matches)(`${rule} matches %s (${platform})`, (text) => {
        expect(hits(rule, text, platform)).toBe(true)
      })
      it.each(misses)(`${rule} does not match %s (${platform})`, (text) => {
        expect(hits(rule, text, platform)).toBe(false)
      })
    }
  }

  it('the F1 command is missed by the verbatim pattern and caught by the broad globs', () => {
    expect(wildcardMatch('git push origin main --force', 'git push --force*', 'linux')).toBe(false)
    expect(hits('git push --force:*', 'git push origin main --force', 'linux')).toBe(true)
  })
})

describe('broadBashGlobs — shape and bounds', () => {
  it('a glob-word rule is not broadened', () => {
    expect(broadBashGlobs('rm -rf /*')).toEqual([])
    expect(broadBashGlobs('ls *.log:*')).toEqual([])
  })

  it('a wildcard program, or no program at all, is not broadened', () => {
    expect(broadBashGlobs('*git push:*')).toEqual([])
    expect(broadBashGlobs(':*')).toEqual([])
  })

  it('a rule with no words is the optional-tail form under every anchor', () => {
    expect(broadBashGlobs('rm:*')).toEqual(ANCHORS.map((a) => `${a}rm *`))
  })

  it('every glob starts with one of the five anchors followed by the program', () => {
    for (const rule of ['git push --force:*', 'rm -rf:*', 'docker run:*', 'git branch -D:*']) {
      const program = rule.split(' ')[0]
      const globs = broadBashGlobs(rule)
      expect(globs.length).toBeGreaterThan(0)
      for (const glob of globs) {
        expect(
          ANCHORS.some((a) => glob.startsWith(`${a}${program} `)),
          glob
        ).toBe(true)
      }
    }
  })

  it('stays bounded: a three-letter cluster is ≤ 24 alternatives × 5 anchors (× 2 bodies)', () => {
    const globs = broadBashGlobs('rm -rfv:*')
    // 3! permutations + 3! split orders = 12 alternatives.
    expect(globs.length).toBeLessThanOrEqual(24 * 5)
    expect(globs.length).toBe(12 * 2 * 5)
    expect(hits('rm -rfv:*', 'rm -v -f -r x', 'linux')).toBe(true)
  })

  it('caps a rule whose word combinations exceed 24 — two clusters keep their own spellings only', () => {
    // 12 × 12 alternatives > 24 → each word itself only.
    const globs = broadBashGlobs('tar -xzf -cvf:*')
    expect(globs.length).toBe(1 * 2 * 5)
    expect(hits('tar -xzf -cvf:*', 'tar -xzf a -cvf b', 'linux')).toBe(true)
  })

  it('is deduplicated', () => {
    for (const rule of ['git push --force:*', 'rm -rf:*', 'rm -f:*']) {
      const globs = broadBashGlobs(rule)
      expect(new Set(globs).size).toBe(globs.length)
    }
  })
})
