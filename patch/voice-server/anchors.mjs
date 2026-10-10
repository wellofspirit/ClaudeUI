const V = '[\\w$]+'

/**
 * Resolve the success-response helper used by a control-request dispatch chunk.
 * Identical-looking calls in other concatenated ESM chunks are unrelated.
 *
 * @param {string} src concatenated cli.js source
 * @param {string} msgVar control-request message variable
 * @param {string} anchorChunkSpec chunk containing the dispatch fallback
 * @param {(offset: number) => {spec: string} | null} chunkAt maps a source offset to its chunk
 * @returns {{name: string, callSites: number}}
 */
export function resolveSuccessResponseHelper(src, msgVar, anchorChunkSpec, chunkAt) {
  const escMsg = msgVar.replace(/\$/g, '\\$')
  const successRe = new RegExp(`(${V})\\(${escMsg},\\{\\}\\)`, 'g')
  const successMatches = [...src.matchAll(successRe)].filter(
    (match) => chunkAt(match.index)?.spec === anchorChunkSpec
  )
  if (successMatches.length === 0) {
    throw new Error('Cannot find success response helper in the control-request chunk')
  }

  const successNames = new Set(successMatches.map((match) => match[1]))
  if (successNames.size > 1) {
    throw new Error(
      `Success response helper pattern resolved to multiple names in ${anchorChunkSpec}: ${[...successNames].join(', ')}`
    )
  }

  return { name: successMatches[0][1], callSites: successMatches.length }
}
