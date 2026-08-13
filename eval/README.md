# Bundle-split eval

A fixed-point benchmark on this repo snapshot: give a coding agent the question in
`question.md` and compare its analysis against the reference answers in `results/`.

The commit that adds this directory (branch `bench/bundle-size`) is the eval point —
the repo state every candidate is evaluated against. Build outputs referenced by the
question come from `bun run build:mac` at this commit (`[5/8] web build` =
`vite build --config vite.web.config.ts`).

## Running a candidate

1. Check out the eval-point commit.
2. Copy the working tree to a scratch location, then **delete `.git/` and `eval/` from
   the copy** — candidates must not see git history, prior results, or this harness, so
   they can't cheat.
3. Point the agent at the copy as its working directory and give it `question.md`
   verbatim as the prompt.
4. Save the agent's answer to `eval/results/<model>.md` on this branch.

## Grading

Each result is scored blind (see `mapping.md` for the anonymization used in the first
round): overall quality 1–10, correctness 1–10, effectiveness 1–10, and whether the
true issue was identified (T/F). Verify factual claims against the repo — key ground
truth lives in `vite.web.config.ts`, `src/web/main.tsx`, and
`src/main/services/remote-server.ts` (`serveStatic`), plus the built chunk sizes in
`out/web/assets/`.
