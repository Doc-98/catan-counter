import { game, setYouPlayer, markYouPlayerAsked } from './gameState.js';
import { downloadCurrentGameLog } from './messageLogger.js';
import { ResourceObjectType } from './types.js';

// Chrome extension API type declaration. `storage` is optional (and `chrome`
// itself is undefined under Jest/jsdom unless a test stubs it) so the view
// mode preference degrades gracefully to an in-memory default when it's
// unavailable — same pattern as messageLogger.ts.
declare const chrome:
  | {
      runtime: {
        getURL: (path: string) => string;
      };
      storage?: {
        local: {
          get(
            keys: string | string[] | null
          ): Promise<Record<string, unknown>>;
          set(items: Record<string, unknown>): Promise<void>;
        };
      };
    }
  | undefined;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

const RESOURCE_ICONS = {
  tree: 'tree.svg',
  brick: 'brick.svg',
  sheep: 'sheep.svg',
  wheat: 'wheat.svg',
  ore: 'ore.svg',
} as const;

const STYLES = {
  modalBackdrop: `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 10002;
    display: flex;
    justify-content: center;
    align-items: center;
  `,
  modalDialog: `
    background: white;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    max-width: 400px;
    width: 90%;
    font-family: Arial, sans-serif;
  `,
  primaryButton: `
    padding: 12px;
    border: 2px solid #3498db;
    background: #ecf0f1;
    border-radius: 6px;
    cursor: pointer;
    font-weight: bold;
    transition: all 0.2s;
  `,
  secondaryButton: `
    padding: 8px 16px;
    border: 1px solid #ccc;
    background: #f8f9fa;
    border-radius: 4px;
    cursor: pointer;
    color: #666;
  `,
  resolveButton: `
    position: absolute;
    top: 6px;
    right: 8px;
    background: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 10px;
    cursor: pointer;
    opacity: 0.8;
  `,
};

/**
 * Format resource name with proper capitalization
 */
function formatResourceName(resource: string): string {
  return String(resource).charAt(0).toUpperCase() + String(resource).slice(1);
}

/**
 * Get resource icon URL
 */
function getResourceIconUrl(resource: keyof typeof RESOURCE_ICONS): string {
  return chrome!.runtime.getURL(`assets/${RESOURCE_ICONS[resource]}`);
}

/**
 * Create a modal backdrop element
 */
function createModalBackdrop(): HTMLDivElement {
  const backdrop = document.createElement('div');
  backdrop.style.cssText = STYLES.modalBackdrop;
  return backdrop;
}

/**
 * Create a modal dialog element
 */
function createModalDialog(): HTMLDivElement {
  const dialog = document.createElement('div');
  dialog.style.cssText = STYLES.modalDialog;
  return dialog;
}

/**
 * Create a button element with hover effects
 */
function createButton(
  text: string,
  style: string,
  hoverStyle?: { background: string; color: string }
): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = text;
  button.style.cssText = style;

  if (hoverStyle) {
    button.addEventListener('mouseover', () => {
      button.style.background = hoverStyle.background;
      button.style.color = hoverStyle.color;
    });
    button.addEventListener('mouseout', () => {
      button.style.background = '#ecf0f1';
      button.style.color = 'black';
    });
  }

  return button;
}

/**
 * Create a resource button with icon and probability
 */
function createResourceButton(
  resource: string,
  probability: number,
  onClick: () => void
): HTMLButtonElement {
  const button = document.createElement('button');
  button.setAttribute('data-resource', resource);
  button.style.cssText = `
    ${STYLES.primaryButton}
    display: flex;
    align-items: center;
    gap: 10px;
  `;

  const iconUrl = getResourceIconUrl(resource as keyof typeof RESOURCE_ICONS);
  button.innerHTML = `
    <img src="${iconUrl}" 
         style="width: 20px; height: 20px;" 
         alt="${resource}" />
    <span>${formatResourceName(resource)}</span>
    <span style="margin-left: auto; font-size: 12px; opacity: 0.7;">${(probability * 100).toFixed(1)}%</span>
  `;

  // Add hover effects
  button.addEventListener('mouseover', () => {
    button.style.background = '#3498db';
    button.style.color = 'white';
  });
  button.addEventListener('mouseout', () => {
    button.style.background = '#ecf0f1';
    button.style.color = 'black';
  });

  button.addEventListener('click', onClick);
  return button;
}

// =============================================================================
// MAIN OVERLAY FUNCTIONALITY
// =============================================================================

// Create draggable overlay for game state display
let gameStateOverlay: HTMLDivElement | null = null;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let isMinimized = false;
let isResizing = false;
let currentScale = 1;
let resizeStartData = { x: 0, y: 0, scale: 1 };
let youPlayerSelectedCallback: (() => void) | null = null;
// True while content.ts is scrolling the chat to rebuild history after a page
// load/refresh. The overlay shows a loader instead of (stale/partial) counts.
let isLoadingHistory = false;

// =============================================================================
// OVERLAY UI PREFERENCES (resource view mode, collapsible sections, ...)
// =============================================================================

type ResourceViewMode = 'table' | 'hand';

interface OverlayUiPrefs {
  // 'table' matches the original numeric layout; 'hand' renders each
  // player's resources as a row of cards, closer to colonist's own hand tray.
  resourceViewMode: ResourceViewMode;
  // The dice roll frequency chart takes real estate players don't always
  // want spent — collapsed to just its header when true.
  diceChartCollapsed: boolean;
}

let uiPrefs: OverlayUiPrefs = {
  resourceViewMode: 'table',
  diceChartCollapsed: false,
};

const UI_PREFS_STORAGE_KEY = 'catanOverlayUiPrefs';

function storageAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.local;
}

/**
 * Load persisted overlay UI preferences (if any) from chrome.storage.local
 * and apply them. Safe to call before the overlay exists — prefs are just
 * picked up the next time it renders. Call once on startup (see content.ts).
 */
export async function initOverlayPreferences(): Promise<void> {
  if (!storageAvailable()) return;
  try {
    const stored = await chrome!.storage!.local.get(UI_PREFS_STORAGE_KEY);
    const saved = stored[UI_PREFS_STORAGE_KEY] as
      | Partial<OverlayUiPrefs>
      | undefined;
    if (!saved) return;

    if (saved.resourceViewMode === 'table' || saved.resourceViewMode === 'hand') {
      uiPrefs.resourceViewMode = saved.resourceViewMode;
    }
    if (typeof saved.diceChartCollapsed === 'boolean') {
      uiPrefs.diceChartCollapsed = saved.diceChartCollapsed;
    }
    if (gameStateOverlay) updateOverlayContent(gameStateOverlay);
  } catch (error) {
    console.warn('🃏 Could not load overlay UI preferences:', error);
  }
}

function persistUiPrefs(): void {
  if (!storageAvailable()) return;
  void chrome!.storage!.local
    .set({ [UI_PREFS_STORAGE_KEY]: uiPrefs })
    .catch(error => {
      console.warn('🃏 Could not persist overlay UI preferences:', error);
    });
}

function toggleResourceViewMode(): void {
  uiPrefs.resourceViewMode =
    uiPrefs.resourceViewMode === 'table' ? 'hand' : 'table';
  persistUiPrefs();
  if (gameStateOverlay) updateOverlayContent(gameStateOverlay);
}

function toggleDiceChartCollapsed(): void {
  uiPrefs.diceChartCollapsed = !uiPrefs.diceChartCollapsed;
  persistUiPrefs();
  if (gameStateOverlay) updateOverlayContent(gameStateOverlay);
}

/** Test-only: set UI preferences directly, bypassing storage/persistence. */
export function _setOverlayUiPrefsForTesting(
  prefs: Partial<OverlayUiPrefs>
): void {
  uiPrefs = { ...uiPrefs, ...prefs };
}

/**
 * Test-only: drop the module-level overlay reference so the next
 * showGameStateOverlay() call creates (and appends) a fresh element, instead
 * of reusing one detached from the DOM by a prior test's `document.body.innerHTML = ''`.
 */
export function _resetOverlayForTesting(): void {
  gameStateOverlay = null;
  isMinimized = false;
  isLoadingHistory = false;
  currentScale = 1;
  uiPrefs = { resourceViewMode: 'table', diceChartCollapsed: false };
}

function createGameStateOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.id = 'catan-game-state-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    width: 450px;
    max-height: calc(100vh - 40px);
    background: white;
    border: 2px solid #333;
    border-radius: 8px;
    font-family: Arial, sans-serif;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 10000;
    box-shadow: 0 4px 8px rgba(0,0,0,0.3);
    color: black;
    transform-origin: top left;
    transform: scale(${currentScale});
  `;

  // Add drag and resize functionality
  overlay.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', stopDragAndResize);

  // Initial content
  updateOverlayContent(overlay);

  return overlay;
}

function startDrag(e: MouseEvent): void {
  if (!gameStateOverlay) return;

  const target = e.target as HTMLElement;

  // Check if clicking on resize handle
  if (target.classList.contains('resize-handle')) {
    isResizing = true;
    resizeStartData = {
      x: e.clientX,
      y: e.clientY,
      scale: currentScale,
    };
    e.preventDefault();
    return;
  }

  // Only allow dragging from the header
  const header = gameStateOverlay.querySelector('#overlay-header');
  if (
    !header?.contains(target) ||
    target.id === 'minimize-btn' ||
    target.id === 'save-log-btn' ||
    target.id === 'view-toggle-btn'
  )
    return;

  isDragging = true;
  const rect = gameStateOverlay.getBoundingClientRect();
  dragOffset.x = e.clientX - rect.left;
  dragOffset.y = e.clientY - rect.top;

  // Prevent text selection while dragging
  e.preventDefault();
}

function handleMouseMove(e: MouseEvent): void {
  if (isResizing && gameStateOverlay) {
    const deltaX = e.clientX - resizeStartData.x;
    const deltaY = e.clientY - resizeStartData.y;
    const avgDelta = (deltaX + deltaY) / 2;

    // Calculate new scale (minimum 0.5, maximum 2.0)
    const scaleFactor = avgDelta / 300; // Adjust sensitivity
    currentScale = Math.max(
      0.5,
      Math.min(2.0, resizeStartData.scale + scaleFactor)
    );

    // Apply the new scale
    gameStateOverlay.style.transform = `scale(${currentScale})`;
    e.preventDefault();
    return;
  }

  if (!isDragging || !gameStateOverlay) return;

  const x = e.clientX - dragOffset.x;
  const y = e.clientY - dragOffset.y;

  // Keep overlay within viewport (accounting for scale)
  const scaledWidth = gameStateOverlay.offsetWidth * currentScale;
  const scaledHeight = gameStateOverlay.offsetHeight * currentScale;
  const maxX = window.innerWidth - scaledWidth;
  const maxY = window.innerHeight - scaledHeight;

  gameStateOverlay.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
  gameStateOverlay.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
  gameStateOverlay.style.right = 'auto'; // Remove right positioning when dragging
}

function stopDragAndResize(): void {
  isDragging = false;
  isResizing = false;
}

function getOrderedPlayers() {
  if (!game.youPlayerName) {
    return game.players;
  }

  const youPlayerIndex = game.players.findIndex(
    player => player.name === game.youPlayerName
  );

  if (youPlayerIndex === -1) {
    return game.players;
  }

  // Create ordered array: players after youPlayer, then players before youPlayer, then youPlayer
  const playersAfter = game.players.slice(youPlayerIndex + 1);
  const playersBefore = game.players.slice(0, youPlayerIndex);
  const youPlayer = game.players[youPlayerIndex];

  return [...playersAfter, ...playersBefore, youPlayer];
}

function generateResourceProbabilityTable(): string {
  if (!game.probableGameState || game.players.length === 0) {
    return '';
  }

  const resourceNames = ['tree', 'brick', 'sheep', 'wheat', 'ore'] as const;
  const resourceColors = [
    '#38c61b22',
    '#cc7b6422',
    '#8fb50e22',
    '#f4bb2522',
    '#9fa4a122',
  ];

  let table =
    '<div style="margin-top: 15px;"><h4 style="margin: 0 0 10px 0; text-align: center;">Resource Probabilities</h4>';
  table +=
    '<table style="width: 100%; border-collapse: collapse; margin: 10px 0;">';

  // Header row
  table += '<thead><tr style="background: #f5f5f5;">';
  table +=
    '<th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Player</th>';

  resourceNames.forEach((resource, index) => {
    const cardsInPlay = game.gameResources[resource];
    const totalPossible = 19;

    table += `<th style="padding: 8px; border: 1px solid #ddd; text-align: center; background: ${resourceColors[index]};">
      <img src="${getResourceIconUrl(resource)}" 
           style="width: 14.5px; height: 20px;" 
           alt="${resource}" 
           title="${resource}" /><br>
      <small style="font-size: 9px; color: #666;">${cardsInPlay}/${totalPossible}</small>
    </th>`;
  });

  table += '</tr></thead><tbody>';

  // Player rows - using ordered players with youPlayer last
  const orderedPlayers = getOrderedPlayers();
  orderedPlayers.forEach(player => {
    const probabilities =
      game.probableGameState!.getPlayerResourceProbabilities(player.name);

    table += '<tr>';
    table += `<td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; color: ${player.color};">${player.name}</td>`;

    resourceNames.forEach((resource, index) => {
      const resourceKey =
        resource as keyof typeof probabilities.minimumResources;
      const minCount = probabilities.minimumResources[resourceKey];
      const additionalProb =
        probabilities.additionalResourceProbabilities[resourceKey];

      // Format: "minimum + probability%"
      let displayText = minCount.toString();
      if (additionalProb > 0) {
        displayText += ` <span style="color:rgb(47, 120, 23); font-size: 10px;">+${additionalProb.toFixed(2)}</span>`;
      }

      table += `<td style="padding: 8px; border: 1px solid #ddd; text-align: center; width: 65px;background: ${resourceColors[index]}; font-weight: bold;">
        ${displayText}
      </td>`;
    });

    table += '</tr>';
  });

  table += '</tbody></table></div>';
  return table;
}

const HAND_CARD_WIDTH = 40;
const HAND_CARD_HEIGHT = 56;
// How much of the previous same-resource card a following one covers, so a
// run of duplicates fans out like a real hand instead of sitting edge to
// edge. Only applied between cards of the same resource — the flex gap alone
// separates one resource group from the next (see generateResourceHandView).
const HAND_CARD_OVERLAP_PX = 32;

/**
 * Render one resource card. A guaranteed card is opaque with a solid border;
 * an "additional" card (the single blended probability of holding more than
 * the guaranteed minimum, see getPlayerResourceProbabilities) is drawn with a
 * dashed border, a probability badge, and a white wash over the art — so
 * uncertainty reads as "faded ink", not see-through. The card itself stays
 * fully opaque (`opacity` is never touched) so it still fully occludes
 * whatever it's stacked on top of; a genuinely transparent card would let a
 * card behind it bleed through at the overlap.
 *
 * `stackOnPrevious` pulls this card left to overlap the one before it in the
 * same resource group. Later cards paint over earlier ones in normal flow,
 * so the last (front) card of a group is always the fully visible one —
 * which is why the uncertain card, pushed last, ends up on top.
 */
function createHandCardHtml(
  resource: keyof typeof RESOURCE_ICONS,
  options?: { probability?: number; stackOnPrevious?: boolean }
): string {
  const iconUrl = getResourceIconUrl(resource);
  const probability = options?.probability;
  const isUncertain = probability !== undefined;
  // Whiten more heavily at low probability, tapering off as probability
  // rises (mirrors the old opacity curve, just as an opaque wash instead of
  // true transparency: floor ~10% wash near-certain, ~65% wash near-zero).
  const whitenAlpha = isUncertain ? 0.65 - 0.55 * probability! : 0;
  const whitenOverlay = isUncertain
    ? `<div style="
        position: absolute;
        inset: 0;
        background: rgba(255, 255, 255, ${whitenAlpha.toFixed(2)});
      "></div>`
    : '';
  const badge = isUncertain
    ? `<span style="
        position: absolute;
        bottom: 2px;
        right: 2px;
        background: rgba(255, 255, 255, 0.9);
        color: #333;
        font-size: 9px;
        font-weight: bold;
        line-height: 1.4;
        padding: 0 3px;
        border-radius: 3px;
      ">${Math.round(probability! * 100)}%</span>`
    : '';
  const title = isUncertain
    ? `Maybe ${formatResourceName(resource)} (${Math.round(probability! * 100)}% chance of one more)`
    : formatResourceName(resource);
  const overlapStyle = options?.stackOnPrevious
    ? `margin-left: -${HAND_CARD_OVERLAP_PX}px;`
    : '';

  return `
    <div class="hand-card" style="
      position: relative;
      width: ${HAND_CARD_WIDTH}px;
      height: ${HAND_CARD_HEIGHT}px;
      flex: 0 0 auto;
      border-radius: 4px;
      overflow: hidden;
      border: ${isUncertain ? '2px dashed #d4a017' : '1px solid rgba(0,0,0,0.25)'};
      box-shadow: 0 1px 3px rgba(0,0,0,0.25);
      background: white;
      ${overlapStyle}
    " title="${title}">
      <img src="${iconUrl}" alt="${resource}"
        style="width: 100%; height: 100%; object-fit: cover; display: block;" />
      ${whitenOverlay}
      ${badge}
    </div>
  `;
}

/**
 * Alternative to generateResourceProbabilityTable(): renders each player's
 * resources as a row of cards (colonist's own hand tray, reusing the same
 * card art) instead of a numeric table. Uses the exact same underlying data
 * (minimumResources / additionalResourceProbabilities) so the two views never
 * disagree — only the presentation differs.
 */
function generateResourceHandView(): string {
  if (!game.probableGameState || game.players.length === 0) {
    return '';
  }

  const resourceNames = ['tree', 'brick', 'sheep', 'wheat', 'ore'] as const;

  let html =
    '<div style="margin-top: 15px;"><h4 style="margin: 0 0 10px 0; text-align: center;">Resource Hands</h4>';

  getOrderedPlayers().forEach(player => {
    const probabilities = game.probableGameState!.getPlayerResourceProbabilities(
      player.name
    );

    const cards: string[] = [];
    let knownTotal = 0;

    resourceNames.forEach(resource => {
      const minCount = probabilities.minimumResources[resource];
      const additionalProb = probabilities.additionalResourceProbabilities[
        resource
      ];
      knownTotal += minCount;

      for (let i = 0; i < minCount; i++) {
        cards.push(
          createHandCardHtml(resource, { stackOnPrevious: i > 0 })
        );
      }
      if (additionalProb > 0) {
        cards.push(
          createHandCardHtml(resource, {
            probability: additionalProb,
            // Only the very first card of a group (this one, if it's the
            // only card) sits flush; otherwise it fans out on top of the
            // guaranteed cards ahead of it, becoming the visible "front" card.
            stackOnPrevious: minCount > 0,
          })
        );
      }
    });

    html += `
      <div data-player-hand="${player.name}" style="
        margin-bottom: 10px;
        padding: 8px;
        background: #f8f9fa;
        border-radius: 6px;
        border-left: 4px solid ${player.color};
      ">
        <div style="font-weight: bold; color: ${player.color}; margin-bottom: 6px;">
          ${player.name}
          <span style="font-weight: normal; color: #666; font-size: 10px;">(${knownTotal} known)</span>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
          ${cards.length > 0 ? cards.join('') : '<span style="color: #999; font-size: 11px;">No cards</span>'}
        </div>
      </div>
    `;
  });

  html += '</div>';
  return html;
}

function generateDevCardsDisplay(): string {
  const devCardTypes = [
    { key: 'knights', name: 'Knight', icon: 'knight.svg' },
    { key: 'monopolies', name: 'Monopoly', icon: 'mono.svg' },
    { key: 'roadBuilders', name: 'Road Building', icon: 'rb.svg' },
    { key: 'yearOfPlenties', name: 'Year of Plenty', icon: 'yop.svg' },
    { key: 'victoryPoints', name: 'Victory Point', icon: 'vp.svg' },
  ];

  /**
   * Get dev card icon URL
   */
  const getDevCardIconUrl = (icon: string): string =>
    chrome!.runtime.getURL(`assets/${icon}`);

  let display = '<div style="margin: 15px 0;">';
  display += `<h4 style="margin: 0 0 10px 0; text-align: center;">Development Cards Remaining: ${game.devCards}</h4>`;
  display +=
    '<div style="display: flex; justify-content: space-around; align-items: center; padding: 10px; background: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">';

  devCardTypes.forEach(cardType => {
    const remaining = game[cardType.key as keyof typeof game] as number;
    const total =
      cardType.key === 'knights'
        ? 14
        : cardType.key === 'victoryPoints'
          ? 5
          : 2;

    display += `
      <div style="display: flex; flex-direction: column; align-items: center; min-width: 60px;">
        <div style="width: 32px; height: 40px; margin-bottom: 5px; display: flex; align-items: center; justify-content: center; background: white; border-radius: 4px; border: 1px solid #ddd;">
          <img src="${getDevCardIconUrl(cardType.icon)}" 
               style="width: 24px; height: 32px;" 
               alt="${cardType.name}" 
               title="${cardType.name}" />
        </div>
        <div style="font-size: 12px; font-weight: bold; color: #2c3e50;">
          ${remaining}/${total}
        </div>
        <div style="font-size: 9px; color: #666; text-align: center; line-height: 1.1;">
          ${cardType.name}
        </div>
      </div>
    `;
  });

  display += '</div></div>';
  return display;
}

function generateDiceChart(): string {
  const collapsed = uiPrefs.diceChartCollapsed;

  // Clickable header, always shown — collapsing only hides the bars below it,
  // so the chart never disappears entirely, just the space it takes up.
  let chart = `
    <div style="margin: 15px 0;">
      <h4
        id="dice-chart-header"
        style="margin: 0 0 ${collapsed ? 0 : 10}px 0; text-align: center; cursor: pointer; user-select: none;"
        title="${collapsed ? 'Show dice roll frequency' : 'Hide dice roll frequency'}"
      >Dice Roll Frequency <span style="font-size: 10px; color: #999;">${collapsed ? '▸' : '▾'}</span></h4>
  `;

  if (!collapsed) {
    const maxRolls = Math.max(...Object.values(game.diceRolls), 1);
    const chartHeight = 120;

    chart +=
      '<div style="display: flex; align-items: end; justify-content: space-between; height: ' +
      chartHeight +
      'px; border-bottom: 2px solid #333; padding: 0 5px;">';

    for (let i = 2; i <= 12; i++) {
      const rolls = game.diceRolls[i as keyof typeof game.diceRolls];
      const barHeight =
        maxRolls > 0 ? (rolls / maxRolls) * (chartHeight - 20) : 0;
      const barColor =
        i === 7 ? '#ff6b6b' : i === 6 || i === 8 ? '#4ecdc4' : '#45b7d1';

      chart += `
        <div style="display: flex; flex-direction: column; align-items: center; min-width: 25px;">
          <div style="font-size: 10px; font-weight: bold; margin-bottom: 2px;">${rolls}</div>
          <div style="
            width: 20px;
            height: ${barHeight}px;
            background: ${barColor};
            border-radius: 2px 2px 0 0;
            display: flex;
            align-items: end;
            justify-content: center;
            margin-bottom: 2px;
          "></div>
          <div style="font-size: 10px; font-weight: bold;">${i}</div>
        </div>
      `;
    }

    chart += '</div>';
  }

  chart += '</div>';
  return chart;
}

function generateBlockedDiceDisplay(): string {
  // Check if there are any blocked dice rolls
  const hasBlockedRolls = Object.keys(game.blockedDiceRolls).length > 0;

  if (!hasBlockedRolls) {
    return '';
  }

  let display =
    '<div style="margin: 15px 0;"><h4 style="margin: 0 0 10px 0; text-align: center;">🔒 Blocked by Robber</h4>';
  display +=
    '<div style="background: #f8f9fa; padding: 10px; border-radius: 6px; font-size: 12px; line-height: 1.4;">';

  // Collect all blocked entries
  const blockedEntries: Array<{
    number: number;
    resource: string;
    count: number;
  }> = [];

  Object.entries(game.blockedDiceRolls).forEach(([diceNumber, resources]) => {
    Object.entries(resources).forEach(([resource, count]) => {
      if (count > 0) {
        blockedEntries.push({
          number: parseInt(diceNumber),
          resource,
          count,
        });
      }
    });
  });

  // Sort by dice number, then by resource
  blockedEntries.sort((a, b) => {
    if (a.number !== b.number) {
      return a.number - b.number;
    }
    return a.resource.localeCompare(b.resource);
  });

  // Generate the display text
  const blockedTexts = blockedEntries.map(
    entry => `${entry.number} ${entry.resource}: ${entry.count}`
  );

  display += blockedTexts.join('<br>');
  display += '</div></div>';

  return display;
}

/**
 * Small pill showing one candidate resource + its probability for an
 * unresolved steal, using the same card art as the hand view instead of a
 * text list ("brick: 0.67, wheat: 0.33") — a glance at the icons says what
 * the words used to.
 */
function createResourceProbabilityChip(
  resource: keyof typeof RESOURCE_ICONS,
  probability: number
): string {
  return `
    <span style="
      display: inline-flex;
      align-items: center;
      gap: 2px;
      background: white;
      border: 1px solid #eee;
      border-radius: 3px;
      padding: 1px 4px;
    " title="${formatResourceName(resource)}: ${Math.round(probability * 100)}%">
      <img src="${getResourceIconUrl(resource)}" alt="${resource}"
        style="width: 10px; height: 14px;" />
      <span style="font-size: 10px; color: #555;">${Math.round(probability * 100)}%</span>
    </span>
  `;
}

/**
 * Unresolved robber/knight steals where the stolen resource is still
 * ambiguous. Each row leans on names, color, and icons instead of a
 * sentence: "<Thief> 🦹⟵ <Victim>" reads as "thief took a card from victim"
 * without spelling it out, and the candidate resources are icon chips
 * (see createResourceProbabilityChip) rather than a "could be: x, y" list.
 * Clicking a row still opens the same manual-resolution modal as before.
 */
function generateUnknownTransactionsDisplay(): string {
  const unresolvedTransactions = game.probableGameState
    .getUnknownTransactions()
    .filter(t => !t.isResolved);

  if (unresolvedTransactions.length === 0) {
    return '';
  }

  const playerColor = (name: string): string =>
    game.players.find(p => p.name === name)?.color ?? '#333';

  let display =
    '<div style="margin: 15px 0; padding: 8px; background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px;">';
  display +=
    '<h4 style="margin: 0 0 8px 0; color: #856404; font-size: 12px; text-align: center;">🎭 Unresolved Steals</h4>';

  unresolvedTransactions.forEach(transaction => {
    const transactionResourceProbabilities =
      game.probableGameState.getTransactionResourceProbabilities(
        transaction.id
      );

    const chips = transactionResourceProbabilities
      ? Object.entries(transactionResourceProbabilities)
          .filter(([, probability]) => probability > 0)
          .sort(([, a], [, b]) => b - a)
          .map(([resource, probability]) =>
            createResourceProbabilityChip(
              resource as keyof typeof RESOURCE_ICONS,
              probability
            )
          )
          .join('')
      : '';

    display += `<div
      class="unknown-transaction-item"
      data-transaction-id="${transaction.id}"
      style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
        padding: 6px 8px;
        background: white;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
        border: 1px solid transparent;
        transition: border-color 0.2s ease;
      "
      onmouseover="this.style.borderColor='#007bff';"
      onmouseout="this.style.borderColor='transparent';"
      title="${transaction.thief} may have taken one of these from ${transaction.victim} — click to resolve"
    >
      <span style="white-space: nowrap;">
        <strong style="color: ${playerColor(transaction.thief)};">${transaction.thief}</strong>
        <span style="color: #999;">🦹⟵</span>
        <strong style="color: ${playerColor(transaction.victim)};">${transaction.victim}</strong>
      </span>
      <span style="display: flex; gap: 3px; flex-wrap: wrap; justify-content: flex-end;">${chips}</span>
    </div>`;
  });

  display += '</div>';
  return display;
}

/**
 * Show modal for manually resolving an unknown transaction
 */
function showTransactionResolutionModal(transactionId: string): void {
  const transaction =
    game.probableGameState.getUnknownTransaction(transactionId);
  if (!transaction) {
    console.error(`Transaction ${transactionId} not found`);
    return;
  }

  const transactionResourceProbabilities =
    game.probableGameState.getTransactionResourceProbabilities(transactionId);

  if (!transactionResourceProbabilities) {
    console.error(
      `No resource probabilities found for transaction ${transactionId}`
    );
    return;
  }

  // Get only the resources that are possible (probability > 0)
  const possibleResources = Object.entries(transactionResourceProbabilities)
    .filter(([_, probability]) => probability > 0)
    .sort(([_, a], [__, b]) => b - a); // Sort by probability descending

  if (possibleResources.length === 0) {
    console.error(
      `No possible resources found for transaction ${transactionId}`
    );
    return;
  }

  const backdrop = createModalBackdrop();
  const dialog = createModalDialog();

  dialog.innerHTML = `
    <h3 style="margin: 0 0 15px 0; color: #2c3e50;">🔍 Resolve Unknown Transaction</h3>
    <p style="margin: 0 0 15px 0; color: #555;">
      <strong>${transaction.thief}</strong> stole from <strong>${transaction.victim}</strong><br>
      <small style="color: #666;">What resource was stolen?</small>
    </p>
    <div id="resource-buttons" style="display: flex; flex-direction: column; gap: 10px;">
    </div>
    <div style="margin-top: 15px; display: flex; justify-content: flex-end;">
      <button 
        id="cancel-resolve-btn"
        style="${STYLES.secondaryButton}"
      >Cancel</button>
    </div>
  `;

  const resourceButtonsContainer = dialog.querySelector('#resource-buttons');

  // Create resource buttons
  possibleResources.forEach(([resource, probability]) => {
    const button = createResourceButton(resource, probability, () => {
      resolveTransaction(transactionId, resource as keyof ResourceObjectType);
      document.body.removeChild(backdrop);
    });
    resourceButtonsContainer?.appendChild(button);
  });

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  // Add cancel button handler
  const cancelBtn = dialog.querySelector('#cancel-resolve-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(backdrop);
    });
  }

  // Close on backdrop click
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) {
      document.body.removeChild(backdrop);
    }
  });
}

/**
 * Resolve a transaction with the specified resource
 */
function resolveTransaction(
  transactionId: string,
  resource: keyof ResourceObjectType
): void {
  const success = game.probableGameState.resolveUnknownTransaction(
    transactionId,
    resource
  );

  if (success) {
    console.log(
      `✅ Manually resolved transaction ${transactionId} with resource: ${resource}`
    );
    // Update the display to reflect the resolution
    updateGameStateDisplay();
  } else {
    console.error(
      `❌ Failed to resolve transaction ${transactionId} with resource: ${resource}`
    );
  }
}

function generateMainContent(): string {
  const resourceSection =
    uiPrefs.resourceViewMode === 'hand'
      ? generateResourceHandView()
      : generateResourceProbabilityTable();
  const resourceCaption =
    uiPrefs.resourceViewMode === 'hand'
      ? 'Solid cards are guaranteed; whitened dashed cards show the chance of one more.'
      : 'Numbers shown are guaranteed resources, additional resources are shown as a probability';

  return `
    ${resourceSection}
    <div style="font-size: 12px; color: #666; text-align: center; line-height: 1.1;">${resourceCaption}</div>
    ${generateUnknownTransactionsDisplay()}
    ${generateDevCardsDisplay()}
    <div style="font-size: 12px; color: #666; text-align: center; line-height: 1.1;">Cards in your hand are currently not counted</div>
    ${generateDiceChart()}
    ${generateBlockedDiceDisplay()}
  `;
}

function generateLoadingContent(): string {
  return `
    <div style="
      text-align: center;
      padding: 40px 20px;
      color: #666;
      font-size: 14px;
      line-height: 1.5;
    ">
      <style>@keyframes catan-spin { to { transform: rotate(360deg); } }</style>
      <div class="catan-spinner" style="
        width: 40px;
        height: 40px;
        margin: 0 auto 18px;
        border: 4px solid #e0e0e0;
        border-top-color: #2c3e50;
        border-radius: 50%;
        animation: catan-spin 0.8s linear infinite;
      "></div>
      <div style="font-weight: bold; margin-bottom: 8px; color: #2c3e50;">
        Loading game history…
      </div>
      <div>
        Scrolling the chat and rebuilding resource counts.
      </div>
    </div>
  `;
}

function generateWaitingContent(): string {
  return `
    <div style="
      text-align: center; 
      padding: 40px 20px; 
      color: #666;
      font-size: 14px;
      line-height: 1.5;
    ">
      <div style="font-size: 48px; margin-bottom: 20px;">🎲</div>
      <div style="font-weight: bold; margin-bottom: 10px; color: #2c3e50;">
        Waiting for first dice roll...
      </div>
      <div>
        The counter will start tracking resources once the first dice is rolled in the game.
      </div>
    </div>
  `;
}

function updateOverlayContent(overlay: HTMLDivElement): void {
  const contentDisplay = isMinimized ? 'none' : 'block';
  const mainContent = isLoadingHistory
    ? generateLoadingContent()
    : game.hasRolledFirstDice
      ? generateMainContent()
      : generateWaitingContent();

  overlay.innerHTML = `
    <div id="overlay-header" style="
      background: #2c3e50;
      color: white;
      padding: 10px;
      border-radius: 6px 6px ${isMinimized ? '6px 6px' : '0 0'};
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
      user-select: none;
      flex: 0 0 auto;
    ">
      <div style="font-weight: bold;">🎲 Catan Counter</div>
      <div style="display: flex; align-items: center; gap: 2px;">
        <button id="view-toggle-btn" style="
          background: none;
          border: none;
          color: white;
          cursor: pointer;
          font-size: 14px;
          padding: 2px 6px;
          border-radius: 3px;
        " title="${uiPrefs.resourceViewMode === 'table' ? 'Switch to Hand view' : 'Switch to Table view'}">${uiPrefs.resourceViewMode === 'table' ? '🃏' : '📋'}</button>
        <button id="save-log-btn" style="
          background: none;
          border: none;
          color: white;
          cursor: pointer;
          font-size: 14px;
          padding: 2px 6px;
          border-radius: 3px;
        " title="Download this game's chat log as JSON">💾</button>
        <button id="minimize-btn" style="
          background: none;
          border: none;
          color: white;
          cursor: pointer;
          font-size: 16px;
          padding: 2px 6px;
          border-radius: 3px;
        " title="${isMinimized ? 'Expand' : 'Minimize'}">${isMinimized ? '□' : '−'}</button>
      </div>
    </div>
    
    <div id="overlay-content" style="display: ${contentDisplay}; padding: 15px; flex: 1 1 auto; min-height: 0; overflow-y: auto; position: relative;">
      ${mainContent}
      <div class="resize-handle" style="
        position: absolute;
        bottom: 0;
        right: 0;
        width: 20px;
        height: 20px;
        cursor: nw-resize;
        background: linear-gradient(-45deg, transparent 0%, transparent 30%, #ccc 30%, #ccc 40%, transparent 40%, transparent 60%, #ccc 60%, #ccc 70%, transparent 70%);
        border-radius: 0 0 6px 0;
      " title="Drag to resize"></div>
    </div>
  `;

  // Add minimize button functionality
  const minimizeBtn = overlay.querySelector(
    '#minimize-btn'
  ) as HTMLButtonElement;
  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', e => {
      e.stopPropagation(); // Prevent dragging when clicking minimize
      toggleMinimize();
    });
  }

  // Add view-toggle button functionality
  const viewToggleBtn = overlay.querySelector(
    '#view-toggle-btn'
  ) as HTMLButtonElement;
  if (viewToggleBtn) {
    viewToggleBtn.addEventListener('click', e => {
      e.stopPropagation(); // Prevent dragging when clicking the toggle
      toggleResourceViewMode();
    });
  }

  // Add dice-chart collapse/expand functionality
  const diceChartHeader = overlay.querySelector('#dice-chart-header');
  if (diceChartHeader) {
    diceChartHeader.addEventListener('click', () => {
      toggleDiceChartCollapsed();
    });
  }

  // Add save-log button functionality
  const saveLogBtn = overlay.querySelector(
    '#save-log-btn'
  ) as HTMLButtonElement;
  if (saveLogBtn) {
    saveLogBtn.addEventListener('click', e => {
      e.stopPropagation(); // Prevent dragging when clicking save
      downloadCurrentGameLog();
    });
  }

  // Add event listeners for transaction items
  const transactionItems = overlay.querySelectorAll(
    '.unknown-transaction-item'
  );
  transactionItems.forEach(item => {
    item.addEventListener('click', e => {
      const transactionId = item.getAttribute('data-transaction-id');
      if (transactionId) {
        showTransactionResolutionModal(transactionId);
      }
    });
  });
}

function toggleMinimize(): void {
  isMinimized = !isMinimized;
  if (gameStateOverlay) {
    updateOverlayContent(gameStateOverlay);
  }
}

export function showGameStateOverlay(): void {
  if (!gameStateOverlay) {
    gameStateOverlay = createGameStateOverlay();
    document.body.appendChild(gameStateOverlay);
  } else {
    updateOverlayContent(gameStateOverlay);
    gameStateOverlay.style.display = 'block';
  }
}

export function hideGameStateOverlay(): void {
  if (gameStateOverlay) {
    gameStateOverlay.style.display = 'none';
  }
}

export function updateGameStateDisplay(): void {
  if (gameStateOverlay && gameStateOverlay.style.display !== 'none') {
    updateOverlayContent(gameStateOverlay);
    // Reapply the current scale after updating content
    gameStateOverlay.style.transform = `scale(${currentScale})`;
  }
}

export function setYouPlayerSelectedCallback(callback: () => void): void {
  youPlayerSelectedCallback = callback;
}

/**
 * Toggle the "loading game history" state. While true the overlay shows a
 * spinner instead of the resource tables, since the counts are still being
 * rebuilt by scrolling the chat (see content.ts loadChatHistory).
 */
export function setHistoryLoading(loading: boolean): void {
  isLoadingHistory = loading;
  if (gameStateOverlay) {
    updateOverlayContent(gameStateOverlay);
  }
}

export function showYouPlayerDialog(): void {
  if (game.players.length === 0) return;

  // Mark that we've asked to prevent multiple dialogs
  markYouPlayerAsked();

  // Create modal backdrop
  const backdrop = document.createElement('div');
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 10001;
    display: flex;
    justify-content: center;
    align-items: center;
  `;

  // Create dialog
  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: white;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    max-width: 400px;
    width: 90%;
    font-family: Arial, sans-serif;
  `;

  dialog.innerHTML = `
    <h3 style="margin: 0 0 15px 0; color: #2c3e50;">🎲 Catan Counter Setup</h3>
    <p style="margin: 0 0 20px 0; color: #555;">
      Which player are you? This helps the extension track when resources are stolen "from you".
    </p>
    <div id="player-buttons" style="display: flex; flex-direction: column; gap: 10px;">
      ${game.players
        .map(
          player => `
        <button 
          data-player="${player.name}" 
          style="
            padding: 12px; 
            border: 2px solid #3498db; 
            background: #ecf0f1; 
            border-radius: 6px; 
            cursor: pointer; 
            font-weight: bold;
            transition: all 0.2s;
          "
          onmouseover="this.style.background='#3498db'; this.style.color='white';"
          onmouseout="this.style.background='#ecf0f1'; this.style.color='black';"
        >
          ${player.name}
        </button>
      `
        )
        .join('')}
    </div>
  `;

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  // Add click handlers
  const buttons = dialog.querySelectorAll('[data-player]');
  buttons.forEach(button => {
    button.addEventListener('click', () => {
      const playerName = button.getAttribute('data-player');
      if (playerName) {
        setYouPlayer(playerName);
        console.log(`🎯 "You" player set to: ${playerName}`);
        document.body.removeChild(backdrop);

        // Trigger reprocessing callback if provided
        if (youPlayerSelectedCallback) {
          youPlayerSelectedCallback();
        }
      }
    });
  });

  // Close on backdrop click
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) {
      document.body.removeChild(backdrop);
    }
  });
}
