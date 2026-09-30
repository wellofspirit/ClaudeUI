/**
 * Layer 2: the custom-endpoint FORM's per-model details and Detect (ADR-086,
 * mockup `3fdf1efe` Option A).
 *
 * Mounted in a tiny host that owns the draft, as both sheets do, so what is
 * pinned is what reaches `onDraft` — the draft the host's Save persists. Detect
 * is driven over the real bridge (`shared-provider:probe`): the Add form sends
 * the TYPED key, the Edit form sends the provider id and lets the host use the
 * stored key, which never comes back. The merge rules themselves are
 * `endpoint-detect.test.ts`'s; here it is that the form applies them, badges
 * the result, and changes nothing a failed or ignored Detect did not earn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { chooseSelectMenuOption } from '@test/helpers/select-menu'
import { harnessSnapshot } from '@test/helpers/harness-snapshot'
import { harnessStore } from '../harness-store'
import { ProviderForm, blankProviderDraft } from '../ProviderForm'
import type {
  EndpointProbeResult,
  SharedProviderDefinition
} from '../../../../../shared/shared-provider'

const AT = '2026-09-30T10:00:00.000Z'

const saved = (models: SharedProviderDefinition['models']): SharedProviderDefinition => ({
  id: 'gpu-box',
  name: 'GPU box',
  kind: 'custom',
  protocol: 'openai-completions',
  baseUrl: 'http://10.0.4.12:8000/v1',
  models,
  routes: { pi: { enabled: true }, opencode: { enabled: true } },
  managed: true
})

// ── Harness ──────────────────────────────────────────────────────────

let app: TestApp
let answer: EndpointProbeResult
let probes: unknown[]
let draft: SharedProviderDefinition

function Host({
  initial,
  idLocked = false
}: {
  initial: SharedProviderDefinition
  idLocked?: boolean
}): React.JSX.Element {
  const [current, setCurrent] = useState(initial)
  const [key, setKey] = useState('')
  draft = current
  return (
    <ProviderForm
      draft={current}
      onDraft={setCurrent}
      apiKey={key}
      onApiKey={setKey}
      idLocked={idLocked}
    />
  )
}

beforeEach(async () => {
  app = await bootTestApp()
  probes = []
  answer = { status: 'detected', server: 'openai-compatible', models: [] }
  app.bridge.ipcMain.handle('shared-provider:probe', async (_e: unknown, input: unknown) => {
    probes.push(input)
    return answer
  })
})

afterEach(() => {
  cleanup()
  app.teardown()
  harnessStore.resetForTests()
})

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
  })
}

async function typeInto(el: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(el, { target: { value } })
  })
}

/** NumberField commits on blur. */
async function commitNumber(el: HTMLElement, value: string): Promise<void> {
  await typeInto(el, value)
  await act(async () => {
    fireEvent.blur(el)
  })
}

async function detect(): Promise<void> {
  await click(screen.getByTestId('ProviderForm.detect'))
  await screen.findByTestId('ProviderForm.detectResult')
}

const byId = (testid: string, id: string): HTMLElement =>
  screen.getAllByTestId(testid).find((el) => el.dataset.id === id)!

/** The provenance badge of `field` inside model row `index`. */
const source = (index: number, field: string): string | undefined =>
  within(byId('ProviderForm.model', String(index)))
    .getAllByTestId('ProviderForm.source')
    .find((el) => el.dataset.id === field)?.dataset.source

async function expand(index: number): Promise<void> {
  const toggle = byId('ProviderForm.modelToggle', String(index))
  if (toggle.getAttribute('aria-expanded') !== 'true') await click(toggle)
}

// ── Sending ──────────────────────────────────────────────────────────

describe('Detect — what it sends', () => {
  it('is disabled until there is a Base URL, then sends the typed key (Add)', async () => {
    render(<Host initial={blankProviderDraft()} />)
    expect(screen.getByTestId('ProviderForm.detect')).toBeDisabled()

    await typeInto(screen.getByTestId('ProviderForm.baseUrl'), '  http://10.0.4.12:8000/v1 ')
    await typeInto(screen.getByTestId('ProviderForm.key'), 'sk-typed')
    await detect()

    expect(probes).toEqual([
      { baseUrl: 'http://10.0.4.12:8000/v1', protocol: 'openai-completions', apiKey: 'sk-typed' }
    ])
  })

  it('sends the provider id and no key when editing — the host holds the stored key (GUARD)', async () => {
    render(<Host initial={saved([{ id: 'llama' }])} idLocked />)
    await detect()
    expect(probes).toEqual([
      { baseUrl: 'http://10.0.4.12:8000/v1', protocol: 'openai-completions', providerId: 'gpu-box' }
    ])
  })

  it('never sends a provider id from the Add form, whatever id is typed', async () => {
    render(<Host initial={blankProviderDraft()} />)
    await typeInto(screen.getByTestId('ProviderForm.id'), 'gpu-box')
    await typeInto(screen.getByTestId('ProviderForm.baseUrl'), 'http://x/v1')
    await detect()
    expect(probes[0]).not.toHaveProperty('providerId')
  })
})

// ── What a result fills ──────────────────────────────────────────────

describe('Detect — filling', () => {
  it('vLLM: fills context and a suggested output, and badges them', async () => {
    answer = {
      status: 'detected',
      server: 'vllm',
      models: [{ id: 'llama', contextWindow: 32_768 }]
    }
    render(<Host initial={saved([{ id: 'llama' }, { id: 'other' }])} idLocked />)
    await detect()

    expect(screen.getByTestId('ProviderForm.detectResult')).toHaveAttribute('data-state', 'vllm')
    expect(screen.getByTestId('ProviderForm.detectResult')).toHaveTextContent(
      'Vision and reasoning aren’t reported'
    )
    expect(draft.models[0]).toMatchObject({ contextWindow: 32_768, maxTokens: 8_192 })
    expect(byId('ProviderForm.modelSummary', '0')).toHaveTextContent('32.8K context')
    expect(byId('ProviderForm.modelSummary', '0')).toHaveTextContent('8.2K output')

    await expand(0)
    expect(source(0, 'contextWindow')).toBe('server')
    expect(source(0, 'maxTokens')).toBe('suggested')
    expect(source(0, 'vision')).toBe('default')
    expect(byId('ProviderForm.contextWindow', '0')).toHaveValue('32768')
  })

  it('SGLang: fills vision and reasoning, names the parser, warns without a tool-call parser', async () => {
    answer = {
      status: 'detected',
      server: 'sglang',
      models: [
        {
          id: 'qwen3-vl',
          contextWindow: 131_072,
          vision: true,
          reasoning: true,
          reasoningParser: 'qwen3'
        }
      ],
      toolCallParser: null
    }
    render(<Host initial={saved([{ id: 'qwen3-vl' }])} idLocked />)
    await detect()

    const banner = screen.getByTestId('ProviderForm.detectResult')
    expect(banner).toHaveAttribute('data-state', 'sglang')
    expect(banner).toHaveTextContent('context, vision, reasoning read from the server')
    expect(banner).toHaveTextContent('no tool-call parser')
    expect(draft.models[0]).toMatchObject({ vision: true, reasoning: true, maxTokens: 32_768 })

    await expand(0)
    expect(source(0, 'vision')).toBe('server')
    expect(source(0, 'reasoning')).toBe('server')
    expect(byId('ProviderForm.model', '0')).toHaveTextContent('Server runs reasoning parser qwen3')
  })

  it('SGLang without /model_info says so, and fills no capability', async () => {
    answer = {
      status: 'detected',
      server: 'sglang',
      models: [{ id: 'qwen3', contextWindow: 32_768 }],
      modelInfoUnavailable: true
    }
    render(<Host initial={saved([{ id: 'qwen3' }])} idLocked />)
    await detect()
    expect(screen.getByTestId('ProviderForm.detectResult')).toHaveTextContent(
      'Couldn’t read /model_info — set vision and reasoning by hand.'
    )
    expect(draft.models[0].vision).toBeUndefined()
  })

  it('a fresh Add draft becomes the served models; one model opens, several stay folded', async () => {
    answer = {
      status: 'detected',
      server: 'vllm',
      models: [{ id: 'a', contextWindow: 65_536 }, { id: 'b' }]
    }
    render(<Host initial={blankProviderDraft()} />)
    await typeInto(screen.getByTestId('ProviderForm.baseUrl'), 'http://x/v1')
    await detect()
    expect(draft.models.map((model) => model.id)).toEqual(['a', 'b'])
    expect(screen.queryAllByTestId('ProviderForm.modelDetails')).toHaveLength(0)
    expect(screen.getAllByTestId('ProviderForm.modelSummary')).toHaveLength(2)
    cleanup()

    answer = { status: 'detected', server: 'vllm', models: [{ id: 'only' }] }
    render(<Host initial={blankProviderDraft()} />)
    await typeInto(screen.getByTestId('ProviderForm.baseUrl'), 'http://x/v1')
    await detect()
    expect(screen.getAllByTestId('ProviderForm.modelDetails')).toHaveLength(1)
  })

  it('offers the served models the list lacks, imports them, and marks one not served', async () => {
    answer = {
      status: 'detected',
      server: 'openai-compatible',
      models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    }
    render(<Host initial={saved([{ id: 'a' }, { id: 'retired' }])} idLocked />)
    await detect()

    expect(byId('ProviderForm.notServed', '1')).toHaveTextContent('not served by this endpoint')
    expect(screen.queryAllByTestId('ProviderForm.notServed').map((el) => el.dataset.id)).toEqual([
      '1'
    ])
    const importButton = screen.getByTestId('ProviderForm.importModels')
    expect(importButton).toHaveTextContent('Import served models (2 new)')
    await click(importButton)
    expect(draft.models.map((model) => model.id)).toEqual(['a', 'retired', 'b', 'c'])
    expect(draft.models[2].detected).toMatchObject({ server: 'openai-compatible' })
    expect(screen.queryByTestId('ProviderForm.importModels')).not.toBeInTheDocument()
  })

  it('the offer is live: removing a served model offers it again', async () => {
    answer = { status: 'detected', server: 'openai-compatible', models: [{ id: 'a' }, { id: 'b' }] }
    render(<Host initial={saved([{ id: 'a' }, { id: 'b' }])} idLocked />)
    await detect()
    expect(screen.queryByTestId('ProviderForm.importModels')).not.toBeInTheDocument()

    await click(byId('ProviderForm.removeModel', '1'))
    expect(screen.getByTestId('ProviderForm.importModels')).toHaveTextContent(
      'Import served models (1 new)'
    )
    await click(screen.getByTestId('ProviderForm.importModels'))
    expect(draft.models.map((model) => model.id)).toEqual(['a', 'b'])
    expect(screen.queryByTestId('ProviderForm.importModels')).not.toBeInTheDocument()
  })
})

// ── The output warning ───────────────────────────────────────────────

describe('the output warning', () => {
  it('warns on a 32K context with the default output, and Set makes it a suggestion', async () => {
    render(
      <Host
        initial={saved([
          {
            id: 'lora',
            contextWindow: 32_768,
            detected: { server: 'vllm', at: AT, contextWindow: 32_768 }
          }
        ])}
        idLocked
      />
    )
    const warning = byId('ProviderForm.outputWarning', '0')
    expect(warning).toHaveTextContent('the default max output of 32,000 leaves ~768 tokens')
    const set = byId('ProviderForm.applySuggestedOutput', '0')
    expect(set).toHaveTextContent('Set 8,192')

    await click(set)
    expect(draft.models[0]).toMatchObject({
      maxTokens: 8_192,
      detected: { maxTokens: 8_192 }
    })
    await expand(0)
    expect(source(0, 'maxTokens')).toBe('suggested')
    expect(screen.queryByTestId('ProviderForm.outputWarning')).not.toBeInTheDocument()
  })

  it('says there is no room when the output is at least the context', () => {
    render(
      <Host initial={saved([{ id: 'tight', contextWindow: 16_384, maxTokens: 20_000 }])} idLocked />
    )
    const warning = byId('ProviderForm.outputWarning', '0')
    expect(warning).toHaveTextContent(
      '16.4K context with a max output of 20,000 leaves no room for the prompt. Set Max output to about 4.1K.'
    )
    expect(byId('ProviderForm.applySuggestedOutput', '0')).toHaveTextContent('Set 4,096')
  })

  it('names the headroom without claiming every turn compacts', () => {
    render(
      <Host initial={saved([{ id: 'big', contextWindow: 131_072, maxTokens: 70_000 }])} idLocked />
    )
    expect(byId('ProviderForm.outputWarning', '0')).toHaveTextContent(
      '131.1K context with a max output of 70,000 leaves ~61,072 tokens for the prompt before the harness compacts. Set Max output to about 32.8K.'
    )
    expect(byId('ProviderForm.outputWarning', '0')).not.toHaveTextContent('every turn')
  })

  it('does not warn when only pi is on (16,384 is half of 32K)', () => {
    render(
      <Host
        initial={{
          ...saved([{ id: 'lora', contextWindow: 32_768 }]),
          routes: { pi: { enabled: true }, opencode: { enabled: false } }
        }}
        idLocked
      />
    )
    expect(screen.queryByTestId('ProviderForm.outputWarning')).not.toBeInTheDocument()
  })

  it('measures only harnesses that run: a saved opencode route is not counted while opencode is not installed (GUARD)', async () => {
    // Both routes stay enabled in the definition (ADR-082 §8 keeps a hidden
    // harness's route), but nothing is delivered to opencode, so only pi's
    // 16,384 default is reserved, which is half of 32K.
    app.bridge.ipcMain.handle('harness:state', async () => harnessSnapshot(['opencode']))
    await act(async () => {
      await harnessStore.refresh()
    })
    render(<Host initial={saved([{ id: 'lora', contextWindow: 32_768 }])} idLocked />)
    expect(draft.routes.opencode.enabled).toBe(true)
    expect(screen.queryByTestId('ProviderForm.engines')).toBeInTheDocument()
    expect(screen.queryByTestId('ProviderForm.outputWarning')).not.toBeInTheDocument()
  })
})

// ── Detect again ─────────────────────────────────────────────────────

describe('Detect again (GUARD)', () => {
  // Detected at 32K, then the user typed their own context window.
  const edited = (): SharedProviderDefinition =>
    saved([
      {
        id: 'llama',
        contextWindow: 16_000,
        maxTokens: 8_192,
        detected: { server: 'vllm', at: AT, contextWindow: 32_768, maxTokens: 8_192 }
      }
    ])

  beforeEach(() => {
    answer = {
      status: 'detected',
      server: 'vllm',
      models: [{ id: 'llama', contextWindow: 32_768 }]
    }
  })

  it('shows an edited field as a change, and leaves it alone until asked', async () => {
    render(<Host initial={edited()} idLocked />)
    await detect()
    const diff = screen.getByTestId('ProviderForm.detectChanges')
    expect(within(diff).getAllByTestId('ProviderForm.detectChange')).toHaveLength(1)
    expect(diff).toHaveTextContent('llama context 16,000 → 32,768 (you edited this)')
    expect(draft.models[0].contextWindow).toBe(16_000)
  })

  it('Apply writes the server’s value and makes it the baseline', async () => {
    render(<Host initial={edited()} idLocked />)
    await detect()
    await click(screen.getByTestId('ProviderForm.applyChanges'))
    expect(draft.models[0]).toMatchObject({
      contextWindow: 32_768,
      detected: { contextWindow: 32_768 }
    })
    expect(screen.queryByTestId('ProviderForm.detectChanges')).not.toBeInTheDocument()
    await expand(0)
    expect(source(0, 'contextWindow')).toBe('server')
  })

  it('Ignore dismisses the diff and keeps the user’s value', async () => {
    render(<Host initial={edited()} idLocked />)
    await detect()
    await click(screen.getByTestId('ProviderForm.ignoreChanges'))
    expect(screen.queryByTestId('ProviderForm.detectChanges')).not.toBeInTheDocument()
    expect(draft.models[0].contextWindow).toBe(16_000)
    await expand(0)
    expect(source(0, 'contextWindow')).toBe('manual')
  })

  it('a result belongs to its URL: editing the URL or protocol clears it (GUARD)', async () => {
    answer = {
      status: 'detected',
      server: 'vllm',
      models: [{ id: 'llama', contextWindow: 32_768 }, { id: 'other-server-model' }]
    }
    const everything = (): (HTMLElement | null)[] => [
      screen.queryByTestId('ProviderForm.detectResult'),
      screen.queryByTestId('ProviderForm.importModels'),
      screen.queryByTestId('ProviderForm.detectChanges')
    ]
    render(<Host initial={edited()} idLocked />)
    await detect()
    expect(everything().every(Boolean)).toBe(true)

    await typeInto(screen.getByTestId('ProviderForm.baseUrl'), 'http://10.0.9.9:8000/v1')
    expect(everything()).toEqual([null, null, null])
    // …and nothing about the old server reached the draft.
    expect(draft.models.map((model) => model.id)).toEqual(['llama'])

    await detect()
    expect(everything().every(Boolean)).toBe(true)
    chooseSelectMenuOption(screen.getByTestId('ProviderForm.protocol'), 'openai-responses')
    await act(async () => {})
    expect(draft.protocol).toBe('openai-responses')
    expect(everything()).toEqual([null, null, null])
  })

  it('an answer for a URL the user has since changed fills nothing', async () => {
    let release: (value: EndpointProbeResult) => void = () => undefined
    app.bridge.ipcMain.removeHandler('shared-provider:probe')
    app.bridge.ipcMain.handle(
      'shared-provider:probe',
      () => new Promise<EndpointProbeResult>((resolve) => (release = resolve))
    )
    render(<Host initial={saved([{ id: 'llama' }])} idLocked />)
    await click(screen.getByTestId('ProviderForm.detect'))
    await typeInto(screen.getByTestId('ProviderForm.baseUrl'), 'http://10.0.9.9:8000/v1')
    await act(async () => {
      release({
        status: 'detected',
        server: 'vllm',
        models: [{ id: 'llama', contextWindow: 4096 }]
      })
    })
    expect(screen.queryByTestId('ProviderForm.detectResult')).not.toBeInTheDocument()
    expect(draft.models[0].contextWindow).toBeUndefined()
    expect(screen.getByTestId('ProviderForm.detect')).not.toBeDisabled()
  })

  it('a line answered by hand drops out, and Apply never overwrites that edit (GUARD)', async () => {
    // The verifier's repro: detected at 32K, the server now reports 64K, so the
    // diff offers the context AND the suggestion that follows it.
    answer = {
      status: 'detected',
      server: 'vllm',
      models: [{ id: 'llama', contextWindow: 65_536 }]
    }
    render(
      <Host
        initial={saved([
          {
            id: 'llama',
            contextWindow: 32_768,
            maxTokens: 8_192,
            detected: { server: 'vllm', at: AT, contextWindow: 32_768, maxTokens: 8_192 }
          }
        ])}
        idLocked
      />
    )
    await detect()
    const lines = (): (string | undefined)[] =>
      screen.queryAllByTestId('ProviderForm.detectChange').map((el) => el.dataset.id)
    expect(lines()).toEqual(['llama:contextWindow', 'llama:maxTokens'])

    await expand(0)
    await commitNumber(byId('ProviderForm.maxTokens', '0'), '4000')
    expect(lines()).toEqual(['llama:contextWindow'])

    await click(screen.getByTestId('ProviderForm.applyChanges'))
    expect(draft.models[0]).toMatchObject({ contextWindow: 65_536, maxTokens: 4_000 })
    expect(screen.queryByTestId('ProviderForm.detectChanges')).not.toBeInTheDocument()
  })

  it('the diff disappears once every line has been answered by hand', async () => {
    render(<Host initial={edited()} idLocked />)
    await detect()
    await expand(0)
    await commitNumber(byId('ProviderForm.contextWindow', '0'), '20000')
    expect(screen.queryByTestId('ProviderForm.detectChanges')).not.toBeInTheDocument()
  })

  it('the Detect again link runs the probe again', async () => {
    render(<Host initial={edited()} idLocked />)
    await detect()
    await click(screen.getByTestId('ProviderForm.detectAgain'))
    expect(probes).toHaveLength(2)
  })
})

// ── Failure ──────────────────────────────────────────────────────────

describe('a failed Detect', () => {
  it('shows the banner and changes nothing', async () => {
    answer = {
      status: 'failed',
      reason: 'unauthorized',
      message: 'http://10.0.4.12:8000/v1/models refused the request (HTTP 401).',
      keyWithheld: true
    }
    const initial = saved([{ id: 'llama', contextWindow: 8_000 }])
    render(<Host initial={initial} idLocked />)
    await detect()

    const banner = screen.getByTestId('ProviderForm.detectResult')
    expect(banner).toHaveAttribute('data-state', 'failed')
    expect(banner).toHaveTextContent('refused the request (HTTP 401)')
    expect(banner).toHaveTextContent('Enter the API key above, then Detect again.')
    expect(banner).toHaveTextContent('The saved key is only sent to the saved address')
    expect(draft).toEqual(initial)
    expect(screen.queryByTestId('ProviderForm.detectChanges')).not.toBeInTheDocument()
  })

  it('a refused call renders as a failure too', async () => {
    app.bridge.ipcMain.removeHandler('shared-provider:probe')
    app.bridge.ipcMain.handle('shared-provider:probe', async () => ({
      ok: false,
      error: 'permission denied'
    }))
    render(<Host initial={saved([{ id: 'llama' }])} idLocked />)
    await detect()
    expect(screen.getByTestId('ProviderForm.detectResult')).toHaveAttribute('data-state', 'failed')
    expect(screen.getByTestId('ProviderForm.detectResult')).toHaveTextContent('permission denied')
  })
})

// ── Editing by hand ──────────────────────────────────────────────────

describe('editing a model by hand', () => {
  it('a typed value badges manual; clearing it returns to the engine default', async () => {
    render(<Host initial={saved([{ id: 'llama' }])} idLocked />)
    expect(byId('ProviderForm.modelSummary', '0')).toHaveTextContent('context: default')
    await expand(0)

    await commitNumber(byId('ProviderForm.contextWindow', '0'), '65536')
    expect(draft.models[0].contextWindow).toBe(65_536)
    expect(source(0, 'contextWindow')).toBe('manual')

    await commitNumber(byId('ProviderForm.contextWindow', '0'), '')
    expect(draft.models[0]).not.toHaveProperty('contextWindow')
    expect(source(0, 'contextWindow')).toBe('default')

    await click(byId('ProviderForm.detail', 'vision'))
    expect(draft.models[0].vision).toBe(true)
  })

  it('a newly added row opens only when it is the only one', async () => {
    render(<Host initial={saved([])} idLocked />)
    await click(screen.getByTestId('ProviderForm.addModel'))
    expect(screen.getAllByTestId('ProviderForm.modelDetails')).toHaveLength(1)
    await click(screen.getByTestId('ProviderForm.addModel'))
    expect(screen.getAllByTestId('ProviderForm.modelDetails')).toHaveLength(1)
    expect(screen.getAllByTestId('ProviderForm.modelSummary')).toHaveLength(1)
  })
})
