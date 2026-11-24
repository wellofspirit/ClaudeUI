/**
 * @vitest-environment node
 *
 * `parseMediaInput` (model-written input: keep only what has the documented type) and `runMediaTool`
 * (what the agent reads back for a background start, a foreground outcome and an error).
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  mediaZodShape,
  parseMediaInput,
  runMediaTool,
  type MediaCall,
  type MediaStartFn
} from '../media-tool-handler'

describe('parseMediaInput', () => {
  it('keeps the documented fields and drops empty or mistyped ones', () => {
    expect(
      parseMediaInput('image', {
        prompt: 'a fox',
        images: ['a.png', '', 7, 'b.png'],
        model: 'openai/gpt-image',
        path: 'out/fox.png',
        duration: 5,
        aspect: '16:9'
      })
    ).toEqual({
      prompt: 'a fox',
      images: ['a.png', 'b.png'],
      model: 'openai/gpt-image',
      path: 'out/fox.png'
    })
    expect(parseMediaInput('image', { prompt: 3, images: 'a.png', model: '', path: 4 })).toEqual({
      prompt: ''
    })
  })

  it('video also takes a positive finite duration and a known aspect', () => {
    expect(parseMediaInput('video', { prompt: 'p', duration: 8, aspect: '9:16' })).toEqual({
      prompt: 'p',
      duration: 8,
      aspect: '9:16'
    })
    for (const duration of [0, -1, Number.NaN, Infinity, '5']) {
      expect(parseMediaInput('video', { prompt: 'p', duration })).not.toHaveProperty('duration')
    }
    expect(parseMediaInput('video', { prompt: 'p', aspect: '4:3' })).not.toHaveProperty('aspect')
  })
})

describe('runMediaTool', () => {
  const call = (over: Partial<MediaCall> = {}): MediaCall => ({
    routingId: 'r1',
    cwd: '/proj',
    engineId: 'opencode',
    toolUseId: 'tu1',
    kind: 'image',
    foreground: false,
    input: { prompt: 'a fox', images: ['in.png'], junk: 1 },
    ...over
  })

  it('passes the caller and the parsed input to start; a background start is worded with the path', async () => {
    const start = vi.fn<MediaStartFn>(async () => ({
      ok: true,
      jobId: 'job1',
      path: '/proj/media/fox.png',
      modelLabel: 'GPT Image'
    }))
    const reply = await runMediaTool(start, call())
    expect(start).toHaveBeenCalledWith({
      routingId: 'r1',
      cwd: '/proj',
      engineId: 'opencode',
      toolUseId: 'tu1',
      kind: 'image',
      input: { prompt: 'a fox', images: ['in.png'] },
      foreground: false
    })
    expect(reply.isError).toBe(false)
    expect(reply.text).toContain('Image job job1 started with GPT Image')
    expect(reply.text).toContain('/proj/media/fox.png')
    expect(reply.text).toContain('Do not poll')
    expect((await runMediaTool(start, call({ kind: 'video' }))).text).toMatch(/^Video job/)
  })

  it('a foreground completion returns the notice text, not an error', async () => {
    const start = vi.fn<MediaStartFn>(async () => ({
      ok: true,
      jobId: 'job2',
      path: '/p/x.png',
      modelLabel: 'M',
      final: {
        status: 'completed',
        result: {
          kind: 'image',
          jobId: 'job2',
          path: '/p/final.png',
          mime: 'image/png',
          bytes: 1,
          modelLabel: 'M',
          source: 'openai',
          elapsedMs: 1
        }
      }
    }))
    const reply = await runMediaTool(start, call({ foreground: true }))
    expect(reply.isError).toBe(false)
    expect(reply.text).toContain('finished')
    expect(reply.text).toContain('from 1 input image(s)')
    expect(reply.text).toContain('/p/final.png')
  })

  it('a foreground failure or stop is an error result', async () => {
    const failed = await runMediaTool(
      async () => ({
        ok: true,
        jobId: 'j',
        path: '/p',
        modelLabel: 'M',
        final: { status: 'failed', error: 'quota' }
      }),
      call({ foreground: true })
    )
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('failed (M): quota')
    const stopped = await runMediaTool(
      async () => ({
        ok: true,
        jobId: 'j',
        path: '/p',
        modelLabel: 'M',
        final: { status: 'stopped', error: '' }
      }),
      call({ foreground: true })
    )
    expect(stopped.isError).toBe(true)
    expect(stopped.text).toContain('stopped by the user')
  })

  it('a refused start is the error text as given', async () => {
    const reply = await runMediaTool(async () => ({ ok: false, error: 'no model' }), call())
    expect(reply).toEqual({ text: 'no model', isError: true })
  })
})

describe('mediaZodShape', () => {
  it('video adds duration and aspect; image does not', () => {
    expect(Object.keys(mediaZodShape('image')).sort()).toEqual([
      'images',
      'model',
      'path',
      'prompt'
    ])
    expect(Object.keys(mediaZodShape('video')).sort()).toEqual([
      'aspect',
      'duration',
      'images',
      'model',
      'path',
      'prompt'
    ])
    expect(z.object(mediaZodShape('video')).safeParse({ prompt: 'p', aspect: '4:3' }).success).toBe(
      false
    )
  })
})
