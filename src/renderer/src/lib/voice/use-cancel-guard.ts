/**
 * Download turns into Cancel in the same spot (the notice pill's button, and the
 * Settings row's): a double click, or a held Enter whose keydown auto-repeats,
 * would land its second press on the Cancel that just replaced the button it
 * meant to press — and abort the download it just started. The two buttons are
 * keyed apart so focus does not carry over, and this ignores a press in the first
 * {@link CANCEL_GUARD_MS} of the Cancel being on screen.
 */

import { useCallback, useLayoutEffect, useRef } from 'react'

export const CANCEL_GUARD_MS = 500

/**
 * `armed()` is true once the button has been visible for {@link CANCEL_GUARD_MS}.
 * Pass whether the Cancel button is on screen now.
 */
export function useCancelGuard(visible: boolean): () => boolean {
  const since = useRef<number | null>(null)
  useLayoutEffect(() => {
    since.current = visible ? Date.now() : null
  }, [visible])
  return useCallback(
    () => since.current !== null && Date.now() - since.current >= CANCEL_GUARD_MS,
    []
  )
}
