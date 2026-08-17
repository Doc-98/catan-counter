# Catan Counter Chrome Extension

A Chrome extension that automatically tracks game state for Settlers of Catan games played on [colonist.io](https://colonist.io). The extension monitors chat messages and maintains a real-time count of resources, development cards, dice rolls, and player statistics using advanced probabilistic variant tracking.

## Features

### 🎲 **Game State Tracking**

- **Player Resources**: Tracks wheat, sheep, brick, wood, and ore for all players
- **Development Cards**: Monitors knights, victory points, year of plenty, road builders, and monopolies
- **Dice Rolls**: Records frequency of all dice roll results (2-12)
- **Blocked Dice Tracking**: Monitors when robber blocks resource production by dice number and resource type
- **Building Counts**: Tracks settlements, cities, and roads remaining for each player
- **Victory Points**: Monitors VP progress for all players

### 📊 **Enhanced User Interface**

- **Modern Overlay**: Clean, organized display with resource tables and dice roll charts
- **Probabilistic Resource Display**: Shows guaranteed resources plus probability of additional resources
- **Draggable & Resizable**: Move and scale the overlay to your preference
- **Minimize/Maximize**: Collapse to header-only for minimal screen usage
- **Responsive Tables**: Color-coded resource tracking with remaining bank resources
- **Interactive Charts**: Visual dice roll frequency with statistical bars

### 🎯 **Smart Player Identification**

- **"You" Player Setup**: One-time dialog to identify your player for accurate tracking
- **Automatic Detection**: Triggers on first dice roll when all players are loaded
- **Message Reprocessing**: Re-analyzes all chat history once your identity is known
- **Enhanced Theft Tracking**: Properly handles "stole [resource] from you" messages

### 📊 **Real-time Monitoring**

- **Live Updates**: Game state updates automatically as chat messages appear
- **Page Refresh / Reconnect Recovery**: colonist renders the chat as a virtual scroller that only keeps ~15 messages in the DOM, so on refresh the extension scrolls the chat from top to bottom to rebuild the **entire** game history. The sweep reads the scroller's live position each step (the scroller corrects its estimated height as rows render and re-pins to the bottom when live messages arrive) and re-sweeps if any rows were missed. All rows flow through a `MessageOrderBuffer` that feeds the parser in strict `data-index` order — rows rendered out of order wait behind the gap instead of being lost. A spinner is shown in the overlay while this runs and is replaced by the resource tables once the counts are rebuilt.
- **Contradiction tolerance**: chat messages are ground truth — if an observed trade/steal/monopoly is impossible in every tracked variant (e.g. some messages were still missed), the tracker force-applies the observation with clamping and warns, instead of eliminating every variant and crashing mid-prune.
- **Intelligent Processing**: Pauses during setup, then reprocesses for accuracy
- **Comprehensive Logging**: Detailed console output for debugging

### 📼 **Game Message Logging**

- **Automatic capture**: Every chat message is recorded (plain text + verbatim HTML, deduped by `data-index`) independently of the parser, so the log is complete even for messages the parser ignores
- **Auto-saved per game**: Each game is persisted to `chrome.storage.local` under `catanGameLog:<gameId>` (the game id comes from the colonist URL hash) — no clicks needed, and logs survive refreshes, tab closes, and navigation
- **One-click export**: The 💾 button in the overlay header downloads the current game as `catan-game-<gameId>-<timestamp>.json`
- **Export everything**: From DevTools (select the extension's content-script context in the console dropdown), run `__catanCounter.exportAllGameLogs()` to download all stored games as a single JSON file
- **Versioned schema** (`schemaVersion: 1`) with game metadata — game id, URL, players, which player captured the log (`youPlayerName`), timestamps — designed so logs collected from many users can later be pooled as training data for a Catan-playing bot

Exported JSON shape:

```json
{
  "schemaVersion": 1,
  "gameId": "green9433",
  "url": "https://colonist.io/#green9433",
  "startedAt": "2026-08-17T20:29:09.000Z",
  "updatedAt": "2026-08-17T21:02:41.000Z",
  "youPlayerName": "Camilo#6469",
  "players": ["Aaren", "Camilo#6469", "Botzow", "Mathe"],
  "messages": [
    {
      "index": 2,
      "text": "Aaren placed a Settlement",
      "html": "<div data-index=\"2\" ...>",
      "loggedAt": "..."
    }
  ]
}
```

### 🎯 **Supported Game Events**

- Resource collection from dice rolls
- Building placement (settlements, cities, roads)
- Development card purchases and usage
- Player-to-player trades
- Bank trades (4:1 and port trades)
- Resource stealing (robber and knight)
- **"From you" theft tracking** (requires player identification)
- Development card effects (Year of Plenty, Monopoly, Road Building)
- Resource discarding
- Starting resource distribution

### 🧠 **Advanced Variant-Based Probabilistic Tracking**

- **Variant Tree System**: When uncertainty exists (like unknown resource steals), creates a tree of possible game states with calculated probabilities
- **Smart Variant Resolution**: Automatically eliminates impossible variants when players take actions that reveal information
- **Dynamic Probability Calculations**: Real-time recalculation of resource probabilities as new information becomes available
- **Probabilistic Resource Display**: Shows minimum guaranteed resources and probability of having additional resources (e.g., "2 +67%" means at least 2 guaranteed, 67% chance of more)
- **Branch Elimination**: When players make offers or spend resources, impossible variants are automatically pruned
- **Automatic Deduction**: Single-resource-type steals are instantly resolved without creating variants
- **Unknown-Transaction Refinement**: after every message the tracker collapses the whole tree when every variant agrees on the current hands — historical steals that no longer affect anyone's cards (e.g. a card that made a round trip) retire from the Unknown Transactions list instead of lingering forever. Two additional _approximate_ refinements — culling outcome branches below 3% probability and auto-resolving steals once one outcome reaches ≥95% — are gated behind `trackerConfig.approximateRefinements` (`src/trackerConfig.ts`, off by default, so the tracker only ever states what provably follows from the chat)
- **Hand-Count Resolution**: Reads each player's current resource-card count from colonist's player-information panel (`[data-player-information-container]`) and prunes any variant whose per-player totals don't match. This resolves uncertain steals that the chat alone cannot — most notably **after a monopoly**, where different variants disagree on how many cards a player kept, the known hand sizes pin the distribution and collapse the remaining ambiguity.

## Installation

### Prerequisites

- Node.js — version is pinned in [`.nvmrc`](.nvmrc) (currently Node 24). With
  [nvm](https://github.com/nvm-sh/nvm) installed, run `nvm use` in the repo root.
- npm
- Google Chrome (or another Chromium-based browser)

### Setup

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd catan-counter
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the extension**

   ```bash
   npm run build
   ```

4. **Load in Chrome**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" in the top right
   - Click "Load unpacked"
   - Select the `catan-counter` folder

## Development

### Available Scripts

- **`npm run build`** - Bundle TypeScript modules into single JavaScript file using Rollup
- **`npm run watch`** - Watch for TypeScript changes and auto-bundle
- **`npm run format`** - Format all files with Prettier
- **`npm run format:check`** - Check if files are properly formatted
- **`npm run dev`** - Development mode: auto-format and bundle on file changes

#### Testing Scripts

- **`npm test`** - Run all tests with Jest
- **`npm run test:watch`** - Run tests in watch mode (auto-rerun on changes)
- **`npm run test:coverage`** - Run tests and generate coverage report
- **`npm run test:ci`** - Run tests in CI mode (no watch, with coverage)
- **`npm run test:update`** - Update Jest snapshots

### Development Workflow

1. **Start development mode**

   ```bash
   npm run dev
   ```

2. **Make changes** to any TypeScript files in the `src/` directory

3. **Run tests** to ensure your changes work correctly

   ```bash
   npm test
   ```

4. **Reload extension** in Chrome (click refresh icon on extension card)

5. **Test on colonist.io** by starting or joining a game

### Testing

The project uses Jest 30.0.2 with TypeScript support for comprehensive testing of the variant-based probabilistic system.

#### Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (reruns on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run tests in CI mode
npm run test:ci
```

#### Test Structure

Tests are organized with comprehensive coverage of game state management, chat parsing logic, and the variant-based probabilistic tracking system. The test suite includes both unit tests and integration tests with real HTML scenarios from colonist.io.

#### Writing Tests

- Tests use TypeScript with Jest globals (`@jest/globals`)
- DOM environment is mocked for browser extension testing
- Game state functions are thoroughly tested including the variant tree system
- Coverage targets: 80% for branches, functions, lines, and statements
- Helper functions like `expectMatchingVariantCombinations` for order-independent variant testing

#### Variant System Testing

The test suite includes comprehensive testing of the probabilistic variant tracking:

- **Variant creation** when unknown steals occur
- **Probability calculations** for different resource combinations
- **Variant resolution** when players take actions that eliminate possibilities
- **Complex multi-steal scenarios** with automatic branch pruning
- **Real-world game scenarios** with expected probability outcomes

## Usage

1. **Navigate to colonist.io** and start/join a Catan game

2. **Extension activates automatically** when it detects a game chat

3. **Player identification setup** - On the first dice roll, a dialog will appear asking you to identify which player you are. This enables accurate tracking of "from you" messages.

4. **View game state** in the enhanced overlay that appears in the top-right corner

5. **Interact with the overlay**:
   - **Drag** the header to move the overlay
   - **Minimize** using the (−) button to collapse to header only
   - **Resize** by dragging the bottom-right corner to scale proportionally
6. **Monitor real-time updates** as the game progresses

### Game State Display

The overlay features an organized, visual layout with:

#### 📋 **Resource Tables**

- **Main Resource Table**: Shows current known resource counts for each player
- **Probability Table**: Displays minimum guaranteed resources and probability of additional resources
- **Header columns** with resource emojis (🐑🌾🧱🌲⛰️) and remaining bank resources
- **Color-coded cells** for easy resource identification
- **Probabilistic Display**: Format like "2 +67%" (2 guaranteed, 67% chance of more)

#### 📊 **Dice Roll Chart**

- **Visual bar graph** showing frequency of each dice roll (2-12)
- **Roll counts** displayed above each bar
- **Color coding**: Red for 7, teal for 6&8, blue for others

#### 🎛️ **Interactive Controls**

- **Header bar** for dragging and minimizing
- **Resize handle** in bottom-right corner for proportional scaling
- **Minimize button** to collapse to header-only view

## Technical Details

### Architecture

- **Modular TypeScript**: Organized into separate modules for maintainability
- **Rollup Bundling**: Multiple TypeScript files compiled into single JavaScript output
- **Content Script**: Injected into colonist.io pages
- **Chat Monitoring**: Uses MutationObserver to detect new messages
- **Pattern Matching**: Analyzes chat messages and HTML structure
- **Variant Tree Management**: Maintains probabilistic game states with automatic branch pruning

### Message Processing

The extension recognizes 25+ different game scenarios including:

- Building placement and purchases
- Resource collection and trading
- Development card usage
- **Player theft scenarios** (including "from you" messages)
- **Unknown resource steals** with variant tree creation
- Special game events (robber movement, discarding, etc.)

### Variant-Based Probabilistic System

The extension features a sophisticated variant tree system for tracking uncertain game states:

#### Core Components

- **`Variant`**: Represents a single possible game state with probability
- **`VariantNode`**: Tree node containing variants with parent/child relationships
- **`VariantTree`**: Manages the complete tree of possible game states
- **`VariantTransactionProcessor`**: Handles transaction processing across variants
- **`PropbableGameState`**: Integrates variant system with game state management

#### Key Features

- **Probabilistic Resource Tracking**: Calculates exact probabilities based on known information
- **Smart Deduction**: Automatically resolves steals when victims have only one resource type
- **Branch Elimination**: Removes impossible variants when players reveal information through actions
- **Transaction Type Safety**: Uses discriminated unions for type-safe transaction processing
- **Real-time Recalculation**: Maintains accurate probabilities as game state evolves

#### Example Scenarios

- **Unknown Steal**: Player steals from someone with multiple resource types → Creates variants for each possibility
- **Resource Offer**: Player offers resources they might not have → Eliminates impossible variants
- **Building Action**: Player builds something requiring specific resources → Resolves which variant was correct
- **Multiple Steals**: Handles complex scenarios with multiple unknown steals and their interactions

### Smart Reprocessing System

- **Player Detection**: Automatically identifies when player setup is needed
- **Processing Pause**: Stops processing new messages during player identification
- **Complete Reanalysis**: Re-examines all chat history with "you" player context
- **Accurate Attribution**: Ensures proper resource tracking for all theft events

### Modular Architecture

The codebase is organized into focused modules for better maintainability:

- **`types.ts`** - All TypeScript interface definitions and type declarations
- **`gameState.ts`** - Game state initialization, player management, and resource tracking
- **`gameStateWithVariants.ts`** - Enhanced game state with probabilistic variant tracking
- **`variants.ts`** - Core variant tree system classes
- **`variantTransactions.ts`** - Transaction processing for the variant system
- **`domUtils.ts`** - DOM element querying, resource parsing, and utility functions
- **`overlay.ts`** - Draggable game state overlay UI with probabilistic resource display
- **`chatParser.ts`** - Core chat message parsing logic handling 24+ game scenarios
- **`messageLogger.ts`** - Records raw chat messages per game, persists them to `chrome.storage.local`, and exports them as JSON
- **`content.ts`** - Main entry point, initialization, and mutation observer setup

All modules are bundled into a single `content.js` file using Rollup for optimal browser performance.

### Browser Compatibility

- Chrome (primary target)
- Other Chromium-based browsers (Edge, Brave, etc.)

## Project Structure

```
catan-counter/
├── src/
│   ├── content.ts              # Main entry point and initialization
│   ├── types.ts                # TypeScript interface definitions
│   ├── gameState.ts            # Game state management and utilities
│   ├── gameStateWithVariants.ts # Enhanced game state with variant tracking
│   ├── variants.ts             # Core variant tree system classes
│   ├── variantTransactions.ts  # Transaction processing for variants
│   ├── domUtils.ts             # DOM querying and utility functions
│   ├── overlay.ts              # Draggable overlay UI with probabilistic display
│   ├── chatParser.ts           # Chat message parsing logic
│   └── __tests__/              # Test files directory
│       ├── gameProbabilities.test.ts    # Variant system integration tests
│       ├── testUtils.ts                 # Test helper functions
│       ├── gameActions.test.ts          # Game action tests
│       ├── chatParser.integration.test.ts # Chat parser integration tests
│       └── scenarios/                   # Test HTML scenarios
├── manifest.json               # Chrome extension manifest
├── overlay.css                # Styling for game overlay
├── content.js                 # Bundled JavaScript output (generated)
├── rollup.config.js           # Rollup bundler configuration
├── jest.config.js             # Jest testing configuration
├── jest.setup.ts              # Test environment setup
├── package.json               # Dependencies and scripts
├── tsconfig.json              # TypeScript configuration
├── .prettierrc                # Code formatting rules
├── .prettierignore            # Files to ignore in formatting
└── README.md                  # This file
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run formatting (`npm run format`)
5. Run tests (`npm test`)
6. Commit your changes (`git commit -m 'Add amazing feature'`)
7. Push to the branch (`git push origin feature/amazing-feature`)
8. Open a Pull Request

## License

This project is licensed under the ISC License - see the package.json file for details.

## Disclaimer

This extension is designed for educational and analytical purposes. It does not provide any unfair advantage in gameplay and only tracks information that is already visible in the game chat.
