/**
 * Source-file graph helpers for the repo-wide guard specs (`import-cycles`,
 * `vi-mock-targets`). Plain `fs`/`path`; a regex scan, not a parser: the
 * repo's import style (top-level, one statement per `from`) is regular enough,
 * and the guards' non-vacuity assertions catch a scan that stops finding things.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'

/** The repo root: this file lives at `src/test/helpers/`. */
export const REPO_ROOT = resolve(__dirname, '../../..')

const SOURCE_EXT = /\.(?:ts|tsx|mts|js|mjs|jsx)$/
const TRY_EXT = ['.ts', '.tsx', '.js', '.mjs', '.jsx']
const TRY_INDEX = ['/index.ts', '/index.tsx', '/index.js']

const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['@renderer/', 'src/renderer/src/'],
  ['@test/', 'src/test/']
]

/** Every source file under `src/`, repo-relative with forward slashes, sorted. */
export function listSourceFiles(): string[] {
  const out: string[] = []
  const walk = (dirRel: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, dirRel), { withFileTypes: true })) {
      const rel = `${dirRel}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(rel)
    }
  }
  walk('src')
  return out.sort()
}

export function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

export function isTestFile(rel: string): boolean {
  return (
    rel.includes('/__tests__/') ||
    /\.(?:test|spec)\.[^/]+$/.test(rel) ||
    rel.startsWith('src/test/') ||
    rel.startsWith('src/e2e/') ||
    rel.startsWith('src/integration/')
  )
}

function isFile(rel: string): boolean {
  const abs = join(REPO_ROOT, rel)
  return existsSync(abs) && statSync(abs).isFile()
}

/**
 * The repo-relative file a relative or aliased specifier names, or null when it
 * names none (or is a bare package).
 */
export function resolveSpecifier(fromRel: string, specifier: string): string | null {
  const spec = specifier.replace(/\?.*$/, '')
  let base: string
  const alias = ALIASES.find(([prefix]) => spec.startsWith(prefix))
  if (alias) base = alias[1] + spec.slice(alias[0].length)
  else if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    base = posix.normalize(posix.join(dirname(fromRel), spec))
  } else return null
  base = base.replace(/\/$/, '')

  const candidates = [base, ...TRY_EXT.map((e) => base + e), ...TRY_INDEX.map((i) => base + i)]
  // `./x.js` may name `x.ts` (ESM-style specifiers).
  if (/\.(?:js|mjs|jsx)$/.test(base)) {
    const stem = base.replace(/\.(?:js|mjs|jsx)$/, '')
    candidates.push(stem + '.ts', stem + '.tsx')
  }
  return candidates.find(isFile) ?? null
}

// `import|export <clause> from '<spec>'`, anchored at column 0. The clause is
// one of the shapes the grammar allows, so a preceding `export type X = …`
// (this repo writes no semicolons) cannot be swallowed into it.
const CLAUSE = String.raw`(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+)|[\w$]+|\*`
const FROM_RE = new RegExp(
  String.raw`^(?:import|export)\s+(type\s+)?(${CLAUSE})\s*from\s*['"]([^'"\n]+)['"]`,
  'gm'
)
const SIDE_EFFECT_RE = /^import\s*['"]([^'"\n]+)['"]/gm

/** True for `{ type A, type B }` (and `X, { type A }` is NOT all-type: X is a value). */
function allNamedAreTypes(clause: string): boolean {
  const m = /^\{([^}]*)\}$/.exec(clause.trim())
  if (!m) return false
  const specs = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return specs.length > 0 && specs.every((s) => /^type\s+\S/.test(s))
}

/**
 * Specifiers of top-level static value imports and re-exports, plus side-effect
 * imports. Type-only forms and dynamic `import()` are excluded.
 */
export function staticValueImports(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(FROM_RE)) {
    if (m[1]) continue
    if (allNamedAreTypes(m[2])) continue
    out.push(m[3])
  }
  for (const m of text.matchAll(SIDE_EFFECT_RE)) out.push(m[1])
  return out
}
