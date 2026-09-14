/// <reference types="vite/client" />

import type { VerifierHandle } from './utils/verifier-hooks'

declare global {
  interface Window {
    /**
     * The real-app harness's read handle on renderer state — installed only when
     * the launch opted in (`CLAUDEUI_VERIFIER_HOOKS=1` / `--claudeui-verifier-hooks`;
     * see `src/shared/verifier-hooks.ts`). Absent in every normal run, which is
     * why it is optional here and why callers must probe before using it.
     *
     * Renderer-scoped on purpose: this declaration lives in the web tsconfig's
     * tree only, so main/preload code cannot reach for it by accident.
     */
    __claudeuiVerifier?: VerifierHandle
  }
}
