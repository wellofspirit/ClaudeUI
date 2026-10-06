# ADR-092: No viewport units inside SessionView's zoom: size against a zoomed box, or divide by `uiFontScale`

**Status:** Accepted (2026-10-06).
**Relates to:** [ADR-073](adr-073_agent-roster-and-task-run-identity.md) §9 (the roster overlay, where the trap
was first measured), [ADR-048](adr-048_mobile-surface-pattern.md) (the mobile surfaces that live partly inside
and partly outside the zoomed root), [ADR-027](adr-027_test-data-attributes.md) (the test ids the layout tests
assert on).

## Context

`SessionView` renders the whole app under CSS `zoom: uiFontScale` (1 to 1.5), on a root whose width and height it
already divides by the scale (`width: calc(100vw / scale)`, `height: calc(100dvh / scale)`). Inside that subtree
every `vw`, `vh`, `dvh`, `svh` and `lvh` length is multiplied by the zoom, while `getBoundingClientRect()` reports
page px. A box written as a fraction of the viewport therefore comes out `scale` times too big. `shared/use-anchored-menu.ts`
documents the same trap for fixed menus.

It shipped broken twice, in two places, and neither was visible to a jsdom test (which evaluates no layout):

- **The agent overlay on the owner's phone** (412 px wide, `uiFontScale` 1.1): `w-[min(420px,calc(100vw-32px))]`
  rendered 380 px at scale 1, 418 px at 1.1 and 570 px at 1.5, so at 1.1 its left edge was 15 px off the screen.
- **The desktop dialogs in a small window** (1280 x 640): the MCP dialog's `maxHeight: 85vh` is 106% of the window at
  1.25 and 128% at 1.5. Its top edge measured -16 px and -83 px; the header and the footer's Close button were
  off-window. The same shape sat in the Skills, Permissions, Remote access, provider-editor and sign-in dialogs, and
  in the mobile config sheet (`min(80dvh, 32rem)`: harmless only while its content was shorter than the cap,
  since at 1.5 the cap itself was taller than a 728 px phone).

## Decision

**Inside the zoomed root, write no viewport unit.** (ChatPanel's message list is a second zoom, `chatFontScale / uiFontScale`, nested in the first; the same rule applies inside it.) Size against something already in zoomed px:

1. **A percentage of a box that is.** A modal inside a `fixed inset-0` backdrop uses the backdrop as its reference:
   `max-h-[85%]`, `max-w-[95%]`, `w-[min(620px,94%)]`, `max-w-[calc(100%-2rem)]`. The overlay sits in the composer and
   uses `max-w-full`. A percentage `max-height` only works against a parent with a definite height; every backdrop here
   is `fixed inset-0`, which has one. Check that before switching an auto-height parent's child to `%`.
2. **Or divide by `uiFontScale`.** Where there is no box to be a percentage of (a dropdown positioned off a small
   trigger), cap against the window and divide: `maxWidth: calc((100vw - 32px) / ${uiFontScale})`, as `SettingsDialog`
   and `SheetFrame` already did.

**Sanctioned exceptions**, each carrying `// eslint-disable-next-line no-restricted-syntax -- <why>`:

| Site                                                        | Why it is fine                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `SessionView.tsx` (the root: `100vw`, `100dvh`, `h-screen`) | It IS the zoomed root, and divides by `uiFontScale`.                                                        |
| `SettingsDialog/View.tsx`, `SheetFrame.tsx`                 | They divide by `uiFontScale`.                                                                               |
| `terminal/TerminalPanel/TerminalMobileView.tsx`             | Hosted outside the zoomed root (`SessionView` mounts it after the zoomed `div` closes), so its px are real. |
| `shared/DirectoryBrowserDialog.tsx`                         | Portalled to `document.body`: outside the zoomed root.                                                      |
| `web/main.tsx` (the "Loading..." screen)                    | Renders before, and outside, `SessionView`.                                                                 |
| `WelcomeScreen/View.tsx` (`h-screen`)                       | Not mounted anywhere in production (nothing imports it outside its own tests).                              |

**A lint guard** keeps it from coming back. Two selectors are APPENDED to the renderer block's existing
`no-restricted-syntax` array in `eslint.config.mjs` (a second config object for the same files would replace the
sealed-field selectors, not add to them): a string `Literal` or `TemplateElement` containing a number followed by
`vw|vh|dvh|svh|lvh`, and the Tailwind classes `(min-|max-)?(h|w)-(screen|dvh|svh|lvh)`. The message names the zoom
trap, points at `shared/use-anchored-menu.ts`, and says to size against a zoomed box (%) or divide by `uiFontScale`.

**A layout test** covers the class: `McpDialogLayout.browser.test.tsx` renders the MCP dialog inside `ZoomFrame` at
scale 1, 1.25 and 1.5 in a 1280 x 640 window and asserts its panel, its header Close and its footer Close are inside
the window (Layer 2b, `docs/testing-strategy.md`). Reverting the fix fails it at 1.25 and 1.5.

## Consequences

- A new dialog written with `max-h-[85vh]` fails lint at the line, with the reason and the two ways out.
- The sanctioned sites are the whole list of places the rule is switched off; adding one means writing the reason.
- The rule is syntactic: it cannot tell a `vh` in a comment-free string that is NOT a CSS length (rare), and it does
  not see a unit built at runtime. The layout test is the backstop for those.
- `main.css`'s `html`/`body` `100vh`/`100dvh` are outside the zoomed root and not linted (CSS is not scanned).
