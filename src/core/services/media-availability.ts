/**
 * Which of ClaudeUI's media tools an engine is offered now: its toggle is on and a model resolves for
 * that kind (the setting is not Off and a connected source has one). opencode's session ruleset reads
 * it to hide ours when unusable and opencode's own tools when ours is offered (`mediaToolRules`); pi
 * reads it per spawn (a kind that is Off gets no tool).
 *
 * {@link mediaKindsEnabled} is the part that needs no I/O (the toggle and Off), for a spawn that must not
 * await (Claude's: `ClaudeSession.run` reaches the query in the same tick).
 */
import { MEDIA_KINDS, resolveMediaGeneration, type MediaKind } from '../../shared/media-generation'
import { appSetting } from './app-settings'
import { resolveMediaModel } from './media-catalog'

type MediaEngine = 'claude' | 'pi' | 'opencode'

/** The kinds the engine's toggle and the settings allow: on for the engine and not Off. Connection is not read. */
export function mediaKindsEnabled(engine: MediaEngine): Record<MediaKind, boolean> {
  const settings = resolveMediaGeneration(appSetting('mediaGeneration'))
  const on = settings.engines[engine]
  return {
    image: on && settings.imageModel !== 'off',
    video: on && settings.videoModel !== 'off'
  }
}

export async function mediaOffered(engine: MediaEngine): Promise<Record<MediaKind, boolean>> {
  const enabled = mediaKindsEnabled(engine)
  const usable = async (kind: MediaKind): Promise<boolean> => {
    if (!enabled[kind]) return false
    try {
      return !('error' in (await resolveMediaModel(kind, undefined, false)))
    } catch {
      return false
    }
  }
  const [image, video] = await Promise.all(MEDIA_KINDS.map(usable))
  return { image, video }
}
