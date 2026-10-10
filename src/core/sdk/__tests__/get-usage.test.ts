/**
 * @vitest-environment node
 *
 * QueryHandle.getUsage → cli.js's native `get_usage` control request.
 *
 * `skip_behaviors: true` is what keeps the usage meter cheap: without it cli.js
 * scans every transcript touched in the last seven days to fill the response's
 * `behaviors` section, which nothing in the app reads (docs/protocol-cc/
 * 07-control-outbound.md, `get_usage`).
 */
import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { ControlChannel } from '../control'
import { NdjsonWriter, type JsonLine } from '../protocol'
import { WireLog } from '../wire-log'
import { makeHandle, MessageQueue } from '../query'

function buildHandle(): {
  handle: ReturnType<typeof makeHandle>
  control: ControlChannel
  written: JsonLine[]
} {
  const pass = new PassThrough()
  const written: JsonLine[] = []
  pass.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) written.push(JSON.parse(line))
    }
  })
  const control = new ControlChannel(new NdjsonWriter(pass))
  const handle = makeHandle(
    new MessageQueue(),
    control,
    {} as unknown as ChildProcess,
    {},
    Promise.resolve({}),
    new WireLog(),
    () => {}
  )
  return { handle, control, written }
}

const flushed = async (written: JsonLine[]): Promise<JsonLine> => {
  while (written.length === 0) await new Promise((r) => setImmediate(r))
  return written[0]
}

describe('QueryHandle.getUsage', () => {
  it('asks for get_usage without the transcript scan', async () => {
    const { handle, control, written } = buildHandle()
    const p = handle.getUsage()

    const sent = await flushed(written)
    expect(sent).toMatchObject({
      type: 'control_request',
      request: { subtype: 'get_usage', skip_behaviors: true }
    })

    const response = { rate_limits_available: true, rate_limits: {}, behaviors: null }
    control.handleResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id: sent.request_id, response }
    })
    await expect(p).resolves.toEqual(response)
  })

  it('reads a null payload as an empty object', async () => {
    const { handle, control, written } = buildHandle()
    const p = handle.getUsage()
    const sent = await flushed(written)
    control.handleResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id: sent.request_id, response: null }
    })
    await expect(p).resolves.toEqual({})
  })
})
