/**
 * Layer 2: `ReplaceModelReferencesDialog` — what a locked model's click opens.
 *
 * Driven through a stateful fake `window.api` (engine files, opencode.jsonc, the
 * judge-support answer) that logs every write in order, because what matters is
 * WHAT each file ends up holding and in WHICH order the dialog wrote them, then
 * handed back: the part a screenshot cannot check.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { ReplaceModelReferencesDialog } from '../ReplaceModelReferencesDialog'
import { useSessionStore } from '../../../stores/session-store'
import { findModelReferences } from '../../../../../shared/model-references'
import type {
  EngineConfig,
  EngineId,
  JudgeModelSupport,
  ModelInfo,
  OpencodeConfigSettings
} from '../../../../../shared/types'

const info = (engineId: EngineId, value: string, displayName = value): ModelInfo =>
  ({ value, displayName, description: '', engineId }) as ModelInfo

let files: Partial<Record<EngineId, EngineConfig>>
let opencodeFile: OpencodeConfigSettings
let modelsByEngine: Partial<Record<EngineId, ModelInfo[]>>
let support: Record<string, JudgeModelSupport> | Error
let accounts: { activeId: string | null; accounts: Array<{ id: string }> } | Error
let log: string[]
let saveEngineConfig: ReturnType<typeof vi.fn>
let saveOpencodeSettings: ReturnType<typeof vi.fn>
let judgeModelSupport: ReturnType<typeof vi.fn>
let onResolved: ReturnType<typeof vi.fn<() => Promise<void>>>
let onCancel: ReturnType<typeof vi.fn<() => void>>
let setPiDefaultModel: ReturnType<typeof vi.fn<(v: string) => void>>
let setOpencodeDefaultModel: ReturnType<typeof vi.fn<(v: string) => void>>
let reloadModels: ReturnType<typeof vi.fn<() => void>>
let awaitPending: ReturnType<typeof vi.fn<() => Promise<void>>>

const clone = <T,>(v: T): T => structuredClone(v)

beforeEach(() => {
  files = {}
  opencodeFile = {}
  modelsByEngine = {}
  support = {}
  accounts = { activeId: 'acct-1', accounts: [{ id: 'acct-1' }] }
  log = []
  saveEngineConfig = vi.fn(async (engine: EngineId, cfg: EngineConfig) => {
    log.push(`save:${engine}`)
    files[engine] = clone(cfg)
  })
  saveOpencodeSettings = vi.fn(async (settings: OpencodeConfigSettings) => {
    log.push('save:opencode.jsonc')
    opencodeFile = clone(settings)
  })
  judgeModelSupport = vi.fn(async () => {
    if (support instanceof Error) throw support
    return support
  })
  onResolved = vi.fn(async () => {
    log.push('resolved')
  })
  onCancel = vi.fn()
  awaitPending = vi.fn(async () => {
    log.push('pending')
  })
  setPiDefaultModel = vi.fn((v: string) => void log.push(`mirror:pi:${v}`))
  setOpencodeDefaultModel = vi.fn((v: string) => void log.push(`mirror:oc:${v}`))
  reloadModels = vi.fn(() => void log.push('reload'))
  useSessionStore.setState({ setPiDefaultModel, setOpencodeDefaultModel, reloadModels })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadEngineConfig: async (e: EngineId) => clone(files[e] ?? {}),
    saveEngineConfig,
    loadOpencodeSettings: async () => clone(opencodeFile),
    saveOpencodeSettings,
    getEngineModels: async (e: EngineId) =>
      (modelsByEngine[e] ?? []).length === 0
        ? []
        : [{ engineId: e, vendorId: 'v', vendorName: 'v', models: modelsByEngine[e] }],
    judgeModelSupport,
    listProviderAccounts: async () => {
      if (accounts instanceof Error) throw accounts
      return accounts
    }
  }
})
afterEach(cleanup)

const GONE = 'prov/gone'
const GONE2 = 'prov/gone2'
const KEEP = 'prov/keep'

/** The references the container would hand the dialog, from the files as they stand. */
function refsFor(...values: string[]): ReturnType<typeof findModelReferences> {
  return findModelReferences({ opencode: opencodeFile, engines: files }, values)
}

function mount(
  values: string[],
  removals: Partial<Record<EngineId, string[]>>
): ReturnType<typeof render> {
  return render(
    <ReplaceModelReferencesDialog
      references={refsFor(...values)}
      removals={removals}
      awaitPendingWrites={awaitPending}
      onResolved={onResolved}
      onCancel={onCancel}
    />
  )
}

const rows = (): HTMLElement[] => screen.getAllByTestId('ReplaceModelReferencesDialog.row')
const rowOf = (id: string): HTMLElement => rows().find((r) => r.dataset.id === id)!
const apply = (): HTMLElement => screen.getByTestId('ReplaceModelReferencesDialog.apply')

async function ready(): Promise<void> {
  await screen.findAllByTestId('ReplaceModelReferencesDialog.row')
  // The loading text goes once models and files have loaded.
  await act(async () => {})
}

async function pick(row: HTMLElement, value: string): Promise<void> {
  fireEvent.click(within(row).getByTestId('ModelPicker.trigger'))
  const option = screen
    .getAllByTestId('ModelPicker.option')
    .find((o) => o.getAttribute('data-value') === value)
  if (!option) throw new Error(`no option ${value}`)
  await act(async () => {
    fireEvent.click(option)
  })
}

const optionValues = (row: HTMLElement): Array<string | null> => {
  fireEvent.click(within(row).getByTestId('ModelPicker.trigger'))
  const values = screen
    .getAllByTestId('ModelPicker.option')
    .map((o) => o.getAttribute('data-value'))
  fireEvent.click(within(row).getByTestId('ModelPicker.trigger'))
  return values
}

async function clickApply(): Promise<void> {
  await act(async () => {
    fireEvent.click(apply())
  })
}

describe('ReplaceModelReferencesDialog', () => {
  it('names each setting by title and breadcrumb, with the model being replaced by display name', async () => {
    files = { pi: { piConfig: { defaultModel: GONE } } }
    modelsByEngine = { pi: [info('pi', GONE, 'Gone Model'), info('pi', KEEP, 'Keep Model')] }
    mount([GONE], { pi: [GONE] })
    await ready()
    const row = rowOf('piDefault:pi')
    expect(row).toHaveTextContent('pi · Default model')
    expect(row).toHaveTextContent('Models & providers › Default models › pi')
    expect(row).toHaveTextContent('Replacing Gone Model')
    // No link out: the dialog names the location instead (R6).
    expect(within(row).queryByRole('link')).toBeNull()
  })

  it('offers the engine own models minus every value this untick removes, per engine', async () => {
    files = { pi: { piConfig: { defaultModel: GONE } } }
    modelsByEngine = {
      pi: [info('pi', GONE), info('pi', GONE2), info('pi', KEEP)]
    }
    // GONE2 is removed too (another locked row of the same engine).
    mount([GONE], { pi: [GONE, GONE2], opencode: [KEEP] })
    await ready()
    expect(optionValues(rowOf('piDefault:pi'))).toEqual(['', KEEP])
  })

  it('judge rows only list what judgeModelSupport allows, and wait for its answer', async () => {
    files = { pi: { autoMode: { judgeModel: GONE } } }
    modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP), info('pi', 'prov/no')] }
    support = {
      [GONE]: { ok: true } as JudgeModelSupport,
      [KEEP]: { ok: true } as JudgeModelSupport,
      'prov/no': { ok: false, reason: 'no route' } as JudgeModelSupport
    }
    mount([GONE], { pi: [GONE] })
    await ready()
    // asked once, over the engine's FULL list
    expect(judgeModelSupport).toHaveBeenCalledTimes(1)
    expect(judgeModelSupport).toHaveBeenCalledWith('pi', [GONE, KEEP, 'prov/no'])
    expect(optionValues(rowOf('judge:pi'))).toEqual(['', KEEP])
  })

  it('a failed judgeModelSupport lists the unfiltered candidates, as the row does', async () => {
    files = { pi: { autoMode: { judgeModel: GONE } } }
    modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP), info('pi', 'prov/no')] }
    support = new Error('boom')
    mount([GONE], { pi: [GONE] })
    await ready()
    expect(optionValues(rowOf('judge:pi'))).toEqual(['', KEEP, 'prov/no'])
  })

  it('a judge row shows no picker, and Apply stays off, until the support answer arrives', async () => {
    files = { pi: { autoMode: { judgeModel: GONE } } }
    modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
    let release: (v: Record<string, JudgeModelSupport>) => void = () => {}
    judgeModelSupport.mockImplementation(
      () => new Promise<Record<string, JudgeModelSupport>>((r) => (release = r))
    )
    mount([GONE], { pi: [GONE] })
    await ready()
    expect(within(rowOf('judge:pi')).queryByTestId('ModelPicker.trigger')).toBeNull()
    expect(apply()).toBeDisabled()
    await act(async () => release({}))
    expect(within(rowOf('judge:pi')).getByTestId('ModelPicker.trigger')).toBeInTheDocument()
  })

  it('every empty option reads as the setting own row does', async () => {
    files = {
      pi: {
        piConfig: { defaultModel: GONE },
        autoMode: { judgeModel: GONE, fallbackJudgeModel: GONE },
        dispatch: { defaultModel: GONE }
      }
    }
    opencodeFile = { model: GONE, smallModel: GONE }
    modelsByEngine = {
      pi: [info('pi', GONE), info('pi', KEEP)],
      opencode: [info('opencode', KEEP)]
    }
    mount([GONE], { pi: [GONE], opencode: [GONE] })
    await ready()
    const emptyLabel = (id: string): string => {
      const row = rowOf(id)
      fireEvent.click(within(row).getByTestId('ModelPicker.trigger'))
      const text = screen
        .getAllByTestId('ModelPicker.option')
        .find((o) => o.getAttribute('data-value') === '')!.textContent
      fireEvent.click(within(row).getByTestId('ModelPicker.trigger'))
      return text ?? ''
    }
    expect(emptyLabel('opencodeDefault:opencode')).toBe('Default (use opencode default)')
    expect(emptyLabel('opencodeSmall:opencode')).toBe('Default (use opencode default)')
    expect(emptyLabel('piDefault:pi')).toMatch(/^Default \(/)
    expect(emptyLabel('judge:pi')).toBe('Same as session model (default)')
    expect(emptyLabel('fallbackJudge:pi')).toBe('None (ask me instead)')
    expect(emptyLabel('dispatchDefault:pi')).toBe('(not set)')
  })

  describe('dispatch allowed models', () => {
    it('defaults to Remove while other entries remain; Apply drops the entry, siblings kept', async () => {
      files = {
        pi: {
          piConfig: { defaultModel: KEEP },
          dispatch: { allowedModels: [GONE, KEEP], maxCostUsd: 3 }
        }
      }
      modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
      mount([GONE], { pi: [GONE] })
      await ready()
      const row = rowOf('dispatchAllowed:pi')
      expect(within(row).getByTestId('ReplaceModelReferencesDialog.picker')).toHaveAttribute(
        'data-value',
        ''
      )
      expect(row).toHaveTextContent('Remove from the list')
      expect(apply()).toBeEnabled()
      await clickApply()
      expect(files.pi).toEqual({
        piConfig: { defaultModel: KEEP },
        dispatch: { allowedModels: [KEEP], maxCostUsd: 3 }
      })
    })

    it('drops the key when the list empties, and the row starts UNDECIDED offering "Allow any model"', async () => {
      files = { pi: { dispatch: { allowedModels: [GONE], maxCostUsd: 3 } } }
      modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
      mount([GONE], { pi: [GONE] })
      await ready()
      const row = rowOf('dispatchAllowed:pi')
      // Removing the last entry WIDENS the list: no pre-selected choice.
      expect(apply()).toBeDisabled()
      expect(within(row).getByTestId('ReplaceModelReferencesDialog.picker')).toHaveAttribute(
        'data-value',
        '__undecided__'
      )
      fireEvent.click(within(row).getByTestId('ModelPicker.trigger'))
      expect(
        screen.getAllByTestId('ModelPicker.option').find((o) => o.getAttribute('data-value') === '')
      ).toHaveTextContent('Allow any model')
      fireEvent.click(within(row).getByTestId('ModelPicker.trigger'))
      await pick(row, '')
      expect(apply()).toBeEnabled()
      await clickApply()
      expect(files.pi?.dispatch).toEqual({ maxCostUsd: 3 })
      expect(files.pi?.dispatch?.allowedModels).toBeUndefined()
    })

    it('a replacement already in the list just removes the old entry (no duplicate)', async () => {
      files = { pi: { dispatch: { allowedModels: [GONE, KEEP] } } }
      modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
      mount([GONE], { pi: [GONE] })
      await ready()
      await pick(rowOf('dispatchAllowed:pi'), KEEP)
      await clickApply()
      expect(files.pi?.dispatch?.allowedModels).toEqual([KEEP])
    })

    it('a new replacement takes the old entry place', async () => {
      files = { pi: { dispatch: { allowedModels: [GONE, KEEP] } } }
      modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP), info('pi', 'prov/new')] }
      mount([GONE], { pi: [GONE] })
      await ready()
      await pick(rowOf('dispatchAllowed:pi'), 'prov/new')
      await clickApply()
      expect(files.pi?.dispatch?.allowedModels).toEqual(['prov/new', KEEP])
    })
  })

  it('Apply is off until every row is decided', async () => {
    files = { pi: { piConfig: { defaultModel: GONE }, dispatch: { allowedModels: [GONE, KEEP] } } }
    modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
    mount([GONE], { pi: [GONE] })
    await ready()
    // The allowed row defaults to Remove, the default-model row has no default.
    expect(apply()).toBeDisabled()
    await pick(rowOf('piDefault:pi'), KEEP)
    expect(apply()).toBeEnabled()
  })

  it('writes every engine file ONCE with all its patches, opencode.jsonc by snapshot, mirrors, then hands back', async () => {
    files = {
      pi: {
        piConfig: { defaultModel: GONE, thinking: 'high' } as EngineConfig['piConfig'],
        autoMode: { judgeModel: GONE, twoStageMode: 'fast' },
        dispatch: { defaultModel: GONE, allowedModels: [GONE, KEEP] }
      },
      claude: { dispatch: { maxCostUsd: 1 } }
    }
    opencodeFile = {
      model: GONE,
      smallModel: 'prov/other',
      modelAllowlist: { prov: ['x'] }
    } as OpencodeConfigSettings
    modelsByEngine = {
      pi: [info('pi', GONE), info('pi', KEEP), info('pi', 'prov/new')],
      opencode: [info('opencode', GONE), info('opencode', KEEP)]
    }
    support = {
      [KEEP]: { ok: true } as JudgeModelSupport,
      'prov/new': { ok: true } as JudgeModelSupport
    }
    mount([GONE], { pi: [GONE], opencode: [GONE] })
    await ready()

    await pick(rowOf('piDefault:pi'), 'prov/new')
    await pick(rowOf('judge:pi'), '')
    await pick(rowOf('dispatchDefault:pi'), KEEP)
    await pick(rowOf('opencodeDefault:opencode'), KEEP)
    await clickApply()

    expect(saveEngineConfig).toHaveBeenCalledTimes(1)
    expect(files.pi).toEqual({
      piConfig: { defaultModel: 'prov/new', thinking: 'high' },
      autoMode: { judgeModel: undefined, twoStageMode: 'fast' },
      dispatch: { defaultModel: KEEP, allowedModels: [KEEP] }
    })
    // Untouched engine files are not written.
    expect(files.claude).toEqual({ dispatch: { maxCostUsd: 1 } })
    // opencode.jsonc: only the referenced key changes, and the stale allowlist is not sent.
    expect(saveOpencodeSettings).toHaveBeenCalledTimes(1)
    expect(saveOpencodeSettings.mock.calls[0][0]).toEqual({
      model: KEEP,
      smallModel: 'prov/other'
    })
    expect(saveOpencodeSettings.mock.calls[0][1]).toEqual({
      model: GONE,
      smallModel: 'prov/other',
      modelAllowlist: { prov: ['x'] }
    })
    expect(log).toEqual([
      'pending',
      'save:pi',
      'mirror:pi:prov/new',
      'save:opencode.jsonc',
      'mirror:oc:prov/keep',
      'reload',
      'resolved'
    ])
  })

  it('writes from a FRESH read, never from a copy the dialog or a pane held', async () => {
    files = { pi: { piConfig: { defaultModel: GONE } } }
    modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
    mount([GONE], { pi: [GONE] })
    await ready()
    await pick(rowOf('piDefault:pi'), KEEP)
    // Written elsewhere after the dialog opened (a pane, the Manage sheet).
    files.pi = { piConfig: { defaultModel: GONE }, dispatch: { maxCostUsd: 9 } }
    await clickApply()
    expect(files.pi).toEqual({ piConfig: { defaultModel: KEEP }, dispatch: { maxCostUsd: 9 } })
  })

  it('a pi default set to its empty option mirrors the RAW empty value', async () => {
    files = { pi: { piConfig: { defaultModel: GONE } } }
    modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
    mount([GONE], { pi: [GONE] })
    await ready()
    await pick(rowOf('piDefault:pi'), '')
    await clickApply()
    expect(setPiDefaultModel).toHaveBeenCalledWith('')
    expect(files.pi?.piConfig?.defaultModel).toBeUndefined()
  })

  it('a failed write keeps the dialog open with the error, and does not hand back', async () => {
    files = { pi: { piConfig: { defaultModel: GONE } } }
    opencodeFile = { model: GONE }
    modelsByEngine = {
      pi: [info('pi', GONE), info('pi', KEEP)],
      opencode: [info('opencode', GONE), info('opencode', KEEP)]
    }
    saveEngineConfig.mockImplementation(async () => {
      throw new Error('disk full')
    })
    mount([GONE], { pi: [GONE], opencode: [GONE] })
    await ready()
    await pick(rowOf('piDefault:pi'), KEEP)
    await pick(rowOf('opencodeDefault:opencode'), KEEP)
    await clickApply()
    expect(screen.getByTestId('ReplaceModelReferencesDialog.error')).toHaveTextContent('disk full')
    expect(onResolved).not.toHaveBeenCalled()
    // The first failure stops the run: opencode.jsonc was never written.
    expect(saveOpencodeSettings).not.toHaveBeenCalled()
    expect(screen.getByTestId('ReplaceModelReferencesDialog')).toBeInTheDocument()
    // Retrying is possible.
    expect(apply()).toBeEnabled()
  })

  it('settings already written stay written when a later write fails (still no untick)', async () => {
    files = { pi: { piConfig: { defaultModel: GONE } } }
    opencodeFile = { model: GONE }
    modelsByEngine = {
      pi: [info('pi', GONE), info('pi', KEEP)],
      opencode: [info('opencode', GONE), info('opencode', KEEP)]
    }
    saveOpencodeSettings.mockImplementation(async () => {
      throw new Error('locked file')
    })
    mount([GONE], { pi: [GONE], opencode: [GONE] })
    await ready()
    await pick(rowOf('piDefault:pi'), KEEP)
    await pick(rowOf('opencodeDefault:opencode'), KEEP)
    await clickApply()
    expect(files.pi?.piConfig?.defaultModel).toBe(KEEP)
    expect(screen.getByTestId('ReplaceModelReferencesDialog.error')).toHaveTextContent(
      'locked file'
    )
    expect(onResolved).not.toHaveBeenCalled()
    // The models the written file changed are still announced.
    expect(reloadModels).toHaveBeenCalledTimes(1)
  })

  describe('fallback judge equal to the judge', () => {
    const SAME = 'prov/same'

    it('warns when the chosen fallback equals the chosen judge, on the same account', async () => {
      files = { pi: { autoMode: { judgeModel: GONE, fallbackJudgeModel: GONE2 } } }
      modelsByEngine = { pi: [info('pi', GONE), info('pi', GONE2), info('pi', SAME)] }
      support = { [SAME]: { ok: true, chatgpt: true } as JudgeModelSupport }
      mount([GONE, GONE2], { pi: [GONE, GONE2] })
      await ready()
      expect(screen.queryByTestId('ReplaceModelReferencesDialog.sameJudgeWarning')).toBeNull()
      await pick(rowOf('judge:pi'), SAME)
      expect(screen.queryByTestId('ReplaceModelReferencesDialog.sameJudgeWarning')).toBeNull()
      await pick(rowOf('fallbackJudge:pi'), SAME)
      expect(
        screen.getAllByTestId('ReplaceModelReferencesDialog.sameJudgeWarning')
      ).not.toHaveLength(0)
      // A warning, not a block.
      expect(apply()).toBeEnabled()
    })

    it('a fallback account other than the active one makes it a new route: no warning', async () => {
      files = {
        pi: {
          autoMode: {
            judgeModel: SAME,
            fallbackJudgeModel: GONE,
            fallbackJudgeAccount: 'acct-2'
          }
        }
      }
      modelsByEngine = { pi: [info('pi', GONE), info('pi', SAME)] }
      support = { [SAME]: { ok: true, chatgpt: true } as JudgeModelSupport }
      mount([GONE], { pi: [GONE] })
      await ready()
      await pick(rowOf('fallbackJudge:pi'), SAME)
      expect(screen.queryByTestId('ReplaceModelReferencesDialog.sameJudgeWarning')).toBeNull()
    })

    it('writes the fallback through fallbackJudgePatch: a non-ChatGPT model clears the account', async () => {
      files = {
        pi: { autoMode: { fallbackJudgeModel: GONE, fallbackJudgeAccount: 'acct-2' } }
      }
      modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
      support = { [KEEP]: { ok: true, chatgpt: false } as JudgeModelSupport }
      mount([GONE], { pi: [GONE] })
      await ready()
      await pick(rowOf('fallbackJudge:pi'), KEEP)
      await clickApply()
      expect(files.pi?.autoMode?.fallbackJudgeModel).toBe(KEEP)
      expect(files.pi?.autoMode?.fallbackJudgeAccount).toBeUndefined()
    })
  })

  it('waits for the container pending writes before the first write', async () => {
    files = { pi: { piConfig: { defaultModel: GONE } } }
    modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
    mount([GONE], { pi: [GONE] })
    await ready()
    await pick(rowOf('piDefault:pi'), KEEP)
    await clickApply()
    expect(log.indexOf('pending')).toBeLessThan(log.indexOf('save:pi'))
  })

  it('Escape and Cancel close it; neither does while Apply runs', async () => {
    files = { pi: { piConfig: { defaultModel: GONE } } }
    modelsByEngine = { pi: [info('pi', GONE), info('pi', KEEP)] }
    let release: () => void = () => {}
    saveEngineConfig.mockImplementation(() => new Promise<void>((r) => (release = r)))
    mount([GONE], { pi: [GONE] })
    await ready()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    await pick(rowOf('piDefault:pi'), KEEP)
    await clickApply()
    expect(screen.getByTestId('ReplaceModelReferencesDialog.cancel')).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    await act(async () => release())
  })
})
