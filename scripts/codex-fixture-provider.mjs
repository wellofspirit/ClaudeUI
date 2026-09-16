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
//        [--chatgpt [--vault-home <dir> [--accounts <n>]]]
//
// Prints `PORT <n>` on the first line of stdout and then one JSON line
// describing what it wrote, so a parent process can parse either. It then serves
// turns until it is killed — or, with `--exit-on-stdin-close`, until its stdin
// ends, which is how the stress harness guarantees it dies with its parent.
// One `TURN <n>` line per request goes to stderr.
//
// --chatgpt serves an INJECTED ChatGPT identity instead of an API key: the
// config gains `chatgpt_base_url` (so the binary's own `/wham/*` and usage reads
// land here and not on the real chatgpt.com, where a fabricated token kills the
// host within seconds), the provider call takes any bearer, and gzip-encoded
// bodies — what a session under an injected identity sends — are decoded.
// --vault-home <dir> writes the FABRICATED vault the identity comes from
// (`<dir>/.claude/ui/auth-vault.json`, v3, `--accounts <n>` of them, the first
// active), and requires --chatgpt because a vault account without the redirect
// is exactly the combination that kills the host.
//
// A drive recipe, all of it under one scratch home and none of it the real one:
//
//   bun scripts/codex-fixture-provider.mjs --codex-home <home>/.codex \
//        --chatgpt --vault-home <home> --accounts 1 --exit-on-stdin-close
//   # then launch the app with Electron's own `-r <home-shim.cjs>` (the shim
//   # patches os.homedir() to CLAUDEUI_TEST_HOME, the only isolation hook that
//   # survives Electron's startup), CLAUDEUI_TEST_HOME=<home>,
//   # CODEX_HOME=<home>/.codex and CLAUDE_UI_LOG_DIR=<home>/.claude/ui/logs.
//   # `node scripts/codex-render-stress.mjs --accounts 1` does all of it.
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
  writeFabricatedVault,
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
// provider instead, which sends no header at all. Under `--chatgpt` the bearer
// is the INJECTED vault token, so `auth.json` is written only when asked for.
const chatgpt = has('chatgpt')
const withAuth = !has('no-auth') && !chatgpt
const vaultHome = arg('vault-home', '')
const accounts = Number.parseInt(arg('accounts', '1'), 10)
if (vaultHome && !chatgpt) {
  console.error('codex-fixture-provider: --vault-home requires --chatgpt')
  process.exit(2)
}
if (!vaultHome && argv.includes('--accounts')) {
  console.error('codex-fixture-provider: --accounts requires --vault-home')
  process.exit(2)
}
if (vaultHome && (!Number.isInteger(accounts) || accounts < 1)) {
  console.error('codex-fixture-provider: --accounts must be an integer >= 1')
  process.exit(2)
}

const home = resolve(codexHome)
mkdirSync(home, { recursive: true })

const fixture = await startFixtureProvider({
  port,
  chatgpt,
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
  chatgpt,
  apiKey: withAuth ? FIXTURE_API_KEY : null
})

// The fabricated vault the injected identity comes from. It refuses the real
// home itself; never point it at one anyway.
const vault = vaultHome ? writeFabricatedVault(resolve(vaultHome), { accounts }) : null
if (vault) process.stderr.write(`VAULT ${vault.path} ${vault.accounts.length} accounts\n`)

console.log(`PORT ${fixture.port}`)
console.log(
  JSON.stringify({
    port: fixture.port,
    codexHome: home,
    provider,
    model: model || null,
    authorization: withAuth,
    chatgpt,
    vaultAccounts: vault ? vault.accounts.length : 0
  })
)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  process.stderr.write(
    `TURNS ${fixture.requests.length} ERRORS ${fixture.errors.length} BACKEND ${fixture.backend.length}\n`
  )
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
