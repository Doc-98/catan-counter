import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  showGameStateOverlay,
  setResetRequestedCallback,
  _resetOverlayForTesting,
} from '../overlay';
import { resetGameState, game } from '../gameState';
import { PropbableGameState } from '../probableGameState';
import { placeSettlement } from '../gameActions';

function getOverlay(): HTMLElement {
  const overlay = document.getElementById('catan-game-state-overlay');
  if (!overlay) throw new Error('overlay not rendered');
  return overlay;
}

describe('overlay reset button', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGameState();
    _resetOverlayForTesting();
    (globalThis as any).chrome = { runtime: { getURL: (p: string) => p } };

    placeSettlement('Alice');
    game.probableGameState = new PropbableGameState(game.players);
    game.hasRolledFirstDice = true;
  });

  it('invokes the registered reset callback when clicked', () => {
    const onReset = jest.fn();
    setResetRequestedCallback(onReset);

    showGameStateOverlay();
    const overlay = getOverlay();
    const resetBtn = overlay.querySelector('#reset-btn') as HTMLButtonElement;

    expect(resetBtn).toBeTruthy();
    expect(resetBtn.title).toContain('Reset');

    resetBtn.click();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('does not throw when clicked with no callback registered yet', () => {
    showGameStateOverlay();
    const overlay = getOverlay();
    const resetBtn = overlay.querySelector('#reset-btn') as HTMLButtonElement;

    expect(() => resetBtn.click()).not.toThrow();
  });
});

describe('overlay popout button', () => {
  let fakePopoutDoc: Document;
  let fakePopoutWindow: {
    document: Document;
    closed: boolean;
    close: () => void;
    addEventListener: jest.Mock;
  };
  let originalOpen: typeof window.open;

  beforeEach(() => {
    document.body.innerHTML = '';
    resetGameState();
    _resetOverlayForTesting();
    (globalThis as any).chrome = { runtime: { getURL: (p: string) => p } };

    placeSettlement('Alice');
    game.probableGameState = new PropbableGameState(game.players);
    game.hasRolledFirstDice = true;

    // jsdom doesn't implement real multi-window support, so window.open is
    // stubbed to hand back a minimal fake window backed by a real Document
    // (document.implementation.createHTMLDocument gives us one with an
    // actual .body, which is all togglePopout() needs to adopt the overlay
    // into).
    fakePopoutDoc = document.implementation.createHTMLDocument('popout');
    fakePopoutWindow = {
      document: fakePopoutDoc,
      closed: false,
      close: jest.fn(() => {
        fakePopoutWindow.closed = true;
      }),
      addEventListener: jest.fn(),
    };
    originalOpen = window.open;
    window.open = jest.fn(() => fakePopoutWindow as unknown as Window);
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  it('moves the overlay into the popout window and back on toggle', () => {
    showGameStateOverlay();
    const overlay = getOverlay();
    const popoutBtn = () =>
      overlay.querySelector('#popout-btn') as HTMLButtonElement;

    expect(popoutBtn().title).toContain('Open in a separate window');

    popoutBtn().click();

    // The same node moved into the fake popout document...
    expect(overlay.ownerDocument).toBe(fakePopoutDoc);
    expect(fakePopoutDoc.body.contains(overlay)).toBe(true);
    // ...and is no longer in the page.
    expect(document.body.contains(overlay)).toBe(false);
    expect(document.getElementById('catan-game-state-overlay')).toBeNull();
    expect(window.open).toHaveBeenCalledTimes(1);

    // Re-rendering after the move still works and reflects the new state —
    // querying through the node reference itself since it's no longer
    // reachable via document.getElementById.
    expect(overlay.querySelector<HTMLButtonElement>('#popout-btn')!.title).toContain(
      'Return to page'
    );

    // Toggling again brings it home.
    overlay.querySelector<HTMLButtonElement>('#popout-btn')!.click();

    expect(fakePopoutWindow.close).toHaveBeenCalledTimes(1);
    expect(document.body.contains(overlay)).toBe(true);
    expect(document.getElementById('catan-game-state-overlay')).toBe(overlay);
    expect(overlay.querySelector<HTMLButtonElement>('#popout-btn')!.title).toContain(
      'Open in a separate window'
    );
  });

  it('brings the overlay home if the popout window is closed externally', () => {
    jest.useFakeTimers();
    try {
      showGameStateOverlay();
      const overlay = getOverlay();
      overlay
        .querySelector<HTMLButtonElement>('#popout-btn')!
        .click();

      expect(fakePopoutDoc.body.contains(overlay)).toBe(true);

      // Simulate the user closing the popout via the browser's own window
      // controls, rather than our button.
      fakePopoutWindow.closed = true;
      jest.advanceTimersByTime(600);

      expect(document.body.contains(overlay)).toBe(true);
      expect(overlay.querySelector<HTMLButtonElement>('#popout-btn')!.title).toContain(
        'Open in a separate window'
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
