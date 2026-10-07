/**
 * The PRODUCTION client's feed for contract tests (`OpencodeClient` +
 * `opencode-event-stream`), and a TCP relay that lets a test cut that feed
 * from the server side. Shared by the client and mapper contract files.
 */
import { createServer, type Server, type Socket, connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { OpencodeClient } from '../../../core/opencode/OpencodeClient'
import { eventSessionID } from '../../../core/opencode/protocol-v2/events'
import type {
  OpencodeFeedItem,
  SubscribeOptions
} from '../../../core/opencode/opencode-event-stream'

export const basic = (password: string) =>
  'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')

/** Runs a production feed in the background and lets a test wait on what it saw. */
export function startFeed(client: OpencodeClient, options: SubscribeOptions = {}) {
  const controller = new AbortController()
  const items: OpencodeFeedItem[] = []
  const waiters = new Set<() => void>()
  let failure: unknown = null
  const wake = () => {
    for (const waiter of [...waiters]) waiter()
  }
  const done = (async () => {
    try {
      for await (const item of client.subscribeEvents({ ...options, signal: controller.signal })) {
        items.push(item)
        wake()
      }
    } catch (error) {
      failure = error
      wake()
    }
  })()
  const until = <R>(probe: () => R | undefined, label: string, timeoutMs = 30_000): Promise<R> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(
          new Error(
            `timed out waiting for ${label}; feed saw: ${items
              .map((i) => (i.kind === 'event' ? i.event.type : i.kind))
              .slice(-40)
              .join(', ')}`
          )
        )
      }, timeoutMs)
      const check = () => {
        const hit = probe()
        if (hit !== undefined || failure) {
          clearTimeout(timer)
          waiters.delete(check)
          if (hit !== undefined) resolve(hit)
          else reject(new Error(`feed failed: ${String(failure)}`))
        }
      }
      waiters.add(check)
      check()
    })
  const events = (sessionID: string, from = 0) =>
    items
      .slice(from)
      .flatMap((item) =>
        item.kind === 'event' && eventSessionID(item.event) === sessionID ? [item.event] : []
      )
  const turnEnd = (sessionID: string, from = 0) =>
    until(
      () =>
        events(sessionID, from).find((event) =>
          /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)
        ),
      `the turn end of ${sessionID}`
    )
  return {
    items,
    until,
    events,
    turnEnd,
    close: async () => {
      controller.abort()
      await done
    }
  }
}

/**
 * A loopback TCP relay in front of the engine, so a test can cut the event
 * stream from the SERVER side (every open socket destroyed) and hold the
 * client off for a while (new connections refused) — a hermetic stand-in for
 * the engine failing an overflowed subscriber or a network blip.
 */
export async function startRelay(target: string) {
  const { hostname, port } = new URL(target)
  const sockets = new Set<Socket>()
  let refusing = false
  const server: Server = createServer((inbound) => {
    if (refusing) {
      inbound.destroy()
      return
    }
    const outbound = connect(Number(port), hostname)
    sockets.add(inbound)
    sockets.add(outbound)
    const drop = () => {
      inbound.destroy()
      outbound.destroy()
      sockets.delete(inbound)
      sockets.delete(outbound)
    }
    inbound.on('error', drop).on('close', drop)
    outbound.on('error', drop).on('close', drop)
    inbound.pipe(outbound)
    outbound.pipe(inbound)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    cut(options: { refuse: boolean }) {
      refusing = options.refuse
      for (const socket of [...sockets]) socket.destroy()
      sockets.clear()
    },
    allow() {
      refusing = false
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}
