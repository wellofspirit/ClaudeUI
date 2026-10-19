/**
 * What the UI says for a Claude subagent that ended through `SubagentHandback`
 * without delivering a report (`handback: 'withheld'`). cli.js's own text for it
 * is written for the parent MODEL ("Send the agent a message (SendMessage) to ask
 * it to deliver its report"), so ClaudeUI substitutes this one — the same words
 * on the card, in the panel and in the agent note.
 */
export const HANDBACK_WITHHELD_TEXT = 'The subagent ended without delivering a report.'

/**
 * The same sentence for an X-Agent (a cross-engine dispatch, ADR-105 §3): its card says
 * "X-Agent" where a Claude subagent's says "subagent".
 */
export const XAGENT_HANDBACK_WITHHELD_TEXT = 'The X-Agent ended without delivering a report.'
