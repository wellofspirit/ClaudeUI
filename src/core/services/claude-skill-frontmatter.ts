/**
 * The frontmatter reader for skills and legacy commands, as cli.js 2.1.317 reads it
 * (`docs/architecture/skill-catalog.md`): BOM stripped, the block is `---`..`---` at the very
 * start, YAML inside; on a YAML error one retry after quoting simple `key: value` lines whose
 * value holds YAML-significant characters; if that fails too the frontmatter is `{}` and the
 * body still loads. Never throws.
 */

import { parse as parseYaml } from 'yaml'

export interface ParsedMarkdown {
  data: Record<string, unknown>
  body: string
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/
const SPECIAL = /[{}[\]*&#!|>%@`]|: /

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = parseYaml(text)
    if (v === null || v === undefined) return {}
    return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** cli.js's retry: quote simple `key: value` lines whose value would trip YAML; tabs -> two spaces. */
function quoteSimpleValues(yaml: string): string {
  return yaml
    .split('\n')
    .map((line) => {
      const tabless = line.replace(/^\t+/, (t) => '  '.repeat(t.length))
      const m = /^([a-zA-Z_-]+):[ \t]+(.+?)[ \t]*$/.exec(tabless)
      if (!m) return tabless
      const [, key, value] = m
      if (!SPECIAL.test(value)) return tabless
      if (/^(".*"|'.*')$/.test(value)) return tabless
      return `${key}: "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    })
    .join('\n')
}

export function parseMarkdownFrontmatter(raw: string): ParsedMarkdown {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const m = FRONTMATTER.exec(text)
  if (!m) return { data: {}, body: text }
  const body = text.slice(m[0].length)
  const data = parseObject(m[1]) ?? parseObject(quoteSimpleValues(m[1])) ?? {}
  return { data, body }
}
