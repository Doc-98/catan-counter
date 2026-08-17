// Refinement passes that keep the unknown-transaction list short: culling
// vanishingly-unlikely outcome branches and auto-resolving dominant ones.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { placeSettlement } from '../gameActions';
import { game, resetGameState } from '../gameState';
import { PropbableGameState } from '../probableGameState';
import { trackerConfig } from '../trackerConfig';
import { TransactionTypeEnum } from '../types';

jest.mock('../overlay', () => ({
  updateGameStateDisplay: jest.fn(),
}));

afterEach(() => {
  trackerConfig.approximateRefinements = false;
});

function setup(victimResources: Record<string, number>) {
  resetGameState();
  placeSettlement('Thief');
  placeSettlement('Victim');
  game.probableGameState = new PropbableGameState(game.players);
  game.probableGameState.processTransaction({
    type: TransactionTypeEnum.RESOURCE_GAIN,
    playerName: 'Victim',
    resources: victimResources,
  });
  game.probableGameState.processTransaction({
    type: TransactionTypeEnum.ROBBER_STEAL,
    stealerName: 'Thief',
    victimName: 'Victim',
    stolenResource: null,
  });
}

describe('autoResolveDominantOutcomes', () => {
  it('stays exact with approximateRefinements off (the default)', () => {
    // 95% wheat, but the flag is off: the steal must stay an open question.
    setup({ wheat: 19, sheep: 1 });
    expect(game.probableGameState.getUnknownTransactions()).toHaveLength(1);
  });

  it('resolves a steal once one outcome is >= 95% likely', () => {
    trackerConfig.approximateRefinements = true;
    // Victim holds 19 wheat + 1 sheep: the steal is 95% wheat.
    setup({ wheat: 19, sheep: 1 });

    const transactions = (game.probableGameState as any).transactionProcessor
      .unknownTransactions;
    expect(transactions).toHaveLength(1);
    expect(transactions[0].isResolved).toBe(true);
    expect(transactions[0].resolvedResource).toBe('wheat');
    expect(game.probableGameState.getUnknownTransactions()).toHaveLength(0);
  });

  it('leaves genuinely uncertain steals unresolved', () => {
    trackerConfig.approximateRefinements = true;
    // 75% wheat is not certain enough to resolve.
    setup({ wheat: 3, sheep: 1 });
    expect(game.probableGameState.getUnknownTransactions()).toHaveLength(1);
  });
});

describe('cullImprobableOutcomes', () => {
  it('drops outcome branches below epsilon and keeps the rest', () => {
    setup({ wheat: 3, sheep: 1 });
    const pgs: any = game.probableGameState;
    const transaction = pgs.getUnknownTransactions()[0];

    // With a raised epsilon the 25% sheep branch is culled, leaving only
    // wheat — which then auto-resolves the transaction.
    pgs.transactionProcessor.cullImprobableOutcomes(0.3);
    pgs.resolveAllUnknownTransactions();

    expect(pgs.getUnknownTransactions()).toHaveLength(0);
    expect(
      pgs.transactionProcessor.getUnknownTransaction(transaction.id)
        .resolvedResource
    ).toBe('wheat');
    // The sheep branch is gone from the tree: the thief holds wheat now.
    const leaves = pgs.variantTree.getCurrentVariantNodes();
    expect(leaves).toHaveLength(1);
    expect(leaves[0].gameState['Thief'].resources.wheat).toBe(1);
  });

  it('never culls every outcome of a transaction', () => {
    setup({ wheat: 1, sheep: 1 });
    const pgs: any = game.probableGameState;

    // Both outcomes are 50% — below an absurd epsilon, but culling all
    // options would destroy real information, so nothing is removed.
    pgs.transactionProcessor.cullImprobableOutcomes(0.9);

    expect(pgs.getUnknownTransactions()).toHaveLength(1);
    expect(pgs.variantTree.getCurrentVariantNodes()).toHaveLength(2);
  });

  it('retires unknowns once all variants converge on the same present', () => {
    // Round-trip steal: Thief takes an unknown card from Victim, then Victim
    // steals it right back (Thief holds nothing else). Whether the card was
    // wheat or sheep, every hand ends identical — the history is unknowable
    // AND irrelevant, so it must not linger as an open question.
    setup({ wheat: 1, sheep: 1 });
    expect(game.probableGameState.getUnknownTransactions()).toHaveLength(1);

    game.probableGameState.processTransaction({
      type: TransactionTypeEnum.ROBBER_STEAL,
      stealerName: 'Victim',
      victimName: 'Thief',
      stolenResource: null,
    });

    expect(game.probableGameState.getUnknownTransactions()).toHaveLength(0);
    const pgs: any = game.probableGameState;
    const leaves = pgs.variantTree.getCurrentVariantNodes();
    expect(leaves).toHaveLength(1);
    expect(leaves[0].gameState['Victim'].resources).toMatchObject({
      wheat: 1,
      sheep: 1,
    });
    expect(leaves[0].gameState['Thief'].resources).toMatchObject({
      wheat: 0,
      sheep: 0,
    });
  });

  it('default epsilon leaves ordinary two-way steals alone', () => {
    setup({ wheat: 1, sheep: 1 });
    const pgs: any = game.probableGameState;
    const probs = pgs.getTransactionResourceProbabilities(
      pgs.getUnknownTransactions()[0].id
    );
    expect(probs.wheat).toBeCloseTo(0.5);
    expect(probs.sheep).toBeCloseTo(0.5);
  });
});
