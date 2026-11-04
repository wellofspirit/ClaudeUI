/**
 * opencode 2.x contract: which credential route BOOTS a location (ruling 2, S-OC, 2.2.5).
 *
 * The S7 design (ADR-097 §5) assumed no credential route activates a location, so a
 * proven-copy cleanup that only uses `/api/credential` runs ahead of any OAuth resolution.
 * On 2.2.5 that holds for `list`, `remove`, `activate` and relabel — and FAILS for `create`:
 * `POST /api/credential` runs `requireConnectable` against the GLOBAL-CONFIG Location's
 * services (`packages/server/src/handlers/credential.ts`), which loads the user's plugins;
 * the ChatGPT plugin then resolves (and may refresh) the active connection.
 *
 * The observable: a probe plugin declared in the isolated home's global config appends a line
 * to a log from its `setup`. A line therefore means the global-config location was built.
 * `OpencodeCredentialStore` fails a create closed until the cleanup has succeeded
 * (`credential-store.ts` `createGuard`); this file pins the engine fact that makes that
 * necessary, and the unit suite pins the guard.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { describeV2, fixtureConfig, installPlugin, useRig, type TestHome } from './harness/host'

const probeLog = (home: TestHome) => join(home.root, 'credential-location-probe.log')
const probeLines = (home: TestHome): string[] =>
  existsSync(probeLog(home)) ? readFileSync(probeLog(home), 'utf8').split('\n').filter(Boolean) : []

/** The user's GLOBAL config document (what the global-config Location reads). */
const globalConfigFile = (home: TestHome) =>
  join(home.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')

describeV2('opencode 2.x contract: a credential route that boots a location', () => {
  const rig = useRig('credential-location', {
    // Called just before every server start, so the global config is in place in time. The probe
    // plugin is loaded ONLY by the global-config location: the injected content carries ClaudeUI's
    // plugins, this file carries the user's.
    config: (fixture, home) => {
      const probe = installPlugin(
        home,
        'contract-credential-location',
        'credential-location-probe.js'
      )
      const file = globalConfigFile(home)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ plugins: [{ package: probe, options: {} }] }, null, 2))
      return fixtureConfig(fixture)
    },
    env: (_fixture, home) => ({ CONTRACT_CREDENTIAL_PROBE_LOG: probeLog(home) })
  })

  it('list (and a remove of a missing id) do not boot it; create does', async () => {
    const r = rig()
    // Nothing has asked for the global-config location's services yet.
    await r.api.ok('credential.list')
    await r.api.ok('credential.remove', { params: { credentialID: 'cred_missing' } })
    expect(probeLines(r.home)).toEqual([])

    // `create` provides `requireConnectable` with the global-config Location's services: its
    // plugins load (the user's included) and an OAuth connection may be resolved from them.
    await r.api.ok('credential.create', {
      body: {
        id: 'cred_contract_probe',
        integrationID: 'openai',
        label: 'probe',
        value: { type: 'key', key: 'sk-contract-probe' }
      }
    })
    await expect.poll(() => probeLines(r.home).length, { timeout: 15_000 }).toBeGreaterThan(0)
    // Built once, not per route.
    expect(probeLines(r.home)).toEqual(['global-config-location'])
  })
})
