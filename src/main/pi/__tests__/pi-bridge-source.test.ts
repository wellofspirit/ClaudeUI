/**
 * @vitest-environment node
 *
 * Sanity tripwires for the pi-bridge-source.ts string constant. These do NOT
 * prove the extension works against a real pi process — that's the gated
 * integration guard test (src/integration/pi/pi-bridge.integration.test.ts).
 * These are cheap checks against accidental edits (e.g. someone adding an
 * `import`, which would break pi's jiti loader with zero resolution surface).
 */
import { describe, it, expect } from 'vitest'
import { PI_BRIDGE_EXTENSION_SOURCE, PI_BRIDGE_VERSION } from '../pi-bridge-source'

describe('PI_BRIDGE_EXTENSION_SOURCE', () => {
  it('has a non-empty version string', () => {
    expect(typeof PI_BRIDGE_VERSION).toBe('string')
    expect(PI_BRIDGE_VERSION.length).toBeGreaterThan(0)
  })

  it('is version 2 (M3 bumped it for resources_discover)', () => {
    expect(PI_BRIDGE_VERSION).toBe('2')
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
})
