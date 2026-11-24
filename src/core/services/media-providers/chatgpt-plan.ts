/**
 * The ChatGPT plan's image endpoint (`POST chatgpt.com/backend-api/codex/images/{generations,edits}`),
 * called with the signed-in account's own token (the one place besides the judge route and the
 * usage read that holds it). The backend is not a published API: the plan fixes the model, quality
 * and size server-side, so only the prompt (and, for an edit, the images) matter.
 *
 * Edits are JSON with data-URL `images`; this endpoint rejects multipart. A 401 gets ONE retry on a
 * force-refreshed token, as `shared-providers/chatgpt-rate-limits.ts` does. The token never
 * reaches a log line or an error message.
 */
import { chatgptRequestHeaders } from '../../automode/judge-route'
import { credentialSync, type ChatgptInjectionToken } from '../../auth/vault/CredentialSync'
import { hostAppVersion } from '../../host'
import { pickNetFetch } from '../net-fetch'
import {
  dataUrl,
  failureFrom,
  imageBytes,
  parseSize,
  transportError,
  type ImagesResponse
} from './http'
import { recordPlanUsage } from './plan-usage'
import {
  MediaProviderError,
  type MediaGenerateRequest,
  type MediaGenerateResult,
  type MediaProvider
} from './types'

const BASE = 'https://chatgpt.com/backend-api/codex'
const LABEL = 'ChatGPT'

export interface ChatgptPlanDeps {
  fetch(): Promise<typeof fetch>
  /** The active account's token; `force` refreshes it first. */
  token(force: boolean): Promise<ChatgptInjectionToken | null>
  appVersion(): string
}

const defaultDeps: ChatgptPlanDeps = {
  fetch: () => pickNetFetch(),
  // `Infinity` puts any expiry inside the refresh margin, as the judge route's force does.
  token: (force) => credentialSync.injectionTokenFor(null, force ? Infinity : undefined),
  appVersion: () => hostAppVersion()
}

export function createChatgptPlanProvider(deps: ChatgptPlanDeps = defaultDeps): MediaProvider {
  return {
    source: 'chatgpt-plan',
    async generate(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
      if (req.kind !== 'image') throw new MediaProviderError('The ChatGPT plan makes images only.')
      const edit = req.images.length > 0
      const url = `${BASE}/images/${edit ? 'edits' : 'generations'}`
      const body = JSON.stringify({
        model: 'gpt-image-2',
        prompt: req.prompt,
        n: 1,
        output_format: 'png',
        ...(edit
          ? { images: req.images.map((i) => ({ image_url: dataUrl(i.bytes, i.mime) })) }
          : {})
      })
      try {
        const fetchImpl = await deps.fetch()
        let token = await deps.token(false)
        if (!token) {
          throw new MediaProviderError('ChatGPT is not signed in; sign in again in Settings.')
        }
        let response: Response | undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          response = await fetchImpl(url, {
            method: 'POST',
            headers: {
              ...chatgptRequestHeaders(token, deps.appVersion()),
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body,
            signal: req.signal
          })
          if (response.status === 401 && attempt === 0) {
            const fresh = await deps.token(true)
            // A refresh that changed nothing would only 401 again.
            if (!fresh || fresh.accessToken === token.accessToken) break
            token = fresh
            continue
          }
          break
        }
        if (!response) throw new MediaProviderError('ChatGPT returned no response.')
        const secrets = [token.accessToken]
        // Usage headers ride on errors too (a rate limit states how full the plan is).
        const planUsage = recordPlanUsage(response.headers)
        if (!response.ok) {
          if (response.status === 401) {
            throw new MediaProviderError(
              'ChatGPT rejected the sign-in; sign in again in Settings.',
              401
            )
          }
          throw await failureFrom(LABEL, response, secrets)
        }
        const json = (await response.json()) as ImagesResponse
        const { bytes, revisedPrompt } = await imageBytes(LABEL, json, fetchImpl, req.signal)
        return {
          bytes,
          mime: 'image/png',
          ...parseSize(json.size),
          ...(revisedPrompt ? { revisedPrompt } : {}),
          ...(planUsage ? { planUsage } : {})
        }
      } catch (err) {
        throw transportError(LABEL, err, req.signal)
      }
    }
  }
}
