/** Members kept by default: the recent past is all a guard set has to answer for. */
export const BOUNDED_SET_DEFAULT_CAP = 512

/**
 * Insertion-ordered set that evicts its OLDEST member once `cap` is exceeded.
 *
 * For guards that only ever have to answer for the recent past (uuids a Claude session sent or already looked up): a member old enough to fall out
 * of the window cannot matter again, so eviction costs nothing and the set stops
 * growing for the life of a long-lived session.
 */
export class BoundedSet {
  private readonly entries = new Set<string>()

  constructor(private readonly cap: number = BOUNDED_SET_DEFAULT_CAP) {}

  /** Re-adding an existing member keeps its ORIGINAL position (Set semantics). */
  add(value: string): void {
    this.entries.add(value)
    while (this.entries.size > this.cap) {
      this.entries.delete(this.entries.values().next().value!)
    }
  }

  has(value: string): boolean {
    return this.entries.has(value)
  }

  get size(): number {
    return this.entries.size
  }
}
