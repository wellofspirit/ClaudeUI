/**
 * @vitest-environment node
 *
 * H12 guard — the classifier must correlate each verdict with the request that
 * is actually awaiting it. Pre-fix, the MCP callback resolved WHATEVER was in
 * `this.pending`, so a late verdict from a timed-out request resolved the NEXT
 * request's pending → stream permanently off-by-one (a stale ALLOW could
 * approve a later dangerous tool). We thread a request id and drop verdicts
 * whose id doesn't match the pending request.
 *
 * The real ClassifierSession is driven via getClassifier(); the SDK query is
 * stubbed (it parks until aborted — the MCP tool callback is the signal
 * channel), and createClassifierServer is stubbed to capture that callback so
 * the test can feed verdicts with arbitrary ids.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'

let TEMP_HOME = ''
const capturedCallbacks: Array<(id: string, result: unknown) => void> = []

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

// SDK query stub: an async iterable that parks until the abort signal fires,
// then completes (so the background consume loop exits cleanly on stop()).
vi.mock('../sdk', () => ({
  query: (params: { options?: { abortController?: AbortController } }) => {
    const ac = params?.options?.abortController
    return {
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => {
          if (ac?.signal.aborted) return resolve()
          ac?.signal.addEventListener('abort', () => resolve())
        })
      }
    }
  }
}))

vi.mock('../auto-classifier-tool', () => ({
  createClassifierServer: (onResult: (id: string, result: unknown) => void) => {
    capturedCallbacks.push(onResult)
    return { name: 'auto-classifier' }
  }
}))

vi.mock('../claude-session', () => ({ getSdkExecutableOpts: () => ({}) }))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

type ClassifierApi = typeof import('../auto-classifier')

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'classifier-corr-'))
  capturedCallbacks.length = 0
})

afterEach(async () => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    // Best-effort — Windows can briefly EPERM a temp dir touched by an async op
    // that hasn't fully unwound; the OS reclaims it regardless.
    try {
      fs.rmSync(TEMP_HOME, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  vi.clearAllMocks()
})

async function fresh(): Promise<ClassifierApi> {
  vi.resetModules()
  return import('../auto-classifier')
}

describe('ClassifierSession — verdict/request correlation (H12)', () => {
  it('ignores a verdict whose id does not match the pending request', async () => {
    const { getClassifier, stopClassifier } = await fresh()
    const classifier = getClassifier('h12-idcheck')

    // Request A → id "1".
    const pA = classifier.classify('Bash', { command: 'echo hi' }, 'transcript')
    await flush()
    const cb = capturedCallbacks[0]
    expect(cb).toBeTruthy()

    // A stale/mismatched verdict must NOT resolve the pending request.
    cb('does-not-match', { thinking: '', shouldBlock: true, reason: 'STALE BLOCK' })
    await flush()
    let settled = false
    void pA.then(
      () => (settled = true),
      () => (settled = true)
    )
    await flush()
    expect(settled).toBe(false)

    // The correctly-correlated verdict (id "1") resolves it.
    cb('1', { thinking: '', shouldBlock: false, reason: 'allowed' })
    const res = await pA
    expect(res.shouldBlock).toBe(false)
    expect(res.reason).toBe('allowed')

    stopClassifier('h12-idcheck')
  })

  it('a late verdict for a timed-out request A cannot resolve a subsequent request B', async () => {
    const { getClassifier, stopClassifier } = await fresh()
    vi.useFakeTimers()
    try {
      const classifier = getClassifier('h12-timeout')

      // Request A (id "1"). Let start() capture the first callback + set pending.
      const pA = classifier.classify('Bash', { command: 'rm -rf /' }, 'transcript A')
      // Attach the rejection expectation NOW so A's timeout doesn't surface as an
      // unhandled rejection when the fake timer fires it below.
      const pARejects = expect(pA).rejects.toThrow(/timeout/i)
      await vi.advanceTimersByTimeAsync(0)
      const cbA = capturedCallbacks[0]
      expect(cbA).toBeTruthy()

      // A times out (TIMEOUT_MS = 30_000). Pending is nulled + the session is
      // torn down so the next classify() starts fresh.
      await vi.advanceTimersByTimeAsync(30_000)
      await pARejects

      // Request B starts a NEW session (fresh callback captured).
      const pB = classifier.classify('Write', { file_path: '/x' }, 'transcript B')
      let bSettled = false
      void pB.then(
        () => (bSettled = true),
        () => (bSettled = true)
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(capturedCallbacks.length).toBe(2)
      const cbB = capturedCallbacks[1]

      // A's late verdict arrives on the OLD callback — must not resolve B.
      cbA('1', { thinking: '', shouldBlock: false, reason: 'STALE ALLOW' })
      await vi.advanceTimersByTimeAsync(0)
      expect(bSettled).toBe(false)

      // B resolves only from its own correlated verdict.
      cbB('2', { thinking: '', shouldBlock: true, reason: 'blocked B' })
      const resB = await pB
      expect(resB.shouldBlock).toBe(true)
      expect(resB.reason).toBe('blocked B')

      stopClassifier('h12-timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
