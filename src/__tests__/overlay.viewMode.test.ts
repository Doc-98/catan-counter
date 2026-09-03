import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  showGameStateOverlay,
  initResourceViewModePreference,
  _setResourceViewModeForTesting,
  _resetOverlayForTesting,
} from '../overlay';
import { resetGameState, game } from '../gameState';
import { PropbableGameState } from '../probableGameState';
import { placeSettlement, playerGetResources, unknownSteal } from '../gameActions';

function getOverlay(): HTMLElement {
  const overlay = document.getElementById('catan-game-state-overlay');
  if (!overlay) throw new Error('overlay not rendered');
  return overlay;
}

describe('overlay resource view mode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGameState();
    _resetOverlayForTesting();
    _setResourceViewModeForTesting('table');
    // overlay.ts uses chrome.runtime.getURL for resource icons; stub it.
    (globalThis as any).chrome = { runtime: { getURL: (p: string) => p } };

    // Give two players known + one uncertain resource so both views have
    // something concrete to render.
    placeSettlement('Alice');
    placeSettlement('Bob');
    game.probableGameState = new PropbableGameState(game.players);
    playerGetResources('Alice', { brick: 2, sheep: 1 });
    playerGetResources('Bob', { tree: 1, wheat: 1 });
    unknownSteal('Alice', 'Bob'); // Bob has 2 resource types -> creates a variant
    game.hasRolledFirstDice = true;
  });

  it('defaults to the table view', () => {
    showGameStateOverlay();
    const overlay = getOverlay();

    expect(overlay.querySelector('table')).toBeTruthy();
    expect(overlay.querySelector('.hand-card')).toBeNull();
    // The toggle button should offer to switch TO hand view.
    const toggle = overlay.querySelector(
      '#view-toggle-btn'
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.title).toContain('Hand view');
  });

  it('switches to the hand view when the toggle is clicked, and back again', () => {
    showGameStateOverlay();
    let overlay = getOverlay();

    const toggle = () =>
      (overlay.querySelector('#view-toggle-btn') as HTMLButtonElement).click();

    toggle();
    overlay = getOverlay();
    expect(overlay.querySelector('table')).toBeNull();
    expect(overlay.textContent).toContain('Resource Hands');
    expect(overlay.textContent).toContain('Alice');
    expect(overlay.textContent).toContain('Bob');
    // Alice has 2 known brick -> at least two brick card images rendered.
    const brickCards = overlay.querySelectorAll('img[alt="brick"]');
    expect(brickCards.length).toBeGreaterThanOrEqual(2);

    toggle();
    overlay = getOverlay();
    expect(overlay.querySelector('table')).toBeTruthy();
    expect(overlay.textContent).not.toContain('Resource Hands');
  });

  it('renders an uncertain card distinctly from guaranteed ones', () => {
    _setResourceViewModeForTesting('hand');
    showGameStateOverlay();
    const overlay = getOverlay();

    // The unknownSteal in beforeEach makes Bob's post-steal hand uncertain
    // between two resource types, so at least one player has a dashed,
    // reduced-opacity "maybe" card with a percentage badge.
    const html = overlay.innerHTML;
    expect(html).toContain('dashed');
    expect(html).toMatch(/\d+%<\/span>/);
  });

  it('persists the chosen view mode and reloads it via initResourceViewModePreference', async () => {
    const store: Record<string, unknown> = {};
    (globalThis as any).chrome = {
      runtime: { getURL: (p: string) => p },
      storage: {
        local: {
          get: jest.fn(async (keys: string) => {
            return keys in store ? { [keys]: store[keys] } : {};
          }),
          set: jest.fn(async (items: Record<string, unknown>) => {
            Object.assign(store, items);
          }),
        },
      },
    };

    showGameStateOverlay();
    let overlay = getOverlay();
    (overlay.querySelector('#view-toggle-btn') as HTMLButtonElement).click();

    expect(store['catanResourceViewMode']).toBe('hand');

    // Simulate a fresh load: reset the in-memory mode back to the default,
    // then confirm the persisted preference is picked back up.
    _setResourceViewModeForTesting('table');
    await initResourceViewModePreference();

    overlay = getOverlay();
    expect(overlay.textContent).toContain('Resource Hands');
  });
});
