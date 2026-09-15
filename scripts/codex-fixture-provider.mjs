// A standalone Codex fixture provider: a localhost Responses server plus the
// `CODEX_HOME` that points a Codex process at it. Run under BUN — it imports the
// TypeScript module the real-binary integration suite uses
// (`src/integration/codex/fixture-provider.ts`), so there is exactly one copy of
// the wire and one copy of the `config.toml`.
//
// Usage:
//   bun scripts/codex-fixture-provider.mjs --codex-home <dir> [--port 0]
//        [--provider openai|fixture] [--model <name>] [--text <assistant text>]
//        [--no-auth] [--reviewer user|auto_review]
//
// Prints `PORT <n>` on the first line of stdout and then one JSON line
// describing what it wrote, so a parent process can parse either. It then serves
// turns until it is killed — or, with `--exit-on-stdin-close`, until its stdin
// ends, which is how the stress harness guarantees it dies with its parent.
// One `TURN <n>` line per request goes to stderr.
//
// Defaults are what a REAL ClaudeUI session needs, not what the integration
// suite needs: `model_provider = "openai"`, because `assertCodexProvider`
// (`src/core/codex/model-selection.ts`) refuses every other provider name, with
// `openai_base_url` pointing that built-in provider at this server — the only
// way to redirect it, since declaring `[model_providers.openai]` makes 0.154
// throw the WHOLE config away and fall back to the real endpoint. The model is
// left unset so Codex picks its own catalogued default: naming one the native
// catalog does not carry makes `selectCodexModel` throw.
//
// No credentials of any kind. `auth.json` gets a made-up API key whose only job
// is to prove the child read the isolated home it was given.
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FIXTURE_API_KEY,
  FIXTURE_AUTHORIZATION,
  fixtureAssistantMessage,
  startFixtureProvider,
  writeFixtureCodexHome
} from '../src/integration/codex/fixture-provider'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const codexHome = arg('codex-home', '')
if (!codexHome) {
  console.error('codex-fixture-provider: --codex-home <dir> is required')
  process.exit(2)
}
const provider = arg('provider', 'openai')
const model = arg('model', '')
const text = arg('text', undefined)
const reviewer = arg('reviewer', 'user')
const port = Number.parseInt(arg('port', '0'), 10)
// `requires_openai_auth = true` in the override below, so the child sends the
// key from `auth.json`; `--no-auth` is for a home that declares the `fixture`
// provider instead, which sends no header at all.
const withAuth = !has('no-auth')

const home = resolve(codexHome)
mkdirSync(home, { recursive: true })

const fixture = await startFixtureProvider({
  port,
  authorization: withAuth ? FIXTURE_AUTHORIZATION : undefined,
  script: ({ requests }) => {
    process.stderr.write(`TURN ${requests.length}\n`)
    return fixtureAssistantMessage(text)
  }
})

writeFixtureCodexHome(home, {
  port: fixture.port,
  provider,
  model: model || null,
  openaiBaseUrl: provider === 'openai' ? `http://127.0.0.1:${fixture.port}/v1` : null,
  approvalsReviewer: reviewer === 'auto_review' ? 'auto_review' : 'user',
  apiKey: withAuth ? FIXTURE_API_KEY : null
})

console.log(`PORT ${fixture.port}`)
console.log(
  JSON.stringify({
    port: fixture.port,
    codexHome: home,
    provider,
    model: model || null,
    authorization: withAuth
  })
)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  process.stderr.write(`TURNS ${fixture.requests.length} ERRORS ${fixture.errors.length}\n`)
  for (const error of fixture.errors) process.stderr.write(`REJECTED ${error}\n`)
  await fixture.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Opt-in, not automatic: a shell that backgrounds this script hands it a stdin
// that is already at EOF, and an automatic watchdog would shut the fixture down
// before it served a single turn. The parent that wants the guarantee holds the
// write end of a pipe and passes the flag.
if (has('exit-on-stdin-close')) {
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.stdin.resume()
}
