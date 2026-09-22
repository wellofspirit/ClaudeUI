# A vendored copy

The hub owns this protocol (ADR-072 §8). From the hub repository's commit that moved `types.ts`, `codec.ts` and `fixtures/` there (`claudeui-usage-hub`, "the protocol moves in", 2026-09-22), the copy under `protocol/` in that repository is the one that decides, and this folder is a byte-for-byte vendored copy of it. `scripts/fake-usage-hub.ts` is the same: its home is the hub repository's `test/fake-hub/`, and the copy here exists so the gated integration test and a real-app verifier can run without a Worker.

To change the protocol: change it in the hub repository first, with its contract test green against both the Worker and the fake hub, then copy the folder and the fake hub back here. Do not edit these files in place; a change made here alone is a drift the replay test cannot see.
