/**
 * opencode-config-diff.ts
 *
 * Pure (no fs / no ajv) deep-diff that turns an old→new opencode config object
 * into the minimal set of leaf patches the raw writer applies. Lives in `shared`
 * so BOTH the renderer (the schema-driven editor's Save button) and tests import
 * the same implementation; the main-process writer (opencode-native-raw.ts) only
 * APPLIES patches, it does not compute them.
 */

import type { RawConfigPatch } from './types'

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Structural equality. Arrays compared element-wise; objects key-wise. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    return ak.every((k) => k in b && deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * Compute the minimal set of leaf patches transforming `oldVal` into `newVal`.
 *
 * Semantics:
 *  - both plain objects → RECURSE over the union of keys.
 *      · key in old but gone from new (or set to undefined) → DELETE patch
 *      · key added (absent/undefined in old) → SET patch with the whole subtree
 *      · key kept in both → recurse
 *  - anything else (primitive, ARRAY, or object↔non-object type change) is an
 *    ATOMIC leaf: SET the whole new value when changed, DELETE when it became
 *    undefined. Arrays are never diffed element-wise — a changed array is
 *    replaced wholesale.
 *
 * Untouched siblings produce no patch.
 */
export function diffToPatches(
  oldVal: unknown,
  newVal: unknown,
  base: (string | number)[] = []
): RawConfigPatch[] {
  if (isPlainObject(oldVal) && isPlainObject(newVal)) {
    const patches: RawConfigPatch[] = []
    const keys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)])
    for (const key of keys) {
      const path = [...base, key]
      const hadOld = key in oldVal && oldVal[key] !== undefined
      const hasNew = key in newVal && newVal[key] !== undefined
      if (!hasNew) {
        if (hadOld) patches.push({ path }) // removed → delete
      } else if (!hadOld) {
        patches.push({ path, value: newVal[key] }) // added → set whole subtree
      } else {
        patches.push(...diffToPatches(oldVal[key], newVal[key], path))
      }
    }
    return patches
  }
  if (deepEqual(oldVal, newVal)) return []
  if (newVal === undefined) return [{ path: base }] // became undefined → delete
  return [{ path: base, value: newVal }] // atomic leaf set
}
