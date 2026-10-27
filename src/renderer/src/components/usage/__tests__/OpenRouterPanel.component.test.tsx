/**
 * `OpenRouterPanel` — the OpenRouter tab's body.
 *
 * Worth guarding: a missing figure says so instead of drawing a zero (no limit,
 * no credits), the reconciliation strip says nothing it cannot back up, and the
 * Models card spends one endpoints read per open.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { OpenRouterPanel } from '../OpenRouterPanel'
import { makeEndpoint, makeKey, makeModel, makeOverview } from './openrouter-fixtures'

const MODELS = [
  makeModel(),
  makeModel({ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', codingIndex: 71.5 })
]

let overviewFn: ReturnType<typeof vi.fn>
let modelsFn: ReturnType<typeof vi.fn>
let endpointsFn: ReturnType<typeof vi.fn>

function renderPanel(onOpenSpend = vi.fn()): ReturnType<typeof render> {
  return render(<OpenRouterPanel onOpenSpend={onOpenSpend} />)
}

beforeEach(() => {
  overviewFn = vi.fn().mockResolvedValue(makeOverview())
  modelsFn = vi.fn().mockResolvedValue(MODELS)
  endpointsFn = vi.fn().mockResolvedValue([makeEndpoint()])
  ;(window as any).api = {
    openrouterOverview: overviewFn,
    openrouterModels: modelsFn,
    openrouterModelEndpoints: endpointsFn
  }
})

afterEach(() => {
  vi.useRealTimers()
})

async function ready(): Promise<void> {
  await screen.findByTestId('OpenRouterPanel.budget')
}

describe('OpenRouterPanel — cards', () => {
  it('draws budget, spend, credits and free-model cards from the overview', async () => {
    renderPanel()
    await ready()

    const budget = screen.getByTestId('OpenRouterPanel.budget')
    expect(within(budget).getByText('$42.50')).toBeInTheDocument()
    expect(within(budget).getByText('/ $100.00')).toBeInTheDocument()
    expect(within(budget).getByText('$57.50 left')).toBeInTheDocument()
    expect(screen.getByTestId('OpenRouterPanel.budget.bar')).toHaveStyle({ width: '42.5%' })

    const spend = screen.getByTestId('OpenRouterPanel.spend')
    expect(within(spend).getByText('$210.75')).toBeInTheDocument()

    const credits = screen.getByTestId('OpenRouterPanel.credits')
    expect(within(credits).getByText('$1,019.75')).toBeInTheDocument()
    // 210.75 / 480.25
    expect(credits).toHaveTextContent('44%')

    expect(screen.getByTestId('OpenRouterPanel.freeModels')).toHaveTextContent('/ 1,000 requests')
    expect(screen.getByTestId('OpenRouterPanel.keyLabel')).toHaveTextContent('sk-or-v1-…abc')
  })

  it('says "No limit" and draws no bar when the key has no limit', async () => {
    overviewFn.mockResolvedValue(
      makeOverview({
        key: makeKey({ limitUsd: null, limitRemainingUsd: null, limitReset: null, resetsAt: null })
      })
    )
    renderPanel()
    await ready()

    expect(screen.getByTestId('OpenRouterPanel.budget')).toHaveTextContent('No limit')
    expect(screen.queryByTestId('OpenRouterPanel.budget.bar')).toBeNull()
    expect(screen.queryByTestId('OpenRouterPanel.budget.pace')).toBeNull()
  })

  it('says the credits are unavailable, with the reason, when /credits failed', async () => {
    overviewFn.mockResolvedValue(
      makeOverview({ credits: null, partialErrors: { credits: 'OpenRouter is unavailable' } })
    )
    renderPanel()
    await ready()

    const credits = screen.getByTestId('OpenRouterPanel.credits')
    expect(credits).toHaveTextContent('Unavailable')
    expect(credits).toHaveTextContent('OpenRouter is unavailable')
    // The other cards are unaffected.
    expect(screen.getByTestId('OpenRouterPanel.spend')).toBeInTheDocument()
  })

  it('omits the free-models card when OpenRouter reported no free-model counter', async () => {
    overviewFn.mockResolvedValue(makeOverview({ key: makeKey({ freeModelRequests: null }) }))
    renderPanel()
    await ready()
    expect(screen.queryByTestId('OpenRouterPanel.freeModels')).toBeNull()
  })

  it('projects month end only for a monthly limit with >= 3 UTC days elapsed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 10 elapsed days of a 31-day month: $42.50 of spend projects to ~$132.
    vi.setSystemTime(new Date('2026-10-11T00:00:00Z'))
    const { unmount } = renderPanel()
    await ready()
    expect(screen.getByTestId('OpenRouterPanel.budget.pace')).toHaveTextContent('~$132')
    unmount()

    // Under three days in: too early to say anything.
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'))
    renderPanel()
    await ready()
    expect(screen.queryByTestId('OpenRouterPanel.budget.pace')).toBeNull()
  })

  it('does not project a weekly limit', async () => {
    overviewFn.mockResolvedValue(makeOverview({ key: makeKey({ limitReset: 'weekly' }) }))
    renderPanel()
    await ready()
    expect(screen.queryByTestId('OpenRouterPanel.budget.pace')).toBeNull()
  })
})

describe('OpenRouterPanel — reconciliation', () => {
  it('is hidden when the ledger could not be read', async () => {
    overviewFn.mockResolvedValue(makeOverview({ ledger: null }))
    renderPanel()
    await ready()
    expect(screen.queryByTestId('OpenRouterPanel.reconcile')).toBeNull()
  })

  it('states both figures and the gap, naming machines only past one', async () => {
    overviewFn.mockResolvedValue(
      makeOverview({ ledger: { sinceUtc: '2026-10-01T00:00:00Z', costUsd: 41.1, machines: 3 } })
    )
    renderPanel()
    await ready()

    const strip = screen.getByTestId('OpenRouterPanel.reconcile')
    expect(strip).toHaveTextContent('recorded $41.10 on this key since Oct 1 across 3 machines')
    expect(strip).toHaveTextContent('says $42.50 this month')
    expect(screen.getByTestId('OpenRouterPanel.reconcile.gap')).toHaveTextContent('$1.40')
  })

  it('hides the gap line when the two agree to the cent', async () => {
    overviewFn.mockResolvedValue(
      makeOverview({ ledger: { sinceUtc: '2026-10-01T00:00:00Z', costUsd: 42.5, machines: 1 } })
    )
    renderPanel()
    await ready()

    expect(screen.getByTestId('OpenRouterPanel.reconcile')).not.toHaveTextContent('machines')
    expect(screen.queryByTestId('OpenRouterPanel.reconcile.gap')).toBeNull()
  })

  it('hands "Open in Spend" to the shell', async () => {
    const onOpenSpend = vi.fn()
    renderPanel(onOpenSpend)
    await ready()
    fireEvent.click(screen.getByTestId('OpenRouterPanel.reconcile.openSpend'))
    expect(onOpenSpend).toHaveBeenCalledTimes(1)
  })
})

describe('OpenRouterPanel — reading', () => {
  it('shows one error card with a retry when the overview fails', async () => {
    overviewFn.mockRejectedValueOnce(new Error('OpenRouter rejected the key'))
    renderPanel()

    const error = await screen.findByTestId('OpenRouterPanel.error')
    expect(error).toHaveTextContent('OpenRouter rejected the key')
    expect(screen.queryByTestId('OpenRouterPanel.budget')).toBeNull()

    fireEvent.click(screen.getByTestId('OpenRouterPanel.error.retry'))
    await ready()
    expect(screen.queryByTestId('OpenRouterPanel.error')).toBeNull()
    expect(overviewFn).toHaveBeenCalledTimes(2)
  })

  it('reads once on mount and drops a refresh click while a read is in flight', async () => {
    let resolve: (v: unknown) => void = () => {}
    overviewFn.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    renderPanel()
    expect(overviewFn).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('OpenRouterPanel.refresh'))
    expect(overviewFn).toHaveBeenCalledTimes(1)

    resolve(makeOverview())
    await ready()
    fireEvent.click(screen.getByTestId('OpenRouterPanel.refresh'))
    await waitFor(() => expect(overviewFn).toHaveBeenCalledTimes(2))
  })
})

describe('OpenRouterPanel — models', () => {
  it('lists Mine, then reads All on toggle', async () => {
    renderPanel()
    await ready()
    await screen.findAllByTestId('OpenRouterPanel.models.row')
    expect(modelsFn).toHaveBeenCalledWith('user')
    expect(screen.getByTestId('OpenRouterPanel.models.scope.user')).toHaveTextContent('Mine (2)')

    fireEvent.click(screen.getByTestId('OpenRouterPanel.models.scope.all'))
    expect(screen.getByTestId('OpenRouterPanel.models.scope.all')).toHaveTextContent('All (464)')
    await waitFor(() => expect(modelsFn).toHaveBeenCalledWith('all'))
  })

  it('narrows the rows with the text filter, by id or name', async () => {
    renderPanel()
    const rows = await screen.findAllByTestId('OpenRouterPanel.models.row')
    expect(rows).toHaveLength(2)

    fireEvent.change(screen.getByTestId('OpenRouterPanel.models.filter'), {
      target: { value: 'GLM' }
    })
    const left = screen.getAllByTestId('OpenRouterPanel.models.row')
    expect(left.map((r) => r.getAttribute('data-id'))).toEqual(['z-ai/glm-5.3-flash'])

    fireEvent.change(screen.getByTestId('OpenRouterPanel.models.filter'), {
      target: { value: 'nothing-like-this' }
    })
    expect(screen.queryAllByTestId('OpenRouterPanel.models.row')).toHaveLength(0)
    expect(screen.getByTestId('OpenRouterPanel.models.empty')).toBeInTheDocument()
  })

  it('loads endpoints once on open, fastest first, and collapses on the second click', async () => {
    endpointsFn.mockResolvedValue([
      makeEndpoint({ provider: 'Slow', throughputP50: 100 }),
      makeEndpoint({ provider: 'Fast', throughputP50: 600 }),
      makeEndpoint({ provider: 'Sick', throughputP50: 300, status: -5, uptime1d: 84.5 }),
      makeEndpoint({ provider: 'NoReading', throughputP50: null })
    ])
    renderPanel()
    const [row] = await screen.findAllByTestId('OpenRouterPanel.models.row')

    fireEvent.click(row)
    const endpoints = await screen.findByTestId('OpenRouterPanel.endpoints')
    expect(endpointsFn).toHaveBeenCalledTimes(1)
    expect(endpointsFn).toHaveBeenCalledWith('deepseek/deepseek-v4.1-flash')

    const providers = within(endpoints)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelector('td')?.textContent)
    expect(providers).toEqual(['Fast', 'Sickdegraded', 'Slow', 'NoReading'])
    expect(within(endpoints).getAllByTestId('OpenRouterPanel.endpoints.degraded')).toHaveLength(1)
    // 84.5 is below the 90 amber line.
    expect(within(endpoints).getByText('84.5%')).toHaveClass('text-danger')

    fireEvent.click(row)
    expect(screen.queryByTestId('OpenRouterPanel.endpoints')).toBeNull()
    expect(endpointsFn).toHaveBeenCalledTimes(1)
  })

  it('scrolls the endpoints inside the card only past eight rows', async () => {
    endpointsFn.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => makeEndpoint({ provider: `P${i}`, throughputP50: i }))
    )
    renderPanel()
    const [row] = await screen.findAllByTestId('OpenRouterPanel.models.row')
    fireEvent.click(row)
    const endpoints = await screen.findByTestId('OpenRouterPanel.endpoints')
    expect(endpoints.querySelector('[data-scrolls="true"]')).not.toBeNull()
  })

  it('shows an endpoint read failing on its own line, not as a panel error', async () => {
    endpointsFn.mockRejectedValue(new Error('rate limited'))
    renderPanel()
    const [row] = await screen.findAllByTestId('OpenRouterPanel.models.row')
    fireEvent.click(row)
    expect(await screen.findByTestId('OpenRouterPanel.endpoints.error')).toHaveTextContent(
      'rate limited'
    )
    expect(screen.queryByTestId('OpenRouterPanel.error')).toBeNull()
  })
})
