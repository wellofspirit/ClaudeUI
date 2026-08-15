/**
 * "Your session ended" — the human-facing half of close 4010 (ADR-054).
 *
 * The strong tier gives a session an absolute max-age and cuts the socket at
 * it, sync stream included. That is not a rejection and not a failure: the
 * credential is fine, the SESSION is over, and the client reconnects at once
 * (no backoff) into whatever handshake the tier now demands — under a tier that
 * cuts sessions, a ceremony.
 *
 * Which is exactly why a notice is owed. Without it the operator watches the app
 * dissolve into the sign-in screen for no visible reason, and the natural read
 * of that is "something broke" or "my passkey stopped working". One sentence
 * turns an unexplained interruption into an expected one.
 *
 * A banner rather than a modal, and it never blocks: the reconnect is already
 * running underneath it and may need nothing from the user at all (a passkey
 * login arms everything at accept, so a single tap — or on some paths not even
 * that — is the whole cost). It is dismissed by the app when the connection
 * comes back.
 */
export function SessionExpiredNotice(): React.JSX.Element {
  return (
    <div
      data-testid="SessionExpiredNotice"
      role="status"
      className="fixed top-0 left-0 right-0 z-[9997] px-3 py-1.5 text-center text-[11px] leading-snug bg-accent/15 text-text-secondary border-b border-accent/30"
    >
      Session expired — sign in again. This server ends remote sessions after a set time.
    </div>
  )
}
