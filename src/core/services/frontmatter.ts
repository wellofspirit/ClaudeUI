// ---------------------------------------------------------------------------
// YAML frontmatter parser (lightweight, no dependency)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

/**
 * A value that is *only* a block-scalar indicator: `|`, `|-`, `|+`, `>`, `>-`, `>+`.
 * Anchored on both ends so a value that merely contains a pipe
 * (`description: use a | pipe`) is still treated as a plain scalar.
 */
const BLOCK_SCALAR_RE = /^([|>])[-+]?$/

export interface Frontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

/**
 * Consume a YAML block scalar's content lines, starting at the line AFTER
 * `headerIndex`. Returns the joined value and the index of the last consumed
 * line so the caller's loop resumes on the next key.
 *
 * Deliberately partial (this is a frontmatter reader, not a YAML engine):
 * indentation is stripped relative to the first content line, and chomping
 * indicators (`-` / `+`) are not modelled separately because the caller
 * `.trim()`s every value anyway — the only difference between `|` and `|-`
 * here would be trailing newlines, which the trim removes.
 */
function consumeBlockScalar(
  lines: string[],
  headerIndex: number,
  folded: boolean
): { value: string; lastIndex: number } {
  const content: string[] = []
  let indent: number | null = null
  let i = headerIndex

  while (i + 1 < lines.length) {
    const next = lines[i + 1]
    if (next.trim() === '') {
      // Blank lines belong to the block until a less-indented key ends it.
      content.push('')
      i++
      continue
    }
    const lead = next.length - next.replace(/^[ \t]+/, '').length
    if (lead === 0) break // back at frontmatter key level — block is over
    if (indent === null) indent = lead
    content.push(next.slice(Math.min(lead, indent)))
    i++
  }

  while (content.length > 0 && content[content.length - 1] === '') content.pop()

  // Folded (`>`) joins with spaces; literal (`|`) keeps the line breaks.
  const value = folded ? content.filter((l) => l !== '').join(' ') : content.join('\n')
  return { value, lastIndex: i }
}

/** Lightweight `---` frontmatter reader (line scanner, no YAML engine). */
export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { frontmatter: {}, body: raw }

  const yamlBlock = m[1]
  const body = m[2]
  const fm: Frontmatter = {}

  // Simple key: value extraction (handles multi-line values via indentation)
  const lines = yamlBlock.split(/\r?\n/)
  let currentKey: string | null = null
  let currentValue = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      if (currentKey) fm[currentKey] = currentValue.trim()
      currentKey = kvMatch[1]
      const scalarHeader = kvMatch[2].trim().match(BLOCK_SCALAR_RE)
      if (scalarHeader) {
        // YAML block scalar (`description: |`, `|-`, `>`, `>-`, …): the value is
        // the following more-indented lines, NOT the indicator. Without this the
        // indicator leaked into the value verbatim ("|\nFirst line…").
        // `i` is advanced past the consumed lines so key parsing resumes after.
        const consumed = consumeBlockScalar(lines, i, scalarHeader[1] === '>')
        currentValue = consumed.value
        i = consumed.lastIndex
      } else {
        currentValue = kvMatch[2]
      }
    } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
      currentValue += '\n' + line.trim()
    }
  }
  if (currentKey) fm[currentKey] = currentValue.trim()

  return { frontmatter: fm, body }
}
