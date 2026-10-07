import { describe, it, expect } from 'vitest'
import { hostPrecheck, planModeRefusesAsk, type HostPrecheckContext } from '../host-precheck'
import { OpencodeSessionAllows } from '../session-allows'
import { asHostPrecheckRules, compileClaudeRulesV2 } from '../permission-v2'
import { matchesUserAskRule } from '../wildcard'
import { denyAskHit } from '../../permissions/shell-rules'
import type { PendingApproval } from '../../../shared/types'

// Synthetic rules only.
const DENY = ['Bash(git push --force:*)', 'Bash(rm -rf:*)']
const ASK = ['Bash(docker run:*)', 'Edit(*.env)']

function ctxWith(
  opts: {
    deny?: string[]
    ask?: string[]
    allow?: string[]
    allows?: OpencodeSessionAllows
    mode?: string
    cwd?: string
    platform?: NodeJS.Platform
  } = {}
): HostPrecheckContext {
  const deny = opts.deny ?? DENY
  const ask = opts.ask ?? ASK
  const allow = opts.allow ?? []
  return {
    mode: opts.mode ?? 'default',
    rules: { deny, ask, allow },
    userRules: asHostPrecheckRules(
      compileClaudeRulesV2({ allow, deny, ask, additionalDirectories: [], defaultMode: undefined })
    ),
    sessionAllows: opts.allows ?? new OpencodeSessionAllows(),
    platform: opts.platform ?? 'linux',
    ...(opts.cwd !== undefined ? { cwd: opts.cwd, realpath: () => undefined } : {})
  }
}

/** A shell ask as the mapper builds it: the tool's `command` input + per-statement resources. */
function bash(command: string, patterns: string[] = [command]): PendingApproval {
  return { requestId: 'per_1', toolUseId: 'c1', toolName: 'shell', input: { command }, patterns }
}

describe('hostPrecheck (ADR-085 S2)', () => {
  describe('§1 deny', () => {
    it.each([
      ['git push origin main --force', 'Bash(git push --force:*)'],
      ['sudo git push --force', 'Bash(git push --force:*)'],
      ['ls && rm -rf x', 'Bash(rm -rf:*)']
    ])('%s → deny (%s)', (command, rule) => {
      expect(hostPrecheck(bash(command), ctxWith())).toEqual({ kind: 'deny', rule })
    })

    it('falls back to the patterns when the ask carries no command', () => {
      const approval: PendingApproval = {
        requestId: 'per_1',
        toolName: 'shell',
        input: {},
        patterns: ['echo ok', 'git push origin main --force']
      }
      expect(hostPrecheck(approval, ctxWith())).toEqual({
        kind: 'deny',
        rule: 'Bash(git push --force:*)'
      })
    })

    it('an empty command string falls back to the patterns too', () => {
      const approval = bash('', ['rm -rf dist'])
      expect(hostPrecheck(approval, ctxWith())).toEqual({ kind: 'deny', rule: 'Bash(rm -rf:*)' })
    })
  })

  describe('1b: a user deny rule by glob', () => {
    const edit = (path: string): PendingApproval => ({
      requestId: 'per_e',
      toolUseId: 'c_e',
      toolName: 'edit',
      input: { filePath: path },
      patterns: [path]
    })
    const denyEdit = (opts: Parameters<typeof ctxWith>[0] = {}) =>
      ctxWith({ deny: [...DENY, 'Edit(secrets/**)'], ...opts })

    it('an edit a user Edit deny covers → deny, named by the compiled rule', () => {
      expect(hostPrecheck(edit('secrets/key.pem'), denyEdit())).toEqual({
        kind: 'deny',
        rule: 'edit(secrets/**)'
      })
      expect(hostPrecheck(edit('src/a.ts'), denyEdit())).toEqual({ kind: 'continue' })
    })

    it('a webfetch a user WebFetch deny covers → deny', () => {
      const fetch: PendingApproval = {
        requestId: 'per_w',
        toolUseId: 'c_w',
        toolName: 'webfetch',
        input: { url: 'https://evil.example/x' },
        patterns: ['https://evil.example/x']
      }
      const ctx = ctxWith({ deny: ['WebFetch(domain:evil.example)'] })
      expect(hostPrecheck(fetch, ctx)).toMatchObject({ kind: 'deny' })
    })

    it('comes before the ask rules, the session allows and plan mode', () => {
      const allows = new OpencodeSessionAllows()
      allows.add('edit', ['*'])
      const ctx = denyEdit({ ask: ['Edit(secrets/**)'], allows, mode: 'plan' })
      expect(hostPrecheck(edit('secrets/key.pem'), ctx)).toEqual({
        kind: 'deny',
        rule: 'edit(secrets/**)'
      })
    })

    it('a child ask too', () => {
      const childEdit = {
        ...edit('secrets/key.pem'),
        subagent: { sessionId: 's', parentToolUseId: 't' }
      }
      expect(hostPrecheck(childEdit, denyEdit())).toEqual({
        kind: 'deny',
        rule: 'edit(secrets/**)'
      })
    })

    it('a later user allow for the same pattern does not outrank the deny (deny tier is last)', () => {
      const ctx = denyEdit({ allow: ['Edit(secrets/public/**)'] })
      expect(hostPrecheck(edit('secrets/public/a.txt'), ctx)).toMatchObject({ kind: 'deny' })
    })
  })

  describe('§1 ask', () => {
    it('a spelling the glob misses is an ask hit, with the rule', () => {
      // `docker --context x run alpine` is caught server-side since the broad
      // globs (ADR-085 §3); a `.exe`-suffixed program is still only §1's.
      const command = 'docker.exe --context x run alpine'
      const ctx = ctxWith()
      // The glob (G9, including the broad globs) does not see it…
      expect(matchesUserAskRule(ctx.userRules, 'shell', [command], 'linux')).toBe(false)
      // …§1 does.
      expect(hostPrecheck(bash(command), ctx)).toEqual({
        kind: 'user-ask',
        rule: 'Bash(docker run:*)'
      })
    })
  })

  describe('user ask rule by glob (G9, any category)', () => {
    it('an edit on a path a user Edit ask rule matches → user-ask without a rule', () => {
      const approval: PendingApproval = {
        requestId: 'per_e',
        toolName: 'edit',
        input: { filePath: '/x/.env' },
        patterns: ['/x/.env']
      }
      expect(hostPrecheck(approval, ctxWith())).toEqual({ kind: 'user-ask' })
    })
  })

  describe('order: rules before the session-allow set', () => {
    it('deny beats a session allow', () => {
      const allows = new OpencodeSessionAllows()
      allows.add('shell', ['git push *'])
      expect(hostPrecheck(bash('git push --force x'), ctxWith({ allows }))).toEqual({
        kind: 'deny',
        rule: 'Bash(git push --force:*)'
      })
    })

    it('ask beats a session allow', () => {
      const allows = new OpencodeSessionAllows()
      allows.add('shell', ['docker run *', 'docker *'])
      expect(hostPrecheck(bash('docker --context x run alpine'), ctxWith({ allows }))).toEqual({
        kind: 'user-ask',
        rule: 'Bash(docker run:*)'
      })
    })

    it('a glob ask beats a session allow on `*`', () => {
      const allows = new OpencodeSessionAllows()
      allows.add('edit', ['*'])
      const approval: PendingApproval = {
        requestId: 'per_e',
        toolName: 'edit',
        input: {},
        patterns: ['/x/.env']
      }
      expect(hostPrecheck(approval, ctxWith({ allows }))).toEqual({ kind: 'user-ask' })
    })

    it('a session allow covers otherwise', () => {
      const allows = new OpencodeSessionAllows()
      allows.add('shell', ['git push *'])
      expect(hostPrecheck(bash('git push origin feat'), ctxWith({ allows }))).toEqual({
        kind: 'session-allow'
      })
    })

    it('a non-shell ask is covered by a stored `*`', () => {
      const allows = new OpencodeSessionAllows()
      allows.add('webfetch', ['*'])
      const approval: PendingApproval = {
        requestId: 'per_w',
        toolName: 'webfetch',
        input: { url: 'https://example.com' },
        patterns: ['https://example.com']
      }
      expect(hostPrecheck(approval, ctxWith({ allows }))).toEqual({ kind: 'session-allow' })
    })
  })

  describe('continue', () => {
    it('when nothing applies', () => {
      expect(hostPrecheck(bash('git status'), ctxWith())).toEqual({ kind: 'continue' })
    })

    it('a mention is no §1 deny hit, but rung 1b keeps the broad glob’s over-refusal', () => {
      // §1: `echo rm -rf` has no `rm` in a program position.
      expect(denyAskHit('echo rm -rf', { deny: DENY, ask: [] })).toBeUndefined()
      // The broad glob `* rm -rf*` matches it (ADR-085's accepted over-refusal).
      expect(hostPrecheck(bash('echo rm -rf'), ctxWith())).toEqual({
        kind: 'deny',
        rule: 'shell(* rm -rf*)'
      })
    })

    it('a non-shell ask with no patterns and no allows', () => {
      const approval: PendingApproval = { requestId: 'per_m', toolName: 'somemcp_tool', input: {} }
      expect(hostPrecheck(approval, ctxWith())).toEqual({ kind: 'continue' })
    })

    it('with no rules at all', () => {
      expect(hostPrecheck(bash('git push --force'), ctxWith({ deny: [], ask: [] }))).toEqual({
        kind: 'continue'
      })
    })
  })

  describe('never throws', () => {
    it('a hostile approval (input: null) → an answer, no exception', () => {
      const hostile = {
        requestId: 'per_h',
        toolName: 'shell',
        input: null,
        patterns: ['rm -rf /']
      } as unknown as PendingApproval
      const verdict = hostPrecheck(hostile, ctxWith())
      expect(['deny', 'user-ask', 'continue']).toContain(verdict.kind)
    })

    it('an internal failure → user-ask, reported to onError', () => {
      const errors: unknown[] = []
      const hostile = { requestId: 'per_h', input: {} } as unknown as PendingApproval
      const verdict = hostPrecheck(hostile, { ...ctxWith(), onError: (e) => errors.push(e) })
      expect(verdict).toEqual({ kind: 'user-ask' })
      expect(errors).toHaveLength(1)
    })

    it('a throwing onError does not escape', () => {
      const hostile = { requestId: 'per_h', input: {} } as unknown as PendingApproval
      expect(
        hostPrecheck(hostile, {
          ...ctxWith(),
          onError: () => {
            throw new Error('logger down')
          }
        })
      ).toEqual({ kind: 'user-ask' })
    })
  })
})

// ADR-085 S3b — owner ruling 7, "plan mode wins": the plan refusal and the
// plan-mode allow-rule rung are rungs of the one host ladder.
describe('ADR-085 S3b — hostPrecheck plan-mode rungs', () => {
  const ALLOW = ['Bash(git:*)', 'Bash(ls:*)', 'Edit', 'Task']
  const plan = (opts: Parameters<typeof ctxWith>[0] = {}) =>
    ctxWith({ allow: ALLOW, ...opts, mode: 'plan' })
  const edit: PendingApproval = {
    requestId: 'per_e',
    toolName: 'edit',
    input: { filePath: '/x/src/a.ts' },
    patterns: ['/x/src/a.ts']
  }
  const task = (subagent: string): PendingApproval => ({
    requestId: 'per_t',
    toolName: 'subagent',
    input: { agent: subagent },
    patterns: [subagent]
  })

  describe('plan-refuse', () => {
    it('an edit, even under an Edit allow', () => {
      expect(hostPrecheck(edit, plan())).toEqual({ kind: 'plan-refuse' })
    })

    it('the general subagent, even under a Task allow; explore is not refused', () => {
      expect(hostPrecheck(task('general'), plan())).toEqual({ kind: 'plan-refuse' })
      expect(hostPrecheck(task('explore'), plan())).toEqual({ kind: 'continue' })
    })

    it.each(['git commit -m x', 'mv a b', 'ls && touch f', 'git status > out.txt'])(
      'a command that is not plan-safe: %s',
      (command) => {
        expect(hostPrecheck(bash(command), plan())).toEqual({ kind: 'plan-refuse' })
      }
    )

    it('a shell ask with no command text at all (nothing to vouch for)', () => {
      const approval: PendingApproval = { requestId: 'per_b', toolName: 'shell', input: {} }
      expect(hostPrecheck(approval, plan())).toEqual({ kind: 'plan-refuse' })
    })

    it('deny comes before plan-refuse (the more specific reason)', () => {
      expect(hostPrecheck(bash('rm -rf dist'), plan())).toEqual({
        kind: 'deny',
        rule: 'Bash(rm -rf:*)'
      })
    })

    it('plan-refuse comes before a user ask rule (§1 and glob) and a session allow', () => {
      // §1 ask hit on a non-plan-safe command.
      expect(hostPrecheck(bash('docker run alpine'), plan())).toEqual({ kind: 'plan-refuse' })
      // A glob ask rule on the edit path.
      const envEdit: PendingApproval = { ...edit, patterns: ['/x/.env'] }
      expect(hostPrecheck(envEdit, plan())).toEqual({ kind: 'plan-refuse' })
      // A session allow covering the command / the edit.
      const allows = new OpencodeSessionAllows()
      allows.add('shell', ['git commit *'])
      allows.add('edit', ['*'])
      expect(hostPrecheck(bash('git commit -m x'), plan({ allows }))).toEqual({
        kind: 'plan-refuse'
      })
      expect(hostPrecheck(edit, plan({ allows }))).toEqual({ kind: 'plan-refuse' })
    })

    it('planModeRefusesAsk — the shared predicate (a non-mutating category is never refused)', () => {
      expect(planModeRefusesAsk({ toolName: 'edit' }, undefined)).toBe(true)
      expect(planModeRefusesAsk({ toolName: 'subagent', patterns: ['general'] }, undefined)).toBe(
        true
      )
      expect(planModeRefusesAsk({ toolName: 'subagent', patterns: ['explore'] }, undefined)).toBe(
        false
      )
      expect(planModeRefusesAsk({ toolName: 'shell' }, undefined)).toBe(true)
      expect(planModeRefusesAsk({ toolName: 'shell' }, 'git commit -m x')).toBe(true)
      expect(planModeRefusesAsk({ toolName: 'shell' }, 'git status')).toBe(false)
      expect(planModeRefusesAsk({ toolName: 'webfetch', patterns: ['x'] }, undefined)).toBe(false)
      expect(planModeRefusesAsk({ toolName: 'read', patterns: ['x'] }, undefined)).toBe(false)
    })
  })

  describe('allow-rule (plan mode only)', () => {
    it('a plan-safe command a Bash allow covers → allow-rule with the rule', () => {
      expect(hostPrecheck(bash('git status'), plan())).toEqual({
        kind: 'allow-rule',
        rule: 'Bash(git:*)'
      })
    })

    it('a two-segment `git status && ls` covered by two rules → the first segment’s rule', () => {
      expect(hostPrecheck(bash('git status && ls'), plan())).toEqual({
        kind: 'allow-rule',
        rule: 'Bash(git:*)'
      })
      // One segment uncovered → no allow-rule (the card).
      expect(hostPrecheck(bash('git status && ls'), plan({ allow: ['Bash(git:*)'] }))).toEqual({
        kind: 'continue'
      })
    })

    it('a plan-safe command with no covering allow → continue (the card)', () => {
      expect(hostPrecheck(bash('git status'), plan({ allow: [] }))).toEqual({ kind: 'continue' })
      expect(hostPrecheck(bash('cat README.md'), plan())).toEqual({ kind: 'continue' })
    })

    it('a session allow still answers before the allow rule', () => {
      const allows = new OpencodeSessionAllows()
      allows.add('shell', ['git status *'])
      expect(hostPrecheck(bash('git status'), plan({ allows }))).toEqual({
        kind: 'session-allow'
      })
    })

    it('a §1 ask rule on a plan-safe command still sends it to the human', () => {
      expect(hostPrecheck(bash('git status'), plan({ ask: ['Bash(git status:*)'] }))).toEqual({
        kind: 'user-ask',
        rule: 'Bash(git status:*)'
      })
    })

    it.each(['default', 'acceptEdits', 'auto', 'full'])(
      'never in %s mode with the same rules (allows are server-side or stripped there)',
      (mode) => {
        const ctx = ctxWith({ allow: ALLOW, mode })
        expect(hostPrecheck(bash('git status'), ctx)).toEqual({ kind: 'continue' })
        expect(hostPrecheck(bash('git commit -m x'), ctx)).toEqual({ kind: 'continue' })
        expect(hostPrecheck(edit, ctx)).toEqual({ kind: 'continue' })
      }
    )
  })

  describe('continue', () => {
    it('a non-mutating, non-shell ask with nothing matching', () => {
      const approval: PendingApproval = {
        requestId: 'per_w',
        toolName: 'webfetch',
        input: { url: 'https://example.com' },
        patterns: ['https://example.com']
      }
      expect(hostPrecheck(approval, plan())).toEqual({ kind: 'continue' })
    })
  })

  describe('fail toward the human', () => {
    it('an internal failure in plan mode answers user-ask, never allow-rule', () => {
      const errors: unknown[] = []
      const ctx = plan()
      // The allow tier is read only on the allow-rule rung; make reading it throw.
      const rules = {
        deny: ctx.rules.deny,
        ask: ctx.rules.ask,
        get allow(): readonly string[] {
          throw new Error('rules unavailable')
        }
      }
      const verdict = hostPrecheck(bash('git status'), {
        ...ctx,
        rules,
        onError: (e) => errors.push(e)
      })
      expect(verdict).toEqual({ kind: 'user-ask' })
      expect(errors).toHaveLength(1)
    })
  })
})

// ADR-085 S3b (F3) — with the session cwd the plan line is the union of pi's
// plan-safe list and ADR-084's read-only checker (opencode on Windows runs pwsh).
describe('ADR-085 S3b — hostPrecheck plan mode reads the union oracle', () => {
  const win = (opts: Parameters<typeof ctxWith>[0] = {}) =>
    ctxWith({ ...opts, mode: 'plan', cwd: 'D:/repo', platform: 'win32' })

  it('pwsh research and a quote-aware grep are not refused; mutations and cd-chains still are', () => {
    for (const command of [
      'Get-ChildItem -Path src',
      'Get-Content README.md',
      'Select-String -Path README.md -Pattern x',
      'grep "a && b" README.md',
      'cat README.md',
      'git status'
    ]) {
      expect(hostPrecheck(bash(command), win()), command).toEqual({ kind: 'continue' })
    }
    for (const command of [
      'git commit -m x',
      'Set-Content x y',
      'mkdir x',
      'cd src && ls',
      'echo hi > f'
    ]) {
      expect(hostPrecheck(bash(command), win()), command).toEqual({ kind: 'plan-refuse' })
    }
  })

  it('linux: `grep "a && b" README.md` is not refused', () => {
    const ctx = ctxWith({ mode: 'plan', cwd: '/repo', platform: 'linux' })
    expect(hostPrecheck(bash('grep "a && b" README.md'), ctx)).toEqual({ kind: 'continue' })
  })

  it('a user ASK rule on a checker-only read-only command → user-ask, not plan-refuse (F4)', () => {
    expect(
      hostPrecheck(bash('Get-Content README.md'), win({ ask: ['Bash(Get-Content:*)'] }))
    ).toEqual({ kind: 'user-ask', rule: 'Bash(Get-Content:*)' })
  })

  it('a Bash(Get-Content:*) allow → allow-rule; no allow → continue (the card)', () => {
    expect(
      hostPrecheck(bash('Get-Content README.md'), win({ allow: ['Bash(Get-Content:*)'] }))
    ).toEqual({ kind: 'allow-rule', rule: 'Bash(Get-Content:*)' })
    expect(hostPrecheck(bash('Get-Content README.md'), win())).toEqual({ kind: 'continue' })
  })

  it('without a cwd only the list decides: `Get-Content README.md` is refused; with it, not', () => {
    expect(hostPrecheck(bash('Get-Content README.md'), ctxWith({ mode: 'plan' }))).toEqual({
      kind: 'plan-refuse'
    })
    expect(
      planModeRefusesAsk({ toolName: 'shell' }, 'Get-Content README.md', {
        cwd: 'D:/repo',
        additionalDirectories: [],
        rules: { deny: [] },
        platform: 'win32',
        realpath: () => undefined
      })
    ).toBe(false)
  })
})
