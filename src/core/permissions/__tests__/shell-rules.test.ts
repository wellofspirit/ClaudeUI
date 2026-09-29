/**
 * @vitest-environment node
 *
 * ADR-085 §1 — the user's Bash rules matched against a command.
 *
 * The bulk is the deny/ask table from the design review (§4 "must catch" and
 * "false-deny risks"), run against synthetic rules shaped like a real rule
 * set, plus a chaining property over every must-hit line. Then allow coverage
 * (lenient and strict), the cli.js `ZIe` predicate, the carve-out and the
 * launcher-shape check.
 */
import { describe, expect, it } from 'vitest'
import {
  allowCovers,
  bashRuleWordAlternatives,
  canLaunchOtherPrograms,
  denyAskHit,
  hasBashRule,
  isCarvedOut,
  isClassifierBypassingRule,
  isLauncherShapedSegment,
  parseBashRule,
  SHELL_RULES_MAX_ANALYSED_LENGTH,
  UNANALYSABLE_COMMAND
} from '../shell-rules'

const FORCE_PUSH = 'Bash(git push --force:*)'
const RM_ROOT = 'Bash(rm -rf /*)'
const RM_RF = 'Bash(rm -rf:*)'
const DOCKER_RUN = 'Bash(docker run:*)'
const JIRA_CREATE = 'Bash(jira issue create:*)'

const RULES = { deny: [FORCE_PUSH, RM_ROOT, RM_RF], ask: [DOCKER_RUN, JIRA_CREATE] }
/** UTF-16LE base64 of `git push --force`, as `pwsh -EncodedCommand` takes it. */
const ENCODED_FORCE_PUSH = 'ZwBpAHQAIABwAHUAcwBoACAALQAtAGYAbwByAGMAZQA='
const ALLOW = [
  'Bash(git:*)',
  'Bash(ls:*)',
  'Bash(docker:*)',
  'Bash(git status:*)',
  'Bash(bun run test:*)',
  'Bash(pwd)'
]

/** [command, expected tier, expected rule]. */
type HitCase = [string, 'deny' | 'ask', string]

const MUST_HIT: HitCase[] = [
  // Reordering and global options.
  ['git push origin main --force', 'deny', FORCE_PUSH],
  ['git push --force origin main', 'deny', FORCE_PUSH],
  ['git -C . push --force', 'deny', FORCE_PUSH],
  ['git -c k=v push --force', 'deny', FORCE_PUSH],
  ['git --no-pager push origin --force', 'deny', FORCE_PUSH],
  ['docker --context x run alpine', 'ask', DOCKER_RUN],
  ['docker run --rm alpine', 'ask', DOCKER_RUN],
  ['jira issue create --summary x', 'ask', JIRA_CREATE],
  ['jira --site y issue create', 'ask', JIRA_CREATE],
  // Wrappers and program spellings.
  ['sudo git push --force', 'deny', FORCE_PUSH],
  ['sudo -u root git push --force', 'deny', FORCE_PUSH],
  ['echo main | xargs git push --force origin', 'deny', FORCE_PUSH],
  ['env A=1 git push --force', 'deny', FORCE_PUSH],
  ['env -i A=1 B=2 git push --force', 'deny', FORCE_PUSH],
  ['A=1 git push --force', 'deny', FORCE_PUSH],
  ['nohup git push --force &', 'deny', FORCE_PUSH],
  ['time git push --force', 'deny', FORCE_PUSH],
  ['nice -n 5 git push --force', 'deny', FORCE_PUSH],
  ['timeout 5 git push --force', 'deny', FORCE_PUSH],
  ['timeout -s KILL 5 git push --force', 'deny', FORCE_PUSH],
  ['command git push --force', 'deny', FORCE_PUSH],
  ['exec git push --force', 'deny', FORCE_PUSH],
  ['sudo env A=1 nice -n 5 git push --force', 'deny', FORCE_PUSH],
  ['/usr/bin/git push --force', 'deny', FORCE_PUSH],
  ['git.exe push --force', 'deny', FORCE_PUSH],
  ['GIT push --force', 'deny', FORCE_PUSH],
  ['"git" push --force', 'deny', FORCE_PUSH],
  ["'git' push --force", 'deny', FORCE_PUSH],
  ['& git push --force', 'deny', FORCE_PUSH],
  ["& 'C:\\Program Files\\Git\\bin\\git.exe' push --force", 'deny', FORCE_PUSH],
  ['Start-Process git -ArgumentList "push","--force"', 'deny', FORCE_PUSH],
  ['sudo docker run alpine', 'ask', DOCKER_RUN],
  // Chaining.
  ['ls && git push --force', 'deny', FORCE_PUSH],
  ['ls; git push --force', 'deny', FORCE_PUSH],
  ['ls || git push --force', 'deny', FORCE_PUSH],
  ['ls & git push --force', 'deny', FORCE_PUSH],
  ['cat x | git push --force', 'deny', FORCE_PUSH],
  ['echo git push --force | sh', 'deny', FORCE_PUSH],
  ['echo git push --force |& bash', 'deny', FORCE_PUSH],
  ['git status 2>&1 | git push --force', 'deny', FORCE_PUSH],
  // Substitutions, also inside double quotes.
  ['echo $(git push --force)', 'deny', FORCE_PUSH],
  ['echo `git push --force`', 'deny', FORCE_PUSH],
  ['echo "$(git push --force)"', 'deny', FORCE_PUSH],
  ['echo "x `git push --force`"', 'deny', FORCE_PUSH],
  ['echo "x $(ls; git push --force)"', 'deny', FORCE_PUSH],
  ['diff <(git push --force) x', 'deny', FORCE_PUSH],
  ['tee >(git push --force)', 'deny', FORCE_PUSH],
  ['echo @(git push --force)', 'deny', FORCE_PUSH],
  ['echo $(echo $(git push --force))', 'deny', FORCE_PUSH],
  // Past the re-analysis depth cap the text is still scanned flat.
  ['echo $(echo $(echo $(echo $(echo $(echo git push --force)))))', 'deny', FORCE_PUSH],
  ['echo git push --force | sudo sh', 'deny', FORCE_PUSH],
  // Quoted content, program at any position.
  ['sh -c "git push --force"', 'deny', FORCE_PUSH],
  ["bash -lc 'git push --force'", 'deny', FORCE_PUSH],
  ['sh -c \'bash -c "git push --force"\'', 'deny', FORCE_PUSH],
  ['sh -c "bash -c \\"git push --force\\""', 'deny', FORCE_PUSH],
  ['bun -e \'x(["git","push","--force"])\'', 'deny', FORCE_PUSH],
  ["node -e \"require('child_process').execSync('git push --force')\"", 'deny', FORCE_PUSH],
  ['echo "git push --force" | sh', 'deny', FORCE_PUSH],
  ['pwsh -Command "git push --force"', 'deny', FORCE_PUSH],
  ['powershell -c "& git push --force"', 'deny', FORCE_PUSH],
  ['cmd /c "git push --force"', 'deny', FORCE_PUSH],
  ['cmd /c git push --force', 'deny', FORCE_PUSH],
  ['sh -c git\\ push\\ --force', 'deny', FORCE_PUSH],
  ['iex "git push --force"', 'deny', FORCE_PUSH],
  ['Invoke-Command { git push --force }', 'deny', FORCE_PUSH],
  ['sh -c "docker run alpine"', 'ask', DOCKER_RUN],
  // Flag spellings and synonyms.
  ['git push --force=x', 'deny', FORCE_PUSH],
  ['git push --forc origin', 'deny', FORCE_PUSH],
  ['git push -f', 'deny', FORCE_PUSH],
  ['git push -fu origin main', 'deny', FORCE_PUSH],
  ['git push origin +main', 'deny', FORCE_PUSH],
  ['git push --force-with-lease', 'deny', FORCE_PUSH],
  ['git push --force-if-includes origin', 'deny', FORCE_PUSH],
  ['git push –-force', 'deny', FORCE_PUSH],
  // rm: clusters, long options, PowerShell and cmd spellings.
  ['rm -rf /', 'deny', RM_ROOT],
  ['rm -fr /', 'deny', RM_ROOT],
  ['rm -r -f /', 'deny', RM_ROOT],
  ['rm -Rf /', 'deny', RM_ROOT],
  ['rm -Rfv /etc', 'deny', RM_ROOT],
  ['rm --recursive --force /', 'deny', RM_ROOT],
  ['rm -rf "/"', 'deny', RM_ROOT],
  ['Remove-Item -Recurse -Force /', 'deny', RM_ROOT],
  ['ri -rec -fo /', 'deny', RM_ROOT],
  ['rm -rf dist', 'deny', RM_RF],
  // cmd's `/s` also reads as a root path to the `/*` glob word: the first rule wins.
  ['del /s /q C:\\x', 'deny', RM_ROOT],
  ['rd /S /Q build', 'deny', RM_ROOT],
  ['erase /s /f x', 'deny', RM_ROOT],
  ['find . -name x -exec rm -rf {} \\;', 'deny', RM_RF],
  // Separators, continuations, ANSI-C quoting, grouping, here-strings, stop-parsing.
  ['ls\ngit push --force', 'deny', FORCE_PUSH],
  ['ls\r\ngit push --force', 'deny', FORCE_PUSH],
  ['ls\rgit push --force', 'deny', FORCE_PUSH],
  ['git\tpush\t--force', 'deny', FORCE_PUSH],
  ['git push \\\n  --force', 'deny', FORCE_PUSH],
  ['git push `\n  --force', 'deny', FORCE_PUSH],
  ["sh -c $'git push --force'", 'deny', FORCE_PUSH],
  ["$'\\x67it' push --force", 'deny', FORCE_PUSH],
  ["$'\\147it' push --force", 'deny', FORCE_PUSH],
  ['{ git push --force; }', 'deny', FORCE_PUSH],
  ['( git push --force )', 'deny', FORCE_PUSH],
  ['(cd x && git push --force)', 'deny', FORCE_PUSH],
  ["bash <<< 'git push --force'", 'deny', FORCE_PUSH],
  ['bash <<< git\\ push\\ --force', 'deny', FORCE_PUSH],
  ['git --% push --force', 'deny', FORCE_PUSH],
  ['>out git push --force', 'deny', FORCE_PUSH],
  ['git push --force > out 2>&1', 'deny', FORCE_PUSH],
  // Shell keywords are transparent (review B1).
  ['for b in a b; do git push --force origin $b; done', 'deny', FORCE_PUSH],
  ['for b in $(cat branches); do git push --force origin $b; done', 'deny', FORCE_PUSH],
  ['if git push --force; then echo ok; fi', 'deny', FORCE_PUSH],
  ['if true; then git push --force; else git push --force; fi', 'deny', FORCE_PUSH],
  ['if false; then :; elif git push --force; then :; fi', 'deny', FORCE_PUSH],
  ['! git push --force', 'deny', FORCE_PUSH],
  ['while git push --force; do :; done', 'deny', FORCE_PUSH],
  ['until git push --force; do :; done', 'deny', FORCE_PUSH],
  ['coproc git push --force', 'deny', FORCE_PUSH],
  ['case x in x) git push --force;; esac', 'deny', FORCE_PUSH],
  ['select b in a; do git push --force; done', 'deny', FORCE_PUSH],
  ['function f { git push --force; }', 'deny', FORCE_PUSH],
  ['f() { git push --force; }', 'deny', FORCE_PUSH],
  ['[[ -n x ]] && git push --force', 'deny', FORCE_PUSH],
  ['time -p git push --force', 'deny', FORCE_PUSH],
  // Glued braces stay in their word (review B2).
  ['echo git push --force | xargs -I{} sh -c {}', 'deny', FORCE_PUSH],
  ['echo git push --force | xargs -I {} sh -c "{}"', 'deny', FORCE_PUSH],
  ['echo push --force | xargs git', 'deny', FORCE_PUSH],
  // Substitution text stays in its word; wrapper operands re-read as one command (review B3).
  ['bash -c "$(echo git push --force)"', 'deny', FORCE_PUSH],
  ['bash -c $(echo git push --force)', 'deny', FORCE_PUSH],
  ['eval "$(echo git push --force)"', 'deny', FORCE_PUSH],
  ['eval $(echo git push --force)', 'deny', FORCE_PUSH],
  ['echo ${X:-$(git push --force)}', 'deny', FORCE_PUSH],
  ['Start-Process git -ArgumentList "push --force"', 'deny', FORCE_PUSH],
  ["Start-Process -FilePath git -ArgumentList 'push --force'", 'deny', FORCE_PUSH],
  ["Start-Process -FilePath git -ArgumentList @('push','--force')", 'deny', FORCE_PUSH],
  ['Start-Process git "push --force"', 'deny', FORCE_PUSH],
  ['saps -Wait git -ArgumentList "push --force"', 'deny', FORCE_PUSH],
  ['iex ("git push " + "--force")', 'deny', FORCE_PUSH],
  ['iex ("gi" + "t push --force")', 'deny', FORCE_PUSH],
  ['pwsh -c ("git push " + "--force")', 'deny', FORCE_PUSH],
  ['iex ("git push {0}" -f "--force")', 'deny', FORCE_PUSH],
  // Remote / container executors and other operand wrappers (review S1).
  ['ssh dev-box git push --force', 'deny', FORCE_PUSH],
  ['ssh -i key -p 22 dev-box git push --force', 'deny', FORCE_PUSH],
  ['docker exec app git push --force', 'deny', FORCE_PUSH],
  ['docker exec -it app git push --force', 'deny', FORCE_PUSH],
  ['podman exec app git push --force', 'deny', FORCE_PUSH],
  ['kubectl exec pod -- git push --force', 'deny', FORCE_PUSH],
  ['chroot /mnt git push --force', 'deny', FORCE_PUSH],
  ['su deploy -c "git push --force"', 'deny', FORCE_PUSH],
  ['script -c "git push --force" /dev/null', 'deny', FORCE_PUSH],
  ['flock /tmp/lock git push --force', 'deny', FORCE_PUSH],
  ['unbuffer git push --force', 'deny', FORCE_PUSH],
  // Encoded PowerShell (review S2): UTF-16LE base64 of `git push --force`.
  ['pwsh -EncodedCommand ZwBpAHQAIABwAHUAcwBoACAALQAtAGYAbwByAGMAZQA=', 'deny', FORCE_PUSH],
  ['powershell -enc ZwBpAHQAIABwAHUAcwBoACAALQAtAGYAbwByAGMAZQA=', 'deny', FORCE_PUSH],
  ['pwsh -ec ZwBpAHQAIABwAHUAcwBoACAALQAtAGYAbwByAGMAZQA=', 'deny', FORCE_PUSH],
  // Small misses (review S4, S5).
  ['rm -Rfvi /', 'deny', RM_ROOT],
  ['rm -rf //', 'deny', RM_ROOT],
  ['git-push --force', 'deny', FORCE_PUSH],
  ['echo git push --force | at now', 'deny', FORCE_PUSH],
  ['echo git push --force | batch', 'deny', FORCE_PUSH],
  ["git -c alias.p='push --force' p", 'deny', FORCE_PUSH],
  ["git -c alias.p='!git push --force' p", 'deny', FORCE_PUSH],
  // Heredocs: run when fed to an executor; bash expands substitutions in an unquoted one.
  ['bash <<EOF\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ["python - <<'EOF'\nimport os; os.system('git push --force')\nEOF", 'deny', FORCE_PUSH],
  ['cat <<EOF | sh\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ['cat <<EOF > notes.md\n$(git push --force)\nEOF', 'deny', FORCE_PUSH],
  // Data exemptions never cover a body or a pipe to a shell (review S15).
  ['echo "git push --force" | bash', 'deny', FORCE_PUSH],
  ['git commit -m "$(git push --force)"', 'deny', FORCE_PUSH],
  ['grep x "$(git push --force)"', 'deny', FORCE_PUSH],
  // A `<` in a PowerShell comment is no parse error: the pwsh reading still counts (review r2 B5).
  ['“git” push --force <# #>', 'deny', FORCE_PUSH],
  ['“git” push --force # <', 'deny', FORCE_PUSH],
  ['git push `\n  --force # <', 'deny', FORCE_PUSH],
  ['git pu`sh --force # <', 'deny', FORCE_PUSH],
  ['<# run #> git push –-force', 'deny', FORCE_PUSH],
  ['“git” push "--force"# <', 'deny', FORCE_PUSH],
  // PowerShell: a token that starts with a quote ends at its closing quote.
  ['git "push"x --force', 'deny', FORCE_PUSH],
  // Every segment feeding an executor is rescanned, not just the adjacent one (review r2 B6).
  ['cat <<EOF | tee log | sh\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ['cat <<EOF | cat | bash\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ["cat <<EOF | sed 's/x/y/' | sh\ngit push --force\nEOF", 'deny', FORCE_PUSH],
  ['echo "git push --force" | tee x.sh | sh', 'deny', FORCE_PUSH],
  ['echo "git push --force" | cat | sh', 'deny', FORCE_PUSH],
  ['echo git push --force | cat | sh', 'deny', FORCE_PUSH],
  ['for b in a; do echo "git push --force"; done | sh', 'deny', FORCE_PUSH],
  ['(echo "git push --force"; echo x) | sh', 'deny', FORCE_PUSH],
  ['{ echo "git push --force"; echo x; } | sh', 'deny', FORCE_PUSH],
  // One executor test: interpreters and operand-wrapper tails read a pipe too (review r2 B7).
  [`echo "import os;os.system('git push --force')" | python`, 'deny', FORCE_PUSH],
  [`echo "import os;os.system('git push --force')" | python3 -`, 'deny', FORCE_PUSH],
  [`echo "import os;os.system('git push --force')" | python -i`, 'deny', FORCE_PUSH],
  [`echo "require('child_process').execSync('git push --force')" | node`, 'deny', FORCE_PUSH],
  [`echo "require('child_process').execSync('git push --force')" | node -`, 'deny', FORCE_PUSH],
  [`echo "system('git push --force')" | perl`, 'deny', FORCE_PUSH],
  [`echo "system('git push --force')" | ruby`, 'deny', FORCE_PUSH],
  ['echo "git push --force" | ssh host bash', 'deny', FORCE_PUSH],
  ['echo "git push --force" | ssh host', 'deny', FORCE_PUSH],
  ['echo "git push --force" | docker exec -i c sh', 'deny', FORCE_PUSH],
  ['echo "git push --force" | kubectl exec -i p -- sh', 'deny', FORCE_PUSH],
  // `source`, `.`, `eval`, `sudo -s|-i`, `su -` and `parallel` run their input (review r2 B8, S18).
  ['source /dev/stdin <<EOF\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ['. /dev/stdin <<EOF\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ['echo "git push --force" | source /dev/stdin', 'deny', FORCE_PUSH],
  ['echo "git push --force" | . /dev/stdin', 'deny', FORCE_PUSH],
  ['echo "git push --force" | eval "$(cat)"', 'deny', FORCE_PUSH],
  ['echo "git push --force" | eval $(cat)', 'deny', FORCE_PUSH],
  ['sudo -s <<EOF\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ['sudo -u root -i <<EOF\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ['echo "git push --force" | sudo -s', 'deny', FORCE_PUSH],
  ['echo "git push --force" | su -', 'deny', FORCE_PUSH],
  ['echo "git push --force" | parallel', 'deny', FORCE_PUSH],
  ['parallel <<EOF\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  // Data written where it runs is not data (review r2 B9).
  ['echo "git push --force" > x.sh && sh x.sh', 'deny', FORCE_PUSH],
  ['echo "git push --force" >> x.sh; bash x.sh', 'deny', FORCE_PUSH],
  ["printf 'git push --force\\n' > x.sh; . x.sh", 'deny', FORCE_PUSH],
  ['echo "git push --force" >> ~/.bashrc', 'deny', FORCE_PUSH],
  ['echo "git push --force" > .git/hooks/pre-commit', 'deny', FORCE_PUSH],
  ['echo "git push --force" > notes.txt; sudo ls', 'deny', FORCE_PUSH],
  ['echo "git push --force" > out.txt; cat out.txt', 'deny', FORCE_PUSH],
  ['cat <<EOF > x.sh; sh x.sh\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ["cat <<'EOF' > x.sh && bash x.sh\ngit push --force\nEOF", 'deny', FORCE_PUSH],
  ['cat <<EOF > x.sh\ngit push --force\nEOF\nsh x.sh', 'deny', FORCE_PUSH],
  ['cat > x.sh <<EOF\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ['tee x.sh <<EOF; sh x.sh\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  ['for b in a; do echo "git push --force"; done > x.sh', 'deny', FORCE_PUSH],
  ['echo "git push --force" | Out-File x.ps1; pwsh x.ps1', 'deny', FORCE_PUSH],
  ['Write-Output "git push --force" | Set-Content x.ps1; & ./x.ps1', 'deny', FORCE_PUSH],
  ['echo "git push --force" | tee >(sh)', 'deny', FORCE_PUSH],
  ['echo "git push --force" > >(sh)', 'deny', FORCE_PUSH],
  // Empty segments are transparent to a pipe; a pipe into a compound feeds it all (review r3 B10).
  ['echo git push --force |\nsh', 'deny', FORCE_PUSH],
  ['echo "git push --force" |\n  tr a-z a-z |\n  bash', 'deny', FORCE_PUSH],
  ['echo "git push --force"\n| iex', 'deny', FORCE_PUSH],
  ['echo git push --force\n| iex', 'deny', FORCE_PUSH],
  ['echo git push --force | (sh)', 'deny', FORCE_PUSH],
  ['echo git push --force | (cd x && sh)', 'deny', FORCE_PUSH],
  ['echo git push --force | { sh; }', 'deny', FORCE_PUSH],
  ['echo git push --force | while read l; do sh -c "$l"; done', 'deny', FORCE_PUSH],
  ['echo git push --force | while read l; do eval "$l"; done', 'deny', FORCE_PUSH],
  ['echo git push --force | if true; then sh; fi', 'deny', FORCE_PUSH],
  ['echo push --force | (xargs git)', 'deny', FORCE_PUSH],
  // A pipe with no command after it still carries its left side out (bash reads the body first).
  ['cat <<EOF |\nsh\ngit push --force\nEOF', 'deny', FORCE_PUSH],
  // `.git/` holds config and hooks the next git call runs (review r3 S28).
  ['echo "git push --force" >> .git/config', 'deny', FORCE_PUSH],
  // A trailing `/` is still directly under root (review r2 S20).
  ['rm -rf /etc/', 'deny', RM_ROOT],
  ['rm -rf "/etc/"', 'deny', RM_ROOT]
]

const MUST_NOT_HIT: Array<[string, { deny?: string[]; ask?: string[] }]> = [
  // Program at token 0 (or after a wrapper) only — a mention is not a call.
  ['echo rm -rf', RULES],
  ['git rm -rf dir', RULES],
  ['ls -la rm', RULES],
  // `-rf` needs both letters, and `npm` is the program here, not `rm`.
  ['npm rm -f pkg', RULES],
  ['printf "%s" rm', RULES],
  // Only a `-` last word is a prefix; other words are whole.
  ['docker build -t runtime .', RULES],
  ['docker logs runner-1', RULES],
  ['jira issue list --jql created', RULES],
  ['jira issue list --jql "created > -1d"', RULES],
  // A glob word's `*` does not cross `/`.
  ['rm -rf dist/', { deny: [RM_ROOT] }],
  ['rm -rf /d/WorkPlace/x/dist', { deny: [RM_ROOT] }],
  ['rm -rf ./build', { deny: [RM_ROOT] }],
  ['rm -rf /tmp/build', { deny: [RM_ROOT] }],
  // Neither `--force` nor any synonym of it.
  ['git push origin feat', RULES],
  ['git push --follow-tags', RULES],
  ['git push -u origin feat', RULES],
  ['git push --no-verify origin feat', RULES],
  ['git push origin feat:feat', RULES],
  ['git status', RULES],
  ['git log --oneline', RULES],
  // PowerShell parameter NAMES are not letter clusters: not recursive.
  ['Remove-Item x -Force', RULES],
  ['Remove-Item -LiteralPath x -Force', RULES],
  ['Remove-Item -Filter *.tmp -Force', RULES],
  // Not rm, and not recursive.
  ['rm -f x.txt', RULES],
  ['del /q x.txt', RULES],
  ['', RULES],
  ['   ', RULES],
  // The data of a text reader, printer or message option is not a command (review S15).
  ['rg "git push --force" docs/', RULES],
  ['grep -rn "docker run" .', RULES],
  ['git grep "git push --force"', RULES],
  ['git log --grep "rm -rf"', RULES],
  ['git log -S"git push --force"', RULES],
  ['git commit -m "rm -rf cleanup in CI"', RULES],
  ['git commit -am "do not git push --force"', RULES],
  ['git commit --message="git push --force is banned"', RULES],
  ['git tag -m "rm -rf" v1', RULES],
  ['echo "git push --force"', RULES],
  ['printf "%s\n" "git push --force"', RULES],
  ['Write-Host "git push --force"', RULES],
  ['gh pr create --title "x" --body "run docker run later"', RULES],
  ['jira issue edit X-1 --summary "docker run fails"', RULES],
  // A data heredoc (quoted delimiter, not fed to an executor) is not a command.
  ["cat <<'EOF' > notes.md\ngit push --force\nEOF", RULES],
  ["git commit -F - <<'EOF'\nrm -rf the cache\nEOF", RULES],
  // Data written to a file nothing runs stays data (review r2 B9 rule 3).
  ['echo "git push --force" > notes.txt', RULES],
  ['echo "git push --force" > notes.txt && git status', RULES],
  ['echo "git push --force" > /dev/null', RULES],
  ['echo "git push --force" 2>&1', RULES],
  ['echo "git push --force" < input.txt; cat x', RULES],
  // `||` and `&&` are not pipes: `sh` reads nothing from the left (review r3 B10).
  ['echo "git push --force" || sh', RULES],
  ['echo "git push --force" && sh', RULES],
  ['echo git push --force\n\nsh', RULES],
  // A glued `{}` is not a group, and `-I{}`'s braces do not split the segment.
  ['find . -name x -exec echo {} \\;', RULES],
  // Two-character flags stay case-sensitive; positional words fold.
  ['git branch -d feat', { deny: ['Bash(git branch -D:*)'] }]
]

describe('denyAskHit — must hit', () => {
  it.each(MUST_HIT)('%j → %s %s', (command, tier, rule) => {
    expect(denyAskHit(command, RULES)).toEqual({ tier, rule })
  })

  it('stays a hit behind a chain on either side (property over every must-hit line)', () => {
    for (const [command, tier, rule] of MUST_HIT) {
      // A heredoc body runs to its delimiter LINE, so the chain goes on the operator's line
      // (appended after the body it would be swallowed by it — review r2 S26).
      const nl = command.indexOf('\n')
      const after =
        command.includes('<<') && nl >= 0
          ? `${command.slice(0, nl)} && pwd${command.slice(nl)}`
          : `${command} && pwd`
      for (const variant of [`ls && ${command}`, after]) {
        expect(denyAskHit(variant, RULES), JSON.stringify(variant)).toEqual({ tier, rule })
      }
    }
  })

  it('checks deny before ask', () => {
    expect(denyAskHit('docker run x && git push -f', RULES)).toEqual({
      tier: 'deny',
      rule: FORCE_PUSH
    })
  })

  it('a bare Bash rule, or Bash(*), hits every command', () => {
    expect(denyAskHit('anything', { deny: ['Bash'] })).toEqual({ tier: 'deny', rule: 'Bash' })
    expect(denyAskHit('anything', { ask: ['Bash(*)'] })).toEqual({ tier: 'ask', rule: 'Bash(*)' })
  })

  it('ignores every other tool', () => {
    expect(denyAskHit('git push --force', { deny: ['Read(**)', 'mcp__x', 'Edit'] })).toBe(undefined)
  })

  it("keeps today's text semantics as a union (nothing that hit before stops hitting)", () => {
    // pi matched `x:*` as a raw whole-command startsWith: still a hit.
    expect(denyAskHit('docker runtime-check', { ask: [DOCKER_RUN] })?.rule).toBe(DOCKER_RUN)
    // An exact rule still hits its exact command.
    expect(denyAskHit('ls -la', { deny: ['Bash(ls -la)'] })?.rule).toBe('Bash(ls -la)')
    // A glob specifier over the whole command (`*` not crossing `/`).
    expect(denyAskHit('git diff --stat', { deny: ['Bash(git * --stat)'] })).toBeDefined()
    // Degenerate `Bash(:*)` was "startsWith('')" — every command.
    expect(denyAskHit('ls', { deny: ['Bash(:*)'] })).toBeDefined()
  })

  it('an exact deny rule is matched as a prefix (a flag word may grow)', () => {
    const deny = ['Bash(git push --force)']
    expect(denyAskHit('git push --force origin main', { deny })).toBeDefined()
    expect(denyAskHit('git push origin --force-with-lease', { deny })).toBeDefined()
  })

  it('git branch -D ≡ --delete --force; --delete ≡ -d', () => {
    const deny = ['Bash(git branch -D:*)']
    expect(denyAskHit('git branch -D feat', { deny })).toBeDefined()
    expect(denyAskHit('git branch --delete --force feat', { deny })).toBeDefined()
    expect(denyAskHit('git branch -d -f feat', { deny })).toBeDefined()
    expect(denyAskHit('git branch -d feat', { deny })).toBeUndefined()
    const del = ['Bash(git branch --delete:*)']
    expect(denyAskHit('git branch -d feat', { deny: del })).toBeDefined()
    expect(denyAskHit('git branch -D feat', { deny: del })).toBeDefined()
    expect(denyAskHit('git branch -m a b', { deny: del })).toBeUndefined()
  })

  it('git push --delete ≡ -d ≡ a :ref refspec; clean/checkout/switch -f ≡ --force', () => {
    const del = ['Bash(git push --delete:*)']
    expect(denyAskHit('git push origin -d feat', { deny: del })).toBeDefined()
    expect(denyAskHit('git push origin :feat', { deny: del })).toBeDefined()
    expect(denyAskHit('git push origin feat', { deny: del })).toBeUndefined()
    expect(denyAskHit('git clean --force -d', { deny: ['Bash(git clean -f:*)'] })).toBeDefined()
    expect(denyAskHit('git clean -fdx', { deny: ['Bash(git clean -f:*)'] })).toBeDefined()
    expect(denyAskHit('git clean -n', { deny: ['Bash(git clean -f:*)'] })).toBeUndefined()
    expect(
      denyAskHit('git checkout --force main', { deny: ['Bash(git checkout -f:*)'] })
    ).toBeDefined()
    expect(
      denyAskHit('git switch --discard-changes main', { deny: ['Bash(git switch -f:*)'] })
    ).toBeDefined()
    expect(
      denyAskHit('git reset --har HEAD~1', { deny: ['Bash(git reset --hard:*)'] })
    ).toBeDefined()
  })

  it('a PowerShell cmdlet, its aliases and its bash namesake are one program', () => {
    expect(denyAskHit('ls -Recurse', { ask: ['Bash(Get-ChildItem:*)'] })).toBeDefined()
    expect(denyAskHit('gci -Recurse', { ask: ['Bash(ls:*)'] })).toBeDefined()
    expect(denyAskHit('Get-Content x', { deny: ['Bash(cat:*)'] })).toBeDefined()
    expect(denyAskHit('Copy-Item -Recurse a b', { deny: ['Bash(cp -r:*)'] })).toBeDefined()
    expect(denyAskHit('git status', { deny: ['Bash(Get-ChildItem:*)'] })).toBeUndefined()
  })

  it('positional words compare case-insensitively (PowerShell); two-character flags do not', () => {
    const deny = ['Bash(Set-ExecutionPolicy Unrestricted:*)', 'Bash(Stop-Process -Name Explorer:*)']
    expect(denyAskHit('set-executionpolicy unrestricted', { deny })?.rule).toBe(deny[0])
    expect(denyAskHit('Stop-Process -Name explorer', { deny })?.rule).toBe(deny[1])
  })

  it('never throws: an unanalysable command asks', () => {
    expect(denyAskHit(undefined as unknown as string, RULES)).toEqual({
      tier: 'ask',
      rule: UNANALYSABLE_COMMAND
    })
    // 20 000 consecutive wrappers (a recursion would overflow the stack).
    const chain = `${'sudo '.repeat(20000)}git push --force`
    expect(denyAskHit(chain, RULES)).toEqual({ tier: 'deny', rule: FORCE_PUSH })
  })

  it('a command over the length cap is scanned flat, still over-approximately', () => {
    const long = `${'x '.repeat(SHELL_RULES_MAX_ANALYSED_LENGTH)}; git push --force`
    expect(denyAskHit(long, RULES)).toEqual({ tier: 'deny', rule: FORCE_PUSH })
  })

  it('the flat scan reads PowerShell typography and -EncodedCommand too (review r2 S19)', () => {
    const pad = `# ${'x'.repeat(SHELL_RULES_MAX_ANALYSED_LENGTH)}\n`
    for (const tail of [
      `pwsh -enc ${ENCODED_FORCE_PUSH}`,
      `powershell -EncodedCommand ${ENCODED_FORCE_PUSH}`,
      '“git” push --force',
      'git push –-force'
    ]) {
      expect(denyAskHit(pad + tail, RULES), tail).toEqual({ tier: 'deny', rule: FORCE_PUSH })
    }
  })

  it('a long wrapper chain stays within the token budget (review r2 S19)', () => {
    // `$'…'` is decoded by the full analysis only: a hit proves the budget held.
    const chain = 'sudo '.repeat(1200)
    expect(denyAskHit(`${chain}$'\\x67it' push --force`, RULES)?.rule).toBe(FORCE_PUSH)
    expect(denyAskHit(`${chain}pwsh -enc ${ENCODED_FORCE_PUSH}`, RULES)?.rule).toBe(FORCE_PUSH)
    expect(denyAskHit(`${'env A=1 '.repeat(900)}$'\\x67it' push --force`, RULES)?.rule).toBe(
      FORCE_PUSH
    )
  })

  it('answers each rule set correctly on the same command (the memo is rule-independent)', () => {
    const command = 'ls && git push -f && docker run x'
    expect(denyAskHit(command, { deny: [RM_RF] })).toBeUndefined()
    expect(denyAskHit(command, { ask: [DOCKER_RUN] })?.rule).toBe(DOCKER_RUN)
    expect(denyAskHit(command, { deny: [FORCE_PUSH] })?.rule).toBe(FORCE_PUSH)
    expect(denyAskHit(command, {})).toBeUndefined()
  })

  it('synonyms are program-scoped: a `-f` elsewhere is not `--force`', () => {
    expect(denyAskHit('git commit -F msg.txt', RULES)).toBeUndefined()
    expect(denyAskHit('git fetch --force', { deny: [FORCE_PUSH] })).toBeUndefined()
  })
})

describe('denyAskHit — must not hit', () => {
  it.each(MUST_NOT_HIT)('%j', (command, rules) => {
    expect(denyAskHit(command, rules)).toBeUndefined()
  })
})

describe('denyAskHit — accepted over-refusals', () => {
  // A quoted mention of a denied command, as an argument of a program not on the
  // data list, is refused: the rescan cannot tell it from `sh -c`. The model rephrases.
  it.each([['cat "git push --force"'], ['bash -c "echo \'git push --force\'"']])(
    '%j hits',
    (command) => {
      expect(denyAskHit(command, RULES)?.tier).toBe('deny')
    }
  )

  it('docker compose run is docker … run', () => {
    expect(denyAskHit('docker compose run web', RULES)?.rule).toBe(DOCKER_RUN)
  })

  // A pipe out of the segment always lifts the data exemption (review r2 B9 rule 1):
  // the matcher does not know what the right side does with the text.
  it.each([['grep -rn "rm -rf" . | head'], ['rg "git push --force" src | wc -l']])(
    '%j hits',
    (command) => {
      expect(denyAskHit(command, RULES)?.tier).toBe('deny')
    }
  )
})

describe('parseBashRule', () => {
  it('normalises the program and flags glob words', () => {
    expect(parseBashRule('Git.exe push --force:*')).toEqual({
      program: 'git',
      words: [
        { text: 'push', glob: false },
        { text: '--force', glob: false }
      ],
      prefix: true,
      raw: 'Git.exe push --force:*'
    })
    expect(parseBashRule('rm -rf /*')).toMatchObject({
      program: 'rm',
      words: [
        { text: '-rf', glob: false },
        { text: '/*', glob: true }
      ],
      prefix: true
    })
    expect(parseBashRule('git log *')).toMatchObject({ words: [{ text: 'log' }], prefix: true })
    expect(parseBashRule('pwd')).toMatchObject({ program: 'pwd', words: [], prefix: false })
    expect(parseBashRule('git commit -m "wip one":*')?.words.map((w) => w.text)).toEqual([
      'commit',
      '-m',
      'wip one'
    ])
    expect(parseBashRule(':*')).toBeUndefined()
  })
})

describe('bashRuleWordAlternatives (ADR-085 §3 — the opencode broad globs)', () => {
  const alts = (specifier: string, index: number): string[][] => {
    const rule = parseBashRule(specifier)
    if (!rule) throw new Error(`unparsable ${specifier}`)
    return bashRuleWordAlternatives(rule, index)
  }

  it('`--force` on git push → itself first, then every force spelling', () => {
    const out = alts('git push --force:*', 1)
    expect(out[0]).toEqual(['--force'])
    expect(out).toContainEqual(['-f'])
    expect(out).toContainEqual(['--force-with-lease'])
    expect(out).toContainEqual(['--force-if-includes'])
    expect(out).toContainEqual(['+'])
    expect(new Set(out.map((a) => a.join(' '))).size).toBe(out.length)
  })

  it('`-rf` on rm → the permutations as one token, and the split letters in every order', () => {
    expect(alts('rm -rf:*', 0)).toEqual([['-rf'], ['-fr'], ['-r', '-f'], ['-f', '-r']])
  })

  it('a plain word → itself only', () => {
    expect(alts('git push --force:*', 0)).toEqual([['push']])
    expect(alts('docker run:*', 0)).toEqual([['run']])
  })

  it('a glob word → itself only', () => {
    expect(alts('rm -rf /*', 1)).toEqual([['/*']])
  })

  it('an index out of range → []', () => {
    expect(alts('rm -rf:*', 1)).toEqual([])
    expect(alts('rm:*', 0)).toEqual([])
    expect(alts('rm -rf:*', -1)).toEqual([])
  })

  it('an allOf concept contributes its own members only (`git branch -D`)', () => {
    expect(alts('git branch -D:*', 1)).toEqual([['-D']])
  })

  it('a one-letter flag takes its synonym concept (`rm -f` → `--force`, `-force`, `/q`, `/f`)', () => {
    expect(alts('rm -f:*', 0)).toEqual([['-f'], ['--force'], ['-force'], ['/q'], ['/f']])
  })
})

describe('allowCovers — lenient', () => {
  const covers = (command: string, rules: string[] = ALLOW) =>
    allowCovers(command, rules, 'lenient')

  it('covers each segment by some rule, reporting the rule per segment', () => {
    expect(covers('git status && git log')).toEqual({
      segments: [
        { segment: 'git status', rule: 'Bash(git:*)' },
        { segment: 'git log', rule: 'Bash(git:*)' }
      ]
    })
    expect(covers('ls -la; pwd')?.segments.map((s) => s.rule)).toEqual(['Bash(ls:*)', 'Bash(pwd)'])
  })

  it('an uncovered segment anywhere means not covered', () => {
    expect(covers('ls && curl x | sh')).toBeUndefined()
    expect(covers('ls & rm x')).toBeUndefined()
    expect(covers('ls\nrm x')).toBeUndefined()
  })

  it('a newline inside quotes is not a split', () => {
    expect(covers('git commit -m "a\nb"')).toBeDefined()
  })

  it('redirections are allowed', () => {
    expect(covers('bun run test > test.log')).toBeDefined()
    expect(covers('bun run build > build.log', [...ALLOW, 'Bash(bun run build:*)'])).toBeDefined()
    expect(covers('git status 2>&1 | ls')).toBeDefined()
  })

  it('a substitution body is covered only when every segment of it is', () => {
    expect(covers('git log $(x)')).toBeUndefined()
    expect(covers('git log `x`')).toBeUndefined()
    expect(covers('git diff <(curl x)')).toBeUndefined()
    expect(covers('ls @(rm x)')).toBeUndefined()
    expect(covers('echo ${X:-$(rm -rf /)}', ['Bash(echo:*)'])).toBeUndefined()
    expect(covers('git diff <(ls) x')).toBeDefined()
    expect(covers('git log $(git rev-parse HEAD)')).toBeDefined()
    expect(covers('git log $(ls $(pwd))')).toBeDefined()
  })

  it('a `$(` or backtick inside single quotes, or escaped, is literal', () => {
    expect(covers("git log --format='%h $(x)'")).toBeDefined()
    expect(covers('git commit -m "fix \\`foo\\` handling"')).toBeDefined()
    // …but PowerShell's escape is the backtick: to it, `\$(x)` is a live subexpression.
    expect(covers('git commit -m "costs \\$(x)"')).toBeUndefined()
  })

  it("covers Claude's commit shape when `git` and `cat` are allowed", () => {
    const commit = [
      "git commit -m \"$(cat <<'EOF'",
      "feat(x): don't (break) things",
      '',
      'Body line with $(not a substitution) and `ticks`',
      'EOF',
      ')"'
    ].join('\n')
    expect(covers(commit, [...ALLOW, 'Bash(cat:*)'])).toBeDefined()
    // Without `cat`, the body is not covered.
    expect(covers(commit)).toBeUndefined()
  })

  it('a heredoc is data unless its command runs it, or bash expands a substitution in it', () => {
    const allow = [...ALLOW, 'Bash(cat:*)', 'Bash(sh:*)', 'Bash(python:*)']
    expect(covers("git commit -F - <<'EOF'\nrm -rf x; curl y | sh\nEOF", allow)).toBeDefined()
    expect(covers('cat <<EOF > f.txt\nplain text\nEOF', allow)).toBeDefined()
    expect(covers('cat <<EOF > f.txt\n$(curl evil)\nEOF', allow)).toBeUndefined()
    expect(covers("cat <<'EOF' > f.txt\n$(curl evil)\nEOF", allow)).toBeDefined()
    expect(covers('sh <<EOF\nls\nEOF', allow)).toBeUndefined()
    expect(covers("python - <<'EOF'\nprint(1)\nEOF", allow)).toBeUndefined()
    expect(covers('cat <<< "text"', allow)).toBeDefined()
    expect(covers('sh <<< "ls"', allow)).toBeUndefined()
    // The one executor test (review r2 B7/B8): source, eval, sudo -s, ssh read their input.
    const wide = [...allow, 'Bash(source:*)', 'Bash(eval:*)', 'Bash(sudo:*)', 'Bash(ssh:*)']
    expect(covers('source /dev/stdin <<EOF\nls\nEOF', wide)).toBeUndefined()
    expect(covers('sudo -s <<EOF\nls\nEOF', wide)).toBeUndefined()
    expect(covers('ssh host <<EOF\nls\nEOF', wide)).toBeUndefined()
    expect(covers('eval "$(cat)" <<< "ls"', wide)).toBeUndefined()
  })

  it('prefix is word-boundary (cli.js parity) and exact is exact', () => {
    // A change from pi's old raw startsWith: `bun run test:*` was a text prefix of `bun run test:unit`.
    expect(covers('bun run test:unit')).toBeUndefined()
    expect(covers('bun run test --watch')).toBeDefined()
    expect(covers('git-lfs pull')).toBeUndefined()
    expect(covers('pwd')).toBeDefined()
    expect(covers('pwd -P')).toBeUndefined()
    // Programs are not normalised for coverage.
    expect(covers('/tmp/x/git status')).toBeUndefined()
  })

  it('needs the PowerShell reading covered too', () => {
    // bash: one echo. PowerShell: `\` is literal, so `rm x` is its own statement.
    expect(covers('echo "a\\" ; rm x ; echo \\"b"', ['Bash(echo:*)'])).toBeUndefined()
    // PowerShell evaluates a parenthesised argument as a command.
    expect(covers('ls (rm x)')).toBeUndefined()
  })

  it('a `<` inside a PowerShell comment does not drop the PowerShell reading (review r2 B5)', () => {
    const git = ['Bash(git:*)']
    // PowerShell runs `rm x` here (bash runs one `git commit`); the comment hides nothing.
    for (const comment of ['', ' # <', ' <# c #>']) {
      const command = `git commit -m "a\\"; rm x; echo \\"b"${comment}`
      expect(covers(command, git), command).toBeUndefined()
      expect(allowCovers(command, git, 'strict'), command).toBeUndefined()
    }
    // A `<` PowerShell accepts, or a real redirect: still covered.
    expect(covers("git log --format='<%h>'", git)).toBeDefined()
    expect(covers('git log --format="<%h>"', git)).toBeDefined()
    expect(covers('git log 2>&1', git)).toBeDefined()
    expect(covers('git status # a note', git)).toBeDefined()
  })

  it('a pipe continued over a newline covers like one on a line (review r3 B10)', () => {
    const allow = ['Bash(git:*)', 'Bash(cat:*)']
    expect(covers('git status |\ncat', allow)).toBeDefined()
    expect(covers('git status\n| cat', allow)).toBeDefined()
    expect(covers('git status |\nrm x', allow)).toBeUndefined()
  })

  it('a bash line continuation still covers (the PowerShell reading of a `--flag` line runs nothing)', () => {
    expect(covers('git commit \\\n  -m x \\\n  --amend')).toBeDefined()
  })

  it('an exact rule covers its whole command as written; a bare Bash rule covers anything', () => {
    const exact = 'Bash(npm run build && npm test)'
    expect(covers('npm run build && npm test', [exact])?.segments).toEqual([
      { segment: 'npm run build && npm test', rule: exact }
    ])
    expect(covers('anything $(x) | sh', ['Bash'])).toBeDefined()
  })

  it('an "always allow" rule minted from a compound command still matches that command', () => {
    // pi and Codex suggest `Bash(<whole command>:*)`; only the identical command is covered by it.
    const minted = 'Bash(ls && git log $(cat ref):*)'
    expect(covers('ls   &&  git log $(cat ref)', [minted])).toBeDefined()
    expect(covers('ls && git log $(cat ref) && rm -rf x', [minted])).toBeUndefined()
  })

  it('shell keywords are not commands; a for/case header is data', () => {
    const allow = [...ALLOW, 'Bash(echo:*)']
    expect(covers('for f in *.ts; do echo $f; done', allow)).toBeDefined()
    expect(
      covers('if git diff --quiet; then echo same; else echo changed; fi', allow)
    ).toBeDefined()
    expect(covers('for f in a; do rm -rf $f; done', allow)).toBeUndefined()
    expect(covers('for f in $(curl x); do echo $f; done', allow)).toBeUndefined()
    expect(covers('while true; do curl x; done', allow)).toBeUndefined()
  })

  it('never throws', () => {
    expect(allowCovers(undefined as unknown as string, ALLOW, 'lenient')).toBeUndefined()
    expect(allowCovers(undefined as unknown as string, ALLOW, 'strict')).toBeUndefined()
  })

  it('no Bash allow rules, no coverage', () => {
    expect(covers('ls', ['Read(**)'])).toBeUndefined()
    expect(covers('', ALLOW)).toBeUndefined()
  })
})

describe('allowCovers — strict', () => {
  const covers = (command: string, rules: string[] = ALLOW) => allowCovers(command, rules, 'strict')

  it('covers every segment through the ADR-084 lexer', () => {
    expect(covers('git status && git log')?.segments).toHaveLength(2)
    expect(covers('git status')).toBeDefined()
  })

  it('a redirection, a newline or a `$` is never covered', () => {
    expect(covers('git log > out')).toBeUndefined()
    expect(covers('git commit -m "a\nb"')).toBeUndefined()
    expect(covers('git log $HOME')).toBeUndefined()
  })

  it('prefix is word-boundary', () => {
    expect(covers('bun run test:unit')).toBeUndefined()
    expect(covers('bun run test --watch')).toBeDefined()
    expect(covers('git-lfs pull')).toBeUndefined()
  })
})

describe('isClassifierBypassingRule (cli.js ZIe parity)', () => {
  it.each([
    'Bash',
    'Bash()',
    'Bash(*)',
    'Bash(**)',
    'PowerShell(*)',
    'Bash(python)',
    'Bash(python:*)',
    'Bash(python *)',
    'Bash(python*)',
    'Bash(python -c *)',
    'Bash(node -e:*)',
    'Bash(npm run:*)',
    'Bash(bun run *)',
    'Bash(sudo:*)',
    'Bash(xargs:*)',
    'Bash(env:*)',
    'Bash(bash:*)',
    'Bash(python -m pytest:*)',
    // The union: PowerShell's launchers count for Bash rules too, each also `.exe`.
    'Bash(pwsh:*)',
    'Bash(python.exe:*)',
    'Bash(npm.exe run:*)',
    'PowerShell(iex:*)',
    'PowerShell(Start-Process:*)',
    'PowerShell(cmd.exe *)',
    'PowerShell(python -m pkg.mod:*)',
    'Agent',
    'Agent(Explore)',
    'Task(x)',
    'Monitor',
    'AppifactRepl'
  ])('%s bypasses', (rule) => {
    expect(isClassifierBypassingRule(rule)).toBe(true)
  })

  it.each([
    'Bash(bun run test:*)',
    'Bash(git:*)',
    'Bash(npm:*)',
    'Bash(npx prettier:*)',
    'Bash(uv run:*)',
    'Bash(docker run:*)',
    'Bash(python -m pkg.mod:*)',
    'Bash(python3.12 -m pkg.sub.mod:*)',
    'Bash(pythonista:*)',
    'Read(**)',
    'WebFetch',
    'mcp__server'
  ])('%s does not', (rule) => {
    expect(isClassifierBypassingRule(rule)).toBe(false)
  })
})

describe('isCarvedOut', () => {
  const denyAsk = { deny: [FORCE_PUSH, RM_RF], ask: [DOCKER_RUN] }

  it('names the narrower deny/ask rule inside a broader allow', () => {
    expect(isCarvedOut('Bash(git:*)', denyAsk)).toBe(FORCE_PUSH)
    expect(isCarvedOut('Bash(git push:*)', denyAsk)).toBe(FORCE_PUSH)
    expect(isCarvedOut('Bash(docker:*)', denyAsk)).toBe(DOCKER_RUN)
    expect(isCarvedOut('Bash(rm:*)', denyAsk)).toBe(RM_RF)
  })

  it('leaves a disjoint allow alone', () => {
    expect(isCarvedOut('Bash(git status:*)', denyAsk)).toBeUndefined()
    expect(isCarvedOut('Bash(ls:*)', denyAsk)).toBeUndefined()
    expect(isCarvedOut('Bash(docker build:*)', denyAsk)).toBeUndefined()
    expect(isCarvedOut('Bash(pwd)', denyAsk)).toBeUndefined()
    expect(isCarvedOut('Bash(git status)', denyAsk)).toBeUndefined()
    expect(isCarvedOut('Read(**)', denyAsk)).toBeUndefined()
    expect(isCarvedOut('Bash(git:*)', { deny: ['Read(**)'], ask: [] })).toBeUndefined()
  })

  it('flags do not narrow a prefix allow: `rm -f:*` still covers `rm -f -r /`', () => {
    expect(isCarvedOut('Bash(rm -f:*)', denyAsk)).toBe(RM_RF)
    expect(isCarvedOut('Bash(Remove-Item:*)', denyAsk)).toBe(RM_RF)
  })

  it('an ask rule broader than the allow binds the whole allow', () => {
    expect(isCarvedOut('Bash(git status:*)', { deny: [], ask: ['Bash(git:*)'] })).toBe(
      'Bash(git:*)'
    )
  })

  it('whole-tool, launcher and wrapper allows reach every program', () => {
    expect(isCarvedOut('Bash', denyAsk)).toBe(FORCE_PUSH)
    expect(isCarvedOut('Bash(sh:*)', denyAsk)).toBe(FORCE_PUSH)
    expect(isCarvedOut('Bash(sudo git:*)', denyAsk)).toBe(FORCE_PUSH)
    expect(isCarvedOut('Bash(ls:*)', { deny: ['Bash'], ask: [] })).toBe('Bash')
  })

  it('an exact allow is carved out only when its own command hits', () => {
    expect(isCarvedOut('Bash(git push origin main --force)', denyAsk)).toBe(FORCE_PUSH)
    expect(isCarvedOut('Bash(git push origin main)', denyAsk)).toBeUndefined()
  })

  it("'program' strength (Codex): any deny/ask rule for the same program carves it out", () => {
    const program = { strength: 'program' as const }
    // `docker compose run web` hits the ask, so an emitted allow would skip it.
    expect(isCarvedOut('Bash(docker compose:*)', denyAsk)).toBeUndefined()
    expect(isCarvedOut('Bash(docker compose:*)', denyAsk, program)).toBe(DOCKER_RUN)
    expect(isCarvedOut('Bash(git status:*)', denyAsk, program)).toBe(FORCE_PUSH)
    expect(isCarvedOut('Bash(git status)', denyAsk, program)).toBe(FORCE_PUSH)
    expect(isCarvedOut('Bash(ls:*)', denyAsk, program)).toBeUndefined()
  })

  it('never throws (answers carved out)', () => {
    expect(isCarvedOut('Bash(git:*)', undefined as never)).toBeDefined()
  })
})

describe('hasBashRule', () => {
  it('uses the same parser as every other question', () => {
    expect(hasBashRule(['Read(**)', 'Bash(git push --force:*)'])).toBe(true)
    expect(hasBashRule(['Bash'])).toBe(true)
    expect(hasBashRule(['Bash(*)'])).toBe(true)
    expect(hasBashRule(['  Bash(ls)  '])).toBe(true)
    expect(hasBashRule(['Read(**)', 'PowerShell(rm:*)', 'mcp__x', ''])).toBe(false)
    expect(hasBashRule([])).toBe(false)
  })

  it('never throws (answers true)', () => {
    expect(hasBashRule(undefined as never)).toBe(true)
  })
})

describe('canLaunchOtherPrograms', () => {
  it.each([
    'Bash',
    'Bash(bash:*)',
    'Bash(npm:*)',
    'Bash(bun:*)',
    'Bash(git:*)',
    'Bash(python3:*)',
    'Bash(docker:*)',
    'Bash(find:*)',
    'Bash(sed:*)',
    'Bash(awk:*)',
    'Bash(make:*)',
    'Bash(sudo ls:*)',
    'Bash(ssh:*)',
    'Bash(at:*)',
    'Bash(batch:*)',
    'Bash(parallel:*)'
  ])('%s can', (rule) => {
    expect(canLaunchOtherPrograms(rule)).toBe(true)
  })

  it.each(['Bash(ls:*)', 'Bash(cat:*)', 'Bash(pwd)', 'Bash(rg:*)', 'Read(**)', 'mcp__x'])(
    '%s cannot',
    (rule) => {
      expect(canLaunchOtherPrograms(rule)).toBe(false)
    }
  )
})

describe('isLauncherShapedSegment', () => {
  it.each([
    ['npm', 'exec', 'foo'],
    ['npm', 'x', 'foo'],
    ['npx', 'prettier'],
    ['bunx', 'foo'],
    ['bun', 'x', 'foo'],
    ['bun', '-e', 'code'],
    ['bun', '--eval=code'],
    ['bun', 'run', 'test'],
    ['node', '-e', 'code'],
    ['node', '--eval', 'code'],
    ['node', '-p', '1'],
    ['python', '-c', 'code'],
    ['python3.12', '-Sc', 'code'],
    ['perl', '-e', 'code'],
    ['ruby', '-e', 'code'],
    ['deno', 'eval', 'code'],
    ['deno', 'run', 'x.ts'],
    ['uv', 'run', 'x'],
    ['uv', 'tool', 'run', 'x'],
    ['uvx', 'x'],
    ['pipx', 'run', 'x'],
    ['bash', '-c', 'x'],
    ['sh', '-lc', 'x'],
    ['bash'],
    ['zsh', '-s'],
    ['pwsh', '-Command', 'x'],
    ['pwsh', '-c', 'x'],
    ['pwsh', '-EncodedCommand', 'eA=='],
    ['pwsh', '-enc', 'eA=='],
    ['powershell', 'Get-Date'],
    ['cmd', '/c', 'x'],
    ['cmd.exe', '/C', 'x'],
    ['eval', 'x'],
    ['exec', 'x'],
    ['env', 'x'],
    ['xargs', 'rm'],
    ['sudo', 'ls'],
    ['ssh', 'host', 'ls'],
    ['timeout', '5', 'x'],
    ['iex', 'x'],
    ['Start-Process', 'x'],
    ['docker', 'exec', 'c', 'sh'],
    ['docker', 'run', 'alpine'],
    ['git', '-c', 'alias.x=!sh', 'x'],
    ['git', '-C', 'dir', '-c', 'k=v', 'status'],
    ['git', '--exec-path=/tmp/x', 'status'],
    ['find', '.', '-exec', 'rm', '{}', ';'],
    ['find', '.', '-execdir', 'x', '{}', '+'],
    ['sed', 's/^/x/e', 'f'],
    ['sed', '-n', '1e date', 'f'],
    ['sed', '-e', 'p', '-e', 'e ls', 'f'],
    ['sed', '--expression=s/a/b/ge', 'f'],
    ['sed', '-f', 'script.sed', 'f'],
    ['awk', 'BEGIN { system("ls") }'],
    ['awk', '{ print | "sh" }'],
    ['awk', '-f', 'prog.awk'],
    ['cmd', '/r', 'x'],
    ['pwsh', '-CommandWithArgs', 'x'],
    ['pwsh', '-cwa', 'x'],
    ['python3', '-'],
    ['python'],
    ['node', '-'],
    ['kubectl', 'exec', 'pod', '--', 'sh'],
    ['kubectl', 'run', 'x', '--image=y'],
    ['sed', 'w /etc/passwd', 'f'],
    ['sed', 's/a/b/w out', 'f'],
    ['awk', '{ print > "/etc/x" }'],
    ['awk', '{ printf "%s", $1 > "out" }'],
    ['git', 'config', 'core.hooksPath', '.hooks'],
    ['git', 'config', '--global', 'alias.x', '!sh'],
    ['git', 'config', 'diff.x.textconv', 'sh'],
    ['su', '-c', 'x'],
    ['chroot', '/mnt', 'x'],
    ['flock', 'f', 'x'],
    ['unbuffer', 'x'],
    // Review r2 S21.
    ['git', 'rebase', '-x', 'make test', 'main'],
    ['git', 'rebase', '--exec', 'make test', 'main'],
    ['git', 'rebase', '--exec=make test', 'main'],
    ['git', 'rebase', '-i', '-x', 'sh', 'main'],
    ['git', 'bisect', 'run', 'make', 'test'],
    ['git', 'submodule', 'foreach', 'git pull'],
    ['git', 'submodule', '--quiet', 'foreach', 'x'],
    ['git', 'difftool', '-x', 'sh'],
    ['git', 'difftool', '--extcmd=sh'],
    ['git', 'filter-branch', '--tree-filter', 'rm x', 'HEAD'],
    ['git', 'filter-branch', '--msg-filter=sed s/a/b/'],
    ['python', '-i'],
    ['python3', '-i', 'x.py'],
    ['find', '.', '-fprint', '/etc/x'],
    ['find', '.', '-fprintf', 'out', '%p'],
    ['find', '.', '-fls', 'out'],
    ['at', 'now'],
    ['batch'],
    ['parallel', 'echo']
  ])('%j is launcher-shaped', (...tokens) => {
    expect(isLauncherShapedSegment(tokens)).toBe(true)
  })

  it.each([
    ['ls', '-la'],
    ['npm', 'install'],
    ['npm', 'test'],
    ['bun', 'test'],
    ['bun', 'install'],
    ['node', 'script.js'],
    ['python', 'script.py'],
    ['python', '-m', 'pytest'],
    ['bash', 'script.sh'],
    ['pwsh', '-File', 'x.ps1'],
    ['deno', 'fmt'],
    ['uv', 'sync'],
    ['docker', 'build', '.'],
    ['docker', 'ps'],
    ['git', 'status'],
    ['git', 'commit', '-c', 'HEAD'],
    ['git', '-C', 'dir', 'log'],
    ['find', '.', '-name', 'x'],
    ['sed', '-n', '1p', 'f'],
    ['sed', '-i', 's/a/b/g', 'f'],
    ['sed', 's/e/E/g', 'f'],
    ['awk', '{ print $1 }', 'f'],
    ['awk', '-F', '|', '{ print $1 }'],
    ['awk', '$3 > 100', 'f'],
    ['git', 'config', 'user.name', 'x'],
    ['node', '--version'],
    // Script runners, by cli.js parity (ADR §5 residual).
    ['make'],
    ['npm', 'test'],
    ['bun', 'file.ts'],
    ['tar', '--to-command=sh', '-xf', 'a.tar'],
    ['go', 'run', 'x.go'],
    // Review r2 S21: the same programs without the code-running option.
    ['git', 'rebase', '-i', 'main'],
    ['git', 'rebase', '-X', 'theirs', 'main'],
    ['git', 'bisect', 'start'],
    ['git', 'submodule', 'update', '--init'],
    ['git', 'difftool', 'HEAD~1'],
    ['git', 'filter-branch', '--prune-empty'],
    ['python', '-I', 'x.py'],
    ['find', '.', '-name', 'x', '-print']
  ])('%j is not', (...tokens) => {
    expect(isLauncherShapedSegment(tokens)).toBe(false)
  })

  it('an empty segment is not', () => {
    expect(isLauncherShapedSegment([])).toBe(false)
  })

  it('never throws (answers launcher-shaped)', () => {
    expect(isLauncherShapedSegment(undefined as never)).toBe(true)
  })
})

/**
 * Review B4 / S12: linear matching. The round-1 matcher re-scanned the tail at
 * every program position (quadratic: 20 000 repetitions took minutes) and
 * compiled globs to backtracking regexes. The bounds are generous — they exist
 * to catch a return of either, not to benchmark.
 */
describe('cost', () => {
  const timed = (fn: () => void): number => {
    const t = performance.now()
    fn()
    return performance.now() - t
  }

  it('a quoted string repeating the rule program stays linear', () => {
    const command = `echo "${'git push x '.repeat(20000)}"`
    expect(timed(() => denyAskHit(command, RULES))).toBeLessThan(2000)
    const py = `python -c "${'git push x '.repeat(5000)}"`
    expect(timed(() => denyAskHit(py, RULES))).toBeLessThan(2000)
  })

  it('a 100 KB command with every construct is cheap', () => {
    const unit =
      'for b in a; do sudo git -C . push "x $(ls)" \'q\' | sh; done && Start-Process git "x"\n'
    const command = unit.repeat(Math.ceil(100_000 / unit.length))
    expect(command.length).toBeGreaterThan(SHELL_RULES_MAX_ANALYSED_LENGTH)
    expect(timed(() => denyAskHit(command, RULES))).toBeLessThan(500)
    const under = command.slice(0, SHELL_RULES_MAX_ANALYSED_LENGTH - 1)
    expect(timed(() => denyAskHit(under, RULES))).toBeLessThan(3000)
  })

  it('per-candidate scans are shared across the segment (review r2 S25)', () => {
    const under = (unit: string): string => unit.repeat(Math.floor(60_000 / unit.length))
    for (const unit of [
      '-exec find . {} \\; ',
      '-exec docker x {} \\; ',
      '-exec git x {} \\; ',
      '-exec pwsh x {} \\; ',
      '-exec ssh h x {} \\; '
    ]) {
      const command = `find . ${under(unit)}`
      expect(
        timed(() => denyAskHit(command, RULES)),
        unit
      ).toBeLessThan(400)
    }
    expect(timed(() => denyAskHit(`${'sudo -u a '.repeat(6000)}git push`, RULES))).toBeLessThan(400)
  })

  it('a long pipeline to executors stays linear (review r2 B6)', () => {
    const command = `echo "git push" ${'| sh '.repeat(12_000)}`
    expect(timed(() => denyAskHit(command, RULES))).toBeLessThan(500)
    // Pipes into compounds, each widening the pipeline the next executor reads (review r3 B10).
    const groups = `echo "git push" ${'| (sh) '.repeat(7_000)}`
    expect(timed(() => denyAskHit(groups, RULES))).toBeLessThan(500)
  })

  it('multi-star glob words do not backtrack', () => {
    const deny = ['Bash(rm -rf ******x)']
    const token = 'a'.repeat(5000)
    expect(timed(() => denyAskHit(`rm -rf ${token}`, { deny }))).toBeLessThan(500)
  })
})
