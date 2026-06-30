/**
 * Registry lookup: engineId → EngineToolMap.
 */

import type { EngineId } from '../../../../../shared/types'
import type { EngineToolMap } from '../../../../../shared/tool-kinds'
import { ClaudeEngineToolMap } from './ClaudeEngineToolMap'
import { OpencodeEngineToolMap } from './OpencodeEngineToolMap'

export function engineToolMap(engineId: EngineId): EngineToolMap {
  if (engineId === 'opencode') return OpencodeEngineToolMap
  return ClaudeEngineToolMap
}
