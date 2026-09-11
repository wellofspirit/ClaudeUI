/**
 * Registry lookup: engineId → EngineToolMap.
 */

import type { EngineId } from '../../../../../shared/types'
import type { EngineToolMap } from '../../../../../shared/tool-kinds'
import { ClaudeEngineToolMap } from './ClaudeEngineToolMap'
import { OpencodeEngineToolMap } from './OpencodeEngineToolMap'
import { PiEngineToolMap } from './PiEngineToolMap'
import { CodexEngineToolMap } from './CodexEngineToolMap'

// `satisfies Record<EngineId, …>` makes a new engine a compile error until its
// tool map is added (rather than silently falling back to Claude's).
const ENGINE_TOOL_MAP = {
  codex: CodexEngineToolMap,
  claude: ClaudeEngineToolMap,
  opencode: OpencodeEngineToolMap,
  pi: PiEngineToolMap
} satisfies Record<EngineId, EngineToolMap>

export function engineToolMap(engineId: EngineId): EngineToolMap {
  return ENGINE_TOOL_MAP[engineId]
}
