#!/usr/bin/env bash
# The commit gates, with exit codes that cannot be masked by pipes.
#
# Exists because `bun run test 2>&1 | grep "Test Files"` returns grep's exit
# code, not the suite's — a trap that has swallowed real failures more than
# once. Run this instead of ad-hoc pipelines before every commit.
#
# Note on the vitest fork-pool teardown crash (Windows): vitest 4.1.10 made it
# rare but has NOT provably eliminated it. Its signature is "N-1 or N-2 files
# passed, zero test failures, clean on re-run". This script retries the suite
# once to absorb it; two consecutive failures are real.
set -uo pipefail

echo "== typecheck"
bun run typecheck || exit 1
echo "== lint"
bunx eslint --cache . || exit 1
echo "== test"
if ! bun run test; then
  echo "== test failed once — retrying (teardown-crash signature check)"
  bun run test || exit 1
fi
echo "== ALL GATES GREEN"
