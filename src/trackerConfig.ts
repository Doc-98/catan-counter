// trackerConfig.ts
// Tuning switches for the variant tracker.

export const trackerConfig = {
  /**
   * Approximate refinements: cull outcome branches below 3% probability and
   * auto-resolve steals once one outcome reaches >= 95%. These trade a small
   * chance of being wrong for a tighter tree and a shorter unknown-transaction
   * list; a wrong guess self-heals via the force-apply contradiction handling.
   *
   * Off by default: with this off the tracker is exact — it only ever states
   * what provably follows from the chat. Exact inference (certainty
   * resolution, convergence collapse, hand-count pruning) is always active
   * regardless of this flag.
   */
  approximateRefinements: false,
};
