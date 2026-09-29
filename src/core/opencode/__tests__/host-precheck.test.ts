import { describe, it, expect } from 'vitest'
import { hostPrecheck, type HostPrecheckContext } from '../host-precheck'
import { OpencodeSessionAllows } from '../session-allows'
import { compileClaudeRulesToOpencode } from '../permission-compiler'
import { matchesUserAskRule } from '../wildcard'
import type { PendingApproval } from '../../../shared/types'

// Synthetic rules only.
const DENY = ['Bash(git push --force:*)', 'Bash(rm -rf:*)']
const ASK = ['Bash(docker run:*)', 'Edit(*.env)']

function ctxWith(
  opts: { deny?: string[]; ask?: string[]; allows?: OpencodeSessionAllows } = {}
): HostPrecheckContext {
  const deny = opts.deny ?? DENY
  const ask = opts.ask ?? ASK
  return {
    rules: { deny, ask },
    userRules: compileClaudeRulesToOpencode({
      allow: [],
      deny,
      ask,
      additionalDirectories: [],
      defaultMode: undefined
    }),
    sessionAllows: opts.allows ?? new OpencodeSessionAllows(),
    platform: 'linux'
  }
}

/** A shell ask as the mapper builds it: `metadata.command` (or the tool part's input) + per-statement patterns. */
function bash(command: string, patterns: string[] = [command]): PendingApproval {
  return { requestId: 'per_1', toolUseId: 'c1', toolName: 'bash', input: { command }, patterns }
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
        toolName: 'bash',
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

  describe('§1 ask', () => {
    it('a global option the glob misses is an ask hit, with the rule', () => {
      const command = 'docker --context x run alpine'
      const ctx = ctxWith()
      // The glob (today's G9) does not see it…
      expect(matchesUserAskRule(ctx.userRules, 'bash', [command], 'linux')).toBe(false)
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
      allows.add('bash', ['git push *'])
      expect(hostPrecheck(bash('git push --force x'), ctxWith({ allows }))).toEqual({
        kind: 'deny',
        rule: 'Bash(git push --force:*)'
      })
    })

    it('ask beats a session allow', () => {
      const allows = new OpencodeSessionAllows()
      allows.add('bash', ['docker run *', 'docker *'])
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
      allows.add('bash', ['git push *'])
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
      // A mention is not a program position: `echo rm -rf` is no deny hit.
      expect(hostPrecheck(bash('echo rm -rf'), ctxWith())).toEqual({ kind: 'continue' })
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
        toolName: 'bash',
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
