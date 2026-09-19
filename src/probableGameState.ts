import { VariantTree, VariantNode, GameState, RESOURCE_TYPES } from './variants';
import { VariantTransactionProcessor } from './variantTransactions';
import { trackerConfig } from './trackerConfig';
import {
  ResourceObjectType,
  TransactionType,
  TransactionTypeEnum,
  PlayerType,
  UnknownTransaction,
} from './types';

function updateResourceAmount(
  resources: ResourceObjectType,
  resourceType: keyof ResourceObjectType,
  amount: number
): void {
  resources[resourceType] += amount;
}

function getResourceAmount(
  resources: ResourceObjectType,
  resourceType: keyof ResourceObjectType
): number {
  return resources[resourceType];
}

function isValidResourceType(
  resourceType: string
): resourceType is keyof ResourceObjectType {
  return RESOURCE_TYPES.includes(resourceType as keyof ResourceObjectType);
}

export class PropbableGameState {
  private variantTree: VariantTree;
  private transactionProcessor: VariantTransactionProcessor;
  private transactionHistory: TransactionType[];

  constructor(initialPlayers: PlayerType[]) {
    // Initialize game state with players and their known starting resources
    const initialGameState: GameState = {};
    this.transactionHistory = [];

    for (const player of initialPlayers) {
      initialGameState[player.name] = {
        resources: { ...player.resources }, // Copy the initial resources
      };
      // set initial transactions
      this.transactionHistory.push({
        type: TransactionTypeEnum.RESOURCE_GAIN,
        playerName: player.name,
        resources: { ...player.resources },
      });
    }

    this.variantTree = new VariantTree(initialGameState);
    this.transactionProcessor = new VariantTransactionProcessor(
      this.variantTree
    );
  }

  /**
   * Get all unknown transactions
   */
  getUnknownTransactions(): UnknownTransaction[] {
    return this.transactionProcessor.getUnresolvedTransactions();
  }

  /**
   * Get unknown transaction by ID
   */
  getUnknownTransaction(id: string): UnknownTransaction | undefined {
    return this.transactionProcessor.getUnknownTransaction(id);
  }

  /**
   * Resolve unknown transaction by specifying what resource was stolen
   */
  resolveUnknownTransaction(
    id: string,
    resolvedResource: keyof ResourceObjectType
  ): boolean {
    return this.transactionProcessor.resolveUnknownTransaction(
      id,
      resolvedResource
    );
  }

  /**
   * Resolve all unknown transactions by looking at possible variants
   * if there doesn't exist a node with that transaction id then mark it as resolved
   * if there is only one node mark all transactions as resolved, never mark a transaction
   * as unresolved in this function
   */
  resolveAllUnknownTransactions(): void {
    const unresolvedTransactions = this.getUnknownTransactions();

    for (const transaction of unresolvedTransactions) {
      // Get all current leaf nodes that have this transaction in their chain
      const allLeafNodes = this.variantTree.getCurrentVariantNodes();
      const transactionNodes = allLeafNodes.filter(node =>
        node.hasTransactionId(transaction.id)
      );

      if (transactionNodes.length === 0) {
        // No nodes exist with this transaction ID - variants have been pruned away
        // Mark as resolved but we don't know what resource was stolen
        transaction.isResolved = true;
      } else if (transactionNodes.length === 1) {
        // Only one variant remains - we can determine what resource was stolen
        const remainingNode = transactionNodes[0];

        // Find the stolen resource by looking at the transaction chain
        const stolenResource = this.findStolenResourceInChain(
          remainingNode,
          transaction.id
        );

        if (stolenResource) {
          // Resolve the transaction with the determined resource
          this.transactionProcessor.resolveUnknownTransaction(
            transaction.id,
            stolenResource
          );
        } else {
          // Mark as resolved even if we can't determine the resource
          transaction.isResolved = true;
        }
      } else {
        // Multiple nodes exist - check if they all have the same stolen resource for this transaction
        const stolenResources = new Set<string>();

        for (const node of transactionNodes) {
          const stolenResource = this.findStolenResourceInChain(
            node,
            transaction.id
          );
          if (stolenResource) {
            stolenResources.add(stolenResource);
          }
        }

        if (stolenResources.size === 1) {
          // All variants agree on what resource was stolen
          const stolenResource = Array.from(
            stolenResources
          )[0] as keyof ResourceObjectType;
          this.transactionProcessor.resolveUnknownTransaction(
            transaction.id,
            stolenResource
          );
        }
      }
      // If multiple nodes exist with different stolen resources, leave the transaction unresolved
    }
  }

  /**
   * Full refinement cycle for unknown transactions: cap runaway tree growth,
   * resolve what's certain, cull vanishingly-unlikely outcome branches,
   * auto-resolve dominant ones, then resolve again (culling can leave a
   * transaction with one option).
   */
  private refineUnknownTransactions(): void {
    // Unconditional, regardless of approximateRefinements below — see
    // trackerConfig.maxVariants. Runs first so everything after it (here and
    // in every render that follows) operates on an already-bounded tree
    // instead of paying to compute over one that's already exploded.
    this.variantTree.capVariantCount(trackerConfig.maxVariants);
    this.resolveAllUnknownTransactions();
    if (trackerConfig.approximateRefinements) {
      this.transactionProcessor.cullImprobableOutcomes();
      this.transactionProcessor.autoResolveDominantOutcomes();
    }
    // When every variant agrees on the current hands, remaining branches are
    // purely historical (e.g. a card that made a round trip) — collapse them
    // so stale steals stop showing as open questions.
    if (this.variantTree.collapseIfConverged()) {
      console.log(
        '🧹 All variants converged on one game state — retiring historical unknowns'
      );
    }
    this.resolveAllUnknownTransactions();
  }

  /**
   * Prune variants using known per-player hand sizes (read from colonist's
   * `[data-player-information-container]` panel). Any variant in which a player's
   * total resource cards doesn't match their known count is impossible and is
   * removed. This resolves steals the chat alone can't — notably after a monopoly,
   * when variants disagree on how many cards a player kept.
   *
   * Safe no-op unless a strict, non-empty subset of variants matches all the given
   * counts, so contradictory or non-discriminating data never empties or collapses
   * the tree (and we never try to remove the root).
   */
  pruneByHandCounts(handCounts: { [playerName: string]: number }): void {
    const nodes = this.variantTree.getCurrentVariantNodes();
    if (nodes.length <= 1) return; // nothing to disambiguate

    const matchesCounts = (node: VariantNode): boolean =>
      Object.entries(handCounts).every(([playerName, count]) => {
        const playerState = node.gameState[playerName];
        if (!playerState) return true; // unknown player -> no constraint
        const total = RESOURCE_TYPES.reduce(
          (sum, resourceType) => sum + playerState.resources[resourceType],
          0
        );
        return total === count;
      });

    const validNodes = nodes.filter(matchesCounts);

    // Ignore contradictory (none match) or non-discriminating (all match) data.
    if (validNodes.length === 0 || validNodes.length === nodes.length) return;

    for (const node of nodes) {
      if (!matchesCounts(node)) {
        this.variantTree.removeVariantNode(node);
      }
    }

    this.variantTree.pruneInvalidNodes();
    this.refineUnknownTransactions();
  }

  /**
   * Find the stolen resource for a specific transaction in a node's chain
   */
  private findStolenResourceInChain(
    node: VariantNode,
    transactionId: string
  ): keyof ResourceObjectType | null {
    let current: VariantNode | null = node;

    while (current) {
      if (current.transactionId === transactionId && current.stolenResource) {
        return current.stolenResource;
      }
      current = current.parent;
    }

    return null;
  }

  /**
   * Process a transaction
   */
  processTransaction(transaction: TransactionType): void {
    // Add transaction to history for debugging
    this.transactionHistory.push(transaction);

    switch (transaction.type) {
      case TransactionTypeEnum.ROBBER_STEAL: {
        if (transaction.stolenResource) {
          // Known steal - we know exactly what was stolen
          this.processKnownSteal(
            transaction.stealerName,
            transaction.victimName,
            transaction.stolenResource
          );
        } else {
          // Unknown steal - create probability branches
          this.transactionProcessor.processUnknownSteal(
            transaction.stealerName,
            transaction.victimName
          );
        }
        break;
      }

      case TransactionTypeEnum.MONOPOLY: {
        this.transactionProcessor.processMonopoly(
          transaction.playerName,
          transaction.resourceType,
          transaction.totalStolen
        );
        break;
      }

      case TransactionTypeEnum.TRADE: {
        this.transactionProcessor.processTrade(
          transaction.player1,
          transaction.player2,
          transaction.resourceChanges
        );
        break;
      }

      case TransactionTypeEnum.TRADE_OFFER: {
        this.transactionProcessor.processTradeOffer(
          transaction.playerName,
          transaction.offeredResources
        );
        break;
      }

      case TransactionTypeEnum.RESOURCE_GAIN: {
        this.processResourceGain(transaction.playerName, transaction.resources);
        break;
      }

      case TransactionTypeEnum.RESOURCE_LOSS: {
        this.processResourceLoss(transaction.playerName, transaction.resources);
        break;
      }

      case TransactionTypeEnum.BANK_TRADE: {
        this.processBankTrade(
          transaction.playerName,
          transaction.resourceChanges
        );
        break;
      }

      default:
        // This should never happen with proper typing, but keeping for safety
        const exhaustiveCheck: never = transaction;
        console.warn(
          `Unknown transaction type: ${(exhaustiveCheck as any).type}`
        );
    }

    // Auto-resolve any transactions that can now be determined
    this.refineUnknownTransactions();
  }

  /**
   * Process a known steal (we know exactly what resource was stolen)
   */
  private processKnownSteal(
    stealerName: string,
    victimName: string,
    resourceType: keyof ResourceObjectType
  ): void {
    const currentNodes = this.variantTree.getCurrentVariantNodes();

    const stealIsPossible = (node: VariantNode): boolean => {
      const victimState = node.gameState[victimName];
      return (
        !!victimState &&
        !!node.gameState[stealerName] &&
        getResourceAmount(victimState.resources, resourceType) > 0
      );
    };

    // The chat is ground truth: the steal happened. If it's impossible in
    // EVERY variant, our tracking is wrong (e.g. messages were missed after a
    // page refresh) — force-apply it (clamped at zero) rather than eliminating
    // every variant, which would throw on root removal.
    const anyPossible = currentNodes.some(stealIsPossible);
    if (!anyPossible) {
      console.warn(
        `⚠️ ${stealerName} stole ${resourceType} from ${victimName}, but no variant allows it — force-applying (messages may have been missed)`
      );
    }

    for (const node of currentNodes) {
      const gameState = node.gameState;
      const victimState = gameState[victimName];
      const stealerState = gameState[stealerName];

      if (stealIsPossible(node)) {
        // Execute the steal
        updateResourceAmount(victimState!.resources, resourceType, -1);
        updateResourceAmount(stealerState!.resources, resourceType, 1);
      } else if (anyPossible) {
        // This variant is invalid - victim doesn't have the resource
        this.variantTree.removeVariantNode(node);
      } else if (victimState && stealerState) {
        // Force-apply: victim can't go below zero
        if (getResourceAmount(victimState.resources, resourceType) > 0) {
          updateResourceAmount(victimState.resources, resourceType, -1);
        }
        updateResourceAmount(stealerState.resources, resourceType, 1);
      }
    }

    this.variantTree.pruneInvalidNodes();
  }

  /**
   * Process definite resource gain
   */
  private processResourceGain(
    playerName: string,
    resources: Partial<ResourceObjectType>
  ): void {
    const currentNodes = this.variantTree.getCurrentVariantNodes();

    for (const node of currentNodes) {
      const gameState = node.gameState;
      const playerState = gameState[playerName];

      if (playerState) {
        // Execute the gain
        for (const [resourceType, amount] of Object.entries(resources)) {
          if (typeof amount === 'number' && isValidResourceType(resourceType)) {
            updateResourceAmount(playerState.resources, resourceType, amount);
          }
        }
      }
    }
  }

  /**
   * Process definite resource loss
   */
  private processResourceLoss(
    playerName: string,
    resources: Partial<ResourceObjectType>
  ): void {
    const currentNodes = this.variantTree.getCurrentVariantNodes();

    for (const node of currentNodes) {
      const gameState = node.gameState;
      const playerState = gameState[playerName];

      if (playerState) {
        let canAfford = true;

        // Check if player can afford this loss in this variant
        for (const [resourceType, amount] of Object.entries(resources)) {
          if (
            typeof amount === 'number' &&
            isValidResourceType(resourceType) &&
            getResourceAmount(playerState.resources, resourceType) < amount
          ) {
            canAfford = false;
            break;
          }
        }

        if (canAfford) {
          // Execute the loss
          for (const [resourceType, amount] of Object.entries(resources)) {
            if (
              typeof amount === 'number' &&
              isValidResourceType(resourceType)
            ) {
              updateResourceAmount(
                playerState.resources,
                resourceType,
                -amount
              );
            }
          }
        } else {
          // This variant is invalid - player can't afford the loss
          this.variantTree.removeVariantNode(node);
        }
      }
    }

    this.variantTree.pruneInvalidNodes();
  }

  /**
   * Process bank trade (player trades resources with the bank)
   */
  private processBankTrade(
    playerName: string,
    resourceChanges: Partial<ResourceObjectType>
  ): void {
    const currentNodes = this.variantTree.getCurrentVariantNodes();

    for (const node of currentNodes) {
      const gameState = node.gameState;
      const playerState = gameState[playerName];

      if (playerState) {
        let canAfford = true;

        // Check if player can afford the resources they're giving up
        for (const [resourceType, amount] of Object.entries(resourceChanges)) {
          if (
            amount < 0 && // Negative amounts are resources being given up
            isValidResourceType(resourceType) &&
            getResourceAmount(playerState.resources, resourceType) <
              Math.abs(amount)
          ) {
            canAfford = false;
            break;
          }
        }

        if (canAfford) {
          // Execute the bank trade (both losses and gains)
          for (const [resourceType, amount] of Object.entries(
            resourceChanges
          )) {
            if (
              typeof amount === 'number' &&
              isValidResourceType(resourceType)
            ) {
              updateResourceAmount(playerState.resources, resourceType, amount);
            }
          }
        } else {
          // This variant is invalid - player can't afford the trade
          this.variantTree.removeVariantNode(node);
        }
      }
    }

    this.variantTree.pruneInvalidNodes();
  }

  /**
   * Get resource probabilities for a player.
   *
   * Returns the minimum guaranteed count per resource, plus two views of the
   * uncertainty above that minimum:
   *  - `additionalResourceProbabilities`: a single blended P(more than the
   *    minimum) per resource — kept for callers that only need a yes/no
   *    signal (e.g. gameActions' "which resources could this victim hold"
   *    check).
   *  - `additionalResourceProbabilitySteps`: the full ladder behind that
   *    number — step[0] is P(at least minimum+1), step[1] is P(at least
   *    minimum+2), and so on. A single stacked steal only ever needs step
   *    0, but several unresolved steals landing on the same player can
   *    genuinely spread their hand across more than one extra card per
   *    resource; collapsing that into one blended probability silently hides
   *    how much of it is "probably +1" versus "possibly +2 or more" — this
   *    ladder is what lets the UI show that as multiple graduated cards
   *    instead of one misleadingly-confident badge.
   */
  getPlayerResourceProbabilities(playerName: string): {
    minimumResources: ResourceObjectType;
    additionalResourceProbabilities: ResourceObjectType;
    additionalResourceProbabilitySteps: { [K in keyof ResourceObjectType]: number[] };
  } {
    const variants = this.variantTree.getCurrentVariants();

    if (variants.length === 0) {
      // No variants - return all zeros
      const emptyResources: ResourceObjectType = {
        tree: 0,
        brick: 0,
        sheep: 0,
        wheat: 0,
        ore: 0,
      };
      return {
        minimumResources: { ...emptyResources },
        additionalResourceProbabilities: { ...emptyResources },
        additionalResourceProbabilitySteps: {
          tree: [],
          brick: [],
          sheep: [],
          wheat: [],
          ore: [],
        },
      };
    }

    // Calculate minimum resources across all variants
    const minimumResources: ResourceObjectType = {
      tree: Number.MAX_SAFE_INTEGER,
      brick: Number.MAX_SAFE_INTEGER,
      sheep: Number.MAX_SAFE_INTEGER,
      wheat: Number.MAX_SAFE_INTEGER,
      ore: Number.MAX_SAFE_INTEGER,
    };

    // Collect all resource counts with their probabilities
    const resourceCounts: Array<{
      resources: ResourceObjectType;
      probability: number;
    }> = [];

    for (const variant of variants) {
      const playerState = variant.gameState[playerName];
      if (playerState) {
        resourceCounts.push({
          resources: playerState.resources,
          probability: variant.probability,
        });

        // Update minimums
        for (const resourceType of RESOURCE_TYPES) {
          minimumResources[resourceType] = Math.min(
            minimumResources[resourceType],
            playerState.resources[resourceType]
          );
        }
      }
    }

    // If no player state found, set minimums to 0
    if (resourceCounts.length === 0) {
      for (const resourceType of RESOURCE_TYPES) {
        minimumResources[resourceType] = 0;
      }
    }

    // Calculate probability of having more than minimum for each resource
    const additionalResourceProbabilities: ResourceObjectType = {
      tree: 0,
      brick: 0,
      sheep: 0,
      wheat: 0,
      ore: 0,
    };
    const additionalResourceProbabilitySteps: {
      [K in keyof ResourceObjectType]: number[];
    } = {
      tree: [],
      brick: [],
      sheep: [],
      wheat: [],
      ore: [],
    };

    for (const resourceType of RESOURCE_TYPES) {
      const minCount = minimumResources[resourceType];
      const maxCount = resourceCounts.reduce(
        (max, { resources }) => Math.max(max, resources[resourceType]),
        minCount
      );

      // steps[i] = P(count >= minCount + i + 1), i.e. the probability of
      // having reached at least the (i+1)th card beyond the guaranteed
      // minimum. steps[0] is exactly the old single-number
      // additionalResourceProbabilities value.
      const steps: number[] = [];
      for (let atLeast = minCount + 1; atLeast <= maxCount; atLeast++) {
        let probabilityAtLeast = 0;
        for (const { resources, probability } of resourceCounts) {
          if (resources[resourceType] >= atLeast) {
            probabilityAtLeast += probability;
          }
        }
        steps.push(probabilityAtLeast);
      }

      additionalResourceProbabilitySteps[resourceType] = steps;
      additionalResourceProbabilities[resourceType] = steps[0] ?? 0;
    }

    return {
      minimumResources,
      additionalResourceProbabilities,
      additionalResourceProbabilitySteps,
    };
  }

  /**
   * Get all possible game states with their probabilities
   */
  getAllPossibleGameStates(): Array<{
    gameState: GameState;
    probability: number;
  }> {
    return this.transactionProcessor.getAllPossibleGameStates();
  }

  /**
   * Get the number of possible game states being tracked
   */
  getVariantCount(): number {
    return this.variantTree.getCurrentVariantNodes().length;
  }

  /**
   * Get resource probabilities for a specific transaction
   */
  getTransactionResourceProbabilities(
    transactionId: string
  ): ResourceObjectType | null {
    return this.transactionProcessor.getTransactionResourceProbabilities(
      transactionId
    );
  }

  /**
   * Get the complete transaction history for debugging
   */
  getTransactionHistory(): TransactionType[] {
    return [...this.transactionHistory]; // Return a copy to prevent external modification
  }

}
