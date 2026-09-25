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

describe.skipIf(!cliJsExists())('patches', () => {
  it('cli.js is readable and non-empty', () => {
    expect(src.length).toBeGreaterThan(1_000_000) // ~11MB; sanity lower bound
  })

  it('all expected markers present', () => {
    const markers = findMarkers(src)
    // Minimum set we require in every build.
    expect(markers).toEqual(
      expect.arrayContaining([
        '/*PATCHED:subagent-A*/',
        '/*PATCHED:subagent-B*/',
        '/*PATCHED:subagent-C*/',
        '/*PATCHED:subagent-D*/',
        '/*PATCHED:subagent-E*/',
        '/*PATCHED:subagent-F*/',
        // subagent-F2 forwards stream_events past the v2.1.197 IVe/fHo pre-filter.
        '/*PATCHED:subagent-F2*/',
        // subagent-G (iu8 background streaming) was merged into BVe() in 2.1.197
        // and is now covered by Patch E — its marker is intentionally absent.
        '/*PATCHED:queue-control-dequeue*/',
        '/*PATCHED:queue-control-consumed*/',
        '/*PATCHED:mcp-status-store-promise*/',
        '/*PATCHED:mcp-status-await-refresh*/',
        '/*PATCHED:background-task*/',
        '/*PATCHED:rate-limit-relay*/',
        '/*PATCHED:voice-server*/',
        '/*PATCHED:bash-output-streaming*/',
        '/*PATCHED:bash-early-poll*/'
      ])
    )
  })

  // ---------------------------------------------------------------------------
  // subagent-streaming — markers A..F + F2. Patch G (iu8 standalone background
  // loop) was merged into BVe() upstream in 2.1.197, so its marker is absent
  // and Patch E covers that path; F2 forwards stream_events past the 2.1.197
  // IVe/fHo streaming pre-filter.
  // ---------------------------------------------------------------------------
  describe('subagent-streaming', () => {
    for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'F2']) {
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
