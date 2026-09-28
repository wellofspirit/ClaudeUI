/**
 * cli.js's own canonical text for a queued command.
 *
 * ## Why this exists
 *
 * A queued command's `prompt` is whatever went into cli.js's queue: the pushed
 * user frame's `message.content` — a plain STRING for a text-only prompt, but a
 * ContentBlockParam **ARRAY** when the prompt carried images or a PDF (see
 * `ClaudeSession.run`, which builds `[image…, {type:'text'}]` for attachments).
 * cli.js branches on exactly that everywhere it needs the text, and so must we.
 *
 * Today's reader is the transcript loader: a message folded into a running turn
 * is persisted as `{type:'attachment', attachment:{type:'queued_command',
 * prompt, …}}` with that `prompt` verbatim (docs/protocol-cc/
 * 03-inbound-messages.md §3.21), and `session-history.ts` renders it as the
 * user message it was.
 *
 * It was written for the retired `queue-control` patch, whose
 * `system/queued_command_consumed` carried the same verbatim `prompt` and was
 * matched by text against the queue (04-system-subtypes.md §4.10). Handing the
 * ARRAY to a `item.text === text` comparison never matched, so an image-carrying
 * steer was only noticed at the turn-end flush and its bubble landed below its
 * own answer. The queue is keyed by uuid now, but the prompt's shape is not.
 */

/** One content block as it appears inside a queued command's prompt. */
interface MaybeTextBlock {
  type?: unknown
  text?: unknown
}

/**
 * The text cli.js would consider this queued command to be — the exact rule of
 * its `rD` (2.1.280, `.cache/pristine-cli.js` @2680178), which its own
 * transcript view applies to a `queued_command` attachment's `prompt`:
 *
 *  - a string is itself;
 *  - an array yields its `text` blocks, in order, joined with `\n` (non-text
 *    blocks — images, documents — contribute nothing, which is why an
 *    attachments-only prompt is legitimately `''`);
 *  - anything else is `''`.
 */
export function queuedCommandText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return (prompt as MaybeTextBlock[])
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        block.type === 'text' &&
        typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('\n')
}
