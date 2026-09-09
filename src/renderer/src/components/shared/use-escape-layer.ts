/**
 * use-escape-layer — ONE Escape stack for every overlay in the app.
 *
 * Escape must go one level up, not all the way back to the beginning. Before
 * this hook only `SheetFrame` kept a stack of its own, so a press with a model
 * editor open over a provider dialog over the Manage sheet fell through both
 * dialogs (neither listened) and hit the sheet's capture-phase handler, which
 * closed the sheet — unmounting the dialog and the editor with it. Every
 * overlay registering here instead means a stack of sheet › dialog › editor ›
 * confirm peels exactly one layer per press.
 *
 * WHY A MODULE-LEVEL STACK. The overlays that must order themselves are not
 * parent and child: the Manage sheet's second frame for "Edit endpoint" is its
 * SIBLING, and a dialog's confirm is a sibling of the dialog. No context or ref
 * reaches from one to the other, so module scope is the only scope they share.
 *
 * WHY CAPTURE PHASE, AND WHY THE EVENT IS STOPPED. `SettingsDialog` keeps a
 * bubble-phase Escape listener on `document` that closes the whole dialog. A
 * capture-phase `stopPropagation()` on `document` runs before the event reaches
 * any target and prevents it bubbling back, so the dialog behind never sees a
 * key that a layer above already answered. Other capture listeners on
 * `document` — the lower layers — still fire, which is why each one checks that
 * it is on top and otherwise says nothing at all, INCLUDING not stopping the
 * event: stopping it is the top layer's job.
 *
 * A MENU IS A LAYER ONLY WHILE IT IS OPEN. Dropdown menus (`SelectMenu`,
 * `ModelPicker`) are mounted the whole time their row is on screen, so they
 * cannot register on mount the way an overlay does — a settings page holds a
 * dozen of them and the last-mounted one would swallow every press. They pass
 * their `open` flag as `active` instead: while the menu is closed the hook
 * registers NOTHING (no token, no listener) and the sheet behind keeps
 * answering; the moment the menu opens it becomes the top layer, so Escape
 * closes the menu and stops there rather than closing the sheet under it.
 */

import { useEffect, useRef } from 'react'

/** Every mounted layer's token, oldest first. The last entry answers Escape. */
const LAYERS: object[] = []

/**
 * Register this overlay as the topmost Escape layer while mounted. Escape
 * closes ONLY the topmost registered layer and stops the event there, so a
 * stack peels one layer per press.
 *
 * `enabled=false` keeps the layer registered — it is still on top, and the key
 * must not fall through to whatever is under it — but swallows Escape without
 * closing: a confirm whose action is mid-flight must not be dismissed under the
 * user.
 *
 * `active=false` is the opposite: NOTHING is registered, so the layer is not in
 * the stack at all and whatever is under it answers Escape. Overlays leave it
 * at the default (they exist only while they are up); a menu passes its `open`
 * flag, because a closed menu must be invisible to the stack.
 */
export function useEscapeLayer(onClose: () => void, enabled = true, active = true): void {
  /**
   * Both read through refs so the registration below depends on `active`
   * ALONE. Callers pass inline arrows (the endpoint sheet's `onClose`) whose
   * identity changes on every render of their parent, and re-registering means
   * re-pushing — which would make whichever layer last re-rendered the "top"
   * one regardless of mount order.
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    // Not a layer at all: a closed menu must let the sheet behind it answer.
    if (!active) return
    const token = {}
    LAYERS.push(token)
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (LAYERS[LAYERS.length - 1] !== token) return
      e.stopPropagation()
      if (!enabledRef.current) return
      closeRef.current()
    }
    document.addEventListener('keydown', handler, true)
    return () => {
      document.removeEventListener('keydown', handler, true)
      const at = LAYERS.indexOf(token)
      if (at !== -1) LAYERS.splice(at, 1)
    }
  }, [active])
}

/**
 * Test-only: how many layers are registered right now. A leaked registration
 * would silently make the NEXT overlay's Escape a no-op, which is invisible
 * from any single component's tests.
 */
export function __escapeLayerCount(): number {
  return LAYERS.length
}
