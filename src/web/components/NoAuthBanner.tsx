/**
 * The `off`-mode warning banner (security.md §Policy modes, hard requirement 2:
 * "a persistent, prominent warning banner on the desktop settings surface *and*
 * on every connected web client for as long as the mode is active").
 *
 * Deliberately NOT dismissible and deliberately not subtle. The mode means
 * anyone who can reach this address is already inside — the operator chose
 * that, and the on-screen cost of the choice is that it stays visible.
 *
 * Rendered off `auth-response.method === 'none'`, which is the server's own
 * report of what it checked (nothing). It disappears the moment the connection
 * drops, because the method describes a connection, not the machine.
 */
export function NoAuthBanner(): React.JSX.Element {
  return (
    <div
      data-testid="NoAuthBanner"
      role="alert"
      className="fixed top-0 inset-x-0 z-[9998] flex items-center gap-2 px-3 py-1.5 bg-danger/90 text-white text-[12px] font-medium"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        aria-hidden="true"
      >
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      <span className="leading-snug">
        Remote authentication is OFF. Anyone who can reach this address has full control of the
        desktop — turn it back on in Settings › Remote.
      </span>
    </div>
  )
}
