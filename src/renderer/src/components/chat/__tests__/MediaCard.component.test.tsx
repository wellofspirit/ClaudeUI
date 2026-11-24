/**
 * Layer 2: MediaCard — the card of a hosted generate_image / generate_video call. Its state is the
 * session's task records for the call's tool_use id (like TaskCard), so each test seeds the
 * records the host job service emits and asserts the card's `data-state` and parts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import { makePendingApproval, makeTaskNotification } from '@test/factories/messages'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'
import type { MediaCatalog, MediaJobResult } from '../../../../../shared/media-generation'
import { mediaToolView } from '../../../../../shared/media-tool-view'
import { MediaCard } from '../MediaCard'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

const ROUTE = 'route-media-card'
const TOOL = 'mcp__claude-ui-media__generate_image'

const block = (toolUseId: string, toolName = TOOL): ToolUseBlock => ({
  type: 'tool_use',
  toolUseId,
  toolName,
  toolInput: {}
})
const imageView = (input: Record<string, unknown> = { prompt: 'a red fox' }) =>
  mediaToolView('image', input)

const media = (over: Partial<MediaJobResult> = {}): MediaJobResult => ({
  kind: 'image',
  jobId: 'job1',
  path: '/repo/.claude/ui/media/s/job1.png',
  mime: 'image/png',
  bytes: 421_888,
  width: 1536,
  height: 1024,
  blobId: 'blob-1',
  modelLabel: 'ChatGPT Plan',
  source: 'chatgpt-plan',
  elapsedMs: 34_000,
  ...over
})

const CATALOG: MediaCatalog = {
  models: [
    {
      ref: 'chatgpt-plan',
      kind: 'image',
      source: 'chatgpt-plan',
      name: 'ChatGPT Plan',
      acceptsImages: true
    }
  ],
  connected: { 'chatgpt-plan': true, openai: false, openrouter: false },
  planUsage: { usedPercent: 12, resetsInSeconds: 4 * 3600, at: 1 }
}

describe('MediaCard', () => {
  let app: TestApp
  let stops: Array<{ toolUseId: string; isDispatch: unknown }>

  const renderCard = (
    toolUseId: string,
    over: Partial<React.ComponentProps<typeof MediaCard>> = {}
  ): ReturnType<typeof render> =>
    render(
      <MediaCard
        block={block(toolUseId)}
        view={imageView()}
        isPendingApproval={false}
        permissionMode="default"
        onApproval={async () => {}}
        {...over}
      />
    )
  const state = (): string | null => screen.getByTestId('MediaCard').getAttribute('data-state')

  beforeEach(async () => {
    app = await bootTestApp()
    stops = []
    app.bridge.ipcMain.handle('media:list-models', async () => CATALOG)
    app.bridge.ipcMain.handle(
      'session:stop-task',
      async (_e, _rid: string, toolUseId: string, isDispatch?: unknown) => {
        stops.push({ toolUseId, isDispatch })
        return { success: true }
      }
    )
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('approval: shows the prompt, the save path and the model chip, and decides through the buttons', async () => {
    const onApproval = vi.fn(async () => {})
    renderCard('tu1', {
      view: imageView({ prompt: 'a red fox', path: 'out/fox.png', images: ['in/src.png'] }),
      approval: makePendingApproval({ toolName: TOOL, toolUseId: 'tu1' }),
      isPendingApproval: true,
      onApproval
    })
    expect(state()).toBe('approval')
    expect(screen.getByTestId('MediaCard.prompt')).toHaveTextContent('a red fox')
    expect(screen.getByTestId('MediaCard.savePath')).toHaveTextContent('out/fox.png')
    // The source picture has no preview in the harness: its path is shown instead.
    expect(screen.getByTestId('MediaCard.sourcePath')).toHaveTextContent('in/src.png')
    expect(await screen.findByText('ChatGPT Plan · included')).toBeInTheDocument()
    expect(await screen.findByTestId('MediaCard.planUsage')).toHaveTextContent('12% used')
    expect(screen.getByTestId('ApprovalButtons')).toBeInTheDocument()
  })

  it('a call with no task record yet reads running, without a clock', () => {
    renderCard('tu2')
    expect(state()).toBe('running')
    expect(screen.queryByTestId('MediaCard.elapsed')).not.toBeInTheDocument()
  })

  it('running: the clock counts from startedAt and Stop goes through session:stop-task', async () => {
    seed.taskStarted(ROUTE, {
      toolUseId: 'tu3',
      taskId: 'media-job3',
      taskType: 'media',
      startedAt: Date.now() - 21_000
    })
    renderCard('tu3')
    expect(state()).toBe('running')
    expect(screen.getByTestId('MediaCard.elapsed').textContent).toMatch(/^2\ds$/)
    await act(async () => {
      fireEvent.click(screen.getByTestId('MediaCard.stop'))
    })
    expect(stops).toEqual([{ toolUseId: 'tu3', isDispatch: false }])
    expect(screen.queryByTestId('MediaCard.stop')).not.toBeInTheDocument()
  })

  it('done image: the picture comes from the blob, with size, elapsed and plan chips', () => {
    seed.taskNotification(
      ROUTE,
      makeTaskNotification({ toolUseId: 'tu4', status: 'completed', media: media() })
    )
    renderCard('tu4')
    expect(state()).toBe('done')
    expect(screen.getByTestId('BlobImage')).toHaveAttribute('data-id', 'blob-1')
    const chips = screen.getAllByTestId('MediaCard.chip').map((c) => c.textContent)
    expect(chips).toContain('1536×1024 PNG · 412 KB')
    expect(chips).toContain('34.0s')
    expect(chips).toContain('ChatGPT Plan · included')
    expect(chips).toContain('size & quality set by plan')
    expect(screen.queryByTestId('MediaCard.compare')).not.toBeInTheDocument()
  })

  it('done image from a keyed provider shows the model and its cost, not the plan note', () => {
    seed.taskNotification(
      ROUTE,
      makeTaskNotification({
        toolUseId: 'tu5',
        media: media({ source: 'openrouter', modelLabel: 'qwen-image-3', costUsd: 0.03 })
      })
    )
    renderCard('tu5')
    const chips = screen.getAllByTestId('MediaCard.chip').map((c) => c.textContent)
    expect(chips).toContain('OpenRouter · qwen-image-3')
    expect(chips).toContain('$0.03')
    expect(chips.join('|')).not.toContain('set by plan')
  })

  it('an edit offers Before / After / Side by side and Revised prompt replaces Prompt', () => {
    seed.taskNotification(
      ROUTE,
      makeTaskNotification({
        toolUseId: 'tu6',
        media: media({ inputs: ['/repo/in.png'], revisedPrompt: 'a crimson fox, studio light' })
      })
    )
    renderCard('tu6')
    const options = screen.getAllByTestId('MediaCard.compareOption')
    expect(options.map((o) => o.getAttribute('data-id'))).toEqual(['before', 'after', 'side'])
    expect(options[1]).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(options[0])
    expect(screen.queryByTestId('BlobImage')).not.toBeInTheDocument()
    expect(screen.getByTestId('MediaCard.sourcePath')).toHaveTextContent('/repo/in.png')
    fireEvent.click(options[2])
    expect(screen.getByTestId('BlobImage')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('MediaCard.promptToggle'))
    expect(screen.getByTestId('MediaCard.prompt')).toHaveTextContent('a crimson fox')
    expect(screen.getByTestId('MediaCard.promptToggle')).toHaveTextContent('Revised prompt')
  })

  it('Reveal is offered only where the client has it (the web client has none)', () => {
    seed.taskNotification(ROUTE, makeTaskNotification({ toolUseId: 'tu7', media: media() }))
    const w = window.api as unknown as Record<string, unknown>
    const saved = { open: w.openPath, reveal: w.showInFolder }
    try {
      w.openPath = vi.fn(async () => ({}))
      w.showInFolder = undefined
      renderCard('tu7')
      expect(screen.getByTestId('MediaCard.open')).toBeInTheDocument()
      expect(screen.queryByTestId('MediaCard.reveal')).not.toBeInTheDocument()
      expect(screen.getByTestId('MediaCard.copyPath')).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('MediaCard.open'))
      expect(w.openPath).toHaveBeenCalledWith('/repo/.claude/ui/media/s/job1.png')
    } finally {
      w.openPath = saved.open
      w.showInFolder = saved.reveal
    }
  })

  it('done video without a file URL for this client shows the saved path, not a dead player', () => {
    seed.taskNotification(
      ROUTE,
      makeTaskNotification({
        toolUseId: 'tu8',
        media: media({
          kind: 'video',
          path: '/repo/generated/intro.mp4',
          mime: 'video/mp4',
          fileId: 'file-1',
          blobId: undefined,
          durationSeconds: 5,
          source: 'openrouter',
          modelLabel: 'kling-v3.0-std',
          costUsd: 0.42
        })
      })
    )
    renderCard('tu8', { block: block('tu8', 'generate_video'), view: mediaToolView('video', {}) })
    expect(screen.getByTestId('MediaCard')).toHaveAttribute('data-media', 'video')
    expect(screen.getByTestId('MediaCard.videoPath')).toHaveTextContent('/repo/generated/intro.mp4')
    expect(screen.getAllByTestId('MediaCard.chip').map((c) => c.textContent)).toContain('$0.42')
  })

  it('failed: the provider text, the model chip and a way to change the model', () => {
    const open = vi.fn()
    window.addEventListener('open-settings', open as EventListener)
    seed.taskNotification(
      ROUTE,
      makeTaskNotification({
        toolUseId: 'tu9',
        status: 'failed',
        summary: '0 endpoints available matching your guardrail restrictions',
        media: undefined
      })
    )
    renderCard('tu9', { view: imageView({ prompt: 'x', model: 'openrouter/mai/mai-image-2.7' }) })
    window.removeEventListener('open-settings', open as EventListener)
    expect(state()).toBe('error')
    expect(screen.getByTestId('MediaCard.error')).toHaveTextContent('0 endpoints available')
    expect(screen.getByTestId('MediaCard.guardrails')).toBeInTheDocument()
    window.addEventListener('open-settings', open as EventListener)
    fireEvent.click(screen.getByTestId('MediaCard.changeModel'))
    window.removeEventListener('open-settings', open as EventListener)
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      page: 'media',
      group: 'models'
    })
  })

  it('a refused call (error result, no job) is an error card without a guardrails link', () => {
    renderCard('tu10', {
      result: {
        type: 'tool_result',
        toolUseId: 'tu10',
        toolResult: 'path outside the workspace',
        isError: true
      }
    })
    expect(state()).toBe('error')
    expect(screen.getByTestId('MediaCard.error')).toHaveTextContent('path outside the workspace')
    expect(screen.queryByTestId('MediaCard.guardrails')).not.toBeInTheDocument()
  })

  it('older finished cards collapse to one row; the newest keep their picture; a click expands', () => {
    const msgs: ChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 1,
        content: ['old', 'n1', 'n2', 'n3', 'n4'].map((id) => block(id))
      }
    ]
    useSessionStore.setState((s) => ({
      sessions: { ...s.sessions, [ROUTE]: { ...s.sessions[ROUTE], messages: msgs } }
    }))
    mirrorStoreIntoReplica()
    for (const id of ['old', 'n1']) {
      seed.taskNotification(
        ROUTE,
        makeTaskNotification({ toolUseId: id, media: media({ jobId: id, blobId: `b-${id}` }) })
      )
    }
    const { unmount } = renderCard('old')
    expect(state()).toBe('collapsed')
    expect(screen.queryByTestId('MediaCard.image')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('MediaCard.expand'))
    expect(state()).toBe('done')
    expect(screen.getByTestId('MediaCard.image')).toBeInTheDocument()
    unmount()
    renderCard('n1')
    expect(state()).toBe('done')
  })
})
