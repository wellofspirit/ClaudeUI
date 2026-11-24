/**
 * Helpers the three media provider clients share: error text that is short and credential-free,
 * the image response shape OpenAI and OpenRouter both answer, and an abortable sleep.
 */
import { MediaProviderError } from './types'

/** Provider error text shown on the card, in the ledger and to the agent. */
export const MAX_ERROR_CHARS = 500

/** Cut to {@link MAX_ERROR_CHARS} and mask any of `secrets` that the provider echoed back. */
export function safeMessage(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/\s+/g, ' ').trim()
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]')
  }
  // Bearer tokens and `sk-` style keys the provider did not echo from us but might quote.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
  return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS - 1)}…` : out
}

/** The provider's own words from a non-OK response: `error.message`, `message`, `detail`, else the raw text. */
export async function failureFrom(
  label: string,
  response: Response,
  secrets: readonly string[]
): Promise<MediaProviderError> {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      const err = body.error
      const candidate =
        (typeof err === 'string' ? err : (err as { message?: unknown } | undefined)?.message) ??
        body.message ??
        body.detail
      detail = typeof candidate === 'string' ? candidate : text
    } catch {
      detail = text
    }
  } catch {
    /* an unreadable body leaves just the status */
  }
  const message = `${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`
  return new MediaProviderError(safeMessage(message, secrets), response.status)
}

export function dataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** `1536x1024` → dimensions; anything else (`auto`) → none. */
export function parseSize(size: unknown): { width?: number; height?: number } {
  const m = typeof size === 'string' ? size.match(/^(\d+)x(\d+)$/) : null
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {}
}

export function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface ImagesResponse {
  data?: Array<{ b64_json?: string | null; url?: string | null; revised_prompt?: string | null }>
  size?: string
  usage?: { cost?: unknown } & Record<string, unknown>
}

/** The first image of an OpenAI-style response as bytes; `url` results are fetched without credentials. */
export async function imageBytes(
  label: string,
  body: ImagesResponse,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<{ bytes: Buffer; revisedPrompt?: string }> {
  const item = body.data?.[0]
  if (!item) throw new MediaProviderError(`${label} returned no image`)
  const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
  if (item.b64_json) return { bytes: Buffer.from(item.b64_json, 'base64'), revisedPrompt }
  if (item.url && /^https:\/\//i.test(item.url)) {
    const res = await fetchImpl(item.url, { signal })
    if (!res.ok)
      throw new MediaProviderError(
        `${label} image download failed (HTTP ${res.status})`,
        res.status
      )
    return { bytes: Buffer.from(await res.arrayBuffer()), revisedPrompt }
  }
  throw new MediaProviderError(`${label} returned no image data`)
}

/** Wrap a thrown transport error (not an abort) so the message is short and credential-free. */
export function transportError(label: string, err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return err
  if (err instanceof MediaProviderError) return err
  const text = err instanceof Error ? err.message : String(err)
  return new MediaProviderError(safeMessage(`${label} request failed: ${text}`))
}
