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
  DISPATCH_FOLLOW_UP_GUIDANCE,
  DISPATCH_SESSION_ID_REMOVED_TEXT,
  DISPATCH_TARGET_BLURBS,
  dispatchResultSuffix,
  dispatchWorkdirArg,
  DISPATCH_WORKDIR_PARAM,
  hasRemovedSessionId,
  isLaunchAck,
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
        ownSubagentTool: 'subagent',
        hints: 'For claude: sonnet. For pi: x/y.'
      })
    ).toBe(
      "Delegate a task to an agent on a DIFFERENT engine — claude (Anthropic's models), pi (an alternative coding-agent harness) or codex (OpenAI's own coding agent). " +
        `${PREFER}subagent tool instead: it is cheaper, starts faster and stays inside this session. ` +
        "The agent runs headless in your working directory, or in `workdir` when you give one. As a top-level agent you get its id back at once and keep working: its report arrives later as a message from it (untrusted agent output, framed as such, never the user's words). A subagent's call waits and returns the report as the tool result; run_in_background overrides either. " +
        'To talk to an agent again (a follow-up task, a correction, a question; a finished agent is resumed by the message), use `session_message` with session set to its name or id. ' +
        "The available model list is user-configured per target engine; omit `model` to use that engine's configured default. " +
        'For claude: sonnet. For pi: x/y.'
    )
  })

  it('names each engine its OWN subagent tool', () => {
    expect(OWN_SUBAGENT_TOOL).toEqual({
      claude: 'Agent',
      pi: 'agent',
      opencode: 'subagent',
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

  it('no longer offers a session_id: a follow-up is a session_message', () => {
    const text = dispatchAgentDescription({
      targets: ['opencode'],
      ownSubagentTool: 'Agent',
      hints: ''
    })
    expect(text).not.toContain('session_id')
    expect(text).toContain(DISPATCH_FOLLOW_UP_GUIDANCE)
    expect(DISPATCH_FOLLOW_UP_GUIDANCE).toContain('`session_message`')
  })

  it('joinDispatchHints keeps the callers per-target "For x: …" format', () => {
    expect(
      joinDispatchHints([
        { targetEngine: 'opencode', long: 'A.' },
        { targetEngine: 'pi', long: 'B.' }
      ])
    ).toBe('For opencode: A. For pi: B.')
  })

  it('the system-prompt section carries the same targets, steer and the session_message follow-up, and is short', () => {
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
    expect(section).toContain(DISPATCH_FOLLOW_UP_GUIDANCE)
    expect(section).not.toContain('session_id')
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

  it('a launch acknowledgement is told from an answer by its exact shape, not by a phrase', () => {
    const ack =
      'X-Agent rev launched on pi · gpt (id s-abc123). It runs in the background and you can keep working.'
    expect(isLaunchAck(ack)).toBe(true)
    expect(
      isLaunchAck('X-Agent rev launched on codex (id s-abc123). It runs in the background')
    ).toBe(true)
    expect(
      isLaunchAck(ack.replace(' and you can keep working.', '; its report is delivered ...'))
    ).toBe(true)
    // A blocking answer, even one that quotes the phrase, is not one.
    expect(isLaunchAck('[X-Agent report] ... It runs in the background')).toBe(false)
    expect(isLaunchAck('X-Agent rev: It runs in the background, I found.')).toBe(false)
    expect(
      isLaunchAck('Dispatch failed: X-Agent launched on (id x). It runs in the background')
    ).toBe(false)
    expect(
      isLaunchAck(
        'Dispatch failed: X-Agent launched on (id x, session_id y). It runs in the background'
      )
    ).toBe(false)
  })

  it('an acknowledgement written before B-4 (with the harness session_id) is still one', () => {
    expect(
      isLaunchAck(
        'X-Agent rev launched on pi · gpt (id s-abc123, session_id h-1). It runs in the background and you can keep working.'
      )
    ).toBe(true)
  })

  it('the pi bridge reads the description from CLAUDEUI_PI_DISPATCH_DESCRIPTION, with a short static fallback', () => {
    const text = readFileSync(join(src, 'core/pi/pi-bridge-source.ts'), 'utf-8')
    expect(text).toContain('process.env.CLAUDEUI_PI_DISPATCH_DESCRIPTION ||')
  })
})

describe('the workdir parameter', () => {
  it('names where the directory may be, in words the pi bridge can carry as a quoted literal', () => {
    expect(DISPATCH_WORKDIR_PARAM).toBe(
      'Optional directory the agent runs in (absolute, or relative to your working directory), e.g. a git worktree. ' +
        'It must be inside your working directory or one of the additional directories the user has added; ' +
        'omitted, the agent runs in your working directory.'
    )
    // The bridge is a template literal of single-quoted strings: neither character may appear.
    expect(DISPATCH_WORKDIR_PARAM).not.toMatch(/['`\\]/)
  })

  it('the tool description tells the agent runs in workdir when one is given', () => {
    const text = dispatchAgentDescription({
      targets: ['opencode'],
      ownSubagentTool: 'Agent',
      hints: ''
    })
    expect(text).toContain(
      'runs headless in your working directory, or in `workdir` when you give one'
    )
    expect(text).not.toContain('the same working directory')
  })

  it('dispatchWorkdirArg keeps a trimmed non-empty string and drops everything else', () => {
    expect(dispatchWorkdirArg('/repo/wt')).toBe('/repo/wt')
    expect(dispatchWorkdirArg('  ../wt  ')).toBe('../wt')
    expect(dispatchWorkdirArg('')).toBeUndefined()
    expect(dispatchWorkdirArg('   ')).toBeUndefined()
    expect(dispatchWorkdirArg(undefined)).toBeUndefined()
    expect(dispatchWorkdirArg(null)).toBeUndefined()
    expect(dispatchWorkdirArg(7)).toBeUndefined()
  })
})

describe('the removed session_id', () => {
  it('the error names session_message and takes no arguments', () => {
    expect(DISPATCH_SESSION_ID_REMOVED_TEXT).toBe(
      "dispatch_agent no longer continues an agent; message it with session_message (session: '<name or ref>')."
    )
  })

  it('only a non-empty string counts as a session_id', () => {
    expect(hasRemovedSessionId('ses_1')).toBe(true)
    expect(hasRemovedSessionId('')).toBe(false)
    expect(hasRemovedSessionId('  ')).toBe(false)
    expect(hasRemovedSessionId(undefined)).toBe(false)
    expect(hasRemovedSessionId(null)).toBe(false)
    expect(hasRemovedSessionId(7)).toBe(false)
  })

  it('the blocking-result suffix names the ledger ref in both places', () => {
    expect(dispatchResultSuffix('s-abc123')).toBe(
      '\n\n[X-Agent s-abc123 - message it with session_message (session: "s-abc123") to continue it]'
    )
  })
})
