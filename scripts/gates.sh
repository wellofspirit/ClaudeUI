#!/usr/bin/env bash
# The commit gates, with exit codes that cannot be masked by pipes.
#
#   scripts/gates.sh            fast gate: typecheck, lint of the changed files, and the tests
#                               related to the changed files (vitest's module graph)
#   scripts/gates.sh --full     everything: typecheck, lint, the whole default suite (run before a PR;
#                               CI runs the same set)
#   scripts/gates.sh --base <ref>   compare against <ref> instead of the merge-base with
#                               origin/pre-release
#
# "Changed" = committed since the base + uncommitted + untracked. A change to the test setup or
# the build/test configuration makes the fast gate run the whole suite.
#
# Works in a git worktree without its own node_modules (it resolves the main checkout's).
#
# Never pipe this into a filter before acting on its result: `gates.sh | tail && git commit`
# takes tail's exit code.
#
# A failed test run is never retried. The old "non-zero exit, zero failed tests" retry also matched an
# unhandled error, which is how a cross-file leak shows up under vmForks, so it would have hidden one
# once. If the fork-pool teardown crash (Windows) recurs it fails loudly: narrow a retry to its
# actual text then.
set -uo pipefail

cd "$(dirname "$0")/.."

MODE=fast
BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full) MODE=full ;;
    --base) BASE="$2"; shift ;;
    *) echo "usage: scripts/gates.sh [--full] [--base <ref>]" >&2; exit 2 ;;
  esac
  shift
done

PROJECTS=(--project unit --project unit-node --project unit-forks --project component --project e2e --project browser)
REPORT=.cache/gates/vitest.json
mkdir -p .cache/gates

start=$(date +%s)
elapsed() { echo "$(( $(date +%s) - start ))s"; }

# --- what changed -------------------------------------------------------------------------------
CHANGED=()
if [ "$MODE" = fast ]; then
  if [ -z "$BASE" ]; then
    BASE=$(git merge-base HEAD origin/pre-release 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null || echo HEAD)
  fi
  while IFS= read -r f; do
    [ -n "$f" ] && [ -f "$f" ] && CHANGED+=("$f")
  done < <( { git diff --name-only --diff-filter=ACMR "$BASE"; git ls-files --others --exclude-standard; } | sort -u)
  echo "== fast gate: ${#CHANGED[@]} changed file(s) since $(git rev-parse --short "$BASE")"
  for f in "${CHANGED[@]}"; do
    case "$f" in
      package.json|bun.lock|vitest.config.*|tsconfig*.json|eslint.config.*|src/test/setup/*|src/test/stubs/*)
        echo "   $f changed: running the whole suite"
        MODE=full
        break ;;
    esac
  done
fi

# --- typecheck (incremental) --------------------------------------------------------------------
echo "== typecheck"
bun run typecheck || exit 1

# --- lint ---------------------------------------------------------------------------------------
echo "== lint"
if [ "$MODE" = full ]; then
  bunx eslint --cache . || exit 1
else
  LINT=()
  for f in "${CHANGED[@]}"; do
    case "$f" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) LINT+=("$f") ;; esac
  done
  if [ ${#LINT[@]} -gt 0 ]; then
    bunx eslint --cache --no-warn-ignored "${LINT[@]}" || exit 1
  else
    echo "   no lintable changes"
  fi
fi

# --- tests --------------------------------------------------------------------------------------
run_tests() {
  rm -f "$REPORT"
  if [ "$MODE" = full ]; then
    bunx vitest run "${PROJECTS[@]}" --reporter=default --reporter=json --outputFile.json="$REPORT"
  else
    bunx vitest related --run "${PROJECTS[@]}" --passWithNoTests \
      --reporter=default --reporter=json --outputFile.json="$REPORT" "${CHANGED[@]}"
  fi
}

echo "== test ($MODE)"
if [ "$MODE" = fast ] && [ ${#CHANGED[@]} -eq 0 ]; then
  echo "   nothing changed: no tests to run"
else
  run_tests || exit 1
fi

echo "== ALL GATES GREEN ($MODE, $(elapsed))"
