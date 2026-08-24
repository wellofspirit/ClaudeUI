/**
 * The first-boot console chain (S3 stage 2; security.md §"Headless bootstrap
 * chain").
 *
 * ## The problem it solves
 *
 * ADR-056 made admission credential-based: a link is a CHANNEL, and identity is
 * a passkey or the break-glass password. On the desktop the first credential is
 * enrolled from the host anchor — you press a button in Settings and scan a QR.
 * A headless box has no Settings pane and no one looking at it, so with zero
 * credentials AND no password provisioned, **nothing can connect at all**. That
 * is the correct security posture and a useless deployment.
 *
 * The console closes the loop. It is the headless host anchor, so it is allowed
 * to do the one thing no remote client may: mint an enrollment link out of thin
 * air. The link is printed to stdout, where only someone who can already read
 * this process's output can see it — which is the same trust boundary the
 * desktop's Settings pane has.
 *
 * ## The RP ID constraint (why the link is HTTPS or nothing)
 *
 * A WebAuthn credential binds to the RP ID of the origin that created it, so the
 * enrollment link MUST point at the tailnet HTTPS name. A link at a LAN IP would
 * produce either a failed ceremony or — worse — a credential bound to a name
 * that will not exist tomorrow. `RemoteServer.mintEnrollToken()` enforces this
 * by refusing to mint without an active `tailscale serve`, and this module
 * reports that refusal as actionable guidance rather than swallowing it.
 *
 * ## Idempotence
 *
 * The chain re-prints on EVERY start until a credential exists. A one-time print
 * that scrolled off the screen, or landed in a log the operator was not tailing,
 * is a bricked deployment; re-printing costs nothing because the state that
 * gates it (zero credentials) is exactly the state in which the link is useless
 * to an attacker who cannot already read the console.
 *
 * Kept free of side effects other than the injected `print`, so the branch table
 * can be unit-tested without a server.
 */

/** The subset of `sanitizedRemoteConfig()` the chain reads. */
export interface BootstrapConfigView {
  credentialCount: number
  passwordSet: boolean
  effectiveAuthPolicy: string
}

/** The subset of `RemoteServer` the chain reads. */
export interface BootstrapServerView {
  /** Mint a one-time enrollment link. Throws when there is no HTTPS origin. */
  mintEnrollToken(): { token: string; expiresAt: number; url: string }
  /** The LAN link (with its channel-key fragment), or null in TLS/stopped state. */
  lanLink(): string | null
}

export interface BootstrapChainInput {
  config: BootstrapConfigView
  server: BootstrapServerView
  /** Where lines go. Injected so tests observe rather than capture stdout. */
  print: (line: string) => void
}

/**
 * Print the access banner for this start.
 *
 * Returns a small summary so `main.ts` (and the `show-link` subcommand) can
 * report an exit-worthy failure without re-deriving the branch.
 */
export function runFirstBootChain({ config, server, print }: BootstrapChainInput): {
  enrolled: boolean
  enrollUrl: string | null
  lanUrl: string | null
} {
  const enrolled = config.credentialCount > 0
  const lanUrl = server.lanLink()

  print('')
  print('  ClaudeUI server')
  print('  ───────────────')

  if (config.effectiveAuthPolicy === 'off') {
    // The `off` banner comes FIRST and is unmissable. Everything below it is
    // about how to authenticate, and none of it applies.
    print('')
    print('  !!  REMOTE AUTHENTICATION IS DISABLED (policy "off").')
    print('  !!  Every client that can reach this port has operator-level access')
    print('  !!  to this machine. Re-enable it from Settings.')
    if (lanUrl) {
      print('')
      print(`  URL:  ${lanUrl}`)
    }
    print('')
    return { enrolled, enrollUrl: null, lanUrl }
  }

  let enrollUrl: string | null = null

  // The bootstrap case: no passkey AND no break-glass password means nothing on
  // earth can currently connect, so mint the one credential-granting link the
  // console is allowed to mint.
  if (!enrolled && !config.passwordSet) {
    try {
      const minted = server.mintEnrollToken()
      enrollUrl = minted.url
      const minutes = Math.max(1, Math.round((minted.expiresAt - Date.now()) / 60_000))
      print('')
      print('  No passkey is enrolled and no password is set, so nothing can')
      print('  connect yet. Open this ONE-TIME link on the device you want to')
      print(`  enroll (expires in ~${minutes} min):`)
      print('')
      print(`    ${minted.url}`)
      print('')
      print('  It grants enrollment and nothing else — it cannot read a')
      print('  conversation until a passkey has been registered on it.')
    } catch (err) {
      // Almost always "no HTTPS origin". Say what to do, not what threw.
      print('')
      print('  No passkey is enrolled and no password is set, so nothing can')
      print('  connect yet — and an enrollment link cannot be minted:')
      print('')
      print(`    ${err instanceof Error ? err.message : String(err)}`)
      print('')
      print('  A passkey binds to the origin that created it, so enrollment')
      print('  needs a stable HTTPS name. Start with --tls (Tailscale HTTPS)')
      print('  and try again.')
    }
  } else if (!enrolled) {
    print('')
    print('  No passkey is enrolled yet; sign in with the break-glass password,')
    print('  then enroll a passkey from Settings.')
  }

  if (lanUrl) {
    print('')
    print(`  LAN:  ${lanUrl}`)
    if (lanUrl.includes('#k=')) {
      print('        (the #k= fragment is this LAN channel key — it is not a')
      print('         password, and it never leaves the browser)')
    }
  }

  print('')
  return { enrolled, enrollUrl, lanUrl }
}
