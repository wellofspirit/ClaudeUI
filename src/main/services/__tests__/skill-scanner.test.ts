/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Replicate the private parseFrontmatter and extractFirstLine from skill-scanner.ts
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

interface Frontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { frontmatter: {}, body: raw }

  const yamlBlock = m[1]
  const body = m[2]
  const fm: Frontmatter = {}

  let currentKey: string | null = null
  let currentValue = ''

  for (const line of yamlBlock.split(/\r?\n/)) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      if (currentKey) fm[currentKey] = currentValue.trim()
      currentKey = kvMatch[1]
      currentValue = kvMatch[2]
    } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
      currentValue += '\n' + line.trim()
    }
  }
  if (currentKey) fm[currentKey] = currentValue.trim()

  return { frontmatter: fm, body }
}

function extractFirstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) return trimmed.slice(0, 200)
  }
  return ''
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses simple key-value pairs', () => {
    const raw = `---
name: my-skill
description: A test skill
---
Body content here`

    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter.name).toBe('my-skill')
    expect(frontmatter.description).toBe('A test skill')
    expect(body).toBe('Body content here')
  })

  it('handles multi-line values with indentation', () => {
    const raw = `---
name: my-skill
description: First line
  continued on next line
  and another line
---
Body`

    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter.description).toBe('First line\ncontinued on next line\nand another line')
  })

  it('returns empty frontmatter when no delimiters', () => {
    const raw = 'Just some text without frontmatter'
    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter).toEqual({})
    expect(body).toBe(raw)
  })

  it('handles empty frontmatter block', () => {
    const raw = `---

---
Body here`

    const { frontmatter, body } = parseFrontmatter(raw)
    expect(Object.keys(frontmatter)).toHaveLength(0)
    expect(body).toBe('Body here')
  })

  it('handles keys with hyphens', () => {
    const raw = `---
display-name: My Skill
---
Body`

    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter['display-name']).toBe('My Skill')
  })

  it('handles multiple keys', () => {
    const raw = `---
name: test
description: desc
version: 1.0
author: someone
---
Body`

    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter.name).toBe('test')
    expect(frontmatter.description).toBe('desc')
    expect(frontmatter.version).toBe('1.0')
    expect(frontmatter.author).toBe('someone')
  })

  it('handles Windows-style line endings', () => {
    const raw = '---\r\nname: test\r\n---\r\nBody'
    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter.name).toBe('test')
    expect(body).toBe('Body')
  })

  it('handles values with colons', () => {
    const raw = `---
description: Use this: when needed
---
Body`

    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter.description).toBe('Use this: when needed')
  })

  it('handles tab-indented continuation lines', () => {
    const raw = `---
description: Start
\tcontinued
---
Body`

    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter.description).toBe('Start\ncontinued')
  })
})

describe('extractFirstLine', () => {
  it('returns first non-empty, non-heading line', () => {
    const body = `# Heading

This is the first real line.
And another.`

    expect(extractFirstLine(body)).toBe('This is the first real line.')
  })

  it('skips multiple headings', () => {
    const body = `# Title
## Subtitle
First content line`

    expect(extractFirstLine(body)).toBe('First content line')
  })

  it('returns empty string for heading-only content', () => {
    expect(extractFirstLine('# Only heading')).toBe('')
  })

  it('returns empty string for empty body', () => {
    expect(extractFirstLine('')).toBe('')
  })

  it('truncates to 200 characters', () => {
    const longLine = 'x'.repeat(300)
    expect(extractFirstLine(longLine)).toHaveLength(200)
  })

  it('skips empty lines', () => {
    const body = `


First real line`

    expect(extractFirstLine(body)).toBe('First real line')
  })

  it('returns first line immediately if no headings', () => {
    expect(extractFirstLine('Direct content')).toBe('Direct content')
  })
})
