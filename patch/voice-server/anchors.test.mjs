import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSuccessResponseHelper } from './anchors.mjs'

function fixtureChunks(...bodies) {
  let src = ''
  const chunks = []
  for (const [index, body] of bodies.entries()) {
    const spec = `/chunk-${index}.js`
    const start = src.length
    src += `// @bun-chunk ${spec}\n${body}\n`
    chunks.push({ spec, start, end: src.length })
  }
  const chunkAt = (offset) => chunks.find((chunk) => chunk.start <= offset && offset < chunk.end)
  return { src, chunks, chunkAt }
}

test('ignores an unrelated same-message-variable call in another chunk', () => {
  const { src, chunks, chunkAt } = fixtureChunks('io(I,{})', 'Xe(I,{})\nXe(I,{})')
  assert.deepEqual(resolveSuccessResponseHelper(src, 'I', chunks[1].spec, chunkAt), {
    name: 'Xe',
    callSites: 2
  })
})

test('rejects genuinely ambiguous helpers in the dispatch chunk', () => {
  const { src, chunks, chunkAt } = fixtureChunks('io(I,{})', 'Xe(I,{})\nQe(I,{})')
  assert.throws(
    () => resolveSuccessResponseHelper(src, 'I', chunks[1].spec, chunkAt),
    /multiple names in \/chunk-1\.js: Xe, Qe/
  )
})

test('rejects a dispatch chunk with no success helper', () => {
  const { src, chunks, chunkAt } = fixtureChunks('io(I,{})', 'Qe(I,"error")')
  assert.throws(
    () => resolveSuccessResponseHelper(src, 'I', chunks[1].spec, chunkAt),
    /Cannot find success response helper/
  )
})

test('escapes dollar signs in the minified message variable', () => {
  const { src, chunks, chunkAt } = fixtureChunks('io($I,{})', '$e($I,{})')
  assert.deepEqual(resolveSuccessResponseHelper(src, '$I', chunks[1].spec, chunkAt), {
    name: '$e',
    callSites: 1
  })
})
