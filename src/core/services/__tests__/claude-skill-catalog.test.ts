/**
 * @vitest-environment node
 *
 * The skill catalog against real directories: a throwaway CLAUDE_CONFIG_DIR and home, a test
 * managed dir (the managed-dir lookups are redirected into the temp tree) and, for the worktree
 * case, a real `git init` repo with a linked worktree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const managedRef = vi.hoisted(() => ({ dir: '' }))
vi.mock('../claude-config-paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../claude-config-paths')>()
  return {
    ...orig,
    claudeManagedDir: () => managedRef.dir,
    readClaudeSettingsLayers: (cwd: string, opts: Record<string, unknown> = {}) =>
      orig.readClaudeSettingsLayers(cwd, { ...opts, managedDir: managedRef.dir })
  }
})

import { resolveClaudeSkillCatalog, type ClaudeSkillCatalog } from '../claude-skill-catalog'

let root: string
let cfg: string
let home: string
let managed: string
let repo: string
let env: Record<string, string>

const write = (file: string, data: string | object): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
}
const md = (fm: Record<string, unknown> | null, body = 'Body text'): string =>
  fm === null
    ? body
    : `---\n${Object.entries(fm)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')}\n---\n${body}`
const skill = (
  base: string,
  name: string,
  fm: Record<string, unknown> | null = { description: `d-${name}` },
  body?: string
): void => write(path.join(base, name, 'SKILL.md'), md(fm, body))
const posixOnly = it.skipIf(process.platform === 'win32') // dir symlinks / `<` `:` in names
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    stdio: 'ignore'
  })
}

const resolve = (cwd = repo): ClaudeSkillCatalog =>
  resolveClaudeSkillCatalog(cwd, { env, homeDir: home })
const names = (c: ClaudeSkillCatalog = resolve()): string[] => c.entries.map((e) => e.name)
const entry = (name: string, c: ClaudeSkillCatalog = resolve()) =>
  c.entries.find((e) => e.name === name)

const userSkills = (): string => path.join(cfg, 'skills')
const projSkills = (dir = repo): string => path.join(dir, '.claude', 'skills')

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-')))
  cfg = path.join(root, 'cfg')
  home = path.join(root, 'home')
  managed = path.join(root, 'managed')
  repo = path.join(root, 'home', 'work', 'repo')
  managedRef.dir = managed
  fs.mkdirSync(cfg, { recursive: true })
  fs.mkdirSync(repo, { recursive: true })
  fs.mkdirSync(path.join(repo, '.git')) // a git root for the walk; real git only where needed
  env = { CLAUDE_CONFIG_DIR: cfg, HOME: home }
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('sources and precedence', () => {
  it('orders managed, user, project, then commands, and the first name wins', () => {
    skill(path.join(managed, '.claude', 'skills'), 'dup', { description: 'managed' })
    skill(userSkills(), 'dup', { description: 'user' })
    skill(userSkills(), 'u-only')
    skill(projSkills(), 'dup', { description: 'project' })
    skill(projSkills(), 'p-only')
    write(path.join(userSkills(), '..', 'commands', 'dup.md'), 'cmd')
    write(path.join(repo, '.claude', 'commands', 'c1.md'), 'cmd')
    const c = resolve()
    expect(names(c)).toEqual(['dup', 'u-only', 'p-only', 'c1'])
    expect(entry('dup', c)).toMatchObject({ source: 'managed', description: 'managed' })
    expect(c.skipped.some((s) => s.name === 'dup')).toBe(true)
  })

  posixOnly(
    'sorts a directory by localeCompare, follows symlinks, does not skip hidden dirs, ignores loose files',
    () => {
      skill(userSkills(), 'b')
      skill(userSkills(), 'a')
      skill(userSkills(), '.hidden')
      write(path.join(userSkills(), 'loose.md'), 'x')
      write(path.join(userSkills(), 'deep', 'nested', 'SKILL.md'), md({ description: 'x' }))
      skill(path.join(root, 'elsewhere'), 'linked')
      fs.symlinkSync(
        path.join(root, 'elsewhere', 'linked'),
        path.join(userSkills(), 'linked'),
        'dir'
      )
      expect(names()).toEqual(['.hidden', 'a', 'b', 'linked'].sort((x, y) => x.localeCompare(y)))
    }
  )

  it('skips a dir named synced in the user skills only', () => {
    skill(userSkills(), 'synced')
    skill(userSkills(), 'real')
    skill(projSkills(), 'synced')
    expect(names()).toEqual(['real', 'synced'])
    expect(entry('synced')?.source).toBe('project')
  })

  posixOnly('counts a file reached twice by realpath once', () => {
    skill(userSkills(), 'orig')
    fs.symlinkSync(path.join(userSkills(), 'orig'), path.join(userSkills(), 'alias'), 'dir')
    expect(names()).toEqual(['alias'])
  })

  it('refuses a SKILL.md over 1 MB and records it', () => {
    skill(userSkills(), 'big', { description: 'x' }, 'a'.repeat(1_000_001))
    skill(userSkills(), 'ok')
    const c = resolve()
    expect(names(c)).toEqual(['ok'])
    expect(c.skipped).toContainEqual(expect.objectContaining({ name: 'big' }))
  })

  it('never throws on a missing config dir or cwd', () => {
    const c = resolveClaudeSkillCatalog(path.join(root, 'nope'), {
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'nocfg') },
      homeDir: home
    })
    expect(c.entries).toEqual([])
  })
})

describe('the project walk', () => {
  it('walks from the cwd to the git root, closest first, and stops there', () => {
    skill(path.join(root, 'home', 'work', '.claude', 'skills'), 'above-git')
    skill(projSkills(), 'at-root')
    const sub = path.join(repo, 'pkg', 'app')
    skill(projSkills(path.join(repo, 'pkg')), 'mid')
    skill(projSkills(sub), 'near')
    expect(names(resolve(sub))).toEqual(['near', 'mid', 'at-root'])
  })

  it('continues to the filesystem root outside git but never includes $HOME', () => {
    fs.rmSync(path.join(repo, '.git'), { recursive: true })
    skill(projSkills(home), 'home-skill')
    skill(path.join(home, 'work', '.claude', 'skills'), 'work-skill')
    skill(projSkills(), 'repo-skill')
    expect(names()).toEqual(['repo-skill', 'work-skill'])
  })

  it('uses the main checkout only when the linked worktree has none', () => {
    fs.rmSync(path.join(repo, '.git'), { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'i')
    const wt = path.join(home, 'work', 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch')
    skill(projSkills(), 'main-skill')
    expect(names(resolve(wt))).toEqual(['main-skill'])
    skill(projSkills(wt), 'wt-skill')
    expect(names(resolve(wt))).toEqual(['wt-skill'])
  }, 30_000)
})

describe('legacy commands', () => {
  it('names nested files with ":" and ignores non-.md and the frontmatter name', () => {
    const cmds = path.join(repo, '.claude', 'commands')
    write(path.join(cmds, 'top.md'), md({ name: 'ignored', description: 'T' }))
    write(path.join(cmds, 'a', 'b.md'), 'x')
    write(path.join(cmds, 'a', 'c', 'd.md'), 'x')
    write(path.join(cmds, 'notes.txt'), 'x')
    write(path.join(cmds, 'UP.MD'), 'x')
    const c = resolve()
    expect(names(c)).toEqual(['a:b', 'a:c:d', 'top'])
    expect(entry('top', c)).toMatchObject({ kind: 'command', source: 'project', description: 'T' })
    expect(entry('top', c)?.displayName).toBeUndefined()
  })

  it('a directory holding SKILL.md (any case) contributes only that file', () => {
    const cmds = path.join(cfg, 'commands')
    write(path.join(cmds, 'a', 'foo', 'skill.md'), md({ description: 'S' }))
    write(path.join(cmds, 'a', 'foo', 'extra.md'), 'x')
    write(path.join(cmds, 'a', 'foo', 'bar', 'deep.md'), 'x')
    const c = resolve()
    expect(names(c)).toEqual(['a:foo'])
    expect(entry('a:foo', c)?.baseDir).toBe(path.join(cmds, 'a', 'foo'))
  })

  posixOnly('survives a symlink cycle', () => {
    const cmds = path.join(cfg, 'commands')
    write(path.join(cmds, 'x', 'one.md'), 'x')
    fs.symlinkSync(cmds, path.join(cmds, 'x', 'loop'), 'dir')
    expect(names()).toContain('x:one')
  })

  it('gives the default label to a command with no description', () => {
    write(path.join(cfg, 'commands', 'plain.md'), '\n\n')
    expect(entry('plain')?.description).toBe('Custom command')
  })
})

describe('frontmatter', () => {
  it('falls back to the first body line: heading stripped, long lines cut to 97 + ...', () => {
    skill(userSkills(), 'h', null, '\n# The Title\nmore')
    skill(userSkills(), 'long', null, 'x'.repeat(150))
    const c = resolve()
    expect(entry('h', c)?.description).toBe('The Title')
    expect(entry('long', c)?.description).toBe(`${'x'.repeat(97)}...`)
  })

  it('stringifies a numeric or boolean description', () => {
    skill(userSkills(), 'n', { description: 42 })
    skill(userSkills(), 'b', { description: true })
    const c = resolve()
    expect([entry('n', c)?.description, entry('b', c)?.description]).toEqual(['42', 'true'])
  })

  it('retries bad YAML after quoting simple values, and falls back to {} with the body loaded', () => {
    write(
      path.join(userSkills(), 'q', 'SKILL.md'),
      '---\ndescription: Use for: things {and} more\nname: Q\n---\nbody'
    )
    write(path.join(userSkills(), 'broken', 'SKILL.md'), '---\n: : [\n  - {\n---\nfirst line')
    const c = resolve()
    expect(entry('q', c)).toMatchObject({
      description: 'Use for: things {and} more',
      displayName: 'Q'
    })
    expect(entry('broken', c)).toMatchObject({ description: 'first line', body: 'first line' })
  })

  it('strips a BOM and parses the optional fields', () => {
    write(
      path.join(userSkills(), 's', 'SKILL.md'),
      '﻿' +
        md({
          name: 'Pretty',
          description: ' spaced ',
          when_to_use: 'when',
          'argument-hint': '"[x]"',
          arguments: 'one two 3'
        })
    )
    expect(entry('s')).toMatchObject({
      displayName: 'Pretty',
      description: 'spaced',
      whenToUse: 'when',
      argumentHint: '[x]',
      argumentNames: ['one', 'two']
    })
  })

  it('records Claude-only keys and shell interpolation', () => {
    skill(
      userSkills(),
      'c',
      {
        description: 'd',
        context: 'fork',
        model: 'opus',
        'allowed-tools': ['Read'],
        effort: 'high'
      },
      'run !`ls` now'
    )
    skill(userSkills(), 'ctx', { description: 'd', context: 'inline' }, '```!\nls\n```')
    skill(userSkills(), 'mid', { description: 'd' }, 'not!`x` inline')
    const c = resolve()
    expect(entry('c', c)?.claudeOnly).toEqual([
      'context',
      'allowed-tools',
      'model',
      'effort',
      'shell-interpolation'
    ])
    expect(entry('ctx', c)?.claudeOnly).toEqual(['shell-interpolation'])
    expect(entry('mid', c)?.claudeOnly).toEqual([])
  })

  it('skips a conditional `paths` skill but loads an all-** one, and ignores paths for commands', () => {
    skill(userSkills(), 'cond', { description: 'd', paths: ['src/**/*.ts'] })
    skill(userSkills(), 'all', { description: 'd', paths: ['**'] })
    write(path.join(cfg, 'commands', 'cmd.md'), md({ paths: ['src/**'] }))
    const c = resolve()
    expect(names(c)).toEqual(['all', 'cmd'])
    expect(c.skipped).toContainEqual({
      name: 'cond',
      reason: 'conditional skill (activates when matching files are touched)'
    })
  })

  posixOnly('refuses invalid names', () => {
    skill(userSkills(), 'a<b')
    skill(userSkills(), 'anthropic-skills:x')
    skill(userSkills(), 'fine')
    expect(names()).toEqual(['fine'])
  })
})

describe('listing eligibility and overrides', () => {
  it('derives userInvocable / modelInvocable from the frontmatter', () => {
    skill(userSkills(), 'normal')
    skill(userSkills(), 'hidden', { description: 'd', 'disable-model-invocation': true })
    skill(userSkills(), 'noui', { description: 'd', 'user-invocable': false })
    const c = resolve()
    expect(entry('normal', c)).toMatchObject({ userInvocable: true, modelInvocable: true })
    expect(entry('hidden', c)).toMatchObject({ userInvocable: true, modelInvocable: false })
    expect(entry('noui', c)).toMatchObject({ userInvocable: false, modelInvocable: true })
  })

  const overrides = (user: object, policy?: object): void => {
    const file = path.join(cfg, 'settings.json')
    const prev = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')) as object) : {}
    write(file, { ...prev, skillOverrides: user })
    if (policy) write(path.join(managed, 'managed-settings.json'), { skillOverrides: policy })
  }

  it('applies each override value by the full name only', () => {
    skill(userSkills(), 'off-s')
    skill(userSkills(), 'name-s', { description: 'desc', when_to_use: 'w' })
    skill(userSkills(), 'ui-s')
    skill(userSkills(), 'on-s')
    write(path.join(cfg, 'commands', 'ns', 'cmd.md'), 'cmd body')
    write(path.join(cfg, 'commands', 'other', 'keep.md'), 'keep body')
    overrides({
      'off-s': 'off',
      'name-s': 'name-only',
      'ui-s': 'user-invocable-only',
      'on-s': 'on',
      'ns:cmd': 'off',
      // the part after the last `:` is not a key (cli.js has no unqualified name for it)
      keep: 'off'
    })
    const c = resolve()
    expect(names(c)).toEqual(['name-s', 'on-s', 'ui-s', 'other:keep'])
    expect(entry('name-s', c)).toMatchObject({ description: '', modelInvocable: true })
    expect(entry('ui-s', c)).toMatchObject({ modelInvocable: false, userInvocable: true })
    expect(c.skipped).toContainEqual({ name: 'off-s', reason: 'skillOverrides: off' })
    expect(c.skipped).toContainEqual({ name: 'ns:cmd', reason: 'skillOverrides: off' })
  })

  it('takes the higher of the merged value and the policy layer value', () => {
    skill(userSkills(), 'a')
    skill(userSkills(), 'b')
    skill(userSkills(), 'c')
    overrides(
      { a: 'on', b: 'off', c: 'name-only' },
      { a: 'off', b: 'name-only', c: 'user-invocable-only' }
    )
    const c = resolve()
    // a: policy off; b: the policy value replaces the user's in the merge, so name-only; c: raised
    expect(names(c)).toEqual(['b', 'c'])
    expect(entry('b', c)?.description).toBe('')
    expect(entry('c', c)).toMatchObject({ modelInvocable: false, userInvocable: true })
  })

  it('does not apply overrides to plugin entries', () => {
    plugin({ files: { 'skills/p/SKILL.md': md({ description: 'd' }) } })
    overrides({ 'fake:p': 'off', p: 'off' })
    expect(names()).toEqual(['fake:p'])
  })
})

describe('strictPluginOnlyCustomization', () => {
  const policy = (v: unknown): void =>
    write(path.join(managed, 'managed-settings.json'), { strictPluginOnlyCustomization: v })
  const seed = (): void => {
    skill(path.join(managed, '.claude', 'skills'), 'mgd')
    skill(userSkills(), 'usr')
    skill(projSkills(), 'prj')
    write(path.join(repo, '.claude', 'commands', 'cmd.md'), 'x')
    plugin({ files: { 'skills/p/SKILL.md': md({ description: 'd' }) } })
  }

  it('keeps managed skills and plugins, drops user, project and commands', () => {
    seed()
    policy(true)
    expect(names()).toEqual(['mgd', 'fake:p'])
    policy(['skills'])
    expect(names()).toEqual(['mgd', 'fake:p'])
  })

  it('leaves everything when the list does not name skills', () => {
    seed()
    policy(['hooks'])
    expect(names()).toEqual(['mgd', 'usr', 'prj', 'cmd', 'fake:p'])
  })

  it('CLAUDE_CODE_DISABLE_POLICY_SKILLS turns the managed skills off', () => {
    seed()
    env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1'
    expect(names()).not.toContain('mgd')
  })
})

describe('plugins', () => {
  it('loads the default skills dir, manifest paths, sanitised names and frontmatter aliases', () => {
    plugin({
      manifest: { skills: ['./extra', './single'] },
      files: {
        'skills/a b/SKILL.md': md({ name: 'bare', description: 'user desc' }),
        'skills/ignored.md': 'x',
        'extra/one/SKILL.md': md({ description: 'x' }),
        'extra/two/SKILL.md': md(null, 'no description'),
        'single/SKILL.md': md({ description: 'x' })
      }
    })
    const c = resolve()
    expect(names(c)).toEqual(['fake:a-b', 'fake:one', 'fake:two', 'fake:single'])
    expect(entry('fake:a-b', c)).toMatchObject({
      kind: 'skill',
      source: 'plugin',
      pluginId: 'fake@fakemkt',
      pluginName: 'fake',
      aliases: ['bare'],
      modelInvocable: true
    })
    expect(entry('fake:a-b', c)?.pluginRoot).toBe(pluginRoot)
    // a plugin skill without a user-written description or when_to_use is not model-listed
    expect(entry('fake:two', c)).toMatchObject({
      description: 'no description',
      modelInvocable: false
    })
  })

  it('a root SKILL.md makes a single-skill plugin only without skills/ and manifest skills', () => {
    plugin({ files: { 'SKILL.md': md({ name: 'fake:rooty', description: 'd' }) } })
    expect(names()).toEqual(['fake:rooty'])
    plugin({
      files: { 'SKILL.md': md({ description: 'd' }), 'skills/s/SKILL.md': md({ description: 'd' }) }
    })
    expect(names()).toEqual(['fake:s'])
  })

  it('refuses plugin paths that escape the root', () => {
    plugin({
      manifest: { skills: '../outside', commands: ['../outside'] },
      files: { 'skills/s/SKILL.md': md({ description: 'd' }) }
    })
    skill(path.join(pluginRoot, '..'), 'outside')
    const c = resolve()
    expect(names(c)).toEqual(['fake:s'])
    expect(c.skipped.filter((s) => /escapes/.test(s.reason))).toHaveLength(2)
  })

  it('loads default commands (recursive, case-insensitive .md) only without manifest commands', () => {
    plugin({
      files: {
        'commands/top.md': 'x',
        'commands/ns/deep/inner.MD': 'x',
        'commands/skilldir/SKILL.md': 'x',
        'commands/skilldir/other.md': 'x',
        'other/custom.md': 'x'
      }
    })
    expect(names()).toEqual(['fake:ns:deep:inner', 'fake:top'])
    plugin({
      manifest: { commands: './other' },
      files: { 'commands/top.md': 'x', 'other/custom.md': 'x' }
    })
    expect(names()).toEqual(['fake:custom'])
    plugin({
      manifest: { commands: { renamed: { source: './other/custom.md' } } },
      files: { 'commands/top.md': 'x', 'other/custom.md': 'x' }
    })
    expect(names()).toEqual(['fake:renamed'])
  })

  posixOnly('does not follow links below the plugin root for commands', () => {
    plugin({ files: { 'commands/a.md': 'x' } })
    write(path.join(root, 'outside', 'b.md'), 'x')
    fs.symlinkSync(path.join(root, 'outside'), path.join(pluginRoot, 'commands', 'link'), 'dir')
    expect(names()).toEqual(['fake:a'])
  })

  it('orders plugin commands before plugin skills, after every directory source', () => {
    skill(userSkills(), 'u')
    plugin({ files: { 'commands/c.md': 'x', 'skills/s/SKILL.md': md({ description: 'd' }) } })
    expect(names()).toEqual(['u', 'fake:c', 'fake:s'])
  })

  posixOnly('drops a plugin skill whose realpath is already loaded', () => {
    plugin({ files: { 'skills/s/SKILL.md': md({ description: 'd' }) } })
    fs.mkdirSync(userSkills(), { recursive: true })
    fs.symlinkSync(path.join(pluginRoot, 'skills', 's'), path.join(userSkills(), 'same'), 'dir')
    expect(names()).toEqual(['same'])
  })

  it('a disabled plugin contributes nothing', () => {
    plugin({
      files: { 'skills/s/SKILL.md': md({ description: 'd' }), 'commands/c.md': 'x' },
      enabled: false
    })
    expect(names()).toEqual([])
  })

  it('fills plugin variables into the body and leaves a sensitive option as written', () => {
    plugin({
      manifest: { userConfig: { region: { default: 'eu' }, token: { sensitive: true } } },
      files: {
        'skills/s/SKILL.md': md(
          { description: 'd' },
          'root ${CLAUDE_PLUGIN_ROOT} proj ${CLAUDE_PROJECT_DIR} r=${user_config.region} t=${user_config.token}'
        )
      }
    })
    const body = entry('fake:s')?.body
    expect(body).toBe(`root ${pluginRoot} proj ${repo} r=eu t=\${user_config.token}`)
  })
})

// ---------------------------------------------------------------------------
// A directory marketplace `fakemkt` holding one in-place plugin `fake`.
// ---------------------------------------------------------------------------
let pluginRoot: string
function plugin(opts: {
  manifest?: Record<string, unknown>
  files?: Record<string, string>
  enabled?: boolean
}): void {
  const mkt = path.join(root, 'mkt')
  pluginRoot = path.join(mkt, 'plugins', 'fake')
  fs.rmSync(pluginRoot, { recursive: true, force: true })
  write(path.join(mkt, '.claude-plugin', 'marketplace.json'), {
    name: 'fakemkt',
    owner: { name: 'probe' },
    plugins: [{ name: 'fake', source: './plugins/fake', version: '1.0.0' }]
  })
  write(path.join(cfg, 'plugins', 'known_marketplaces.json'), {
    fakemkt: { source: { source: 'directory', path: mkt }, installLocation: mkt }
  })
  write(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), { name: 'fake', ...opts.manifest })
  for (const [rel, content] of Object.entries(opts.files ?? {}))
    write(path.join(pluginRoot, rel), content)
  const settingsFile = path.join(cfg, 'settings.json')
  const prev = fs.existsSync(settingsFile)
    ? (JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>)
    : {}
  write(settingsFile, { ...prev, enabledPlugins: { 'fake@fakemkt': opts.enabled ?? true } })
}
