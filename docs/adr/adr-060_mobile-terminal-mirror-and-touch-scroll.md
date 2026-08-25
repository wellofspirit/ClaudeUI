# ADR-060 — Mobile terminal: mirror the pty's grid, pan it horizontally, scroll it by touch

**Status:** Proposed (2026-08-25)
**Relates to:** ADR-048 (mobile surface pattern — this is the "presentation forks, machinery is shared" rule applied to the terminal), ADR-054 (read/act split — synthesized arrow keys pass through the same gate the accessory keys do), ADR-052 / `docs/architecture/security.md` (the `shell` capability and the terminal posture), ADR-002/-003 (renderer/main IPC and the host-local event lane), ADR-027 (structural test attributes)

> **Numbering note.** The kickoff spec called for `adr-059`; that number was already
> taken by _no-silent-model-fallback_, so this is 060.

## Context

The terminal takeover shipped on the phone in the mobile-parity arc (ADR-048 amendment).
Three things were broken there, and the user reported all three together:

1. **No vertical scrolling by touch, at all.** `@xterm/xterm` 6.0.0 replaced the
   native-overflow viewport with VS Code's synthetic `ScrollableElement`
   (`.xterm-scrollable-element`), which listens for `wheel` and nothing else. The vendored
   VS Code `Gesture` touch module is dead code in the bundle — its `addTarget` has zero
   call sites. Confirmed live: a wheel scrolls scrollback, a finger drag moves nothing.
2. **No horizontal scrolling.** There was no horizontal dimension to scroll: xterm is a
   grid, and the grid was fitted to the phone.
3. **A normal PowerShell command line "goes beyond the border" and the view garbles.**
   Terminals are a **per-cwd pool shared by every surface** — one pty, several viewers —
   and `PtyManager.resize` is last-writer-wins. When the pty believes a wider grid than
   the phone renders (a desktop refit at ~120 columns, or scrollback replayed from a
   120-column history), PSReadLine's absolute-cursor repaints clamp against the phone's
   ~48-column grid and smear. Phone-alone, the fit is correct and lines wrap properly.

(3) is the interesting one: it is not a rendering bug, it is a **shared-resource contention
bug**, and the two candidate cures — "let the smallest viewport win" (tmux's
`aggressive-resize off`, which makes the desktop unusable) and "let the phone win" (what
was happening) — are both wrong.

## Decision

The phone stops competing for the pty's WIDTH. It **mirrors** it and pans.

### 1. Geometry is on the wire

`PtyManager` tracks `cols`/`rows` per entry (`sizeOf(id)`), and `resize()` returns whether
the grid actually changed. On a real change it fans a `resized` notice out to every
attached remote connection — the same shape and the same attached-only rule as `data` /
`exit`. `TerminalService.resize()` additionally raises the host-local `terminal:resized`
event, because a **narrow Electron window runs the mobile fork** and therefore needs the
notice as much as a phone does.

`terminal:attach` now answers `{ ok: true, cols, rows }` (and `{ ok: false }` for a
terminal that is gone) instead of a bare boolean, on **both** lanes. A mirroring client
needs the grid at the instant it attaches; the push only ever covers later changes, and
asking afterwards would race the first bytes.

New server→client frame on the volatile lane: `term-resized { termId, cols, rows }`. It is
OUTPUT — no new gate, no ring, no audit row, exactly like `term-data` (PTY geometry is not
a secret, but it is also not an event worth replaying: a reconnecting client re-reads the
grid from its attach reply). The pre-existing **client→server** `term-resize` is a
different message and keeps its meaning.

### 2. The spawn default becomes 100×30

Was 80×24. A desktop surface refits within a frame or two, so this is invisible there. But
the phone deliberately never pushes cols, so for a pty the **phone** created, the spawn
default is the shell's width for its whole life. 80 columns is unusable for a PowerShell
prompt plus a path; 100 is a real terminal width and still cheap to pan.

### 3. Mobile sizing: mirror cols, push rows

- On attach with geometry: `term.resize(ptyCols, fittedRows)`, then push
  `resizeTerminal(ptyCols, fittedRows)` **only if the rows differ from the pty's**.
- Nothing is pushed before the attach reply lands. Pushing earlier would send xterm's
  80-column default and shrink whatever the desktop is running.
- On `terminal:resized` / `term-resized`: adopt the new cols and re-assert our rows.
- Own-box changes (ResizeObserver, tab becoming visible): **rows only**, pushed with the
  mirrored cols unchanged.
- The desktop panel is untouched: it fits both axes and ignores the event entirely.

**Convergence.** The desktop is fit-driven and never reacts, so desktop-pushes-(C,R_d) →
phone-counter-pushes-(C,R_p) → desktop-does-nothing is stable.

**Amendment to the ratified design — the two-mirror case.** The design as ratified had the
phone counter-push whenever the event's rows differed from its own. That terminates with
one mirroring surface, but **two** of them (a phone plus a narrow Electron window) with
different heights counter-push at each other forever: A pushes R_a, B is told and pushes
R_b, A is told and pushes R_a, … As built, a notice whose **cols are unchanged** is not
acted on at all. That early return is the termination argument — it swallows both the echo
of our own push and any rows-only notice — and it costs one thing: after a rows-only
change made elsewhere, the pty keeps that surface's rows and this one keeps rendering its
own. Which is the residual we were already accepting in the other direction (below).

### 4. Touch scrolling by synthesizing wheel events

A one-finger vertical drag over the xterm host is converted into `WheelEvent`s dispatched
at the element under the touch. 8px of slop before the gesture is claimed (so a tap stays a
tap and still focuses the terminal and raises the keyboard); once claimed, every
`touchmove` is `preventDefault`ed. No momentum or fling in v1.

Reusing xterm's own wheel machinery buys, for free and byte-exactly: scrollback in the
normal buffer, the alternate-buffer wheel→arrow-key conversion (so `less`, `vim`, a pager
scroll), DECCKM application-cursor encoding, and app mouse reporting. The arrow keys that
conversion produces go through `coreService.triggerDataEvent(…, true)` — i.e.
`Terminal.onData` — i.e. the **same ADR-054 read-only gate** the accessory key row uses, so
watching-state refusal and the step-up prompt apply with no extra code.

**The event has to be shaped like a real wheel, and that is not the default.** Verified by
probe against Chromium (see below): xterm reads the wheel through **two** different
properties — VS Code's `StandardWheelEvent` prefers the legacy `wheelDeltaY` whenever it is
defined, while xterm's own alt-buffer handler reads `deltaY`. A plain
`new WheelEvent('wheel', { deltaY })` in Chromium gets `wheelDeltaY === deltaY`, the
**opposite** sign convention from a real wheel event (`wheelDeltaY === -deltaY × 1.2`), so
the two paths disagree: the same synthetic event scrolls the scrollback one way and the
pager the other. The fix is to install `wheelDeltaY = -deltaY × 1.2` explicitly, which
makes the event a faithful copy and both paths agree. Scroll gain then works out to
`50/120 × 1.2 = 0.5` viewport pixels per pixel of `deltaY`, so the handler emits
`deltaY = -2 × fingerTravel` and the content tracks the finger 1:1.

### 5. A horizontal pan container (mobile only)

The mirrored grid is routinely wider than the phone, so `.xterm-screen` overflows its host
box. Nothing between it and the component's own DOM sets `overflow`, so making a wrapper a
scroll container is enough — the overflowing ink becomes real scrollable width, with no
second copy of the grid's size to keep in step. `overflow-x: auto`, `overflow-y: hidden`
(rows always fit the strip exactly, so xterm's internal scrollback is the only vertical
axis), and `touch-action: pan-x`, which is what splits the gesture space: the **browser**
owns horizontal panning, our handler owns vertical, and the axis lock in the handler stops
a diagonal from fighting the pan.

The takeover chrome (tab strip, accessory keys, read-only badge) is untouched.

## Probe evidence

Chromium via Playwright, real `@xterm/xterm@6.0.0`, 390×844 viewport, a 120×40 grid in a
390px strip (`scratchpad/wheel-probe*.mjs`):

| Check                               | Result                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| synthetic wheel drives the viewport | yes — no `isTrusted` check exists anywhere in the xterm bundle          |
| drag down 180 px                    | viewport back 180 px (gain **1.00**)                                    |
| drag up 180 px                      | viewport forward 180 px (gain **1.00**)                                 |
| alt buffer, drag down               | `ESC [ A` ×4                                                            |
| alt buffer, drag up                 | `ESC [ B` ×4                                                            |
| alt buffer + DECCKM                 | `ESC O B`                                                               |
| pan wrapper                         | `scrollWidth` 800 vs `clientWidth` 390 — scrollable, max scrollLeft 410 |
| plain `WheelEvent({deltaY})`        | **inconsistent**: normal buffer scrolls up, alt buffer sends down       |

## Consequences

- The phone can finally scroll a terminal, in both axes, and a shared shell renders
  identically on both surfaces because both are drawing the same grid.
- **Rows remain last-writer-wins** — deliberately, and the residuals are accepted, not
  bugs: a TUI opened while the phone is attached sizes to the phone's rows, and the desktop
  may show blank rows below a 20-row pty screen in a 30-row panel. This is tmux's
  small-client behavior and was already the pre-existing contract
  (`sync-core.md` §Terminal, "Resize contention: last-resize-wins").
- Alt-buffer scroll rate is xterm's, not ours: its `consumeWheelEvent` applies a 0.3×
  "likely trackpad" factor below 50 px of delta, so a slow drag moves ~0.6 lines per line of
  finger travel and a fast one moves faster. Inherited verbatim from the desktop wheel path;
  changing it would mean reimplementing the thing this design exists to reuse.
- Two versions of the wheel-shape knowledge now live in the tree (the constants in
  `terminal-touch-scroll.ts` and the table above). An xterm bump can silently change the
  gain or the sign; the header comment names the exact upstream code that decides both.
- Version skew is handled in one direction only, and that is enough: a client talking to a
  pre-060 host gets `true` from attach, never sees `terminal:resized`, and falls back to
  fitting both axes — which is exactly what it did before. The web bundle is served by the
  host it talks to, so the reverse skew cannot arise in practice.

## Alternatives considered

- **Reimplement touch scrolling against `term.scrollLines()` / arrow-key injection.**
  Rejected: it means re-deriving the alt-buffer conversion, DECCKM encoding and mouse
  reporting, and keeping three of them in step with xterm forever. Kept as the documented
  fallback if a future xterm starts rejecting untrusted wheel events.
- **Clamp the pty to the smallest attached viewport** (tmux `aggressive-resize off`).
  Rejected: it makes the desktop terminal unusable whenever a phone is attached, which is
  a strictly worse version of the reported bug.
- **Reflow the phone's grid and let the shell wrap.** That IS the current behavior when the
  phone is alone, and it is fine — but it cannot work while another surface owns a wider
  grid, which is the case that was broken.
- **A per-surface pty (no pooling).** Rejected: the shared pool is the feature — picking up
  the desktop's shell from the phone is the whole point of terminal-on-mobile.
