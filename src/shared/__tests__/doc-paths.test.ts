/**
 * @vitest-environment node
 *
 * Guard: a repository path written in backticks in the docs agents are routed by must exist.
 *
 * Covered: every `CLAUDE.md` (the root one and the per-directory notes), `docs/architecture/**`,
 * `docs/testing-strategy.md`, `docs/component-guide.md` and `docs/commands.md`. Not covered:
 * `docs/adr/**` and the protocol references, which cite upstream and historical paths on purpose.
 *
 * Two kinds of token are checked:
 *  - A ROOTED path starts with one of CHECKED_ROOTS. A trailing `:line`, `#anchor` or `/` is
 *    ignored. `<placeholder>`, `*` and `{a,b}` make it a pattern: the literal directories before
 *    the first pattern segment must exist, and when the pattern is the last segment at least one
 *    entry must match it.
 *  - In a `CLAUDE.md` only, a bare source-file name or a relative path to one (`judge-setup.ts`,
 *    `rules/policy.ts`) must be a repo-root file or the tail of some file under SOURCE_ROOTS, so a
 *    rename cannot leave a note pointing at a name that no longer exists.
 *
 * Names are compared case-exactly, so a path that only resolves on a case-insensitive filesystem
 * fails here as it would on Linux.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()

/** Roots whose contents are tracked, so a path under them can be checked on any checkout. */
const CHECKED_ROOTS = ['src/', 'scripts/', 'patch/', 'docs/', '.github/', '.claude/skills/']

/** Where a bare source-file name in a note may live, and where `CLAUDE.md` files are looked for. */
const SOURCE_ROOTS = ['src', 'scripts', 'patch', 'docs']

/** A token that names a source file without a root: `PiSession.ts`, `kinds/index.ts`. */
const BARE_SOURCE_FILE = /^[\w@][\w@./-]*\.(?:ts|tsx|mjs|sh)$/

/** Paths a covered doc names although they are absent, each with the reason. */
const KNOWN_ABSENT: Record<string, string> = {}

const entriesCache = new Map<string, string[] | null>()

/** The names in a repo-relative directory, or null when it is not a directory. */
function entries(dir: string): string[] | null {
  let cached = entriesCache.get(dir)
  if (cached === undefined) {
    try {
      cached = readdirSync(join(REPO, dir))
    } catch {
      cached = null
    }
    entriesCache.set(dir, cached)
  }
  return cached
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const name of entries(dir) ?? []) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const rel = `${dir}/${name}`
    if (statSync(join(REPO, rel)).isDirectory()) walk(rel, visit)
    else visit(rel)
  }
}

const sourceFiles: string[] = []
for (const root of SOURCE_ROOTS) walk(root, (file) => sourceFiles.push(file))

const isNote = (doc: string): boolean => doc === 'CLAUDE.md' || doc.endsWith('/CLAUDE.md')

function coveredDocs(): string[] {
  const docs = [
    'CLAUDE.md',
    'docs/testing-strategy.md',
    'docs/component-guide.md',
    'docs/commands.md'
  ]
  for (const file of sourceFiles) {
    if (isNote(file) || (file.startsWith('docs/architecture/') && file.endsWith('.md'))) {
      docs.push(file)
    }
  }
  return [...new Set(docs)]
}

const isPattern = (segment: string): boolean => /[*<{]|\.\.\.|…/.test(segment)

/** `claude-*.ts`, `<engine>.json`, `{a,b}.md` → an anchored RegExp over one path segment. */
function segmentMatcher(segment: string): RegExp {
  const source = segment
    .replace(/<[^>]*>/g, '*')
    .replace(/[.+?^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]*)\}/g, (_m, alternatives: string) => `(?:${alternatives.replace(/,/g, '|')})`)
    .replace(/\*+/g, '[^/]*')
  return new RegExp(`^${source}$`)
}

/** Why the rooted `path` does not resolve, or null when it does. */
function missing(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment !== '')
  let dir = '.'
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const names = entries(dir)
    if (names === null) return `${dir} is not a directory`
    if (isPattern(segment)) {
      // A pattern in the middle of a path is not expanded: the literal prefix existing is enough.
      if (i < segments.length - 1) return null
      return names.some((name) => segmentMatcher(segment).test(name))
        ? null
        : `nothing in ${dir} matches ${segment}`
    }
    if (!names.includes(segment)) return `no ${segment} in ${dir}`
    dir = dir === '.' ? segment : `${dir}/${segment}`
  }
  return null
}

/** Why the bare `name` is neither a repo-root file nor the tail of a source file, or null. */
function missingBare(name: string): string | null {
  if (entries('.')?.includes(name)) return null
  return sourceFiles.some((file) => file === name || file.endsWith(`/${name}`))
    ? null
    : `no file under ${SOURCE_ROOTS.join(', ')} ends in ${name}`
}

interface Token {
  text: string
  rooted: boolean
}

/** The checkable tokens on one line of Markdown. */
function pathTokens(line: string, bareNames: boolean): Token[] {
  const tokens: Token[] = []
  for (const span of line.matchAll(/`([^`]+)`/g)) {
    for (const raw of span[1].split(/\s+/)) {
      const text = raw
        .replace(/^["'(]+/, '')
        .replace(/["'),.;]+$/, '')
        .replace(/#.*$/, '')
        .replace(/:\d+(?:[-,]\d+)*$/, '')
      if (CHECKED_ROOTS.some((root) => text.startsWith(root))) tokens.push({ text, rooted: true })
      else if (bareNames && BARE_SOURCE_FILE.test(text)) tokens.push({ text, rooted: false })
    }
  }
  return tokens
}

describe('backticked repository paths in agent-facing docs', () => {
  const docs = coveredDocs()

  it('covers the root file, the per-directory notes and the architecture pages', () => {
    expect(docs).toContain('CLAUDE.md')
    expect(docs.filter((doc) => doc.startsWith('src/') && isNote(doc))).not.toEqual([])
    expect(docs.filter((doc) => doc.startsWith('docs/architecture/'))).not.toEqual([])
  })

  it('every path exists', () => {
    const dead: string[] = []
    let checked = 0
    for (const doc of docs) {
      let fenced = false
      readFileSync(join(REPO, doc), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.trimStart().startsWith('```')) {
            fenced = !fenced
            return
          }
          if (fenced) return
          for (const token of pathTokens(line, isNote(doc))) {
            checked++
            if (token.text in KNOWN_ABSENT) continue
            const reason = token.rooted ? missing(token.text) : missingBare(token.text)
            if (reason) dead.push(`${doc}:${index + 1}  ${token.text}  (${reason})`)
          }
        })
    }
    expect(checked).toBeGreaterThan(0)
    expect(dead).toEqual([])
  })

  it('has no stale exception', () => {
    expect(Object.keys(KNOWN_ABSENT).filter((path) => missing(path) === null)).toEqual([])
  })
})
