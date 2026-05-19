/**
 * Layer 1: Unit tests for the chat-search engine.
 *
 * Tests pure logic: given a DOM and a query, do we get the right ranges?
 * The CSS Custom Highlight API is not available in jsdom; tests verify the
 * pure-data side (findMatches, indices, wrap-around). The highlight side
 * effect is feature-detected at runtime and is a no-op under jsdom.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createChatSearchEngine } from '../chat-search'

function makeFixture(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('createChatSearchEngine', () => {
  it('returns zero matches for a query shorter than 2 chars', () => {
    const root = makeFixture('<p>hello world</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('h', false)
    expect(engine.getState()).toEqual({ total: 0, index: 0 })
    engine.dispose()
  })

  it('returns zero matches for an empty query', () => {
    const root = makeFixture('<p>hello world</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('', false)
    expect(engine.getState()).toEqual({ total: 0, index: 0 })
    engine.dispose()
  })

  it('finds case-insensitive substring matches across multiple nodes', () => {
    const root = makeFixture('<p>Hello world</p><p>Other hello here</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('hello', false)
    expect(engine.getState().total).toBe(2)
    engine.dispose()
  })

  it('respects case-sensitive flag', () => {
    const root = makeFixture('<p>Hello world</p><p>hello again</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('hello', true)
    expect(engine.getState().total).toBe(1)
    engine.setQuery('hello', false)
    expect(engine.getState().total).toBe(2)
    engine.dispose()
  })

  it('finds multiple matches within a single text node', () => {
    const root = makeFixture('<p>foo foo foofoo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', false)
    expect(engine.getState().total).toBe(4)
    engine.dispose()
  })

  it('excludes subtrees with data-search="skip"', () => {
    const root = makeFixture(
      '<p>foo</p><div data-search="skip"><p>foo</p><p>foo</p></div><p>foo</p>'
    )
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', false)
    expect(engine.getState().total).toBe(2)
    engine.dispose()
  })

  it('next() advances and wraps around', () => {
    const root = makeFixture('<p>foo</p><p>foo</p><p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', false)
    expect(engine.getState().index).toBe(1)
    engine.next()
    expect(engine.getState().index).toBe(2)
    engine.next()
    expect(engine.getState().index).toBe(3)
    engine.next()
    expect(engine.getState().index).toBe(1) // wraps
    engine.dispose()
  })

  it('prev() retreats and wraps around', () => {
    const root = makeFixture('<p>foo</p><p>foo</p><p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', false)
    expect(engine.getState().index).toBe(1)
    engine.prev()
    expect(engine.getState().index).toBe(3) // wraps
    engine.prev()
    expect(engine.getState().index).toBe(2)
    engine.dispose()
  })

  it('subscribe() notifies on query change', () => {
    const root = makeFixture('<p>foo bar foo</p>')
    const engine = createChatSearchEngine(root)
    const states: Array<{ total: number; index: number }> = []
    const unsub = engine.subscribe((s) => states.push(s))
    engine.setQuery('foo', false)
    expect(states.length).toBeGreaterThan(0)
    expect(states[states.length - 1].total).toBe(2)
    unsub()
    engine.dispose()
  })

  it('changing the query updates total', () => {
    const root = makeFixture('<p>foo bar baz</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', false)
    expect(engine.getState().total).toBe(1)
    engine.setQuery('bar', false)
    expect(engine.getState().total).toBe(1)
    engine.setQuery('xx', false)
    expect(engine.getState().total).toBe(0)
    engine.dispose()
  })

  it('dispose() makes further calls a no-op', () => {
    const root = makeFixture('<p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', false)
    engine.dispose()
    engine.setQuery('foo', false) // should not throw
    expect(engine.getState()).toEqual({ total: 0, index: 0 })
  })
})
