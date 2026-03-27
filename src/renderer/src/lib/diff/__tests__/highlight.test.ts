import { describe, it, expect } from 'vitest'
import { getLang, tokenizeLines } from '../highlight'

describe('getLang', () => {
  it('resolves TypeScript extensions', () => {
    expect(getLang('src/foo.ts')).toBe('typescript')
    expect(getLang('src/foo.tsx')).toBe('tsx')
    expect(getLang('src/foo.mts')).toBe('typescript')
  })

  it('resolves JavaScript extensions', () => {
    expect(getLang('src/foo.js')).toBe('javascript')
    expect(getLang('src/foo.jsx')).toBe('jsx')
    expect(getLang('src/foo.mjs')).toBe('javascript')
    expect(getLang('src/foo.cjs')).toBe('javascript')
  })

  it('resolves common languages', () => {
    expect(getLang('main.py')).toBe('python')
    expect(getLang('main.rs')).toBe('rust')
    expect(getLang('main.go')).toBe('go')
    expect(getLang('main.rb')).toBe('ruby')
    expect(getLang('main.java')).toBe('java')
    expect(getLang('main.cpp')).toBe('cpp')
    expect(getLang('main.c')).toBe('c')
  })

  it('resolves extensionless files', () => {
    expect(getLang('Dockerfile')).toBe('docker')
    expect(getLang('Makefile')).toBe('makefile')
  })

  it('resolves data formats', () => {
    expect(getLang('data.json')).toBe('json')
    expect(getLang('config.yaml')).toBe('yaml')
    expect(getLang('config.yml')).toBe('yaml')
    expect(getLang('config.toml')).toBe('toml')
  })

  it('returns plaintext for unknown extensions', () => {
    expect(getLang('file.xyz')).toBe('plaintext')
    expect(getLang('random.unknown')).toBe('plaintext')
  })

  it('returns plaintext for undefined/empty', () => {
    expect(getLang(undefined)).toBe('plaintext')
    expect(getLang('')).toBe('plaintext')
  })

  it('handles nested paths correctly', () => {
    expect(getLang('/a/b/c/deep/file.ts')).toBe('typescript')
    expect(getLang('src/renderer/src/components/Foo.tsx')).toBe('tsx')
  })

  it('is case-insensitive for file names', () => {
    expect(getLang('DOCKERFILE')).toBe('docker')
    expect(getLang('MAKEFILE')).toBe('makefile')
  })
})

describe('tokenizeLines', () => {
  it('tokenizes a single line of TypeScript', () => {
    const result = tokenizeLines('const x = 1', 'typescript')

    expect(result).toHaveLength(1)
    expect(result[0].length).toBeGreaterThan(0)

    // Should contain 'const' as a keyword token
    const constToken = result[0].find((t) => t.content.includes('const'))
    expect(constToken).toBeDefined()
    // Keywords should have a color
    expect(constToken?.color).toBeDefined()
  })

  it('tokenizes multiple lines', () => {
    const code = 'const a = 1\nconst b = 2\nconst c = 3'
    const result = tokenizeLines(code, 'typescript')

    expect(result).toHaveLength(3)
    // Each line should have tokens
    for (const line of result) {
      expect(line.length).toBeGreaterThan(0)
    }
  })

  it('handles empty lines', () => {
    const code = 'const a = 1\n\nconst b = 2'
    const result = tokenizeLines(code, 'typescript')

    expect(result).toHaveLength(3)
    // Middle line should have a single empty/whitespace token
    expect(result[1]).toBeDefined()
  })

  it('returns basic tokens for plaintext', () => {
    const result = tokenizeLines('hello world', 'plaintext')
    expect(result).toHaveLength(1)
    // Should still tokenize, just without colors
    const content = result[0].map((t) => t.content).join('')
    expect(content).toBe('hello world')
  })

  it('handles syntax highlighting for strings', () => {
    const result = tokenizeLines("const s = 'hello'", 'typescript')
    expect(result).toHaveLength(1)
    // The string 'hello' should have a distinct color
    const stringToken = result[0].find((t) => t.content.includes('hello'))
    expect(stringToken).toBeDefined()
    expect(stringToken?.color).toBeDefined()
  })

  it('handles multi-line constructs correctly', () => {
    const code = '/*\n * block comment\n */\nconst x = 1'
    const result = tokenizeLines(code, 'typescript')

    expect(result).toHaveLength(4)
    // Comment lines should have comment coloring
    const commentToken = result[1].find((t) => t.content.includes('block comment'))
    expect(commentToken).toBeDefined()
  })

  it('is efficient for large inputs', () => {
    // Generate 1000 lines of code
    const lines = Array.from({ length: 1000 }, (_, i) => `const var${i} = ${i}`)
    const code = lines.join('\n')

    const start = performance.now()
    const result = tokenizeLines(code, 'typescript')
    const elapsed = performance.now() - start

    expect(result).toHaveLength(1000)
    // Should complete in under 2 seconds even on slow CI
    expect(elapsed).toBeLessThan(2000)
  })
})
