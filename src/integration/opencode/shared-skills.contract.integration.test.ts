/** @vitest-environment node */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { startMcpHttpHost, type McpHttpHost } from '../../core/opencode/mcp-http-host'
import { OpencodeClient } from '../../core/opencode/OpencodeClient'
import { effectiveClaudeSkillCatalog } from '../../core/opencode/effective-claude-skills'
import { expandClaudeSkillInvocation } from '../../core/skills/claude-skills'
import { basic } from './harness/client-feed'
import { describeV2, fixtureConfig, useRig } from './harness/host'

describeV2('OpenCode selected Claude skills native no-model contract', () => {
  let host: McpHttpHost
  beforeAll(async () => {
    host = await startMcpHttpHost(() => new McpServer({ name: 'skills-probe', version: '1' }), {
      skills: (directory) => ({
        skills: [
          {
            name: 'plugin:task',
            description: `for ${directory}`,
            content: `body for ${directory}`,
            path: join(directory, '.claude', 'skills', 'selected', 'SKILL.md'),
            modelInvocable: true
          },
          {
            name: 'plugin:denied',
            description: 'denied by native policy',
            content: 'DENIED_BODY_MUST_NOT_EXPAND',
            path: join(directory, '.claude', 'skills', 'denied', 'SKILL.md'),
            modelInvocable: true
          }
        ],
        sourceRoots: [join(directory, '.claude', 'skills')]
      })
    })
  })
  afterAll(async () => {
    await host?.close()
  })
  const rig = useRig('shared-skills', {
    config: (fixture, home) => {
      const pluginDir = join(home.root, 'claudeui-xeng')
      mkdirSync(pluginDir, { recursive: true })
      copyFileSync(
        resolve('resources/opencode/claudeui-xeng/index.js'),
        join(pluginDir, 'index.js')
      )
      writeFileSync(
        join(pluginDir, 'package.json'),
        JSON.stringify({ type: 'module', main: 'index.js' })
      )
      return {
        ...fixtureConfig(fixture),
        policies: [{ action: 'integration.use', resource: 'skill:plugin:denied', effect: 'deny' }],
        plugins: ['-opencode.config.compatibility', '-opencode.config.skill', pluginDir]
      }
    },
    env: () => ({
      CLAUDEUI_OPENCODE_SKILLS_URL: `http://127.0.0.1:${host.port}/skills`,
      CLAUDEUI_OPENCODE_SKILLS_TOKEN: host.token
    })
  })

  it('installs exact per-directory content and removes a disabled Claude native row', async () => {
    const first = rig().home.workspace('project-one')
    const second = rig().home.workspace('project-two')
    for (const directory of [first, second]) {
      const native = join(directory, '.claude', 'skills', 'disabled')
      mkdirSync(native, { recursive: true })
      writeFileSync(
        join(native, 'SKILL.md'),
        '---\nname: disabled\ndescription: should be off\n---\n\nNative body\n'
      )
      const reactivated = join(directory, '.opencode', 'skills', 'reactivated')
      mkdirSync(reactivated, { recursive: true })
      writeFileSync(
        join(reactivated, 'SKILL.md'),
        '---\nname: reactivated\ndescription: native source\n---\n\nNative body\n'
      )
    }
    const clientFor = (directory: string) =>
      new OpencodeClient({
        baseUrl: rig().server.url,
        authHeader: basic(rig().server.password),
        directory
      })
    const one = await clientFor(first).skills()
    const two = await clientFor(second).skills()
    const selectedOne = one.find((skill) => skill.name === 'plugin:task')
    const selectedTwo = two.find((skill) => skill.name === 'plugin:task')
    expect(selectedOne).toMatchObject({
      content: `body for ${first}`,
      path: join(first, '.claude', 'skills', 'selected', 'SKILL.md')
    })
    expect(selectedTwo).toMatchObject({
      content: `body for ${second}`,
      path: join(second, '.claude', 'skills', 'selected', 'SKILL.md')
    })
    expect(one.map((skill) => skill.name)).not.toContain('disabled')
    expect(two.map((skill) => skill.name)).not.toContain('disabled')
    expect(one.map((skill) => skill.name)).not.toContain('reactivated')
    expect(two.map((skill) => skill.name)).not.toContain('reactivated')
    expect(one.map((skill) => skill.name)).not.toContain('plugin:denied')
    expect(two.map((skill) => skill.name)).not.toContain('plugin:denied')
    const effective = effectiveClaudeSkillCatalog(
      {
        skills: [
          {
            name: 'plugin:denied',
            path: join(first, '.claude', 'skills', 'denied', 'SKILL.md'),
            directory: join(first, '.claude', 'skills', 'denied'),
            description: 'denied by native policy',
            content: 'DENIED_BODY_MUST_NOT_EXPAND',
            source: 'project',
            userInvocable: true,
            modelInvocable: true,
            compatibilityWarnings: []
          }
        ],
        warnings: [],
        revision: ''
      },
      one
    )
    expect(effective.skills).toEqual([])
    expect(expandClaudeSkillInvocation('/plugin:denied', effective)).toBeNull()
  })
})
