#!/usr/bin/env bash
# Run a command against this checkout on a real Linux host (M5-L).
#
# ClaudeUI has no Linux desktop build and therefore no Linux job that ever starts
# the pinned `codex`, so "Linux works" cannot be asserted from macOS or from CI as
# it stands. This script is the evidence path: it builds
# `scripts/docker/codex-linux.Dockerfile` for one architecture, copies the
# checkout in, installs dependencies and runs whatever you ask — by default the
# typecheck, the protocol check and the Codex integration suites.
#
#   scripts/docker/codex-linux-verify.sh --arch x64
#   scripts/docker/codex-linux-verify.sh --arch arm64 -- bun run check-codex-protocol
#   scripts/docker/codex-linux-verify.sh --arch x64 --no-bwrap -- <command…>
#
# Flags:
#   --arch x64|arm64   the target architecture (linux/amd64 or linux/arm64).
#   --no-bwrap         build the image WITHOUT bubblewrap, to see the server's
#                      boot warning fire. Separate image and volumes.
#   --keep             keep the container after it exits (docker cp / docker start -ai).
#   -- <command…>      the command to run instead of the default.
#
# THE HOST CHECKOUT IS NEVER WRITTEN. The repo is bind-mounted READ-ONLY at
# `/src`, the container refuses to proceed if that mount turns out to be
# writable, and everything actually runs against a COPY at `/work`. The copy rule
# is `git ls-files --cached --others --exclude-standard`: everything git tracks
# plus untracked files that are not ignored — which is precisely how
# `node_modules`, `vendor`, `.cache`, `out`, `dist` and `.git` itself stay out,
# without a hand-maintained exclusion list that could drift from `.gitignore`.
#
# `/work/node_modules`, `/work/vendor`, the bun install cache and the Electron
# cache are per-arch NAMED VOLUMES, so the (slow) first `bun install` and the
# (large) Codex download are paid once per architecture. They survive `docker rm`;
# `docker volume rm claudeui-codex-linux-<arch>-*` resets them.
#
# The container runs with seccomp and AppArmor unconfined and `SYS_ADMIN`,
# because Codex's sandbox is bubblewrap and bubblewrap needs to create a user
# namespace, which Docker's default seccomp profile blocks. That is a property of
# the VERIFICATION host, not advice for a deployment: a stock Linux box needs no
# such relaxation (see docs/architecture/codex.md for the Ubuntu 24.04 AppArmor
# caveat that produces the same symptom).
set -euo pipefail

arch=''
keep=0
bwrap=1
command=()

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch="${2-}"; shift 2 ;;
    --keep) keep=1; shift ;;
    --no-bwrap) bwrap=0; shift ;;
    --) shift; command=("$@"); break ;;
    *) echo "codex-linux-verify: unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$arch" in
  x64) platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "codex-linux-verify: --arch must be x64 or arm64" >&2; exit 2 ;;
esac

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
suffix="$arch"
[ "$bwrap" = 1 ] || suffix="$arch-nobwrap"
image="claudeui-codex-linux:$suffix"
volume="claudeui-codex-linux-$suffix"

if [ ${#command[@]} -eq 0 ]; then
  command=(bash -lc 'bun run typecheck && bun run check-codex-protocol && bunx vitest run --project integration src/integration/codex')
fi

echo "codex-linux-verify: building $image for $platform (bubblewrap=$bwrap)"
docker build \
  --platform "$platform" \
  --build-arg "WITH_BUBBLEWRAP=$bwrap" \
  -f "$repo/scripts/docker/codex-linux.Dockerfile" \
  -t "$image" \
  "$repo/scripts/docker"

# The in-container preamble. Everything before the user's command: prove /src is
# read-only, copy the checkout, install.
read -r -d '' preamble <<'PREAMBLE' || true
set -euo pipefail
# The read-only mount is a GUARD, not a convention: if this checkout is writable
# from inside the container, a test that writes to the repo would corrupt the
# developer's working tree, so refuse rather than run.
if touch /src/.codex-linux-verify-writable 2>/dev/null; then
  rm -f /src/.codex-linux-verify-writable
  echo 'codex-linux-verify: /src is writable; refusing to run against the host checkout' >&2
  exit 1
fi
git config --global --add safe.directory /src
cd /src
# Tracked files plus untracked-and-not-ignored ones; ignored trees (node_modules,
# vendor, .cache, out, dist) and .git never appear in this list.
git ls-files -z --cached --others --exclude-standard > /tmp/copy-list
tar -C /src --null --files-from /tmp/copy-list -cf - | tar -C /work -xf -
cd /work
echo "codex-linux-verify: $(uname -m) / node $(node -v) / bun $(bun --version) / bwrap $(command -v bwrap || echo '(absent)')"
bun install
PREAMBLE

# `--init`: without a reaping PID 1 an orphaned grandchild stays a zombie, its
# process GROUP stays alive, and the integration suites' "no app-server group
# survived disposal" check fails on a container artefact rather than on anything
# the product did. tini reaps, which is what a real box's init does.
run=(docker run --platform "$platform"
  --init
  --security-opt seccomp=unconfined
  --security-opt apparmor=unconfined
  --cap-add SYS_ADMIN
  -e CODEX_INTEGRATION=1
  -v "$repo:/src:ro"
  -v "$volume-node-modules:/work/node_modules"
  -v "$volume-vendor:/work/vendor"
  -v "$volume-bun-cache:/root/.bun/install/cache"
  -v "$volume-electron-cache:/root/.cache/electron"
  -w /work)
[ "$keep" = 1 ] || run+=(--rm)
if [ -t 0 ]; then run+=(-t); fi

exec "${run[@]}" "$image" bash -lc "$preamble"'
'"$(printf '%q ' "${command[@]}")"
