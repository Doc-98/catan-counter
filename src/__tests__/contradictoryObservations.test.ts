// Chat messages are ground truth: when an observed event is impossible in
// every variant (typically because messages were missed, e.g. after a page
// refresh where the history replay left a gap), the tracker must not eliminate
// every variant. Doing so used to cascade into removing the tree's root, which
// threw "Cannot remove root node" mid-prune — aborting processTransaction
// before resolveAllUnknownTransactions ran, and freezing half-pruned unknown
// transactions in the overlay (e.g. shown as "Could be: wheat: 1.00" yet never
// resolved).

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { placeSettlement } from '../gameActions';
import { game, resetGameState } from '../gameState';
import { PropbableGameState } from '../probableGameState';
import { TransactionTypeEnum } from '../types';

jest.mock('../overlay', () => ({
  updateGameStateDisplay: jest.fn(),
}));

describe('observations that contradict every variant', () => {
  beforeEach(() => {
    resetGameState();
    placeSettlement('Toland');
    placeSettlement('Emalee');
    game.probableGameState = new PropbableGameState(game.players);

    // Emalee has 1 wheat + 1 sheep, then Toland steals an unknown resource
    // from her: the tree branches into a stole-wheat and a stole-sheep variant.
    game.probableGameState.processTransaction({
      type: TransactionTypeEnum.RESOURCE_GAIN,
      playerName: 'Emalee',
      resources: { wheat: 1, sheep: 1 },
    });
    game.probableGameState.processTransaction({
      type: TransactionTypeEnum.ROBBER_STEAL,
      stealerName: 'Toland',
      victimName: 'Emalee',
      stolenResource: null,
    });
    expect(game.probableGameState.getUnknownTransactions()).toHaveLength(1);
  });

  it('a trade impossible in every variant does not crash or corrupt the tree', () => {
    // Emalee gives 1 brick — she has no brick in either variant, so this
    // contradicts the entire tree (as happens when the trade that gave her the
    // brick was in a gap of missed messages).
    expect(() =>
      game.probableGameState.processTransaction({
        type: TransactionTypeEnum.TRADE,
        player1: 'Emalee',
        player2: 'Toland',
        resourceChanges: { brick: -1, ore: 1 },
      })
    ).not.toThrow();

    // The steal's uncertainty is untouched: both possibilities survive instead
    // of one branch being half-pruned and frozen at probability 1.00.
    const transaction = game.probableGameState.getUnknownTransactions()[0];
    const probabilities =
      game.probableGameState.getTransactionResourceProbabilities(
        transaction.id
      );
    expect(probabilities).toEqual({
      tree: 0,
      brick: 0,
      sheep: 0.5,
      wheat: 0.5,
      ore: 0,
    });
  });

  it('a trade offer impossible in every variant does not crash', () => {
    expect(() =>
      game.probableGameState.processTransaction({
        type: TransactionTypeEnum.TRADE_OFFER,
        playerName: 'Emalee',
        offeredResources: { brick: 2 },
      })
    ).not.toThrow();
    expect(game.probableGameState.getUnknownTransactions()).toHaveLength(1);
  });
});
