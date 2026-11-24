/**
 * The media generation catalog query, declared ONCE and served by both transports
 * (Settings › Media generation and the card's "Change model…" read it). `config`: a
 * base remote connection may read it. The result carries no `ok` key.
 */
import type { MediaCatalog } from '../../shared/media-generation'
import { listMediaModels } from '../services/media-catalog'
import type { CommandRegistration } from './command-registry'

export const MEDIA_CHANNELS = ['media:list-models'] as const

export function mediaCommands(): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    {
      channel: 'media:list-models',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<MediaCatalog> => listMediaModels()
    }
  ]
}
