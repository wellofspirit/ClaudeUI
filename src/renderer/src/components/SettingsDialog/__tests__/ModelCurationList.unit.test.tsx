/**
 * Layer 1: `ModelCurationList` — "Models in the picker" as a grouped,
 * filterable list (settings-v2 follow-up G, owner-approved mockup `0a41c623`).
 *
 * The component writes nothing itself: `onSet` is its ONE output, and the
 * caller (`OpencodeModelCuration`) owns the orphan guard and the IPC. So what
 * is guarded here is the part a screenshot cannot check — WHICH set every
 * affordance produces, and WHICH models each filter leaves visible:
 *
 *  · a vendor checkbox and Select all act on what the FILTERS show, not on the
 *    whole group and not on what the disclosure state happens to reveal. Get
 *    that wrong and "search a vendor, select all" silently curates 358 models.
 *  · facets NARROW; none of them selects anything.
 *  · previews (`ROW_PREVIEW` / `GROUP_HEADERS_PREVIEW`) exist only while no
 *    filter is active — hiding a search hit behind "Show more" would hide the
 *    very row the user searched for.
 *
 * Everything is driven through a harness that holds the LIFTED state (search,
 * facets, sort, selection), because that is how the sheet wires it: the bulk
 * actions render in the row's title line, outside the list's subtree, and they
 * have to agree with it about what "shown" means.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useState } from 'react'
import {
  GROUP_HEADERS_PREVIEW,
  ModelCurationActions,
  ModelCurationList,
  ROW_PREVIEW,
  vendorLabel,
  visibleModels,
  type CurationFacet,
  type CurationModel,
  type CurationSort
} from '../ModelCurationList'

// ── Fixtures ─────────────────────────────────────────────────────────

/** 14 models over 4 vendor prefixes — the shape a gateway catalog has. */
const CATALOG: CurationModel[] = [
  // deepseek/ · 5
  {
    id: 'deepseek/v4-flash-0731',
    name: 'DeepSeek V4 Flash 0731',
    releaseDate: '2026-07-31',
    reasoning: true,
    toolCalling: true
  },
  {
    id: 'deepseek/v4-flash',
    name: 'DeepSeek V4 Flash Latest',
    releaseDate: '2026-08-02',
    reasoning: true,
    toolCalling: true
  },
  {
    id: 'deepseek/v4-pro',
    name: 'DeepSeek V4 Pro',
    releaseDate: '2026-08-13',
    reasoning: true,
    toolCalling: true
  },
  {
    id: 'deepseek/v3-lite',
    name: 'DeepSeek V3 Lite',
    releaseDate: '2025-11-01',
    toolCalling: true
  },
  { id: 'deepseek/coder-2', name: 'DeepSeek Coder 2', toolCalling: true },
  // openai/ · 4
  { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', releaseDate: '2026-05-01', toolCalling: true },
  { id: 'openai/gpt-6-mini', name: 'GPT-6 Mini', releaseDate: '2026-06-01', toolCalling: true },
  {
    id: 'openai/gpt-5-6-luna',
    name: 'GPT-5.6 Luna',
    releaseDate: '2026-01-01',
    reasoning: true,
    toolCalling: true
  },
  { id: 'openai/o5', name: 'O5', reasoning: true },
  // nvidia/ · 3 (the only free ones, and none of them calls tools)
  { id: 'nvidia/nemotron-5', name: 'Nemotron 5', releaseDate: '2026-03-01', free: true },
  { id: 'nvidia/nemotron-mini', name: 'Nemotron Mini', releaseDate: '2026-04-01', free: true },
  { id: 'nvidia/nemotron-ultra', name: 'Nemotron Ultra', releaseDate: '2026-02-01' },
  // moonshotai/ · 2
  {
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3',
    releaseDate: '2026-06-15',
    reasoning: true,
    toolCalling: true
  },
  { id: 'moonshotai/kimi-k2', name: 'Kimi K2', releaseDate: '2026-01-15', toolCalling: true }
]

/** A provider whose ids carry no vendor prefix at all (opencode zen). */
const FLAT: CurationModel[] = [
  { id: 'grok-code', name: 'Grok Code', releaseDate: '2026-02-01' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', releaseDate: '2026-04-01' },
  { id: 'qwen3-coder', name: 'Qwen3 Coder', releaseDate: '2026-03-01' },
  { id: 'kimi-k2', name: 'Kimi K2', releaseDate: '2026-01-01' }
]

/** Ten one-model vendors: enough to hit `GROUP_HEADERS_PREVIEW`. */
const MANY_VENDORS: CurationModel[] = Array.from({ length: 10 }, (_, i) => ({
  id: `v${i}/only`,
  name: `Vendor ${i} model`
}))

const SELECTED = ['deepseek/v4-flash-0731', 'moonshotai/kimi-k3']

// ── Harness ──────────────────────────────────────────────────────────

/** Every list `onSet` produced, in order. */
let sets: string[][]

beforeEach(() => {
  sets = []
})

function Harness({
  models,
  initialSelected = []
}: {
  models: CurationModel[]
  initialSelected?: string[]
}): React.JSX.Element {
  const [selected, setSelected] = useState(initialSelected)
  const [filter, setFilter] = useState('')
  const [facets, setFacets] = useState<CurationFacet[]>([])
  const [sort, setSort] = useState<CurationSort>('newest')
  const onSet = (next: string[]): void => {
    sets.push(next)
    setSelected(next)
  }
  return (
    <>
      <ModelCurationActions
        testid="T"
        models={models}
        selected={selected}
        onSet={onSet}
        filter={filter}
        facets={facets}
      />
      <ModelCurationList
        testid="T"
        models={models}
        selected={selected}
        onSet={onSet}
        total={models.length}
        filter={filter}
        onFilterChange={setFilter}
        facets={facets}
        onFacetsChange={setFacets}
        sort={sort}
        onSortChange={setSort}
      />
    </>
  )
}

const mount = (models = CATALOG, initialSelected = SELECTED): void => {
  render(<Harness models={models} initialSelected={initialSelected} />)
}

const part = (name: string): HTMLElement[] => screen.queryAllByTestId(`T.${name}`)
const ids = (name: string): (string | undefined)[] => part(name).map((el) => el.dataset.id)
const byId = (name: string, id: string): HTMLElement =>
  part(name).find((el) => el.dataset.id === id)!
const rowsOf = (prefix: string): (string | undefined)[] =>
  ids('row').filter((id) => id?.startsWith(`${prefix}/`))
const search = (value: string): void => {
  fireEvent.change(screen.getByTestId('T.filter'), { target: { value } })
}

// ── Helpers, on their own ────────────────────────────────────────────

describe('helpers', () => {
  it('spells the common vendors the way their own docs do, and guesses the rest', () => {
    expect(vendorLabel('x-ai')).toBe('xAI')
    expect(vendorLabel('moonshotai')).toBe('Moonshot')
    expect(vendorLabel('meta-llama')).toBe('Meta')
    expect(vendorLabel('nvidia')).toBe('NVIDIA')
    // Unknown prefixes are capitalised, never printed raw.
    expect(vendorLabel('acme-labs')).toBe('Acme-labs')
    // A model with no `/` groups under `other`.
    expect(vendorLabel('other')).toBe('Other')
  })

  it('AND-s search with every active facet, matching name OR id', () => {
    expect(visibleModels(CATALOG, SELECTED, 'NEMOTRON', []).map((m) => m.id)).toEqual([
      'nvidia/nemotron-5',
      'nvidia/nemotron-mini',
      'nvidia/nemotron-ultra'
    ])
    // `v4-flash` appears in the id only; `Kimi` in the name only.
    expect(visibleModels(CATALOG, SELECTED, 'v4-flash', []).map((m) => m.id)).toEqual([
      'deepseek/v4-flash-0731',
      'deepseek/v4-flash'
    ])
    expect(visibleModels(CATALOG, SELECTED, 'kimi', ['selected']).map((m) => m.id)).toEqual([
      'moonshotai/kimi-k3'
    ])
    expect(visibleModels(CATALOG, SELECTED, 'nemotron', ['free']).map((m) => m.id)).toEqual([
      'nvidia/nemotron-5',
      'nvidia/nemotron-mini'
    ])
  })
})

// ── Grouping ─────────────────────────────────────────────────────────

describe('vendor groups', () => {
  it('orders selected vendors first, then the biggest, and labels them', () => {
    mount()
    // deepseek and moonshotai each hold one selection (tie → alphabetical by
    // label), then the rest by model count: openai 4, nvidia 3.
    expect(ids('group')).toEqual(['deepseek', 'moonshotai', 'openai', 'nvidia'])
    expect(byId('group', 'nvidia')).toHaveTextContent('NVIDIA')
    expect(byId('group', 'moonshotai')).toHaveTextContent('Moonshot')
  })

  it('counts the WHOLE group in the header, and says how many are free', () => {
    mount()
    expect(byId('group', 'deepseek')).toHaveTextContent('deepseek/ · 1 of 5')
    // The mockup's NVIDIA row: free is worth naming, and only when there is one.
    expect(byId('group', 'nvidia')).toHaveTextContent('nvidia/ · 0 of 3 · 2 free')
    expect(byId('group', 'openai').textContent).not.toContain('free')
  })

  it('renders ONE flat list when the ids carry no vendor prefix', () => {
    mount(FLAT, [])
    expect(part('group')).toEqual([])
    expect(part('groupToggle')).toEqual([])
    // Flat means always open — there is no header to open it with.
    expect(ids('row')).toEqual(['claude-sonnet-4-5', 'qwen3-coder', 'grok-code'])
    expect(byId('showMore', 'other')).toHaveTextContent('Show 1 more')
  })

  it('opens the vendors with a selection and leaves the rest collapsed', () => {
    mount()
    expect(byId('groupExpand', 'deepseek')).toHaveAttribute('aria-expanded', 'true')
    expect(byId('groupExpand', 'moonshotai')).toHaveAttribute('aria-expanded', 'true')
    expect(byId('groupExpand', 'openai')).toHaveAttribute('aria-expanded', 'false')
    expect(rowsOf('openai')).toEqual([])
  })

  it('toggles a group from anywhere on the header except the checkbox', () => {
    mount()
    fireEvent.click(byId('group', 'openai'))
    expect(byId('groupExpand', 'openai')).toHaveAttribute('aria-expanded', 'true')
    expect(rowsOf('openai').length).toBe(ROW_PREVIEW)

    fireEvent.click(byId('group', 'openai'))
    expect(byId('groupExpand', 'openai')).toHaveAttribute('aria-expanded', 'false')

    // The caret is the same action, and the checkbox is NOT: clicking it must
    // not also collapse the group it just filled.
    fireEvent.click(byId('groupExpand', 'openai'))
    expect(byId('groupExpand', 'openai')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(byId('groupToggle', 'openai'))
    expect(byId('groupExpand', 'openai')).toHaveAttribute('aria-expanded', 'true')
  })

  it('caps the vendor list, then reveals all of it', () => {
    mount(MANY_VENDORS, [])
    expect(part('group')).toHaveLength(GROUP_HEADERS_PREVIEW)
    expect(screen.getByTestId('T.moreVendors')).toHaveTextContent(
      `… ${10 - GROUP_HEADERS_PREVIEW} more vendors — type to search, or show them`
    )

    fireEvent.click(screen.getByTestId('T.moreVendors'))
    expect(part('group')).toHaveLength(10)
    expect(part('moreVendors')).toEqual([])
  })
})

// ── Search and facets ────────────────────────────────────────────────

describe('search and facets', () => {
  it('names the catalog size in the placeholder', () => {
    mount()
    expect(screen.getByTestId('T.filter')).toHaveAttribute(
      'placeholder',
      'Search 14 models by name or id…'
    )
  })

  it('auto-expands every matching group, hides the rest, and lifts the cap', () => {
    mount()
    search('nemotron')
    expect(ids('group')).toEqual(['nvidia'])
    expect(byId('groupExpand', 'nvidia')).toHaveAttribute('aria-expanded', 'true')
    // All three matches render: a preview would hide a search hit.
    expect(rowsOf('nvidia')).toHaveLength(3)
    expect(part('showMore')).toEqual([])

    // A user toggle still wins — until the filter changes again.
    fireEvent.click(byId('group', 'nvidia'))
    expect(rowsOf('nvidia')).toEqual([])
    search('nemotron-5')
    expect(rowsOf('nvidia')).toEqual(['nvidia/nemotron-5'])
  })

  it('says how much of the WHOLE catalog each facet holds', () => {
    mount()
    expect(ids('facet')).toEqual(['selected', 'free', 'reasoning', 'tools'])
    expect(byId('facet', 'selected')).toHaveTextContent('Selected · 2')
    expect(byId('facet', 'free')).toHaveTextContent('Free · 2')
    expect(byId('facet', 'reasoning')).toHaveTextContent('Reasoning · 6')
    expect(byId('facet', 'tools')).toHaveTextContent('Tool calling · 10')
  })

  it('drops a facet nothing in the catalog satisfies', () => {
    mount(CATALOG, [])
    expect(ids('facet')).toEqual(['free', 'reasoning', 'tools'])

    cleanup()
    // A catalog that reports no flags at all leaves the row with no facets.
    mount(FLAT, [])
    expect(part('facet')).toEqual([])
  })

  it('each facet NARROWS, and none of them selects anything', () => {
    mount()
    fireEvent.click(byId('facet', 'free'))
    expect(byId('facet', 'free')).toHaveAttribute('aria-pressed', 'true')
    // Newest-first within the group: Mini (Apr) lands above 5 (Mar).
    expect(ids('row')).toEqual(['nvidia/nemotron-mini', 'nvidia/nemotron-5'])
    expect(sets).toEqual([])

    fireEvent.click(byId('facet', 'free'))
    fireEvent.click(byId('facet', 'reasoning'))
    expect(ids('row')).toHaveLength(6)

    fireEvent.click(byId('facet', 'reasoning'))
    fireEvent.click(byId('facet', 'tools'))
    expect(ids('row')).toHaveLength(10)

    fireEvent.click(byId('facet', 'tools'))
    fireEvent.click(byId('facet', 'selected'))
    expect(ids('row')).toEqual(['deepseek/v4-flash-0731', 'moonshotai/kimi-k3'])
    expect(sets).toEqual([])
  })

  it('AND-s a facet with the search text', () => {
    mount()
    fireEvent.click(byId('facet', 'reasoning'))
    search('deepseek')
    expect(ids('row')).toEqual(['deepseek/v4-flash-0731', 'deepseek/v4-pro', 'deepseek/v4-flash'])
  })

  it('reports no matches rather than an empty card', () => {
    mount()
    search('there-is-no-such-model')
    expect(screen.getByTestId('T.empty')).toHaveTextContent('No models match.')
  })
})

// ── Rows ─────────────────────────────────────────────────────────────

describe('rows', () => {
  it('shows the name, the tags, the mono id and the release month', () => {
    mount()
    const row = byId('row', 'deepseek/v4-flash-0731')
    expect(row).toHaveTextContent('DeepSeek V4 Flash 0731')
    expect(row).toHaveTextContent('deepseek/v4-flash-0731')
    // `2026-07-31` is read off the string, not through `Date` — a UTC parse
    // prints the previous month everywhere west of London.
    expect(row).toHaveTextContent('Jul 2026')
    expect(row).toHaveAttribute('aria-checked', 'true')
    expect(
      [...row.querySelectorAll('[data-testid="T.tag"]')].map((el) => el.getAttribute('data-id'))
    ).toEqual(['reasoning', 'tools'])

    expect(byId('row', 'moonshotai/kimi-k2')).toHaveAttribute('aria-checked', 'false')

    // A model the catalog dates nothing for carries no date node at all.
    search('o5')
    expect(byId('row', 'openai/o5').textContent).not.toMatch(/20\d\d/)
  })

  it('marks a free model in the picker’s own emerald', () => {
    mount(CATALOG, [])
    search('nemotron-5')
    const tag = byId('tag', 'free')
    expect(tag).toHaveTextContent('free')
    expect(tag.className).toContain('text-emerald-300')
  })

  it('puts the SELECTED rows first, then the sort order', () => {
    mount()
    search('deepseek')
    // Newest (the default): the selection, then releaseDate desc, undated last.
    expect(rowsOf('deepseek')).toEqual([
      'deepseek/v4-flash-0731',
      'deepseek/v4-pro',
      'deepseek/v4-flash',
      'deepseek/v3-lite',
      'deepseek/coder-2'
    ])

    fireEvent.click(byId('sort', 'name'))
    expect(rowsOf('deepseek')).toEqual([
      'deepseek/v4-flash-0731',
      'deepseek/coder-2',
      'deepseek/v3-lite',
      'deepseek/v4-flash',
      'deepseek/v4-pro'
    ])
  })

  it('previews three rows per open group, then shows the rest', () => {
    mount()
    expect(rowsOf('deepseek')).toHaveLength(ROW_PREVIEW)
    const more = byId('showMore', 'deepseek')
    expect(more).toHaveTextContent('Show 2 more')

    fireEvent.click(more)
    expect(rowsOf('deepseek')).toHaveLength(5)
    expect(ids('showMore')).not.toContain('deepseek')
  })

  it('toggles one model per row click, through the ONE writer', () => {
    mount()
    fireEvent.click(byId('row', 'deepseek/v4-pro'))
    expect(sets.at(-1)).toEqual([...SELECTED, 'deepseek/v4-pro'])

    fireEvent.click(byId('row', 'deepseek/v4-flash-0731'))
    expect(sets.at(-1)).toEqual(['moonshotai/kimi-k3', 'deepseek/v4-pro'])
  })
})

// ── Bulk ─────────────────────────────────────────────────────────────

describe('bulk actions', () => {
  it('reads a vendor as on / mixed / off', () => {
    mount()
    expect(byId('groupToggle', 'deepseek')).toHaveAttribute('data-state', 'mixed')
    expect(byId('groupToggle', 'deepseek')).toHaveAttribute('aria-checked', 'mixed')
    expect(byId('groupToggle', 'openai')).toHaveAttribute('data-state', 'off')
    expect(byId('groupToggle', 'openai')).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(byId('groupToggle', 'openai'))
    expect(byId('groupToggle', 'openai')).toHaveAttribute('data-state', 'on')
    expect(byId('groupToggle', 'openai')).toHaveAttribute('aria-checked', 'true')
  })

  it('a vendor checkbox fills and clears the whole group', () => {
    mount()
    fireEvent.click(byId('groupToggle', 'deepseek'))
    expect(sets.at(-1)).toEqual([
      ...SELECTED,
      'deepseek/v4-flash',
      'deepseek/v4-pro',
      'deepseek/v3-lite',
      'deepseek/coder-2'
    ])

    fireEvent.click(byId('groupToggle', 'deepseek'))
    expect(sets.at(-1)).toEqual(['moonshotai/kimi-k3'])
    expect(byId('groupToggle', 'deepseek')).toHaveAttribute('data-state', 'off')
  })

  it('a vendor checkbox acts on the SHOWN members only', () => {
    mount()
    search('v4-flash')
    // Two of deepseek's five match, and one of those is already selected.
    expect(byId('groupToggle', 'deepseek')).toHaveAttribute('data-state', 'mixed')
    fireEvent.click(byId('groupToggle', 'deepseek'))
    expect(sets.at(-1)).toEqual([...SELECTED, 'deepseek/v4-flash'])
  })

  it('Select all / Clear act on what the filters show, and disable when spent', () => {
    mount()
    expect(screen.getByTestId('T.selectAll')).toHaveTextContent('Select all 14')
    search('nemotron')
    expect(screen.getByTestId('T.selectAll')).toHaveTextContent('Select all 3')

    fireEvent.click(screen.getByTestId('T.selectAll'))
    expect(sets.at(-1)).toEqual([
      ...SELECTED,
      'nvidia/nemotron-5',
      'nvidia/nemotron-mini',
      'nvidia/nemotron-ultra'
    ])
    // Every shown model is now selected — there is nothing left to select.
    expect(screen.getByTestId('T.selectAll')).toBeDisabled()

    fireEvent.click(screen.getByTestId('T.clearShown'))
    // Only the shown three left; the two outside the search are untouched.
    expect(sets.at(-1)).toEqual(SELECTED)
    expect(screen.getByTestId('T.clearShown')).toBeDisabled()
    expect(screen.getByTestId('T.selectAll')).not.toBeDisabled()
  })

  it('Clear is dead while nothing shown is selected', () => {
    mount(CATALOG, [])
    expect(screen.getByTestId('T.clearShown')).toBeDisabled()
    expect(screen.getByTestId('T.selectAll')).not.toBeDisabled()
  })
})

// ── The write contract ───────────────────────────────────────────────

it('never writes on its own — mount, search, sort and expand are all reads', () => {
  const onSet = vi.fn()
  render(
    <ModelCurationList
      testid="T"
      models={CATALOG}
      selected={SELECTED}
      onSet={onSet}
      total={CATALOG.length}
      filter=""
      onFilterChange={vi.fn()}
      facets={[]}
      onFacetsChange={vi.fn()}
      sort="newest"
      onSortChange={vi.fn()}
    />
  )
  fireEvent.click(byId('group', 'openai'))
  fireEvent.click(byId('sort', 'name'))
  fireEvent.click(byId('showMore', 'deepseek'))
  expect(onSet).not.toHaveBeenCalled()
})
