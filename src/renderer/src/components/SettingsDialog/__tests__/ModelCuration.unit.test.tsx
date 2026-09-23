/**
 * Layer 1: `ModelCuration` — "Models in the picker" for any engine (ADR-074 §2,
 * mockup `7eeb6bff`, "Separate per engine" state).
 *
 * Driven through FAKE adapters, because the adapter is the whole engine seam:
 * what is guarded here is what the component asks each adapter to save, for
 * every way into and out of "Only the ones I pick" — the part a screenshot
 * cannot check. The real adapters' channels are pinned by the Manage sheet's
 * own tests (`ProviderSheet.component.test.tsx`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { createRef, useState } from 'react'
import {
  LARGE_CATALOG,
  ModelCuration,
  type CuratedEngine,
  type CurationAdapter
} from '../ModelCuration'
import type { CurationModel } from '../ModelCurationList'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

const catalogOf = (n: number): CurationModel[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m-${i}`, name: `Model ${i}` }))

/** A fake adapter: the catalog and selection it answers, and every save it got. */
function fakeAdapter(
  engine: CuratedEngine,
  catalog: CurationModel[],
  selection: string[] | undefined,
  extra: Partial<CurationAdapter> = {}
): CurationAdapter & { saves: Array<string[] | null> } {
  const saves: Array<string[] | null> = []
  return {
    engine,
    providerId: 'prov',
    loadCatalog: async () => catalog,
    loadSelection: async () => selection,
    save: async (next) => {
      saves.push(next)
    },
    pickerValue: (id) => `prov/${id}`,
    saves,
    ...extra
  }
}

let engineConfigs: Record<string, EngineConfig>
let discovered: EngineModelGroup[]
let onWrote: ReturnType<typeof vi.fn<() => Promise<void>>>

beforeEach(() => {
  engineConfigs = {}
  discovered = []
  onWrote = vi.fn(async () => {})
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadOpencodeSettings: async () => ({}),
    getEngineModels: async () => discovered,
    loadEngineConfig: async (id: string) => engineConfigs[id] ?? {}
  }
})
afterEach(cleanup)

function Harness({ adapters }: { adapters: CurationAdapter[] }): React.JSX.Element {
  const [engine, setEngine] = useState<CuratedEngine>(adapters[0].engine)
  return (
    <ModelCuration
      testid="S"
      providerName="Prov"
      adapters={adapters}
      engine={engine}
      onEngineChange={setEngine}
      filterRef={createRef<HTMLInputElement>()}
      onWrote={onWrote}
    />
  )
}

async function mount(...adapters: CurationAdapter[]): Promise<void> {
  render(<Harness adapters={adapters} />)
  await screen.findAllByTestId('S.curationMode.option')
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
  })
}

const mode = (id: 'all' | 'pick'): HTMLElement =>
  screen.getAllByTestId('S.curationMode.option').find((el) => el.dataset.id === id)!
const row = (id: string): HTMLElement =>
  screen.getAllByTestId('S.models.row').find((el) => el.dataset.id === id)!

/** Mark `id` as discovered by pi and named by pi's default. */
function lockForPi(id: string): void {
  discovered = [
    {
      engineId: 'pi',
      vendorId: 'prov',
      vendorName: 'prov',
      models: [{ value: `prov/${id}`, displayName: id, description: '', engineId: 'pi' }]
    }
  ]
  engineConfigs = { pi: { piConfig: { defaultModel: `prov/${id}` } } }
}

describe('ModelCuration', () => {
  it('shows tabs only when two engines curate, each with its count', async () => {
    await mount(fakeAdapter('pi', catalogOf(3), undefined))
    expect(screen.queryByTestId('S.curationTabs')).not.toBeInTheDocument()
    cleanup()

    await mount(
      fakeAdapter('opencode', catalogOf(8), ['m-0', 'm-1', 'm-gone']),
      fakeAdapter('pi', catalogOf(3), undefined)
    )
    expect(
      screen.getAllByTestId('S.curationTabCount').map((el) => [el.dataset.id, el.textContent])
    ).toEqual([
      // A picked id the catalog no longer has is not counted.
      ['opencode', '2 of 8'],
      ['pi', 'all 3']
    ])
  })

  it(`Only from All seeds every model for a catalog of ${LARGE_CATALOG} or fewer`, async () => {
    const adapter = fakeAdapter('pi', catalogOf(LARGE_CATALOG), undefined)
    await mount(adapter)
    await click(mode('pick'))
    expect(adapter.saves).toEqual([catalogOf(LARGE_CATALOG).map((m) => m.id)])
    expect(mode('pick')).toHaveTextContent(`Only the ones I pick · ${LARGE_CATALOG}`)
  })

  it(`Only from All starts EMPTY over ${LARGE_CATALOG} — except what a setting uses`, async () => {
    lockForPi('m-7')
    const adapter = fakeAdapter('pi', catalogOf(LARGE_CATALOG + 1), undefined)
    await mount(adapter)
    await click(mode('pick'))
    expect(adapter.saves).toEqual([['m-7']])
  })

  it('All models writes null, and says what that means', async () => {
    const adapter = fakeAdapter('opencode', catalogOf(3), ['m-0'])
    await mount(adapter)
    expect(screen.getByTestId('S.curationModeRow')).toHaveTextContent(
      'New models from Prov stay out of the opencode picker until you pick them.'
    )
    await click(mode('all'))
    expect(adapter.saves).toEqual([null])
    expect(screen.getByTestId('S.curationModeRow')).toHaveTextContent(
      'Every model Prov offers is shown, including ones added later.'
    )
    expect(onWrote).toHaveBeenCalled()
  })

  it('unticking in All switches to Only with the rest picked, and Undo goes back to All', async () => {
    const adapter = fakeAdapter('pi', catalogOf(3), undefined)
    await mount(adapter)
    expect(row('m-1')).toHaveAttribute('data-soft', 'true')
    await click(row('m-1'))
    expect(adapter.saves).toEqual([['m-0', 'm-2']])
    expect(screen.getByTestId('S.curationToast')).toHaveTextContent(
      'Switched to Only the ones I pick — everything but this model is picked.'
    )
    expect(row('m-0')).not.toHaveAttribute('data-soft')

    await click(screen.getByTestId('S.curationUndo'))
    expect(adapter.saves).toEqual([['m-0', 'm-2'], null])
    expect(mode('all')).toHaveAttribute('aria-pressed', 'true')
  })

  it('a locked model cannot be unticked, in All or in Only', async () => {
    lockForPi('m-1')
    const adapter = fakeAdapter('pi', catalogOf(3), undefined)
    await mount(adapter)
    await click(row('m-1'))
    expect(adapter.saves).toEqual([])
    expect(row('m-1')).toHaveAttribute('data-locked', 'true')
    // Refused by the LOCK, before the guard: nothing reached the writer to refuse.
    expect(screen.queryByTestId('S.modelsError')).not.toBeInTheDocument()
    cleanup()

    const picked = fakeAdapter('pi', catalogOf(3), ['m-0', 'm-1'])
    await mount(picked)
    await click(row('m-1'))
    expect(picked.saves).toEqual([])
    expect(row('m-1')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByTestId('S.modelsError')).not.toBeInTheDocument()
  })

  it('a no-op edit on All models stays on All (a vendor of only locked models)', async () => {
    // Two vendors; every shown model of `locked/` is locked, so its vendor box
    // changes nothing — and must not read as "switch to Only".
    discovered = [
      {
        engineId: 'pi',
        vendorId: 'prov',
        vendorName: 'prov',
        models: ['locked/a', 'locked/b'].map((id) => ({
          value: `prov/${id}`,
          displayName: id,
          description: '',
          engineId: 'pi' as const
        }))
      }
    ]
    engineConfigs = {
      pi: { dispatch: { defaultModel: 'prov/locked/a', allowedModels: ['prov/locked/b'] } }
    }
    const adapter = fakeAdapter(
      'pi',
      [
        { id: 'locked/a', name: 'A' },
        { id: 'locked/b', name: 'B' },
        { id: 'free/c', name: 'C' }
      ],
      undefined
    )
    await mount(adapter)
    await click(
      screen.getAllByTestId('S.models.groupToggle').find((el) => el.dataset.id === 'locked')!
    )
    expect(adapter.saves).toEqual([])
    expect(mode('all')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('S.curationToast')).not.toBeInTheDocument()
  })

  it('refuses an edit that would still orphan a setting, naming it', async () => {
    // pi discovered a model its catalog does not list (so no row carries the
    // lock), and pi's default names it: seeding Only from the catalog would
    // drop it, so the guard refuses rather than orphaning the default.
    lockForPi('m-9')
    const adapter = fakeAdapter('pi', catalogOf(3), undefined)
    await mount(adapter)
    await click(mode('pick'))
    expect(adapter.saves).toEqual([])
    expect(screen.getByTestId('S.modelsError')).toHaveTextContent(
      '"prov/m-9" is the pi default model — change that first.'
    )
  })

  it('puts the previous selection back when the save fails', async () => {
    const adapter = fakeAdapter('opencode', catalogOf(2), ['m-0'], {
      save: async () => {
        throw new Error('config write failed')
      }
    })
    await mount(adapter)
    await click(row('m-1'))
    expect(screen.getByTestId('S.modelsError')).toHaveTextContent('config write failed')
    expect(row('m-1')).toHaveAttribute('aria-checked', 'false')
  })

  it('a failed save clears the toast along with the edit', async () => {
    const adapter = fakeAdapter('pi', catalogOf(3), undefined, {
      save: async () => {
        throw new Error('config write failed')
      }
    })
    await mount(adapter)
    await click(row('m-1'))
    expect(screen.getByTestId('S.modelsError')).toHaveTextContent('config write failed')
    expect(screen.queryByTestId('S.curationToast')).not.toBeInTheDocument()
    // Re-read from the adapter: still All models.
    expect(mode('all')).toHaveAttribute('aria-pressed', 'true')
  })

  it('saves run in order, and a failed early save does not roll back a later one', async () => {
    let failFirst!: (reason: Error) => void
    const saves: Array<string[] | null> = []
    let onDisk: string[] | undefined = ['m-0', 'm-1', 'm-2']
    const adapter = fakeAdapter('opencode', catalogOf(3), onDisk, {
      loadSelection: async () => onDisk,
      save: (next) => {
        saves.push(next)
        if (saves.length === 1)
          return new Promise<void>((_, reject) => {
            failFirst = reject
          })
        onDisk = next ?? undefined
        return Promise.resolve()
      }
    })
    await mount(adapter)
    await click(row('m-0'))
    await click(row('m-1'))
    // The second save is QUEUED behind the first, not racing it.
    expect(saves).toEqual([['m-1', 'm-2']])

    await act(async () => failFirst(new Error('first write failed')))
    expect(saves).toEqual([['m-1', 'm-2'], ['m-2']])
    // The later edit stands: no rollback to the first edit's "previous".
    expect(row('m-0')).toHaveAttribute('aria-checked', 'false')
    expect(row('m-1')).toHaveAttribute('aria-checked', 'false')
    expect(row('m-2')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('S.modelsError')).toHaveTextContent('first write failed')
  })

  it('the toast is announced, and can be dismissed without undoing', async () => {
    const adapter = fakeAdapter('pi', catalogOf(1), undefined)
    await mount(adapter)
    await click(row('m-0'))
    const toast = screen.getByTestId('S.curationToast')
    expect(toast).toHaveAttribute('role', 'status')
    expect(toast).toHaveAttribute('aria-live', 'polite')
    expect(toast).toHaveTextContent('Switched to Only the ones I pick — none are picked.')
    await click(screen.getByTestId('S.curationToastDismiss'))
    expect(screen.queryByTestId('S.curationToast')).not.toBeInTheDocument()
    expect(adapter.saves).toEqual([[]])
  })

  it('arrow keys move between the engine tabs', async () => {
    await mount(
      fakeAdapter('opencode', catalogOf(2), undefined),
      fakeAdapter('pi', catalogOf(2), undefined)
    )
    const tab = (engine: string): HTMLElement =>
      screen.getAllByTestId('S.curationTab').find((el) => el.dataset.id === engine)!
    expect(tab('opencode')).toHaveAttribute('tabindex', '0')
    expect(tab('pi')).toHaveAttribute('tabindex', '-1')
    await act(async () => {
      fireEvent.keyDown(tab('opencode'), { key: 'ArrowRight' })
    })
    expect(tab('pi')).toHaveAttribute('aria-selected', 'true')
    expect(tab('pi')).toHaveFocus()
    await act(async () => {
      fireEvent.keyDown(tab('pi'), { key: 'ArrowRight' })
    })
    expect(tab('opencode')).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the adapter’s reason instead of an empty list', async () => {
    await mount(
      fakeAdapter('opencode', catalogOf(2), undefined),
      fakeAdapter('pi', [], undefined, {
        describeEmpty: async () => 'pi reports no models for this provider — check its key.'
      })
    )
    await click(screen.getAllByTestId('S.curationTab').find((el) => el.dataset.id === 'pi')!)
    const models = screen.getByTestId('S.models')
    expect(models).toHaveAttribute('data-id', 'empty')
    expect(models).toHaveTextContent('pi reports no models for this provider — check its key.')
  })
})
