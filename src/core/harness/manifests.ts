/**
 * The release manifests (ADR-082 §5): one JSON per harness under
 * `src/shared/harness-manifests/`, the single source of truth for what "Tested"
 * means. The `scripts/ensure-*.mjs` acquisition pipelines read the same files.
 */
import type { HarnessId, HarnessManifest } from '../../shared/harness-types'
import claude from '../../shared/harness-manifests/claude.json'
import opencode from '../../shared/harness-manifests/opencode.json'
import pi from '../../shared/harness-manifests/pi.json'
import codex from '../../shared/harness-manifests/codex.json'

const MANIFESTS: Record<HarnessId, HarnessManifest> = {
  claude: claude as HarnessManifest,
  opencode: opencode as HarnessManifest,
  pi: pi as HarnessManifest,
  codex: codex as HarnessManifest
}

export function harnessManifest(id: HarnessId): HarnessManifest {
  return MANIFESTS[id]
}
