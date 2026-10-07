/**
 * How long ClaudeUI's own opencode server lingers idle after a read-only lease
 * (credential, catalog and auth reads; S7, ADR-097 §5): a burst of reads
 * reuses one server instead of starting and ending one per read. Its own
 * module so importers need not load the server manager to read it.
 */
export const READ_LINGER_MS = 60_000
