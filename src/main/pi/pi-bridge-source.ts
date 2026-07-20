/**
 * ClaudeUI pi approval-bridge extension — source constant.
 *
 * pi has no native permission system (see docs/protocol-pi/README.md
 * "Extensions" — verified in M0 against the real standalone binary). The
 * sanctioned mechanism is a ClaudeUI-owned extension loaded per-spawn with
 * `-e`, whose `tool_call` hook returns `{block: true, reason}` to prevent
 * execution, consulting a loopback HTTP endpoint (PiBridgeHost) for the
 * decision:
 *
 *   pi child (this extension) --POST /tool-call--> PiBridgeHost (main process)
 *                              <--{behavior:'allow'|'deny', ...}--
 *
 * This string is written verbatim to
 * `<os.tmpdir()>/claudeui-pi-bridge/<PI_BRIDGE_VERSION>/claudeui-bridge.ts`
 * by `writeBridgeExtension()` (PiBridgeHost.ts) and loaded via
 * `pi --mode rpc -e <path>`. Never written under `~/.pi/**` — that's user
 * space.
 *
 * CONSTRAINTS (do not violate when editing this string):
 *  - NO `import` statements. This file is compiled by pi's OWN jiti loader in
 *    a separate process — it is not part of ClaudeUI's tsconfig/bundle and
 *    has zero module-resolution surface (no node_modules relative to it, no
 *    path aliases). `export default function (pi) {}` is the entire contract
 *    pi needs; `fetch` and `process.env` are ambient globals in pi's runtime
 *    (verified — extensions.md's own `tool_result` example calls bare
 *    `fetch()` with no import).
 *  - Must be INERT (register nothing) when CLAUDEUI_PI_BRIDGE_URL/TOKEN are
 *    absent, so a user launching the pinned binary by hand (outside
 *    ClaudeUI) is never affected by this file existing on disk.
 *  - Fail CLOSED on every error path (network failure, non-2xx, bad JSON) —
 *    an unreachable ClaudeUI host must never silently allow a tool call
 *    through. Never include the URL or bearer token in a reason string (that
 *    text can end up in the model's context).
 *  - Bump PI_BRIDGE_VERSION whenever this string changes. The file on disk is
 *    write-if-absent and version-keyed by directory, so a stale copy from a
 *    previous ClaudeUI build never shadows an edit made here.
 *  - M3 ADDED a `resources_discover` handler (shared-skills directive) gated
 *    INDEPENDENTLY on its OWN env var (CLAUDEUI_PI_SKILL_DIRS) — a separate
 *    `if` block, not nested under the bridge URL/token check. Neither hook may
 *    gate on the other's env var: the skills env var alone must not activate
 *    tool_call, and the bridge URL/token alone must not activate
 *    resources_discover.
 *  - M4a+b ADDED four `pi.registerTool()` registrations — render_mermaid,
 *    create_mockup, show_mockup, dispatch_agent — calling back over the SAME
 *    bridge host's `POST /hosted-tool` route (PiBridgeHost.ts). Gated on its
 *    OWN boolean env var (CLAUDEUI_PI_HOSTED_TOOLS=1), independently of the
 *    tool_call/resources_discover hooks (same independence rule as M3's
 *    skills), though it still needs bridgeUrl/bridgeToken (the SAME loopback
 *    host — execute() POSTs to it just like the tool_call hook does).
 *    dispatch_agent gets a SECOND, nested gate (CLAUDEUI_PI_DISPATCH_ENABLED
 *    =1) so it registers only when PiSession's resolved crossEngineDispatch
 *    capability is true, independent of the other three hosted tools.
 *    `parameters` is a PLAIN JSON-schema object literal — verified against
 *    the real binary (scratchpad probe): no typebox import needed, the model
 *    calls the tool with correct args and zero extension_errors. execute()
 *    returns `{content:[{type:'text',text}], isError?}` (MCP-shaped),
 *    verified as exactly what pi.registerTool().execute expects.
 *  - M5a ADDED plan mode: `pi.registerCommand('cui-plan-enter'|'cui-plan-exit')`
 *    + a `pi.registerTool('exit_plan')`, gated on its OWN env var
 *    (CLAUDEUI_PI_PLAN_TOOLS=1), independent of bridgeUrl/bridgeToken (unlike
 *    the hosted tools above, exit_plan's execute() makes NO network call —
 *    it only flips the active tool set locally). The two commands are
 *    PiSession's inbound toggle channel (sent as a normal `prompt` RPC
 *    message, e.g. `/cui-plan-enter` — verified: an extension command
 *    executes immediately even mid-turn, rpc.md:67); exit_plan's `execute()`
 *    runs ONLY when the tool_call gate below already allowed the call (i.e.
 *    ClaudeUI resolved the human's approval positively) — a blocked call
 *    never reaches execute(), so plan state and the restricted tool set
 *    survive a deny/"keep planning" untouched. That asymmetry (gate decides,
 *    execute() reacts) is the entire exit contract; see PiSession.resolveApproval.
 *    ADDENDUM (bridge v5): pi.registerTool() AUTO-ACTIVATES the tool, so
 *    exit_plan would otherwise be model-visible from spawn in every mode —
 *    a `session_start` handler hides it whenever plan state is not active
 *    (fires on startup and after session switch/fork reloads), cui-plan-enter
 *    captures `toolsBeforePlan` WITHOUT exit_plan so no restore path re-adds
 *    it, and permission-engine.ts denies any exit_plan call outside plan
 *    mode (PLAN_EXIT_OUTSIDE_PLAN_REASON) as the gate-layer backstop.
 */

export const PI_BRIDGE_VERSION = '5'

export const PI_BRIDGE_EXTENSION_SOURCE = `// AUTO-GENERATED by ClaudeUI (src/main/pi/pi-bridge-source.ts). Do not edit
// this file directly -- it is overwritten on the next ClaudeUI launch.
//
// ClaudeUI approval-bridge extension. Inert unless both CLAUDEUI_PI_BRIDGE_URL
// and CLAUDEUI_PI_BRIDGE_TOKEN are set in the environment (ClaudeUI sets both
// per-spawn; a user running this pinned pi binary by hand never sets them, so
// the extension registers nothing and is a complete no-op for them).
export default function (pi) {
  // Shared-skills discovery (M3): independently gated on its OWN env var --
  // registered (or not) BEFORE the bridge URL/token check below returns early,
  // so neither hook's presence depends on the other's env var. Absent means
  // this handler is never registered, so a user running the pinned binary by
  // hand (or a spawn with no skill dirs to contribute) is unaffected. The main
  // process computes the dir list (checking existence) and passes it via env;
  // this handler just splits the string -- no fs access here, keeps the
  // extension dumb.
  const skillDirsEnv = process.env.CLAUDEUI_PI_SKILL_DIRS;
  if (skillDirsEnv) {
    pi.on('resources_discover', () => {
      // Node's path.delimiter without importing node:path (see the
      // no-import constraint above) -- process is already an ambient global.
      var delimiter = process.platform === 'win32' ? ';' : ':';
      var skillPaths = skillDirsEnv.split(delimiter).filter(function (p) { return p.length > 0; });
      return { skillPaths: skillPaths };
    });
  }

  // Plan mode (M5a): a ClaudeUI permission mode ('plan') enforced BOTH here
  // (the model never sees edit/write while planning) and by PiSession's
  // permission-engine gate (defense in depth -- bash gets a read-only
  // allowlist there; the gate answers 'ask' for exit_plan itself, which is
  // what surfaces ExitPlanModeCard). Independently gated on its OWN env var
  // (CLAUDEUI_PI_PLAN_TOOLS=1), BEFORE the bridge-only early return below --
  // exit_plan's execute() makes NO network call, so this whole block needs
  // neither bridgeUrl nor bridgeToken to function (though the tool_call gate
  // a few lines down, which is what actually turns exit_plan's call into an
  // approval prompt, does need them -- PiSession always sets both together).
  // Mirrors vendor/pi-cli/examples/extensions/plan-mode/index.ts's
  // togglePlanMode/enablePlanModeTools/restoreNormalModeTools pattern: only
  // edit/write are dropped from the active set (ported verbatim from that
  // example's PLAN_MODE_DISABLED_TOOLS) -- bash and any other active tool
  // (hosted tools, dispatch_agent) stay active; the permission-engine gate,
  // not this tool-set switch, is what actually restricts them further.
  if (process.env.CLAUDEUI_PI_PLAN_TOOLS === '1') {
    var planState = { inPlan: false, toolsBeforePlan: null };

    var withoutExitPlan = function (names) {
      return names.filter(function (name) { return name !== 'exit_plan'; });
    };

    var restorePlanTools = function () {
      // The capture below already filtered exit_plan out of toolsBeforePlan;
      // the fallback filters too, so NO restore path can ever re-expose
      // exit_plan outside plan mode.
      pi.setActiveTools(planState.toolsBeforePlan || withoutExitPlan(pi.getActiveTools()));
      planState.inPlan = false;
      planState.toolsBeforePlan = null;
    };

    pi.registerTool({
      name: 'exit_plan',
      label: 'Exit Plan Mode',
      description: 'Call this when you are done researching and are ready to present your implementation plan. Pass the complete plan (markdown) as the plan parameter. The user reviews it and decides how to proceed -- if approved, your normal tools are restored; if not, you keep planning.',
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: 'The complete implementation plan, in markdown, for the user to review.' }
        },
        required: ['plan']
      },
      execute: async function (toolCallId, params) {
        // Reached ONLY if the tool_call gate below allowed this call (the
        // gate answers 'ask' for exit_plan in plan mode -- ClaudeUI resolves
        // it 'allow' or 'deny'; pi never calls execute() for a blocked call.
        // Outside plan mode the gate denies outright, so a stray call while
        // the tool is briefly visible never reaches here). No /hosted-tool
        // POST -- entirely local to the extension.
        if (planState.inPlan) restorePlanTools();
        return { content: [{ type: 'text', text: 'Plan approved -- proceeding.' }] };
      }
    });

    // pi.registerTool() AUTO-ACTIVATES the tool (the M4a hosted tools rely on
    // exactly that), so exit_plan is model-visible from load in EVERY mode.
    // session_start fires after extension load on startup AND after session
    // switch/fork reloads (this extension instance is fresh then, inPlan =
    // false) -- hide exit_plan unless plan state is active. PiSession's
    // doStart re-sends /cui-plan-enter when the session's mode is 'plan',
    // which re-adds it. The permission-engine gate additionally denies any
    // exit_plan call outside plan mode (defense in depth for the window
    // between load and this event, and for any pi version that re-activates
    // registered tools).
    pi.on('session_start', function () {
      if (!planState.inPlan) {
        pi.setActiveTools(withoutExitPlan(pi.getActiveTools()));
      }
    });

    pi.registerCommand('cui-plan-enter', {
      description: 'ClaudeUI internal: enter plan mode (read-only tools).',
      handler: async function () {
        if (planState.inPlan) return; // idempotent -- already entered
        var active = pi.getActiveTools();
        // Capture WITHOUT exit_plan -- registration auto-activated it, and a
        // restore must never re-add it outside plan mode.
        planState.toolsBeforePlan = withoutExitPlan(active);
        var next = active.filter(function (name) { return name !== 'edit' && name !== 'write'; });
        if (next.indexOf('exit_plan') === -1) next.push('exit_plan');
        pi.setActiveTools(next);
        planState.inPlan = true;
      }
    });

    pi.registerCommand('cui-plan-exit', {
      description: 'ClaudeUI internal: exit plan mode (restore normal tools).',
      handler: async function () {
        if (!planState.inPlan) return; // idempotent -- already exited
        restorePlanTools();
      }
    });
  }

  const bridgeUrl = process.env.CLAUDEUI_PI_BRIDGE_URL;
  const bridgeToken = process.env.CLAUDEUI_PI_BRIDGE_TOKEN;

  // Hosted tools (M4a+b): render_mermaid/create_mockup/show_mockup/
  // dispatch_agent, independently gated on their OWN boolean env var
  // (CLAUDEUI_PI_HOSTED_TOOLS=1) -- computed here, BEFORE the bridge-only
  // early return below, so a build/config can disable hosted tools without
  // disabling approvals (the approval hook further below is gated purely on
  // bridgeUrl/bridgeToken, with no dependency on this block ever running).
  // Hosted tools still need bridgeUrl/bridgeToken themselves -- execute()
  // POSTs to the SAME loopback host the tool_call hook calls, just a
  // different route.
  if (process.env.CLAUDEUI_PI_HOSTED_TOOLS === '1' && bridgeUrl && bridgeToken) {
    var postHostedTool = async function (toolName, input, toolCallId) {
      try {
        var res = await fetch(bridgeUrl + '/hosted-tool', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + bridgeToken,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ toolName: toolName, input: input, toolCallId: toolCallId })
        });

        if (!res.ok) {
          return {
            content: [{ type: 'text', text: 'ClaudeUI hosted-tool service unreachable (HTTP ' + res.status + ')' }],
            isError: true
          };
        }

        var result = await res.json();
        if (result && Array.isArray(result.content)) return result;
        return {
          content: [{ type: 'text', text: 'ClaudeUI hosted-tool service returned a malformed response' }],
          isError: true
        };
      } catch (err) {
        var errorClass = err && err.constructor && err.constructor.name ? err.constructor.name : 'Error';
        return {
          content: [{ type: 'text', text: 'ClaudeUI hosted-tool service unreachable (' + errorClass + ')' }],
          isError: true
        };
      }
    };

    pi.registerTool({
      name: 'render_mermaid',
      label: 'Render Mermaid Diagram',
      description: 'Render a Mermaid.js diagram as an interactive SVG in the chat UI, displayed inline in a dedicated card. Returns success confirmation or syntax error details -- fix the syntax and call again if it errors.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Complete Mermaid diagram syntax' },
          title: { type: 'string', description: 'Optional title/caption shown on the diagram card' }
        },
        required: ['source']
      },
      execute: async function (toolCallId, params) {
        return postHostedTool('render_mermaid', params, toolCallId);
      }
    });

    pi.registerTool({
      name: 'create_mockup',
      label: 'Create UI Mockup',
      description: 'Create a new UI mockup: scaffolds a directory on disk and writes the initial HTML, rendered inline as a preview card. Tailwind v3 utility classes are available; default to vanilla HTML/CSS/JS. Returns a directory ID -- use the Edit tool on the returned file path for incremental changes, then show_mockup to re-display.',
      parameters: {
        type: 'object',
        properties: {
          html: { type: 'string', description: 'HTML body content for the mockup (goes inside <body>; Tailwind utility classes available)' },
          title: { type: 'string', description: 'Title shown on the mockup preview card' }
        },
        required: ['html']
      },
      execute: async function (toolCallId, params) {
        return postHostedTool('create_mockup', params, toolCallId);
      }
    });

    pi.registerTool({
      name: 'show_mockup',
      label: 'Show UI Mockup',
      description: 'Display an existing mockup from disk by its directory ID. Use this when the user wants to see a previously created mockup again and the original card is no longer visible.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'The mockup directory ID returned by create_mockup' }
        },
        required: ['directory']
      },
      execute: async function (toolCallId, params) {
        return postHostedTool('show_mockup', params, toolCallId);
      }
    });

    // dispatch_agent (M4b): a SECOND, nested gate -- registers only when
    // PiSession's resolved crossEngineDispatch capability was true at spawn
    // time (CLAUDEUI_PI_DISPATCH_ENABLED=1), independent of the three hosted
    // tools above. \`engine\` lists the OTHER engines only -- dispatching
    // pi->pi is same-engine and guard-rejected by crossEngineDispatcher.
    if (process.env.CLAUDEUI_PI_DISPATCH_ENABLED === '1') {
      pi.registerTool({
        name: 'dispatch_agent',
        label: 'Dispatch Agent',
        description: 'Delegate a task to an agent running on a DIFFERENT engine (claude or opencode). The agent runs headless in the same working directory and its final answer is returned as this tool result. The result includes a session_id -- pass it back as session_id to continue the same agent with its context intact.',
        parameters: {
          type: 'object',
          properties: {
            engine: { type: 'string', enum: ['claude', 'opencode'], description: 'Target engine to dispatch to' },
            prompt: { type: 'string', description: 'Task for the dispatched agent' },
            model: { type: 'string', description: 'Target model (engine-specific identifier); omit for the configured default' },
            session_id: { type: 'string', description: 'session_id from a previous dispatch_agent result -- continues that agent' }
          },
          required: ['engine', 'prompt']
        },
        execute: async function (toolCallId, params) {
          return postHostedTool('dispatch_agent', params, toolCallId);
        }
      });
    }
  }

  if (!bridgeUrl || !bridgeToken) return;

  pi.on('tool_call', async (event) => {
    try {
      const res = await fetch(bridgeUrl + '/tool-call', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + bridgeToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input
        })
      });

      if (!res.ok) {
        return { block: true, reason: 'ClaudeUI approval service unreachable (HTTP ' + res.status + ')' };
      }

      const decision = await res.json();

      if (decision && decision.behavior === 'allow') {
        if (decision.updatedInput && typeof decision.updatedInput === 'object') {
          // Documented allow-with-edits mechanism: mutate event.input IN PLACE
          // (reassigning event.input would not affect the actual tool call).
          for (const key of Object.keys(event.input)) delete event.input[key];
          Object.assign(event.input, decision.updatedInput);
        }
        return undefined;
      }

      return { block: true, reason: (decision && decision.reason) || 'Denied by ClaudeUI' };
    } catch (err) {
      // Network failure, timeout, or bad JSON -- fail CLOSED. Never surface
      // the bridge URL or token here.
      const errorClass = err && err.constructor && err.constructor.name ? err.constructor.name : 'Error';
      return { block: true, reason: 'ClaudeUI approval service unreachable (' + errorClass + ')' };
    }
  });

  // The user already chose to open/trust this folder in ClaudeUI -- the
  // desktop app itself is the trust boundary, not pi's own per-project
  // trust.json. remember:false deliberately does NOT persist this decision to
  // pi's trust store: trust is re-derived fresh from ClaudeUI's own state on
  // every launch, and since this handler only participates when
  // CLAUDEUI_PI_BRIDGE_URL/TOKEN are set (i.e. ClaudeUI itself spawned the
  // process -- see the early return above), a user running the SAME pinned
  // binary by hand still gets pi's own built-in trust prompt untouched.
  pi.on('project_trust', () => ({ trusted: 'yes', remember: false }));
}
`
