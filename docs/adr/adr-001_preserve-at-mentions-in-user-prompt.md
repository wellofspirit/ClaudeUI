# ADR-001: Preserve `@` file mentions in user prompt text sent to SDK

**Status:** Accepted
**Date:** 2026-03-03

## Context

ClaudeUI has an InputBox component where users type prompts. Users can reference files using `@path/to/file` syntax, similar to the official Claude Code CLI.

Investigation of the SDK's bundled `cli.js` revealed that `@` mentions in user prompts and `@` includes in CLAUDE.md are handled by **two completely different mechanisms**:

### CLAUDE.md `@` includes

- Parsed at startup by a function that uses the `marked` lexer to walk the markdown AST
- Skips code blocks/codespans
- Recursively reads and inlines referenced files into a `<system-reminder>` context block
- The `@` reference itself is consumed — only the file content appears in the system prompt

### User prompt `@` mentions

- Parsed **every turn** by a regex-based extractor that scans the raw prompt text:
  - `/(^|\s)@"([^"]+)"/g` for quoted paths
  - `/(^|\s)@([^\s]+)\b/g` for unquoted paths
- Supports `#L<n>-<m>` line range suffixes (e.g., `@file.ts#L10-20`)
- Supports directories (returns `ls` listing)
- Each resolved file is read through the **Read tool** (with permission checks)
- Results are injected as **synthetic tool_use/tool_result message pairs** — making it appear to the model as if a Read tool call already happened
- The original prompt text (including the `@` reference) is sent as the user message

### The critical detail

The SDK's attachment system (`processAttachments` → `extractAtMentionedFiles` → `parseAtMentions`) extracts `@` paths from the **raw user prompt string**. It expects the `@path` text to be present verbatim in the prompt. The synthetic tool results are appended as additional messages alongside the user message — the `@` in the user text serves as the anchor that makes the fake tool results make sense to the model.

## Decision

The InputBox must **preserve `@` references as-is** in the prompt text sent to the SDK via `window.api.sendPrompt()`. Specifically:

1. **Do not strip or transform `@path` references** from the user's prompt before sending
2. **Do not attempt client-side file reading** — the SDK handles this entirely
3. Any future autocomplete/file-picker UI for `@` mentions should insert the path in the exact format the SDK expects: `@relative/path` or `@"path with spaces"`

## Consequences

- The SDK receives the full prompt text with `@` markers intact, enabling its built-in attachment pipeline to extract file paths, read content, and inject synthetic Read tool results
- The model sees both the user's `@file` reference in the prompt AND the corresponding tool result, maintaining coherent context
- File permission checks are handled by the SDK's Read tool validation, not by our UI
- We don't need to duplicate any file-reading logic in the renderer process
