/**
 * The one `dispatch_agent` description (S4, ADR-089 messaging v2): the shared
 * builder's text, and that every engine's copy of the tool is built from it
 * rather than carrying its own prose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  dispatchAgentDescription,
  dispatchAgentPromptSection,
  DISPATCH_TARGET_BLURBS,
  joinDispatchHints,
  OWN_SUBAGENT_TOOL
} from '../dispatch-agent-description'

const PREFER =
  'Use this only when the user asks for a different engine or model vendor, or wants an ' +
  'independent second opinion from a different model family. For ordinary delegation ' +
  '(research, exploration, parallel or background work, implementation) use your own '

describe('dispatchAgentDescription', () => {
  it('renders the shared prose with the target blurbs, the engine own tool and the hints', () => {
    expect(
      dispatchAgentDescription({
        targets: ['claude', 'pi', 'codex'],
        ownSubagentTool: 'task',
        hints: 'For claude: sonnet. For pi: x/y.'
      })
    ).toBe(
      "Delegate a task to an agent on a DIFFERENT engine — claude (Anthropic's models), pi (an alternative coding-agent harness) or codex (OpenAI's own coding agent). " +
        `${PREFER}task tool instead: it is cheaper, starts faster and stays inside this session. ` +
        'The agent runs headless in the same working directory and its final answer is returned as this tool result. ' +
        'The result includes a session_id — pass it back as `session_id` to continue the same agent with its context intact. ' +
        "The available model list is user-configured per target engine; omit `model` to use that engine's configured default. " +
        'For claude: sonnet. For pi: x/y.'
    )
  })

  it('names each engine its OWN subagent tool', () => {
    expect(OWN_SUBAGENT_TOOL).toEqual({
      claude: 'Agent',
      pi: 'agent',
      opencode: 'task',
      codex: 'spawn_agent'
    })
    for (const [engine, tool] of Object.entries(OWN_SUBAGENT_TOOL)) {
      const text = dispatchAgentDescription({
        targets: ['opencode'],
        ownSubagentTool: tool,
        hints: ''
      })
      expect(text, engine).toContain(`use your own ${tool} tool instead`)
    }
  })

  it('a single target has no "or", and an empty hint adds no trailing text', () => {
    const text = dispatchAgentDescription({
      targets: ['opencode'],
      ownSubagentTool: 'Agent',
      hints: ''
    })
    expect(text).toContain(`opencode (${DISPATCH_TARGET_BLURBS.opencode}).`)
    expect(text.endsWith('configured default.')).toBe(true)
  })

  it('joinDispatchHints keeps the callers per-target "For x: …" format', () => {
    expect(
      joinDispatchHints([
        { targetEngine: 'opencode', long: 'A.' },
        { targetEngine: 'pi', long: 'B.' }
      ])
    ).toBe('For opencode: A. For pi: B.')
  })

  it('the system-prompt section carries the same targets, steer and session_id, and is short', () => {
    const section = dispatchAgentPromptSection({
      toolName: 'mcp__claude-ui-collab__dispatch_agent',
      targets: ['opencode', 'pi', 'codex'],
      ownSubagentTool: OWN_SUBAGENT_TOOL.claude
    })
    expect(section).toContain('`mcp__claude-ui-collab__dispatch_agent`')
    expect(section).toContain('opencode (fronts non-Anthropic model vendors')
    expect(section).toContain('pi (an alternative coding-agent harness)')
    expect(section).toContain("codex (OpenAI's own coding agent)")
    expect(section).toContain(`${PREFER}Agent tool instead`)
    expect(section).toContain('pass it back as `session_id`')
    expect(section).not.toContain('requires user approval per call')
    expect(section.length).toBeLessThan(900)
  })
})

describe('every engine builds its dispatch_agent description from the shared builder', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) return name === '__tests__' ? [] : walk(p)
      return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : []
    })
  const src = join(__dirname, '..', '..')
  const files = [...walk(join(src, 'core')), ...walk(join(src, 'shared'))]

  it('the preference sentence exists in exactly one source file', () => {
    const holders = files.filter((f) =>
      readFileSync(f, 'utf-8').includes('Use this only when the user asks for a different engine')
    )
    expect(holders.map((f) => f.replace(/\\/g, '/').split('/src/')[1])).toEqual([
      'shared/dispatch-agent-description.ts'
    ])
  })

  it.each([
    ['core/services/collab-tool.ts', 'OWN_SUBAGENT_TOOL.claude'],
    ['core/opencode/opencode-hosted-tools.ts', 'OWN_SUBAGENT_TOOL.opencode'],
    ['core/codex/codex-hosted-tools.ts', 'OWN_SUBAGENT_TOOL.codex'],
    ['core/pi/PiSession.ts', 'OWN_SUBAGENT_TOOL.pi'],
    ['core/services/claude-session.ts', 'OWN_SUBAGENT_TOOL.claude']
  ])('%s uses the builder with its own tool (%s)', (file, ownTool) => {
    const text = readFileSync(join(src, file), 'utf-8')
    expect(text).toContain('dispatch-agent-description')
    expect(text).toContain(ownTool)
    expect(text).not.toContain('Delegate a task to an agent running on a DIFFERENT engine')
  })

  it('the pi bridge reads the description from CLAUDEUI_PI_DISPATCH_DESCRIPTION, with a short static fallback', () => {
    const text = readFileSync(join(src, 'core/pi/pi-bridge-source.ts'), 'utf-8')
    expect(text).toContain('process.env.CLAUDEUI_PI_DISPATCH_DESCRIPTION ||')
  })
})
