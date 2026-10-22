/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  expandClaudeSkillInvocation,
  renderClaudeSkillCatalog,
  resolveClaudeSkills
} from '../claude-skills'

let base: string
let home: string
let project: string
let config: string

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function skill(root: string, name: string, description: string, extra = '', body = 'Body'): string {
  const file = path.join(root, name, 'SKILL.md')
  write(file, `---\ndescription: ${description}\n${extra}---\n${body}`)
  return file
}

function resolve(cwd = project) {
  return resolveClaudeSkills(cwd, { homeDir: home, configDir: config })
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-skills-'))
  home = path.join(base, 'home')
  config = path.join(home, '.claude')
  project = path.join(base, 'project')
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
})
afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

describe('resolveClaudeSkills', () => {
  it('keeps personal over project and nearest nested project over root, excluding siblings', () => {
    skill(path.join(config, 'skills'), 'same', 'personal')
    skill(path.join(project, '.claude', 'skills'), 'same', 'root')
    skill(path.join(project, '.claude', 'skills'), 'nested', 'root nested')
    const cwd = path.join(project, 'apps', 'web')
    skill(path.join(cwd, '.claude', 'skills'), 'nested', 'near nested')
    skill(path.join(project, 'apps', 'other', '.claude', 'skills'), 'sibling', 'sibling')
    const catalog = resolve(cwd)
    expect(catalog.sourceRoots).toContain(path.join(config, 'skills'))
    expect(catalog.sourceRoots).toContain(path.join(cwd, '.claude', 'skills'))
    expect(catalog.skills.map((entry) => [entry.name, entry.description])).toEqual([
      ['same', 'personal'],
      ['nested', 'near nested']
    ])
    expect(resolve(cwd).revision).toBe(catalog.revision)
    write(
      path.join(cwd, '.claude', 'skills', 'nested', 'SKILL.md'),
      '---\ndescription: changed\n---\nBody'
    )
    expect(resolve(cwd).revision).not.toBe(catalog.revision)
  })

  it('stops at a worktree git file and uses only its main checkout fallback', () => {
    const main = path.join(base, 'main')
    const gitDir = path.join(main, '.git', 'worktrees', 'one')
    fs.mkdirSync(gitDir, { recursive: true })
    write(path.join(gitDir, 'commondir'), '../..')
    skill(path.join(main, '.claude', 'skills'), 'main', 'main')
    const worktree = path.join(base, 'outer', 'worktree')
    write(path.join(worktree, '.git'), `gitdir: ${gitDir}`)
    skill(path.join(base, 'outer', '.claude', 'skills'), 'outside', 'outside')
    expect(resolve(path.join(worktree, 'nested')).skills.map((entry) => entry.name)).toEqual([
      'main'
    ])
    expect(resolve(path.join(worktree, 'nested')).sourceRoots).toContain(
      path.join(main, '.claude', 'skills')
    )
    skill(path.join(worktree, '.claude', 'skills'), 'worktree', 'worktree')
    expect(resolve(path.join(worktree, 'nested')).skills.map((entry) => entry.name)).toEqual([
      'worktree'
    ])
    expect(resolve(path.join(worktree, 'nested')).sourceRoots).not.toContain(
      path.join(main, '.claude', 'skills')
    )
  })

  it('keeps a symlink resource path and deduplicates its real path', () => {
    const target = skill(path.join(base, 'targets'), 'linked', 'linked')
    const link = path.join(config, 'skills', 'linked')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(path.dirname(target), link, process.platform === 'win32' ? 'junction' : 'dir')
    const alias = path.join(config, 'skills', 'alias')
    fs.symlinkSync(path.dirname(target), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const catalog = resolve()
    expect(catalog.skills).toHaveLength(1)
    expect([link, alias]).toContain(catalog.skills[0].directory)
  })

  it('uses only enabled, applicable plugin installs and custom skill roots', () => {
    const enabled = path.join(base, 'plugin-enabled')
    const disabled = path.join(base, 'plugin-disabled')
    skill(path.join(enabled, 'custom'), 'task', 'plugin task')
    skill(path.join(enabled, 'skills'), 'default', 'default plugin task')
    write(
      path.join(enabled, 'direct', 'SKILL.md'),
      '---\nname: renamed\ndescription: direct\n---\nDirect body'
    )
    skill(path.join(disabled, 'skills'), 'hidden', 'hidden')
    write(
      path.join(enabled, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ skills: ['./custom', './direct'] })
    )
    write(
      path.join(config, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'good@market': [{ installPath: enabled, scope: 'project', projectPath: project }],
          'bad@market': [{ installPath: disabled, scope: 'user' }],
          'wrong@market': [
            { installPath: disabled, scope: 'project', projectPath: path.join(base, 'other') }
          ]
        }
      })
    )
    write(
      path.join(config, 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'good@market': true, 'bad@market': false, 'wrong@market': true }
      })
    )
    expect(resolve().skills.map((entry) => entry.name)).toEqual([
      'good:task',
      'good:renamed',
      'good:default'
    ])
    expect(resolve().skills.find((entry) => entry.name === 'good:renamed')?.aliases).toEqual([
      'good:direct'
    ])
    expect(resolve().sourceRoots).toContain(path.join(enabled, 'direct'))
    expect(expandClaudeSkillInvocation('/good:direct', resolve())?.skill.name).toBe('good:renamed')
  })

  it('selects the most specific applicable installation of one plugin key', () => {
    const userInstall = path.join(base, 'user-plugin')
    const projectInstall = path.join(base, 'project-plugin')
    const localInstall = path.join(base, 'local-plugin')
    skill(path.join(userInstall, 'skills'), 'task', 'user plugin')
    skill(path.join(projectInstall, 'skills'), 'task', 'project plugin')
    skill(path.join(localInstall, 'skills'), 'task', 'local plugin')
    write(
      path.join(config, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'same@market': [
            { installPath: userInstall, scope: 'user' },
            { installPath: projectInstall, scope: 'project', projectPath: project },
            { installPath: localInstall, scope: 'local', projectPath: project }
          ]
        }
      })
    )
    write(
      path.join(config, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'same@market': true } })
    )
    expect(resolve().skills.map((entry) => entry.description)).toEqual(['local plugin'])
  })

  it('uses frontmatter command names and keeps primary names ahead of folder aliases', () => {
    skill(path.join(config, 'skills'), 'folder', 'renamed', 'name: renamed\n')
    skill(path.join(project, '.claude', 'skills'), 'folder', 'project folder')
    const catalog = resolve()
    expect(catalog.skills.map((entry) => entry.name)).toEqual(['renamed', 'folder'])
    expect(expandClaudeSkillInvocation('/folder', catalog)?.skill.source).toBe('project')
    expect(expandClaudeSkillInvocation('/renamed', catalog)?.skill.source).toBe('user')
  })

  it('loads a plugin root SKILL.md when no default or custom skills exist', () => {
    const install = path.join(base, 'root-plugin')
    write(path.join(install, 'SKILL.md'), '---\ndescription: root skill\n---\nRoot body')
    write(
      path.join(config, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'root@market': [{ installPath: install, scope: 'user' }]
        }
      })
    )
    write(
      path.join(config, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'root@market': true } })
    )
    expect(resolve().skills.map((entry) => entry.name)).toEqual(['root:root-plugin'])
    expect(resolve().sourceRoots).toContain(install)
  })

  it('honors overrides and invocation flags and rejects YAML aliases', () => {
    skill(path.join(config, 'skills'), 'manual', 'manual', 'disable-model-invocation: true\n')
    skill(
      path.join(config, 'skills'),
      'manualalias',
      'manual alias',
      'name: renamed-manual\ndisable-model-invocation: true\n'
    )
    skill(path.join(config, 'skills'), 'model', 'model', 'user-invocable: false\n')
    skill(path.join(config, 'skills'), 'off', 'off')
    skill(path.join(config, 'skills'), 'nameonly', 'verbose description')
    skill(path.join(config, 'skills'), 'useronly', 'user only')
    write(
      path.join(config, 'skills', 'quoted', 'SKILL.md'),
      '---\ndescription: "Use *keyword* literally"\n---\nQuoted body'
    )
    write(
      path.join(config, 'skills', 'bad', 'SKILL.md'),
      '---\ndescription: &alias bad\nname: *alias\n---\nBad'
    )
    write(
      path.join(config, 'settings.json'),
      JSON.stringify({
        skillOverrides: {
          off: 'off',
          nameonly: 'name-only',
          useronly: 'user-invocable-only'
        }
      })
    )
    const catalog = resolve()
    expect(catalog.skills.map((entry) => entry.name)).toEqual([
      'manual',
      'renamed-manual',
      'model',
      'nameonly',
      'quoted',
      'useronly'
    ])
    expect(catalog.skills.find((entry) => entry.name === 'quoted')?.description).toBe(
      'Use *keyword* literally'
    )
    expect(catalog.skills.find((entry) => entry.name === 'nameonly')?.description).toBe('')
    expect(catalog.skills.find((entry) => entry.name === 'useronly')?.modelInvocable).toBe(false)
    expect(catalog.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('malformed skill frontmatter')])
    )
    expect(renderClaudeSkillCatalog(catalog)).toContain('name="model"')
    expect(renderClaudeSkillCatalog(catalog)).toContain('<manual-only-skill name="manual" />')
    expect(renderClaudeSkillCatalog(catalog)).toContain(
      '<manual-only-skill name="renamed-manual" aliases="manualalias" />'
    )
    expect(renderClaudeSkillCatalog(catalog)).not.toContain('<skill name="manual"')
    expect(renderClaudeSkillCatalog(catalog)).toContain(
      'later shared_claude_skills_update replaces'
    )
    expect(expandClaudeSkillInvocation('/model', catalog)).toBeNull()
    expect(expandClaudeSkillInvocation('/manual', catalog)?.skill.name).toBe('manual')
  })
})

describe('expandClaudeSkillInvocation', () => {
  it('does not fall back to an alias when the primary name is model-only', () => {
    skill(path.join(config, 'skills'), 'model-only', 'alias body', 'name: renamed\n')
    skill(
      path.join(project, '.claude', 'skills'),
      'model-only',
      'primary body',
      'user-invocable: false\n'
    )
    const catalog = resolve()
    for (const prefix of ['/', '/skill:', '$']) {
      expect(expandClaudeSkillInvocation(`${prefix}model-only`, catalog)).toBeNull()
    }
  })

  it('substitutes arguments once, preserves literals, and leaves unrelated commands alone', () => {
    skill(
      path.join(config, 'skills'),
      'echo',
      'echo',
      'allowed-tools: Bash\n',
      'Input: $ARGUMENTS; first: $ARGUMENTS[0]; second: $ARGUMENTS[1]; short: $0'
    )
    const catalog = resolve()
    const result = expandClaudeSkillInvocation('/skill:echo "a b" "$ARGUMENTS"', catalog)
    expect(result?.text).toContain('first: a b; second: $ARGUMENTS')
    expect(result?.text).toContain('short: a b')
    expect(result?.text).toContain('Compatibility: allowed-tools')
    expect(result?.text).toContain(catalog.skills[0].directory)
    expect(expandClaudeSkillInvocation('/echoes', catalog)).toBeNull()
    expect(expandClaudeSkillInvocation('/compact', catalog)).toBeNull()
    expect(expandClaudeSkillInvocation('$echo ""', catalog)?.text).toContain('first: ;')
    expect(expandClaudeSkillInvocation('/echo "unterminated', catalog)).toBeNull()
  })

  it('appends input without placeholders and escapes catalog metadata', () => {
    skill(path.join(config, 'skills'), 'plain', 'A <tag> & value')
    const catalog = resolve()
    expect(renderClaudeSkillCatalog(catalog)).toContain('A &lt;tag&gt; &amp; value')
    expect(expandClaudeSkillInvocation('/plain user text', catalog)?.text).toContain(
      'User input: user text'
    )
  })
})
