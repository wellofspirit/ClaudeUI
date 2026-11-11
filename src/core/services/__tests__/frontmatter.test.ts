/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '../frontmatter'

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

  it('handles a literal block scalar (description: |) without leaking the indicator', () => {
    const raw = `---
name: my-skill
description: |
  First block line
  Second block line
---
Body`

    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter.description).toBe('First block line\nSecond block line')
    expect(frontmatter.description).not.toContain('|')
    expect(frontmatter.name).toBe('my-skill')
    expect(body).toBe('Body')
  })

  it('handles a strip-chomped literal block scalar (|-)', () => {
    const raw = `---
description: |-
  Line one
  Line two

---
Body`

    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter.description).toBe('Line one\nLine two')
  })

  it('folds a folded block scalar (>) onto one line', () => {
    const raw = `---
description: >
  Folded one
  folded two
---
Body`

    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter.description).toBe('Folded one folded two')
  })

  it('does not treat a value merely containing a pipe as a block scalar', () => {
    const raw = `---
description: use a | pipe here
---
Body`

    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter.description).toBe('use a | pipe here')
  })

  it('resumes normal key parsing after a block scalar', () => {
    const raw = `---
description: |
  Block line
version: 1.0
---
Body`

    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter.description).toBe('Block line')
    expect(frontmatter.version).toBe('1.0')
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
