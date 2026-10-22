/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locatePiBinary } from '../../core/pi/pi-locate'
import { PiRpcClient } from '../../core/pi/PiRpcClient'
import { PiBridgeHost } from '../../core/pi/PiBridgeHost'
import { PI_BRIDGE_EXTENSION_SOURCE } from '../../core/pi/pi-bridge-source'
import {
  blockedNativeClaudeSkillNames,
  unavailableClaudeSkillCommand
} from '../../core/pi/pi-skill-input'

const enabled = process.env.PI_INTEGRATION_TESTS === '1' && !!locatePiBinary()

describe.skipIf(!enabled)('Pi selected shared skills native no-model contract', () => {
  it('discovers a namespaced selected file and identifies an excluded native command without a model turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-shared-skills-'))
    const project = join(root, 'project')
    // A configured Pi agent directory can overlap a Claude source root.
    const agentDir = join(project, '.claude')
    const home = join(root, 'home')
    const appData = join(home, 'AppData', 'Roaming')
    const localAppData = join(home, 'AppData', 'Local')
    const selectedDir = join(project, '.claude', 'skills', 'selected')
    const excludedDir = join(project, '.claude', 'skills', 'excluded')
    mkdirSync(selectedDir, { recursive: true })
    mkdirSync(excludedDir, { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(appData, { recursive: true })
    mkdirSync(localAppData, { recursive: true })
    mkdirSync(join(project, '.git'))
    const selectedPath = join(selectedDir, 'SKILL.md')
    writeFileSync(
      selectedPath,
      '---\nname: plugin:task\ndescription: selected\n---\n\nSelected body\n'
    )
    writeFileSync(
      join(excludedDir, 'SKILL.md'),
      '---\nname: excluded\ndescription: excluded\n---\n\nExcluded body\n'
    )
    const extensionPath = join(root, 'bridge.ts')
    writeFileSync(extensionPath, PI_BRIDGE_EXTENSION_SOURCE)
    const host = new PiBridgeHost(async () => ({ behavior: 'allow' }), undefined, {
      skills: [
        {
          name: 'plugin:task',
          path: selectedPath,
          directory: selectedDir,
          content: 'Selected body',
          description: 'selected',
          userInvocable: true,
          modelInvocable: true
        }
      ],
      skillSourceRoots: [join(project, '.claude', 'skills')]
    })
    let client: PiRpcClient | undefined
    try {
      const bridge = await host.start()
      client = new PiRpcClient(locatePiBinary()!, {
        cwd: project,
        args: ['--mode', 'rpc', '--no-session', '--offline', '-e', extensionPath],
        env: {
          HOME: home,
          USERPROFILE: home,
          APPDATA: appData,
          LOCALAPPDATA: localAppData,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local', 'share'),
          XDG_CACHE_HOME: join(home, '.cache'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: '1',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          GOOGLE_API_KEY: '',
          GEMINI_API_KEY: '',
          OPENROUTER_API_KEY: '',
          AZURE_OPENAI_API_KEY: '',
          CLAUDEUI_PI_BRIDGE_URL: bridge.url,
          CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
          CLAUDEUI_PI_SKILL_DIRS: ''
        }
      })
      await client.start()
      const response = await client.request<{
        commands: Array<{ name: string; source: 'skill'; sourceInfo?: { path?: string } }>
      }>({
        type: 'get_commands'
      })
      expect(response.success).toBe(true)
      const skillNames =
        response.data?.commands
          .filter((entry) => entry.source === 'skill')
          .map((entry) => entry.name) ?? []
      expect(skillNames).toContain('skill:plugin:task')
      expect(skillNames).toContain('skill:excluded')
      const catalog = {
        skills: [
          {
            name: 'plugin:task',
            path: selectedPath,
            directory: selectedDir,
            content: 'Selected body',
            description: 'selected',
            userInvocable: true,
            modelInvocable: true,
            compatibilityWarnings: [],
            source: 'project' as const
          }
        ],
        sourceRoots: [join(project, '.claude', 'skills')],
        warnings: [],
        revision: ''
      }
      const blocked = blockedNativeClaudeSkillNames(response.data!.commands, catalog)
      expect([...blocked]).toEqual(['excluded'])
      expect(unavailableClaudeSkillCommand('/skill:excluded run', catalog, blocked, true)).toBe(
        'excluded'
      )
      expect(
        unavailableClaudeSkillCommand('/skill:plugin:task run', catalog, blocked, true)
      ).toBeNull()
      // The host rejects excluded before Pi's native pre-model expansion. No model call is made.
    } finally {
      if (client) {
        const exited = new Promise<void>((resolve) => client!.onExit(() => resolve()))
        client.dispose()
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
      }
      host.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
