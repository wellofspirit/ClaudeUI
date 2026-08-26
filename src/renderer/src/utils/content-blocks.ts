/**
 * Relocated to `src/shared/content-blocks.ts` (SyncCore phase 4a): the shared
 * reducer interprets the same message-upsert semantics, and two copies of this
 * merge would drift. Re-exported here so existing import sites are unchanged.
 */
export { mergeContentBlocks } from '../../../shared/content-blocks'
