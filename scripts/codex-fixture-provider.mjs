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
//        [--web-search ["<query>"]] [--view-image <path>] [--mcp-tool <tool>] [--plan "<markdown>"]
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
// --web-search ["<query>"] scripts a hosted WEB SEARCH on the first agent turn:
// the fixture answers with a Responses `web_search_call` output item, which the
// core turns into a `webSearch` thread item. It carries NO structured results —
// the Responses item has no such field on the pinned binary, and
// `WebSearchItem.results` is filled out-of-band by the standalone web-search
// extension — so the card shows the query, the "Searched" action line and its
// text fallback. The query is optional; a default one is used.
//
// --view-image <path> scripts a `view_image` call on that path, producing an
// `imageView` thread item. The path has to exist and be a readable PNG/JPEG/GIF/
// WebP on the machine the app-server runs on, or the tool fails and no item is
// produced. Put the file inside the isolated test home.
//
// --plan "<markdown>" wraps the assistant answer in `<proposed_plan>` tags. The
// core lifts a `plan` thread item out of those tags ONLY when the turn ran under
// `collaborationMode.mode === 'plan'`, so drive the app in Plan mode: the same
// flag in Default mode deliberately yields an ordinary agent message and no plan
// card, which is what the integration probe pins.
//
// --mcp-tool <tool> scripts a call to an MCP tool the app-server OFFERED on the
// first agent turn: the model request carries every configured server as a
// Responses namespace (`{ type: "namespace", name: "mcp__<server>", tools }`),
// and the call is emitted against the namespace that lists <tool>. The server
// itself comes from the isolated home's `config.toml` (`[mcp_servers.<name>]`,
// a stdio stub); if no namespace offers the tool the turn answers with a plain
// message saying so, which is the diagnosable outcome rather than a dead turn.
//
// The four scripted ITEMS (--command, --web-search, --view-image, --mcp-tool)
// are mutually exclusive on one turn; the first one given wins, in that order.
// Everything else — --reasoning, --plan, --text — composes with whichever fires.
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
  fixturePlanMessage,
  fixtureReasoningItem,
  fixtureViewImageCall,
  fixtureWebSearchItem,
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
// `--web-search` takes an OPTIONAL query, so presence and value are read apart:
// a bare flag is legal and means "the default query".
const webSearch = has('web-search')
const webSearchQuery = arg('web-search', '')
const viewImage = arg('view-image', '')
if (argv.includes('--view-image') && !viewImage) {
  console.error('codex-fixture-provider: --view-image needs a path')
  process.exit(2)
}
const mcpTool = arg('mcp-tool', '')
if (argv.includes('--mcp-tool') && !mcpTool) {
  console.error('codex-fixture-provider: --mcp-tool needs a tool name')
  process.exit(2)
}
const plan = arg('plan', '')
if (argv.includes('--plan') && !plan) {
  console.error('codex-fixture-provider: --plan needs the plan markdown')
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

/**
 * A `function_call` against the MCP namespace that offers `tool`, read off the
 * request's `tools` (the app-server names the namespace `mcp__<sanitised
 * server>`, and guessing it would fail as "tool not available"). Same shape
 * `src/integration/codex/codex-mcp-approval.integration.test.ts` builds.
 */
function fixtureMcpToolCall(request, tool) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const namespace = tools.find(
    (entry) =>
      entry &&
      entry.type === 'namespace' &&
      String(entry.name ?? '').startsWith('mcp__') &&
      (Array.isArray(entry.tools) ? entry.tools : []).some((inner) => inner && inner.name === tool)
  )
  if (!namespace) {
    console.error(
      `codex-fixture-provider: no MCP namespace offers ${tool}; tools: ${JSON.stringify(tools.map((entry) => entry && entry.name))}`
    )
    return fixtureAssistantMessage(`Fixture: no MCP tool named ${tool} was offered.`)
  }
  return {
    type: 'function_call',
    call_id: 'fixture-mcp',
    namespace: String(namespace.name),
    name: tool,
    arguments: '{}'
  }
}

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
    // The FIRST agent turn is the one that carries a scripted item; every turn
    // after it (including the one answering the item's output) just speaks.
    const firstAgentTurn = request.generate !== false && agentTurns === 1
    const answer =
      firstAgentTurn && scriptedCommand
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
        : firstAgentTurn && webSearch
          ? fixtureWebSearchItem(webSearchQuery || undefined)
          : firstAgentTurn && viewImage
            ? fixtureViewImageCall(viewImage)
            : firstAgentTurn && mcpTool
              ? fixtureMcpToolCall(request, mcpTool)
              : plan
                ? fixturePlanMessage(plan)
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
    webSearch: webSearch ? webSearchQuery || 'default' : null,
    viewImage: viewImage || null,
    mcpTool: mcpTool || null,
    plan: plan || null,
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
