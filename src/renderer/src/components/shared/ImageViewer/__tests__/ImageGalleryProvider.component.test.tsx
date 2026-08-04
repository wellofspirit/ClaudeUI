/**
 * Layer 2: thumbnail → viewer wiring, against the real MessageBubble.
 *
 * The interesting behaviour is the index mapping: a thumbnail knows only
 * (messageId, index-within-message), and the provider has to resolve that to a
 * position in a gallery flattened across every user message.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { MessageBubble } from '../../../chat/MessageBubble'
import { ImageGalleryProvider, useImageGallery } from '../ImageGalleryProvider'
import type { ChatMessage, ContentBlock } from '../../../../../../shared/types'

const ROUTE = 'route-image-gallery'

function image(base64Data: string, fileName?: string): ContentBlock {
  return { type: 'image', mediaType: 'image/png', base64Data, fileName }
}

function userMessage(id: string, content: ContentBlock[]): ChatMessage {
  return { id, role: 'user', content, timestamp: 1 }
}

function renderChat(messages: ChatMessage[], wrap = true): ReturnType<typeof render> {
  const bubbles = messages.map((m) => (
    <MessageBubble
      key={m.id}
      message={m}
      pendingApprovals={[]}
      isLastAssistant={false}
      thinkingStartedAt={null}
    />
  ))
  return render(
    wrap ? <ImageGalleryProvider messages={messages}>{bubbles}</ImageGalleryProvider> : <>{bubbles}</>
  )
}

describe('ImageGalleryProvider + MessageBubble thumbnails', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    document.body.style.overflow = ''
  })

  it('renders one clickable thumb per image block', () => {
    const { getAllByTestId } = renderChat([
      userMessage('m1', [{ type: 'text', text: 'look' }, image('AAA', 'a.png'), image('BBB')])
    ])
    const thumbs = getAllByTestId('MessageBubble.imageThumb')
    expect(thumbs).toHaveLength(2)
    expect(thumbs.map((t) => t.getAttribute('data-id'))).toEqual(['0', '1'])
    expect(thumbs[0]).not.toBeDisabled()
    expect(thumbs[0].getAttribute('aria-label')).toBe('View image a.png')
    expect(thumbs[1].getAttribute('aria-label')).toBe('View attached image')
    expect((thumbs[0].querySelector('img') as HTMLImageElement).src).toBe(
      'data:image/png;base64,AAA'
    )
  })

  it('opens the viewer at the clicked thumbnail, indexed across all messages', () => {
    const { getAllByTestId, getByTestId, queryByTestId } = renderChat([
      userMessage('m1', [image('AAA', 'a.png')]),
      userMessage('m2', [image('BBB', 'b.png'), image('CCC', 'c.png')])
    ])
    expect(queryByTestId('ImageViewerOverlay')).toBeNull()

    // Third thumb overall = second image of the second message.
    fireEvent.click(getAllByTestId('MessageBubble.imageThumb')[2])
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('3 / 3')
    expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('c.png')
    expect((getByTestId('ImageViewerOverlay.image') as HTMLImageElement).src).toBe(
      'data:image/png;base64,CCC'
    )
  })

  it('navigates the gallery in message order with the arrow keys', () => {
    const { getAllByTestId, getByTestId } = renderChat([
      userMessage('m1', [image('AAA', 'a.png')]),
      userMessage('m2', [image('BBB', 'b.png'), image('CCC', 'c.png')])
    ])
    fireEvent.click(getAllByTestId('MessageBubble.imageThumb')[0])
    expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('a.png')

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('b.png')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('c.png')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('b.png')
  })

  it('excludes assistant-message images from the attachments gallery', () => {
    const { getAllByTestId, getByTestId } = renderChat([
      { id: 'a1', role: 'assistant', content: [image('ZZZ', 'z.png')], timestamp: 1 },
      userMessage('m1', [image('AAA', 'a.png')])
    ])
    // The assistant bubble has no attachment strip at all.
    expect(getAllByTestId('MessageBubble.imageThumb')).toHaveLength(1)
    fireEvent.click(getAllByTestId('MessageBubble.imageThumb')[0])
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('1 / 1')
  })

  it('shows only the Attachments gallery when there are no tool-result images', () => {
    const { getAllByTestId, queryAllByTestId } = renderChat([
      userMessage('m1', [image('AAA')]),
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool_result', toolUseId: 't1', toolResult: 'done' }],
        timestamp: 2
      }
    ])
    fireEvent.click(getAllByTestId('MessageBubble.imageThumb')[0])
    expect(queryAllByTestId('ImageViewerOverlay.tab')).toHaveLength(0)
  })

  it('closes the viewer and leaves the chat intact', () => {
    const { getAllByTestId, getByTestId, queryByTestId } = renderChat([
      userMessage('m1', [image('AAA')])
    ])
    fireEvent.click(getAllByTestId('MessageBubble.imageThumb')[0])
    fireEvent.click(getByTestId('ImageViewerOverlay.close'))
    expect(queryByTestId('ImageViewerOverlay')).toBeNull()
    expect(getAllByTestId('MessageBubble.imageThumb')).toHaveLength(1)
  })

  it('renders inert thumbnails when no provider is mounted', () => {
    const { getAllByTestId, queryByTestId } = renderChat(
      [userMessage('m1', [image('AAA')])],
      false
    )
    const thumb = getAllByTestId('MessageBubble.imageThumb')[0]
    expect(thumb).toBeDisabled()
    fireEvent.click(thumb)
    expect(queryByTestId('ImageViewerOverlay')).toBeNull()
  })

  it('keeps the context value stable so memoised bubbles do not re-render', () => {
    // MessageBubble is memo()-wrapped; a context value that changed identity per
    // message update would defeat that on every streaming partial.
    const seen: unknown[] = []
    function Probe(): null {
      seen.push(useImageGallery())
      return null
    }
    const first = [userMessage('m1', [image('AAA')])]
    const { rerender } = render(
      <ImageGalleryProvider messages={first}>
        <Probe />
      </ImageGalleryProvider>
    )
    rerender(
      <ImageGalleryProvider messages={[...first, userMessage('m2', [image('BBB')])]}>
        <Probe />
      </ImageGalleryProvider>
    )
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])
  })
})
