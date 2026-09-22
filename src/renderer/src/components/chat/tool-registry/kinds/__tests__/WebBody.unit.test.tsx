/**
 * Layer 1 (unit) for `WebBody` — props in, DOM out, no store and no IPC.
 *
 * The load-bearing rule is the LINK GUARD: a result url is untrusted text that
 * reached us through a search backend and a model, so only `http://` and
 * `https://` ever become an anchor.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WebBody, isSafeResultUrl, resultLocation } from '../WebBody'
import type { KindBodyProps } from '../types'
import type { ContentBlock } from '../../../../../../../shared/types'
import type { ToolView } from '../../../../../../../shared/tool-kinds'

type WebView = Extract<ToolView, { kind: 'web' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

function renderBody(view: WebView, result?: ToolResultBlock): void {
  render(
    <WebBody
      {...({
        view,
        block: { type: 'tool_use', toolUseId: 'tu', toolName: 'webSearch', toolInput: {} },
        result,
        expanded: true,
        hideToolInput: false,
        isError: false
      } as unknown as KindBodyProps)}
    />
  )
}

describe('WebBody', () => {
  it('names the action and shows the target', () => {
    renderBody({ kind: 'web', target: 'electron 38', action: 'search' })
    expect(screen.getByTestId('WebBody.target').textContent).toBe('electron 38')
    expect(screen.getByTestId('WebBody').textContent).toContain('Searched')
  })

  it.each([
    ['fetch', 'Fetched'],
    ['find', 'Found in page'],
    ['other', 'Web'],
    [undefined, 'Web']
  ])('labels the %s action as %s', (action, label) => {
    renderBody({ kind: 'web', target: 'x', ...(action ? { action } : {}) } as WebView)
    expect(screen.getByTestId('WebBody').textContent).toContain(label)
  })

  it('renders one row per result, with the title, the location and the snippet', () => {
    renderBody({
      kind: 'web',
      target: 'electron 38',
      action: 'search',
      results: [
        {
          title: 'Electron 38.0.0',
          url: 'https://electronjs.org/blog/electron-38-0',
          snippet: 'Chromium 140, V8 14.0'
        },
        { title: 'Breaking changes', url: 'https://electronjs.org/docs' }
      ]
    })
    const rows = screen.getAllByTestId('WebBody.result')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Electron 38.0.0')
    expect(rows[0].textContent).toContain('electronjs.org › blog › electron-38-0')
    expect(rows[0].textContent).toContain('Chromium 140, V8 14.0')
    expect(screen.getByTestId('WebBody').parentElement?.textContent).toContain('2 results')
  })

  it('links an https result and does NOT link a javascript: one', () => {
    renderBody({
      kind: 'web',
      target: 'q',
      action: 'search',
      results: [
        { title: 'Safe', url: 'https://safe.test' },
        { title: 'Hostile', url: 'javascript:alert(1)' },
        { title: 'Data', url: 'data:text/html,<script>' },
        { title: 'File', url: 'file:///etc/passwd' }
      ]
    })
    const links = screen.getAllByTestId('WebBody.resultLink')
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://safe.test')
    // The hostile ones are still shown, just as text.
    expect(screen.getAllByTestId('WebBody.result')[1].textContent).toContain('Hostile')
  })

  it('renders NO result block when the result text is empty', () => {
    // The mapper leaves a resultless `webSearch` with an EMPTY result precisely
    // so the query is not repeated under the action line that already shows it.
    renderBody(
      { kind: 'web', target: 'electron 38', action: 'search' },
      {
        type: 'tool_result',
        toolUseId: 'tu',
        toolResult: ''
      }
    )
    // The query appears exactly once — as the target, not again as a "Result".
    expect(screen.getAllByText('electron 38')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('Result')
  })

  it('falls back to the result text only when there are no structured rows', () => {
    renderBody(
      { kind: 'web', target: 'q', action: 'search' },
      {
        type: 'tool_result',
        toolUseId: 'tu',
        toolResult: 'raw search output'
      }
    )
    expect(screen.getByText('raw search output')).toBeTruthy()
    render(<div />)
  })
})

describe('isSafeResultUrl / resultLocation', () => {
  it.each([
    ['https://a.test', true],
    ['http://a.test', true],
    ['javascript:alert(1)', false],
    ['JavaScript:alert(1)', false],
    ['data:text/html,x', false],
    ['file:///etc/passwd', false],
    ['//a.test', false],
    ['', false]
  ])('isSafeResultUrl(%s) is %s', (url, safe) => {
    expect(isSafeResultUrl(url)).toBe(safe)
  })

  it('reads a url as host then path segments, and leaves an unsafe one alone', () => {
    expect(resultLocation('https://electronjs.org/docs/latest/api')).toBe(
      'electronjs.org › docs › latest › api'
    )
    expect(resultLocation('javascript:alert(1)')).toBe('javascript:alert(1)')
  })
})
