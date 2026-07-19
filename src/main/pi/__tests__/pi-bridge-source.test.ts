/**
 * @vitest-environment node
 *
 * Sanity tripwires for the pi-bridge-source.ts string constant. These do NOT
 * prove the extension works against a real pi process — that's the gated
 * integration guard test (src/integration/pi/pi-bridge.integration.test.ts).
 * These are cheap checks against accidental edits (e.g. someone adding an
 * `import`, which would break pi's jiti loader with zero resolution surface).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { PI_BRIDGE_EXTENSION_SOURCE, PI_BRIDGE_VERSION } from '../pi-bridge-source'

describe('PI_BRIDGE_EXTENSION_SOURCE', () => {
  it('has a non-empty version string', () => {
    expect(typeof PI_BRIDGE_VERSION).toBe('string')
    expect(PI_BRIDGE_VERSION.length).toBeGreaterThan(0)
  })

  it('is version 3 (M4a+b bumped it for the four hosted-tool registrations)', () => {
    expect(PI_BRIDGE_VERSION).toBe('3')
  })

  it('contains no import statements (zero module-resolution surface for pi\'s jiti loader)', () => {
    expect(/(^|\s)import(\s|\{)/.test(PI_BRIDGE_EXTENSION_SOURCE)).toBe(false)
  })

  it('exports a default function', () => {
    expect(PI_BRIDGE_EXTENSION_SOURCE).toMatch(/export default function/)
  })

  it('references both bridge env vars', () => {
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain('CLAUDEUI_PI_BRIDGE_URL')
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain('CLAUDEUI_PI_BRIDGE_TOKEN')
  })

  it('is inert (returns early) when the env vars are absent', () => {
    expect(PI_BRIDGE_EXTENSION_SOURCE).toMatch(/if \(!bridgeUrl \|\| !bridgeToken\) return/)
  })

  it('fails closed — blocks with a reason on every non-allow path', () => {
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain('block: true')
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain('ClaudeUI approval service unreachable')
  })

  it('never interpolates the bridge URL or token into a reason string', () => {
    // The only occurrences of bridgeUrl/bridgeToken as bare identifiers should
    // be reading them from process.env and building the fetch() call itself —
    // never inside a `reason:` string literal.
    const reasonLines = PI_BRIDGE_EXTENSION_SOURCE.split('\n').filter((l) => l.includes('reason'))
    for (const line of reasonLines) {
      expect(line).not.toMatch(/bridgeUrl|bridgeToken/)
    }
  })

  it('registers a project_trust handler that trusts without remembering', () => {
    expect(PI_BRIDGE_EXTENSION_SOURCE).toMatch(/project_trust/)
    expect(PI_BRIDGE_EXTENSION_SOURCE).toMatch(/trusted:\s*'yes'/)
    expect(PI_BRIDGE_EXTENSION_SOURCE).toMatch(/remember:\s*false/)
  })

  it('registers a resources_discover handler returning skillPaths (M3 shared skills)', () => {
    expect(PI_BRIDGE_EXTENSION_SOURCE).toMatch(/resources_discover/)
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain('skillPaths')
  })

  it('references the skill-dirs env var', () => {
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain('CLAUDEUI_PI_SKILL_DIRS')
  })

  it('gates resources_discover independently of the bridge URL/token check', () => {
    // The skill-dirs env var read + its `if` guard must appear BEFORE the
    // `if (!bridgeUrl || !bridgeToken) return` line — i.e. resources_discover
    // can register even when the function returns early right after for the
    // (separate) bridge gate. This is the actual independence property: the
    // early return must not be reachable before the skill-dirs block runs.
    const skillEnvIdx = PI_BRIDGE_EXTENSION_SOURCE.indexOf('CLAUDEUI_PI_SKILL_DIRS')
    const earlyReturnIdx = PI_BRIDGE_EXTENSION_SOURCE.indexOf('if (!bridgeUrl || !bridgeToken) return')
    expect(skillEnvIdx).toBeGreaterThan(-1)
    expect(earlyReturnIdx).toBeGreaterThan(-1)
    expect(skillEnvIdx).toBeLessThan(earlyReturnIdx)
  })

  it('splits skill dirs on a platform-appropriate delimiter without importing node:path', () => {
    // Node's path.delimiter equivalent, spelled out inline (see the no-import
    // constraint) rather than `require('node:path').delimiter`.
    expect(PI_BRIDGE_EXTENSION_SOURCE).toMatch(/process\.platform === 'win32' \? ';' : ':'/)
  })

  it('is syntactically valid JavaScript (bonus tripwire beyond the spec\'s minimum set)', () => {
    // The real proof is the gated integration test spawning the real binary;
    // this only catches a typo that would break EVERY spawn outright. Strip
    // the ESM `export default` (new Function can't parse module syntax) and
    // confirm the remaining function expression parses.
    const body = PI_BRIDGE_EXTENSION_SOURCE.replace('export default function', 'return function')
    expect(() => new Function(body)).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // Hosted tools + dispatch_agent (M4a+b) — string tripwires
  // -------------------------------------------------------------------------

  it('registers all four hosted-tool names', () => {
    for (const name of ['render_mermaid', 'create_mockup', 'show_mockup', 'dispatch_agent']) {
      expect(PI_BRIDGE_EXTENSION_SOURCE).toMatch(new RegExp(`name:\\s*'${name}'`))
    }
  })

  it('posts to <bridgeUrl>/hosted-tool and fails closed with the documented literal', () => {
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain("bridgeUrl + '/hosted-tool'")
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain('ClaudeUI hosted-tool service unreachable')
  })

  it('references the hosted-tools and dispatch-enabled env vars', () => {
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain('CLAUDEUI_PI_HOSTED_TOOLS')
    expect(PI_BRIDGE_EXTENSION_SOURCE).toContain('CLAUDEUI_PI_DISPATCH_ENABLED')
  })

  it('gates hosted tools independently of the bridge URL/token early return (same independence rule as M3 skills)', () => {
    const hostedEnvIdx = PI_BRIDGE_EXTENSION_SOURCE.indexOf('CLAUDEUI_PI_HOSTED_TOOLS')
    const earlyReturnIdx = PI_BRIDGE_EXTENSION_SOURCE.indexOf('if (!bridgeUrl || !bridgeToken) return')
    expect(hostedEnvIdx).toBeGreaterThan(-1)
    expect(earlyReturnIdx).toBeGreaterThan(-1)
    expect(hostedEnvIdx).toBeLessThan(earlyReturnIdx)
  })

  it('nests dispatch_agent behind its OWN second gate, inside the hosted-tools block', () => {
    const hostedGateIdx = PI_BRIDGE_EXTENSION_SOURCE.indexOf("CLAUDEUI_PI_HOSTED_TOOLS === '1'")
    const dispatchGateIdx = PI_BRIDGE_EXTENSION_SOURCE.indexOf("CLAUDEUI_PI_DISPATCH_ENABLED === '1'")
    const dispatchNameIdx = PI_BRIDGE_EXTENSION_SOURCE.indexOf("name: 'dispatch_agent'")
    expect(hostedGateIdx).toBeGreaterThan(-1)
    expect(dispatchGateIdx).toBeGreaterThan(-1)
    expect(dispatchNameIdx).toBeGreaterThan(-1)
    expect(hostedGateIdx).toBeLessThan(dispatchGateIdx)
    expect(dispatchGateIdx).toBeLessThan(dispatchNameIdx)
  })
})

// ---------------------------------------------------------------------------
// Behavioral harness — actually EXECUTE the extension source in-process
// against a fake `pi` object + a stubbed global fetch. Goes beyond the
// string tripwires above (which only guard against accidental edits) to
// prove the env-var gating matrix and the execute()/fetch contract really
// behave as documented — still not a substitute for the gated integration
// test (src/integration/pi/pi-hosted-tools.integration.test.ts), which
// drives the real binary.
// ---------------------------------------------------------------------------

interface FakeToolDef {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

interface FakePi {
  on: (event: string, handler: (...args: unknown[]) => unknown) => void
  registerTool: (def: FakeToolDef) => void
}

/** Load the extension's default-exported factory function via `new Function` (same technique as the "syntactically valid JavaScript" test above, extended to actually invoke the result). */
function loadExtensionFactory(): (pi: FakePi) => void {
  const body = PI_BRIDGE_EXTENSION_SOURCE.replace('export default function', 'return function')
  return new Function(body)() as (pi: FakePi) => void
}

/** Run the extension factory against a fake `pi`, capturing every registered tool + event handler by name. */
function runExtension(): { tools: Map<string, FakeToolDef>; events: Map<string, (...args: unknown[]) => unknown> } {
  const tools = new Map<string, FakeToolDef>()
  const events = new Map<string, (...args: unknown[]) => unknown>()
  const pi: FakePi = {
    on: (event, handler) => events.set(event, handler),
    registerTool: (def) => tools.set(def.name, def)
  }
  loadExtensionFactory()(pi)
  return { tools, events }
}

/** Set env vars for the duration of `fn`, restoring the prior values (including absence) afterward — `undefined` means "ensure unset". */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) prev[k] = process.env[k]
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const BRIDGE_CREDS = { CLAUDEUI_PI_BRIDGE_URL: 'http://127.0.0.1:9', CLAUDEUI_PI_BRIDGE_TOKEN: 'tok' }

describe('PI_BRIDGE_EXTENSION_SOURCE — hosted-tools registration matrix (executed in-process)', () => {
  it('registers NEITHER approvals nor hosted tools when bridge creds are absent (existing M2a behavior unaffected)', () => {
    withEnv(
      {
        CLAUDEUI_PI_BRIDGE_URL: undefined,
        CLAUDEUI_PI_BRIDGE_TOKEN: undefined,
        CLAUDEUI_PI_HOSTED_TOOLS: '1',
        CLAUDEUI_PI_DISPATCH_ENABLED: '1'
      },
      () => {
        const { tools, events } = runExtension()
        expect(tools.size).toBe(0)
        expect(events.has('tool_call')).toBe(false)
      }
    )
  })

  it('registers the approval hook but NO hosted tools when CLAUDEUI_PI_HOSTED_TOOLS is unset', () => {
    withEnv(
      { ...BRIDGE_CREDS, CLAUDEUI_PI_HOSTED_TOOLS: undefined, CLAUDEUI_PI_DISPATCH_ENABLED: undefined },
      () => {
        const { tools, events } = runExtension()
        expect(tools.size).toBe(0)
        expect(events.has('tool_call')).toBe(true)
      }
    )
  })

  it('registers the three hosted tools (not dispatch_agent) when CLAUDEUI_PI_HOSTED_TOOLS=1 but CLAUDEUI_PI_DISPATCH_ENABLED is unset', () => {
    withEnv({ ...BRIDGE_CREDS, CLAUDEUI_PI_HOSTED_TOOLS: '1', CLAUDEUI_PI_DISPATCH_ENABLED: undefined }, () => {
      const { tools } = runExtension()
      expect([...tools.keys()].sort()).toEqual(['create_mockup', 'render_mermaid', 'show_mockup'])
    })
  })

  it('registers all four tools (including dispatch_agent) when both hosted-tools env vars are set', () => {
    withEnv({ ...BRIDGE_CREDS, CLAUDEUI_PI_HOSTED_TOOLS: '1', CLAUDEUI_PI_DISPATCH_ENABLED: '1' }, () => {
      const { tools } = runExtension()
      expect([...tools.keys()].sort()).toEqual(['create_mockup', 'dispatch_agent', 'render_mermaid', 'show_mockup'])
    })
  })

  it('parameters are PLAIN JSON-schema object literals — no typebox Type.Object() involved (the load-bearing wire finding)', () => {
    withEnv({ ...BRIDGE_CREDS, CLAUDEUI_PI_HOSTED_TOOLS: '1', CLAUDEUI_PI_DISPATCH_ENABLED: '1' }, () => {
      const { tools } = runExtension()
      expect(tools.get('render_mermaid')!.parameters).toEqual({
        type: 'object',
        properties: {
          source: { type: 'string', description: expect.any(String) },
          title: { type: 'string', description: expect.any(String) }
        },
        required: ['source']
      })
      expect(tools.get('dispatch_agent')!.parameters).toMatchObject({
        type: 'object',
        properties: { engine: { type: 'string', enum: ['claude', 'opencode'] } },
        required: ['engine', 'prompt']
      })
    })
  })
})

describe('PI_BRIDGE_EXTENSION_SOURCE — execute()/fetch contract (executed in-process)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("render_mermaid.execute() POSTs to <bridgeUrl>/hosted-tool with {toolName, input, toolCallId} and returns the parsed {content} verbatim", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: '"Flow" rendered successfully.' }] })
      } as Response
    }) as typeof fetch

    await withEnv({ ...BRIDGE_CREDS, CLAUDEUI_PI_HOSTED_TOOLS: '1' }, async () => {
      const { tools } = runExtension()
      const result = await tools.get('render_mermaid')!.execute('call-1', {
        source: 'graph TD; A-->B',
        title: 'Flow'
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('http://127.0.0.1:9/hosted-tool')
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        toolName: 'render_mermaid',
        input: { source: 'graph TD; A-->B', title: 'Flow' },
        toolCallId: 'call-1'
      })
      expect(result).toEqual({ content: [{ type: 'text', text: '"Flow" rendered successfully.' }] })
    })
  })

  it("dispatch_agent.execute() POSTs its OWN toolName (not a copy-paste of another tool's)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) } as Response
    }) as typeof fetch

    await withEnv({ ...BRIDGE_CREDS, CLAUDEUI_PI_HOSTED_TOOLS: '1', CLAUDEUI_PI_DISPATCH_ENABLED: '1' }, async () => {
      const { tools } = runExtension()
      await tools.get('dispatch_agent')!.execute('call-2', { engine: 'opencode', prompt: 'x' })

      expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ toolName: 'dispatch_agent', toolCallId: 'call-2' })
    })
  })

  it('fails closed with an isError result on a network error (fetch rejects)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch

    await withEnv({ ...BRIDGE_CREDS, CLAUDEUI_PI_HOSTED_TOOLS: '1' }, async () => {
      const { tools } = runExtension()
      const result = (await tools.get('render_mermaid')!.execute('call-3', { source: 'x' })) as {
        content: Array<{ text: string }>
        isError?: boolean
      }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('ClaudeUI hosted-tool service unreachable')
      expect(result.content[0].text).not.toContain('127.0.0.1') // never leaks the bridge URL
    })
  })

  it('fails closed with an isError result on a non-2xx bridge response', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch

    await withEnv({ ...BRIDGE_CREDS, CLAUDEUI_PI_HOSTED_TOOLS: '1' }, async () => {
      const { tools } = runExtension()
      const result = (await tools.get('render_mermaid')!.execute('call-4', { source: 'x' })) as {
        content: Array<{ text: string }>
        isError?: boolean
      }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('HTTP 500')
    })
  })

  it('fails closed with an isError result when the bridge response is not {content:[...]}', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: 'shape' })
    })) as unknown as typeof fetch

    await withEnv({ ...BRIDGE_CREDS, CLAUDEUI_PI_HOSTED_TOOLS: '1' }, async () => {
      const { tools } = runExtension()
      const result = (await tools.get('render_mermaid')!.execute('call-5', { source: 'x' })) as {
        content: Array<{ text: string }>
        isError?: boolean
      }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('malformed')
    })
  })
})
