'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ChessRules = require('../vendor/chess-rules.iife.js');
const Config = require('../background/config.js');
const EngineMod = require('../background/engine.js');
const SessionsMod = require('../background/sessions.js');
const BackgroundMod = require('../background/background.js');
const PositionMod = require('../content/position.js');
const LichessAdapter = require('../content/adapters/lichess.js');
const ChessComAdapter = require('../content/adapters/chesscom.js');
const OverlayMod = require('../content/overlay.js');
const ContentMod = require('../content/content.js');
const PopupMod = require('../popup/popup.js');

// ---------------------------------------------------------------------------
// Helpers & Mocks for DOM, Ports, Storage, and Workers
// ---------------------------------------------------------------------------

function createMockStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      if (typeof keys === 'object') {
        const out = { ...keys };
        for (const k of Object.keys(keys)) {
          if (k in store) out[k] = store[k];
        }
        return out;
      }
      return {};
    },
    async set(items) {
      Object.assign(store, items);
    }
  };
}

function createPortPair(name = 'knight:session', senderTab = { id: 1, url: 'https://lichess.org/analysis' }) {
  const contentListeners = [];
  const bgListeners = [];
  const contentDisconnectListeners = [];
  const bgDisconnectListeners = [];
  let connected = true;

  const contentPort = {
    name,
    sentByContent: [],
    postMessage(msg) {
      if (!connected) throw new Error('Port disconnected');
      const copy = JSON.parse(JSON.stringify(msg));
      this.sentByContent.push(copy);
      for (const fn of bgListeners) fn(copy);
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      for (const fn of bgDisconnectListeners) fn();
    },
    onMessage: { addListener: (fn) => contentListeners.push(fn) },
    onDisconnect: { addListener: (fn) => contentDisconnectListeners.push(fn) }
  };

  const bgPort = {
    name,
    sender: { tab: senderTab },
    sentByBg: [],
    postMessage(msg) {
      if (!connected) throw new Error('Port disconnected');
      const copy = JSON.parse(JSON.stringify(msg));
      this.sentByBg.push(copy);
      for (const fn of contentListeners) fn(copy);
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      for (const fn of contentDisconnectListeners) fn();
    },
    onMessage: { addListener: (fn) => bgListeners.push(fn) },
    onDisconnect: { addListener: (fn) => bgDisconnectListeners.push(fn) }
  };

  return { contentPort, bgPort };
}

class FakeWorker {
  constructor(behavior = {}) {
    this.commands = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.listeners = { message: [], error: [] };
    this.behavior = behavior;
  }

  addEventListener(type, fn) {
    if (this.listeners[type]) this.listeners[type].push(fn);
  }

  emitLine(line) {
    if (this.terminated) return;
    const ev = { data: line };
    if (typeof this.onmessage === 'function') this.onmessage(ev);
    for (const fn of this.listeners.message) fn(ev);
  }

  emitError(message) {
    if (this.terminated) return;
    const err = new Error(message || 'Simulated worker error');
    if (typeof this.onerror === 'function') this.onerror(err);
    for (const fn of this.listeners.error) fn(err);
  }

  postMessage(cmd) {
    if (this.terminated) throw new Error('Worker already terminated');
    this.commands.push(cmd);
    if (typeof this.behavior.onCommand === 'function') {
      this.behavior.onCommand(cmd, this);
      return;
    }
    if (cmd === 'uci') {
      setImmediate(() => {
        this.emitLine('id name Stockfish 19 Lite WASM');
        this.emitLine('uciok');
      });
    } else if (cmd === 'isready') {
      setImmediate(() => {
        this.emitLine('readyok');
      });
    } else if (cmd.startsWith('go ')) {
      setImmediate(() => {
        this.emitLine('info depth 10 seldepth 14 multipv 1 score cp 34 pv e2e4 e7e5');
        this.emitLine('bestmove e2e4 ponder e7e5');
      });
    } else if (cmd === 'stop') {
      setImmediate(() => {
        this.emitLine('bestmove e2e4');
      });
    }
  }

  terminate() {
    this.terminated = true;
  }
}

// ---------------------------------------------------------------------------
// 1. Manifest & Repository Structure Verification
// ---------------------------------------------------------------------------

test('Manifest V3, file structure, CSP, and zero external dependencies', () => {
  const rootDir = path.resolve(__dirname, '..');
  const manifestPath = path.join(rootDir, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage', 'scripting']);
  assert.deepEqual(manifest.host_permissions, [
    'https://www.chess.com/*',
    'https://lichess.org/*'
  ]);
  assert.equal(Object.hasOwn(manifest.background, 'persistent'), false);
  assert.deepEqual(
    manifest.browser_specific_settings.gecko.data_collection_permissions.required,
    ['none']
  );
  assert.match(manifest.content_security_policy.extension_pages, /'wasm-unsafe-eval'/);

  // Verify every file referenced in manifest exists
  for (const scriptRel of manifest.background.scripts) {
    assert.ok(fs.existsSync(path.join(rootDir, scriptRel)), `Missing background script: ${scriptRel}`);
  }
  for (const cs of manifest.content_scripts) {
    for (const jsRel of cs.js) {
      assert.ok(fs.existsSync(path.join(rootDir, jsRel)), `Missing content script: ${jsRel}`);
    }
  }
  assert.ok(fs.existsSync(path.join(rootDir, manifest.action.default_popup)));
  for (const iconRel of Object.values(manifest.icons || {})) {
    const iconBuf = fs.readFileSync(path.join(rootDir, iconRel));
    // Verify valid PNG magic header
    assert.deepEqual([...iconBuf.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  // Verify bundled Stockfish 19 Lite Single JS + WASM exist
  assert.ok(fs.existsSync(path.join(rootDir, 'vendor/stockfish/stockfish-19-lite-single.js')));
  assert.ok(fs.existsSync(path.join(rootDir, 'vendor/stockfish/stockfish-19-lite-single.wasm')));
  assert.ok(fs.existsSync(path.join(rootDir, 'LICENSES.md')));

  // Verify no setInterval() or eval() or innerHTML in our extension source files
  const customFiles = [
    ...manifest.background.scripts,
    ...manifest.content_scripts[0].js.filter((p) => !p.startsWith('vendor/')),
    'popup/popup.js'
  ];
  for (const rel of customFiles) {
    const code = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    assert.ok(!/\bsetInterval\s*\(/.test(code), `Forbidden setInterval in ${rel}`);
    assert.ok(!/\beval\s*\(/.test(code), `Forbidden eval in ${rel}`);
    assert.ok(!/\.innerHTML\b/.test(code), `Forbidden innerHTML in ${rel}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Position Contract & 24 Fixture Reconstructions (Section 6 & 16)
// ---------------------------------------------------------------------------

test('24 chess positions reconstruct full FEN without losing castling, ep, halfmove, or fullmove fields', () => {
  const fixtures = [
    {
      name: '1. Initial startpos (0 moves)',
      moves: [],
      expectedFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    },
    {
      name: '2. Single pawn advance 1. e4',
      moves: ['e4'],
      expectedFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
    },
    {
      name: '3. Open game 1. e4 e5 2. Nf3 Nc6 3. Bb5 (Ruy Lopez)',
      moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
      expectedFen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3'
    },
    {
      name: '4. En passant legal target square on d6 (1. e4 a6 2. e5 d5)',
      moves: ['e4', 'a6', 'e5', 'd5'],
      expectedFen: 'rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3'
    },
    {
      name: '5. En passant capture execution (1. e4 a6 2. e5 d5 3. exd6)',
      moves: ['e4', 'a6', 'e5', 'd5', 'exd6'],
      expectedFen: 'rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3'
    },
    {
      name: '6. En passant legal target square on e3 for Black (1. a3 d5 2. a4 d4 3. e4)',
      moves: ['a3', 'd5', 'a4', 'd4', 'e4'],
      expectedFen: 'rnbqkbnr/ppp1pppp/8/8/P2pP3/8/1PPP1PPP/RNBQKBNR b KQkq e3 0 3'
    },
    {
      name: '7. En passant suppressed when capturing pawn is pinned to king',
      initialFen: '4k3/8/8/r2pP2K/8/8/8/8 w - - 0 1',
      moves: ['Kg4', 'd4', 'Kf4'],
      expectedFen: '4k3/8/8/r3P3/3p1K2/8/8/8 b - - 1 2'
    },
    {
      name: '8. White kingside castling clears White castling rights only',
      moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O'],
      expectedFen: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4'
    },
    {
      name: '9. Both sides castle (White O-O, Black O-O-O)',
      moves: ['d4', 'd5', 'Nc3', 'Nc6', 'Bf4', 'Bf5', 'Qd2', 'Qd7', 'O-O-O', 'O-O-O'],
      expectedFen: '2kr1bnr/pppqpppp/2n5/3p1b2/3P1B2/2N5/PPPQPPPP/2KR1BNR w - - 8 6'
    },
    {
      name: '10. White h1 rook move removes only White K castling right',
      moves: ['h4', 'h5', 'Rh3', 'Rh6', 'Rg3', 'Rg6'],
      expectedFen: 'rnbqkbn1/ppppppp1/6r1/7p/7P/6R1/PPPPPPP1/RNBQKBN1 w Qq - 4 4'
    },
    {
      name: '11. White a1 rook move removes only White Q castling right',
      moves: ['a4', 'a5', 'Ra3', 'Ra6'],
      expectedFen: '1nbqkbnr/1ppppppp/r7/p7/P7/R7/1PPPPPPP/1NBQKBNR w Kk - 2 3'
    },
    {
      name: '12. Capturing opponent undisturbed rook on h8 removes Black k castling right',
      initialFen: 'r3k2r/ppppppp1/8/8/8/8/PPPPPPP1/R3K2R w KQkq - 0 1',
      moves: ['Rxh8'],
      expectedFen: 'r3k2R/ppppppp1/8/8/8/8/PPPPPPP1/R3K3 b Qq - 0 1'
    },
    {
      name: '13. Pawn promotion to Queen in SAN (e8=Q+)',
      initialFen: '6k1/4P3/8/8/8/8/8/4K3 w - - 0 1',
      moves: ['e8=Q+'],
      expectedFen: '4Q1k1/8/8/8/8/8/8/4K3 b - - 0 1'
    },
    {
      name: '14. Pawn underpromotion to Knight in UCI (c7d8n)',
      initialFen: '3rk2r/2P1pppp/8/8/8/8/4PPPP/4K2R w Kk - 0 1',
      moves: ['c7d8n'],
      expectedFen: '3Nk2r/4pppp/8/8/8/8/4PPPP/4K2R b Kk - 0 1'
    },
    {
      name: '15. Pawn underpromotion to Rook and Bishop',
      initialFen: '8/P6p/8/8/8/8/p6P/4K2k w - - 0 1',
      moves: ['a8=R', 'a1=B'],
      expectedFen: 'R7/7p/8/8/8/8/7P/b3K2k w - - 0 2'
    },
    {
      name: '16. UCI move sequence (Sicilian Najdorf)',
      moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'],
      expectedFen: 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6'
    },
    {
      name: '17. Unicode figurines and move annotations (♘f3!, 0-0)',
      moves: ['e4!', 'e5', '♘f3!?', '♞c6', '♗b5+', 'a6', '♗a4', '♘f6', '0-0'],
      expectedFen: 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5'
    },
    {
      name: '18. Scholar mate terminal checkmate position',
      moves: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'],
      expectedFen: 'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4',
      expectGameOver: true
    },
    {
      name: '19. Fool mate in 2 moves',
      moves: ['f3', 'e5', 'g4', 'Qh4#'],
      expectedFen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
      expectGameOver: true
    },
    {
      name: '20. Stalemate position reconstruction',
      initialFen: '7k/5K2/8/8/8/8/8/6Q1 w - - 0 1',
      moves: ['Qg6'],
      expectedFen: '7k/5K2/6Q1/8/8/8/8/8 b - - 1 1',
      expectGameOver: true
    },
    {
      name: '21. Halfmove clock accumulation over reversible knight moves',
      moves: ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'],
      expectedFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 8 5'
    },
    {
      name: '22. Disambiguated SAN rook moves (Rad1, Rad8)',
      initialFen: 'r3k2r/ppp2ppp/2n5/8/8/2N5/PPP2PPP/R3K2R w KQkq - 0 1',
      moves: ['O-O', 'O-O', 'Rad1', 'Rad8'],
      expectedFen: '3r1rk1/ppp2ppp/2n5/8/8/2N5/PPP2PPP/3R1RK1 w - - 4 3'
    },
    {
      name: '23. Direct full 6-field FEN on analysis board with 0 moves',
      directFen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
      moves: [],
      expectedFen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'
    },
    {
      name: '24. King-captures-rook castling notation (e1h1 / e8a8)',
      initialFen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
      moves: ['e1h1', 'e8a8'],
      expectedFen: '2kr3r/pppppppp/8/8/8/8/PPPPPPPP/R4RK1 w - - 2 2'
    }
  ];

  assert.ok(fixtures.length >= 20, 'Must test at least 20 positions');

  for (const f of fixtures) {
    const res = PositionMod.reconstructPosition({
      directFen: f.directFen || null,
      initialFen: f.initialFen || 'startpos',
      moves: f.moves,
      displayedBoard: f.expectedFen.split(' ')[0]
    });
    assert.equal(res.ok, true, `Failed fixture "${f.name}": ${res.reason}`);
    assert.equal(res.fen, f.expectedFen, `FEN mismatch in "${f.name}"`);
    if (f.expectGameOver) {
      assert.equal(res.isGameOver, true, `Expected gameOver in "${f.name}"`);
    }
  }
});

test('Position contract rejects piece-only guessing, invalid FEN, illegal moves, and DOM mismatches', () => {
  // 1. Missing move history + only displayedBoard pieces -> MUST fail with POSITION_UNCERTAIN
  const pieceOnly = PositionMod.reconstructPosition({
    directFen: null,
    moves: null,
    displayedBoard: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'
  });
  assert.equal(pieceOnly.ok, false);
  assert.equal(pieceOnly.errorCode, 'POSITION_UNCERTAIN');

  // 2. Partial 1-field directFen without state fields -> MUST fail with POSITION_UNCERTAIN
  const partialFen = PositionMod.reconstructPosition({
    directFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR',
    moves: []
  });
  assert.equal(partialFen.ok, false);
  assert.equal(partialFen.errorCode, 'POSITION_UNCERTAIN');

  // 3. Illegal move in history -> MUST fail with POSITION_UNCERTAIN
  const illegalHistory = PositionMod.reconstructPosition({
    moves: ['e4', 'e5', 'Ke3']
  });
  assert.equal(illegalHistory.ok, false);
  assert.equal(illegalHistory.errorCode, 'POSITION_UNCERTAIN');

  // 4. Displayed DOM board contradicts reconstructed move history -> MUST fail with POSITION_UNCERTAIN
  const domMismatch = PositionMod.reconstructPosition({
    moves: ['e4', 'e5'],
    displayedBoard: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR' // missing e5
  });
  assert.equal(domMismatch.ok, false);
  assert.equal(domMismatch.errorCode, 'POSITION_UNCERTAIN');

  // 5. UCI move validator checks legal vs illegal moves
  const validMove = PositionMod.validateUciMove(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'g1f3'
  );
  assert.equal(validMove.ok, true);
  assert.equal(validMove.san, 'Nf3');

  const illegalMove = PositionMod.validateUciMove(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'e1e3'
  );
  assert.equal(illegalMove.ok, false);
});

// ---------------------------------------------------------------------------
// 3. Site Adapters: LichessAdapter & ChessComAdapter
// ---------------------------------------------------------------------------

test('LichessAdapter modes (AI, Analysis, Human, BOT account blocked) and DOM parsing', () => {
  // Build minimal synthetic DOM helper
  function makeLichessDoc({ modeClass, hasAi, hasBot, movesList, activeIdx, flipped }) {
    const kwdbNodes = (movesList || []).map((san, idx) => ({
      textContent: san,
      classList: { contains: (c) => c === 'a1t' && idx === activeIdx },
      closest: () => null,
      getAttribute: () => null,
      querySelector: () => null
    }));

    const roundMovesRoot = movesList
      ? { querySelectorAll: (sel) => (sel === 'kwdb' ? kwdbNodes : []) }
      : null;

    const boardRoot = {
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 400, height: 400 }),
      getAttribute: () => null
    };

    const wrap = {
      getAttribute: () => null,
      classList: {
        contains: (c) =>
          (flipped && c === 'orientation-black') || (!flipped && c === 'orientation-white')
      }
    };

    return {
      documentElement: { getAttribute: () => null },
      querySelectorAll(sel) {
        if (sel.includes('.utitle') && hasBot) {
          return [{ textContent: 'BOT', getAttribute: () => 'true' }];
        }
        if (sel.includes('.player') && hasAi) {
          return [{ textContent: 'Stockfish level 4' }];
        }
        return [];
      },
      querySelector(sel) {
        if (sel.includes('cg-board')) return boardRoot;
        if (sel.includes('.cg-wrap')) return wrap;
        if (sel.includes('l4x')) return roundMovesRoot;
        if (sel === '.round__app, .round' && modeClass === 'round') return {};
        if (sel === '.analyse__board, .analyse' && modeClass === 'analysis') return {};
        return null;
      }
    };
  }

  // 1. Lichess built-in AI -> 'ai'
  const aiDoc = makeLichessDoc({ modeClass: 'round', hasAi: true, hasBot: false, movesList: ['e4', 'e5', 'Nf3'] });
  assert.equal(LichessAdapter.getGameMode({ hostname: 'lichess.org', pathname: '/AbCdEfGh' }, aiDoc), 'ai');
  assert.deepEqual(LichessAdapter.getMoveHistory(aiDoc), ['e4', 'e5', 'Nf3']);
  assert.equal(LichessAdapter.getOrientation(aiDoc), 'white');

  // 2. Lichess BOT account -> MUST return 'human' (blocked!) even if round
  const botDoc = makeLichessDoc({ modeClass: 'round', hasAi: false, hasBot: true, movesList: ['e4'] });
  assert.equal(LichessAdapter.getGameMode({ hostname: 'lichess.org', pathname: '/BotGame1' }, botDoc), 'human');

  // 3. Lichess human vs human -> 'human'
  const humanDoc = makeLichessDoc({ modeClass: 'round', hasAi: false, hasBot: false, movesList: ['d4'] });
  assert.equal(LichessAdapter.getGameMode({ hostname: 'lichess.org', pathname: '/HumanGm1' }, humanDoc), 'human');

  // 4. Lichess Analysis -> 'analysis', active move slicing, black orientation
  const analysisDoc = makeLichessDoc({
    modeClass: 'analysis',
    hasAi: false,
    hasBot: false,
    movesList: ['e4', 'c5', 'Nf3', 'd6'],
    activeIdx: 1,
    flipped: true
  });
  assert.equal(LichessAdapter.getGameMode({ hostname: 'lichess.org', pathname: '/analysis' }, analysisDoc), 'analysis');
  assert.deepEqual(LichessAdapter.getMoveHistory(analysisDoc), ['e4', 'c5']);
  assert.equal(LichessAdapter.getOrientation(analysisDoc), 'black');
});

test('ChessComAdapter modes (Computer Bot, Analysis, Live Human blocked), figurine SAN, and board squares', () => {
  const moveNodes = [
    {
      textContent: 'e4',
      parentElement: null,
      classList: { contains: () => false },
      closest: () => null,
      getAttribute: (a) => (a === 'data-ply' ? '1' : null),
      querySelector: () => null
    },
    {
      textContent: 'e5',
      parentElement: null,
      classList: { contains: () => false },
      closest: () => null,
      getAttribute: (a) => (a === 'data-ply' ? '2' : null),
      querySelector: () => null
    },
    {
      textContent: 'f3',
      parentElement: null,
      classList: { contains: () => false },
      closest: () => null,
      getAttribute: (a) => (a === 'data-ply' ? '3' : null),
      querySelector: (s) => (s === '[data-figurine]' ? { getAttribute: () => 'N' } : null)
    }
  ];

  // Build pieces for 1. e4 e5 2. Nf3
  const chess = new ChessRules.Chess();
  chess.move('e4');
  chess.move('e5');
  chess.move('Nf3');
  const board2D = chess.board();
  const pieceEls = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = board2D[r][f];
      if (sq) {
        const fileNum = f + 1;
        const rankNum = 8 - r;
        pieceEls.push({
          getAttribute(attr) {
            if (attr === 'class') return `piece ${sq.color}${sq.type} square-${fileNum}${rankNum}`;
            return null;
          }
        });
      }
    }
  }

  const boardRoot = {
    classList: { contains: (c) => c === 'flipped' },
    getAttribute: () => null,
    querySelectorAll: (s) => (s === '.piece' ? pieceEls : [])
  };

  const doc = {
    documentElement: { getAttribute: () => null },
    querySelector(sel) {
      if (sel.includes('wc-chess-board')) return boardRoot;
      if (sel.includes('wc-simple-move-list')) return { querySelectorAll: () => moveNodes };
      return null;
    }
  };

  assert.equal(
    ChessComAdapter.getGameMode({ hostname: 'www.chess.com', pathname: '/play/computer' }, doc),
    'ai'
  );
  assert.equal(
    ChessComAdapter.getGameMode({ hostname: 'www.chess.com', pathname: '/game/live/12345' }, doc),
    'human'
  );
  assert.equal(
    ChessComAdapter.getGameMode({ hostname: 'www.chess.com', pathname: '/analysis' }, doc),
    'analysis'
  );
  assert.equal(
    ChessComAdapter.getGameMode({ hostname: 'www.chess.com', pathname: '/home' }, doc),
    'unknown'
  );

  const moves = ChessComAdapter.getMoveHistory(doc);
  assert.deepEqual(moves, ['e4', 'e5', 'Nf3']);
  assert.equal(ChessComAdapter.getOrientation(doc), 'black');

  const placement = ChessComAdapter.readDisplayedPosition(doc);
  assert.equal(placement, 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R');
});

// ---------------------------------------------------------------------------
// 4. EngineController UCI State Machine, Cancellation, Timeout, Config Sync
// ---------------------------------------------------------------------------

test('Regression: Chess.com clock annotations are not moves or ply-zero selections', () => {
  const node = (text, { ply = null, selected = false, san = null } = {}) => ({
    textContent: text,
    parentElement: null,
    classList: { contains: (cls) => selected && cls === 'selected' },
    closest: () => null,
    getAttribute: (attr) => ({ 'data-ply': ply, 'data-san': san }[attr] || null),
    querySelector: () => null
  });
  let nodes = [];
  const doc = { querySelector: () => ({ querySelectorAll: () => nodes }) };
  for (const clock of ['9s', '0.9s', '250 ms', '1m', '0:09', '1:09.5', '1m 1s', '1m 22s', '1m1s', '1m\u00a022s', '1h 2m 3s', '1:02:03']) {
    // A clock can also carry the same ply as the following actual move.
    nodes = [node('d4'), node(clock, { ply: '2' }), node('d5', { ply: '2' }),
      node(clock, { selected: true })];
    const moves = ChessComAdapter.getMoveHistory(doc);
    assert.deepEqual(moves, ['d4', 'd5'], clock);
    const chess = new ChessRules.Chess();
    for (const move of moves) chess.move(move);
    assert.equal(chess.fen(), 'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2');
  }
  nodes = [node('d4'), node('d5'), node('Qh5')];
  assert.deepEqual(ChessComAdapter.getMoveHistory(doc), ['d4', 'd5', 'Qh5'],
    'Actual move tokens must still reach legality validation');
  nodes = [node('9s', { san: 'd4' })];
  assert.deepEqual(ChessComAdapter.getMoveHistory(doc), ['d4']);
  const clockChild = node('1m 1s', { selected: true, ply: '0' });
  clockChild.parentElement = { classList: { contains: cls => cls === 'node' } };
  nodes = [node('d4', { selected: true }), node('d5'), clockChild];
  assert.deepEqual(ChessComAdapter.getMoveHistory(doc), ['d4'], 'Nested clock cannot change the selected ply');

  // Full game shown in the report, with compound clocks interleaved.
  const game = ['Nc3', 'd5', 'd4', 'c5', 'dxc5', 'Nf6', 'Nf3', 'Nc6', 'e3', 'e6',
    'h4', 'Bxc5', 'g3', 'e5', 'h5', 'Bg4', 'h6', 'e4', 'Rh2', 'g6', 'b4', 'Bxb4',
    'Rb1', 'Bxf3', 'Qd2', 'Ba5', 'Rb5', 'O-O', 'Ba3', 'd4', 'exd4', 'Nxd4', 'Rh4', 'Nxb5'];
  nodes = game.flatMap((move, index) => [node(move), node(index === 29 ? '1m 1s' : '1m 22s')]);
  const history = ChessComAdapter.getMoveHistory(doc);
  assert.deepEqual(history, game);
  const chess = new ChessRules.Chess();
  for (const move of history) assert.ok(chess.move(move));
  const reconstructed = PositionMod.reconstructPosition({ initialFen: 'startpos', moves: history });
  assert.equal(reconstructed.ok, true);
  assert.equal(reconstructed.fen, chess.fen());

});

test('EngineController cancels stale search with single stop, suppresses stale bestmove, and runs latestPending', async () => {
  const results = [];
  let currentWorker = null;
  let workerCreations = 0;

  const engine = new EngineMod.EngineController({
    config: { enabled: true, movetimeMs: 300, hashMb: 16, keepWorkerWarmMs: 30000 },
    cacheSize: 0,
    workerFactory: () => {
      workerCreations += 1;
      currentWorker = new FakeWorker({
        onCommand(cmd, w) {
          if (cmd === 'uci') setImmediate(() => w.emitLine('uciok'));
          else if (cmd === 'isready') setImmediate(() => w.emitLine('readyok'));
          // Do not auto-finish 'go' so we can test overlapping searches
        }
      });
      return currentWorker;
    },
    onResult: (r) => results.push(r)
  });

  const fen1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const fen2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const fen3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

  // Start request 1
  engine.analyze({ sessionId: 's1', gameId: 'g1', revision: 1, fen: fen1, movetimeMs: 300, hashMb: 16 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.state, 'SEARCHING');
  assert.equal(workerCreations, 1);

  // While request 1 is SEARCHING, send request 2 and request 3 rapidly
  engine.analyze({ sessionId: 's1', gameId: 'g1', revision: 2, fen: fen2, movetimeMs: 300, hashMb: 16 });
  assert.equal(engine.state, 'STOPPING');
  engine.analyze({ sessionId: 's1', gameId: 'g1', revision: 3, fen: fen3, movetimeMs: 300, hashMb: 16 });
  assert.equal(engine.state, 'STOPPING');

  // Verify 'stop' was sent ONLY ONCE
  const stopCount = currentWorker.commands.filter((c) => c === 'stop').length;
  assert.equal(stopCount, 1, 'Must send stop exactly once per active search');

  // Now worker emits stale bestmove for request 1
  currentWorker.emitLine('info depth 8 score cp -20 pv e7e5');
  currentWorker.emitLine('bestmove e7e5');

  // Stale result for rev 1 MUST NOT be emitted, and engine must immediately start rev 3 (skipping superseded rev 2)
  assert.equal(results.length, 0, 'Stale bestmove must not be emitted');
  assert.equal(engine.state, 'SEARCHING');
  assert.equal(engine.activeRequest.revision, 3);
  assert.equal(engine.activeRequest.fen, fen3);

  // Emit info and bestmove for request 3 (Black to move: score cp -30 => White cp +30 => '+0.30')
  currentWorker.emitLine('info depth 14 score cp -30 pv b8c6');
  currentWorker.emitLine('bestmove b8c6 ponder f1b5');

  assert.equal(results.length, 1);
  assert.equal(results[0].revision, 3);
  assert.equal(results[0].fen, fen3);
  assert.equal(results[0].bestMove, 'b8c6');
  assert.equal(results[0].depth, 14);
  assert.equal(results[0].whiteCp, 30);
  assert.equal(results[0].evalText, '+0.30');

  engine.shutdown();
  assert.equal(engine.getActiveWorkerCount(), 0);
});

test('EngineController handles bestmove (none), Hash change during search, boot retry, and watchdog timeout', async () => {
  const results = [];
  const errors = [];
  let currentWorker = null;

  const engine = new EngineMod.EngineController({
    config: { enabled: true, movetimeMs: 100, hashMb: 16, keepWorkerWarmMs: 30000 },
    stopTimeoutMs: 60,
    workerFactory: () => {
      currentWorker = new FakeWorker({
        onCommand(cmd, w) {
          if (cmd === 'uci') setImmediate(() => w.emitLine('uciok'));
          else if (cmd === 'isready') setImmediate(() => w.emitLine('readyok'));
        }
      });
      return currentWorker;
    },
    onResult: (r) => results.push(r),
    onError: (e) => errors.push(e)
  });

  const mateFen = 'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';
  engine.analyze({ sessionId: 's1', gameId: 'g1', revision: 1, fen: mateFen, movetimeMs: 100, hashMb: 16 });
  await new Promise((r) => setTimeout(r, 20));

  // Change Hash to 32 MB while search is running
  engine.updateConfig({ enabled: true, movetimeMs: 100, hashMb: 32 });
  assert.ok(!currentWorker.commands.includes('setoption name Hash value 32'));

  // Emit bestmove (none) for checkmated position
  currentWorker.emitLine('info depth 1 score mate 0');
  currentWorker.emitLine('bestmove (none)');

  assert.equal(results.length, 1);
  assert.equal(results[0].gameOver, true);
  assert.equal(results[0].bestMove, null);

  // Now queue next search with new Hash (32 MB) and trigger a watchdog timeout on stop
  const nextFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const afterFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  engine.analyze({ sessionId: 's1', gameId: 'g1', revision: 2, fen: nextFen, movetimeMs: 100, hashMb: 32 });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(currentWorker.commands.includes('setoption name Hash value 32'));
  assert.equal(engine.state, 'SEARCHING');

  const hungWorker = currentWorker;
  engine.analyze({ sessionId: 's1', gameId: 'g1', revision: 3, fen: afterFen, movetimeMs: 100, hashMb: 32 });
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(hungWorker.terminated, true, 'Hung worker must be terminated by watchdog');
  assert.ok(errors.some((e) => e.code === 'ENGINE_TIMEOUT'));
  assert.notEqual(currentWorker, hungWorker, 'A new worker must be booted for latestPending');
  assert.equal(engine.state, 'SEARCHING');
  assert.equal(engine.activeRequest.revision, 3);

  currentWorker.emitLine('info depth 10 score cp 25 pv g1f3');
  currentWorker.emitLine('bestmove g1f3');
  assert.equal(results.length, 2);
  assert.equal(results[1].revision, 3);
  assert.equal(results[1].bestMove, 'g1f3');

  engine.shutdown();
});

test('EngineController retries once on ENGINE_BOOT_FAILED and then disables analysis', async () => {
  const errors = [];
  let bootAttempts = 0;

  const engine = new EngineMod.EngineController({
    config: { enabled: true, movetimeMs: 100, hashMb: 16 },
    bootTimeoutMs: 40,
    workerFactory: () => {
      bootAttempts += 1;
      return new FakeWorker({ onCommand() {} });
    },
    onError: (e) => errors.push(e)
  });

  engine.analyze({
    sessionId: 's1',
    gameId: 'g1',
    revision: 1,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  });

  await new Promise((r) => setTimeout(r, 130));
  assert.equal(bootAttempts, 2, 'Should attempt initial boot + 1 retry');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ENGINE_BOOT_FAILED');
  assert.equal(errors[0].disableEngine, true);
  assert.equal(engine.getActiveWorkerCount(), 0);
});

test('100 sequential position updates with zero result-binding errors and single Worker', async () => {
  const storage = createMockStorage({ enabled: true, movetimeMs: 100, hashMb: 16 });
  let activeWorkers = 0;
  let maxConcurrentWorkers = 0;

  const sessionCtrl = new SessionsMod.SessionController({
    storage,
    initialConfig: { enabled: true, movetimeMs: 100, hashMb: 16, multiPv: 1, showArrow: true, showEval: true, keepWorkerWarmMs: 30000 },
    workerFactory: () => {
      activeWorkers += 1;
      maxConcurrentWorkers = Math.max(maxConcurrentWorkers, activeWorkers);
      let activeGoFen = null;
      const w = new FakeWorker({
        onCommand(cmd) {
          if (cmd === 'uci') setImmediate(() => w.emitLine('uciok'));
          else if (cmd === 'isready') setImmediate(() => w.emitLine('readyok'));
          else if (cmd.startsWith('position fen ')) {
            activeGoFen = cmd.slice('position fen '.length).trim();
          } else if (cmd.startsWith('go ')) {
            const fenAtGo = activeGoFen;
            setImmediate(() => {
              const c = new ChessRules.Chess(fenAtGo);
              const moves = c.moves({ verbose: true });
              const move = moves[0] ? moves[0].lan : '(none)';
              w.emitLine(`info depth 9 score cp 15 pv ${move}`);
              w.emitLine(`bestmove ${move}`);
            });
          } else if (cmd === 'stop') {
            setImmediate(() => w.emitLine('bestmove e2e4'));
          }
        }
      });
      const origTerm = w.terminate.bind(w);
      w.terminate = () => {
        if (!w.terminated) activeWorkers -= 1;
        origTerm();
      };
      return w;
    }
  });

  const { contentPort, bgPort } = createPortPair('knight:session');
  sessionCtrl.handlePortConnect(bgPort);

  contentPort.postMessage({
    type: 'HELLO',
    v: 1,
    sessionId: 'seq-100',
    revision: 0,
    payload: { site: 'lichess', mode: 'analysis', gameId: 'game-100' }
  });

  const chess = new ChessRules.Chess();
  const receivedResults = [];
  bgPort.sentByBg.length = 0;

  for (let i = 1; i <= 100; i++) {
    let legal = chess.moves();
    if (legal.length === 0 || chess.isGameOver()) {
      chess.reset();
      legal = chess.moves();
    }
    chess.move(legal[i % legal.length]);
    const currentFen = chess.fen();

    contentPort.postMessage({
      type: 'POSITION_CHANGED',
      v: 1,
      sessionId: 'seq-100',
      revision: i,
      payload: { gameId: 'game-100', mode: 'analysis', fen: currentFen }
    });

    while (!bgPort.sentByBg.some((m) => m.type === 'ENGINE_RESULT' && m.revision === i)) {
      await new Promise((r) => setImmediate(r));
    }

    const matching = bgPort.sentByBg.filter(
      (m) => m.type === 'ENGINE_RESULT' && m.revision === i
    );
    assert.equal(matching.length, 1, `Expected result for revision ${i}`);
    assert.equal(matching[0].sessionId, 'seq-100');
    assert.equal(matching[0].payload.gameId, 'game-100');
    assert.equal(matching[0].payload.fen, currentFen);

    const legalCheck = PositionMod.validateUciMove(currentFen, matching[0].payload.bestMove);
    assert.equal(legalCheck.ok, true, `Illegal move ${matching[0].payload.bestMove} for rev ${i}`);
    receivedResults.push(matching[0]);
  }

  assert.equal(receivedResults.length, 100);
  assert.equal(maxConcurrentWorkers, 1, 'Never more than 1 active Stockfish Worker');
  sessionCtrl.engine.shutdown();
  assert.equal(activeWorkers, 0);
});

test('Multi-tab management, deduplication, human mode rejection, and Event Page restart', async () => {
  const storage = createMockStorage({ enabled: true, movetimeMs: 300, hashMb: 16, keepWorkerWarmMs: 120 });
  let workerInstances = 0;

  const createCtrl = () =>
    new SessionsMod.SessionController({
      storage,
      workerFactory: () => {
        workerInstances += 1;
        return new FakeWorker();
      }
    });

  const ctrl = createCtrl();
  await ctrl.init();

  const tab1 = createPortPair('knight:session', { id: 101, url: 'https://lichess.org/analysis' });
  const tab2 = createPortPair('knight:session', { id: 102, url: 'https://www.chess.com/play/computer' });
  ctrl.handlePortConnect(tab1.bgPort);
  ctrl.handlePortConnect(tab2.bgPort);

  const fenA = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const fenB = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1';

  tab1.contentPort.postMessage({
    type: 'HELLO',
    v: 1,
    sessionId: 'tab-1',
    revision: 0,
    payload: { site: 'lichess', mode: 'analysis', gameId: 'g-1' }
  });
  tab2.contentPort.postMessage({
    type: 'HELLO',
    v: 1,
    sessionId: 'tab-2',
    revision: 0,
    payload: { site: 'chesscom', mode: 'ai', gameId: 'g-2' }
  });

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(ctrl.activeSessionId, 'tab-1', 'First connected tab becomes active');

  tab1.contentPort.postMessage({
    type: 'POSITION_CHANGED',
    v: 1,
    sessionId: 'tab-1',
    revision: 1,
    payload: { gameId: 'g-1', mode: 'analysis', fen: fenA }
  });
  await new Promise((r) => setTimeout(r, 20));

  const commandsBeforeDup = ctrl.engine.worker.commands.length;
  tab1.contentPort.postMessage({
    type: 'POSITION_CHANGED',
    v: 1,
    sessionId: 'tab-1',
    revision: 1,
    payload: { gameId: 'g-1', mode: 'analysis', fen: fenA }
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(ctrl.engine.worker.commands.length, commandsBeforeDup, 'Duplicate POSITION_CHANGED must be ignored');

  const commandsBeforeTab2 = ctrl.engine.worker.commands.length;
  tab2.contentPort.postMessage({
    type: 'POSITION_CHANGED',
    v: 1,
    sessionId: 'tab-2',
    revision: 1,
    payload: { gameId: 'g-2', mode: 'ai', fen: fenB }
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(ctrl.engine.worker.commands.length, commandsBeforeTab2, 'Inactive tab must not start search');

  const statusAfterSwitch = await ctrl.handleRuntimeMessage({
    type: 'SET_ACTIVE_TAB',
    payload: { sessionId: 'tab-2' }
  });
  assert.equal(statusAfterSwitch.activeSessionId, 'tab-2');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(workerInstances, 1, 'Worker count remains 1 after switching active tab');
  assert.ok(
    tab2.bgPort.sentByBg.some((m) => m.type === 'ENGINE_RESULT' && m.payload.fen === fenB),
    'Newly active tab-2 receives analysis result'
  );

  tab2.contentPort.postMessage({
    type: 'POSITION_CHANGED',
    v: 1,
    sessionId: 'tab-2',
    revision: 2,
    payload: { gameId: 'g-2', mode: 'human', fen: fenA }
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(ctrl.sessions.get('tab-2').mode, 'human');
  assert.equal(ctrl.sessions.get('tab-2').fen, fenA);

  tab1.contentPort.disconnect();
  tab2.contentPort.disconnect();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ctrl.engine.getActiveWorkerCount(), 0);

  await ctrl.handleRuntimeMessage({
    type: 'SET_CONFIG',
    payload: { enabled: true, movetimeMs: 1000, hashMb: 32 }
  });
  const restartedCtrl = createCtrl();
  const restoredCfg = await restartedCtrl.init();
  assert.equal(restoredCfg.enabled, true);
  assert.equal(restoredCfg.movetimeMs, 1000);
  assert.equal(restoredCfg.hashMb, 32);
  restartedCtrl.engine.shutdown();
});

test('Overlay arrow geometry re-orients on board flip and Stage 6 MoveExecutor guards hostnames', async () => {
  const whiteGeom = OverlayMod.computeArrowGeometry('e2e4', 'white', 800, 800);
  const blackGeom = OverlayMod.computeArrowGeometry('e2e4', 'black', 800, 800);

  assert.equal(whiteGeom.x1, 450);
  assert.equal(whiteGeom.y1, 650);
  assert.equal(blackGeom.x1, 350);
  assert.equal(blackGeom.y1, 150);

  const forbiddenLichess = new PositionMod.MoveExecutor({
    hostname: 'lichess.org',
    boardContract: { executeMove: async () => {} }
  });
  const resLichess = await forbiddenLichess.executeMove({
    fen: PositionMod.DEFAULT_POSITION,
    bestMove: 'e2e4'
  });
  assert.equal(resLichess.ok, false);
  assert.equal(resLichess.errorCode, 'UNSUPPORTED_CONTEXT');

  const forbiddenChessCom = new PositionMod.MoveExecutor({
    hostname: 'www.chess.com',
    boardContract: { executeMove: async () => {} }
  });
  const resChessCom = await forbiddenChessCom.executeMove({
    fen: PositionMod.DEFAULT_POSITION,
    bestMove: 'e2e4'
  });
  assert.equal(resChessCom.ok, false);
  assert.equal(resChessCom.errorCode, 'UNSUPPORTED_CONTEXT');

  let executedPayload = null;
  let localExec = null;
  localExec = new PositionMod.MoveExecutor({
    hostname: 'localhost',
    boardContract: {
      async executeMove(moveInfo) {
        executedPayload = moveInfo;
        setImmediate(() => {
          localExec.confirmPosition(moveInfo.expectedFen);
        });
      }
    }
  });

  const execRes = await localExec.executeMove({
    fen: PositionMod.DEFAULT_POSITION,
    bestMove: 'e2e4'
  });
  assert.equal(execRes.ok, true);
  assert.equal(execRes.executedMove, 'e2e4');
  assert.equal(execRes.san, 'e4');
  assert.equal(executedPayload.from, 'e2');
  assert.equal(executedPayload.to, 'e4');
});

test('End-to-end integration with real bundled Stockfish 19 Lite Single WASM binary', async () => {
  const sfFactory = require('../vendor/stockfish/stockfish-19-lite-single.js');

  function createRealWasmWorker() {
    const sf = sfFactory();
    const w = {
      terminated: false,
      onmessage: null,
      onerror: null,
      listeners: [],
      addEventListener(type, fn) {
        if (type === 'message') this.listeners.push(fn);
      },
      postMessage(cmd) {
        if (this.terminated) return;
        setImmediate(() => {
          if (!this.terminated) sf.processCommand(cmd);
        });
      },
      terminate() {
        this.terminated = true;
      }
    };
    sf.listener = (line) => {
      if (w.terminated) return;
      setImmediate(() => {
        if (w.terminated) return;
        const ev = { data: line };
        if (typeof w.onmessage === 'function') w.onmessage(ev);
        for (const fn of w.listeners) fn(ev);
      });
    };
    return w;
  }

  const results = [];
  const errors = [];
  const engine = new EngineMod.EngineController({
    config: { enabled: true, movetimeMs: 100, hashMb: 16, keepWorkerWarmMs: 30000 },
    workerFactory: createRealWasmWorker,
    moveValidator: PositionMod.validateUciMove,
    onResult: (r) => results.push(r),
    onError: (e) => errors.push(e)
  });

  const testFen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  engine.analyze({
    sessionId: 'wasm-e2e',
    gameId: 'live-wasm',
    revision: 1,
    fen: testFen,
    movetimeMs: 100,
    hashMb: 16
  });

  const deadline = Date.now() + 5000;
  while (results.length === 0 && errors.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }

  assert.equal(errors.length, 0, `Unexpected engine error: ${JSON.stringify(errors)}`);
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, 'wasm-e2e');
  assert.equal(results[0].revision, 1);
  assert.equal(results[0].fen, testFen);
  assert.ok(results[0].depth >= 1, `Expected depth >= 1, got ${results[0].depth}`);

  const moveCheck = PositionMod.validateUciMove(testFen, results[0].bestMove);
  assert.equal(moveCheck.ok, true, `Stockfish WASM returned legal move: ${results[0].bestMove} (${moveCheck.san})`);

  engine.shutdown();
  assert.equal(engine.getActiveWorkerCount(), 0);
});
// ---------------------------------------------------------------------------
// 9. ContentController + BoardOverlay DOM Lifecycle & Stale Guard Tests
// ---------------------------------------------------------------------------

test('ContentController handles BOARD_NOT_FOUND bootstrap observer, narrow observer, and stale ENGINE_RESULT guard', () => {
  function makeMockElement(tag = 'div') {
    const attrs = {};
    const children = [];
    const classes = new Set();
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      style: { cssText: '', display: '', position: 'relative' },
      textContent: '',
      parentNode: null,
      children,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c))
      },
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return k in attrs ? attrs[k] : null; },
      appendChild(child) {
        child.parentNode = this;
        children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx >= 0) children.splice(idx, 1);
        child.parentNode = null;
      },
      getBoundingClientRect: () => ({ width: 640, height: 640 })
    };
  }

  let boardMounted = false;
  const boardEl = makeMockElement('cg-board');
  const bodyEl = makeMockElement('body');
  const observerInstances = [];

  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.disconnected = false;
      this.target = null;
      observerInstances.push(this);
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {
      this.disconnected = true;
    }
    trigger() {
      if (!this.disconnected) this.cb();
    }
  }

  let currentMoves = ['e4', 'e5'];
  let currentOrientation = 'white';

  const mockAdapter = {
    id: 'lichess',
    detect: () => true,
    getGameMode: () => 'ai',
    getBoardRoot: () => (boardMounted ? boardEl : null),
    getOrientation: () => currentOrientation,
    getInitialPosition: () => 'startpos',
    getDirectFen: () => null,
    getMoveHistory: () => currentMoves,
    getGameIdentity: () => 'lichess:/AiGame1',
    readDisplayedPosition: () => null,
    observeChanges(onChange) {
      const obs = new MockMutationObserver(onChange);
      obs.observe(boardEl);
      return () => obs.disconnect();
    }
  };

  const { contentPort, bgPort } = createPortPair('knight:session');
  const mockDoc = {
    body: bodyEl,
    documentElement: bodyEl,
    createElement: (t) => makeMockElement(t),
    createElementNS: (_ns, t) => makeMockElement(t)
  };

  const contentCtrl = new ContentMod.ContentController({
    document: mockDoc,
    location: { hostname: 'lichess.org', pathname: '/AiGame1' },
    adapter: mockAdapter,
    MutationObserver: MockMutationObserver,
    ext: {
      runtime: {
        connect: () => contentPort
      }
    }
  });

  // Start before board is mounted -> should emit BOARD_NOT_FOUND and attach bootstrap observer
  contentCtrl.start();
  assert.ok(
    contentPort.sentByContent.some(
      (m) => m.type === 'DISABLE_SESSION' && m.payload.errorCode === 'BOARD_NOT_FOUND'
    ),
    'Should report BOARD_NOT_FOUND when board is initially absent'
  );
  assert.ok(contentCtrl.bootstrapObserver !== null, 'Bootstrap observer should be active');
  const bootstrapObs = contentCtrl.bootstrapObserver;

  // Now mount board and trigger bootstrap observer
  boardMounted = true;
  bootstrapObs.trigger();
  assert.equal(bootstrapObs.disconnected, true, 'Bootstrap observer must disconnect as soon as board is found');
  assert.equal(contentCtrl.bootstrapObserver, null);

  // Verify POSITION_CHANGED was sent for 1. e4 e5
  const posMsg = contentPort.sentByContent.find((m) => m.type === 'POSITION_CHANGED');
  assert.ok(posMsg, 'POSITION_CHANGED should be sent after board mounts');
  assert.equal(posMsg.revision, 1);
  const expectedFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  assert.equal(posMsg.payload.fen, expectedFen);

  // Enable session from background
  bgPort.postMessage({
    type: 'SESSION_STATUS',
    v: 1,
    sessionId: contentCtrl.sessionId,
    revision: 1,
    payload: {
      status: 'thinking',
      isActiveSession: true,
      config: { enabled: true, movetimeMs: 300, hashMb: 16, showArrow: true, showEval: true }
    }
  });

  // Send STALE ENGINE_RESULT (wrong revision) -> must be ignored
  bgPort.postMessage({
    type: 'ENGINE_RESULT',
    v: 1,
    sessionId: contentCtrl.sessionId,
    revision: 999,
    payload: {
      gameId: 'lichess:/AiGame1',
      fen: expectedFen,
      bestMove: 'g1f3',
      depth: 12,
      evalText: '+0.25'
    }
  });
  assert.equal(contentCtrl.overlay.currentMove, null, 'Stale revision must not render on overlay');

  // Send ENGINE_RESULT with ILLEGAL move for current FEN -> must be ignored
  bgPort.postMessage({
    type: 'ENGINE_RESULT',
    v: 1,
    sessionId: contentCtrl.sessionId,
    revision: 1,
    payload: {
      gameId: 'lichess:/AiGame1',
      fen: expectedFen,
      bestMove: 'e7e5', // Black move when White to move
      depth: 12,
      evalText: '+0.25'
    }
  });
  assert.equal(contentCtrl.overlay.currentMove, null, 'Illegal move must not render on overlay');

  // Send VALID ENGINE_RESULT -> must render arrow and badge
  bgPort.postMessage({
    type: 'ENGINE_RESULT',
    v: 1,
    sessionId: contentCtrl.sessionId,
    revision: 1,
    payload: {
      gameId: 'lichess:/AiGame1',
      fen: expectedFen,
      bestMove: 'g1f3',
      depth: 14,
      evalText: '+0.32'
    }
  });
  assert.equal(contentCtrl.overlay.currentMove, 'g1f3');
  assert.equal(contentCtrl.overlay.svg.style.display, 'block');
  assert.equal(contentCtrl.overlay.badgeEl.textContent, 'Nf3 (+0.32) d14');
  assert.equal(contentCtrl.overlay.lineEl.getAttribute('x1'), '520'); // g1 in 640x640 white orientation

  // Flip board to black -> overlay arrow coordinates must update
  currentOrientation = 'black';
  contentCtrl.evaluatePosition(); // deduplicated position, updates orientation
  bgPort.postMessage({
    type: 'ENGINE_RESULT',
    v: 1,
    sessionId: contentCtrl.sessionId,
    revision: 1,
    payload: {
      gameId: 'lichess:/AiGame1',
      fen: expectedFen,
      bestMove: 'g1f3',
      depth: 14,
      evalText: '+0.32'
    }
  });
  assert.equal(contentCtrl.overlay.lineEl.getAttribute('x1'), '120'); // g1 in 640x640 black orientation
  const expectedHead = OverlayMod.computeArrowGeometry('g1f3', 'black', 640, 640).headPoints;
  assert.equal(contentCtrl.overlay.arrowheadEl.getAttribute('points'),
    expectedHead.map(point => point.join(',')).join(' '));
  assert.equal(contentCtrl.overlay.lineEl.getAttribute('marker-end'), null,
    'Arrow does not depend on fragment marker URLs');


  contentCtrl.destroy();
  assert.equal(contentCtrl.overlay.boardRoot, null);
});

// ---------------------------------------------------------------------------
// 10. PopupController & Config Sanitization Tests
// ---------------------------------------------------------------------------

test('PopupController renders status, handles NO_PERMISSION, and updates sanitized config', async () => {
  // Verify Config.sanitizeConfig rejects invalid movetimeMs/hashMb and enforces multiPv = 1
  const sanitized = Config.sanitizeConfig({
    enabled: 'yes',
    movetimeMs: 999,
    hashMb: 128,
    multiPv: 5,
    showArrow: false
  });
  assert.equal(sanitized.enabled, false);
  assert.equal(sanitized.movetimeMs, 300);
  assert.equal(sanitized.hashMb, 16);
  assert.equal(sanitized.multiPv, 1);
  assert.equal(sanitized.showArrow, false);

  function makeEl(id, attrs = {}) {
    const listeners = {};
    const classes = new Set();
    return {
      id,
      textContent: '',
      style: {},
      hidden: false,
      checked: true,
      value: '',
      firstChild: null,
      children: [],
      classList: {
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c)
      },
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => attrs[k],
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
      trigger: (ev) => listeners[ev] && listeners[ev](),
      appendChild(c) {
        this.children.push(c);
        this.firstChild = this.children[0] || null;
      },
      removeChild(c) {
        const idx = this.children.indexOf(c);
        if (idx >= 0) this.children.splice(idx, 1);
        this.firstChild = this.children[0] || null;
      },
      querySelectorAll: () => []
    };
  }

  const elements = {
    'toggle-enabled': makeEl('toggle-enabled'),
    'site-value': makeEl('site-value'),
    'status-value': makeEl('status-value'),
    'best-value': makeEl('best-value'),
    'depth-value': makeEl('depth-value'),
    'error-banner': makeEl('error-banner'),
    'eval-bar': makeEl('eval-bar'),
    'eval-white': makeEl('eval-white'),
    'eval-text': makeEl('eval-text'),
    'movetime-group': makeEl('movetime-group'),
    'hash-group': makeEl('hash-group'),
    'show-arrow': makeEl('show-arrow'),
    'auto-play': makeEl('auto-play'),
    'show-eval': makeEl('show-eval')
  };

  let permissionGranted = false;
  let currentCfg = { ...Config.DEFAULT_CONFIG };

  const popup = new PopupMod.PopupController({
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (t) => makeEl(t)
    },
    ext: {
      permissions: {
        contains: async () => permissionGranted
      },
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'SET_CONFIG') {
            currentCfg = Config.sanitizeConfig(msg.payload, currentCfg);
          }
          return {
            ok: true,
            config: currentCfg,
            activeSessionId: 's1',
            activeSession: {
              sessionId: 's1',
              site: 'lichess',
              mode: 'ai',
              status: 'ready',
              lastResult: { bestMove: 'g1f3', evalText: '+0.35', depth: 15 },
              lastError: null
            },
            sessions: []
          };
        }
      }
    }
  });

  // 1. When host permissions are missing -> shows NO_PERMISSION and refuses to start engine
  await popup.init();
  assert.equal(elements['status-value'].textContent, 'NO_PERMISSION');
  assert.equal(elements['error-banner'].hidden, false);
  assert.match(elements['error-banner'].textContent, /NO_PERMISSION/);
  const deniedToggle = await popup.updateConfig({ enabled: true });
  assert.equal(deniedToggle, null);
  assert.equal(currentCfg.enabled, false, 'Must not enable engine when NO_PERMISSION');

  // 2. Grant permission and toggle ON
  permissionGranted = true;
  await popup.updateConfig({ enabled: true, movetimeMs: 1000, hashMb: 32 });
  assert.equal(elements['toggle-enabled'].textContent, 'ON');
  assert.equal(elements['site-value'].textContent, 'Lichess / AI');
  assert.equal(elements['status-value'].textContent, 'Ready');
  assert.equal(elements['best-value'].textContent, 'g1f3 (+0.35)');
  assert.equal(elements['depth-value'].textContent, '15');
  assert.equal(elements['eval-bar'].hidden, false);
  assert.ok(parseFloat(elements['eval-white'].style.width) > 50);

  const sessions = [
    { sessionId: 's1', tabId: 10, site: 'lichess', mode: 'analysis', status: 'ready' },
    { sessionId: 's2', tabId: 20, site: 'chesscom', mode: 'analysis', status: 'ready' }
  ];
  const snapshot = { config: currentCfg, activeSessionId: 's1', activeSession: sessions[0], sessions };
  popup.render(snapshot);
  popup.render({ ...snapshot, activeSession: { ...sessions[0], lastError: { code: 'POSITION_UNCERTAIN' },
    lastResult: { bestMove: 'e2e4', depth: 20 } } });
  assert.equal(elements['best-value'].textContent, '—', 'Errors hide stale suggestions');
  assert.equal(elements['eval-bar'].hidden, true);
  await popup.updateConfig({ showEval: false });
  assert.equal(elements['show-eval'].checked, false);
  assert.equal(elements['eval-bar'].hidden, true);
  assert.equal(elements['best-value'].textContent, 'g1f3');
  await popup.updateConfig({ autoPlay: true });
  assert.equal(elements['auto-play'].checked, true);

});

test('Regression: Adapters handle ply-0, variations, unitless 0 translate, fading pieces, and ignore overlay mutations', async () => {
  // 1. Lichess Analysis at ply 0 (<move class="empty active">...</move>) -> must return [] instead of full mainline
  const analysisMoves = [
    {
      textContent: '...',
      classList: { contains: (c) => c === 'empty' || c === 'active' },
      closest: () => null,
      getAttribute: () => null,
      querySelector: () => null
    },
    {
      textContent: 'e4',
      classList: { contains: () => false },
      closest: () => null,
      getAttribute: () => null,
      querySelector: () => null
    },
    {
      textContent: 'e5',
      classList: { contains: () => false },
      closest: () => null,
      getAttribute: () => null,
      querySelector: () => null
    }
  ];
  const plyZeroDoc = {
    querySelector(sel) {
      if (sel.includes('.tview2')) {
        return {
          querySelector: () => null,
          querySelectorAll: (s) => (s === 'move' ? analysisMoves : [])
        };
      }
      return null;
    }
  };
  assert.deepEqual(LichessAdapter.getMoveHistory(plyZeroDoc), []);

  // 2. Lichess Analysis when active move is inside a <variation> -> returns null so directFen can be used
  const varMoves = [
    {
      textContent: 'e4',
      classList: { contains: () => false },
      closest: () => null,
      getAttribute: () => null,
      querySelector: () => null
    },
    {
      textContent: 'c5',
      classList: { contains: (c) => c === 'active' },
      closest: (s) => (s.includes('variation') ? {} : null),
      getAttribute: () => null,
      querySelector: () => null
    }
  ];
  const varDoc = {
    querySelector(sel) {
      if (sel.includes('.tview2')) {
        return {
          querySelector: () => null,
          querySelectorAll: (s) => (s === 'move' ? varMoves : [])
        };
      }
      return null;
    }
  };
  assert.equal(LichessAdapter.getMoveHistory(varDoc), null);

  // 3. Lichess readDisplayedPosition handles unitless 0 in translate(0, 700%) / translate(0, 0) and skips .fading pieces
  const cgPieces = [
    // Black king at a8: translate(0, 0) (unitless 0s)
    {
      getAttribute(a) {
        if (a === 'class') return 'black king';
        if (a === 'style') return 'transform: translate(0, 0);';
        return null;
      }
    },
    // White king at a1: translate(0, 700%) (unitless 0 + %)
    {
      getAttribute(a) {
        if (a === 'class') return 'white king';
        if (a === 'style') return 'transform: translate(0, 700%);';
        return null;
      }
    },
    // White queen capturing at d5: translate(300%, 300%)
    {
      getAttribute(a) {
        if (a === 'class') return 'white queen';
        if (a === 'style') return 'transform: translate(300%, 300%);';
        return null;
      }
    },
    // Fading captured black pawn at d5 (comes AFTER white queen in DOM!)
    {
      getAttribute(a) {
        if (a === 'class') return 'black pawn fading';
        if (a === 'style') return 'transform: translate(300%, 300%);';
        return null;
      }
    }
  ];
  const cgDoc = {
    querySelector(sel) {
      if (sel.includes('cg-board')) {
        return {
          querySelectorAll: (s) => (s === 'piece' ? cgPieces : []),
          getBoundingClientRect: () => ({ width: 0, height: 0 }),
          getAttribute: () => null
        };
      }
      return null;
    }
  };
  assert.equal(LichessAdapter.readDisplayedPosition(cgDoc), 'k7/8/8/3Q4/8/8/8/K7');

  // 4. Lichess localized AI name ("Stockfish уровень 4") recognized as 'ai', while human .user-link is blocked
  const ruAiDoc = {
    documentElement: { getAttribute: () => null },
    querySelectorAll(sel) {
      if (sel.includes('.player')) return [{ textContent: 'Stockfish уровень 4', querySelector: () => null }];
      return [];
    },
    querySelector(sel) {
      if (sel === '.round__app, .round') return {};
      return null;
    }
  };
  assert.equal(LichessAdapter.getGameMode({ hostname: 'lichess.org', pathname: '/RuAiGame' }, ruAiDoc), 'ai');

  // 5. LichessAdapter.observeChanges ignores mutations inside [data-knight-overlay="true"] and observes .cg-wrap
  const overlayEl = {
    getAttribute: (a) => (a === 'data-knight-overlay' ? 'true' : null),
    parentNode: null
  };
  const badgeEl = {
    getAttribute: () => null,
    parentNode: overlayEl
  };
  const boardNode = { getAttribute: () => null };
  const wrapNode = { getAttribute: () => null };
  const createdObservers = [];
  class RecordingObserver {
    constructor(cb) {
      this.cb = cb;
      this.target = null;
      createdObservers.push(this);
    }
    observe(t) { this.target = t; }
    disconnect() {}
  }
  let changeCalls = 0;
  const dispose = LichessAdapter.observeChanges(
    () => { changeCalls += 1; },
    {
      querySelector(sel) {
        if (sel.includes('cg-board')) return boardNode;
        if (sel.includes('.cg-wrap')) return wrapNode;
        return null;
      }
    },
    { MutationObserver: RecordingObserver, debounceMs: 10 }
  );
  assert.ok(createdObservers.some((o) => o.target === wrapNode), 'Must observe .cg-wrap for orientation flips');

  // Trigger mutation strictly inside [data-knight-overlay] -> must be ignored
  createdObservers[0].cb([{ type: 'attributes', target: badgeEl }]);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(changeCalls, 0, 'Mutations inside [data-knight-overlay] must not fire onChange');

  // Trigger mutation on wrapNode -> must fire onChange
  const wrapObs = createdObservers.find((o) => o.target === wrapNode);
  wrapObs.cb([{ type: 'attributes', target: wrapNode }]);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(changeCalls, 1, 'Orientation mutation on .cg-wrap must fire onChange');
  dispose();

  // 6. reconstructPosition arbitrates between stale initial directFen and move history using displayedBoard
  const staleDirectRes = PositionMod.reconstructPosition({
    directFen: PositionMod.DEFAULT_POSITION,
    moves: ['e4', 'e5'],
    displayedBoard: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR'
  });
  assert.equal(staleDirectRes.ok, true);
  assert.equal(staleDirectRes.fen, 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
});

test('Regression: Event Page disconnect recovery, immediate Hash sync on search completion, currmove depth, and live Popup broadcast', async () => {
  // 1. EngineController syncs deferred Hash option immediately when active search finishes (even with no latestPending)
  //    and does not overwrite depth on scoreless currmove info lines
  let currentWorker = null;
  const results = [];
  const engine = new EngineMod.EngineController({
    config: { enabled: true, movetimeMs: 100, hashMb: 16, keepWorkerWarmMs: 30000 },
    workerFactory: () => {
      currentWorker = new FakeWorker({
        onCommand(cmd, w) {
          if (cmd === 'uci') setImmediate(() => w.emitLine('uciok'));
          else if (cmd === 'isready') setImmediate(() => w.emitLine('readyok'));
        }
      });
      return currentWorker;
    },
    onResult: (r) => results.push(r)
  });

  const fen = PositionMod.DEFAULT_POSITION;
  engine.analyze({ sessionId: 's1', gameId: 'g1', revision: 1, fen, movetimeMs: 100, hashMb: 16 });
  await new Promise((r) => setTimeout(r, 20));

  // Change Hash to 32 while searching, with NO subsequent analyze() queued
  engine.updateConfig({ enabled: true, movetimeMs: 100, hashMb: 32 });
  assert.ok(!currentWorker.commands.includes('setoption name Hash value 32'));

  // Emit depth 12 with score, then depth 13 currmove WITHOUT score, then bestmove
  currentWorker.emitLine('info depth 12 score cp 28 pv e2e4');
  currentWorker.emitLine('info depth 13 currmove a2a3 currmovenumber 1');
  currentWorker.emitLine('bestmove e2e4');

  assert.equal(results.length, 1);
  assert.equal(results[0].depth, 12, 'Scoreless currmove line must not overwrite completed depth');
  assert.ok(
    currentWorker.commands.includes('setoption name Hash value 32'),
    'Deferred Hash change must be sent immediately upon search completion'
  );
  engine.shutdown();

  // 2. ContentController recovers after Port disconnect (Event Page restart) and re-sends POSITION_CHANGED
  let portPair = createPortPair('knight:session');
  const boardEl = {
    nodeType: 1,
    style: { cssText: '', display: '', position: 'relative' },
    children: [],
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { c.parentNode = null; },
    getBoundingClientRect: () => ({ width: 400, height: 400 })
  };
  const mockDoc = {
    body: boardEl,
    documentElement: boardEl,
    createElement: () => ({
      style: { cssText: '', display: '' },
      textContent: '',
      setAttribute() {},
      appendChild(c) { c.parentNode = this; }
    }),
    createElementNS: () => ({
      style: { cssText: '', display: '' },
      setAttribute() {},
      appendChild(c) { c.parentNode = this; }
    })
  };
  const contentCtrl = new ContentMod.ContentController({
    document: mockDoc,
    location: { hostname: 'lichess.org', pathname: '/analysis' },
    adapter: {
      id: 'lichess',
      detect: () => true,
      getGameMode: () => 'analysis',
      getBoardRoot: () => boardEl,
      getOrientation: () => 'white',
      getInitialPosition: () => 'startpos',
      getDirectFen: () => null,
      getMoveHistory: () => ['e4'],
      getGameIdentity: () => 'lichess:/analysis',
      readDisplayedPosition: () => null,
      observeChanges: () => () => {}
    },
    ext: { runtime: { connect: () => portPair.contentPort } }
  });

  contentCtrl.start();
  assert.equal(portPair.contentPort.sentByContent.filter((m) => m.type === 'POSITION_CHANGED').length, 1);

  // Simulate Event Page unloading (disconnects bgPort) and waking up with a new Port
  portPair.bgPort.disconnect();
  assert.equal(contentCtrl.port, null);
  portPair = createPortPair('knight:session');
  const reeval = contentCtrl.evaluatePosition();
  assert.equal(reeval.deduplicated, false, 'Must not deduplicate against dead Port fingerprint after Event Page restart');
  assert.equal(portPair.contentPort.sentByContent.filter((m) => m.type === 'POSITION_CHANGED').length, 1);
  contentCtrl.destroy();
});




test('Popup serializes rapid settings changes and sends only changed fields', async () => {
  let config = { ...Config.DEFAULT_CONFIG };
  const payloads = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const popup = new PopupMod.PopupController({ document: null, ext: { runtime: {
    sendMessage: async ({ payload }) => {
      payloads.push(payload);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      const previous = config;
      await new Promise(resolve => setTimeout(resolve, 5));
      config = Config.sanitizeConfig(payload, previous);
      inFlight--;
      return { ok: true, config };
    }
  } } });
  popup.render = snapshot => { popup.config = { ...snapshot.config }; };
  await Promise.all([
    popup.updateConfig({ movetimeMs: 1000 }),
    popup.updateConfig({ hashMb: 32 }),
    popup.updateConfig({ showEval: false })
  ]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(payloads, [{ movetimeMs: 1000 }, { hashMb: 32 }, { showEval: false }]);
  assert.equal(config.movetimeMs, 1000);
  assert.equal(config.hashMb, 32);
  assert.equal(config.showEval, false);
  await popup.updateConfig({ hashMb: 32 });
  assert.equal(payloads.length, 3, 'Re-selecting current value performs no write');
  await Promise.all([
    popup.updateConfig(current => ({ enabled: !current.enabled })),
    popup.updateConfig(current => ({ enabled: !current.enabled }))
  ]);
  assert.equal(config.enabled, false, 'Two quick power clicks return to initial state');
});


test('Popup advantage scale uses white scores and handles equality, mate, and missing data', () => {
  const view = PopupMod.getEvaluationView;
  assert.equal(view({ whiteCp: 0 }).whitePercent, 50);
  assert.equal(view({ whiteCp: 0 }).label, 'Equal position');
  const white = view({ whiteCp: 200, scoreCp: -200 });
  const black = view({ whiteCp: -200, scoreCp: 200 });
  assert.ok(white.whitePercent > 50 && white.whitePercent < 100);
  assert.equal(white.whitePercent + black.whitePercent, 100);
  assert.match(black.label, /Black advantage/);
  assert.equal(view({ whiteMate: 3 }).whitePercent, 100);
  assert.equal(view({ whiteMate: -2 }).whitePercent, 0);
  assert.equal(view({ whiteMate: 0 }), null);
  assert.equal(view({ whiteCp: 100000 }).whitePercent, 100);
  assert.equal(view({ evalText: '+0.42' }).whitePercent, view({ whiteCp: 42 }).whitePercent);
  for (const result of [null, {}, { whiteCp: null }, { whiteCp: NaN }, { evalText: 'unknown' }]) {
    assert.equal(view(result), null);
  }
});


test('Lichess orientation and flip observer belong to the main board, not a preview', () => {
  let orientation = 'white';
  const wrap = {
    getAttribute: () => null,
    classList: { contains: name => name === `orientation-${orientation}` }
  };
  const outer = { getAttribute: () => null, classList: { contains: () => false } };
  const board = { closest: () => wrap };
  const doc = {
    querySelector: selector => selector.includes('cg-board') ? board
      : selector === '.cg-wrap.orientation-black' ? {} // unrelated black preview
      : selector.includes('.cg-wrap') ? outer : null
  };
  assert.equal(LichessAdapter.getOrientation(doc), 'white');
  const white = OverlayMod.computeArrowGeometry('d4c5', LichessAdapter.getOrientation(doc), 720, 720);
  assert.deepEqual([white.x1, white.y1, white.targetX, white.targetY], [315, 405, 225, 315]);
  orientation = 'black';
  assert.equal(LichessAdapter.getOrientation(doc), 'black');
  const black = OverlayMod.computeArrowGeometry('d4c5', LichessAdapter.getOrientation(doc), 720, 720);
  assert.deepEqual([black.x1, black.y1, black.targetX, black.targetY], [405, 315, 495, 405]);
  const observed = [];
  class Observer {
    observe(target) { observed.push(target); }
    disconnect() {}
  }
  const stop = LichessAdapter.observeChanges(() => {}, doc, { MutationObserver: Observer });
  assert.ok(observed.includes(wrap), 'Flip observer watches the actual board wrapper');
  assert.ok(!observed.includes(outer), 'Outer layout does not carry the orientation');
  stop();
});


test('Arrowhead geometry stays attached for straight, diagonal, knight, flipped, and resized moves', () => {
  for (const orientation of ['white', 'black']) {
    for (const [width, height] of [[800, 800], [304, 304], [720, 640]]) {
      for (const move of ['e2e4', 'e7e5', 'a1h1', 'h8a8', 'a1h8', 'h8a1', 'g1f3', 'b8c6']) {
        const geometry = OverlayMod.computeArrowGeometry(move, orientation, width, height);
        const [tip, left, right] = geometry.headPoints;
        assert.deepEqual(tip, [geometry.targetX, geometry.targetY]);
        assert.ok(Math.abs((left[0] + right[0]) / 2 - geometry.x2) < 0.02);
        assert.ok(Math.abs((left[1] + right[1]) / 2 - geometry.y2) < 0.02);
        const area = Math.abs((left[0] - tip[0]) * (right[1] - tip[1]) -
          (left[1] - tip[1]) * (right[0] - tip[0]));
        assert.ok(area > 0, 'Head must be a visible triangle');
        for (const [x, y] of geometry.headPoints) {
          assert.ok(x >= 0 && x <= width && y >= 0 && y <= height);
        }
      }
    }
  }
});

test('Content restores an idle board after background loss without a move or tab switch', async () => {
  const requests = [];
  const makeBackground = () => new SessionsMod.SessionController({
    initialConfig: { ...Config.DEFAULT_CONFIG, enabled: true },
    engine: {
      state: 'ready', updateConfig() {}, cancelCurrentSearch() {}, shutdown() {}, scheduleIdleShutdown() {},
      getActiveWorkerCount: () => 0,
      analyze: request => requests.push(request)
    }
  });
  let background = makeBackground();
  let pair;
  let failNext = false;
  let connections = 0;
  let clears = 0;
  const board = {};
  const content = new ContentMod.ContentController({
    document: {},
    adapter: {
      id: 'chesscom', getBoardRoot: () => board, getOrientation: () => 'white',
      getGameMode: () => 'ai', getGameIdentity: () => 'test-game',
      getInitialPosition: () => 'startpos', getMoveHistory: () => [],
      readDisplayedPosition: () => null, observeChanges: () => () => {}
    },
    overlay: { attach() {}, detach() {}, setOrientation() {}, setConfig() {}, clear() { clears++; } },
    ext: { runtime: { connect() {
      connections++;
      if (failNext) { failNext = false; throw new Error('Background restarting'); }
      pair = createPortPair('knight:session', { id: 1, url: 'https://www.chess.com/play/computer' });
      background.handlePortConnect(pair.bgPort);
      return pair.contentPort;
    } } }
  });
  try {
    content.start();
    assert.equal(background.getStatusSnapshot().activeSessionId, content.sessionId);
    const firstPort = content.port;
    const oldFen = content.currentFen;
    const previousClears = clears;
    content.reconnectDelayMs = 10;
    pair.bgPort.disconnect();
    assert.equal(content.port, null);
    assert.equal(content.enabled, false);
    assert.equal(content.isActiveSession, false);
    assert.ok(clears > previousClears, 'Disconnected results must disappear');
    background = makeBackground();
    failNext = true;
    const deadline = Date.now() + 1000;
    while (!background.sessions.size && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(background.getStatusSnapshot().activeSessionId, content.sessionId);
    assert.equal(content.currentFen, oldFen);
    assert.equal(requests.length, 2, 'Same position is analyzed by the restarted background');
    assert.deepEqual(pair.contentPort.sentByContent.map(message => message.type), ['HELLO', 'POSITION_CHANGED']);
    assert.equal(content.enabled, true);
    assert.equal(content.reconnectTimer, null);
    assert.equal(content.reconnectDelayMs, 250, 'Successful handshake resets backoff');
    content._handlePortDisconnect(firstPort);
    assert.equal(content.port, pair.contentPort, 'Late old-port disconnect cannot drop a new connection');
    content.reconnectDelayMs = 10;
    pair.bgPort.disconnect();
    assert.notEqual(content.reconnectTimer, null);
    content.destroy();
    const before = connections;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(connections, before, 'Destroyed pages never reconnect');
    assert.equal(content.reconnectTimer, null);
  } finally {
    content.destroy();
  }
});


test('Session clears the previous position result before broadcasting the next search', () => {
  const requests = [];
  const controller = new SessionsMod.SessionController({
    initialConfig: { ...Config.DEFAULT_CONFIG, enabled: true },
    engine: {
      state: 'ready', updateConfig() {}, cancelCurrentSearch() {}, shutdown() {}, scheduleIdleShutdown() {},
      getActiveWorkerCount: () => 0, analyze: request => requests.push(request)
    }
  });
  const { contentPort, bgPort } = createPortPair();
  controller.handlePortConnect(bgPort);
  const sendPosition = (fen, revision) => contentPort.postMessage({
    type: 'POSITION_CHANGED', v: 1, sessionId: 'freshness', revision,
    payload: { site: 'chesscom', mode: 'ai', gameId: 'freshness-game', fen }
  });
  sendPosition(PositionMod.DEFAULT_POSITION, 1);
  const firstRequest = requests[0];
  controller._handleEngineResult({ ...firstRequest, bestMove: 'e2e4', depth: 14 });
  assert.equal(controller.getStatusSnapshot().activeSession.lastResult.bestMove, 'e2e4');
  const chess = new ChessRules.Chess();
  chess.move('e4');
  sendPosition(chess.fen(), 2);
  const pending = controller.getStatusSnapshot().activeSession;
  assert.equal(pending.status, 'thinking');
  assert.equal(pending.lastResult, null, 'Old move must disappear as soon as the position changes');
  controller._handleEngineResult({ ...firstRequest, bestMove: 'e2e4', depth: 30 });
  assert.equal(controller.getStatusSnapshot().activeSession.lastResult, null, 'Late results stay rejected');
  controller._handleEngineResult({ ...requests[1], bestMove: 'e7e5', depth: 15 });
  assert.equal(controller.getStatusSnapshot().activeSession.lastResult.bestMove, 'e7e5');
});

test('Autoplay executes once, confirms the new position, and respects the detected player side without mode detection', async () => {
  const executed = [], requests = [], moves = [];
  let runtimeListener, background, content;
  let playerColor = 'white';
  let changeBeforeDispatch = false;
  const chess = new ChessRules.Chess();
  const attrs = {};
  const board = {
    setAttribute: (key, value) => { attrs[key] = value; },
    getAttribute: key => attrs[key] || null,
    removeAttribute: key => { delete attrs[key]; }
  };
  const ext = {
    runtime: {
      onMessage: { addListener: listener => { runtimeListener = listener; } },
      onConnect: { addListener() {} },
      sendMessage: async () => null
    },
    scripting: { executeScript: async options => {
      assert.equal(options.world, 'MAIN');
      assert.equal(options.target.tabId, 101);
      const request = options.args[0];
      if (request.readColor) return [{ result: { color: playerColor } }];
      assert.equal(board.getAttribute('data-knight-move-token'), request.token);
      if (changeBeforeDispatch) {
        changeBeforeDispatch = false;
        for (const san of ['Nc3', 'Nc6']) { chess.move(san); moves.push(san); }
        content.evaluatePosition();
        background._handleEngineResult({ ...requests.at(-1), bestMove: 'g1f3' });
        return [{ result: { dispatched: false, errorCode: 'POSITION_CHANGED', error: 'Position changed' } }];
      }
      executed.push(request);
      const check = PositionMod.validateUciMove(chess.fen(), request.uci);
      assert.equal(check.ok, true);
      chess.move(check.san);
      moves.push(check.san);
      content.evaluatePosition();
      return [{ result: { dispatched: true } }];
    } }
  };
  background = BackgroundMod.createBackgroundApp({ ext,
    storage: createMockStorage({ ...Config.DEFAULT_CONFIG, enabled: true, autoPlay: true }),
    onStatusChange() {},
    engine: { state: 'ready', updateConfig() {}, shutdown() {}, cancelCurrentSearch() {},
      scheduleIdleShutdown() {}, getActiveWorkerCount: () => 0, analyze: request => requests.push(request) }
  });
  await background.init();
  const pair = createPortPair('knight:session', { id: 101, url: 'https://www.chess.com/play/online' });
  background.handlePortConnect(pair.bgPort);
  const send = (message, sender = { tab: { id: 101 } }) => new Promise(resolve => {
    runtimeListener(message, sender, resolve);
  });
  content = new ContentMod.ContentController({
    document: {}, location: { hostname: 'www.chess.com' },
    adapter: { id: 'chesscom', getBoardRoot: () => board, getOrientation: () => 'white',
      getGameMode: () => 'human', getGameIdentity: () => 'operator-test', getInitialPosition: () => 'startpos',
      getMoveHistory: () => [...moves], readDisplayedPosition: () => null, observeChanges: () => () => {} },
    overlay: { attach() {}, detach() {}, clear() {}, setConfig() {}, setOrientation() {}, renderResult() {} },
    ext: { runtime: { connect: () => pair.contentPort, sendMessage: send } }
  });
  try {
    content.start();
    const first = requests[0];
    background._handleEngineResult({ ...first, bestMove: 'e2e4' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executed.length, 1);
    assert.equal(content.moveExecutor.pendingExecution, null);
    assert.equal(content.autoBusy, false);
    assert.equal(chess.turn(), 'b');
    background._handleEngineResult({ ...first, bestMove: 'e2e4' });
    background._handleEngineResult({ ...requests[1], bestMove: 'e7e5' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executed.length, 1, 'Old replies and opponent turns do not execute');
    const response = await send({ type: 'EXECUTE_MOVE', sessionId: content.sessionId,
      revision: content.revision, payload: { ...requests[1], uci: 'e7e5', token: 'unused' } }, { tab: { id: 999 } });
    assert.equal(response.ok, false, 'Another tab cannot execute this session');
    await background.handleRuntimeMessage({ type: 'SET_CONFIG', payload: { autoPlay: false } });
    assert.equal(content.autoPlay, false);
    assert.equal(Config.sanitizeConfig({}).autoPlay, false);
    assert.equal('autoPlayColor' in Config.sanitizeConfig({ autoPlayColor: 'white' }), false, 'Legacy manual color is ignored');
    playerColor = 'black';
    await background.handleRuntimeMessage({ type: 'SET_CONFIG', payload: { autoPlay: true } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executed.length, 2, 'Detected Black side executes only after the side API changes');
    assert.equal(content.autoPlayColor, 'black');
    assert.equal(chess.turn(), 'w');
    playerColor = 'white';
    changeBeforeDispatch = true;
    background._handleEngineResult({ ...requests.at(-1), bestMove: 'g1f3' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executed.length, 3, 'A stale dispatch is discarded and the new position can execute');
    assert.deepEqual(moves, ['e4', 'e5', 'Nc3', 'Nc6', 'Nf3']);
    assert.equal(background.getStatusSnapshot().activeSession.lastError, null);
    assert.equal(content.moveExecutor.pendingExecution, null);
    playerColor = null;
    background._handleEngineResult({ ...requests.at(-1), bestMove: 'g7g6' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executed.length, 3, 'Unknown player side never guesses White');
    assert.equal(background.getStatusSnapshot().activeSession.lastError.code, 'AUTO_MOVE_FAILED');
  } finally { content.destroy(); }
});

test('Authorized executor reports unconfirmed moves and can be canceled', async () => {
  const executor = new PositionMod.MoveExecutor({ hostname: 'lichess.org', autoplayAuthorized: true,
    confirmTimeoutMs: 10, boardContract: { executeMove: async () => {} } });
  const request = { fen: PositionMod.DEFAULT_POSITION, bestMove: 'e2e4' };
  const timeout = await executor.executeMove(request);
  assert.equal(timeout.ok, false);
  assert.match(timeout.reason, /timeout/i);
  const pending = executor.executeMove(request);
  executor.cancel();
  assert.equal((await pending).ok, false);
  assert.equal(executor.pendingExecution, null);
});


test('Page move function is serializable and supports Chess.com promotion and Lichess board API', async () => {
  const vm = require('node:vm');
  const { executeOnPage } = require('../background/autoplay.js');
  const createPage = hostname => {
    const attributes = { 'data-knight-move-token': 'test' };
    const board = { getAttribute: key => attributes[key], setAttribute: (key, value) => { attributes[key] = value; },
      removeAttribute: key => { delete attributes[key]; } };
    const window = {};
    return { board, context: { document: { querySelector: () => board }, location: { hostname }, window, setTimeout } };
  };
  const chesscom = createPage('www.chess.com');
  const moves = [];
  chesscom.board.game = { getPlayingAs: () => 1, getFEN: () => '7k/P7/8/8/8/8/8/7K w - - 0 1',
    move: move => { moves.push(move); return { type: 'Move' }; } };
  const dispatch = vm.runInNewContext(`(${executeOnPage.toString()})`, chesscom.context);
  assert.equal((await dispatch({ uci: 'a7a8n', token: 'test', fen: '7k/P7/8/8/8/8/8/7K w - - 0 1' })).dispatched, true);
  assert.equal(moves[0].promotion, 'n');
  assert.equal(moves[0].userGenerated, true, 'Board input must notify the computer-game controller');
  assert.equal((await dispatch({ uci: 'a7a8n', token: 'test', fen: '7k/P7/8/8/8/8/8/7K w - - 0 1' })).errorCode, 'POSITION_CHANGED',
    'Consumed requests cannot execute twice');
  const lichess = createPage('lichess.org');
  const selected = [];
  lichess.context.window.lichess = { chessground: () => ({
    state: { orientation: 'black', turnColor: 'black', movable: { color: 'white', dests: new Map([['e2', ['e4']]]) } },
    cancelMove() {}, selectSquare: square => selected.push(square)
  }) };
  const dispatchLichess = vm.runInNewContext(`(${executeOnPage.toString()})`, lichess.context);
  assert.equal((await dispatchLichess({ uci: 'e2e4', token: 'test', fen: PositionMod.DEFAULT_POSITION })).dispatched, true);
  assert.deepEqual(selected, ['e2', 'e4']);
  assert.equal((await dispatchLichess({ readColor: true })).color, 'white', 'Turn and board flip do not define the player');
  lichess.context.window.lichess.analysis = {};
  assert.equal((await dispatchLichess({ readColor: true })).color, null, 'Analysis has no assigned player');
  for (const [side, expected] of [[1, 'white'], [2, 'black'], ['w', 'white'], ['b', 'black'], [null, null], ['both', null]]) {
    chesscom.board.game.getPlayingAs = () => side;
    assert.equal((await dispatch({ readColor: true })).color, expected);
  }
  chesscom.board.game.getPlayingAs = () => 2;
  chesscom.board.setAttribute('data-knight-move-token', 'opponent-turn');
  await assert.rejects(dispatch({ uci: 'a7a8q', token: 'opponent-turn', fen: '7k/P7/8/8/8/8/8/7K w - - 0 1' }), /Waiting for your turn/);
  assert.equal(moves.length, 1, 'Final page-side check rejects an opponent move');
});

test('Lichess round bridge captures the actual controller during page startup exactly once', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../content/lichess-bridge.js'), 'utf8');
  const { executeOnPage } = require('../background/autoplay.js');
  let dataElement, initCount = 0, fallbackCount = 0;
  const moves = [];
  const attributes = { 'data-knight-move-token': 'round-move' };
  const board = { getAttribute: key => attributes[key], setAttribute: (k, v) => { attributes[k] = v; },
    removeAttribute: key => { delete attributes[key]; } };
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const controller = {
    data: { player: { color: 'black', spectator: false } }, ply: 1,
    chessground: { state: { orientation: 'white', turnColor: 'black', movable: { color: undefined } } },
    canMove: () => true, stepAt: () => ({ fen: fen.split(' ')[0] }),
    pluginMove: (...args) => moves.push(args)
  };
  const window = { document: {
    getElementById: id => id === 'page-init-data' ? dataElement : null,
    querySelector: () => board
  } };
  const context = vm.createContext({ window, document: window.document, location: { hostname: 'lichess.org' } });
  vm.runInContext(source, context);
  // Same order as the deployed page: site first, then module loader, then round init.
  window.site = {};
  const originalLoader = () => { fallbackCount++; return 'other-page'; };
  const initModule = async (name, options) => {
      initCount++;
      assert.equal(name, 'round');
      assert.equal(options.init.data.player.color, 'black');
      return controller;
  };
  const namespace = Object.preventExtensions(Object.defineProperties({}, {
    loadEsmPage: { enumerable: true, configurable: false, get: () => originalLoader },
    loadEsm: { enumerable: true, configurable: false, get: () => initModule }
  }));
  window.site.asset = namespace;
  const asset = window.site.asset;
  assert.equal(namespace.loadEsmPage, originalLoader, 'Immutable module exports are untouched');
  const originalData = { data: { player: { color: 'black' } } };
  dataElement = { textContent: JSON.stringify(originalData), remove: () => { dataElement = null; } };
  await asset.loadEsmPage('round');
  assert.equal(initCount, 1);
  assert.equal(fallbackCount, 0);
  assert.equal(window.__KNIGHT_LICHESS_BRIDGE__.round, controller);
  assert.equal(dataElement, null);
  const dispatch = vm.runInContext(`(${executeOnPage.toString()})`, context);
  assert.equal((await dispatch({ readColor: true })).color, 'black',
    'Player color comes from round data even if orientation and ground metadata differ');
  assert.equal((await dispatch({ uci: 'e7e5', fen, token: 'round-move' })).dispatched, true);
  assert.deepEqual(moves[0], ['e7', 'e5', undefined, true]);
  board.setAttribute('data-knight-move-token', 'round-promotion');
  await dispatch({ uci: 'a2a1n', fen, token: 'round-promotion' });
  assert.equal(moves[1][2], 'knight');
  controller.data.player.spectator = true;
  assert.equal((await dispatch({ readColor: true })).color, null);
  controller.data.player.spectator = false;
  controller.canMove = () => false;
  board.setAttribute('data-knight-move-token', 'replay');
  assert.equal((await dispatch({ uci: 'e7e5', fen, token: 'replay' })).errorCode, 'POSITION_CHANGED');
  assert.equal(moves.length, 2);
  const wrapper = asset.loadEsmPage;
  vm.runInContext(source, context);
  assert.equal(asset.loadEsmPage, wrapper, 'Repeated bridge injection does not stack loaders');
  assert.equal(asset.loadEsmPage('lobby'), 'other-page');
  assert.equal(fallbackCount, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
  const registration = manifest.content_scripts.find(item => item.js.includes('content/lichess-bridge.js'));
  assert.equal(registration.run_at, 'document_start');
  assert.equal(registration.world, 'MAIN');
});

test('Lichess missing bridge returns a useful reload message instead of guessing a color', async () => {
  const vm = require('node:vm');
  const { executeOnPage } = require('../background/autoplay.js');
  const dispatch = vm.runInNewContext(`(${executeOnPage.toString()})`, {
    window: {}, document: { querySelector: () => ({}) }, location: { hostname: 'lichess.org' }
  });
  const result = await dispatch({ readColor: true });
  assert.equal(result.color, null);
  assert.match(result.error, /Reload the game tab/);
});

test('Lichess live board-only FEN matches the screenshot position and still rejects stale moves', async () => {
  const vm = require('node:vm');
  const { executeOnPage } = require('../background/autoplay.js');
  for (const history of [[], ['e4'], ['e4', 'e5'], ['e4', 'e5', 'f4']]) {
    const chess = new ChessRules.Chess();
    for (const san of history) chess.move(san);
    const fen = chess.fen(), fields = fen.split(' ');
    const bestMove = chess.moves({ verbose: true })[0];
    const color = chess.turn() === 'w' ? 'white' : 'black';
    const attributes = {};
    const board = { getAttribute: key => attributes[key], setAttribute: (key, value) => { attributes[key] = value; },
      removeAttribute: key => { delete attributes[key]; } };
    let stepFen = fields[0], dispatched = 0;
    const round = {
      data: { player: { color } }, ply: history.length,
      chessground: { state: { turnColor: color } },
      canMove: () => true, stepAt: () => ({ fen: stepFen }), pluginMove: () => { dispatched++; }
    };
    const dispatch = vm.runInNewContext(`(${executeOnPage.toString()})`, {
      window: { __KNIGHT_LICHESS_BRIDGE__: { round } },
      document: { querySelector: () => board }, location: { hostname: 'lichess.org' }
    });
    const attempt = () => {
      board.setAttribute('data-knight-move-token', 'current');
      return dispatch({ fen, uci: bestMove.from + bestMove.to, token: 'current' });
    };
    assert.equal((await attempt()).dispatched, true, `Board-only FEN after ${history.join(' ') || 'start'}`);
    stepFen = fen;
    assert.equal((await attempt()).dispatched, true, 'Full FEN remains supported');
    stepFen = fields[0];
    round.ply += 2;
    assert.equal((await attempt()).errorCode, 'POSITION_CHANGED', 'Repeated placement at another ply is stale');
    round.ply -= 2;
    round.chessground.state.turnColor = color === 'white' ? 'black' : 'white';
    assert.equal((await attempt()).errorCode, 'POSITION_CHANGED', 'Actual board turn must match');
    round.chessground.state.turnColor = color;
    chess.move(bestMove);
    stepFen = chess.fen().split(' ')[0];
    assert.equal((await attempt()).errorCode, 'POSITION_CHANGED', 'Different placement must fail');
    stepFen = '';
    assert.equal((await attempt()).errorCode, 'POSITION_CHANGED', 'Missing position must fail');
    stepFen = `${fields[0]} ${fields[1]} -`;
    assert.equal((await attempt()).errorCode, 'POSITION_CHANGED', 'Full FEN castling mismatch must fail');
    assert.equal(dispatched, 2, 'No stale request reached the move API');
  }
});
