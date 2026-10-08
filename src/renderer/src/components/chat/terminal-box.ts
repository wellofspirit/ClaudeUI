/**
 * Max height (CSS px, border-box) of a tool-output terminal box: 10 rows of
 * `text-[12px] leading-[1.3]` plus `p-2` (16) = 172.
 *
 * ONE number for every box that shows a Bash command's output, because a card
 * swaps one for another in place: the live box (`LiveBashOutput`) is replaced by
 * the result box (`TerminalView`) the moment the command finishes. If the two caps
 * differ the card jumps by the difference, and a chat pinned to the bottom drops
 * and snaps back (a 300 px live box under a 172 px result box moved it 150-375 px).
 * `estimate-height.ts` imports this for the same reason, so it must stay a plain
 * module: no DOM, no React.
 */
export const TERMINAL_BOX_MAX_HEIGHT = 10 * 12 * 1.3 + 16
