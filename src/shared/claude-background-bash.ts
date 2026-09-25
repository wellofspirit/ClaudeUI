/**
 * The tool_result Claude Code returns for a Bash call whose command went on
 * running in the background. One upstream function builds the text (2.1.280
 * `mEn`, `.cache/pristine-cli.js` @8213182), in four phrasings:
 *
 *   run_in_background     Command running in background with ID: <id>. Output is being written to: <path>.
 *   "Send to background"  Command was manually backgrounded by user with ID: <id>. Output is being written to: <path>.
 *   a message arrived     Command was moved to the background (ID: <id>) so that a message … Output is being written to: <path>.
 *   a timeout             Command did not complete within its <n>s timeout and was moved to the background (ID: <id>). Output is being written to: <path>.
 *
 * Guidance for the model follows on the same line ("You will be notified when
 * it completes. …"), so the path ends at its `<id>.output` file name (upstream
 * `Ec`), not at the end of the line. The sentence starts a line of its own: any
 * stdout and stderr come first, joined with "\n" (the Bash tool's
 * `mapToolResultToToolResultBlockParam`, @10973501). Anchoring on the line start
 * keeps a command that merely prints the phrase, such as a grep over these
 * sources, from reading as a backgrounded one.
 */

const TASK_ID_RE =
  /^Command (?:running in background with ID:|was manually backgrounded by user with ID:|(?:was|did not complete within its \d+s timeout and was) moved to the background \(ID:)\s*([\w-]+)/m

const OUTPUT_FILE_RE = /Output is being written to:\s*(.+?\.output)(?=\.?(?:\s|$))/

/** The background task's id, when `text` is the tool_result of a backgrounded command. */
export function backgroundBashTaskId(text: string): string | undefined {
  return TASK_ID_RE.exec(text)?.[1]
}

/** The file a backgrounded command's output is being written to, when `text` names one. */
export function backgroundBashOutputFile(text: string): string | undefined {
  return OUTPUT_FILE_RE.exec(text)?.[1]
}
