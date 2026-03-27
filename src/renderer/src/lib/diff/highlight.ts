import { Highlight, themes, normalizeTokens, Prism } from 'prism-react-renderer'

/** Map file extensions to Prism language identifiers */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', css: 'css', scss: 'scss', html: 'markup', xml: 'markup',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', graphql: 'graphql', swift: 'swift',
  dockerfile: 'docker', makefile: 'makefile',
  vue: 'markup', svelte: 'markup', php: 'php', r: 'r',
  scala: 'scala', lua: 'lua', perl: 'perl', zig: 'zig',
  elixir: 'elixir', erlang: 'erlang', haskell: 'haskell',
}

/** Resolve a file path to a Prism language identifier */
export function getLang(filePath?: string): string {
  if (!filePath) return 'plaintext'
  const name = filePath.split('/').pop()?.toLowerCase() || ''
  // Handle extensionless files like Dockerfile, Makefile
  if (EXT_TO_LANG[name]) return EXT_TO_LANG[name]
  const ext = name.split('.').pop() || ''
  return EXT_TO_LANG[ext] || 'plaintext'
}

/** The shared theme for all code highlighting */
export const codeTheme = themes.oneDark

export { Highlight }

/** Token data for a single syntax token */
export interface SyntaxToken {
  content: string
  color?: string
}

/**
 * Resolve the color for a token type from the oneDark theme.
 * Caches results for performance.
 */
const colorCache = new Map<string, string | undefined>()

function resolveColor(types: string[]): string | undefined {
  const key = types.join('.')
  if (colorCache.has(key)) return colorCache.get(key)

  let color: string | undefined
  for (const entry of codeTheme.styles) {
    for (const type of types) {
      if (entry.types.includes(type)) {
        color = entry.style.color as string | undefined
        break
      }
    }
    if (color) break
  }

  colorCache.set(key, color)
  return color
}

/**
 * Tokenize a block of code into per-line arrays of syntax tokens.
 *
 * Uses Prism directly (no React rendering) for efficiency.
 * Give it the full file content (or a contiguous block of lines) and it
 * returns syntax tokens for every line. Multi-line constructs (template
 * literals, block comments) are highlighted correctly because Prism sees
 * full context.
 */
export function tokenizeLines(
  code: string,
  language: string
): SyntaxToken[][] {
  // Get the Prism grammar for this language
  const grammar = Prism.languages[language]
  if (!grammar) {
    // No grammar available — return plain text tokens
    return code.split('\n').map((line) => [{ content: line }])
  }

  // Tokenize with Prism
  const prismTokens = Prism.tokenize(code, grammar)

  // Normalize into per-line arrays
  const normalized = normalizeTokens(prismTokens)

  // Map to our SyntaxToken format with colors from the theme
  return normalized.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: resolveColor(token.types),
    }))
  )
}
