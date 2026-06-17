/**
 * Regression test for the /btw side-question flow.
 *
 * Pins the wire shape that cli.js emits in response to a `side_question`
 * control_request, and asserts that QueryHandle.askSideQuestion extracts the
 * answer text correctly.
 *
 * The cli.js handler (anchored in the bundled cli.js as
 * `else if(vH.request.subtype==="side_question")`) returns:
 *
 *   { response: string | null, synthetic: boolean, usage?: ... }
 *
 * Verified against the SDK's own client class in cli.js, which extracts
 * `(await this.request({subtype:"side_question",...})).response.response`.
 *
 * A previous version of this harness mistakenly looked for `r?.answer`,
 * which yielded `null` and surfaced as "No response received." in the BTW
 * card. This test guards against that regression.
 */
import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { ControlChannel } from '../control'
import { NdjsonWriter, type JsonLine } from '../protocol'
import { WireLog } from '../wire-log'
import { makeHandle, MessageQueue } from '../query'

function makeSink(): { writer: NdjsonWriter; written: JsonLine[] } {
  const pass = new PassThrough()
  const written: JsonLine[] = []
  pass.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) written.push(JSON.parse(line))
    }
  })
  return { writer: new NdjsonWriter(pass), written }
}

function buildHandle() {
  const { writer, written } = makeSink()
  const control = new ControlChannel(writer)
  const queue = new MessageQueue()
  const wireLog = new WireLog()
  const fakeChild = {} as unknown as ChildProcess
  const initResponse = Promise.resolve({})
  const handle = makeHandle(queue, control, fakeChild, {}, initResponse, wireLog, () => {})
  return { handle, control, written }
}

describe('QueryHandle.askSideQuestion (cli.js side_question contract)', () => {
  it('returns the answer text from the cli.js {response, synthetic} payload', async () => {
    const { handle, control, written } = buildHandle()

    const p = handle.askSideQuestion('what is 2+2?')

    // Wait for the request to be flushed
    while (written.length === 0) await new Promise((r) => setImmediate(r))
    expect(written[0]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'side_question', question: 'what is 2+2?' }
    })
    const request_id = written[0].request_id as string

    // Simulate cli.js's actual response shape — `response`, NOT `answer`.
    control.handleResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id,
        response: { response: '2 + 2 = 4', synthetic: false }
      }
    })

    await expect(p).resolves.toBe('2 + 2 = 4')
  })

  it('returns null when cli.js reports no response (response=null)', async () => {
    const { handle, control, written } = buildHandle()
    const p = handle.askSideQuestion('hi')
    while (written.length === 0) await new Promise((r) => setImmediate(r))
    const request_id = written[0].request_id as string

    control.handleResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id,
        response: { response: null, synthetic: false }
      }
    })

    await expect(p).resolves.toBeNull()
  })

  it('returns null when the outer response payload is null', async () => {
    const { handle, control, written } = buildHandle()
    const p = handle.askSideQuestion('hi')
    while (written.length === 0) await new Promise((r) => setImmediate(r))
    const request_id = written[0].request_id as string

    control.handleResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id, response: null }
    })

    await expect(p).resolves.toBeNull()
  })

  it('rejects when cli.js reports an error', async () => {
    const { handle, control, written } = buildHandle()
    const p = handle.askSideQuestion('hi')
    while (written.length === 0) await new Promise((r) => setImmediate(r))
    const request_id = written[0].request_id as string

    control.handleResponse({
      type: 'control_response',
      response: { subtype: 'error', request_id, error: 'boom' }
    })

    await expect(p).rejects.toThrow('boom')
  })
})
