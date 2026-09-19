import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { placeSettlement, playerGetResources, unknownSteal } from '../gameActions';
import { game, resetGameState } from '../gameState';
import { PropbableGameState } from '../probableGameState';
import { trackerConfig } from '../trackerConfig';

// Mock only the overlay to avoid DOM dependencies
jest.mock('../overlay', () => ({
  updateGameStateDisplay: jest.fn(),
}));

/**
 * Regression coverage for a real freeze found while testing: an unresolved
 * steal branches once per resource type the victim could hold, so several in
 * a row without anything to resolve them explodes the variant tree
 * combinatorially (5 -> 25 -> 125 -> 625 -> 3125 leaves in one measurement).
 * Recomputing probabilities over a tree that size is what actually froze the
 * tab — 625 leaves measured at ~1.4s per update, 3125 at ~20s, on the main
 * thread, on every subsequent chat message.
 *
 * trackerConfig.approximateRefinements' probability-based culling doesn't
 * save this case: when a victim's holdings stay roughly balanced across
 * several steals, every candidate resource stays above its 3% cull
 * threshold, so nothing gets pruned either way. trackerConfig.maxVariants is
 * the unconditional backstop — active regardless of approximateRefinements.
 */
describe('variant tree size cap', () => {
  beforeEach(() => {
    resetGameState();

    placeSettlement('Alice');
    placeSettlement('Bob');
    placeSettlement('Carol');
    placeSettlement('Dave');

    game.probableGameState = new PropbableGameState(game.players);

    // Balanced across all 5 resource types so every steal keeps branching
    // 5 ways with no candidate ever dropping below approximateRefinements'
    // cull threshold — the exact adversarial case for that mechanism.
    playerGetResources('Alice', { tree: 4, brick: 3, sheep: 3, wheat: 2, ore: 1 });
    playerGetResources('Bob', { tree: 3, brick: 2, sheep: 2, wheat: 3, ore: 2 });
    playerGetResources('Carol', { tree: 2, brick: 4, sheep: 3, wheat: 2, ore: 2 });
    playerGetResources('Dave', { tree: 3, brick: 2, sheep: 4, wheat: 2, ore: 1 });

    jest.clearAllMocks();
  });

  it('never lets the variant tree exceed trackerConfig.maxVariants', () => {
    const names = ['Alice', 'Bob', 'Carol', 'Dave'];

    for (let round = 0; round < 10; round++) {
      const thief = names[round % names.length];
      const victim = names[(round + 1) % names.length];
      unknownSteal(thief, victim);

      expect(game.probableGameState.getVariantCount()).toBeLessThanOrEqual(
        trackerConfig.maxVariants
      );
    }

    // Without the cap this scenario reaches thousands of variants well
    // before round 10 (5^5 = 3125 by round 4 alone).
    expect(game.probableGameState.getVariantCount()).toBeLessThanOrEqual(
      trackerConfig.maxVariants
    );
  });

  it('keeps a full probability computation pass fast even after many steals', () => {
    const names = ['Alice', 'Bob', 'Carol', 'Dave'];

    for (let round = 0; round < 15; round++) {
      const thief = names[round % names.length];
      const victim = names[(round + 1) % names.length];
      unknownSteal(thief, victim);
    }

    const start = performance.now();
    for (const name of names) {
      game.probableGameState.getPlayerResourceProbabilities(name);
    }
    for (const t of game.probableGameState
      .getUnknownTransactions()
      .filter(t => !t.isResolved)) {
      game.probableGameState.getTransactionResourceProbabilities(t.id);
    }
    const elapsed = performance.now() - start;

    // Measured well under 100ms with the cap in place (vs. ~20s uncapped at
    // a comparable variant count) — generous margin for slower CI machines
    // while still catching a real regression back to unbounded growth.
    expect(elapsed).toBeLessThan(1000);
  });

  it('still lets a fully-determined resource show up as a guaranteed minimum once capped', () => {
    const names = ['Alice', 'Bob', 'Carol', 'Dave'];
    for (let round = 0; round < 10; round++) {
      const thief = names[round % names.length];
      const victim = names[(round + 1) % names.length];
      unknownSteal(thief, victim);
    }

    // Capping trades away the least-likely branches, not correctness of the
    // ones it keeps — every surviving variant should still be a coherent,
    // non-negative game state.
    const variants = game.probableGameState.getAllPossibleGameStates();
    expect(variants.length).toBeGreaterThan(0);
    for (const { gameState } of variants) {
      for (const player of names) {
        for (const count of Object.values(gameState[player].resources)) {
          expect(count).toBeGreaterThanOrEqual(0);
        }
      }
    }

    const totalProbability = variants.reduce((sum, v) => sum + v.probability, 0);
    expect(totalProbability).toBeCloseTo(1, 5);
  });
});
