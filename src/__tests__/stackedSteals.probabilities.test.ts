import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { placeSettlement, playerGetResources, unknownSteal } from '../gameActions';
import { game, resetGameState } from '../gameState';
import { PropbableGameState } from '../probableGameState';
import { RESOURCE_TYPES } from '../variants';

// Mock only the overlay to avoid DOM dependencies
jest.mock('../overlay', () => ({
  updateGameStateDisplay: jest.fn(),
}));

/**
 * Regression coverage for a real bug found while testing: after several
 * unresolved (unknown-resource) steals land back to back — no resolving
 * chat message in between — a player's uncertainty for a single resource
 * can genuinely spread across more than one extra card. The old
 * `additionalResourceProbabilities` API only ever exposed a single blended
 * "probability of more than the minimum" number per resource, which
 * silently folded a real "25% chance of *two* extra" into the same figure
 * as "62% chance of *one* extra" — producing numbers that looked
 * plausible in isolation but didn't add up once you dug into what they
 * actually represented.
 */
describe('resource probabilities after several stacked unknown steals', () => {
  beforeEach(() => {
    resetGameState();

    placeSettlement('Alice');
    placeSettlement('Bob');
    placeSettlement('Carol');

    game.probableGameState = new PropbableGameState(game.players);

    playerGetResources('Alice', { tree: 2, brick: 1, sheep: 1 });
    playerGetResources('Bob', { wheat: 2, ore: 1, sheep: 1 });
    playerGetResources('Carol', { brick: 2, tree: 1, ore: 1 });

    jest.clearAllMocks();
  });

  it('exposes a full probability ladder once a resource spreads more than one card beyond the minimum', () => {
    // Six unresolved steals, none of them resolved by chat — the exact
    // shape of scenario reported as "felt off" during manual testing.
    unknownSteal('Alice', 'Bob');
    unknownSteal('Bob', 'Carol');
    unknownSteal('Carol', 'Alice');
    unknownSteal('Alice', 'Bob');

    const bob = game.probableGameState.getPlayerResourceProbabilities('Bob');

    // Bob's wheat genuinely spans 3 possible values by this point (0, 1, or
    // 2), not just "minimum or minimum+1" — the old API had no way to say
    // that. This locks in the exact distribution from the investigation.
    expect(bob.minimumResources.wheat).toBe(0);
    expect(bob.additionalResourceProbabilitySteps.wheat).toHaveLength(2);
    const [pAtLeastOne, pAtLeastTwo] = bob.additionalResourceProbabilitySteps.wheat;
    expect(pAtLeastOne).toBeCloseTo(0.875, 5);
    expect(pAtLeastTwo).toBeCloseTo(0.25, 5);

    // The old single-number field must still equal the first rung, so
    // anything still reading it (e.g. gameActions' heuristic) keeps working.
    expect(bob.additionalResourceProbabilities.wheat).toBeCloseTo(
      pAtLeastOne,
      10
    );
  });

  it('keeps every ladder non-increasing and consistent with the single-number field, for every player and resource', () => {
    unknownSteal('Alice', 'Bob');
    unknownSteal('Bob', 'Carol');
    unknownSteal('Carol', 'Alice');
    unknownSteal('Alice', 'Bob');
    unknownSteal('Bob', 'Carol');
    unknownSteal('Carol', 'Alice');

    for (const playerName of ['Alice', 'Bob', 'Carol']) {
      const probabilities =
        game.probableGameState.getPlayerResourceProbabilities(playerName);

      for (const resource of RESOURCE_TYPES) {
        const steps = probabilities.additionalResourceProbabilitySteps[resource];

        // P(at least min+1) >= P(at least min+2) >= ... — each rung is a
        // strict superset of the outcomes behind the rung after it.
        for (let i = 0; i < steps.length - 1; i++) {
          expect(steps[i]).toBeGreaterThanOrEqual(steps[i + 1] - 1e-9);
        }

        // Every probability is a real probability.
        steps.forEach(p => {
          expect(p).toBeGreaterThan(0); // trailing zero rungs aren't stored
          expect(p).toBeLessThanOrEqual(1 + 1e-9);
        });

        expect(probabilities.additionalResourceProbabilities[resource]).toBeCloseTo(
          steps[0] ?? 0,
          10
        );
      }
    }
  });

  it('never trims the ladder to just one rung when the true spread is wider', () => {
    // Same sequence as above, but confirm at least one player/resource pair
    // ends up needing more than one rung — i.e. this scenario really does
    // exercise the multi-card case, not just a single-card one.
    unknownSteal('Alice', 'Bob');
    unknownSteal('Bob', 'Carol');
    unknownSteal('Carol', 'Alice');
    unknownSteal('Alice', 'Bob');

    const anyMultiRung = ['Alice', 'Bob', 'Carol'].some(playerName => {
      const probabilities =
        game.probableGameState.getPlayerResourceProbabilities(playerName);
      return RESOURCE_TYPES.some(
        resource =>
          probabilities.additionalResourceProbabilitySteps[resource].length > 1
      );
    });

    expect(anyMultiRung).toBe(true);
  });
});
