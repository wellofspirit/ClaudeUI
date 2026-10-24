/**
 * Thrown by a session's `resolveApproval` when the ANSWER was malformed but the
 * request is still parked and answerable (e.g. a Codex question answer that is
 * missing or not an offered choice). The approval answer seam
 * (`src/core/ipc/approval-response.ts`) dismisses the card on every other
 * outcome, including a stale-id throw, but must keep the card for this one: the
 * engine is still waiting, and the user can answer again.
 */
export class ApprovalAnswerRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalAnswerRejected'
  }
}
