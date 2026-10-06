/**
 * The re-read half of the 2.x reconnect contract (ADR-093 S4): what is read,
 * in which order, and the extra round for a child the re-read itself links.
 */
import { describe, expect, it, vi } from 'vitest'
import type { OpencodeEvent } from '../protocol-v2/events'
import type { Session_Message_Info } from '../protocol-v2/openapi'
import { OpencodeEventMapper } from '../v2-event-mapper'
import { reconcileAfterReconnect, type OpencodeStateReader } from '../v2-reconnect'

const SID = 'ses_own'
const MODEL = { providerID: 'p', id: 'm' }

function reader(
  rows: Record<string, Session_Message_Info[]>,
  order: string[]
): OpencodeStateReader {
  return {
    activeSessions: vi.fn(async () => {
      order.push('active')
      return {}
    }),
    listMessages: vi.fn(async (id: string) => {
      order.push(`messages:${id}`)
      if (!rows[id]) throw new Error('404')
      return rows[id]
    }),
    listPermissionRequests: vi.fn(async () => []),
    listForms: vi.fn(async () => []),
    listInbox: vi.fn(async (id: string) => {
      order.push(`inbox:${id}`)
      return []
    })
  }
}

describe('reconcileAfterReconnect', () => {
  it('reads `active` first, the inbox only for the own session, and a child linked by the read in a second round', async () => {
    const mapper = new OpencodeEventMapper({ sessionID: SID })
    const start = {
      id: 'evt_1',
      type: 'session.execution.started',
      created: 1,
      data: { sessionID: SID }
    } as unknown as OpencodeEvent
    mapper.map(start)
    const rows: Record<string, Session_Message_Info[]> = {
      [SID]: [
        {
          id: 'msg_a',
          type: 'assistant',
          agent: 'build',
          model: MODEL,
          time: { created: 2 },
          content: [
            {
              type: 'tool',
              id: 'call_sub',
              name: 'subagent',
              state: {
                status: 'running',
                input: { agent: 'general' },
                metadata: { sessionID: 'ses_c' }
              },
              time: { created: 2 }
            }
          ]
        }
      ],
      ses_c: [
        {
          id: 'msg_c',
          type: 'assistant',
          agent: 'general',
          model: MODEL,
          time: { created: 3 },
          content: [{ type: 'text', text: 'child so far' }]
        }
      ]
    }
    const order: string[] = []
    const out = await reconcileAfterReconnect(reader(rows, order), mapper)
    expect(order[0]).toBe('active')
    expect(order).toContain(`inbox:${SID}`)
    expect(order).not.toContain('inbox:ses_c')
    expect(order.indexOf('messages:ses_c')).toBeGreaterThan(order.indexOf(`messages:${SID}`))
    expect(out.map((o) => o.kind)).toEqual([
      'message',
      'subagent-started',
      // the own session is not active and wrote no idle: ended without one
      'stopped',
      // round 2: the child the first read linked
      'message'
    ])
    expect(out[3]).toMatchObject({ kind: 'message', ownerToolUseId: 'call_sub' })
    expect(mapper.followedSessions()).toEqual([SID, 'ses_c'])
  })

  it('a child that cannot be read is skipped; the own session failing is the caller’s error', async () => {
    const mapper = new OpencodeEventMapper({ sessionID: SID })
    await expect(reconcileAfterReconnect(reader({}, []), mapper)).rejects.toThrow('404')
  })
})
