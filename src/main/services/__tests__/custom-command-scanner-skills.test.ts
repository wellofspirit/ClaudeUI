/**
 * @vitest-environment node
 *
 * Layer 1: the slash-command fallback scanner over a REAL filesystem.
 *
 * The sibling custom-command-scanner.test.ts mocks `fs` wholesale, which cannot
 * express the cases that actually broke the `/` menu: skills live in
 * `<root>/<name>/SKILL.md` directories, and the entries under `~/.claude/skills`
 * are usually symlinks/junctions (a config repo syncs them in). readdir reports
 * those as symbolic links — neither files nor directories — so the acceptance
 * rules only mean something against real inodes.
 *
 * Same hoisted os.homedir() override as claude-workspace-trust.test.ts: the real
 * ~/.claude is never read (it would make assertions machine-dependent).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const hoisted = vi.hoisted(() => {
  const realFs = require('fs') as typeof import('fs')
  const realOs = require('os') as typeof import('os')
  const realPath = require('path') as typeof import('path')
  const root = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudeui-cmdscan-'))
  return {
    TEST_HOME: realPath.join(root, 'home'),
    TEST_CWD: realPath.join(root, 'project'),
    TEST_EXTERNAL: realPath.join(root, 'external'),
    ROOT: root
  }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, homedir: () => hoisted.TEST_HOME },
    homedir: () => hoisted.TEST_HOME
  }
})

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

import { scanCustomCommands, _resetCache } from '../custom-command-scanner'

const USER_COMMANDS = path.join(hoisted.TEST_HOME, '.claude', 'commands')
const USER_SKILLS = path.join(hoisted.TEST_HOME, '.claude', 'skills')
const PROJECT_COMMANDS = path.join(hoisted.TEST_CWD, '.claude', 'commands')
const PROJECT_SKILLS = path.join(hoisted.TEST_CWD, '.claude', 'skills')

/** Write a command markdown file, creating parents. */
function writeCommand(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, '# command\n')
  return file
}

/** Create a real skill directory (`<dir>/<name>/SKILL.md`). */
function writeSkill(dir: string, name: string): string {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: ' + name + '\n---\nbody\n')
  return skillDir
}

/**
 * Windows only grants unprivileged symlink creation for directory junctions;
 * file symlinks need Developer Mode or SeCreateSymbolicLink. Probe once so the
 * file-symlink case can be skipped honestly instead of faked.
 */
const CAN_SYMLINK_FILE = ((): boolean => {
  try {
    const probeDir = fs.mkdtempSync(path.join(hoisted.ROOT, 'probe-'))
    const target = path.join(probeDir, 'target.md')
    fs.writeFileSync(target, 'x')
    fs.symlinkSync(target, path.join(probeDir, 'link.md'), 'file')
    return true
  } catch {
    return false
  }
})()

function linkDir(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(target, linkPath, 'junction')
}

beforeEach(() => {
  for (const dir of [hoisted.TEST_HOME, hoisted.TEST_CWD, hoisted.TEST_EXTERNAL]) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  }
  _resetCache()
})

afterAll(() => {
  fs.rmSync(hoisted.ROOT, { recursive: true, force: true })
})

describe('scanCustomCommands — real filesystem', () => {
  it('finds a regular .md command file (existing behavior)', () => {
    writeCommand(PROJECT_COMMANDS, 'refactor.md')
    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/refactor'])
  })

  it.skipIf(!CAN_SYMLINK_FILE)('finds a symlinked .md command file', () => {
    const target = writeCommand(hoisted.TEST_EXTERNAL, 'linked-cmd.md')
    fs.mkdirSync(USER_COMMANDS, { recursive: true })
    fs.symlinkSync(target, path.join(USER_COMMANDS, 'linked-cmd.md'), 'file')

    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/linked-cmd'])
  })

  it('finds a user skill directory as /<name>', () => {
    writeSkill(USER_SKILLS, 'delegate')
    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/delegate'])
  })

  it('finds a project skill directory as /<name>', () => {
    writeSkill(PROJECT_SKILLS, 'verifier-electron')
    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/verifier-electron'])
  })

  it('finds a symlinked skill directory (junction-synced skills)', () => {
    const target = writeSkill(hoisted.TEST_EXTERNAL, 'commit')
    linkDir(target, path.join(USER_SKILLS, 'commit'))

    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/commit'])
  })

  it('ignores a directory under skills/ that has no SKILL.md', () => {
    fs.mkdirSync(path.join(USER_SKILLS, 'not-a-skill'), { recursive: true })
    writeSkill(USER_SKILLS, 'real-skill')

    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/real-skill'])
  })

  it('skips a dangling skill symlink without throwing', () => {
    const target = writeSkill(hoisted.TEST_EXTERNAL, 'gone')
    linkDir(target, path.join(USER_SKILLS, 'gone'))
    fs.rmSync(target, { recursive: true, force: true })
    writeSkill(USER_SKILLS, 'survivor')

    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/survivor'])
  })

  it.skipIf(!CAN_SYMLINK_FILE)('skips a dangling command symlink without throwing', () => {
    const target = writeCommand(hoisted.TEST_EXTERNAL, 'vanished.md')
    fs.mkdirSync(USER_COMMANDS, { recursive: true })
    fs.symlinkSync(target, path.join(USER_COMMANDS, 'vanished.md'), 'file')
    fs.rmSync(target, { force: true })
    writeCommand(USER_COMMANDS, 'still-here.md')

    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/still-here'])
  })

  it('orders sources project commands > user commands > project skills > user skills', () => {
    writeCommand(PROJECT_COMMANDS, 'pc.md')
    writeCommand(USER_COMMANDS, 'uc.md')
    writeSkill(PROJECT_SKILLS, 'ps')
    writeSkill(USER_SKILLS, 'us')

    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/pc', '/uc', '/ps', '/us'])
  })

  it('dedupes a name that exists in several sources, keeping the highest-precedence one', () => {
    writeCommand(PROJECT_COMMANDS, 'dup.md')
    writeCommand(USER_COMMANDS, 'dup.md')
    writeSkill(PROJECT_SKILLS, 'dup')
    writeSkill(USER_SKILLS, 'dup')
    writeSkill(USER_SKILLS, 'unique')

    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/dup', '/unique'])
  })

  it('a skill added after the first scan appears once the 30s cache expires', () => {
    writeSkill(USER_SKILLS, 'first')
    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/first'])

    writeSkill(USER_SKILLS, 'second')
    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/first'])

    _resetCache()
    expect(scanCustomCommands(hoisted.TEST_CWD)).toEqual(['/first', '/second'])
  })
})
