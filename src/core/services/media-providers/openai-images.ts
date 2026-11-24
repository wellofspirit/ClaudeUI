/**
 * OpenAI Images with a vault API key: `POST api.openai.com/v1/images/generations` (JSON) and
 * `/images/edits` (multipart, `image[]`). Only the key stored for `openai` is used: a
 * `derivedFrom` second key and a custom `baseUrl` on the shared provider are ignored, so the key
 * only ever goes to api.openai.com.
 */
import { authVault } from '../../auth/vault/AuthVault'
import { pickNetFetch } from '../net-fetch'
import {
  failureFrom,
  finite,
  imageBytes,
  parseSize,
  transportError,
  type ImagesResponse
} from './http'
import {
  MediaProviderError,
  type MediaGenerateRequest,
  type MediaGenerateResult,
  type MediaProvider
} from './types'

const BASE = 'https://api.openai.com/v1'
const LABEL = 'OpenAI'

export interface OpenAiImagesDeps {
  fetch(): Promise<typeof fetch>
  apiKey(): Promise<string | null>
}

const defaultDeps: OpenAiImagesDeps = {
  fetch: () => pickNetFetch(),
  apiKey: async () => {
    const credential = await authVault.loadCredential('openai')
    return credential?.type === 'api_key' && credential.key ? credential.key : null
  }
}

/** GPT Image models take `output_format` and quality tiers; DALL·E ones reject them. */
function isGptImage(modelId: string): boolean {
  return /^(gpt-image|chatgpt-image)/.test(modelId)
}

export function createOpenAiImagesProvider(deps: OpenAiImagesDeps = defaultDeps): MediaProvider {
  return {
    source: 'openai',
    async generate(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
      if (req.kind !== 'image') throw new MediaProviderError('OpenAI makes images only here.')
      try {
        const key = await deps.apiKey()
        if (!key) throw new MediaProviderError('No OpenAI API key is stored; add one in Settings.')
        const fetchImpl = await deps.fetch()
        const gpt = isGptImage(req.modelId)
        const fields: Record<string, string> = {
          model: req.modelId,
          prompt: req.prompt,
          n: '1',
          ...(gpt ? { output_format: 'png', ...(req.quality ? { quality: req.quality } : {}) } : {})
        }
        const edit = req.images.length > 0
        const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
        let body: string | FormData
        if (edit) {
          const form = new FormData()
          for (const [name, value] of Object.entries(fields)) form.append(name, value)
          req.images.forEach((image, index) => {
            form.append(
              'image[]',
              new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
              `image-${index}`
            )
          })
          body = form
        } else {
          headers['Content-Type'] = 'application/json'
          body = JSON.stringify({ ...fields, n: 1 })
        }
        const response = await fetchImpl(`${BASE}/images/${edit ? 'edits' : 'generations'}`, {
          method: 'POST',
          headers,
          body,
          signal: req.signal
        })
        if (!response.ok) throw await failureFrom(LABEL, response, [key])
        const json = (await response.json()) as ImagesResponse
        const { bytes, revisedPrompt } = await imageBytes(LABEL, json, fetchImpl, req.signal)
        const costUsd = finite(json.usage?.cost)
        return {
          bytes,
          mime: 'image/png',
          ...parseSize(json.size),
          ...(revisedPrompt ? { revisedPrompt } : {}),
          ...(costUsd !== undefined ? { costUsd } : {})
        }
      } catch (err) {
        throw transportError(LABEL, err, req.signal)
      }
    }
  }
}
