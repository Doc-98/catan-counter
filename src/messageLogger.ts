// messageLogger.ts
// Records every colonist.io chat message (raw HTML + plain text) for the current
// game so real games can be exported as example datasets — and, longer term,
// pooled across many users to train a Catan-playing bot. Logging is independent
// of the parser: it keeps its own data-index dedup and saves messages verbatim,
// so the log stays complete even for messages the parser ignores.
//
// Persistence: each game is auto-saved to chrome.storage.local under
// `catanGameLog:<gameId>` (debounced), so finished games survive navigation and
// tab closes without any user action. The overlay's 💾 button downloads the
// current game as JSON; exportAllGameLogs() downloads every stored game.

import { game } from './gameState.js';

// Minimal typing for the pieces of the extension API we use — the project
// doesn't depend on @types/chrome, and `chrome` is undefined under Jest/jsdom.
declare const chrome:
  | {
      storage?: {
        local: {
          get(keys: string | string[] | null): Promise<Record<string, unknown>>;
          set(items: Record<string, unknown>): Promise<void>;
        };
      };
    }
  | undefined;

export interface LoggedMessage {
  /** colonist's data-index for the chat row — unique, chronological */
  index: number;
  /** plain text of the message (what a human reads) */
  text: string;
  /** verbatim outerHTML — preserves player colors, resource icons, etc. */
  html: string;
  /** ISO timestamp of when this client first saw the message. During a
   * post-refresh history replay this is capture time, not game time. */
  loggedAt: string;
}

export interface GameLog {
  /** bump when the shape changes so pooled logs from many users stay parseable */
  schemaVersion: 1;
  gameId: string;
  url: string;
  startedAt: string;
  updatedAt: string;
  /** which player this log was captured by (null until identified) */
  youPlayerName: string | null;
  players: string[];
  messages: LoggedMessage[];
}

const STORAGE_KEY_PREFIX = 'catanGameLog:';
const PERSIST_DEBOUNCE_MS = 1000;

let currentLog: GameLog | null = null;
const seenIndices = new Set<number>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function storageAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.local;
}

function getGameIdFromUrl(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || 'unknown';
}

/**
 * Start (or resume) logging for the game identified by the current URL. If a
 * log for this game already exists in chrome.storage.local (e.g. after a page
 * refresh), it is loaded and new messages are merged into it.
 */
export async function initMessageLogger(): Promise<void> {
  const gameId = getGameIdFromUrl();
  const now = new Date().toISOString();

  currentLog = {
    schemaVersion: 1,
    gameId,
    url: window.location.href,
    startedAt: now,
    updatedAt: now,
    youPlayerName: null,
    players: [],
    messages: [],
  };
  seenIndices.clear();

  if (!storageAvailable()) return;

  try {
    const key = STORAGE_KEY_PREFIX + gameId;
    const stored = await chrome!.storage!.local.get(key);
    const existing = stored[key] as GameLog | undefined;
    if (existing?.messages) {
      currentLog = { ...existing, updatedAt: now };
      for (const message of currentLog.messages) {
        seenIndices.add(message.index);
      }
      console.log(
        `📼 Resumed game log for "${gameId}" (${currentLog.messages.length} messages)`
      );
    }
  } catch (error) {
    console.warn('📼 Could not load stored game log:', error);
  }
}

/**
 * Record one chat row. Safe to call repeatedly with the same element (history
 * replay re-renders overlapping windows) — rows are deduped by data-index.
 */
export function logChatMessage(element: HTMLElement): void {
  if (!currentLog) return;

  const dataIndexAttr = element.getAttribute('data-index');
  if (dataIndexAttr === null) return;
  const index = parseInt(dataIndexAttr, 10);
  if (isNaN(index) || seenIndices.has(index)) return;

  seenIndices.add(index);
  currentLog.messages.push({
    index,
    text: element.textContent?.trim() ?? '',
    html: element.outerHTML,
    loggedAt: new Date().toISOString(),
  });
  schedulePersist();
}

/** Refresh the metadata snapshot from live game state and keep messages sorted. */
function snapshotMetadata(log: GameLog): void {
  log.updatedAt = new Date().toISOString();
  log.youPlayerName = game.youPlayerName;
  log.players = game.players.map(p => p.name);
  log.messages.sort((a, b) => a.index - b.index);
}

function schedulePersist(): void {
  if (!storageAvailable()) return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistCurrentLog();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistCurrentLog(): Promise<void> {
  if (!currentLog || !storageAvailable()) return;
  snapshotMetadata(currentLog);
  try {
    await chrome!.storage!.local.set({
      [STORAGE_KEY_PREFIX + currentLog.gameId]: currentLog,
    });
  } catch (error) {
    console.warn('📼 Could not persist game log:', error);
  }
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Download the current game's log as a JSON file (wired to the overlay's 💾
 * button). Returns the exported log, or null when nothing has been captured.
 */
export function downloadCurrentGameLog(): GameLog | null {
  if (!currentLog || currentLog.messages.length === 0) {
    console.warn('📼 No messages captured yet — nothing to download');
    return null;
  }
  snapshotMetadata(currentLog);
  downloadJson(
    currentLog,
    `catan-game-${currentLog.gameId}-${timestampSlug()}.json`
  );
  return currentLog;
}

/**
 * Download every game log stored by this extension as one JSON file. Run from
 * the extension's content-script console context:
 *   __catanCounter.exportAllGameLogs()
 */
export async function exportAllGameLogs(): Promise<GameLog[]> {
  if (!storageAvailable()) {
    console.warn('📼 chrome.storage is not available');
    return [];
  }
  const all = await chrome!.storage!.local.get(null);
  const logs = Object.entries(all)
    .filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
    .map(([, value]) => value as GameLog)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  if (logs.length === 0) {
    console.warn('📼 No stored game logs found');
    return [];
  }
  downloadJson(logs, `catan-games-all-${timestampSlug()}.json`);
  return logs;
}

/** Test-only: clear module state between tests. */
export function _resetMessageLoggerForTesting(): void {
  currentLog = null;
  seenIndices.clear();
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

/** Test-only: inspect the in-memory log. */
export function _getCurrentLogForTesting(): GameLog | null {
  return currentLog;
}
