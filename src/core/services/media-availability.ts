/**
 * Which of ClaudeUI's media tools an engine is offered now: its toggle is on and a model resolves for
 * that kind (the setting is not Off and a connected source has one). opencode's session ruleset reads
 * it to hide ours when unusable and opencode's own tools when ours is offered (`mediaToolRules`).
 */
import { resolveMediaGeneration, type MediaKind } from '../../shared/media-generation'
import { appSetting } from './app-settings'
import { resolveMediaModel } from './media-catalog'

export async function mediaOffered(
  engine: 'claude' | 'pi' | 'opencode'
): Promise<Record<MediaKind, boolean>> {
  if (!resolveMediaGeneration(appSetting('mediaGeneration')).engines[engine]) {
    return { image: false, video: false }
  }
  const usable = async (kind: MediaKind): Promise<boolean> => {
    try {
      return !('error' in (await resolveMediaModel(kind, undefined, false)))
    } catch {
      return false
    }
  }
  const [image, video] = await Promise.all([usable('image'), usable('video')])
  return { image, video }
}
