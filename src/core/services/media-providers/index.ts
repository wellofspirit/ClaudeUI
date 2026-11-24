/**
 * The provider for a source. Contract stub: slice A fills it with the ChatGPT plan,
 * OpenAI and OpenRouter clients.
 */
import type { MediaSource } from '../../../shared/media-generation'
import type { MediaProvider } from './types'

export function mediaProviderFor(source: MediaSource): MediaProvider {
  throw new Error(`media-providers: no provider for ${source} yet`)
}
