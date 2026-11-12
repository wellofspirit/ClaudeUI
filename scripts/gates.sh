#!/usr/bin/env bash
# The commit gate, with exit codes that cannot be masked by pipes: typecheck, lint, the format of
# the files this branch changed, and the whole default test suite (CI runs the same set). About
# 45 s on a fast machine.
#
#   scripts/gates.sh            (`--full` is accepted and means the same, for older callers)
#   scripts/gates.sh --force    run even though this exact tree already passed
#
# A green run records the hash of the tree it ran on: every tracked file and every untracked file
# git does not ignore. A later run on an identical tree says so and exits 0 without running anything.
# It is the whole gate or nothing: there is no mode that checks only what changed (tried and
# removed, ae130def). The hash cannot see what git ignores (node_modules, vendor/, the caches):
# after changing those, pass --force.
#
# Works in a git worktree without its own node_modules (it resolves the main checkout's).
#
# Never pipe this into a filter before acting on its result: `gates.sh | tail && git commit`
# takes tail's exit code.
#
# A failed test run is never retried. A "non-zero exit, zero failed tests" retry would also match an
# unhandled error, which is how a cross-file leak shows up under vmForks (ADR-113), and hide it once.
set -uo pipefail

cd "$(dirname "$0")/.."

force=0
case "${1:-}" in
  ''|--full) ;;
  --force) force=1 ;;
  *) echo "usage: scripts/gates.sh [--force]" >&2; exit 2 ;;
esac

# The hash of the working tree's content: what `git add -A && git write-tree` would print, computed
# in a scratch index so the real index and whatever is staged stay untouched. Prints nothing when
# git cannot compute it, and then nothing is skipped and nothing is recorded.
tree_hash() {
  local index tree
  index="$(git rev-parse --git-path "gates-index.$$" 2>/dev/null)" || return 0
  # Starting from the real index keeps its stat cache, so unchanged files are not hashed again.
  cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null
  tree="$(GIT_INDEX_FILE="$index" git add -A . >/dev/null 2>&1 &&
    GIT_INDEX_FILE="$index" git write-tree 2>/dev/null)"
  rm -f "$index"
  printf '%s' "$tree"
}

# The format step checks the files changed since this commit, so a pass is a fact about the tree AND
# this base: both go into the record.
format_base="$(git merge-base HEAD "${GATES_BASE:-origin/pre-release}" 2>/dev/null)"
stamp="$(git rev-parse --git-path gates-green 2>/dev/null)"
tree_before="$(tree_hash)"
key="$tree_before ${format_base:-all}"

if [ "$force" = 0 ] && [ -n "$tree_before" ] && [ -n "$stamp" ] && [ -f "$stamp" ] &&
  [ "$(cat "$stamp")" = "$key" ]; then
  echo "== ALL GATES GREEN (this exact tree already passed: ${tree_before:0:12}; --force runs it again)"
  exit 0
fi

start=$(date +%s)

echo "== typecheck"
bun run typecheck || exit 1

echo "== lint"
bunx eslint --cache . || exit 1

# CI checks the format of every file (`bun run format:check`, about a minute without its cache).
# Here: the files changed since the merge base with the PR target, and the untracked ones. Every
# other file is the base's own, which CI checked when it merged.
if [ -n "$format_base" ]; then
  echo "== format (files changed since ${format_base:0:9})"
  # Listed first, on its own: a git failure here must fail the step, not leave it with no files.
  changed_list="$(git -c core.quotepath=off diff --name-only --diff-filter=ACMR "$format_base" &&
    git -c core.quotepath=off ls-files --others --exclude-standard)" || exit 1
  changed=()
  while IFS= read -r file; do
    [ -f "$file" ] && changed+=("$file")
  done <<< "$changed_list"
  if [ "${#changed[@]}" -gt 0 ]; then
    # In batches: a branch that touches hundreds of files would not fit one Windows command line.
    printf '%s\0' "${changed[@]}" | xargs -0 -n 100 bunx prettier --check --ignore-unknown || exit 1
  fi
else
  echo "== format (no merge base with ${GATES_BASE:-origin/pre-release}: every file)"
  bun run format:check || exit 1
fi

echo "== test"
bunx vitest run --project unit --project unit-node --project unit-forks --project component \
  --project e2e --project browser || exit 1

# Recorded only for a tree that was the same before and after: a file edited while the gate ran, or
# one a test left behind, means no single tree passed.
tree_after="$(tree_hash)"
if [ -n "$tree_before" ] && [ "$tree_before" = "$tree_after" ] && [ -n "$stamp" ]; then
  printf '%s\n' "$key" > "$stamp"
else
  echo "(the tree changed while the gate ran, or git could not hash it: this pass is not recorded)"
fi

echo "== ALL GATES GREEN ($(( $(date +%s) - start ))s)"
