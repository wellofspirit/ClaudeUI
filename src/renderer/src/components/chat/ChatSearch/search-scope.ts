/**
 * Marker attributes the find-in-chat engine reads. Marking sites spread the
 * objects (`<div {...TOOL_OUTPUT_SCOPE}>`); the engine uses the selectors. Both
 * derive from the same name/value constants, so they cannot drift.
 */

const SCOPE_ATTR = 'data-search-scope'
const TOOL_OUTPUT = 'tool-output'
const ANCHOR_ATTR = 'data-search-anchor'

/**
 * Wraps content a tool RETURNED (its output), as opposed to its input or
 * header. Skipped by search when "Exclude tool output" is on.
 */
export const TOOL_OUTPUT_SCOPE = { [SCOPE_ATTR]: TOOL_OUTPUT } as const
export const TOOL_OUTPUT_SELECTOR = `[${SCOPE_ATTR}="${TOOL_OUTPUT}"]`

/**
 * One per transcript message, on the element whose box locates it in the
 * scroll container. The engine binary-searches these to find which message
 * sits at the top of the viewport without laying out every match.
 */
export const SEARCH_ANCHOR = { [ANCHOR_ATTR]: '' } as const
export const SEARCH_ANCHOR_SELECTOR = `[${ANCHOR_ATTR}]`
