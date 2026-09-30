/**
 * @vitest-environment node
 *
 * ADR-085 §4 — a narrow user allow rule lets an auto-mode call skip the judge.
 *
 * A table over synthetic rules (never a real user's): which rules are usable
 * at all (cli.js `ZIe` parity, `classifyAllShell`, the dispatch tool, the
 * carve-out), then shell coverage with its three safety checks (launchers must
 * be named, write targets in scope, Read deny rules on reader paths), then the
 * non-shell tools. Paths are synthetic (`/work/repo`, `D:\work\repo`);
 * `realpath` is injected.
 */
import { describe, expect, it } from 'vitest'
import {
  allowRuleSkip,
  usableAllowRules,
  type AllowSkipAction,
  type AllowSkipScope,
  type AllowSkipVerdict
} from '../allow-rule-skip'
import { SHELL_RULES_MAX_ANALYSED_LENGTH } from '../../permissions/shell-rules'

const FORCE_PUSH = 'Bash(git push --force:*)'

function scope(
  allow: string[],
  opts: { deny?: string[]; ask?: string[] } & Partial<Omit<AllowSkipScope, 'rules'>> = {}
): AllowSkipScope {
  const { deny = [], ask = [], ...rest } = opts
  return {
    cwd: '/work/repo',
    additionalDirectories: [],
    rules: { allow, deny, ask },
    classifyAllShell: false,
    platform: 'linux',
    // Every path exists and is itself (no symlinks).
    realpath: (p) => p,
    ...rest
  }
}

const shell = (command: string, workdir?: string): AllowSkipAction => ({
  kind: 'shell',
  command,
  ...(workdir !== undefined ? { workdir } : {})
})

/** The verdict's decision in one comparable string: `allow <rule>` or the refusal reason. */
function outcome(v: AllowSkipVerdict): string {
  return v.allow ? `allow ${v.rule}` : v.reason
}

describe('usableAllowRules', () => {
  const usable = (
    rule: string,
    opts: { deny?: string[]; ask?: string[]; classifyAllShell?: boolean } = {}
  ): string | true => {
    const r = usableAllowRules(
      { allow: [rule], deny: opts.deny ?? [], ask: opts.ask ?? [] },
      { classifyAllShell: opts.classifyAllShell ?? false }
    )
    return r.usable.includes(rule) ? true : (r.unusable[0]?.reason ?? 'missing')
  }

  it('Bash(git:*) is usable with no deny/ask rule; carved out by a narrower deny or ask', () => {
    expect(usable('Bash(git:*)')).toBe(true)
    expect(usable('Bash(git:*)', { deny: [FORCE_PUSH] })).toBe(`rule:carved-out ${FORCE_PUSH}`)
    expect(usable('Bash(git:*)', { ask: ['Bash(git push:*)'] })).toBe(
      'rule:carved-out Bash(git push:*)'
    )
  })

  it('Bash(git status:*) is not carved out by those', () => {
    expect(usable('Bash(git status:*)', { deny: [FORCE_PUSH], ask: ['Bash(git push:*)'] })).toBe(
      true
    )
  })

  it.each(['Bash(npm run:*)', 'Bash(python:*)', 'Bash(sudo:*)', 'Bash', 'Agent', 'Task(x)'])(
    '%s is classifier-bypassing (cli.js ZIe) → unusable',
    (rule) => {
      expect(usable(rule)).toBe('rule:classifier-bypassing')
    }
  )

  it('the python -m dotted.module exception survives', () => {
    expect(usable('Bash(python -m mypkg.cli:*)')).toBe(true)
  })

  it('classifyAllShell makes every Bash (and PowerShell) rule unusable, and nothing else', () => {
    for (const rule of ['Bash(git status:*)', 'Bash(ls)', 'PowerShell(Get-ChildItem:*)']) {
      expect(usable(rule, { classifyAllShell: true })).toBe('rule:classify-all-shell')
    }
    expect(usable('WebFetch(domain:example.com)', { classifyAllShell: true })).toBe(true)
    expect(usable('mcp__lsphub', { classifyAllShell: true })).toBe(true)
  })

  it.each([
    'mcp__claude-ui-collab',
    'mcp__claude-ui-collab__*',
    'mcp__claude-ui-collab__dispatch_agent',
    'mcp__claudeui',
    'mcp__claudeui__dispatch_agent'
  ])('%s would cover the dispatch tool → unusable', (rule) => {
    expect(usable(rule)).toBe('rule:dispatch-tool')
  })

  it('non-Bash rules are never carved out', () => {
    expect(usable('WebFetch(domain:example.com)', { deny: [FORCE_PUSH, 'Bash(rm:*)'] })).toBe(true)
    expect(usable('mcp__lsphub__*', { ask: ['Bash(git:*)'] })).toBe(true)
  })

  it('keeps rule order', () => {
    const r = usableAllowRules(
      { allow: ['Bash(ls:*)', 'Bash', 'WebSearch', 'Bash(git:*)'] },
      { classifyAllShell: false }
    )
    expect(r.usable).toEqual(['Bash(ls:*)', 'WebSearch', 'Bash(git:*)'])
    expect(r.unusable).toEqual([{ rule: 'Bash', reason: 'rule:classifier-bypassing' }])
  })

  it('never throws on malformed rules: nothing usable', () => {
    const opts = { classifyAllShell: false }
    const nothing = { usable: [], unusable: [] }
    expect(usableAllowRules(['Bash(git:*)'] as never, opts)).toEqual(nothing)
    expect(usableAllowRules(null as never, opts)).toEqual(nothing)
  })
})

describe('allowRuleSkip — shell', () => {
  it.each<[string, string[], { deny?: string[]; ask?: string[]; workdir?: string }, string]>([
    // Coverage.
    ['git status', ['Bash(git:*)'], {}, 'allow Bash(git:*)'],
    ['ls', ['Bash(git:*)'], {}, 'coverage:uncovered'],
    ['ls', [], {}, 'rule:none-usable'],
    ['git status', ['Bash(git:*)'], { deny: [FORCE_PUSH] }, `rule:carved-out ${FORCE_PUSH}`],
    // The deny/ask matcher first (defensive: the hosts ran it already).
    [
      'git push origin main --force',
      ['Bash(git:*)'],
      { deny: [FORCE_PUSH] },
      `hit:deny ${FORCE_PUSH}`
    ],
    ['git -C . push --force', ['Bash(git:*)'], { deny: [FORCE_PUSH] }, `hit:deny ${FORCE_PUSH}`],
    [
      'docker --context x run alpine',
      ['Bash(docker ps:*)'],
      { ask: ['Bash(docker run:*)'] },
      'hit:ask Bash(docker run:*)'
    ],
    // What ADR-084's strict lexer refuses is never covered.
    ['rm -rf $HOME', ['Bash(rm:*)'], {}, 'coverage:uncovered'],
    ['git log > out', ['Bash(git:*)'], {}, 'coverage:uncovered'],
    [
      `git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)"`,
      ['Bash(git:*)', 'Bash(cat:*)'],
      {},
      'coverage:uncovered'
    ],
    // (a) Launchers: the rule must NAME what the launcher runs.
    ['bun run test --watch', ['Bash(bun run test:*)'], {}, 'allow Bash(bun run test:*)'],
    ['bun run test --watch', ['Bash(bun:*)'], {}, 'launcher:unnamed bun'],
    ['bun run test', ['Bash(bun run test)'], {}, 'allow Bash(bun run test)'],
    ['npm exec -- git push --force', ['Bash(npm:*)'], {}, 'launcher:unnamed npm'],
    // A global option's VALUE must not hide the `exec` from the check.
    ['npm --prefix . exec -- git push --force', ['Bash(npm:*)'], {}, 'launcher:unnamed npm'],
    ['bun --cwd . x cowsay', ['Bash(bun:*)'], {}, 'launcher:unnamed bun'],
    ['npx prettier --write src', ['Bash(npx prettier:*)'], {}, 'allow Bash(npx prettier:*)'],
    ['uv run pytest', ['Bash(uv run:*)'], {}, 'launcher:unnamed uv'],
    ['sudo bun run test', ['Bash(sudo bun run test:*)'], {}, 'allow Bash(sudo bun run test:*)'],
    ['git -c core.pager=less log', ['Bash(git:*)'], {}, 'launcher:git'],
    ['xargs git status', ['Bash(xargs git:*)'], {}, 'launcher:xargs'],
    // `sh -c …` rules are ZIe-stripped, and a shell never names what it runs.
    ['sh -c "ls"', ['Bash(sh -c ls:*)'], {}, 'rule:classifier-bypassing'],
    ['node -e x', ['Bash(node -e x)'], {}, 'allow Bash(node -e x)'],
    // (b) Write targets must resolve inside the workspace.
    ['git status; rm -rf /', ['Bash(git:*)', 'Bash(rm:*)'], {}, 'write:path:out-of-scope'],
    ['rm -rf dist/*', ['Bash(rm:*)'], {}, 'allow Bash(rm:*)'],
    ['rm -rf ..', ['Bash(rm:*)'], {}, 'write:path:out-of-scope'],
    ['rm -rf ~', ['Bash(rm:*)'], {}, 'write:path:special ~^'],
    ['rm -rf .git', ['Bash(rm:*)'], {}, 'write:path:sensitive .git'],
    ['rm -- -rf', ['Bash(rm:*)'], {}, 'allow Bash(rm:*)'],
    ['sudo rm -rf /', ['Bash(sudo rm:*)'], {}, 'write:path:out-of-scope'],
    ['timeout 5 rm -rf ..', ['Bash(timeout 5 rm:*)'], {}, 'write:path:out-of-scope'],
    ['cp --target-directory=/etc x', ['Bash(cp:*)'], {}, 'write:path:out-of-scope'],
    ['mkdir -p build/out', ['Bash(mkdir:*)'], {}, 'allow Bash(mkdir:*)'],
    ['find . -name x -delete', ['Bash(find:*)'], {}, 'allow Bash(find:*)'],
    ['find .. -delete', ['Bash(find:*)'], {}, 'write:path:out-of-scope'],
    ['find -L .. -delete', ['Bash(find:*)'], {}, 'write:path:out-of-scope'],
    ['find .. -name x', ['Bash(find:*)'], {}, 'allow Bash(find:*)'],
    ['sed -i s/a/b/ README.md', ['Bash(sed:*)'], {}, 'allow Bash(sed:*)'],
    ['sed -i s/a/b/ ../x', ['Bash(sed:*)'], {}, 'write:path:out-of-scope'],
    ['sed -i -e s/a/b/ ../x', ['Bash(sed:*)'], {}, 'write:path:out-of-scope'],
    // No `i` flag: not a write, so no write check.
    ['sed -n 1p ../README.md', ['Bash(sed:*)'], {}, 'allow Bash(sed:*)'],
    ['tee ../out', ['Bash(tee:*)'], {}, 'write:path:out-of-scope'],
    // workdir: must be in scope for a write check; a reader does not care.
    ['rm x', ['Bash(rm:*)'], { workdir: 'sub' }, 'allow Bash(rm:*)'],
    ['rm x', ['Bash(rm:*)'], { workdir: '/elsewhere' }, 'write:workdir path:out-of-scope'],
    ['git status', ['Bash(git:*)'], { workdir: '/elsewhere' }, 'allow Bash(git:*)'],
    [
      'cat x',
      ['Bash(cat:*)'],
      { workdir: '/elsewhere', deny: ['Read(.env)'] },
      'allow Bash(cat:*)'
    ],
    // (c) Readers: no scope / sensitive check — cli.js parity: an allow rule is
    // the user's consent to read — but the user's Read deny rules bind.
    ['cat README.md', ['Bash(cat:*)'], {}, 'allow Bash(cat:*)'],
    ['cat .env', ['Bash(cat:*)'], {}, 'allow Bash(cat:*)'],
    ['cat ../other/notes.txt', ['Bash(cat:*)'], {}, 'allow Bash(cat:*)'],
    ['cat .env', ['Bash(cat:*)'], { deny: ['Read(.env)'] }, 'read-deny:Read(.env)'],
    ['cat .env', ['Bash(cat:*)'], { deny: ['Read(//**/.env)'] }, 'read-deny:Read(//**/.env)'],
    ['cat .env.', ['Bash(cat:*)'], { deny: ['Read(.env)'] }, 'read-deny:Read(.env)'],
    [
      'cat .env',
      ['Bash(cat:*)'],
      { workdir: '/elsewhere', deny: ['Read(.env)'] },
      'read-deny:Read(.env)'
    ],
    [
      'cat ~/.ssh/id_rsa',
      ['Bash(cat:*)'],
      { deny: ['Read(~/.ssh/**)'] },
      'read-deny:Read(~/.ssh/**)'
    ],
    ['cat *', ['Bash(cat:*)'], { deny: ['Read(.env)'] }, 'read-deny:glob'],
    ['cat *', ['Bash(cat:*)'], {}, 'allow Bash(cat:*)'],
    ['grep foo .env', ['Bash(grep:*)'], { deny: ['Read(.env)'] }, 'read-deny:Read(.env)'],
    ['grep -e foo .env', ['Bash(grep:*)'], { deny: ['Read(.env)'] }, 'read-deny:Read(.env)'],
    ['grep -f .env src', ['Bash(grep:*)'], { deny: ['Read(.env)'] }, 'read-deny:Read(.env)'],
    // The pattern is not a path: a regex with `*` is not a glob refusal.
    ["grep 'a.*b' src/x.ts", ['Bash(grep:*)'], { deny: ['Read(.env)'] }, 'allow Bash(grep:*)'],
    ['rg needle -g .env', ['Bash(rg:*)'], { deny: ['Read(.env)'] }, 'read-deny:Read(.env)'],
    ['head -n 5 .env', ['Bash(head:*)'], { deny: ['Read(.env)'] }, 'read-deny:Read(.env)']
  ])('%s under %j %j → %s', (command, allow, opts, expected) => {
    const { workdir, ...rules } = opts
    expect(outcome(allowRuleSkip(shell(command, workdir), scope(allow, rules)))).toBe(expected)
  })

  it('a later rule that names the launched program wins over an earlier broad one', () => {
    const v = allowRuleSkip(shell('bun run test'), scope(['Bash(bun:*)', 'Bash(bun run test:*)']))
    expect(v).toEqual({
      allow: true,
      rule: 'Bash(bun run test:*)',
      rules: ['Bash(bun run test:*)'],
      summary: 'bun run test'
    })
  })

  it('one rule per segment, deduped in order; the summary is the collapsed command', () => {
    expect(
      allowRuleSkip(
        shell('git status  &&  git log && ls src'),
        scope(['Bash(ls:*)', 'Bash(git:*)'])
      )
    ).toEqual({
      allow: true,
      rule: 'Bash(git:*)',
      rules: ['Bash(git:*)', 'Bash(ls:*)'],
      summary: 'git status && git log && ls src'
    })
  })

  it('classifyAllShell: no Bash rule skips', () => {
    expect(
      outcome(
        allowRuleSkip(shell('git status'), scope(['Bash(git:*)'], { classifyAllShell: true }))
      )
    ).toBe('rule:classify-all-shell')
  })

  it('an empty command is no input; a command past the S1 cap is never covered', () => {
    expect(outcome(allowRuleSkip(shell('  '), scope(['Bash(git:*)'])))).toBe('input:no-command')
    const long = `git log ${'a'.repeat(SHELL_RULES_MAX_ANALYSED_LENGTH)}`
    expect(outcome(allowRuleSkip(shell(long), scope(['Bash(git:*)'])))).toBe('coverage:uncovered')
  })

  it('never throws: a throwing realpath refuses a write, never allows it', () => {
    const boom = (): never => {
      throw new Error('boom')
    }
    const v = allowRuleSkip(shell('rm x'), scope(['Bash(rm:*)'], { realpath: boom }))
    expect(v.allow).toBe(false)
    expect(outcome(v)).toMatch(/^(write:|internal)/)
  })

  it('never throws on a malformed action or scope', () => {
    expect(
      allowRuleSkip({ kind: 'nope' } as unknown as AllowSkipAction, scope(['Bash(git:*)']))
    ).toEqual({ allow: false, reason: 'internal' })
    expect(
      allowRuleSkip(shell('git status'), { ...scope([]), rules: null } as unknown as AllowSkipScope)
    ).toEqual({ allow: false, reason: 'internal' })
  })
})

describe('allowRuleSkip — shell, destructive git subcommands need a rule that names them', () => {
  // No deny/ask rules: `Bash(git:*)` is usable, so only the naming check decides.
  const G = ['Bash(git:*)']

  it.each<[string, string[], string]>([
    // Every destructive shape under `Bash(git:*)` → the judge.
    ['git reset --hard origin/main', G, 'git:unnamed reset'],
    ['git -C . reset --hard', G, 'git:unnamed reset'],
    ['git clean -fdx', G, 'git:unnamed clean'],
    ['git clean --force', G, 'git:unnamed clean'],
    ['git checkout -- .', G, 'git:unnamed checkout'],
    ['git checkout HEAD -- .', G, 'git:unnamed checkout'],
    ['git checkout HEAD file', G, 'git:unnamed checkout'],
    ['git checkout -f main', G, 'git:unnamed checkout'],
    ['git restore file', G, 'git:unnamed restore'],
    ['git switch -f main', G, 'git:unnamed switch'],
    ['git switch --discard-changes main', G, 'git:unnamed switch'],
    ['git branch -D x', G, 'git:unnamed branch'],
    ['git branch -fd x', G, 'git:unnamed branch'],
    ['git branch --delete --force x', G, 'git:unnamed branch'],
    ['git stash drop', G, 'git:unnamed stash'],
    ['git stash clear', G, 'git:unnamed stash'],
    ['git push --force', G, 'git:unnamed push'],
    ['git push -f origin main', G, 'git:unnamed push'],
    ['git push origin main --force-with-lease', G, 'git:unnamed push'],
    ['git push --force-if-includes', G, 'git:unnamed push'],
    ['git push origin --delete old', G, 'git:unnamed push'],
    ['git push -d origin old', G, 'git:unnamed push'],
    ['git push origin +main', G, 'git:unnamed push'],
    ['git push origin :old', G, 'git:unnamed push'],
    ['git push --mirror', G, 'git:unnamed push'],
    ['git rebase main', G, 'git:unnamed rebase'],
    ['git filter-branch', G, 'git:unnamed filter-branch'],
    ['git update-ref -d refs/heads/x', G, 'git:unnamed update-ref'],
    ['git reflog expire --expire=now --all', G, 'git:unnamed reflog'],
    ['git reflog delete x', G, 'git:unnamed reflog'],
    ['git gc --prune=now', G, 'git:unnamed gc'],
    ['git worktree remove -f w', G, 'git:unnamed worktree'],
    ['git branch -M main', G, 'git:unnamed branch'],
    ['git branch -C a b', G, 'git:unnamed branch'],
    ['git checkout -B feat', G, 'git:unnamed checkout'],
    ['git tag -d v1', G, 'git:unnamed tag'],
    ['git tag -dv v1', G, 'git:unnamed tag'],
    ['git tag --delete v1', G, 'git:unnamed tag'],
    ['git remote remove origin', G, 'git:unnamed remote'],
    ['git remote rm origin', G, 'git:unnamed remote'],
    ['git submodule deinit -f sub', G, 'git:unnamed submodule'],
    ['git submodule deinit --all', G, 'git:unnamed submodule'],
    ['git status && git reset --hard', G, 'git:unnamed reset'],
    // Past a wrapper, counted from the segment start.
    ['timeout 5 git reset --hard', ['Bash(timeout 5 git:*)'], 'git:unnamed reset'],
    [
      'timeout 5 git reset --hard',
      ['Bash(timeout 5 git reset:*)'],
      'allow Bash(timeout 5 git reset:*)'
    ],
    // The launcher check still comes first.
    ['git -c core.pager=less reset --hard', G, 'launcher:git'],
    // A rule that NAMES the subcommand skips.
    [
      'git reset --hard origin/main',
      ['Bash(git reset --hard:*)'],
      'allow Bash(git reset --hard:*)'
    ],
    ['git clean -fdx', ['Bash(git clean:*)'], 'allow Bash(git clean:*)'],
    ['git push --force', ['Bash(git push:*)'], 'allow Bash(git push:*)'],
    ['git -C . reset --hard', ['Bash(git -C . reset:*)'], 'allow Bash(git -C . reset:*)'],
    ['git reset --hard', ['Bash(git reset --hard)'], 'allow Bash(git reset --hard)'],
    ['git reset --hard', ['Bash(git:*)', 'Bash(git reset:*)'], 'allow Bash(git reset:*)'],
    ['git tag -d v1', ['Bash(git tag:*)'], 'allow Bash(git tag:*)'],
    ['git remote remove origin', ['Bash(git remote:*)'], 'allow Bash(git remote:*)'],
    // Non-destructive controls under `Bash(git:*)`.
    ['git reset file', G, 'allow Bash(git:*)'],
    ['git reset --soft HEAD~1', G, 'allow Bash(git:*)'],
    ['git clean -n', G, 'allow Bash(git:*)'],
    ['git checkout main', G, 'allow Bash(git:*)'],
    // `-b <name> <start>` names a new branch, not a path.
    ['git checkout -b feat origin/main', G, 'allow Bash(git:*)'],
    ['git switch main', G, 'allow Bash(git:*)'],
    ['git branch -d x', G, 'allow Bash(git:*)'],
    ['git stash', G, 'allow Bash(git:*)'],
    ['git stash list', G, 'allow Bash(git:*)'],
    ['git push origin main', G, 'allow Bash(git:*)'],
    ['git push -u origin main', G, 'allow Bash(git:*)'],
    ['git gc', G, 'allow Bash(git:*)'],
    ['git worktree list', G, 'allow Bash(git:*)'],
    ['git reflog show', G, 'allow Bash(git:*)'],
    // `-m` / `-c` (no force) are not destructive; neither is an unforced deinit.
    ['git branch -m old new', G, 'allow Bash(git:*)'],
    ['git branch -c a b', G, 'allow Bash(git:*)'],
    ['git tag v1', G, 'allow Bash(git:*)'],
    ['git tag -l', G, 'allow Bash(git:*)'],
    ['git remote -v', G, 'allow Bash(git:*)'],
    ['git remote add origin url', G, 'allow Bash(git:*)'],
    ['git submodule update --init', G, 'allow Bash(git:*)'],
    ['git submodule deinit sub', G, 'allow Bash(git:*)']
  ])('%s under %j → %s', (command, allow, expected) => {
    expect(outcome(allowRuleSkip(shell(command), scope(allow)))).toBe(expected)
  })

  it('one named rule per segment', () => {
    expect(
      allowRuleSkip(
        shell('git status && git reset --hard'),
        scope(['Bash(git status:*)', 'Bash(git reset --hard:*)'])
      )
    ).toMatchObject({ allow: true, rules: ['Bash(git status:*)', 'Bash(git reset --hard:*)'] })
  })
})

describe('allowRuleSkip — shell, write targets: scope roots, secret and agent-control names', () => {
  const RM = ['Bash(rm:*)']
  const FIND = ['Bash(find:*)']
  const MV = ['Bash(mv:*)']
  const MOVE_ITEM = ['Bash(Move-Item:*)']
  // An additional directory is a scope root too.
  const extra = { additionalDirectories: ['/work/extra'] }

  it.each<[string, string[], { workdir?: string }, string]>([
    // (a) A scope root (or an ancestor of one, or the effective cwd) is never a delete target.
    ['rm -rf .', RM, {}, 'write:path:scope-root'],
    ['rm -rf ./', RM, {}, 'write:path:scope-root'],
    ['rm -rf /work/repo', RM, {}, 'write:path:scope-root'],
    ['rm -rf /work/extra', RM, {}, 'write:path:scope-root'],
    ['rm -rf sub/..', RM, {}, 'write:path:scope-root'],
    ['rm -rf .', RM, { workdir: 'sub' }, 'write:path:scope-root'],
    ['rm -rf ..', RM, { workdir: 'sub/deeper' }, 'write:path:scope-root'],
    ['rmdir .', ['Bash(rmdir:*)'], {}, 'write:path:scope-root'],
    ['find . -delete', FIND, {}, 'write:path:scope-root'],
    ['find -delete', FIND, {}, 'write:path:scope-root'],
    ['find . -type f -delete', FIND, {}, 'write:path:scope-root'],
    // A name filter narrows only before `-delete`, and with no operator that widens it.
    ["find . -delete -name '*.pyc'", FIND, {}, 'write:path:scope-root'],
    ["find . ! -name '*.pyc' -delete", FIND, {}, 'write:path:scope-root'],
    ["find . -name '*.pyc' -o -delete", FIND, {}, 'write:path:scope-root'],
    // (b) A glob with a literal character must not match a secret-shaped (or
    // agent-control) name; a glob-only one under a scope root is a wipe.
    ['rm -rf .*', RM, {}, 'write:path:pattern-may-match-sensitive .*'],
    ['rm -rf .gi*', RM, {}, 'write:path:pattern-may-match-sensitive .gi*'],
    ['rm -rf .ss?', RM, {}, 'write:path:pattern-may-match-sensitive .ss?'],
    ['rm -rf sub/.*', RM, {}, 'write:path:pattern-may-match-sensitive .*'],
    ['cp .en* x', ['Bash(cp:*)'], {}, 'write:path:pattern-may-match-sensitive .en*'],
    ['rm -rf .cl*', RM, {}, 'write:path:pattern-may-match-agent-control .cl*'],
    ['rm *.md', RM, {}, 'write:path:pattern-may-match-agent-control *.md'],
    ['rm -rf *', RM, {}, 'write:path:scope-root-glob'],
    ['rm -rf ./*', RM, {}, 'write:path:scope-root-glob'],
    ['rm -rf */', RM, {}, 'write:path:scope-root-glob'],
    ['rm -rf ../*', RM, { workdir: 'sub' }, 'write:path:scope-root-glob'],
    ['rm -rf /work/repo/*', RM, {}, 'write:path:scope-root-glob'],
    // Only a glob-only LAST component wipes its parent.
    ['rm -rf */node_modules', RM, {}, 'allow Bash(rm:*)'],
    ['rm -rf */*', RM, {}, 'allow Bash(rm:*)'],
    // A moved SOURCE leaves its place: a delete target. The destination is a write.
    ['mv . x', MV, {}, 'write:path:scope-root'],
    ['mv /work/repo /work/extra/repo', MV, {}, 'write:path:scope-root'],
    ['mv .. x', MV, { workdir: 'sub' }, 'write:path:scope-root'],
    ['mv * sub', MV, {}, 'write:path:scope-root-glob'],
    ['mv ./* sub', MV, {}, 'write:path:scope-root-glob'],
    ['mv -t sub .', MV, {}, 'write:path:scope-root'],
    ['mv --target-directory=sub .', MV, {}, 'write:path:scope-root'],
    ['Move-Item -Path . -Destination x', MOVE_ITEM, {}, 'write:path:scope-root'],
    ['Move-Item -Destination:x .', MOVE_ITEM, {}, 'write:path:scope-root'],
    ['mv x .', MV, {}, 'allow Bash(mv:*)'],
    ['mv -f x .', MV, {}, 'allow Bash(mv:*)'],
    ['mv a b', MV, {}, 'allow Bash(mv:*)'],
    ['mv src/* dist/', MV, {}, 'allow Bash(mv:*)'],
    ['mv -t . a b', MV, {}, 'allow Bash(mv:*)'],
    ['mv --target-directory=. a', MV, {}, 'allow Bash(mv:*)'],
    ['Move-Item x -Destination .', MOVE_ITEM, {}, 'allow Bash(Move-Item:*)'],
    ['mv x .claude/y', MV, {}, 'write:path:agent-control'],
    // (c) find's name filters.
    ['find . -name .git -delete', FIND, {}, 'write:find:sensitive .git'],
    ['find . -path */.git* -delete', FIND, {}, 'write:find:pattern-may-match-sensitive */.git*'],
    ["find . -path '*/.git/*' -delete", FIND, {}, 'write:find:sensitive */.git/*'],
    ["find . -name '*' -delete", FIND, {}, 'write:find:pattern-may-match-sensitive *'],
    ['find sub -name .claude -delete', FIND, {}, 'write:find:agent-control .claude'],
    ["find sub -name '.cl*' -delete", FIND, {}, 'write:find:pattern-may-match-agent-control .cl*'],
    ['find . -regex x -delete', FIND, {}, 'write:find:regex'],
    // (d) Agent-control targets, sources included.
    ['touch .claude/settings.local.json', ['Bash(touch:*)'], {}, 'write:path:agent-control'],
    ['cp x .claude/settings.local.json', ['Bash(cp:*)'], {}, 'write:path:agent-control'],
    ['cp x .githooks/pre-commit', ['Bash(cp:*)'], {}, 'write:path:agent-control'],
    ['tee .husky/pre-commit', ['Bash(tee:*)'], {}, 'write:path:agent-control'],
    ['sed -i s/a/b/ .claude/settings.json', ['Bash(sed:*)'], {}, 'write:path:agent-control'],
    ['cp CLAUDE.md x', ['Bash(cp:*)'], {}, 'write:path:agent-control'],
    ['rm sub/AGENTS.md', RM, {}, 'write:path:agent-control'],
    // Controls: still allowed.
    ['rm -rf sub', RM, {}, 'allow Bash(rm:*)'],
    ['rm -rf dist/*', RM, {}, 'allow Bash(rm:*)'],
    ['rm -rf *.log', RM, {}, 'allow Bash(rm:*)'],
    ['rm -rf dist* build-?', RM, {}, 'allow Bash(rm:*)'],
    ["find . -name '*.pyc' -delete", FIND, {}, 'allow Bash(find:*)'],
    ["find sub -name '*.log' -delete", FIND, {}, 'allow Bash(find:*)'],
    ["find -name '*.pyc' -delete", FIND, {}, 'allow Bash(find:*)'],
    ['find sub -type f -delete', FIND, {}, 'allow Bash(find:*)'],
    ['mkdir .', ['Bash(mkdir:*)'], {}, 'allow Bash(mkdir:*)'],
    ['cp x .', ['Bash(cp:*)'], {}, 'allow Bash(cp:*)'],
    ['touch .', ['Bash(touch:*)'], {}, 'allow Bash(touch:*)'],
    // A literal dot-dir that is neither secret-shaped nor agent-control.
    ['mkdir sub/.cache', ['Bash(mkdir:*)'], {}, 'allow Bash(mkdir:*)'],
    // Residual (recorded): a project manifest is not an agent-control file.
    ['tee package.json', ['Bash(tee:*)'], {}, 'allow Bash(tee:*)']
  ])('%s under %j %j → %s', (command, allow, opts, expected) => {
    expect(outcome(allowRuleSkip(shell(command, opts.workdir), scope(allow, extra)))).toBe(expected)
  })

  it('a session inside a .claude/worktrees/<n> worktree does not match .claude on every write', () => {
    const wt = scope(['Bash(rm:*)', 'Bash(touch:*)'], {
      cwd: '/work/repo/.claude/worktrees/n',
      additionalDirectories: ['/work/repo']
    })
    expect(outcome(allowRuleSkip(shell('rm x'), wt))).toBe('allow Bash(rm:*)')
    expect(outcome(allowRuleSkip(shell('touch src/a.ts'), wt))).toBe('allow Bash(touch:*)')
    // …but the parent repo's own settings, reached from there, still do.
    expect(outcome(allowRuleSkip(shell('rm ../../settings.json'), wt))).toBe(
      'write:path:agent-control'
    )
  })
})

describe('allowRuleSkip — shell, both readings (Windows workspace)', () => {
  const win = (allow: string[], deny: string[] = []): AllowSkipScope => ({
    ...scope(allow, { deny }),
    cwd: 'D:\\work\\repo',
    platform: 'win32'
  })

  it.each<[string, string[], string[], string]>([
    // bash reads `..\x` as `..x` (in the workspace); PowerShell as `..\x` (outside).
    ['Remove-Item -Recurse -Force ..\\x', ['Bash(Remove-Item:*)'], [], 'write:path:out-of-scope'],
    ['Remove-Item .\\dist', ['Bash(Remove-Item:*)'], [], 'allow Bash(Remove-Item:*)'],
    ['Remove-Item -Path:..\\x', ['Bash(Remove-Item:*)'], [], 'write:path:out-of-scope'],
    ['rm -rf D:\\other', ['Bash(rm:*)'], [], 'write:path:drive-relative'],
    [
      'Get-Content ..\\secrets\\k.pem',
      ['Bash(Get-Content:*)'],
      ['Read(**/*.pem)'],
      'read-deny:Read(**/*.pem)'
    ],
    [
      'Get-Content README.md',
      ['Bash(Get-Content:*)'],
      ['Read(**/*.pem)'],
      'allow Bash(Get-Content:*)'
    ],
    // Scope roots, secret globs and agent-control names, in both readings.
    ['Remove-Item -Recurse -Force .', ['Bash(Remove-Item:*)'], [], 'write:path:scope-root'],
    ['Remove-Item -Recurse -Force *', ['Bash(Remove-Item:*)'], [], 'write:path:scope-root-glob'],
    [
      'Remove-Item -Recurse -Force .*',
      ['Bash(Remove-Item:*)'],
      [],
      'write:path:pattern-may-match-sensitive .*'
    ],
    [
      'Remove-Item .git*',
      ['Bash(Remove-Item:*)'],
      [],
      'write:path:pattern-may-match-sensitive .git*'
    ],
    // PowerShell reads `\*` as the root of the current drive, bash as a literal `*`: both refuse.
    ['Remove-Item \\*', ['Bash(Remove-Item:*)'], [], 'write:path:scope-root-glob'],
    ['rm -rf D:/work/repo/', ['Bash(rm:*)'], [], 'write:path:scope-root'],
    // The Git Bash spelling of the same root.
    ['rm -rf /d/work/repo', ['Bash(rm:*)'], [], 'write:path:scope-root'],
    // bash reads `D:\work\repo` as the drive-relative `D:workrepo` — refused before the root check.
    ['rm -rf D:\\work\\repo', ['Bash(rm:*)'], [], 'write:path:drive-relative'],
    // A trailing backslash is not one the two readings agree on: the strict lexer refuses it.
    ['rm -rf D:\\work\\repo\\', ['Bash(rm:*)'], [], 'coverage:uncovered'],
    // bash reads `.claude\settings.json` as `.claudesettings.json`; PowerShell does not.
    ['touch .claude\\settings.json', ['Bash(touch:*)'], [], 'write:path:agent-control']
  ])('%s under %j (deny %j) → %s', (command, allow, deny, expected) => {
    expect(outcome(allowRuleSkip(shell(command), win(allow, deny)))).toBe(expected)
  })
})

describe('allowRuleSkip — non-shell', () => {
  const run = (action: AllowSkipAction, allow: string[], extra: Partial<AllowSkipScope> = {}) =>
    outcome(allowRuleSkip(action, { ...scope(allow), ...extra }))

  it('WebFetch: bare, or domain: over the hostname (a subdomain counts, a look-alike does not)', () => {
    const fetch = (url: string): AllowSkipAction => ({ kind: 'webfetch', url })
    expect(run(fetch('notaurl'), ['WebFetch'])).toBe('allow WebFetch')
    const domain = ['WebFetch(domain:example.com)']
    expect(run(fetch('https://api.example.com/x'), domain)).toBe(
      'allow WebFetch(domain:example.com)'
    )
    expect(run(fetch('https://EXAMPLE.com/'), domain)).toBe('allow WebFetch(domain:example.com)')
    expect(run(fetch('https://example.com.evil.io/'), domain)).toBe('rule:none-usable')
    expect(run(fetch('https://notexample.com/'), domain)).toBe('rule:none-usable')
    expect(run(fetch('notaurl'), domain)).toBe('url:invalid')
    // Only `domain:` — any other specifier matches nothing.
    expect(run(fetch('https://example.com/'), ['WebFetch(https://example.com/*)'])).toBe(
      'rule:none-usable'
    )
    expect(run(fetch('https://example.com/'), [])).toBe('rule:none-usable')
  })

  it('WebSearch: a bare rule only', () => {
    expect(run({ kind: 'websearch' }, ['WebSearch'])).toBe('allow WebSearch')
    expect(run({ kind: 'websearch' }, ['WebSearch(cats)'])).toBe('rule:none-usable')
  })

  it('Skill: bare, or the exact name', () => {
    expect(run({ kind: 'skill', name: 'review' }, ['Skill(review)'])).toBe('allow Skill(review)')
    expect(run({ kind: 'skill', name: 'reviewx' }, ['Skill(review)'])).toBe('rule:none-usable')
    expect(run({ kind: 'skill', name: 'anything' }, ['Skill'])).toBe('allow Skill')
  })

  it('MCP: server level (`mcp__s`, `mcp__s__*`) and tool level', () => {
    const call: AllowSkipAction = { kind: 'mcp', server: 'lsphub', tool: 'find_refs' }
    expect(run(call, ['mcp__lsphub'])).toBe('allow mcp__lsphub')
    expect(run(call, ['mcp__lsphub__*'])).toBe('allow mcp__lsphub__*')
    expect(run(call, ['mcp__lsphub__find_refs'])).toBe('allow mcp__lsphub__find_refs')
    expect(run(call, ['mcp__lsphub__other'])).toBe('rule:none-usable')
    expect(run(call, ['mcp__other'])).toBe('rule:none-usable')
    // A rule that carries a specifier matches nothing (Claude's MCP syntax has none).
    expect(run(call, ['mcp__lsphub(x)'])).toBe('rule:none-usable')
  })

  it("MCP: the rule's tool name is compared in the engine's key form", () => {
    // opencode's sanitiser (`[^a-zA-Z0-9_-]` → `_`, mcp/catalog.ts:117): `find.refs` → `find_refs`.
    const sanitize = (t: string): string => t.replace(/[^a-zA-Z0-9_-]/g, '_')
    const call: AllowSkipAction = { kind: 'mcp', server: 'lsphub', tool: 'find_refs' }
    expect(run(call, ['mcp__lsphub__find.refs'], { mcpToolKey: sanitize })).toBe(
      'allow mcp__lsphub__find.refs'
    )
    // Identity (pi): the rule must match as written.
    expect(run(call, ['mcp__lsphub__find.refs'])).toBe('rule:none-usable')
    // The sanitiser keeps `-`, so a hyphenated tool keeps its hyphen in the key.
    expect(
      run({ kind: 'mcp', server: 'lsphub', tool: 'find-refs' }, ['mcp__lsphub__find-refs'], {
        mcpToolKey: sanitize
      })
    ).toBe('allow mcp__lsphub__find-refs')
  })

  it('MCP: the dispatch tool never skips', () => {
    expect(
      run({ kind: 'mcp', server: 'claudeui', tool: 'dispatch_agent' }, ['mcp__claudeui'])
    ).toBe('rule:dispatch-tool')
    expect(
      run({ kind: 'mcp', server: 'claude-ui-collab', tool: 'dispatch_agent' }, [
        'mcp__claude-ui-collab__*'
      ])
    ).toBe('rule:dispatch-tool')
  })
})
