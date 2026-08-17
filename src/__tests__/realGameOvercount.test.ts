// Real game captured 2026-08-15 (colonist room #pack4745, Friendly Robber
// variant, 4 players, 405 chat messages) where the overlay reported 38
// guaranteed resources against the 23 the players actually held.
//
// Root cause: "You stole X from Y" names the victim but not the thief, and the
// parser recovered the thief by reading the player name off the *previous* chat
// row — assuming it was that player's "moved Robber" message. Any message can
// land in between. At data-index 246 the previous row was "Aghas built a
// Settlement", so NickTheSwift's stolen wool was credited to Aghas (likewise at
// 282, credited to Nedrah9972). That left NickTheSwift a sheep short in every
// variant, so the dev-card purchase at 248 was unaffordable everywhere;
// processResourceLoss then tried to delete the last surviving variant and
// VariantTree.removeVariantNode threw "Cannot remove root node". Live, that
// throw escapes updateGameFromChat inside the MutationObserver callback, so the
// payment is silently skipped — five times across this game (248, 326, 343,
// 355, 388), for 3+3+3+2+4 = exactly the 15 phantom cards observed.
//
// The fixture is the full chat log, reduced to the hooks the parser reads
// (data-index, img[alt], and the font-weight:600 / color name spans). Colonist's
// build-generated class hashes and CDN URLs are stripped deliberately — they
// change on every colonist deploy and must not be baked into fixtures.
//
// EXPECTED_HAND_COUNTS is ground truth read from colonist's own player panel at
// the moment of capture, so it is not derived from anything the extension
// computes. It is independently corroborated: replaying the log by hand and
// counting cards (steals are zero-sum transfers, so hand *size* is exact even
// when the stolen resource is hidden) reproduces these four numbers exactly.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { updateGameFromChat } from '../chatParser';
import { resetGameState, game, setYouPlayerForTesting } from '../gameState';
import { RESOURCE_TYPES } from '../variants';

const EXPECTED_HAND_COUNTS: { [name: string]: number } = {
  Nedrah9972: 11,
  Catanwyse: 4,
  Aghas: 5,
  NickTheSwift: 3,
};

function replayLog(): void {
  const html = readFileSync(
    join(__dirname, 'scenarios', 'realGameOvercount.html'),
    'utf-8'
  );
  document.body.innerHTML = html;
  resetGameState();
  setYouPlayerForTesting('NickTheSwift');
  document
    .querySelectorAll<HTMLElement>('[data-index]')
    .forEach(element => updateGameFromChat(element));
}

/**
 * Total guaranteed resources as the overlay computes them — from the variant
 * tree via getPlayerResourceProbabilities().minimumResources (overlay.ts:372).
 * Deliberately NOT game.players[].resources: unknownSteal() updates only the
 * variant tree, so that legacy field is expected to drift and is not displayed.
 */
function guaranteedTotal(name: string): number {
  const probabilities =
    game.probableGameState.getPlayerResourceProbabilities(name);
  return RESOURCE_TYPES.reduce(
    (sum: number, resource: string) =>
      sum + (probabilities.minimumResources as any)[resource],
    0
  );
}

describe('real game — resource over-count (room #pack4745)', () => {
  it('processes the full chat log without throwing', () => {
    expect(() => replayLog()).not.toThrow();
  });

  it('tracks every hand exactly, with nothing left unresolved', () => {
    replayLog();

    // Guaranteed resources are a lower bound on what a player holds, so
    // guaranteed > actual is impossible under any ruleset — that inequality is
    // what this game violated. Here the log resolves completely, so the counts
    // land exactly on colonist's own numbers with no probabilistic remainder.
    for (const [name, actual] of Object.entries(EXPECTED_HAND_COUNTS)) {
      expect(guaranteedTotal(name)).toBe(actual);
    }
  });

  it('credits a "You stole" steal to the current player', () => {
    replayLog();

    // At data-index 246 the preceding row is another player's build message.
    // Attributing the steal by previous sibling gave the wool to Aghas; the
    // thief on a "You stole" line is always the current player.
    const aghas = game.players.find(p => p.name === 'Aghas');
    expect(aghas).toBeDefined();
    expect(guaranteedTotal('Aghas')).toBe(EXPECTED_HAND_COUNTS.Aghas);
  });
});
