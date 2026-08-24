/**
 * `automation:*` — the scheduled-automation command surface, ONE declaration,
 * both transports.
 *
 * ## Why this file exists
 *
 * These ten channels were the last family still on raw `ipcMain.handle`
 * (`automation.ipc.ts`), which meant no declared capability, no capability
 * check, no audit row, and no way to reach them from a phone. The registry port
 * closes all four at once, and the headless ruling (2026-08-17 — everything
 * except host-PHYSICAL verbs is changeable from the remote UI) is why the remote
 * half lands with it rather than later.
 *
 * ## Capability: `config`, not `admin`
 *
 * `PINNED_CAPABILITIES` froze the seven MUTATING channels at `admin` ahead of
 * this port, deliberately as a fail-closed placeholder rather than a claim (see
 * the comment there). The ruling is `config`:
 *
 *  - an automation is HOST-SIDE CONFIGURATION — a stored prompt plus a cron
 *    expression, in `~/.claude/ui/automation/`, next to every other file the
 *    `config` capability already writes;
 *  - `admin` means EXACTLY the session-security area since ADR-056 (`authcfg:*`
 *    + `webauthn:*` + their host anchor `remote:*`). Leaving automations there
 *    would re-conflate "changes what this machine does" with "changes who may
 *    connect to this machine", which is the conflation ADR-056 undid;
 *  - the authority argument does not separate them either. An automation runs a
 *    prompt against the host on a timer — but `session:send` on the same
 *    connection runs a prompt against the host RIGHT NOW, and that is `chat`,
 *    in the base grant set. security.md §Posture states this plainly: any
 *    authenticated remote client is already operator-level in effect.
 *
 * What actually keeps automations honest is what keeps the rest of the surface
 * honest: every mutation is audited by the registry, every run is observable on
 * the event lane, and a `strong` step-up tier demands the mutation window before
 * any `command` here lands.
 *
 * ## The manager arrives late
 *
 * `AutomationManager` is constructed by `registerAutomationIpc()` during boot,
 * but the registration TABLE must not depend on that timing: a channel set that
 * differs between production and a test (or between a windowed and a headless
 * boot) is exactly what the parity pins exist to catch. So the registrations are
 * a module constant, and the manager is resolved per dispatch through
 * {@link setAutomationManager} — the same shape `services/host-window.ts` uses
 * for the window `remote-handlers.ts` cannot capture.
 *
 * Electron-free on purpose: `remote-handlers.ts` imports this module.
 */

import type { AutomationManager } from '../services/automation-manager'
import { isValidAutomationId } from '../services/automation-id'
import type { Automation } from '../../shared/types'
import type { CommandRegistration } from './command-registry'

let managerRef: AutomationManager | null = null

/**
 * Hand the running manager to the registrations. Called once, by
 * `registerAutomationIpc()`, right after it constructs the manager.
 */
export function setAutomationManager(manager: AutomationManager): void {
  managerRef = manager
}

/**
 * The live manager, or a throw.
 *
 * Reachable only if a host registered the channels without ever starting the
 * automation service — a refusal is the honest answer there, and it is one the
 * registry audits like any other failed command.
 */
function manager(): AutomationManager {
  if (!managerRef) throw new Error('Automations are not running on this host')
  return managerRef
}

/**
 * Reject a caller-supplied automation id at the IPC perimeter before it can
 * reach any path.join in the manager (audit M-AU3). Throwing rejects the
 * dispatch, so a hostile/compromised renderer — or a remote client — gets a
 * clean error instead of a traversal.
 */
function requireValidId(id: unknown): asserts id is string {
  if (!isValidAutomationId(id)) {
    throw new Error(`Invalid automation id: ${JSON.stringify(id)}`)
  }
}

/**
 * Every automation channel, transport-agnostic.
 *
 * The three READS are `query` (unaudited — a per-read row would bury the
 * mutations); the seven mutations are `command` and therefore audited. No
 * `sessionIdArg`: an automation id is not a session routing id, and declaring
 * one would put a foreign id in the audit row's `session_id` column.
 */
export const AUTOMATION_COMMANDS: ReadonlyArray<Omit<CommandRegistration, 'transport'>> = [
  {
    channel: 'automation:list',
    capability: 'config',
    kind: 'query',
    handler: () => manager().list()
  },
  {
    channel: 'automation:list-runs',
    capability: 'config',
    kind: 'query',
    handler: (automationId: string) => {
      requireValidId(automationId)
      return manager().listRuns(automationId)
    }
  },
  {
    channel: 'automation:load-run-history',
    capability: 'config',
    kind: 'query',
    handler: (automationId: string, runId: string) => {
      requireValidId(automationId)
      requireValidId(runId)
      return manager().loadRunMessages(automationId, runId)
    }
  },
  {
    channel: 'automation:save',
    capability: 'config',
    kind: 'command',
    handler: (automation: Automation) => {
      requireValidId(automation?.id)
      manager().upsert(automation)
    }
  },
  {
    channel: 'automation:delete',
    capability: 'config',
    kind: 'command',
    handler: (id: string) => {
      requireValidId(id)
      manager().delete(id)
    }
  },
  {
    channel: 'automation:toggle',
    capability: 'config',
    kind: 'command',
    handler: (id: string, enabled: boolean) => {
      requireValidId(id)
      manager().toggle(id, enabled)
    }
  },
  {
    channel: 'automation:run-now',
    capability: 'config',
    kind: 'command',
    handler: (id: string) => {
      requireValidId(id)
      // Fire-and-forget — don't await, runs stream results via events
      manager()
        .runNow(id)
        .catch(() => {})
    }
  },
  {
    channel: 'automation:cancel',
    capability: 'config',
    kind: 'command',
    handler: (id: string) => {
      requireValidId(id)
      manager().cancelRun(id)
    }
  },
  {
    channel: 'automation:send-message',
    capability: 'config',
    kind: 'command',
    handler: (id: string, prompt: string) => {
      requireValidId(id)
      manager().sendMessage(id, prompt)
    }
  },
  {
    channel: 'automation:dismiss-run',
    capability: 'config',
    kind: 'command',
    handler: (automationId: string, runId: string) => {
      requireValidId(automationId)
      requireValidId(runId)
      manager().dismissRun(automationId, runId)
    }
  }
]
