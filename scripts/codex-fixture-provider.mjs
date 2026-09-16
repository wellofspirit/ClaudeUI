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
//        [--command "<shell>"] [--guardian approved|denied]
//        [--reasoning "<headline>"]
//        [--chatgpt [--vault-home <dir> [--accounts <n>]]]
//
// Prints `PORT <n>` on the first line of stdout and then one JSON line
// describing what it wrote, so a parent process can parse either. It then serves
// turns until it is killed — or, with `--exit-on-stdin-close`, until its stdin
// ends, which is how the stress harness guarantees it dies with its parent.
// One `TURN <n>` line per request goes to stderr.
//
// --command "<shell>" scripts a TOOL CALL on the first agent request: the
// fixture answers with `exec_command` carrying that script (the integration
// suite's exact argument shape, `sandbox_permissions: "require_escalated"` +
// a justification), and answers the request that follows the tool's output with
// the ordinary assistant text. Without it the agent only ever speaks, and an
// agent that proposes no action gives the reviewer nothing to review.
//
// What sends the action to the reviewer is `sandbox_permissions:
// "require_escalated"` in that call — `core/src/tools/handlers/mod.rs:276`
// returns `permissions_preapproved: false` for it — NOT where the command
// writes. The integration suite's own scripted command writes inside the cwd
// and is reviewed all the same. The path only has to be somewhere isolated.
//
// --guardian <approved|denied> scripts the NATIVE auto-reviewer: it implies
// `--reviewer auto_review`, and every guardian call (told apart by the reviewer
// prompt's own `>>> APPROVAL REQUEST START` frame, the same predicate the
// integration suite uses) is answered with that verdict and a fixed rationale.
// That is what makes a real-app drive in Auto mode show the tool card's review
// chip and strip (F18) without a credential and without a paid turn. It also
// DEFAULTS --command — an agent with nothing to propose is never reviewed — to
// a write into the parent of --codex-home, i.e. the isolated test home this
// very invocation was given. NEVER `$HOME`: the app-server child inherits the
// untouched environment (the drive recipe's shim patches `os.homedir()` in the
// Electron main process only), so `$HOME` there is the developer's real home.
// Pass --command to review something else.
//
// --reasoning "<headline>" puts a REASONING item in front of whatever every
// agent turn was going to answer with, streamed the way the wire streams one
// (`output_item.added` with an empty summary, `reasoning_summary_part.added`,
// `reasoning_summary_text.delta`, `output_item.done` carrying the summary), so
// the app shows a rendered Thought without a credential. Guardian turns are
// excluded exactly as --command excludes them: the reviewer's own session is
// not the agent's, and a Thought on it would render nowhere. Pass the headline
// as the backend writes one — a bold Markdown line — to exercise the strip
// (F19: a whole-line `**…**` is dropped from the canonical thinking block).
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
import { dirname, join, resolve } from 'node:path'
import {
  FIXTURE_API_KEY,
  FIXTURE_AUTHORIZATION,
  fixtureAssistantMessage,
  fixtureGuardianVerdict,
  fixtureReasoningItem,
  isGuardianRequest,
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
const command = arg('command', '')
const reasoning = arg('reasoning', '')
if (argv.includes('--reasoning') && !reasoning) {
  console.error('codex-fixture-provider: --reasoning needs a headline')
  process.exit(2)
}
const guardian = arg('guardian', '')
if (guardian && guardian !== 'approved' && guardian !== 'denied') {
  console.error('codex-fixture-provider: --guardian must be `approved` or `denied`')
  process.exit(2)
}
// A scripted verdict is pointless unless the native reviewer is the one
// deciding, so the flag turns it on rather than failing on a mismatched pair.
const reviewer = guardian ? 'auto_review' : arg('reviewer', 'user')
// Reviewed because the scripted call asks to be (`sandbox_permissions:
// "require_escalated"`), not because of where it writes — so the path only has
// to be isolated. An ABSOLUTE path derived from --codex-home is that: its
// parent is the test home this invocation was handed. Deliberately not `$HOME`,
// which in the app-server child is the developer's real home — the drive
// recipe's shim patches `os.homedir()` in the Electron main process, and the
// child inherits the untouched env.
const DEFAULT_ESCALATION_TARGET = join(dirname(resolve(codexHome)), 'fixture-escalation.txt')
const DEFAULT_ESCALATING_COMMAND = `printf fixture-escalation > "${DEFAULT_ESCALATION_TARGET}"`
const scriptedCommand = command || (guardian ? DEFAULT_ESCALATING_COMMAND : '')
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
  script: ({ request, requests }) => {
    if (guardian && isGuardianRequest(request)) {
      process.stderr.write(`GUARDIAN ${guardian}\n`)
      return fixtureGuardianVerdict(guardian)
    }
    process.stderr.write(`TURN ${requests.length}\n`)
    // The reviewer is a SECOND model session on the SAME provider, so its calls
    // interleave with the agent's and the step index must count only the
    // agent's — otherwise the scripted command never fires.
    const agentTurns = requests.filter(
      (entry) => !isGuardianRequest(entry) && entry.generate !== false
    ).length
    const answer =
      scriptedCommand && request.generate !== false && agentTurns === 1
        ? {
            type: 'function_call',
            call_id: 'fixture-command',
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: scriptedCommand,
              sandbox_permissions: 'require_escalated',
              justification: 'Isolated fixture write outside the workspace root'
            })
          }
        : fixtureAssistantMessage(text)
    // Every AGENT turn reasons first. The guardian predicate is the gate even
    // without --guardian: a reviewer session's Thought belongs to no card.
    return reasoning && !isGuardianRequest(request) && request.generate !== false
      ? [fixtureReasoningItem(reasoning), answer]
      : answer
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
    command: scriptedCommand || null,
    guardian: guardian || null,
    reasoning: reasoning || null,
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
