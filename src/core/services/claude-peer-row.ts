/**
 * Find the transcript row of a peer message cli.js delivered (slice 1a, native
 * cross-session messages).
 *
 * ClaudeUI passes no `--replay-user-messages`, so when another Claude Code
 * process sends this session a message over cli.js's own socket, the only things
 * on stdout are `command_lifecycle` frames naming the message's uuid and, at the
 * end of the turn, a `result` — never the text. The text and the sender are on
 * disk: cli.js writes the turn as a user row with that uuid, `isMeta: true` and
 * `origin: { kind: 'peer', from, name, body, … }`
 * (docs/research/session-tools/V1-probes.md §2.5). The row lands a moment after
 * the lifecycle frame, so the caller retries.
 */
import * as fs from 'fs'
import { peerRowParts } from './agent-note'

/** How much of the file's tail is searched: the row is among the last things written. */
const TAIL_BYTES = 512 * 1024

export interface PeerRow {
  fromTitle: string
  body: string
  /** Sent by another Claude Code process, not by a ClaudeUI session (no `hostInjected`). */
  native: boolean
}

/**
 * The peer row with this uuid; `'not-a-peer'` when the row IS in the tail but is no
 * peer message (a task notification, any other command), so the caller stops looking;
 * null when it is not (yet) there, so the caller tries again.
 */
export async function findPeerRow(
  file: string,
  uuid: string
): Promise<PeerRow | 'not-a-peer' | null> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(file, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    // The newest row is the likeliest: walk backwards.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes(uuid)) continue
      try {
        const row = JSON.parse(line) as {
          type?: string
          uuid?: string
          origin?: unknown
          turnOrigin?: unknown
          message?: { content?: unknown }
        }
        if (row.type !== 'user' || row.uuid !== uuid) continue
        return peerRowParts(row, row.message?.content) ?? 'not-a-peer'
      } catch {
        // a partial first line of the tail, or a row still being written
      }
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}
