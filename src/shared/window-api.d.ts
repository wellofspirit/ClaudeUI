/**
 * The `window.api` ambient declaration.
 *
 * Lives in `src/shared/` rather than next to the preload for a TypeScript reason:
 * a `.d.ts` sitting beside an implementation file of the same module name
 * (`src/preload/index.ts`) is treated as that file's declaration OUTPUT and is
 * dropped from any program that contains both. The node project includes the whole
 * `src/preload` tree, so it never loaded the augmentation — which only surfaced
 * once `src/test/helpers/boot-test-app.ts` (compiled in BOTH projects) started
 * reaching into renderer code for the SyncCore phase 4c replica.
 *
 * The `src/shared` tree is in both projects and has no `window-api.ts` to shadow
 * this file.
 */

import type { ClaudeAPI } from './types'

declare global {
  interface Window {
    api: ClaudeAPI
  }
}
