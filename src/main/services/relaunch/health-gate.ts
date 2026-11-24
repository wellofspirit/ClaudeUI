/**
 * When is a packaged boot "healthy" enough to write its health record (design
 * review rulings 3 and 4)? Core services started (the caller only gets here
 * after `bootCore`), the first window loaded (windowless: nothing to wait for),
 * and the boot's remote start attempt SETTLED: listening, or refused. A start
 * that failed (a port in use) still counts as healthy, with a warning: rolling
 * back cannot make an unbindable port reachable, and the old build would meet
 * the same refusal. The wait is bounded at 45 s.
 */

import { logger } from '../../../core/services/logger'
import type { RemoteStartOutcome } from '../../../core/boot/core-services'

export interface HealthGateArgs {
  /** Resolves when the first window finished loading (already resolved when windowless). */
  windowLoaded: Promise<void>
  /** How the boot's remote start attempt ended (`CoreServices.remoteStartSettled`). */
  remoteStart: Promise<RemoteStartOutcome>
  boundMs?: number
}

export const REMOTE_START_BOUND_MS = 45_000

export type HealthGateOutcome = RemoteStartOutcome | 'timed-out'

export async function whenHealthy(args: HealthGateArgs): Promise<HealthGateOutcome> {
  await args.windowLoaded
  const bound = args.boundMs ?? REMOTE_START_BOUND_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), bound)
  })
  const outcome = await Promise.race([
    args.remoteStart.catch((): RemoteStartOutcome => 'failed'),
    timedOut
  ])
  clearTimeout(timer)
  if (outcome === 'failed')
    logger.warn(
      'relaunch',
      'the remote server failed to start; recording health anyway (a rollback cannot make the port reachable)'
    )
  else if (outcome === 'timed-out')
    logger.warn(
      'relaunch',
      `the remote server start did not settle within ${Math.round(bound / 1000)} s; recording health without it`
    )
  return outcome
}
