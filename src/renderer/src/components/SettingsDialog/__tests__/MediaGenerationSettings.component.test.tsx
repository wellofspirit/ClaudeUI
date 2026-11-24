/**
 * Settings › Media generation: the four page-local bodies write `mediaGeneration` (whole, over the
 * resolved defaults), the model pickers list the connected catalog by source, and a saved model the
 * catalog lacks is flagged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { pageOf } from '../settings-pages'
import { modelOptions } from '../MediaGenerationSettings'
import type { MediaCatalog } from '../../../../../shared/media-generation'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const CATALOG: MediaCatalog = {
  models: [
    {
      ref: 'chatgpt-plan',
      kind: 'image',
      source: 'chatgpt-plan',
      name: 'ChatGPT Plan',
      acceptsImages: true
    },
    {
      ref: 'openai/gpt-image-2',
      kind: 'image',
      source: 'openai',
      name: 'GPT Image 2',
      acceptsImages: true
    },
    {
      ref: 'openrouter/kling',
      kind: 'video',
      source: 'openrouter',
      name: 'Kling',
      acceptsImages: true
    }
  ],
  connected: { 'chatgpt-plan': true, openai: true, openrouter: true },
  planUsage: { usedPercent: 8, resetsInSeconds: 4 * 3600, at: 1 }
}

type Row = (s: AppSettings, u: (p: Partial<AppSettings>) => void) => React.JSX.Element
const body = (group: string): Row => {
  const g = pageOf('media').groups.find((x) => x.id === group)
  if (!g?.items) throw new Error(`no media group ${group}`)
  return g.items[0].render as unknown as Row
}
const mount = (
  group: string,
  mediaGeneration?: AppSettings['mediaGeneration']
): ReturnType<typeof vi.fn> => {
  const update = vi.fn()
  render(body(group)({ ...DEFAULT_SETTINGS, mediaGeneration } as AppSettings, update))
  return update
}

describe('Media generation settings', () => {
  let app: TestApp
  let catalog: MediaCatalog
  beforeEach(async () => {
    app = await bootTestApp()
    catalog = CATALOG
    app.bridge.ipcMain.handle('media:list-models', async () => catalog)
  })
  afterEach(() => {
    cleanup()
    app.teardown()
  })

  it('is a Features page with the four groups, after Mockups', () => {
    const page = pageOf('media')
    expect(page.rail).toBe('features')
    expect(page.label).toBe('Media generation')
    expect(page.groups.map((g) => g.id)).toEqual(['engines', 'models', 'jobs', 'output'])
  })

  it('toggles an engine by writing the whole resolved value', () => {
    const update = mount('engines')
    const rows = screen.getAllByTestId('MediaGenerationSection.engine')
    expect(rows.map((r) => r.dataset.id)).toEqual(['claude', 'pi', 'opencode'])
    expect(rows.every((r) => r.getAttribute('aria-pressed') === 'true')).toBe(true)
    fireEvent.click(rows[2])
    expect(update).toHaveBeenCalledWith({
      mediaGeneration: expect.objectContaining({
        engines: { claude: true, pi: true, opencode: false },
        concurrency: 4
      })
    })
  })

  it('lists models grouped by source with Automatic and Off first', () => {
    const opts = modelOptions(CATALOG, 'image')
    expect(opts.map((o) => o.value)).toEqual(['auto', 'off', 'chatgpt-plan', 'openai/gpt-image-2'])
    expect(opts[0].selectedLabel).toBe('Automatic · ChatGPT Plan')
    expect(opts[2].section).toBe('ChatGPT · included in your plan')
    expect(opts[3].section).toBe('OpenAI · API key · billed per image')
    expect(modelOptions(CATALOG, 'video').at(-1)?.section).toBe(
      'OpenRouter · API key · billed per clip'
    )
  })

  it('flags a saved model the catalog does not list, and Reset writes Automatic', async () => {
    const update = mount('models', { imageModel: 'openai/gone', videoModel: 'off' })
    const warning = await screen.findByTestId('MediaGenerationSection.stale')
    expect(warning).toHaveTextContent('openai/gone')
    expect(warning.dataset.id).toBe('image')
    expect(screen.getAllByTestId('MediaGenerationSection.stale')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('MediaGenerationSection.staleReset'))
    expect(update).toHaveBeenCalledWith({
      mediaGeneration: expect.objectContaining({ imageModel: 'auto', videoModel: 'off' })
    })
  })

  it('does not flag Automatic, Off or a listed model', async () => {
    mount('models', { imageModel: 'chatgpt-plan', videoModel: 'openrouter/kling' })
    await waitFor(() => expect(window.api.listMediaModels).toBeDefined())
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('MediaGenerationSection.stale')).not.toBeInTheDocument()
  })

  it('image quality writes the choice', () => {
    const update = mount('models')
    fireEvent.click(screen.getByText('Low'))
    expect(update).toHaveBeenCalledWith({
      mediaGeneration: expect.objectContaining({ imageQuality: 'low' })
    })
  })

  it('jobs: numbers clamp, and the plan meter shows only when the catalog has usage', async () => {
    const update = mount('jobs')
    const input = screen.getByTestId('MediaGenerationSection.concurrency')
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)
    expect(update).toHaveBeenCalledWith({
      mediaGeneration: expect.objectContaining({ concurrency: 16 })
    })
    expect(await screen.findByTestId('MediaGenerationSection.planUsage')).toHaveTextContent(
      '8% used· resets in 4 h'
    )
    cleanup()
    catalog = { ...CATALOG, planUsage: undefined }
    mount('jobs')
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('MediaGenerationSection.planUsage')).not.toBeInTheDocument()
  })

  it('output: Save to writes generated', () => {
    const update = mount('output')
    fireEvent.click(screen.getByText('Workspace generated/'))
    expect(update).toHaveBeenCalledWith({
      mediaGeneration: expect.objectContaining({ saveTo: 'generated' })
    })
  })
})
