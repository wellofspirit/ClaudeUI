/**
 * Helper for Layer 1 (unit) tests — renders a React component with pre-populated Zustand store.
 * No IPC wiring, no business logic — just store state → component rendering.
 */

import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'

/**
 * Render a component with optional store state overrides.
 *
 * Usage:
 *   import { useSessionStore } from '../stores/session-store'
 *
 *   beforeEach(() => {
 *     useSessionStore.setState({ ...initialState })
 *   })
 *
 *   renderWithStore(<MessageBubble message={msg} />)
 *
 * Note: Zustand stores are module singletons, so we just setState() before render.
 * No React context wrapper needed.
 */
export function renderWithStore(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
): RenderResult {
  return render(ui, options)
}
