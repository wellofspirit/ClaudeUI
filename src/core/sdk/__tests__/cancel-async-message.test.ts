/**
 * @vitest-environment node
 *
 * QueryHandle.cancelAsyncMessage → cli.js's native `cancel_async_message`
 * control request (docs/protocol-cc/07-control-outbound.md).
 *
 * It is the claude take-back since the `queue-control` patch's
 * `dequeue_message` was retired (the official binary rejects that subtype, so
 * recall silently did nothing there). The answer is a SUCCESS carrying
 * `{cancelled}`; `false` means cli.js does not hold that uuid, which is a
 * result, not an error. Answers verbatim from the 2026-09-24 official-binary
 * probe (`official.cancel.jsonl` L101 / L104).
 */
import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { ControlChannel } from '../control'
import { NdjsonWriter, type JsonLine } from '../protocol'
import { WireLog } from '../wire-log'
import { makeHandle, MessageQueue } from '../query'

const UUID = '3f137d3a-6083-4c2b-af9c-94feedd7797c'

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

async function answer(response: unknown): Promise<{
  sent: JsonLine
  result: Promise<{ cancelled: boolean }>
}> {
  const { handle, control, written } = buildHandle()
  const result = handle.cancelAsyncMessage(UUID)
  while (written.length === 0) await new Promise((r) => setImmediate(r))
  const sent = written[0]
  control.handleResponse({
    type: 'control_response',
    response: { subtype: 'success', request_id: sent.request_id, response }
  })
  return { sent, result }
}

describe('QueryHandle.cancelAsyncMessage', () => {
  it('sends the native cancel_async_message subtype with the message uuid', async () => {
    const { sent, result } = await answer({ cancelled: true })
    expect(sent).toMatchObject({
      type: 'control_request',
      request: { subtype: 'cancel_async_message', message_uuid: UUID }
    })
    await expect(result).resolves.toEqual({ cancelled: true })
  })

  it('passes a success answer of cancelled:false through as false', async () => {
    await expect((await answer({ cancelled: false })).result).resolves.toEqual({
      cancelled: false
    })
  })

  it('reads an answer without the field as not cancelled', async () => {
    // Only an explicit `true` may take a message off the card: a false positive
    // would hide a message that is still going to run.
    await expect((await answer({})).result).resolves.toEqual({ cancelled: false })
    await expect((await answer(null)).result).resolves.toEqual({ cancelled: false })
  })

  it('rejects on an error response', async () => {
    const { handle, control, written } = buildHandle()
    const p = handle.cancelAsyncMessage(UUID)
    while (written.length === 0) await new Promise((r) => setImmediate(r))
    control.handleResponse({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: written[0].request_id,
        error: 'cancel_async_message: message_uuid must be a string'
      }
    })
    await expect(p).rejects.toThrow('message_uuid must be a string')
  })
})
