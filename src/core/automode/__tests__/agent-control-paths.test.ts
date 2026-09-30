/**
 * The agent-control path list and matcher (ADR-084 §3). Both engines route an
 * edit here through it — pi calls the matcher, opencode gets the list rendered
 * as `edit` ask patterns — so a miss is an edit that arms git or rewrites the
 * agent's instructions with no review at all.
 */
import { describe, it, expect } from 'vitest'
import {
  AGENT_CONTROL_DIRS,
  AGENT_CONTROL_FILES,
  agentControlEditPatterns,
  isAgentControlPath,
  isAgentControlTarget
} from '../agent-control-paths'

describe('isAgentControlPath — what matches', () => {
  it.each([
    // the root and any depth
    '.git/config',
    '.git/hooks/pre-commit',
    'sub/.git/hooks/pre-commit',
    'packages/a/.git/info/attributes',
    // a linked worktree's `.git` is a file
    '.git',
    'nested/.git',
    '.claude/settings.json',
    '.claude/settings.local.json',
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENTS.md',
    'AGENTS.override.md',
    'docs/AGENTS.md',
    '.husky/pre-commit',
    '.githooks/pre-push',
    '.vscode/tasks.json',
    '.devcontainer/devcontainer.json',
    '.devcontainer.json',
    '.mcp.json',
    'opencode.json',
    'opencode.jsonc',
    '.opencode/plugin/x.ts',
    '.pi/settings.json',
    '.pi/extensions/evil.ts',
    '.agents/skills/x/SKILL.md'
  ])('%s', (p) => {
    expect(isAgentControlPath(p)).toBe(true)
  })

  it('matches absolute paths, POSIX and Windows alike', () => {
    expect(isAgentControlPath('/home/u/repo/.git/config')).toBe(true)
    expect(isAgentControlPath('D:\\repo\\.git\\config')).toBe(true)
    expect(isAgentControlPath('D:/repo/.vscode/tasks.json')).toBe(true)
    expect(isAgentControlPath('C:\\Users\\u\\.claude\\settings.json')).toBe(true)
    expect(isAgentControlPath('\\\\?\\D:\\repo\\.git\\config')).toBe(true)
  })

  it('treats `\\` and `/` as the same separator', () => {
    expect(isAgentControlPath('sub\\.git\\hooks\\pre-commit')).toBe(true)
    expect(isAgentControlPath('sub/.git\\hooks/pre-commit')).toBe(true)
    expect(isAgentControlPath('.claude\\settings.json')).toBe(true)
  })

  it('is case-insensitive on every platform (NTFS and APFS fold case)', () => {
    expect(isAgentControlPath('.GIT/config')).toBe(true)
    expect(isAgentControlPath('.Git/Hooks/pre-commit')).toBe(true)
    expect(isAgentControlPath('.CLAUDE/settings.json')).toBe(true)
    expect(isAgentControlPath('claude.md')).toBe(true)
    // Accepted over-match: a docs page that happens to be called CLAUDE.md asks too.
    expect(isAgentControlPath('docs/CLAUDE.md')).toBe(true)
    expect(isAgentControlPath('docs/claude.md')).toBe(true)
    // The two non-ASCII letters whose uppercase is ASCII.
    expect(isAgentControlPath('.g\u0131t/config')).toBe(true)
    expect(isAgentControlPath('.hu\u017fky/pre-commit')).toBe(true)
  })

  it('sees through Windows spellings of the same entry', () => {
    // Win32 strips trailing dots and spaces from a component.
    expect(isAgentControlPath('.git./config')).toBe(true)
    expect(isAgentControlPath('.git /config')).toBe(true)
    expect(isAgentControlPath('CLAUDE.md.')).toBe(true)
    // An alternate-data-stream suffix names the entry before the colon.
    expect(isAgentControlPath('CLAUDE.md:stream')).toBe(true)
    expect(isAgentControlPath('.git::$INDEX_ALLOCATION/config')).toBe(true)
    // An 8.3 short-name alias may be any long name — asked for.
    expect(isAgentControlPath('GIT~1/config')).toBe(true)
    expect(isAgentControlPath('CLAUDE~1/settings.json')).toBe(true)
    expect(isAgentControlPath('AGENTS~1.MD')).toBe(true)
  })

  it('still matches a path that climbs out with `..`', () => {
    expect(isAgentControlPath('../.git/config')).toBe(true)
    expect(isAgentControlPath('src/../.claude/settings.json')).toBe(true)
  })
})

describe('isAgentControlPath — near misses that must NOT match', () => {
  it.each([
    'src/a.ts',
    'src/.git-hooks-docs.md',
    '.github/workflows/ci.yml',
    '.gitignore',
    '.gitattributes',
    'foo.git/config',
    'my.git',
    '.gitkeep',
    'docs/claude-notes.md',
    'CLAUDE.md.bak',
    'CLAUDE.mdx',
    'notes/AGENTS.md-x.ts',
    'claude/settings.json',
    '.claudeignore',
    '.vscode-test/run.js',
    'vscode/tasks.json',
    'opencode.json.example',
    'pi/settings.json',
    '.pip/pip.conf',
    'agents/skills/x.md',
    'mcp.json',
    // a file NAMED like a control dir's child is not inside it
    'config',
    'hooks/pre-commit',
    // CLAUDE.md as a directory component is not the file
    'CLAUDE.md/x.ts',
    '',
    '.',
    '..'
  ])('%s', (p) => {
    expect(isAgentControlPath(p)).toBe(false)
  })

  it('a drive letter never matches', () => {
    expect(isAgentControlPath('C:\\repo\\src\\a.ts')).toBe(false)
    expect(isAgentControlPath('C:')).toBe(false)
  })
})

describe('isAgentControlTarget — resolved against the session cwd', () => {
  const wt = '/repo/.claude/worktrees/x'

  it('inside cwd: matched relative, so a worktree under .claude/ is not itself a match', () => {
    expect(isAgentControlTarget('src/a.ts', wt)).toBe(false)
    expect(isAgentControlTarget(`${wt}/src/a.ts`, wt)).toBe(false)
    expect(isAgentControlTarget('.git', wt)).toBe(true)
    expect(isAgentControlTarget(`${wt}/.vscode/tasks.json`, wt)).toBe(true)
  })

  it('outside cwd: matched absolute, so `..` keeps the ancestors it lands in', () => {
    expect(isAgentControlTarget('../../settings.json', wt)).toBe(true)
    expect(isAgentControlTarget('/repo/.claude/settings.json', wt)).toBe(true)
    expect(isAgentControlTarget('../../../src/a.ts', wt)).toBe(false)
    expect(isAgentControlTarget('../outside/.claude/settings.json', '/repo')).toBe(true)
  })

  it('Windows cwd: native separators, case-insensitive containment, other drives', () => {
    expect(isAgentControlTarget('src\\a.ts', 'D:\\repo')).toBe(false)
    expect(isAgentControlTarget('d:\\REPO\\src\\a.ts', 'D:\\repo')).toBe(false)
    expect(isAgentControlTarget('.git\\config', 'D:\\repo')).toBe(true)
    expect(isAgentControlTarget('E:\\x\\.claude\\settings.json', 'D:\\repo')).toBe(true)
    expect(isAgentControlTarget('..\\..\\settings.json', 'D:\\r\\.claude\\worktrees\\x')).toBe(true)
  })

  it('no cwd: the path as given', () => {
    expect(isAgentControlTarget('.git/config', undefined)).toBe(true)
    expect(isAgentControlTarget('src/a.ts', undefined)).toBe(false)
  })
})

describe('agentControlEditPatterns', () => {
  it('renders a bare and a `*/` form for every name, plus `/*` forms for directories', () => {
    const patterns = agentControlEditPatterns()
    for (const d of AGENT_CONTROL_DIRS) {
      expect(patterns).toEqual(expect.arrayContaining([d, `${d}/*`, `*/${d}`, `*/${d}/*`]))
    }
    for (const f of AGENT_CONTROL_FILES) {
      expect(patterns).toEqual(expect.arrayContaining([f, `*/${f}`]))
    }
    expect(patterns).toHaveLength(AGENT_CONTROL_DIRS.length * 4 + AGENT_CONTROL_FILES.length * 2)
  })
})
