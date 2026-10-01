/**
 * Test fixtures for the harness installer: tar / tar.gz / zip archives built
 * in memory, and a fake `fetch` answering from a route table. Nothing here
 * touches the network.
 */
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'

export const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex')
export const sha512b64 = (data: Buffer | string): string =>
  createHash('sha512').update(data).digest('base64')

export interface TarEntryOptions {
  /** '0' file (default), '5' directory, '1' hardlink, '2' symlink, 'x' pax, 'L' GNU long name. */
  type?: string
  mode?: number
  linkname?: string
  prefix?: string
}

function field(header: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf8').copy(header, offset, 0, length)
}

function octalField(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

/** One ustar entry (header + padded data) with a valid checksum. */
export function tarEntry(
  name: string,
  body: Buffer | string = '',
  opts: TarEntryOptions = {}
): Buffer {
  const data = Buffer.from(body)
  const header = Buffer.alloc(512)
  field(header, name, 0, 100)
  field(header, octalField(opts.mode ?? 0o644, 8), 100, 8)
  field(header, octalField(0, 8), 108, 8)
  field(header, octalField(0, 8), 116, 8)
  field(header, octalField(data.length, 12), 124, 12)
  field(header, octalField(0, 12), 136, 12)
  header.fill(0x20, 148, 156)
  field(header, opts.type ?? '0', 156, 1)
  if (opts.linkname) field(header, opts.linkname, 157, 100)
  field(header, 'ustar\0', 257, 6)
  field(header, '00', 263, 2)
  if (opts.prefix) field(header, opts.prefix, 345, 155)
  let sum = 0
  for (const byte of header) sum += byte
  field(header, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  data.copy(padded)
  return Buffer.concat([header, padded])
}

/** A pax extended header setting `path` for the next entry. */
export function paxPath(value: string): Buffer {
  const record = (len: number): string => `${len} path=${value}\n`
  let len = record(0).length
  while (record(len).length !== len) len = record(len).length
  return tarEntry('PaxHeader', record(len), { type: 'x' })
}

export function tar(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)])
}

export function tgz(entries: Buffer[]): Buffer {
  return gzipSync(tar(entries))
}

export interface ZipEntry {
  name: string
  body?: Buffer | string
  /** 0 stored, 8 deflated (default). */
  method?: 0 | 8
  /** Unix mode incl. file type bits, e.g. 0o100755, 0o120777 for a symlink. */
  unixMode?: number
}

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.from(e.body ?? '')
    const method = e.method ?? 8
    const comp = method === 8 ? deflateRawSync(data) : data
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, comp)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((e.unixMode ?? 0) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

// ── fetch ─────────────────────────────────────────────────────────────────────

export type Route =
  | {
      status?: number
      body?: Buffer | string | null
      headers?: Record<string, string>
      /** A 302 to this URL. */
      redirect?: string
    }
  | ((init: RequestInit | undefined) => Response | Promise<Response>)

export interface FakeFetch {
  fetch: typeof fetch
  /** Every URL requested, in order (query strings included). */
  calls: string[]
  routes: Map<string, Route>
}

export function fakeFetch(routes: Record<string, Route> = {}): FakeFetch {
  const table = new Map(Object.entries(routes))
  const calls: string[] = []
  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const url = input instanceof URL ? input.href : String(input)
    calls.push(url)
    init?.signal?.throwIfAborted()
    const route = table.get(url)
    if (!route) return new Response('not found', { status: 404 })
    if (typeof route === 'function') return route(init)
    if (route.redirect) {
      return new Response(null, { status: 302, headers: { location: route.redirect } })
    }
    const body = route.body ?? null
    return new Response(body === null ? null : new Uint8Array(Buffer.from(body)), {
      status: route.status ?? 200,
      headers: route.headers
    })
  }
  return { fetch: impl as typeof fetch, calls, routes: table }
}

/** A 200 whose body sends `first`, then never ends until the request is aborted. */
export function hangingBody(first: Buffer | string, onStart?: () => void): Route {
  return (init) => {
    const signal = init?.signal
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from(first)))
        onStart?.()
        signal?.addEventListener(
          'abort',
          () => controller.error(signal.reason ?? new Error('aborted')),
          {
            once: true
          }
        )
      }
    })
    return new Response(stream, { status: 200 })
  }
}
