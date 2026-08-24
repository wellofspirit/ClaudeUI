/**
 * @vitest-environment node
 *
 * Tests for model-discovery's parseModelString — the canonical single copy of
 * the "providerID/modelID" opencode model-value parser (Item 6b dedup; was
 * previously duplicated byte-identically in OpencodeSession.ts and
 * agent-generate.ts, and now delegates to engineMeta('opencode').decodeModelValue).
 *
 * parseModelString itself is pure, but importing model-discovery.ts pulls in
 * OpencodeServerManager (which imports electron) transitively — mock the same
 * minimal set the other model-discovery-*.test.ts files use so the module
 * loads cleanly under plain Node.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: vi.fn(), release: vi.fn() }
}))
vi.mock('../OpencodeClient', () => ({ OpencodeClient: vi.fn() }))
vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted'
}))
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: vi.fn(() => ({})) }))

import { parseModelString } from '../model-discovery'

describe('parseModelString', () => {
  it('splits "providerID/modelID" on the first slash', () => {
    expect(parseModelString('anthropic/claude-opus-4-8')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-8'
    })
  })

  it('defaults providerID to "opencode" for a bare id with no slash', () => {
    expect(parseModelString('mimo-v2.5-free')).toEqual({
      providerID: 'opencode',
      modelID: 'mimo-v2.5-free'
    })
  })

  it('keeps everything after the FIRST slash as modelID (multi-slash values)', () => {
    expect(parseModelString('openrouter/foo/bar')).toEqual({
      providerID: 'openrouter',
      modelID: 'foo/bar'
    })
  })
})
