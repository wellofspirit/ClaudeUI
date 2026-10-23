/** Real RPC guard for pi 1.4.0 transcript tool restoration; no provider call. */
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locatePiLaunch } from '../../core/pi/pi-locate'
import { PiRpcClient } from '../../core/pi/PiRpcClient'
import { PiBridgeHost, writeBridgeExtension } from '../../core/pi/PiBridgeHost'
import { piSessionToolsEnv } from '../../core/services/session-tool-specs'

const launch = locatePiLaunch()

describe.skipIf(!process.env.PI_INTEGRATION_TESTS || !launch)('pi resumed tool loadout', () => {
  it.each([false, true])(
    'adds new bridge tools, preserves removals, and toggles plan tools (compacted=%s)',
    async (compacted) => {
      const dir = mkdtempSync(join(tmpdir(), 'pi-resume-tools-'))
      const agentDir = join(dir, 'agent')
      mkdirSync(agentDir)
      const session = join(dir, 'session.jsonl')
      const timestamp = new Date().toISOString()
      const refs = (names: string[]) =>
        names.map((name) => ({
          name,
          description: name,
          parameters: { type: 'object', properties: {} }
        }))
      const entry = (id: string, parentId: string | null, extra: Record<string, unknown>) => ({
        id,
        parentId,
        timestamp,
        ...extra
      })
      writeFileSync(
        session,
        [
          {
            type: 'session',
            version: 3,
            id: '11111111-1111-4111-8111-111111111111',
            timestamp,
            cwd: dir
          },
          entry('loadout1', null, {
            type: 'message',
            message: {
              role: 'system',
              content: '',
              toolsAdded: refs(['read', 'write', 'session_stop']),
              timestamp: Date.now()
            }
          }),
          entry('loadout2', 'loadout1', {
            type: 'message',
            message: {
              role: 'system',
              content: '',
              toolsRemoved: refs(['session_stop']),
              timestamp: Date.now()
            }
          }),
          entry('user0001', 'loadout2', {
            type: 'message',
            message: { role: 'user', content: 'Earlier turn', timestamp: Date.now() }
          }),
          ...(compacted
            ? [
                entry('compact1', 'user0001', {
                  type: 'compaction',
                  summary: 'Earlier work summarized',
                  firstKeptEntryId: 'user0001',
                  tokensBefore: 1000
                })
              ]
            : [])
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n'
      )
      const inspectPath = join(dir, 'inspect.ts')
      writeFileSync(
        inspectPath,
        `export default function(pi) {
      pi.registerCommand('inspect-loadout', { handler: async () => {
        pi.sendMessage({ customType: 'loadout', content: JSON.stringify(pi.getActiveTools()), display: false });
      }});
    }`
      )
      const host = new PiBridgeHost(async () => ({ behavior: 'allow' }))
      const bridge = await host.start()
      const client = new PiRpcClient(launch!, {
        cwd: dir,
        args: [
          '--mode',
          'rpc',
          '--session',
          session,
          '-e',
          writeBridgeExtension(),
          '-e',
          inspectPath
        ],
        env: {
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: '1',
          PI_TELEMETRY: '0',
          PI_SKIP_VERSION_CHECK: '1',
          CLAUDEUI_PI_BRIDGE_URL: bridge.url,
          CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
          CLAUDEUI_PI_SESSION_TOOLS: piSessionToolsEnv(),
          CLAUDEUI_PI_PLAN_TOOLS: '1',
          CLAUDEUI_PI_MCP: '',
          CLAUDEUI_PI_HOSTED_TOOLS: '',
          CLAUDEUI_PI_DISPATCH_ENABLED: '',
          CLAUDEUI_PI_AGENT_TOOL: '',
          CLAUDEUI_PI_SEND_MESSAGE: '',
          CLAUDEUI_PI_SKILL_DIRS: ''
        }
      })
      const loadouts: string[][] = []
      client.onEvent((ev) => {
        const event = ev as unknown as {
          type: string
          message?: { customType?: string; content?: unknown }
        }
        if (event.type === 'message_end' && event.message?.customType === 'loadout') {
          loadouts.push(JSON.parse(String(event.message.content)))
        }
      })
      const inspect = async () => {
        const count = loadouts.length
        expect(
          (await client.request({ type: 'prompt', message: '/inspect-loadout' })).success
        ).toBe(true)
        const deadline = Date.now() + 5000
        while (loadouts.length === count && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        expect(loadouts.length).toBe(count + 1)
        return loadouts[count]
      }
      try {
        await client.start()
        const initial = await inspect()
        expect(initial).toEqual(expect.arrayContaining(['read', 'write', 'session_list']))
        expect(initial).not.toContain('session_stop')
        expect(initial).not.toContain('exit_plan')
        expect((await client.request({ type: 'prompt', message: '/cui-plan-enter' })).success).toBe(
          true
        )
        const plan = await inspect()
        expect(plan).toContain('exit_plan')
        expect(plan).not.toContain('write')
        expect(plan).not.toContain('session_stop')
        expect((await client.request({ type: 'prompt', message: '/cui-plan-exit' })).success).toBe(
          true
        )
        expect((await inspect()).sort()).toEqual(initial.sort())
      } finally {
        client.dispose()
        host.dispose()
      }
    },
    30_000
  )
})
