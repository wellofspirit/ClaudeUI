/**
 * @vitest-environment node
 *
 * Layer 1 patch regression tests.
 *
 * Verifies the post-apply state of `vendor/claude-cli/cli.js`:
 * every expected `/*PATCHED:<name>*\/` marker is present and unique. These tests run
 * on every CI invocation (no auth or network required) so a failed/silently-no-op
 * patch caused by an SDK upgrade is caught before shipping.
 *
 * Behavioral tests that actually invoke `sdkQuery()` live in `patch/<name>/test.mjs`
 * and are run by `patch/test-all.mjs` — those require valid Claude auth.
 *
 * Two patches (`taskstop-notification`, `incomplete-session-resume-fix`) have been
 * upstreamed into the SDK and the apply scripts detect that and no-op. Their markers
 * won't be present in cli.js — we assert the upstream pattern instead.
 *
 * Four patches write markers into `sdk.mjs` (not cli.js): `*-sdk` suffixed ones from
 * queue-control, background-task, usage-relay, voice-server. Those are not verified
 * here — sdk.mjs is a separate small file and its markers are covered behaviorally.
 */

import { describe, it, expect } from 'vitest'
import {
  cliJsExists,
  readCliJs,
  hasMarker,
  countOccurrences,
  findMarkers
} from '../../test/helpers/patch-harness'

// Read cli.js once — it's ~11MB and we don't want to re-read per test.
const src = cliJsExists() ? readCliJs() : ''

/** Upstream detection for taskstop-notification Part A (SDK >= 0.2.49). */
const TASKSTOP_A_UPSTREAM =
  /=\([\w$]+\)=>[\w$]+==="completed"\|\|[\w$]+==="failed"\|\|[\w$]+==="stopped"\|\|[\w$]+==="killed"/

/** Upstream detection for taskstop-notification Part B (SDK >= 0.2.87). */
const TASKSTOP_B_UPSTREAM = /notified:!0[\s\S]{1,300}?[\w$]+\([\w$]+,"stopped",\{toolUseId:/

/** Upstream detection for incomplete-session-resume-fix (SDK >= 0.2.87). */
const RESUME_FIX_UPSTREAM_BUILD =
  /([\w$]+)\.set\(([\w$]+)\.uuid,([\w$]+)&&\1\.has\(\3\)\?\1\.get\(\3\)\?\?null:\3\);(?:continue|return)/

const RESUME_FIX_UPSTREAM_APPLY =
  /([\w$]+)\.parentUuid&&([\w$]+)\.has\(\1\.parentUuid\)\)\1\.parentUuid=\2\.get\(\1\.parentUuid\)\?\?null/

/** Upstream detection for mcp-tool-refresh (CLI 2.1.114+). The CLI now
 *  calls refreshTools() before each API call natively — our patches are a
 *  no-op when this pattern is present. */
const MCP_TOOL_REFRESH_UPSTREAM = /\.options\.refreshTools\)\{[^}]*\.options\.refreshTools\(\)/

describe.skipIf(!cliJsExists())('patches', () => {
  it('cli.js is readable and non-empty', () => {
    expect(src.length).toBeGreaterThan(1_000_000) // ~11MB; sanity lower bound
  })

  it('all expected markers present', () => {
    const markers = findMarkers(src)
    // Minimum set we require in every build. taskstop + resume-fix are
    // upstreamed in 0.2.87+ and tested separately below.
    expect(markers).toEqual(
      expect.arrayContaining([
        '/*PATCHED:subagent-A*/',
        '/*PATCHED:subagent-B*/',
        '/*PATCHED:subagent-C*/',
        '/*PATCHED:subagent-D*/',
        '/*PATCHED:subagent-E*/',
        '/*PATCHED:subagent-F*/',
        '/*PATCHED:subagent-G*/',
        '/*PATCHED:queue-control-dequeue*/',
        '/*PATCHED:queue-control-consumed*/',
        '/*PATCHED:mcp-status-store-promise*/',
        '/*PATCHED:mcp-status-await-refresh*/',
        // mcp-tool-refresh — upstreamed in CLI 2.1.114; tested below.
        '/*PATCHED:background-task*/',
        '/*PATCHED:usage-relay*/',
        '/*PATCHED:request-usage*/',
        '/*PATCHED:rate-limit-relay*/',
        '/*PATCHED:voice-server*/',
        '/*PATCHED:bash-output-streaming*/',
        '/*PATCHED:bash-early-poll*/'
      ])
    )
  })

  // ---------------------------------------------------------------------------
  // subagent-streaming — 7 markers A..G
  // ---------------------------------------------------------------------------
  describe('subagent-streaming', () => {
    for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      const name = `subagent-${letter}`
      it(`marker ${name} present in cli.js`, () => {
        expect(hasMarker(src, name)).toBe(true)
      })
      it(`marker ${name} appears exactly once`, () => {
        expect(countOccurrences(src, `/*PATCHED:${name}*/`)).toBe(1)
      })
    }
  })

  // ---------------------------------------------------------------------------
  // taskstop-notification — upstreamed in SDK 0.2.49 (A) and 0.2.87 (B)
  // Current SDK (0.2.97) has both upstreamed → markers are absent; we assert
  // the upstream patterns instead so a regression in the SDK would fail.
  // ---------------------------------------------------------------------------
  describe('taskstop-notification', () => {
    it('Part A: marker or upstream pattern present', () => {
      const markerPresent = hasMarker(src, 'taskstop-notification-A')
      const upstreamPresent = TASKSTOP_A_UPSTREAM.test(src)
      expect(markerPresent || upstreamPresent).toBe(true)
    })

    it('Part A: if marker present, appears exactly once', () => {
      const count = countOccurrences(src, '/*PATCHED:taskstop-notification-A*/')
      // Upstreamed → 0; patched → 1. Never more.
      expect(count).toBeLessThanOrEqual(1)
    })

    it('Part B: marker or upstream pattern present', () => {
      const markerPresent = hasMarker(src, 'taskstop-notification-B')
      const upstreamPresent = TASKSTOP_B_UPSTREAM.test(src)
      expect(markerPresent || upstreamPresent).toBe(true)
    })

    it('Part B: if marker present, appears exactly once', () => {
      const count = countOccurrences(src, '/*PATCHED:taskstop-notification-B*/')
      expect(count).toBeLessThanOrEqual(1)
    })
  })

  // ---------------------------------------------------------------------------
  // queue-control — 2 markers in cli.js (the -sdk one lives in sdk.mjs)
  // ---------------------------------------------------------------------------
  describe('queue-control', () => {
    for (const name of ['queue-control-dequeue', 'queue-control-consumed']) {
      it(`marker ${name} present in cli.js`, () => {
        expect(hasMarker(src, name)).toBe(true)
      })
      it(`marker ${name} appears exactly once`, () => {
        expect(countOccurrences(src, `/*PATCHED:${name}*/`)).toBe(1)
      })
    }
  })

  // ---------------------------------------------------------------------------
  // mcp-status — 2 markers
  // ---------------------------------------------------------------------------
  describe('mcp-status', () => {
    for (const name of ['mcp-status-store-promise', 'mcp-status-await-refresh']) {
      it(`marker ${name} present in cli.js`, () => {
        expect(hasMarker(src, name)).toBe(true)
      })
      it(`marker ${name} appears exactly once`, () => {
        expect(countOccurrences(src, `/*PATCHED:${name}*/`)).toBe(1)
      })
    }
  })

  // ---------------------------------------------------------------------------
  // mcp-tool-refresh — upstreamed in CLI 2.1.114
  // When upstreamed, markers are absent and the patch is a no-op. Assert the
  // native `refreshTools()` pattern instead.
  // ---------------------------------------------------------------------------
  describe('mcp-tool-refresh', () => {
    it('marker or upstream pattern present', () => {
      const markerA = hasMarker(src, 'mcp-tool-refresh-A')
      const markerB = hasMarker(src, 'mcp-tool-refresh-B')
      const upstream = MCP_TOOL_REFRESH_UPSTREAM.test(src)
      expect(markerA || markerB || upstream).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // background-task — single marker in cli.js (-sdk is in sdk.mjs)
  // ---------------------------------------------------------------------------
  describe('background-task', () => {
    it('marker background-task present in cli.js', () => {
      expect(hasMarker(src, 'background-task')).toBe(true)
    })
    it('marker background-task appears exactly once', () => {
      expect(countOccurrences(src, '/*PATCHED:background-task*/')).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // usage-relay — single marker in cli.js
  // ---------------------------------------------------------------------------
  describe('usage-relay', () => {
    it('marker usage-relay present in cli.js', () => {
      expect(hasMarker(src, 'usage-relay')).toBe(true)
    })
    it('marker usage-relay appears exactly once', () => {
      expect(countOccurrences(src, '/*PATCHED:usage-relay*/')).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // request-usage — single marker
  // ---------------------------------------------------------------------------
  describe('request-usage', () => {
    it('marker request-usage present in cli.js', () => {
      expect(hasMarker(src, 'request-usage')).toBe(true)
    })
    it('marker request-usage appears exactly once', () => {
      expect(countOccurrences(src, '/*PATCHED:request-usage*/')).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // rate-limit-relay — single marker
  // ---------------------------------------------------------------------------
  describe('rate-limit-relay', () => {
    it('marker rate-limit-relay present in cli.js', () => {
      expect(hasMarker(src, 'rate-limit-relay')).toBe(true)
    })
    it('marker rate-limit-relay appears exactly once', () => {
      expect(countOccurrences(src, '/*PATCHED:rate-limit-relay*/')).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // incomplete-session-resume-fix — upstreamed in SDK 0.2.87
  // Marker absent on 0.2.87+; assert upstream redirect-map patterns instead.
  // ---------------------------------------------------------------------------
  describe('incomplete-session-resume-fix', () => {
    it('marker or upstream redirect-build pattern present', () => {
      const markerPresent = hasMarker(src, 'incomplete-session-resume-fix')
      const upstreamBuild = RESUME_FIX_UPSTREAM_BUILD.test(src)
      expect(markerPresent || upstreamBuild).toBe(true)
    })

    it('marker or upstream redirect-apply pattern present', () => {
      const markerPresent = hasMarker(src, 'incomplete-session-resume-fix')
      const upstreamApply = RESUME_FIX_UPSTREAM_APPLY.test(src)
      expect(markerPresent || upstreamApply).toBe(true)
    })

    it('if marker present, appears exactly once', () => {
      const count = countOccurrences(src, '/*PATCHED:incomplete-session-resume-fix*/')
      expect(count).toBeLessThanOrEqual(1)
    })
  })

  // ---------------------------------------------------------------------------
  // voice-server — single marker in cli.js (-sdk is in sdk.mjs)
  // ---------------------------------------------------------------------------
  describe('voice-server', () => {
    it('marker voice-server present in cli.js', () => {
      expect(hasMarker(src, 'voice-server')).toBe(true)
    })
    it('marker voice-server appears exactly once', () => {
      expect(countOccurrences(src, '/*PATCHED:voice-server*/')).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // bash-output-streaming — 2 markers
  // ---------------------------------------------------------------------------
  describe('bash-output-streaming', () => {
    for (const name of ['bash-output-streaming', 'bash-early-poll']) {
      it(`marker ${name} present in cli.js`, () => {
        expect(hasMarker(src, name)).toBe(true)
      })
      it(`marker ${name} appears exactly once`, () => {
        expect(countOccurrences(src, `/*PATCHED:${name}*/`)).toBe(1)
      })
    }
  })
})
