# ADR-087 — Transcript images are content-addressed blobs off the ring, and canonical drops an exited session's transcript

**Status:** Accepted (2026-10-01, owner-ruled; branch `state-sync-size`)
**Amends:** [ADR-051](adr-051_sync-core-replication-architecture.md) (what the ring and the
snapshot carry; canonical no longer keeps every transcript for the life of the process),
[ADR-049](adr-049_image-viewer-and-image-content-pipeline.md) Decisions 3 and 5 (a transcript image
is a `{mediaType, blobId, bytes}` ref, not inline `base64Data`; the gallery's `data:`-URI `WeakMap`
caches are replaced by the client blob cache)
**Relates to:** [ADR-043](adr-043_senduserfile-files-widget.md) (the `/sent-file` HTTP route
this deliberately does NOT copy), [ADR-052](adr-052_remote-auth-passkeys-capabilities.md) (the
`chat` capability that gates the fetch), [ADR-056](adr-056_headless-admission-model.md) (the
E2E channel the bytes stay inside), [ADR-027](adr-027_test-data-attributes.md) (testids)

## Context

A remote client took minutes to sync against a host running one long session. Measured on that
session with the real history readers:

|                                             | JSON        | of which base64 images |
| ------------------------------------------- | ----------- | ---------------------- |
| main transcript (414 messages, 131 images)  | 59.4 MB     | 58.2 MB                |
| 7 subagent transcripts (545 images)         | 213.4 MB    | 207.8 MB               |
| **that session's share of one `sync-full`** | **~273 MB** | 97%                    |
| the same share as an E2E frame              | ~364 MB     |                        |

The belief that "the ring is bounded, so sync is bounded" was wrong in three independent ways:

1. **The ring bounds only catchup.** A client with `lastSeq === 0` (every page load — the cursor is
   memory-only), a stale epoch, or a cursor the ring has rolled past gets a `sync-full`, and a
   snapshot is all of canonical state: every session's `messages` and `subagentMessages`.
2. **The ring is bounded by entries, not bytes.** 5000 entries each carrying a 1 MB screenshot is
   5 GB of catchup; the ring never promised otherwise.
3. **Canonical never evicted.** A session whose engine had exited kept its whole transcript on the
   host until the process ended, so snapshot size also grew with uptime — worst on a headless
   server, which is exactly the host that runs for days.

Images rode inline as base64 on `tool_result.images`, on `image`/`document` blocks, and on the
`attachments` of `session:user-message` and queue items — every one of those ringed and
snapshotted. Past ~400 MB of canonical JSON the E2E frame's base64 step also exceeds V8's string
limit; `sendOn` logs the encrypt failure and the client simply never receives its snapshot.

## Decision

### 1. Image and document bytes leave the replication lanes

- The host interns the bytes in a **content-addressed, in-memory, LRU-bounded store**
  (`BlobStore`, 1 GiB of decoded bytes). `blobId` is the SHA-256 of the decoded bytes, so the same
  screenshot arriving from a live event, a transcript re-read and a subagent file is one entry.
- Everything replicated carries a **`BlobRef` `{ blobId, bytes }`** in place of `base64Data`:
  `ToolResultImage`, the `image` and `document` content blocks, and the attachments of
  `session:user-message` and of queue items. The interning happens at the producers — the shared
  tool-result decoder, each engine's mapper, the history readers, and `sendPrompt` — so the reducer
  never sees a byte. `base64Data` survives only on an **upload** (`AttachmentUpload`, the
  `sendPrompt` argument an engine needs), which is an invoke argument and never ringed.
- Clients fetch through a new query, **`blob:get`** (`chat` capability), cache the result, and
  resolve an image only as it nears the viewport.

**Why an invoke and not an HTTP route.** `/sent-file` is plain HTTP behind a scoped URL token; on
the LAN origin and through the tunnel it is outside the E2E channel. Transcript images were inside
the encrypted snapshot until now, and a screenshot of the operator's screen is conversation
content, not a deliberately delivered artifact. Moving them to an HTTP route would have been a
quiet downgrade, so the fetch rides the same authenticated, encrypted lane the snapshot does. The
cost is that the browser's HTTP cache cannot hold them; a client-side LRU does.

**Why `chat`.** A `chat` grant reads these exact bytes inside the snapshot today. `blob:get` is the
same data on a narrower lane, not a new authority. The id is a 256-bit content hash, so it is not
enumerable, and knowing one is evidence of having been sent the transcript that names it.

**Why memory-only.** Canonical state is memory-only; a host restart re-reads transcripts and
re-interns every blob they contain. A store that outlived the process would need its own retention
policy for nothing. The honest consequence: a blob the LRU dropped is **unavailable** until a
transcript that contains it is read again, and the client renders that as a quiet placeholder.

### 2. Canonical drops the transcript of a session with no live engine

- On `session:status` → `disconnected` (Claude, opencode and Codex report engine exit this way;
  pi's stop reports `idle` with `sdkActive` still true, a pre-existing pi quirk left for its own
  follow-up, so a stopped pi session is not evicted), and when a watched session stops being
  watched, `SyncCore.evictTranscript` strips `messages`, `subagentMessages` and the item streams
  and clears `seeded`, keeping the row and every light field. A transcript that is already empty
  is left alone — a spawned-but-never-prompted session has nothing to drop and must not be told
  to read from disk.
- It is a **host cache decision, not an event** — the mirror of the client's `evictLocalSessions`.
  Connected replicas keep the transcript they already folded; nothing blanks.
- The snapshot says so: `PerSessionSnapshot.seeded: false` means "canonical does not hold this
  transcript" — whether the host dropped it or a resume's history read is still in flight. A client
  reads `sdkActive` to tell the two apart: a dead one is marked evicted (the sidebar click then
  reloads it from disk, the path a locally evicted session already takes) and, when it is the
  session on screen, is reloaded and replaced in one step; a live one is filled from disk the way
  a follower of a resume already is (fill-only, so an in-flight turn is never wiped). An evicted
  entry always RESUMES on send — the resume decision must not key on "has messages", or a prompt
  typed before the reload lands would start a new conversation under the old row — and the chat
  shows its loading state, not the welcome screen, while the active entry is evicted.
- The async history seed is now **awaited by `sendPrompt`**. `seedSession` only fills an empty
  transcript, so a prompt that beat the read used to leave canonical with a one-turn transcript
  marked complete; eviction would have turned that rare race into the common path.

## Consequences

- A snapshot is bounded by the **text of live sessions**. The measured session's share falls from
  ~273 MB to single-digit MB; ring entries are small again, so 5000 of them is a real bound.
- The host no longer holds base64 strings on the V8 heap; image bytes are off-heap `Buffer`s, once.
- Opening an image-heavy chat costs fetches proportional to what is scrolled into view, not to the
  transcript.
- **Accepted bounds.** An LRU-evicted blob shows as unavailable. A resumed session re-reads its
  transcript from disk on the host (a cost paid once per respawn, where it used to be zero). A
  client resyncing onto an exited session shows its last-known transcript until the disk read
  lands; the replacement is a disk load, so it carries what the transcript file carries — message
  ids are re-minted and the thinking-duration label (never persisted) is gone. A client that syncs
  mid-resume and whose fill is refused by live events already folded shows the tail until its next
  resync. The snapshot invariant (`restore(N) + fold === canonical@head`) holds on everything but
  a transcript evicted AFTER the snapshot was taken (plus the todos / sentFiles derived from it),
  which the invariant test masks for exactly those sessions and compares everywhere else. Neither a byte budget on the ring nor a
  disk tier for blobs is taken here.

## Alternatives considered

- **Compress the snapshot.** PNG base64 and ciphertext do not compress; rejected.
- **Scope the snapshot per client** (the `sync` frame names the sessions it wants). A live session
  the client did not ask for would then fold events into a transcript with no prefix; fixing that
  needs a transcript-at-seq fetch and a replace seed for live sessions — a larger protocol change
  than the problem that remains once images are refs. Not taken.
- **Persist `lastSeq`** so reloads catch up instead of resyncing. Helps the reload case only, and
  leaves catchup unbounded in bytes; a possible follow-up, not a fix.
- **Evict through the reducer** (a ringed `transcript-evicted` event). Every replica would strip,
  including one showing the session, which would then have to refetch what it was already
  displaying. A host-private eviction has the same memory effect with no client churn.
