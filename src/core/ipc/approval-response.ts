import type { ApprovalDecision, PermissionSuggestion } from '../../shared/types'
import { ApprovalAnswerRejected } from '../services/approval-errors'
import { crossEngineDispatcher, XENG_REQUEST_PREFIX } from '../services/cross-engine-dispatcher'
import type { SessionManager } from '../services/session-manager'
import { emitEvent } from '../services/sync-host'

/**
 * `session:approval-response` — the one place a client's answer to a pending
 * approval card is routed (desktop and remote handlers both call it).
 *
 * A reserved `xeng:` id is a forwarded cross-engine dispatch approval (ADR-033);
 * anything else goes to the session. Then `session:approval-dismiss` is emitted
 * for the card on `routingId`, in a `finally`: pending approvals are replicated
 * canonical state (ADR-038), and the answering client only removes its OWN copy
 * locally, so without this seam every other client keeps a card nobody can
 * answer. Engines emit their own dismiss for internal resolutions (abort, turn
 * end) and some also on a human answer; the reducer's removal is idempotent, so
 * the duplicate is harmless and the engines' emits stay. A resolve that throws
 * (Codex's "Stale or unknown approval") still retires the card everywhere, and
 * the error still reaches the caller. The one exception is `ApprovalAnswerRejected`
 * (a malformed answer to a still-parked request): the card stays.
 */
export function answerApproval(
  manager: SessionManager,
  routingId: string,
  requestId: string,
  decision: ApprovalDecision,
  answers?: Record<string, string>,
  updatedPermissions?: PermissionSuggestion[]
): void {
  let dismiss = true
  try {
    if (
      requestId.startsWith(XENG_REQUEST_PREFIX) &&
      crossEngineDispatcher.resolveApproval(requestId, decision, answers, updatedPermissions)
    ) {
      return
    }
    manager.get(routingId)?.resolveApproval(requestId, decision, answers, updatedPermissions)
  } catch (err) {
    // A malformed answer leaves the request parked and answerable: keep the card.
    if (err instanceof ApprovalAnswerRejected) dismiss = false
    throw err
  } finally {
    if (dismiss) emitEvent('session:approval-dismiss', [routingId, { requestId }])
  }
}
