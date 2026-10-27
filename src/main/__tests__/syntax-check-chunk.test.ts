/** @vitest-environment node */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const { createSyntaxChecker, syntaxCheckChunk, syntaxCheckNodeVersion } =
  await import('../../../scripts/lib/syntax-check-chunk.mjs')

/** Run a snippet under Bun and return its parsed JSON result. */
function runUnderBun(source: string, env: Record<string, string>): Record<string, any> {
  const stdout = execFileSync('bun', ['-e', source], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 25_000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  return JSON.parse(line as string)
}

describe('patched chunk syntax checking', () => {
  it('parses ESM without resolving absent imports or evaluating top-level code', () => {
    expect(
      syntaxCheckChunk(
        Buffer.from(`
        import missing from 'claudeui-nonexistent-syntax-check-package';
        export { other } from '/nonexistent/claudeui-syntax-check-module.mjs';
        throw new Error('must not execute');
        await Promise.reject(new Error('must not execute either'));
        export default missing;
      `)
      )
    ).toBeNull()
  })

  it('accepts independent chunks with colliding module bindings', () => {
    for (const value of [1, 2]) {
      expect(
        syntaxCheckChunk(Buffer.from(`const binding = ${value}; export { binding };`))
      ).toBeNull()
    }
  })

  it('fails closed with parser diagnostics for malformed JavaScript', () => {
    expect(syntaxCheckChunk(Buffer.from('export const value = ;'))).toMatch(/SyntaxError/)
  })

  it('rejects an unbound ESM export', () => {
    expect(syntaxCheckChunk(Buffer.from('export { undefinedBinding };'))).toMatch(
      /Export 'undefinedBinding' is not defined/
    )
  })

  it('reports the Node that checked the chunks', () => {
    expect(syntaxCheckNodeVersion()).toBe(process.version)
  })

  // Acceptance criterion 1 / A3: the module must report parser errors even when
  // it is loaded under Bun, whose own `--check` is a project-wide TypeScript
  // check that never parses the piped chunk.
  it('reports malformed chunks when loaded under Bun', { timeout: 30_000 }, () => {
    const moduleUrl = new URL('../../../scripts/lib/syntax-check-chunk.mjs', import.meta.url).href
    const result = runUnderBun(
      `
        ;(async () => {
          const mod = await import(process.env.CLAUDEUI_SYNTAX_CHECK_MODULE_URL)
          const attempt = (source) => {
            try {
              return { value: mod.syntaxCheckChunk(Buffer.from(source)) }
            } catch (err) {
              return { error: String((err && err.message) || err) }
            }
          }
          const invalid = attempt('export const value = ;')
          const valid = attempt('export {}')
          let node = null
          try {
            node = mod.syntaxCheckNodeVersion()
          } catch {}
          console.log(JSON.stringify({ bun: process.versions.bun, node, invalid, valid }))
        })()
        `,
      { CLAUDEUI_SYNTAX_CHECK_MODULE_URL: moduleUrl }
    )

    // Proves the assertions ran in Bun, not in this Node process.
    expect(result.bun).toBeTruthy()
    expect(String(result.invalid.value ?? result.invalid.error)).toMatch(/SyntaxError/)
    expect(result.valid.error).toBeUndefined()
    expect(result.valid.value).toBeNull()
    // …and that it checked with a real Node found on PATH, not Bun itself.
    expect(result.node).toMatch(/^v\d+\./)
  })
})

// Acceptance criterion 2 / A1: the command is proved by a canary before any
// chunk is trusted, so a fake (or Bun's node shim) cannot fail open or fail shut.
describe('checker runtime validation', () => {
  const notRealNode = /syntax check needs a real Node\.js: ".*" is not one \(/

  it('rejects a command that accepts every input', () => {
    const checker = createSyntaxChecker(process.execPath, ['-e', 'process.exit(0)'])
    expect(() => checker.check(Buffer.from('export const value = ;'))).toThrow(notRealNode)
    expect(() => checker.check(Buffer.from('export {}'))).toThrow(notRealNode)
  })

  it('rejects a command that rejects every input', () => {
    const checker = createSyntaxChecker(process.execPath, [
      '-e',
      "require('node:fs').writeSync(2, 'SyntaxError: fake rejection\\n'); process.exit(1)"
    ])
    expect(() => checker.check(Buffer.from('export {}'))).toThrow(notRealNode)
  })

  it('throws for a command that does not exist', () => {
    const checker = createSyntaxChecker(
      join(tmpdir(), 'claudeui-missing-node-does-not-exist', 'node')
    )
    expect(() => checker.check(Buffer.from('export {}'))).toThrow(notRealNode)
    expect(() => checker.check(Buffer.from('export {}'))).toThrow(/ENOENT/)
  })

  it('fails closed when the checker dies or exits without a diagnostic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudeui-syntax-silent-'))
    const script = join(dir, 'silent-check.cjs')
    writeFileSync(
      script,
      [
        "const { readFileSync, writeSync } = require('node:fs')",
        "const source = readFileSync(0, 'utf8')",
        "if (source.includes('export const value = ;')) {",
        "  writeSync(2, 'SyntaxError: fake rejection\\n')",
        '  process.exit(1)',
        '}',
        "if (source.includes('kill-self')) process.kill(process.pid, 'SIGTERM')",
        "if (source.includes('silent-failure')) process.exit(1)"
      ].join('\n')
    )
    try {
      const checker = createSyntaxChecker(process.execPath, [script])
      expect(() => checker.check(Buffer.from('silent-failure'))).toThrow(
        /syntax check did not run: ".*" exited 1 without a diagnostic/
      )
      // Windows reports a self-killed child as status 1, POSIX as a signal;
      // both must surface as a broken checker, never as a chunk diagnostic.
      expect(() => checker.check(Buffer.from('kill-self'))).toThrow(
        /syntax check did not (run|finish)/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates the command once and then reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudeui-syntax-canary-'))
    const counter = join(dir, 'spawns.txt')
    const script = join(dir, 'fake-check.cjs')
    writeFileSync(
      script,
      [
        "const { appendFileSync, readFileSync } = require('node:fs')",
        'appendFileSync(process.env.CLAUDEUI_SYNTAX_SPAWN_COUNTER, ".")',
        "const source = readFileSync(0, 'utf8')",
        "if (source.includes('export const value = ;')) {",
        "  require('node:fs').writeSync(2, 'SyntaxError: fake rejection\\n')",
        '  process.exit(1)',
        '}'
      ].join('\n')
    )
    const previous = process.env.CLAUDEUI_SYNTAX_SPAWN_COUNTER
    process.env.CLAUDEUI_SYNTAX_SPAWN_COUNTER = counter
    try {
      const checker = createSyntaxChecker(process.execPath, [script])
      expect(checker.check(Buffer.from('export {}'))).toBeNull()
      // Invalid canary, valid canary, then the chunk itself.
      expect(readFileSync(counter, 'utf8')).toHaveLength(3)
      expect(checker.check(Buffer.from('export {}'))).toBeNull()
      expect(readFileSync(counter, 'utf8')).toHaveLength(4)
    } finally {
      if (previous === undefined) delete process.env.CLAUDEUI_SYNTAX_SPAWN_COUNTER
      else process.env.CLAUDEUI_SYNTAX_SPAWN_COUNTER = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
