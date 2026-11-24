/**
 * OpenRouter with a vault API key: images (`POST /images/generations`, input images as
 * `input_references`: OpenRouter has no edits endpoint) and video (`POST /videos`, poll
 * `GET /videos/<id>`, download from `unsigned_urls` with the key). Wire shapes follow opencode's
 * `openai-images.ts` (`references` mode) and `openrouter-video.ts`
 * (`vendor/opencode-src/packages/ai/src/protocols/`). Only the key stored for `openrouter` is used:
 * a `derivedFrom` second key and a custom `baseUrl` are ignored, so the key goes only to
 * openrouter.ai.
 */
import { authVault } from '../../auth/vault/AuthVault'
import { pickNetFetch } from '../net-fetch'
import {
  dataUrl,
  failureFrom,
  finite,
  imageBytes,
  parseSize,
  safeMessage,
  sleep,
  transportError,
  type ImagesResponse
} from './http'
import {
  MediaProviderError,
  type MediaGenerateRequest,
  type MediaGenerateResult,
  type MediaProvider
} from './types'

const BASE = 'https://openrouter.ai/api/v1'
const LABEL = 'OpenRouter'
/** OpenRouter's app attribution headers (as the judge route sends). */
const ATTRIBUTION: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://github.com/wellofspirit/ClaudeUI',
  'X-Title': 'ClaudeUI'
}
const POLL_MS = 5_000
/** Consecutive poll failures (network or 5xx) tolerated before the job is given up. */
const MAX_POLL_FAILURES = 3

export interface OpenRouterDeps {
  fetch(): Promise<typeof fetch>
  apiKey(): Promise<string | null>
  /** Abortable wait between video polls. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

const defaultDeps: OpenRouterDeps = {
  fetch: () => pickNetFetch(),
  apiKey: async () => {
    const credential = await authVault.loadCredential('openrouter')
    return credential?.type === 'api_key' && credential.key ? credential.key : null
  },
  sleep
}

interface VideoJob {
  id?: string | null
  status?: string
  unsigned_urls?: string[] | null
  error?: string | null
  usage?: { cost?: unknown } | null
}

export function createOpenRouterProvider(deps: OpenRouterDeps = defaultDeps): MediaProvider {
  return {
    source: 'openrouter',
    async generate(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
      try {
        const key = await deps.apiKey()
        if (!key)
          throw new MediaProviderError('No OpenRouter API key is stored; add one in Settings.')
        const fetchImpl = await deps.fetch()
        const headers = {
          ...ATTRIBUTION,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        }
        return req.kind === 'image'
          ? await generateImage(req, fetchImpl, headers, key)
          : await generateVideo(req, fetchImpl, headers, key, deps)
      } catch (err) {
        throw transportError(LABEL, err, req.signal)
      }
    }
  }
}

async function generateImage(
  req: MediaGenerateRequest,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  key: string
): Promise<MediaGenerateResult> {
  const body = {
    model: req.modelId,
    prompt: req.prompt,
    n: 1,
    ...(req.images.length > 0
      ? {
          input_references: req.images.map((i) => ({
            type: 'image_url',
            image_url: { url: dataUrl(i.bytes, i.mime) }
          }))
        }
      : {})
  }
  const response = await fetchImpl(`${BASE}/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal
  })
  if (!response.ok) throw await failureFrom(LABEL, response, [key])
  const json = (await response.json()) as ImagesResponse
  const { bytes, revisedPrompt } = await imageBytes(LABEL, json, fetchImpl, req.signal)
  const costUsd = finite(json.usage?.cost)
  return {
    bytes,
    mime: sniffImageMime(bytes),
    ...parseSize(json.size),
    ...(revisedPrompt ? { revisedPrompt } : {}),
    ...(costUsd !== undefined ? { costUsd } : {})
  }
}

/** Gateway-hosted models choose their own format and say nothing about it: the bytes decide. */
function sniffImageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (bytes.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  return 'image/png'
}

async function generateVideo(
  req: MediaGenerateRequest,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  key: string,
  deps: OpenRouterDeps
): Promise<MediaGenerateResult> {
  const frames = req.images.slice(0, 2).map((image, index) => ({
    type: 'image_url',
    image_url: { url: dataUrl(image.bytes, image.mime) },
    frame_type: index === 0 ? 'first_frame' : 'last_frame'
  }))
  const create = await fetchImpl(`${BASE}/videos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: req.modelId,
      prompt: req.prompt,
      ...(frames.length > 0 ? { frame_images: frames } : {}),
      ...(req.durationSeconds !== undefined ? { duration: req.durationSeconds } : {}),
      ...(req.aspect ? { aspect_ratio: req.aspect } : {})
    }),
    signal: req.signal
  })
  if (!create.ok) throw await failureFrom(LABEL, create, [key])
  const started = (await create.json()) as VideoJob
  if (!started.id) throw new MediaProviderError('OpenRouter did not return a video job id.')
  const jobId = started.id
  req.onProviderJobId?.(jobId)

  let failures = 0
  for (;;) {
    await deps.sleep(POLL_MS, req.signal)
    let job: VideoJob
    try {
      const poll = await fetchImpl(`${BASE}/videos/${encodeURIComponent(jobId)}`, {
        headers,
        signal: req.signal
      })
      if (!poll.ok) {
        if (poll.status >= 500 && ++failures < MAX_POLL_FAILURES) continue
        throw await failureFrom(LABEL, poll, [key])
      }
      job = (await poll.json()) as VideoJob
      failures = 0
    } catch (err) {
      if (req.signal.aborted || err instanceof MediaProviderError) throw err
      if (++failures < MAX_POLL_FAILURES) continue
      throw err
    }
    const status = job.status ?? 'pending'
    if (status === 'pending' || status === 'in_progress') continue
    if (status !== 'completed') {
      throw new MediaProviderError(
        safeMessage(`OpenRouter video job ${status}${job.error ? `: ${job.error}` : ''}`, [key])
      )
    }
    const url = job.unsigned_urls?.[0]
    if (!url) throw new MediaProviderError('OpenRouter completed the video without a download URL.')
    const bytes = await download(url, fetchImpl, key, req.signal)
    const costUsd = finite(job.usage?.cost)
    return {
      bytes,
      mime: 'video/mp4',
      ...(req.durationSeconds !== undefined ? { durationSeconds: req.durationSeconds } : {}),
      ...(costUsd !== undefined ? { costUsd } : {})
    }
  }
}

/** The content URLs are OpenRouter's own and need the key; any other host never sees it. */
async function download(
  url: string,
  fetchImpl: typeof fetch,
  key: string,
  signal: AbortSignal
): Promise<Buffer> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new MediaProviderError('OpenRouter returned an invalid video URL.')
  }
  if (target.protocol !== 'https:')
    throw new MediaProviderError('OpenRouter returned a non-HTTPS video URL.')
  const ours = target.hostname === 'openrouter.ai' || target.hostname.endsWith('.openrouter.ai')
  const res = await fetchImpl(target.toString(), {
    ...(ours ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    signal
  })
  if (!res.ok) throw await failureFrom(`${LABEL} video download`, res, [key])
  return Buffer.from(await res.arrayBuffer())
}
