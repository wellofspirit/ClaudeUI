/**
 * Browser-side rig for the gated passkeys walk
 * (`src/integration/passkeys/passkeys-browser-walk.integration.test.ts`).
 *
 * Everything here is about driving a REAL Microsoft Edge through REAL WebAuthn
 * ceremonies. There is no fake: the ceremony runs in the browser's own
 * `navigator.credentials` implementation, and the only thing swapped out is the
 * *authenticator hardware* — a CDP virtual authenticator standing in for
 * Windows Hello / a phone, which is the one piece a headless run cannot have.
 *
 * Why Edge rather than the bundled Chromium: it is the browser installed on the
 * developer machine (`channel: 'msedge'` needs no `playwright install`), and it
 * is Chromium, so the `WebAuthn` CDP domain is the same.
 *
 * Kept OUT of this module on purpose: anything that touches the app, the DB or
 * `tailscale serve`. The test file owns the instance and the serve entry; this
 * file owns the browser. That split is what lets the test's `finally` tear the
 * instance down even when a browser step throws.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Browser, BrowserContext, CDPSession, Locator, Page } from 'playwright'

/** Where the walk's evidence lands (gitignored). */
export const SHOT_DIR = path.resolve(process.cwd(), '.cache', 'screenshots')

/**
 * One virtual credential, in the shape CDP's `WebAuthn.getCredentials` returns
 * and `WebAuthn.addCredential` accepts. Only the fields both sides agree on are
 * declared — the payload is passed through verbatim, so a newer Edge adding
 * fields costs nothing.
 */
export interface VirtualCredential {
  credentialId: string
  isResidentCredential: boolean
  rpId?: string
  privateKey: string
  userHandle?: string
  signCount: number
  largeBlob?: string
  backupEligibility?: boolean
  backupState?: boolean
}

/** A page plus the CDP plumbing that makes its WebAuthn real-but-controllable. */
export interface WalkPage {
  context: BrowserContext
  page: Page
  cdp: CDPSession
  /** Present only when this page was opened WITH a virtual authenticator. */
  authenticatorId: string | null
  /** Console + pageerror lines, oldest first — the failure report's best friend. */
  logs: string[]
}

/**
 * Launch Edge. Headless by default; `CLAUDEUI_WALK_HEADED=1` shows the window,
 * which is how you watch the ceremony screens go by while debugging.
 */
export async function launchEdge(): Promise<Browser> {
  const { chromium } = await import('playwright')
  return await chromium.launch({
    channel: 'msedge',
    headless: process.env.CLAUDEUI_WALK_HEADED !== '1'
  })
}

/**
 * Attach a virtual authenticator to `cdp` and return its id.
 *
 * The option set is the "phone/laptop platform authenticator" profile the
 * design targets: an internal (platform) CTAP2 authenticator with discoverable
 * credentials and user verification, reporting UV as satisfied — i.e. the
 * biometric gate is simulated as *passed*, which is exactly the part a headless
 * machine cannot perform. `defaultBackupEligibility`/`defaultBackupState` make
 * the credential look SYNCED, so the `backedUp` flag the desktop list surfaces
 * is exercised rather than always false.
 *
 * Those last two are recent CDP additions; an older build rejects the whole
 * call, so a rejection retries once without them rather than failing the walk
 * for a cosmetic flag.
 */
export async function addVirtualAuthenticator(cdp: CDPSession): Promise<string> {
  const base = {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true
  }
  try {
    const res = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { ...base, defaultBackupEligibility: true, defaultBackupState: true }
    } as any)) as { authenticatorId: string }
    return res.authenticatorId
  } catch {
    const res = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: base
    } as any)) as { authenticatorId: string }
    return res.authenticatorId
  }
}

/**
 * Open a page, optionally with a virtual authenticator (and optionally seeded
 * with credentials exported from another one).
 *
 * `context` lets a caller reuse a browser context — a new TAB in the same
 * profile, which is what "same device, second visit" means. Omit it for a
 * genuinely separate device/profile (the break-glass leg needs one, because a
 * page that *could* do a ceremony would not exercise the fallback).
 *
 * The virtual authenticator is bound to the page's CDP target, not to the
 * profile, so credentials do NOT travel between pages by themselves — that is
 * what {@link exportCredentials} + `seed` are for.
 */
export async function openWalkPage(
  browser: Browser,
  opts?: {
    context?: BrowserContext
    virtualAuthenticator?: boolean
    seed?: VirtualCredential[]
  }
): Promise<WalkPage> {
  const context =
    opts?.context ?? (await browser.newContext({ viewport: { width: 1280, height: 900 } }))
  const page = await context.newPage()
  const logs: string[] = []
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`))

  const cdp = await context.newCDPSession(page)
  let authenticatorId: string | null = null
  if (opts?.virtualAuthenticator !== false) {
    await cdp.send('WebAuthn.enable', { enableUI: false })
    authenticatorId = await addVirtualAuthenticator(cdp)
    for (const credential of opts?.seed ?? []) {
      await cdp.send('WebAuthn.addCredential', {
        authenticatorId,
        credential
      } as any)
    }
  }
  return { context, page, cdp, authenticatorId, logs }
}

/** Every discoverable credential currently held by this page's authenticator. */
export async function exportCredentials(wp: WalkPage): Promise<VirtualCredential[]> {
  if (!wp.authenticatorId) return []
  const res = (await wp.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: wp.authenticatorId
  } as any)) as { credentials: VirtualCredential[] }
  return res.credentials
}

/**
 * Wait for a `data-testid` to be visible and return its locator.
 *
 * This — not the screenshot — is the assertion (ADR-027). The screenshots are
 * evidence for a human reading the report; a step that "passed" because a PNG
 * looked right would be no verification at all.
 */
export async function waitForTestId(
  page: Page,
  testId: string,
  timeoutMs = 45_000
): Promise<Locator> {
  const locator = page.locator(`[data-testid="${testId}"]`)
  await locator.first().waitFor({ state: 'visible', timeout: timeoutMs })
  return locator.first()
}

/** True if the testid is present and visible right now (no waiting). */
export async function hasTestId(page: Page, testId: string): Promise<boolean> {
  return (
    (await page
      .locator(`[data-testid="${testId}"]`)
      .first()
      .isVisible()
      .catch(() => false)) === true
  )
}

/** Screenshot into {@link SHOT_DIR} as `walk-<name>.png`; returns the path. */
export async function shot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `walk-${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  return file
}

/**
 * Everything worth knowing about a page that did NOT reach the state it was
 * asked for: the URL, every `data-testid` currently in the DOM, the visible
 * text, and the console/pageerror tail.
 *
 * A walk over a real browser fails for reasons the assertion message cannot
 * name — a chunk that 404s, a hook that throws into the error boundary, a
 * socket that authenticated and then never synced all look identical from
 * "locator timed out". This is what turns one of those into a diagnosis
 * without a second ten-minute run.
 */
export async function dumpSurface(wp: WalkPage, name: string): Promise<string> {
  const shotPath = await shot(wp.page, `FAIL-${name}`).catch(() => '(screenshot failed)')
  const testIds = await wp.page
    .$$eval('[data-testid]', (els) => els.map((e) => e.getAttribute('data-testid') ?? ''))
    .catch(() => [] as string[])
  const text = await wp.page.evaluate(() => document.body?.innerText ?? '').catch(() => '(no body)')
  const report = [
    `url=${wp.page.url()}`,
    `testids=${JSON.stringify([...new Set(testIds)].slice(0, 40))}`,
    `text=${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 400))}`,
    `shot=${shotPath}`,
    `logs=${JSON.stringify(wp.logs.slice(-30))}`
  ].join('\n      ')
  console.log(`    ▸ SURFACE DUMP (${name}):\n      ${report}`)
  return report
}

/**
 * {@link waitForTestId} that dumps the page before it rethrows. Use for the
 * waits whose failure would otherwise be unexplainable.
 */
export async function waitForSurface(
  wp: WalkPage,
  testId: string,
  opts?: { timeoutMs?: number; label?: string }
): Promise<Locator> {
  try {
    return await waitForTestId(wp.page, testId, opts?.timeoutMs ?? 45_000)
  } catch (err) {
    await dumpSurface(wp, opts?.label ?? testId)
    throw err
  }
}

/** Close a walk page's context (and its CDP session with it). */
export async function closeWalkPage(wp: WalkPage | null | undefined): Promise<void> {
  if (!wp) return
  await wp.context.close().catch(() => {})
}
