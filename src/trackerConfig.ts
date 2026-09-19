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

  /**
   * Hard ceiling on how many simultaneous game-state variants the tracker
   * keeps, checked after every transaction regardless of
   * approximateRefinements above.
   *
   * Each unresolved steal branches multiplicatively (one branch per resource
   * type the victim could hold), so a handful in a row without anything to
   * resolve them can explode the tree combinatorially — and when a victim's
   * holdings stay roughly balanced across those steals, every branch stays
   * above approximateRefinements' 3% cull threshold, so that flag alone
   * doesn't help. Measured directly: 625 variants took ~1.4s to recompute
   * probabilities for, 3125 took ~20s — on the UI thread, on every chat
   * message from that point on, which is exactly what a user report of the
   * extension "freezing" mid-game describes. This cap keeps only the highest-
   * probability variants once the tree passes it, trading a small chance of
   * dropping the branch that turns out to be true for staying responsive —
   * consistent with how cullImprobableOutcomes/autoResolveDominantOutcomes
   * already trade exactness for speed, just as an unconditional backstop
   * instead of a probability-gated one.
   */
  maxVariants: 150,
};
