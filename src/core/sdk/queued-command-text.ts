/**
 * cli.js's own canonical text for a queued command.
 *
 * ## Why this exists
 *
 * `system/queued_command_consumed` (patch `queue-control`,
 * docs/protocol-cc/04-system-subtypes.md §4.10) carries the attachment's `prompt`
 * **verbatim**:
 *
 * ```js
 * else if(nt.attachment.type==="queued_command"){ let wr=nt.attachment;
 *   yield{type:"system",subtype:"queued_command_consumed",prompt:wr.prompt, ...} }
 * ```
 *
 * And `attachment.prompt` is whatever went into the queue, which is the pushed
 * message's `message.content` — a plain STRING for a text-only prompt, but a
 * ContentBlockParam **ARRAY** when the prompt carried images or a PDF (see
 * `ClaudeSession.run`, which builds `[image…, {type:'text'}]` for attachments).
 * cli.js branches on exactly that everywhere it needs the text.
 *
 * The consequence, before this helper: `onPromptDelivered(msg.prompt)` handed an
 * ARRAY to `SessionQueue.consumeByText`, whose comparison is `item.text === text`
 * — never true. So an attachment-carrying queued message was never detected as
 * consumed when cli.js actually injected it mid-turn; it stayed `queued` until
 * the turn's `result` flush (`flushQueueAtTurnEnd`) swept it, and the transcript
 * synthesized its user bubble at the END of the whole turn — visibly after the
 * answer the model had already given to it. Text-only queued messages were
 * unaffected, which is why the bug looked attachment-specific.
 *
 * The asymmetry that made it survive review: the RECALL half already normalizes.
 * `dequeue_message` matches with cli.js's own extractor —
 * `VV_(v)= typeof v==="string" ? v : Lu(v,"\n")`, and
 * `Lu(e,t)= e.filter(r=>r.type==="text").map(r=>r.text).join(t)` — so taking a
 * queued image message BACK worked fine while noticing it had been consumed did
 * not.
 *
 * {@link queuedCommandText} is that same rule, client-side. Deliberately NOT a
 * new cli.js patch: the wire already carries everything needed, and every
 * consumer in cli.js normalizes at the read site rather than at the emit site.
 */

/** One content block as it appears inside a queued command's prompt. */
interface MaybeTextBlock {
  type?: unknown
  text?: unknown
}

/**
 * The text cli.js would consider this queued command to be — the exact rule
 * `ZPe` / `VV_` + `Lu` implement in the bundle:
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
