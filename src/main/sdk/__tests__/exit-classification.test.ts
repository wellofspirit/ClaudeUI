import { describe, it, expect } from 'vitest'
import { isCleanExit } from '../query'

describe('isCleanExit', () => {
  it('treats exit code 0 as clean', () => {
    expect(isCleanExit(0, null, false)).toBe(true)
  })

  it('treats exit code 143 (SIGTERM after graceful cleanup) as clean', () => {
    // cli.js catches SIGTERM, cleans up, exits normally → Node reports
    // code=143, signal=null. This is the case shown to the user as
    // "cli.js exited with code=143 signal=null" before the fix.
    expect(isCleanExit(143, null, false)).toBe(true)
  })

  it('treats direct SIGTERM (signal reported by Node) as clean', () => {
    expect(isCleanExit(null, 'SIGTERM', false)).toBe(true)
  })

  it('treats caller-initiated kill as clean even under unusual code/signal', () => {
    // Idle timeout or disconnect path: we flagged the kill ourselves, exit
    // reason doesn't matter.
    expect(isCleanExit(137, null, true)).toBe(true)
    expect(isCleanExit(1, null, true)).toBe(true)
  })

  it('reports a real crash (non-zero exit, not killed by us) as unclean', () => {
    expect(isCleanExit(1, null, false)).toBe(false)
    expect(isCleanExit(134, null, false)).toBe(false) // SIGABRT
  })

  it('reports SIGKILL (OS OOM etc.) as unclean when we did not initiate it', () => {
    expect(isCleanExit(null, 'SIGKILL', false)).toBe(false)
  })
})
