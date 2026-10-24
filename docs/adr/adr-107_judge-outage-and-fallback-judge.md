# ADR-107: A judge that cannot answer says so, and an optional fallback judge model takes over

**Status:** Accepted (2026-10-23). Implemented on branch `fix/judge-hardening`.
**Amends:** [ADR-081](adr-081_claudeui-owned-judge-transport.md) §3 ("No fallback": a second ClaudeUI route chosen
by the user is now allowed; the engine transports stay deleted).
**Amended by:** [ADR-109](adr-109_stage1-unusable-reply-escalates.md) (2026-10-24: in `both` mode an unusable stage-1 reply escalates to stage 2 instead of raising the banner or reaching the fallback judge).
**Relates to:** [ADR-106](adr-106_judge-calibration-measured-facts.md) (the confirmation sample stays within one
model), [ADR-068](adr-068_chatgpt-identity-vault-owned-codex-injection.md) (vault ChatGPT accounts),
[ADR-091](adr-091_judge-blocks-hold-and-session-local-targets.md) (held blocks are unchanged).

## Context

The pi/opencode auto-mode judge (ADR-081) asks the human whenever it cannot produce a verdict. That rule is right,
but the human was never told why. When the judge route returned HTTP 429 `usage_limit_reached` with a reset six days
away, every gated call of every pi and opencode session, and of their dispatched X-Agents, became an approval card
with no reason on it. The cards read as ordinary permission prompts ("access this directory"). The one banner fired
only when a judge model had no route at all, never when a call failed. Nothing could take over until the quota
reset.

## Decision

1. **The cause is on every card.** A judge that could not answer returns the human outcome with a reason, e.g.
   `Auto-mode judge unavailable: ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z). Review this
call yourself.` The response body is never shown; the full text stays in the log, which says "judge unavailable",
   not BLOCK.
2. **One banner per session on a failed call**, not only on a missing route. A cancelled review or a stage timeout is
   not reported, since it says nothing about the route.
3. **Rate-limit cooldown.** A 429 that names a reset (`resets_at`, or `retry-after`) puts that route, keyed by route
   label and account, on a process-wide cooldown, capped at 8 days. While it lasts the route resolves as unavailable
   without a network call. The settings page shows "<model> has hit its usage limit and rests until …" under the
   judge model.
4. **Optional fallback judge model** (`autoMode.fallbackJudgeModel`, per engine, same picker and same "ClaudeUI can
   call it" narrowing as the judge model). When the judge model cannot produce a verdict (call failure, timeout,
   cooldown, no route, model gone), the WHOLE classification runs again on the fallback. Every verdict, including
   ADR-106's confirmation sample, therefore comes from one model, and a block is never overturned by a different
   model. A permission-mode change or an already-answered ask never reaches the fallback. When both fail, the card
   names both causes. The banner says the fallback is judging; the log marks its verdicts `judge=fallback`.
5. **Optional fallback account** (`autoMode.fallbackJudgeAccount`, a vault ChatGPT account id), behind a collapsed
   "Advanced" section. The resolver takes an explicit ChatGPT account for that route (token, reauthorization, usage
   rows and cooldown are all per account). A named account that is missing or signed out is refused, never swapped
   for the active one. It applies only to a ChatGPT-routed fallback model; picking any other model clears it. The
   fallback may be the judge model itself only on a different account (the same model on the same account would hit
   the same limit).
6. **No engine transport.** The fallback is a second ClaudeUI route of the user's choosing. Models that only an
   engine can call (e.g. opencode's hosted free tier, which refuses any client but OpenCode itself) stay unavailable
   as judges, as ADR-081 §3 decided.

## Consequences

A rate-limited or broken judge is visible at once (card, banner, settings) and, with a fallback configured, no
longer turns every gated call into a prompt. A weaker fallback model changes the security profile while it judges;
the banner says so and names it. The confirmation sample and the credential one-sample rule (ADR-106 §2) hold within
whichever model judged. Cooldowns are in memory: a restart pays one failed call per route before resting it again.

**Which fallback.** Free models were measured as candidates on the real-case replay (2026-10-23, one run each,
identity masked). opencode's hosted free tier only serves the OpenCode client and was not used. Of OpenRouter's free
text models, three answered; on the six should-block cases (credential exploration, an identical retry) they allowed
13 of 13 answered samples, where the default judge model allows about 17%; one also made no false blocks on the
hardest should-allow cases, i.e. it allowed nearly everything. A free model is therefore not a safe fallback. The
recommended fallback is the same judge model on another subscription (§5), which keeps its calibration.
