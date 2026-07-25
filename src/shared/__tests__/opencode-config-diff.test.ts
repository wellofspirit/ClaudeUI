/**
 * Unit tests for the pure deep-diff → leaf-patch computation used by the
 * schema-driven opencode config editor.
 *
 * Guards the patch semantics: changed scalar, atomic array, added key, removed
 * key (delete patch), nested recursion, and untouched-sibling isolation.
 */

import { describe, it, expect } from 'vitest'
import { diffToPatches, deepEqual } from '../opencode-config-diff'

describe('diffToPatches', () => {
  it('emits no patches when nothing changed', () => {
    const doc = { a: 1, b: { c: 'x' }, arr: [1, 2] }
    expect(diffToPatches(doc, structuredClone(doc))).toEqual([])
  })

  it('changed scalar → single set patch at the leaf', () => {
    expect(diffToPatches({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual([{ path: ['b'], value: 3 }])
  })

  it('changed array is ATOMIC — one set with the whole new array', () => {
    const patches = diffToPatches({ input: ['text'] }, { input: ['text', 'image'] })
    expect(patches).toEqual([{ path: ['input'], value: ['text', 'image'] }])
  })

  it('reordered array is a change (element-wise identity is not attempted)', () => {
    const patches = diffToPatches({ x: [1, 2] }, { x: [2, 1] })
    expect(patches).toEqual([{ path: ['x'], value: [2, 1] }])
  })

  it('added key → set patch with the whole subtree', () => {
    const patches = diffToPatches({ a: 1 }, { a: 1, b: { c: 2 } })
    expect(patches).toEqual([{ path: ['b'], value: { c: 2 } }])
  })

  it('removed key → delete patch (no value field)', () => {
    const patches = diffToPatches({ a: 1, b: 2 }, { a: 1 })
    expect(patches).toEqual([{ path: ['b'] }])
    expect('value' in patches[0]).toBe(false)
  })

  it('key set to undefined is treated as a removal (delete patch)', () => {
    const patches = diffToPatches({ a: 1, b: 2 }, { a: 1, b: undefined })
    expect(patches).toEqual([{ path: ['b'] }])
  })

  it('recurses into nested objects, touching only the changed leaf', () => {
    const oldV = { provider: { ec2: { name: 'EC2', options: { baseURL: 'x' } } } }
    const newV = { provider: { ec2: { name: 'EC2', options: { baseURL: 'y' } } } }
    expect(diffToPatches(oldV, newV)).toEqual([
      { path: ['provider', 'ec2', 'options', 'baseURL'], value: 'y' }
    ])
  })

  it('leaves untouched siblings untouched (only the changed nested leaf patches)', () => {
    const oldV = { a: { keep: 1, change: 2 }, b: { untouched: 9 } }
    const newV = { a: { keep: 1, change: 3 }, b: { untouched: 9 } }
    expect(diffToPatches(oldV, newV)).toEqual([{ path: ['a', 'change'], value: 3 }])
  })

  it('object→primitive type change is an atomic leaf set', () => {
    expect(diffToPatches({ a: { nested: 1 } }, { a: 5 })).toEqual([{ path: ['a'], value: 5 }])
  })

  it('the concrete story: toggling attachment on a custom-provider model', () => {
    const oldV = { provider: { ec2: { models: { 'qwen3.6:27b': {} } } } }
    const newV = { provider: { ec2: { models: { 'qwen3.6:27b': { attachment: true } } } } }
    expect(diffToPatches(oldV, newV)).toEqual([
      { path: ['provider', 'ec2', 'models', 'qwen3.6:27b', 'attachment'], value: true }
    ])
  })
})

describe('deepEqual', () => {
  it('compares arrays element-wise and objects key-wise', () => {
    expect(deepEqual([1, { a: 2 }], [1, { a: 2 }])).toBe(true)
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
  })
})
