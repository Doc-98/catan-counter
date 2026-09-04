import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  showGameStateOverlay,
  initOverlayPreferences,
  _setOverlayUiPrefsForTesting,
  _resetOverlayForTesting,
} from '../overlay';
import { resetGameState, game, setYouPlayerForTesting } from '../gameState';
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

  it('renders an uncertain card as a whitened overlay, not a transparent one', () => {
    _setOverlayUiPrefsForTesting({ resourceViewMode: 'hand' });
    showGameStateOverlay();
    const overlay = getOverlay();

    // The unknownSteal in beforeEach makes Bob's post-steal hand uncertain
    // between two resource types, so at least one player has a dashed
    // "maybe" card with a percentage badge.
    const html = overlay.innerHTML;
    expect(html).toContain('dashed');
    expect(html).toMatch(/\d+%<\/span>/);

    // The card itself must stay fully opaque (never `opacity:` on the card),
    // with the uncertainty expressed as a white wash layered on top instead
    // — a transparent front card would let a stacked card behind it bleed
    // through, undermining the fan-out effect.
    const cards = Array.from(overlay.querySelectorAll<HTMLElement>('.hand-card'));
    cards.forEach(card => {
      expect(card.getAttribute('style') || '').not.toMatch(/opacity:/);
    });
    const uncertainCard = cards.find(c =>
      (c.getAttribute('style') || '').includes('dashed')
    )!;
    expect(uncertainCard).toBeTruthy();
    expect(uncertainCard.innerHTML).toMatch(
      /background: rgba\(255, 255, 255, 0\.\d+\)/
    );
  });

  it('fans out same-resource cards (32px overlap) but leaves single cards and different resources flush', () => {
    _setOverlayUiPrefsForTesting({ resourceViewMode: 'hand' });
    showGameStateOverlay();
    const overlay = getOverlay();

    // Alice has brick:2, sheep:1 guaranteed (from beforeEach), plus a 50/50
    // uncertain tree-or-wheat card from the unknownSteal. Only the brick
    // pair should overlap — everything else is a lone card in its group.
    const aliceRow = overlay.querySelector('[data-player-hand="Alice"]')!;
    const aliceCards = Array.from(
      aliceRow.querySelectorAll<HTMLElement>('.hand-card')
    );
    // jsdom's CSSOM (cssstyle) rejects negative lengths in its `.style.*`
    // setters/getters (a known jsdom quirk — real browsers parse
    // `margin-left: -32px` correctly), so this checks the raw style
    // attribute text rather than the parsed `.style.marginLeft` property.
    const overlapMargin = (card: HTMLElement): string | null =>
      (card.getAttribute('style') || '').match(/margin-left: (-\d+)px/)?.[1] ??
      null;
    const isUncertain = (card: HTMLElement) =>
      (card.getAttribute('style') || '').includes('dashed');

    const brickCards = aliceCards.filter(
      c => c.querySelector('img')?.getAttribute('alt') === 'brick'
    );
    expect(brickCards).toHaveLength(2);
    expect(overlapMargin(brickCards[0])).toBeNull();
    expect(overlapMargin(brickCards[1])).toBe('-32');

    const sheepCards = aliceCards.filter(
      c => c.querySelector('img')?.getAttribute('alt') === 'sheep'
    );
    expect(sheepCards).toHaveLength(1);
    expect(overlapMargin(sheepCards[0])).toBeNull();

    // The lone uncertain card(s) (tree and/or wheat) shouldn't overlap either
    // — each is the only card in its own resource group.
    aliceCards
      .filter(isUncertain)
      .forEach(c => expect(overlapMargin(c)).toBeNull());
  });

  it('persists the chosen view mode and reloads it via initOverlayPreferences', async () => {
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

    expect(
      (store['catanOverlayUiPrefs'] as { resourceViewMode?: string })
        ?.resourceViewMode
    ).toBe('hand');

    // Simulate a fresh load: reset in-memory prefs to defaults, then confirm
    // the persisted preference is picked back up.
    _setOverlayUiPrefsForTesting({ resourceViewMode: 'table' });
    await initOverlayPreferences();

    overlay = getOverlay();
    expect(overlay.textContent).toContain('Resource Hands');
  });
});

describe('overlay resource views exclude your own hand', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGameState();
    _resetOverlayForTesting();
    (globalThis as any).chrome = { runtime: { getURL: (p: string) => p } };

    placeSettlement('Alice');
    placeSettlement('Bob');
    game.probableGameState = new PropbableGameState(game.players);
    playerGetResources('Alice', { brick: 2, sheep: 1 });
    playerGetResources('Bob', { tree: 1, wheat: 1 });
    game.hasRolledFirstDice = true;
    setYouPlayerForTesting('Alice');
  });

  it('leaves your own row out of the hand view — you already know your own hand', () => {
    _setOverlayUiPrefsForTesting({ resourceViewMode: 'hand' });
    showGameStateOverlay();
    const overlay = getOverlay();

    expect(overlay.querySelector('[data-player-hand="Alice"]')).toBeNull();
    expect(overlay.querySelector('[data-player-hand="Bob"]')).toBeTruthy();
  });

  it('leaves your own row out of the table view too', () => {
    _setOverlayUiPrefsForTesting({ resourceViewMode: 'table' });
    showGameStateOverlay();
    const overlay = getOverlay();

    const rows = Array.from(overlay.querySelectorAll('tbody tr'));
    const rowNames = rows.map(r => r.textContent);
    expect(rowNames.some(t => t?.includes('Alice'))).toBe(false);
    expect(rowNames.some(t => t?.includes('Bob'))).toBe(true);
  });
});

describe('overlay dice chart collapse', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGameState();
    _resetOverlayForTesting();
    // The dice chart lives inside the "More stats" block, which starts
    // collapsed — open it so these tests can see the chart itself.
    _setOverlayUiPrefsForTesting({ moreStatsCollapsed: false });
    (globalThis as any).chrome = { runtime: { getURL: (p: string) => p } };

    placeSettlement('Alice');
    game.probableGameState = new PropbableGameState(game.players);
    game.hasRolledFirstDice = true;
    game.diceRolls[8] = 3;
  });

  it('is expanded by default and collapses/expands via its header', () => {
    showGameStateOverlay();
    let overlay = getOverlay();

    expect(overlay.textContent).toContain('Dice Roll Frequency');
    const header = overlay.querySelector(
      '#dice-chart-header'
    ) as HTMLElement;
    expect(header).toBeTruthy();
    expect(header.textContent).toContain('▾');
    expect(header.title).toContain('Hide');
    // Expanded: the 6/8 bar's teal color from the 3 rolls of 8 seeded above.
    expect(overlay.innerHTML).toContain('#4ecdc4');

    header.click();
    overlay = getOverlay();
    const collapsedHeader = overlay.querySelector(
      '#dice-chart-header'
    ) as HTMLElement;
    expect(collapsedHeader.textContent).toContain('▸');
    expect(collapsedHeader.title).toContain('Show');
    // Collapsed: the header survives, but the bars (and their colors) don't.
    expect(overlay.innerHTML).not.toContain('#4ecdc4');

    collapsedHeader.click();
    overlay = getOverlay();
    expect(
      (overlay.querySelector('#dice-chart-header') as HTMLElement).textContent
    ).toContain('▾');
  });
});

describe('overlay unresolved-steals display', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGameState();
    _resetOverlayForTesting();
    _setOverlayUiPrefsForTesting({ moreStatsCollapsed: false });
    (globalThis as any).chrome = { runtime: { getURL: (p: string) => p } };

    placeSettlement('Aaren');
    placeSettlement('Bora');
    game.probableGameState = new PropbableGameState(game.players);
    playerGetResources('Bora', { tree: 1, wheat: 1 });
    unknownSteal('Aaren', 'Bora');
    game.hasRolledFirstDice = true;
  });

  it('renders thief/victim with icons instead of a "stole from" sentence', () => {
    showGameStateOverlay();
    const overlay = getOverlay();

    expect(overlay.textContent).toContain('Aaren');
    expect(overlay.textContent).toContain('Bora');
    expect(overlay.textContent).not.toContain('stole from');
    expect(overlay.textContent).not.toContain('Could be:');
    expect(overlay.innerHTML).toContain('🦹');

    // Candidate resources render as icon chips with a percentage, not a
    // "resource: 0.50" text list.
    const item = overlay.querySelector('.unknown-transaction-item')!;
    expect(item.querySelectorAll('img[alt="tree"], img[alt="wheat"]').length)
      .toBeGreaterThan(0);
    expect(item.textContent).toMatch(/\d+%/);
  });

  it('still opens the resolution modal when clicked', () => {
    showGameStateOverlay();
    const overlay = getOverlay();
    const item = overlay.querySelector(
      '.unknown-transaction-item'
    ) as HTMLElement;
    item.click();

    expect(document.body.textContent).toContain('Resolve Unknown Transaction');
  });

  it('collapses and expands via its own header, like the dice chart', () => {
    showGameStateOverlay();
    let overlay = getOverlay();

    const header = overlay.querySelector(
      '#unknown-transactions-header'
    ) as HTMLElement;
    expect(header).toBeTruthy();
    expect(header.textContent).toContain('▾');
    expect(overlay.querySelector('.unknown-transaction-item')).toBeTruthy();

    header.click();
    overlay = getOverlay();
    const collapsedHeader = overlay.querySelector(
      '#unknown-transactions-header'
    ) as HTMLElement;
    expect(collapsedHeader.textContent).toContain('▸');
    // Header survives collapse, but the individual steal rows don't.
    expect(overlay.querySelector('.unknown-transaction-item')).toBeNull();

    collapsedHeader.click();
    overlay = getOverlay();
    expect(overlay.querySelector('.unknown-transaction-item')).toBeTruthy();
  });
});

describe('overlay development cards collapse', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGameState();
    _resetOverlayForTesting();
    _setOverlayUiPrefsForTesting({ moreStatsCollapsed: false });
    (globalThis as any).chrome = { runtime: { getURL: (p: string) => p } };

    placeSettlement('Alice');
    game.probableGameState = new PropbableGameState(game.players);
    game.hasRolledFirstDice = true;
  });

  it('is expanded by default and collapses/expands via its header', () => {
    showGameStateOverlay();
    let overlay = getOverlay();

    const header = overlay.querySelector('#dev-cards-header') as HTMLElement;
    expect(header).toBeTruthy();
    expect(header.textContent).toContain('▾');
    expect(overlay.textContent).toContain('Knight');

    header.click();
    overlay = getOverlay();
    const collapsedHeader = overlay.querySelector(
      '#dev-cards-header'
    ) as HTMLElement;
    expect(collapsedHeader.textContent).toContain('▸');
    expect(overlay.textContent).not.toContain('Knight');
    // The count in the header itself stays visible even collapsed.
    expect(collapsedHeader.textContent).toContain('Development Cards Remaining');
  });
});

describe('overlay blocked-dice collapse', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGameState();
    _resetOverlayForTesting();
    _setOverlayUiPrefsForTesting({ moreStatsCollapsed: false });
    (globalThis as any).chrome = { runtime: { getURL: (p: string) => p } };

    placeSettlement('Alice');
    game.probableGameState = new PropbableGameState(game.players);
    game.hasRolledFirstDice = true;
    game.blockedDiceRolls = { 9: { ore: 2 } };
  });

  it('is expanded by default and collapses/expands via its header', () => {
    showGameStateOverlay();
    let overlay = getOverlay();

    const header = overlay.querySelector(
      '#blocked-dice-header'
    ) as HTMLElement;
    expect(header).toBeTruthy();
    expect(overlay.textContent).toContain('9 ore: 2');

    header.click();
    overlay = getOverlay();
    expect(overlay.textContent).not.toContain('9 ore: 2');
    expect(
      (overlay.querySelector('#blocked-dice-header') as HTMLElement)
        .textContent
    ).toContain('▸');
  });
});

describe('overlay "More stats" block', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGameState();
    _resetOverlayForTesting();
    (globalThis as any).chrome = { runtime: { getURL: (p: string) => p } };

    placeSettlement('Aaren');
    placeSettlement('Bora');
    game.probableGameState = new PropbableGameState(game.players);
    playerGetResources('Bora', { tree: 1, wheat: 1 });
    unknownSteal('Aaren', 'Bora');
    game.hasRolledFirstDice = true;
    game.diceRolls[8] = 3;
    game.blockedDiceRolls = { 9: { ore: 1 } };
  });

  it('starts collapsed, hiding every section (including their headers) behind a single "More stats" button', () => {
    showGameStateOverlay();
    const overlay = getOverlay();

    const btn = overlay.querySelector('#more-stats-btn') as HTMLElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('More stats');

    // Not just the section bodies — the headers themselves aren't rendered.
    expect(overlay.querySelector('#unknown-transactions-header')).toBeNull();
    expect(overlay.querySelector('#dev-cards-header')).toBeNull();
    expect(overlay.querySelector('#dice-chart-header')).toBeNull();
    expect(overlay.querySelector('#blocked-dice-header')).toBeNull();
    expect(overlay.querySelector('.unknown-transaction-item')).toBeNull();
    expect(overlay.textContent).not.toContain('Knight');
    expect(overlay.textContent).not.toContain('9 ore: 1');
  });

  it('reveals every section when clicked, each still independently collapsible, and hides them all again on a second click', () => {
    showGameStateOverlay();
    let overlay = getOverlay();

    (overlay.querySelector('#more-stats-btn') as HTMLElement).click();
    overlay = getOverlay();

    const btn = overlay.querySelector('#more-stats-btn') as HTMLElement;
    expect(btn.textContent).toContain('Collapse all');
    // It renders before the Unresolved Steals section in the markup.
    const html = overlay.innerHTML;
    expect(html.indexOf('more-stats-btn')).toBeLessThan(
      html.indexOf('unknown-transactions-header')
    );

    expect(overlay.querySelector('.unknown-transaction-item')).toBeTruthy();
    expect(overlay.textContent).toContain('Knight');
    expect(overlay.textContent).toContain('9 ore: 1');

    // Each section is still individually collapsible while the block is open.
    (overlay.querySelector('#dev-cards-header') as HTMLElement).click();
    overlay = getOverlay();
    expect(overlay.textContent).not.toContain('Knight');
    expect(overlay.querySelector('#dev-cards-header')).toBeTruthy();

    // Collapsing the whole block again hides everything, headers included.
    (overlay.querySelector('#more-stats-btn') as HTMLElement).click();
    overlay = getOverlay();
    expect(overlay.querySelector('#more-stats-btn')!.textContent).toContain(
      'More stats'
    );
    expect(overlay.querySelector('#dev-cards-header')).toBeNull();
    expect(overlay.querySelector('#dice-chart-header')).toBeNull();
  });
});
