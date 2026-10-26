#!/usr/bin/env bash
# The commit gate, with exit codes that cannot be masked by pipes: typecheck, lint and the whole
# default test suite (CI runs the same set). About 45 s on a fast machine, so there is no partial
# "fast" mode: a change-scoped run saved little and needed its own rules for what counts as changed.
#
#   scripts/gates.sh            (`--full` is accepted and means the same, for older callers)
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

case "${1:-}" in
  ''|--full) ;;
  *) echo "usage: scripts/gates.sh" >&2; exit 2 ;;
esac

start=$(date +%s)

echo "== typecheck"
bun run typecheck || exit 1

echo "== lint"
bunx eslint --cache . || exit 1

echo "== test"
bunx vitest run --project unit --project unit-node --project unit-forks --project component \
  --project e2e --project browser || exit 1

echo "== ALL GATES GREEN ($(( $(date +%s) - start ))s)"
