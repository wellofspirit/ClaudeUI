# Linux verification host for the Codex engine (M5-L).
#
# ClaudeUI ships no Linux DESKTOP build, so there is no Linux runner in the
# desktop matrix and nothing on CI ever starts the pinned Linux `codex`. This
# image is that missing host: it is what `scripts/docker/codex-linux-verify.sh`
# runs acquisition, the protocol check, the server build and the Codex
# integration suites inside, on both `linux/amd64` and `linux/arm64`.
#
# Pins, and why each is the one it is:
#   - node:24.15.0-bookworm-slim — the exact Node the workflows pin (see the
#     libuv note in ci.yml), on the Debian the release tarball targets.
#   - bun 1.4.2 — the repo's package manager, from the npm registry so the
#     version is an integrity-checked package rather than a curl|sh of latest.
#   - bubblewrap — Codex's Linux sandbox. NOT a manifest member (it is a distro
#     package by decision), and the reason this image can exercise a sandboxed
#     command at all. `--no-bwrap` on the script builds a variant without it to
#     prove the server's boot warning.
#   - git, python3, make, g++, ca-certificates — `bun install` rebuilds native
#     addons (better-sqlite3, node-pty) from source on Linux.
FROM node:24.15.0-bookworm-slim

ARG BUN_VERSION=1.4.2
ARG WITH_BUBBLEWRAP=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    git \
    make \
    python3 \
  && if [ "$WITH_BUBBLEWRAP" = "1" ]; then \
       apt-get install -y --no-install-recommends bubblewrap; \
     fi \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "bun@${BUN_VERSION}" && bun --version

# The repo is COPIED in at run time (from the read-only /src mount), never built
# into the image: the image is the host, the checkout is the payload.
WORKDIR /work
