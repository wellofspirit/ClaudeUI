# ADR-109: A stage-1 reply that answers unusably escalates to stage 2, and is abandoned as soon as it opens off-format

**Status:** Accepted (2026-10-24). Implemented on branch `fix/judge-stage1-escalate`.
**Amends:** [ADR-023](adr-023_opencode-automode-classifier.md) (the "transport error at either stage → `unavailable`"
deviation no longer covers an unusable stage-1 reply in `both` mode),
[ADR-083](adr-083_judge-policy-rebalance-and-permission-context.md) §2 (what stage 1 escalates on),
[ADR-107](adr-107_judge-outage-and-fallback-judge.md) (the "can't judge here" banner and the fallback judge are no
longer reached by an unusable reply).
**Relates to:** [ADR-081](adr-081_claudeui-owned-judge-transport.md) §4 (the client-side budget and stop cut on the
ChatGPT route), [ADR-088](adr-088_dispatch-autonomy-inheritance.md) (dispatch targets are judged by the same pipeline).

## Context

In `both` mode, stage 1 answers one tag, `<severity>N</severity>`, at the lowest reasoning effort the model accepts
(`none` on GPT-6 Luna) and a 64-token budget. The ChatGPT route accepts no output cap and no stop sequence, so the
budget is enforced client-side as 1,024 characters and the stop cut at `</severity>`.

GPT-6 Luna at effort `none` sometimes writes its deliberation into the visible reply instead of the tag ("We need
assess the proposed action …"). Measured on one day of captured judge calls (ADR-081 transport, judge-reply
capture on):

- 282 stage-1 calls on ordinary work: 9 opened off-format (3%); 2 of those ran past the budget (6.5 s and 7.7 s)
  and the rest parsed late (3.0–4.6 s, every grade 0–5). Compliant replies: p50 1.7 s, p90 2.5 s.
- Sessions whose own subject was the judge (transcripts quoting its grammar, delegation chains, conflicting user
  instructions): 47 of 125 off-format, 5 over budget, one stream killed by the provider's usage-policy check
  (`invalid_prompt`) mid-deliberation. Renaming the quoted `<severity>` tags in those transcripts changed the rate
  little (22/48 → 18/48 in a replay), so the subject matter, not the quoted grammar, drives it.
- Replaying one over-budget call 102 times: 6 off-format; four other calls 0 of 80.
- Once, the stream completed with a single assistant message whose text was empty (4 output tokens billed, no text
  delta, `output_text.done` with `""`); a replay of that call reproduced it 1 time in 42.

An over-budget reply threw, `classify()` turned the throw into `unavailable`, and the action went to the human with
the session's "Auto-mode can't judge here" banner — although the route was healthy and the model had answered.

## Decision

1. **An unusable stage-1 reply escalates.** In `both` mode, a stage-1 reply that opens off-format, runs past its
   budget, or completes with no visible text sends the action to stage 2, whose verdict is final, exactly like an
   unparseable grade already did. The transport keeps throwing on all three conditions, with a `JudgeWireError` coded
   `judge:off-format`, `judge:over-budget` or `judge:empty`; only `classify()`'s `both`-mode stage 1 turns those
   codes into an escalation. Every other stage-1 failure (HTTP error, timeout, abort, missing route, and a reply
   whose reasoning used the whole budget, which is a judge-configuration problem) stays `unavailable`. `fast` mode
   and stage 2 keep their verdict semantics.
2. **An off-format reply is abandoned at once.** The stage-1 request names the prefixes the reply may open with
   (`<severity>`, and `<thinking>` because the severity parser strips thinking blocks). The reader checks the kept
   text after each delta, ignoring leading whitespace and case, and throws as soon as the text can no longer become
   any of them — usually on the first delta, about a second in — and the stream is cancelled. `<think>` is not
   allowed (the parser does not strip it); a fence, a bold tag or a zero-width character opens off-format and
   escalates. A request without prefixes is not checked.
3. **No banner for an unusable reply** (off-format and over budget in any mode; an empty reply on stage 1 only). The
   model answered and the route is fine; the banner is shown once per session and its copy ("every gated action will
   ask you … change the judge model") is wrong for a per-reply event. In `fast` mode and stage 2 the human card still
   gives the cause. An empty reply is the exception: it stays quiet only on the escalating stage-1 request, because
   elsewhere it may be a judge that never answers (a model that writes only into its reasoning channel, a gateway that
   sends nothing), which the banner must name.
4. **The fallback judge is not consulted** when stage 1 escalates and stage 2 decides; it still runs when that
   stage 2 fails, as for any unavailable result.
5. **Observability.** The verdict log line carries `s1=off-format` / `s1=over-budget` / `s1=empty` on an escalation (on the
   `stage=error` warning too, when stage 2 then fails); the judge-eval report keeps the field. Judge-reply capture
   records an abandoned call as an error with the text that arrived.

## Consequences

- About 3% of stage-1 calls on ordinary work now go to stage 2 instead of parsing late: the late parses cost
  ~2.7 s more each, the over-budget ones ~6 s less, and nothing reaches the human for a healthy route. Sessions
  about the judge itself escalate far more often; stage 2 is the stage built for their intent questions.
- A deliberating stage 1 can no longer talk itself into a clearing grade: content that steers stage 1 into
  prose now meets stage 2, which an attacker could already force with any grade above the threshold.
- A provider usage-policy kill on a compliant reply is still `unavailable`.

## Alternatives considered

- **Strict structured output** (`text.format` json_schema) on the ChatGPT route: accepted by the backend but not
  enforced — 3 of 60 replies still leaked prose, one was then killed by the usage-policy check — and it pushed
  grades sharply down (mean 13.9 → 2.5 on one call), an unvalidated safety shift.
- **Stage-1 effort `low`**: 0 of 40 leaks on one call, but ADR-083 §2 measured a slower real-case tail and the
  sample is too small to rule out a few-percent rate.
- **OpenAI's Decisions API** (`POST /v1/decisions`, typed answers, no explanation): API-key only; the ChatGPT
  subscription endpoint does not serve it (404), and the platform endpoint refuses the subscription token (401).
- **Only escalate on overflow** (no prefix check): keeps late-parsing deliberations at stage 1 and the ~7 s wait
  before an overflow escalates.
- **A larger stage-1 budget**: most deliberations would end in a grade, at 6–10 s, with no stage-2 review of a reply
  the model itself found hard.
- **Turning overflow into a truncated `length` result**: would change `fast` mode and stage 2 (unparseable → block
  instead of → human) and could salvage a half-written verdict.
