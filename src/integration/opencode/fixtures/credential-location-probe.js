// TEST ONLY. Records that the location this plugin was loaded into built its services —
// i.e. that a LOCATION ACTIVATED, which is what can resolve (and refresh) the active OAuth
// credential (ADR-097 §5). Installed in the isolated home's GLOBAL config (`~/.config/opencode`),
// so a line in the log means the global-config location booted; opencode 2.x loads a location's
// plugins lazily, the first time something asks for that location's services (`credential.create`
// does, `packages/server/src/handlers/credential.ts` at v2.2.5; `credential.list` does not).
import fs from 'node:fs'

export default {
  id: 'claudeui-contract-credential-location-probe',
  setup: () => {
    const log = process.env.CONTRACT_CREDENTIAL_PROBE_LOG
    if (log) fs.appendFileSync(log, 'global-config-location\n')
  }
}
