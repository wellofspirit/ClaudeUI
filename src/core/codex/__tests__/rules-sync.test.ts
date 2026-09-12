/**
 * @vitest-environment node
 *
 * The Claude-rule → Codex-execpolicy compiler and its file writer.
 *
 * Every I/O test runs against an isolated `CODEX_HOME` under a temp dir; the
 * real `~/.codex` is never a subject here, and `loadClaudePermissions` is
 * mocked so the developer's own `~/.claude/settings.json` can never leak into
 * an expectation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ClaudePermissions } from '../../../shared/types'

const locateMocks = vi.hoisted(() => ({ codexBinaryAvailable: vi.fn(() => true) }))
vi.mock('../codex-locate', () => locateMocks)

const settingsMocks = vi.hoisted(() => ({
  loadClaudePermissions: vi.fn(() => ({ allow: [], deny: [], ask: [], additionalDirectories: [] }))
}))
vi.mock('../../services/claude-settings', () => settingsMocks)

const loggerMocks = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/logger', () => loggerMocks)

import { compileClaudeRulesToExecpolicy, resolveCodexHome, syncCodexRulesFile } from '../rules-sync'

const perms = (partial: Partial<ClaudePermissions>): ClaudePermissions => ({
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined,
  ...partial
})

/** Only the `prefix_rule(...)` lines, header comments dropped. */
const bodyLines = (text: string): string[] =>
  text
    .trimEnd()
    .split('\n')
    .filter((line) => !line.startsWith('#'))

const tempDirs: string[] = []
function tempCodexHome(create = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rules-'))
  tempDirs.push(dir)
  const codexHome = join(dir, '.codex')
  if (create) mkdirSync(codexHome, { recursive: true })
  return codexHome
}

const savedCodexHome = process.env.CODEX_HOME

beforeEach(() => {
  vi.clearAllMocks()
  locateMocks.codexBinaryAvailable.mockReturnValue(true)
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
})

describe('compileClaudeRulesToExecpolicy — mapping', () => {
  it('compiles a deny PREFIX rule to a forbidden prefix_rule over its argv tokens', () => {
    const { text, skipped } = compileClaudeRulesToExecpolicy(perms({ deny: ['Bash(rm -rf:*)'] }))
    expect(bodyLines(text)).toEqual([
      'prefix_rule(pattern=["rm", "-rf"], decision="forbidden", justification="ClaudeUI deny rule Bash(rm -rf:*)")'
    ])
    expect(skipped).toEqual([])
  })

  it('compiles an EXACT deny to the same (over-matching, therefore narrowing) prefix rule', () => {
    const { text, skipped } = compileClaudeRulesToExecpolicy(perms({ deny: ['Bash(git push)'] }))
    expect(bodyLines(text)).toEqual([
      'prefix_rule(pattern=["git", "push"], decision="forbidden", justification="ClaudeUI deny rule Bash(git push)")'
    ])
    expect(skipped).toEqual([])
  })

  it('compiles an allow PREFIX rule to an allow prefix_rule', () => {
    const { text } = compileClaudeRulesToExecpolicy(perms({ allow: ['Bash(ls:*)'] }))
    expect(bodyLines(text)).toEqual([
      'prefix_rule(pattern=["ls"], decision="allow", justification="ClaudeUI allow rule Bash(ls:*)")'
    ])
  })

  it('SKIPS an exact allow — a prefix would widen what the user granted', () => {
    const { text, skipped } = compileClaudeRulesToExecpolicy(perms({ allow: ['Bash(git status)'] }))
    expect(bodyLines(text)).toEqual([])
    expect(skipped).toEqual([
      { rule: 'Bash(git status)', reason: 'exact allow cannot be a prefix' }
    ])
  })

  it('skips a prefix carrying glob metacharacters in either tier', () => {
    const { text, skipped } = compileClaudeRulesToExecpolicy(
      perms({ deny: ['Bash(git * --force:*)'], allow: ['Bash(npm ru?:*)', 'Bash(a[bc]:*)'] })
    )
    expect(bodyLines(text)).toEqual([])
    expect(skipped.map((entry) => entry.rule)).toEqual([
      'Bash(git * --force:*)',
      'Bash(npm ru?:*)',
      'Bash(a[bc]:*)'
    ])
    for (const entry of skipped) expect(entry.reason).toBe('glob metacharacters cannot be a prefix')
  })

  it('skips a whole-tool Bash rule (`Bash`, `Bash()`, `Bash(*)`) — there is no prefix', () => {
    const { text, skipped } = compileClaudeRulesToExecpolicy(
      perms({ deny: ['Bash', 'Bash()', 'Bash(*)'] })
    )
    expect(bodyLines(text)).toEqual([])
    expect(skipped).toEqual([
      { rule: 'Bash', reason: 'whole-tool rule has no command prefix' },
      { rule: 'Bash()', reason: 'whole-tool rule has no command prefix' },
      { rule: 'Bash(*)', reason: 'whole-tool rule has no command prefix' }
    ])
  })

  it('skips every non-Bash tool, naming it', () => {
    const { text, skipped } = compileClaudeRulesToExecpolicy(
      perms({ deny: ['Read(/etc/**)'], allow: ['WebFetch(domain:example.com)'] })
    )
    expect(bodyLines(text)).toEqual([])
    expect(skipped).toEqual([
      { rule: 'Read(/etc/**)', reason: 'not a Bash rule (Read)' },
      { rule: 'WebFetch(domain:example.com)', reason: 'not a Bash rule (WebFetch)' }
    ])
  })

  it('skips a prefix that does not tokenize (unbalanced quote)', () => {
    const { text, skipped } = compileClaudeRulesToExecpolicy(
      perms({ deny: ['Bash(echo "unterminated:*)'] })
    )
    expect(bodyLines(text)).toEqual([])
    expect(skipped).toEqual([
      { rule: 'Bash(echo "unterminated:*)', reason: 'does not tokenize as shell words' }
    ])
  })

  it('unquotes a quoted prefix into the argv tokens Codex will actually compare', () => {
    const { text } = compileClaudeRulesToExecpolicy(
      perms({ deny: ['Bash(git commit -m "wip one":*)'] })
    )
    expect(bodyLines(text)[0]).toContain('pattern=["git", "commit", "-m", "wip one"]')
  })

  it('ignores a blank rule entry without reporting it as skipped', () => {
    const { text, skipped } = compileClaudeRulesToExecpolicy(perms({ deny: ['   ', ''] }))
    expect(bodyLines(text)).toEqual([])
    expect(skipped).toEqual([])
  })

  it('does not compile the `ask` tier, nor project-shaped extras', () => {
    const { text, skipped } = compileClaudeRulesToExecpolicy(
      perms({ ask: ['Bash(curl:*)'], additionalDirectories: ['/tmp/extra'] })
    )
    expect(bodyLines(text)).toEqual([])
    expect(skipped).toEqual([])
  })
})

describe('compileClaudeRulesToExecpolicy — output shape', () => {
  it('emits deny before allow, each in input order, byte-identically across runs', () => {
    const input = perms({
      deny: ['Bash(rm:*)', 'Bash(shutdown:*)'],
      allow: ['Bash(ls:*)', 'Bash(cat:*)']
    })
    const first = compileClaudeRulesToExecpolicy(input)
    const second = compileClaudeRulesToExecpolicy(perms(structuredClone(input)))
    expect(first.text).toBe(second.text)
    expect(first.hash).toBe(second.hash)
    expect(bodyLines(first.text).map((line) => line.slice(0, line.indexOf(']') + 1))).toEqual([
      'prefix_rule(pattern=["rm"]',
      'prefix_rule(pattern=["shutdown"]',
      'prefix_rule(pattern=["ls"]',
      'prefix_rule(pattern=["cat"]'
    ])
  })

  it('changes the hash when a rule changes, and when only the SKIPPED set changes', () => {
    const base = compileClaudeRulesToExecpolicy(perms({ deny: ['Bash(rm:*)'] }))
    const otherRule = compileClaudeRulesToExecpolicy(perms({ deny: ['Bash(rmdir:*)'] }))
    const extraSkip = compileClaudeRulesToExecpolicy(
      perms({ deny: ['Bash(rm:*)'], allow: ['Bash(git status)'] })
    )
    expect(otherRule.hash).not.toBe(base.hash)
    expect(extraSkip.hash).not.toBe(base.hash)
  })

  it('writes the generated-by banner, the hash of its own content, and the skipped list', () => {
    const compiled = compileClaudeRulesToExecpolicy(
      perms({ deny: ['Bash(rm:*)'], allow: ['Bash(git status)', 'Read(/x)'] })
    )
    const lines = compiled.text.split('\n')
    expect(lines[0]).toBe(
      '# Generated by ClaudeUI from ~/.claude/settings.json user-scope permissions. Do not edit; edits are overwritten.'
    )
    expect(compiled.text).toContain(`# source-hash: ${compiled.hash}`)
    expect(compiled.text).toContain('# skipped: 2 (listed below)')
    expect(compiled.text).toContain('#   Bash(git status)  exact allow cannot be a prefix')
    expect(compiled.text).toContain('#   Read(/x)  not a Bash rule (Read)')
    // The hash line must be the only thing not covered by the hash, so the
    // staleness check ("same hash → same bytes") cannot be fooled.
    expect(compiled.text.match(/^# source-hash: /gm)).toHaveLength(1)
    expect(compiled.text.endsWith('\n')).toBe(true)
  })

  it('records `# skipped: 0` when everything compiled', () => {
    const compiled = compileClaudeRulesToExecpolicy(perms({ deny: ['Bash(rm:*)'] }))
    expect(compiled.text).toContain('\n# skipped: 0\n')
  })

  it('escapes quotes, backslashes and control characters inside an emitted pattern token', () => {
    const compiled = compileClaudeRulesToExecpolicy(
      perms({
        deny: ['Bash(printf "a\tb":*)', "Bash(printf 'q\"uote':*)", "Bash(printf 'back\\slash':*)"]
      })
    )
    expect(bodyLines(compiled.text)).toEqual([
      'prefix_rule(pattern=["printf", "a\\tb"], decision="forbidden", justification="ClaudeUI deny rule Bash(printf \\"a b\\":*)")',
      'prefix_rule(pattern=["printf", "q\\"uote"], decision="forbidden", justification="ClaudeUI deny rule Bash(printf \'q\\"uote\':*)")',
      'prefix_rule(pattern=["printf", "back\\\\slash"], decision="forbidden", justification="ClaudeUI deny rule Bash(printf \'back\\\\slash\':*)")'
    ])
  })

  it('flattens a rule onto one comment line so a skipped entry cannot become a statement', () => {
    const injected = 'Bash(x*\nprefix_rule(pattern=["sudo"], decision="allow")\n:*)'
    const compiled = compileClaudeRulesToExecpolicy(perms({ deny: [injected] }))
    for (const line of compiled.text.trimEnd().split('\n')) expect(line.startsWith('#')).toBe(true)
    expect(compiled.text).toContain(
      '#   Bash(x* prefix_rule(pattern=["sudo"], decision="allow") :*)  glob metacharacters cannot be a prefix'
    )
  })
})

describe('syncCodexRulesFile', () => {
  it('creates rules/claudeui.rules under an isolated CODEX_HOME', () => {
    const codexHome = tempCodexHome()
    const result = syncCodexRulesFile({ codexHome, perms: perms({ deny: ['Bash(rm -rf:*)'] }) })
    expect(result.wrote).toBe(true)
    expect(result.path).toBe(join(codexHome, 'rules', 'claudeui.rules'))
    expect(readFileSync(result.path, 'utf8')).toContain(
      'prefix_rule(pattern=["rm", "-rf"], decision="forbidden"'
    )
    expect(loggerMocks.logger.info).toHaveBeenCalled()
  })

  it('does not rewrite when the compiled content is unchanged', () => {
    const codexHome = tempCodexHome()
    const input = perms({ deny: ['Bash(rm:*)'] })
    const first = syncCodexRulesFile({ codexHome, perms: input })
    // A sentinel the writer would destroy. The `# source-hash:` line is
    // untouched, so an up-to-date check must leave the whole file alone.
    writeFileSync(first.path, `${readFileSync(first.path, 'utf8')}# sentinel\n`)
    const second = syncCodexRulesFile({ codexHome, perms: perms({ deny: ['Bash(rm:*)'] }) })
    expect(second.wrote).toBe(false)
    expect(readFileSync(first.path, 'utf8')).toContain('# sentinel')
  })

  it('rewrites when the rules change', () => {
    const codexHome = tempCodexHome()
    const first = syncCodexRulesFile({ codexHome, perms: perms({ deny: ['Bash(rm:*)'] }) })
    writeFileSync(first.path, `${readFileSync(first.path, 'utf8')}# sentinel\n`)
    const second = syncCodexRulesFile({ codexHome, perms: perms({ deny: ['Bash(shutdown:*)'] }) })
    expect(second.wrote).toBe(true)
    const text = readFileSync(second.path, 'utf8')
    expect(text).not.toContain('# sentinel')
    expect(text).toContain('pattern=["shutdown"]')
  })

  it('does nothing when CODEX_HOME does not exist — it must not look installed', () => {
    const codexHome = tempCodexHome(false)
    const result = syncCodexRulesFile({ codexHome, perms: perms({ deny: ['Bash(rm:*)'] }) })
    expect(result.wrote).toBe(false)
    expect(existsSync(codexHome)).toBe(false)
  })

  it('does nothing when no Codex binary is available', () => {
    locateMocks.codexBinaryAvailable.mockReturnValue(false)
    const codexHome = tempCodexHome()
    const result = syncCodexRulesFile({ codexHome, perms: perms({ deny: ['Bash(rm:*)'] }) })
    expect(result.wrote).toBe(false)
    expect(existsSync(join(codexHome, 'rules'))).toBe(false)
  })

  it('leaves every other file under CODEX_HOME alone', () => {
    const codexHome = tempCodexHome()
    mkdirSync(join(codexHome, 'rules'), { recursive: true })
    const neighbours = [
      join(codexHome, 'config.toml'),
      join(codexHome, 'auth.json'),
      join(codexHome, 'rules', 'handwritten.rules')
    ]
    for (const file of neighbours) writeFileSync(file, 'untouched\n')
    const before = neighbours.map((file) => statSync(file).mtimeMs)
    syncCodexRulesFile({ codexHome, perms: perms({ deny: ['Bash(rm:*)'] }) })
    neighbours.forEach((file, index) => {
      expect(readFileSync(file, 'utf8')).toBe('untouched\n')
      expect(statSync(file).mtimeMs).toBe(before[index])
    })
    // No temp file left behind either.
    expect(readFileSync(join(codexHome, 'rules', 'claudeui.rules'), 'utf8').length).toBeGreaterThan(
      0
    )
  })

  it('reads user-scope permissions when none are passed', () => {
    const codexHome = tempCodexHome()
    settingsMocks.loadClaudePermissions.mockReturnValue(perms({ deny: ['Bash(curl:*)'] }) as never)
    const result = syncCodexRulesFile({ codexHome })
    expect(settingsMocks.loadClaudePermissions).toHaveBeenCalledWith('user')
    expect(readFileSync(result.path, 'utf8')).toContain('pattern=["curl"]')
  })

  it('warns instead of throwing when the write fails', () => {
    const codexHome = tempCodexHome()
    // `rules` is a FILE, so mkdir/write beneath it cannot succeed.
    writeFileSync(join(codexHome, 'rules'), 'not a directory\n')
    const result = syncCodexRulesFile({ codexHome, perms: perms({ deny: ['Bash(rm:*)'] }) })
    expect(result.wrote).toBe(false)
    expect(loggerMocks.logger.warn).toHaveBeenCalled()
  })
})

/**
 * The compiler's output is Starlark that a THIRD-PARTY parser has to accept, so
 * "it looks right" is not enough — an escaping bug would silently invalidate the
 * whole file and, per `load_exec_policy`, drop every rule in the user layer.
 * `codex execpolicy check` is the same parser Codex loads rules with, so this
 * runs the real one wherever the vendored binary exists.
 */
const vendoredCodex = resolve('vendor/codex-cli/codex')
const canRunCodex =
  process.platform === 'darwin' && process.arch === 'arm64' && existsSync(vendoredCodex)

describe.skipIf(!canRunCodex)('generated file against the real execpolicy parser', () => {
  const check = (rulesPath: string, argv: string[], codexHome: string) => {
    const run = spawnSync(vendoredCodex, ['execpolicy', 'check', '--rules', rulesPath, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: codexHome }
    })
    expect(run.stderr, run.stderr).not.toMatch(/error|panic/i)
    return JSON.parse(run.stdout) as { decision?: string }
  }

  it('parses, forbids the compiled deny prefix, allows the compiled allow prefix', () => {
    const codexHome = tempCodexHome()
    const { path } = syncCodexRulesFile({
      codexHome,
      perms: perms({
        deny: ['Bash(rm -rf:*)', 'Bash(git push)'],
        allow: ['Bash(ls:*)', 'Bash(git status)', 'Read(/x)']
      })
    })
    expect(check(path, ['rm', '-rf', '/tmp/x'], codexHome).decision).toBe('forbidden')
    // The exact deny over-matches by design: a longer command still matches.
    expect(check(path, ['git', 'push', '--force'], codexHome).decision).toBe('forbidden')
    expect(check(path, ['ls', '-la'], codexHome).decision).toBe('allow')
    // The skipped exact allow contributed nothing — `git status` is unruled.
    expect(check(path, ['git', 'status'], codexHome).decision).toBeUndefined()
  })

  it('parses a rule whose tokens carry quotes, backslashes and control characters', () => {
    const codexHome = tempCodexHome()
    const { path } = syncCodexRulesFile({
      codexHome,
      perms: perms({ deny: ["Bash(printf \"a\tb\" 'q\"uote' 'back\\slash':*)"] })
    })
    expect(check(path, ['printf', 'a\tb', 'q"uote', 'back\\slash'], codexHome).decision).toBe(
      'forbidden'
    )
  })
})

describe('the default-home arming gate', () => {
  // Module-level state, so each case gets a fresh copy rather than inheriting
  // whatever a previous case armed.
  const freshModule = async () => {
    vi.resetModules()
    return import('../rules-sync')
  }

  it('refuses the implicit home until the application has booted', async () => {
    // The hazard this exists for: `savePermissionsAndNotify` and the Codex
    // spawn prep are both called directly by unit tests of unrelated behaviour,
    // and both reach this writer with no `codexHome`. Unarmed, that would
    // rewrite the developer's own `~/.codex/rules/claudeui.rules`.
    const { syncCodexRulesFile: sync } = await freshModule()
    const codexHome = tempCodexHome()
    process.env.CODEX_HOME = codexHome

    expect(sync({ perms: perms({ deny: ['Bash(rm:*)'] }) }).wrote).toBe(false)
    expect(existsSync(join(codexHome, 'rules'))).toBe(false)

    // An EXPLICIT home never needs arming — that is every test, and it is why
    // the gate costs no coverage.
    expect(sync({ codexHome, perms: perms({ deny: ['Bash(rm:*)'] }) }).wrote).toBe(true)
  })

  it('writes to the implicit home once armed', async () => {
    const { armCodexRulesSync: arm, syncCodexRulesFile: sync } = await freshModule()
    const codexHome = tempCodexHome()
    process.env.CODEX_HOME = codexHome
    arm()

    const result = sync({ perms: perms({ deny: ['Bash(rm:*)'] }) })

    expect(result.wrote).toBe(true)
    expect(result.path).toBe(join(codexHome, 'rules', 'claudeui.rules'))
  })
})

describe('resolveCodexHome', () => {
  it('prefers a non-empty CODEX_HOME', () => {
    process.env.CODEX_HOME = '/tmp/isolated-codex'
    expect(resolveCodexHome()).toBe('/tmp/isolated-codex')
  })

  it('falls back to ~/.codex when CODEX_HOME is unset or empty, as Codex itself does', () => {
    delete process.env.CODEX_HOME
    expect(resolveCodexHome()).toMatch(/[/\\]\.codex$/)
    process.env.CODEX_HOME = ''
    expect(resolveCodexHome()).toMatch(/[/\\]\.codex$/)
  })
})
