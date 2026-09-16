/**
 * Layer 1 (unit) for `ImageBody` — Codex `imageGeneration`.
 *
 * The picture itself is NOT this body's job: `ToolCard` places the shared
 * `ToolResultImages` strip for every standard kind. What is pinned here is the
 * two facts the strip cannot carry, and the failure shape.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ImageBody } from '../ImageBody'
import type { KindBodyProps } from '../types'
import type { ContentBlock } from '../../../../../../../shared/types'
import type { ToolView } from '../../../../../../../shared/tool-kinds'

type ImageView = Extract<ToolView, { kind: 'image' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

function renderBody(view: ImageView, result?: ToolResultBlock): ReturnType<typeof render> {
  return render(
    <ImageBody
      {...({
        view,
        block: { type: 'tool_use', toolUseId: 'tu', toolName: 'imageGeneration', toolInput: {} },
        result,
        expanded: true,
        hideToolInput: false,
        isError: !!result?.isError
      } as unknown as KindBodyProps)}
    />
  )
}

describe('ImageBody', () => {
  it('shows the revised prompt and the saved path', () => {
    renderBody({
      kind: 'image',
      prompt: 'An isometric illustration of a dark desktop application window',
      savedPath: '~/.codex/images/img_01.png'
    })
    expect(screen.getByTestId('ImageBody.prompt').textContent).toContain('isometric illustration')
    expect(screen.getByTestId('ImageBody.savedPath').textContent).toBe('~/.codex/images/img_01.png')
  })

  it('renders nothing when the wire carried neither', () => {
    expect(renderBody({ kind: 'image' }).container.innerHTML).toBe('')
  })

  it('renders the usage-limit failure through the error branch', () => {
    renderBody(
      { kind: 'image' },
      {
        type: 'tool_result',
        toolUseId: 'tu',
        toolResult: 'Image generation limit reached. Resets at 2025-10-09T08:53:20.000Z.',
        isError: true
      }
    )
    expect(screen.getByTestId('ImageBody.error').textContent).toContain(
      'Image generation limit reached'
    )
  })

  it('renders nothing at all for a view of the wrong kind', () => {
    const { container } = render(
      <ImageBody
        {...({
          view: { kind: 'unknown', input: {} },
          block: { type: 'tool_use', toolUseId: 'tu', toolName: 'x' },
          expanded: true,
          hideToolInput: false,
          isError: false
        } as unknown as KindBodyProps)}
      />
    )
    expect(container.innerHTML).toBe('')
  })
})
