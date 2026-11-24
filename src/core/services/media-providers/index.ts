/**
 * The provider for a source: the ChatGPT plan, OpenAI or OpenRouter client.
 */
import type { MediaSource } from '../../../shared/media-generation'
import { createChatgptPlanProvider } from './chatgpt-plan'
import { createOpenAiImagesProvider } from './openai-images'
import { createOpenRouterProvider } from './openrouter'
import type { MediaProvider } from './types'

export function mediaProviderFor(source: MediaSource): MediaProvider {
  switch (source) {
    case 'chatgpt-plan':
      return createChatgptPlanProvider()
    case 'openai':
      return createOpenAiImagesProvider()
    case 'openrouter':
      return createOpenRouterProvider()
  }
}
