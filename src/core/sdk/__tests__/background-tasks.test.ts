/**
 * @vitest-environment node
 *
 * QueryHandle.backgroundTask → cli.js's native `background_tasks` control
 * request (docs/protocol-cc/07-control-outbound.md §7.3).
 *
 * The retired `background-task` patch answered the singular `background_task`,
 * which the official binary rejects as an unsupported subtype, so the button
 * silently did nothing there. The native answer to a request naming a
 * tool_use_id is a SUCCESS carrying `{backgrounded}`: `false` means cli.js has
 * no foreground task with that id, which is a result, not an error.
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

async function answer(response: unknown): Promise<{
  sent: JsonLine
  result: Promise<{ backgrounded: boolean }>
}> {
  const { handle, control, written } = buildHandle()
  const result = handle.backgroundTask('toolu_bash_1')
  while (written.length === 0) await new Promise((r) => setImmediate(r))
  const sent = written[0]
  control.handleResponse({
    type: 'control_response',
    response: { subtype: 'success', request_id: sent.request_id, response }
  })
  return { sent, result }
}

describe('QueryHandle.backgroundTask', () => {
  it('sends the native background_tasks subtype with the tool_use id', async () => {
    const { sent, result } = await answer({ backgrounded: true })
    expect(sent).toMatchObject({
      type: 'control_request',
      request: { subtype: 'background_tasks', tool_use_id: 'toolu_bash_1' }
    })
    await expect(result).resolves.toEqual({ backgrounded: true })
  })

  it('passes a success answer of backgrounded:false through as false', async () => {
    const { result } = await answer({ backgrounded: false })
    await expect(result).resolves.toEqual({ backgrounded: false })
  })

  it('reads an answer without the field as not backgrounded', async () => {
    // `{}` is cli.js's answer to the no-id (background-everything) form; a
    // request that named an id and got it back cannot claim that id moved.
    await expect((await answer({})).result).resolves.toEqual({ backgrounded: false })
    await expect((await answer(null)).result).resolves.toEqual({ backgrounded: false })
  })

  it('rejects on an error response', async () => {
    const { handle, control, written } = buildHandle()
    const p = handle.backgroundTask('toolu_bash_1')
    while (written.length === 0) await new Promise((r) => setImmediate(r))
    control.handleResponse({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: written[0].request_id,
        error: 'Background tasks are disabled in this session.'
      }
    })
    await expect(p).rejects.toThrow('Background tasks are disabled')
  })
})
