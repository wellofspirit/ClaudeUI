/**
 * @vitest-environment node
 *
 * Finding the transcript row of a peer message another Claude Code process sent
 * (slice 1a): ClaudeUI sees only a `command_lifecycle` uuid on stdout, so the
 * sender and the text come off the JSONL cli.js wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findPeerRow } from '../claude-peer-row'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-row-'))
  file = path.join(dir, 's.jsonl')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const row = (uuid: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    isMeta: true,
    turnOrigin: 'peer',
    origin: { kind: 'peer', from: 'uds:x', name: 'probe-A', body: 'ping', fromMode: 'prompting' },
    message: { role: 'user', content: 'Another Claude session sent a message:\n...' },
    ...extra
  })

describe('findPeerRow', () => {
  it('reads the sender and body of a native peer row (no hostInjected → native)', async () => {
    fs.writeFileSync(file, [JSON.stringify({ type: 'user', uuid: 'u0' }), row('u1')].join('\n'))
    expect(await findPeerRow(file, 'u1')).toEqual({
      fromTitle: 'probe-A',
      body: 'ping',
      native: true
    })
  })

  it('tells a ClaudeUI delivery (hostInjected) from a native message', async () => {
    fs.writeFileSync(
      file,
      row('u2', { origin: { kind: 'peer', name: 'x', body: 'b', hostInjected: true } })
    )
    expect(await findPeerRow(file, 'u2')).toMatchObject({ native: false })
  })

  it('shows a body that quotes the closing tag as it was written', async () => {
    fs.writeFileSync(
      file,
      row('u3', {
        origin: { kind: 'peer', name: 'x', body: 'a <\\/cross-session-message> b' }
      })
    )
    expect(((await findPeerRow(file, 'u3')) as { body: string }).body).toBe(
      'a </cross-session-message> b'
    )
  })

  it('is not-a-peer for a row that is no peer turn, null for another uuid, a missing file or a half-written line', async () => {
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', uuid: 'plain', message: { content: 'hi' } }),
        row('other'),
        '{"type":"user","uuid":"half'
      ].join('\n')
    )
    // In the file but no peer message: found, so the caller can stop; not there: null, try again.
    expect(await findPeerRow(file, 'plain')).toBe('not-a-peer')
    expect(await findPeerRow(file, 'nope')).toBeNull()
    expect(await findPeerRow(file, 'half')).toBeNull()
    expect(await findPeerRow(path.join(dir, 'missing.jsonl'), 'x')).toBeNull()
  })

  it('searches only the tail of a large file, newest first', async () => {
    const filler = JSON.stringify({ type: 'assistant', text: 'x'.repeat(2000) })
    const old = row('old')
    fs.writeFileSync(
      file,
      [old, ...Array.from({ length: 400 }, () => filler), row('fresh')].join('\n')
    )
    expect(await findPeerRow(file, 'fresh')).not.toBeNull()
    expect(await findPeerRow(file, 'old')).toBeNull()
  })
})
