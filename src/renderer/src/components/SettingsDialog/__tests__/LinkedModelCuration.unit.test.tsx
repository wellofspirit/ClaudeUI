/**
 * Layer 1: `LinkedModelCuration` — "Which engines use this list" (ADR-074 §3,
 * mockup `7eeb6bff`).
 *
 * Driven through FAKE adapters (each engine's catalog and allowlist) and a
 * mocked `setSharedProviderCuration`. What is guarded is what the component
 * asks the core to persist for each way in and out of one list — the part a
 * screenshot cannot check — plus the union list's per-engine marks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { createRef, useState } from 'react'
import { LinkedModelCuration } from '../LinkedModelCuration'
import type { CuratedEngine, CurationAdapter } from '../ModelCuration'
import type { CurationModel } from '../ModelCurationList'
import type { SharedProviderDefinition } from '../../../../../shared/shared-provider'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

const model = (id: string): CurationModel => ({ id, name: id })

function fakeAdapter(
  engine: CuratedEngine,
  catalog: CurationModel[],
  selection: string[] | undefined
): CurationAdapter & { saves: Array<string[] | null> } {
  const saves: Array<string[] | null> = []
  return {
    engine,
    providerId: engine === 'pi' ? 'openai-codex' : 'openai',
    loadCatalog: async () => catalog,
    loadSelection: async () => selection,
    save: async (next) => void saves.push(next),
    pickerValue: (id) => `${engine === 'pi' ? 'openai-codex' : 'openai'}/${id}`,
    saves
  }
}

const chatgpt = (curation?: SharedProviderDefinition['curation']): SharedProviderDefinition => ({
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'subscription',
  managed: true,
  models: [],
  routes: {
    pi: { enabled: true, providerId: 'openai-codex' },
    opencode: { enabled: true, providerId: 'openai' }
  },
  ...(curation ? { curation } : {})
})

let setCuration: ReturnType<typeof vi.fn>
let engineConfigs: Record<string, EngineConfig>
let discovered: EngineModelGroup[]

beforeEach(() => {
  setCuration = vi.fn(async () => {})
  engineConfigs = {}
  discovered = []
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadOpencodeSettings: async () => ({}),
    getEngineModels: async () => discovered,
    loadEngineConfig: async (id: string) => engineConfigs[id] ?? {},
    setSharedProviderCuration: setCuration
  }
})
afterEach(cleanup)

function Harness({
  definition,
  adapters
}: {
  definition: SharedProviderDefinition
  adapters: CurationAdapter[]
}): React.JSX.Element {
  const [engine, setEngine] = useState<CuratedEngine>('opencode')
  return (
    <LinkedModelCuration
      testid="S"
      providerName="ChatGPT"
      definition={definition}
      adapters={adapters}
      engine={engine}
      onEngineChange={setEngine}
      filterRef={createRef<HTMLInputElement>()}
      onWrote={async () => {}}
    />
  )
}

async function mount(definition: SharedProviderDefinition, ...adapters: CurationAdapter[]) {
  render(<Harness definition={definition} adapters={adapters} />)
  await screen.findAllByTestId('S.curationLink.option')
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
  })
}

const card = (id: 'one' | 'separate'): HTMLElement =>
  screen.getAllByTestId('S.curationLink.option').find((el) => el.dataset.id === id)!
const row = (id: string): HTMLElement =>
  screen.getAllByTestId('S.models.row').find((el) => el.dataset.id === id)!

describe('LinkedModelCuration', () => {
  it('equal lists read as ONE list, with no tabs, over the union of both catalogs', async () => {
    await mount(
      chatgpt(),
      fakeAdapter('opencode', [model('a'), model('b')], ['a']),
      fakeAdapter('pi', [model('a'), model('c')], ['a'])
    )
    expect(card('one').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByTestId('S.curationTabs')).toBeNull()
    expect(
      screen
        .getAllByTestId('S.models.row')
        .map((el) => el.dataset.id)
        .sort()
    ).toEqual(['a', 'b', 'c'])
  })

  it('marks each row with the engines that offer it', async () => {
    await mount(
      chatgpt(),
      fakeAdapter('opencode', [model('a'), model('b')], undefined),
      fakeAdapter('pi', [model('a'), model('c')], undefined)
    )
    const marks = (id: string): Record<string, string | undefined> =>
      Object.fromEntries(
        within(row(id))
          .getAllByTestId('S.modelMark')
          .map((el) => [el.dataset.id, el.dataset.available])
      )
    expect(marks('a')).toEqual({ opencode: 'true', pi: 'true' })
    expect(marks('b')).toEqual({ opencode: 'true', pi: 'false' })
    expect(marks('c')).toEqual({ opencode: 'false', pi: 'true' })
    expect(within(row('b')).getAllByTestId('S.modelMark')[1].getAttribute('title')).toBe(
      'pi does not offer this model'
    )
  })

  it('an edit in the shared list persists ONE linked record', async () => {
    await mount(
      chatgpt({ linked: true, models: ['a', 'b'] }),
      fakeAdapter('opencode', [model('a'), model('b')], ['a', 'b']),
      fakeAdapter('pi', [model('a'), model('b')], ['a', 'b'])
    )
    await click(row('b'))
    expect(setCuration).toHaveBeenLastCalledWith('chatgpt', { linked: true, models: ['a'] })
  })

  it('different lists read as separate — tabs, the per-engine block', async () => {
    await mount(
      chatgpt(),
      fakeAdapter('opencode', [model('a'), model('b')], ['a']),
      fakeAdapter('pi', [model('a'), model('b')], ['a', 'b'])
    )
    expect(card('separate').getAttribute('aria-checked')).toBe('true')
    await screen.findByTestId('S.curationTabs')
  })

  it('joining lists that differ asks first, with each option’s effect', async () => {
    await mount(
      chatgpt(),
      fakeAdapter('opencode', [model('a'), model('b'), model('c')], ['a', 'b']),
      fakeAdapter('pi', [model('a'), model('b'), model('c')], ['c', 'd', 'e', 'f'])
    )
    await click(card('one'))
    expect(setCuration).not.toHaveBeenCalled()
    const panel = screen.getByTestId('S.curationJoin')
    // Tabs are hidden while it is open.
    expect(screen.queryByTestId('S.curationTabs')).toBeNull()
    const options = within(panel)
      .getAllByTestId('S.curationJoinOption')
      .map((el) => [el.dataset.id, el.textContent])
    expect(options).toEqual([
      ['opencode', 'opencode’s list (2)pi changes from 4 to 2 models.'],
      ['pi', 'pi’s list (4)opencode changes from 2 to 4 models.'],
      ['union', 'Both combined (6)Nothing either engine shows today is removed.']
    ])
    // Both combined is the default; Use one list persists it.
    await click(within(panel).getByTestId('S.curationJoinUse'))
    expect(setCuration).toHaveBeenLastCalledWith('chatgpt', {
      linked: true,
      models: ['a', 'b', 'c', 'd', 'e', 'f']
    })
  })

  it('combining with a side on All is All; picking pi’s list takes pi’s', async () => {
    await mount(
      chatgpt(),
      fakeAdapter('opencode', [model('a')], undefined),
      fakeAdapter('pi', [model('a')], ['a'])
    )
    await click(card('one'))
    const panel = screen.getByTestId('S.curationJoin')
    const option = (id: string): HTMLElement =>
      within(panel)
        .getAllByTestId('S.curationJoinOption')
        .find((el) => el.dataset.id === id)!
    expect(option('union').textContent).toContain(
      'One side shows all models, so the combined list is all models.'
    )
    expect(option('pi').textContent).toContain('opencode goes from all models to this list.')
    await click(within(option('pi')).getByRole('radio'))
    await click(within(panel).getByTestId('S.curationJoinUse'))
    expect(setCuration).toHaveBeenLastCalledWith('chatgpt', { linked: true, models: ['a'] })
  })

  it('Keep separate closes the panel and writes nothing', async () => {
    await mount(
      chatgpt(),
      fakeAdapter('opencode', [model('a')], ['a']),
      fakeAdapter('pi', [model('a')], [])
    )
    await click(card('one'))
    await click(screen.getByTestId('S.curationJoinKeep'))
    expect(screen.queryByTestId('S.curationJoin')).toBeNull()
    expect(setCuration).not.toHaveBeenCalled()
  })

  it('Separate records the flag only — both engines keep the list the link projected', async () => {
    await mount(
      chatgpt({ linked: true, models: ['a'] }),
      fakeAdapter('opencode', [model('a'), model('b')], ['a']),
      fakeAdapter('pi', [model('a'), model('b')], ['a'])
    )
    await click(card('separate'))
    expect(setCuration).toHaveBeenLastCalledWith('chatgpt', { linked: false })
    await screen.findByTestId('S.curationTabs')
  })

  it('a model either engine’s settings use is locked in the shared list', async () => {
    discovered = [
      {
        engineId: 'pi',
        vendorId: 'openai-codex',
        vendorName: 'ChatGPT',
        models: [{ value: 'openai-codex/b', displayName: 'b', description: '', engineId: 'pi' }]
      }
    ]
    engineConfigs = { pi: { piConfig: { defaultModel: 'openai-codex/b' } } }
    await mount(
      chatgpt({ linked: true, models: ['a', 'b'] }),
      fakeAdapter('opencode', [model('a'), model('b')], ['a', 'b']),
      fakeAdapter('pi', [model('a'), model('b')], ['a', 'b'])
    )
    expect(row('b').dataset.locked).toBe('true')
    await click(row('b'))
    expect(setCuration).not.toHaveBeenCalled()
  })
})
