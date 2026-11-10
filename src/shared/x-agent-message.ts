/**
 * The words of messaging between a session and its X-Agents (ADR-105 §4), once, for the
 * engines' registrations and the dispatcher: the X-Agent's `session_message` description, how a
 * message reads to the X-Agent it reaches, what the X-Agent's card shows of it, and the
 * refusals. Pure strings, no imports.
 */

/** The name of the one session tool an X-Agent has; it is the same tool a root session has. */
export const X_AGENT_MESSAGE_TOOL = 'session_message'

/**
 * `session_message` as an X-Agent sees it: the session that dispatched it is the only one it can
 * reach, and its report goes through `hand_back`, not through this.
 */
export const X_AGENT_SESSION_MESSAGE_DESCRIPTION =
  'Send a message to the session that dispatched you (pass session "origin"): a question you need ' +
  'answered, or something it should know before your report. It reaches that session as a message ' +
  'from you, labelled as coming from an agent and not from the user, and it may start a turn ' +
  'there. You can message that session and no other. Your final report is not a message: deliver ' +
  'it with hand_back. The result says delivered (it started a turn), queued (it is busy and takes ' +
  'the message into its current turn), held (it will see it at its next turn) or refused.'

/** The `session` input of the X-Agent's tool. */
export const X_AGENT_SESSION_PARAM = 'Always "origin": the session that dispatched you'

/** A title on one line, safe inside the frame (no quotes, bounded). */
function frameTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 80)
  return flat || 'Untitled session'
}

/**
 * A message from a session to the X-Agent it dispatched, as the X-Agent reads it. The dispatcher is
 * the X-Agent's user (ADR-105 §4), and the frame says which session it is, so the text is not read
 * as the words of some other agent (the same provenance a Claude target's delegation preamble gives).
 */
export function xAgentMessageFrame(fromTitle: string, text: string): string {
  return (
    `Message from "${frameTitle(fromTitle)}", the session that dispatched you, acting for the ` +
    `user:\n\n${text}`
  )
}

/**
 * The input of a run a message STARTS (the X-Agent had finished: its harness session is resumed as
 * run n+1), or of the run that sends again messages a finished run never answered. The X-Agent
 * still carries the answer to its earlier `hand_back` ("stop here"), which would read as a refusal
 * of any later work, so the prompt says plainly that this is a new run and asks for a new report.
 * `framed` is one or more {@link xAgentMessageFrame} texts.
 */
export function xAgentNewRunPrompt(framed: string): string {
  return (
    'This is a NEW run: your earlier hand_back belonged to the previous run and does not apply to ' +
    'this one. Answer the message below, then report back with hand_back again.\n\n' +
    framed
  )
}

/** The title of the row the X-Agent's card shows for an incoming message. */
export function xAgentInputNoteTitle(fromTitle: string): string {
  return `Message from ${frameTitle(fromTitle)}`
}

/** The label under that row: what it is, not whose it is. */
export const X_AGENT_INPUT_FRAGMENT_LABEL = 'from the session that dispatched this agent'

/**
 * What the parent hears when a message it sent an X-Agent that was finishing its run could not be
 * sent again as a new run (the X-Agent was busy past the limits, the cost cap was reached, its
 * harness session cannot be resumed): the parent is the only one who can resend it.
 */
export function messageNotTakenText(name: string, reason: string): string {
  const why = reason.replace(/\s+/g, ' ').trim().slice(0, 300)
  return (
    `X-Agent ${name} did not answer a message you sent it while it was finishing its run, and ` +
    `could not take it up again: ${why} Send it again when that is resolved.`
  )
}

/** The refusal of a message from an X-Agent whose run is over (its report was taken, it was stopped). */
export const MESSAGE_RUN_ENDED_TEXT =
  'Refused: your run has ended, so no message was sent. Anything left to say belongs in your hand_back report.'

/**
 * The X-Agent a `session_message` call reached, read from the call's own result ("delivered to
 * X-Agent <name> (it is running …" / "(it was not running …"), for the card to show who the
 * message went to. Null for a result that is not a delivery to an X-Agent (a refusal, a session).
 */
export function xAgentOfMessageResult(resultText: string): string | null {
  const m = /^delivered to X-Agent (.+?) \((?:it is running|it was not running)/.exec(resultText)
  return m ? m[1] : null
}
