/**
 * Whether a vitest command line names only non-browser spec files, so vitest.config.ts can leave the
 * `browser` project (Playwright provider, React and Tailwind plugins, its own Vite server) out of a
 * focused run. The only wrong answer this may give is `false`: keeping the browser project is slower,
 * never a skipped test. A complete non-browser spec path cannot match a `*.browser.test.*` file as a
 * substring, which is why that case alone is safe; a directory or bare name filter could, so it is `false`.
 */

const SPEC = /\.test\.tsx?(:\d+)?$/
const SUBCOMMANDS = new Set(['run', 'watch', 'dev'])
/** Flags that change which projects or files load: any of them in any form answers `false`. */
const FORBIDDEN = /^(--project|-p|--browser(\..*)?|--dir|--root|-r|--changed|--config|-c)(=|$)/
/** Flags whose next token is their value (vitest 5.0.5 option table). */
const VALUE_FLAGS = new Set([
  '-t',
  '--testNamePattern',
  '--reporter',
  '--shard',
  '--pool',
  '--bail',
  '--retry',
  '--maxWorkers',
  '--testTimeout',
  '--hookTimeout',
  '--environment',
  '--outputFile',
  '--mode'
])
/** Flags known to take no value, so a token after them is a positional. */
const BOOLEAN_FLAGS = new Set(['--run', '-w', '--watch', '--passWithNoTests', '--no-color'])

/** @param {string[]} argv the arguments after the executable and script, i.e. `process.argv.slice(2)` */
export function namesOnlyNonBrowserSpecs(argv) {
  let positionals = 0
  let first = true
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('-')) {
      if (FORBIDDEN.test(token)) return false
      if (token.includes('=') || BOOLEAN_FLAGS.has(token)) continue
      if (VALUE_FLAGS.has(token)) {
        i++
        continue
      }
      // An unknown flag may take an optional value (cac swallows the next non-flag token), so a
      // spec path after it might not be a filter at all.
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-') && !token.startsWith('--no-')) return false
      continue
    }
    if (first && SUBCOMMANDS.has(token)) {
      first = false
      continue
    }
    first = false
    if (!SPEC.test(token) || token.includes('.browser.test.')) return false
    positionals++
  }
  return positionals > 0
}
