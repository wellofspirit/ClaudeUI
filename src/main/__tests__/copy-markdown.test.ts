import { describe, expect, it, vi } from 'vitest'
import { copyMarkdown } from '../copy-markdown'

describe('copyMarkdown', () => {
  it('snapshots the click source and waits for the clipboard write', async () => {
    let complete!: () => void
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        })
    )
    const onError = vi.fn()
    let source: string | null = '**original**'
    let settled = false
    const copying = copyMarkdown(source, writeText, onError).then(() => {
      settled = true
    })
    source = '**next message**'
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledExactlyOnceWith('**original**')
    expect(settled).toBe(false)
    complete()
    await copying
    expect(settled).toBe(true)
    expect(onError).not.toHaveBeenCalled()
    expect(source).toBe('**next message**')
  })

  it('reports a rejected write without rejecting the click handler', async () => {
    const error = new Error('clipboard unavailable')
    const writeText = vi.fn().mockRejectedValue(error)
    const onError = vi.fn()

    await expect(copyMarkdown('# message', writeText, onError)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledExactlyOnceWith(error)
  })

  it.each([null, ''])('does not write for an absent source (%s)', async (source) => {
    const writeText = vi.fn()
    const onError = vi.fn()

    await copyMarkdown(source, writeText, onError)
    expect(writeText).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
