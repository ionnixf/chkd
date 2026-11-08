<p align="center">
  <img src="icons/icon.svg" width="80" height="80" alt="chkd logo">
</p>

<h1 align="center">chkd</h1>

<p align="center">
  Lightweight Firefox extension for local chess position analysis on Chess.com and Lichess.
</p>

---

## Features

- **Local engine**: Runs Stockfish via WebAssembly inside the browser. No API keys, accounts, or remote servers.
- **Visual hints**: Real-time best move arrows on the board and evaluation bar in the popup.
- **Auto-detection**: Automatically tracks the active tab and board position.
- **Configurable**: Adjustable search time per move (0.1s to 1s) and engine hash memory.

## Installation (Temporary Add-on)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` from this repository.

## Development & Tests

Run test suite:

```bash
node tests/run-tests.js
```

## Disclaimer

Intended for analysis, study, and play against computer opponents. Do not use engine assistance in live games against human players.
