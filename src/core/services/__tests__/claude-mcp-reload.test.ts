/**
 * @vitest-environment node
 *
 * The reload-until-visible loop against a fake query handle: cli.js's global
 * config cache can serve the old file for up to ~1 s after a native write.
 */
import { describe, expect, it, vi } from 'vitest'
import { reloadMcpUntil, type McpReloadHandle } from '../claude-mcp-reload'

/** A handle whose status shows `names` only from the `visibleFrom`-th reload on. */
function fakeHandle(visibleFrom: number, before: string[], after: string[]): McpReloadHandle {
  let reloads = 0
  return {
    reloadPlugins: vi.fn(async () => {
      reloads++
    }),
    mcpServerStatus: vi.fn(async () =>
      (reloads >= visibleFrom ? after : before).map((name) => ({ name }))
    )
  }
}

const noSleep = vi.fn(async () => {})

describe('reloadMcpUntil', () => {
  it('reloads once and skips the status check when nothing is expected', async () => {
    const h = fakeHandle(1, [], [])
    await expect(reloadMcpUntil(h, undefined, [1], noSleep)).resolves.toBe(true)
    expect(h.reloadPlugins).toHaveBeenCalledTimes(1)
    expect(h.mcpServerStatus).not.toHaveBeenCalled()
  })

  it('retries an add until the server is listed', async () => {
    const h = fakeHandle(3, ['pre'], ['pre', 'addu'])
    const sleep = vi.fn(async () => {})
    await expect(
      reloadMcpUntil(h, { name: 'addu', present: true }, [300, 500, 800], sleep)
    ).resolves.toBe(true)
    expect(h.reloadPlugins).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[300], [500]])
  })

  it('retries a remove until the server is gone', async () => {
    const h = fakeHandle(2, ['pre', 'addl'], ['pre'])
    await expect(
      reloadMcpUntil(h, { name: 'addl', present: false }, [10, 10], noSleep)
    ).resolves.toBe(true)
    expect(h.reloadPlugins).toHaveBeenCalledTimes(2)
  })

  it('gives up after the bounded retries and reports false', async () => {
    const h = fakeHandle(99, ['pre'], ['pre', 'addu'])
    await expect(
      reloadMcpUntil(h, { name: 'addu', present: true }, [1, 1, 1], noSleep)
    ).resolves.toBe(false)
    // first try + one per delay, never more
    expect(h.reloadPlugins).toHaveBeenCalledTimes(4)
  })

  it('does not wait when the first reload already shows the change', async () => {
    const h = fakeHandle(1, [], ['p1'])
    const sleep = vi.fn(async () => {})
    await expect(reloadMcpUntil(h, { name: 'p1', present: true }, [300], sleep)).resolves.toBe(true)
    expect(sleep).not.toHaveBeenCalled()
  })
})
