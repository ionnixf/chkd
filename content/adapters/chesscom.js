(function (root) {
  'use strict';

  const FILES = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

  function getDoc(d) { return d || (typeof document !== 'undefined' ? document : null); }
  function getLoc(l, d) { return l || (d && d.location) || (typeof location !== 'undefined' ? location : null); }

  // Move lists can expose clock annotations as .node elements as well.
  function isClockAnnotation(text) {
    return /^(?:(?:\d+(?:[.,]\d+)?\s*(?:ms|[hms])\s*)+|\d+:\d{2}(?::\d{2})?(?:[.,]\d+)?)$/i.test(text.trim());
  }

  function extractMoveText(node) {
    if (!node) return '';
    const uci = node.getAttribute && node.getAttribute('data-uci');
    if (uci && /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(uci.trim())) return uci.trim();
    const san = node.getAttribute && node.getAttribute('data-san');
    if (san && san.trim()) return san.trim();

    let fig = (node.getAttribute && node.getAttribute('data-figurine')) || '';
    if (!fig && node.querySelector) {
      const figEl = node.querySelector('[data-figurine]');
      if (figEl) fig = (figEl.getAttribute('data-figurine') || '').trim();
    }
    const raw = (node.textContent || '').replace(/^\d+\.+/, '').trim();
    if (!raw) return '';
    if (fig && /^[KQRBN]$/.test(fig) && !raw.startsWith(fig) && !/^(?:O-O|0-0)/.test(raw)) {
      return `${fig}${raw}`;
    }
    return raw;
  }

  function isInsideOverlay(node) {
    let cur = node;
    while (cur) {
      if (cur.getAttribute && cur.getAttribute('data-knight-overlay') === 'true') return true;
      cur = cur.parentNode || cur.parentElement || null;
    }
    return false;
  }

  function hasExternalMutation(mutations) {
    if (!Array.isArray(mutations) || mutations.length === 0) return true;
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (!m || !m.target) return true;
      if (isInsideOverlay(m.target)) continue;
      if (m.type === 'childList') {
        const added = m.addedNodes || [];
        const removed = m.removedNodes || [];
        if (added.length + removed.length > 0) {
          let allOverlay = true;
          for (let j = 0; j < added.length; j++) if (!isInsideOverlay(added[j])) allOverlay = false;
          for (let j = 0; j < removed.length; j++) if (!isInsideOverlay(removed[j])) allOverlay = false;
          if (allOverlay) continue;
        }
      }
      return true;
    }
    return false;
  }

  const ChessComAdapter = {
    id: 'chesscom',

    detect(customLoc, customDoc) {
      const doc = getDoc(customDoc);
      const loc = getLoc(customLoc, doc);
      if (!loc || typeof loc.hostname !== 'string') return false;
      const h = loc.hostname.toLowerCase();
      return h === 'chess.com' || h === 'www.chess.com' || h.endsWith('.chess.com');
    },

    getGameMode(customLoc, customDoc) {
      const doc = getDoc(customDoc);
      const loc = getLoc(customLoc, doc);
      if (!doc || !this.detect(loc, doc)) return 'unknown';

      const explicit = doc.documentElement && doc.documentElement.getAttribute('data-knight-mode');
      if (explicit === 'ai' || explicit === 'analysis' || explicit === 'human') return explicit;

      const path = (loc && typeof loc.pathname === 'string' ? loc.pathname : '').toLowerCase();
      if (
        path.startsWith('/game/live') ||
        path.startsWith('/game/daily') ||
        path.startsWith('/play/online') ||
        path.startsWith('/play/arena') ||
        path.startsWith('/daily') ||
        path.startsWith('/tournaments') ||
        path.startsWith('/live') ||
        Boolean(doc.querySelector('[data-rated="true"], .game-rated-badge'))
      ) {
        return 'human';
      }

      if (
        path.startsWith('/play/computer') ||
        path.startsWith('/game/computer') ||
        Boolean(doc.querySelector('[data-bot-selection], [data-cy="bot-component"], .bot-component, [data-bot="true"]'))
      ) {
        return 'ai';
      }

      if (
        path.startsWith('/analysis') ||
        path.startsWith('/practice') ||
        path.startsWith('/classroom') ||
        path.startsWith('/explorer') ||
        Boolean(doc.querySelector('.analysis-view-component, [data-game-mode="analysis"]'))
      ) {
        return 'analysis';
      }

      return 'unknown';
    },

    getBoardRoot(customDoc) {
      const doc = getDoc(customDoc);
      if (!doc) return null;
      return (
        doc.querySelector('wc-chess-board') ||
        doc.querySelector('chess-board') ||
        doc.querySelector('.board-layout-chessboard .board') ||
        doc.querySelector('.board') ||
        null
      );
    },

    getOrientation(customDoc) {
      const board = this.getBoardRoot(customDoc);
      if (!board) return 'unknown';
      const attr = board.getAttribute && board.getAttribute('data-orientation');
      if (attr === 'black' || attr === 'white') return attr;
      const flipped = board.getAttribute && board.getAttribute('flipped');
      if (flipped === 'true' || flipped === '') return 'black';
      if (board.classList && board.classList.contains('flipped')) return 'black';
      return 'white';
    },

    getInitialPosition(customDoc) {
      const doc = getDoc(customDoc);
      if (!doc) return 'startpos';
      const el = doc.querySelector('[data-initial-fen]');
      if (el) {
        const val = (el.getAttribute('data-initial-fen') || '').trim();
        if (val.split(/\s+/).length === 6) return val;
      }
      return 'startpos';
    },

    getDirectFen(customDoc) {
      const doc = getDoc(customDoc);
      if (!doc) return null;
      const el = doc.querySelector('[data-full-fen], [data-fen]');
      if (el) {
        const val = (el.getAttribute('data-full-fen') || el.getAttribute('data-fen') || '').trim();
        if (val.split(/\s+/).length === 6) return val;
      }
      return null;
    },

    getMoveHistory(customDoc) {
      const doc = getDoc(customDoc);
      if (!doc) return null;

      const rootEl = doc.querySelector(
        'wc-simple-move-list, wc-move-list, vertical-move-list, .vertical-move-list, .move-list, .move-list-component'
      );
      if (rootEl) {
        const nodes = rootEl.querySelectorAll('.node, [data-ply]');
        const moves = [];
        let selectedIdx = -1;
        let plyZeroActive = false;
        let variationActive = false;
        const seenPlies = new Set();

        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          // Filter durations before any selection or ply bookkeeping, including
          // nested clock nodes and compound labels such as "1m 22s".
          if (isClockAnnotation(n.textContent || '') &&
              !(n.getAttribute && (n.getAttribute('data-san') || n.getAttribute('data-uci')))) continue;
          const isAct = Boolean(
            n.classList &&
            (n.classList.contains('selected') || n.classList.contains('current') || n.classList.contains('active'))
          );
          if (n.closest && n.closest('.variation, .subvariation')) {
            if (isAct) variationActive = true;
            continue;
          }
          if (
            n.parentElement &&
            n.parentElement !== rootEl &&
            n.parentElement.classList &&
            n.parentElement.classList.contains('node')
          ) {
            if (isAct && selectedIdx < 0 && moves.length > 0) selectedIdx = moves.length - 1;
            continue;
          }
          const ply = n.getAttribute && n.getAttribute('data-ply');
          if (ply === '0') {
            if (isAct) plyZeroActive = true;
            continue;
          }
          if (ply) {
            if (seenPlies.has(ply)) {
              if (isAct && selectedIdx < 0 && moves.length > 0) selectedIdx = moves.length - 1;
              continue;
            }
            seenPlies.add(ply);
          }
          const san = extractMoveText(n);
          if (!san || san === '...' || san === '…') {
            if (isAct) plyZeroActive = true;
            continue;
          }
          moves.push(san);
          if (isAct) selectedIdx = moves.length - 1;
        }
        if (plyZeroActive && selectedIdx < 0) return [];
        if (variationActive && selectedIdx < 0) return null;
        return selectedIdx >= 0 ? moves.slice(0, selectedIdx + 1) : moves;
      }

      if (this.readDisplayedPosition(doc) === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR') {
        return [];
      }
      return null;
    },

    getGameIdentity(customLoc, customDoc) {
      const doc = getDoc(customDoc);
      const loc = getLoc(customLoc, doc);
      if (doc) {
        const el = doc.querySelector('[data-game-id]');
        if (el && (el.getAttribute('data-game-id') || '').trim()) {
          return `chesscom:${el.getAttribute('data-game-id').trim()}`;
        }
      }
      const p = loc && typeof loc.pathname === 'string' && loc.pathname
        ? loc.pathname.replace(/\/+$/, '') || '/root'
        : '/unknown';
      return `chesscom:${p}`;
    },

    readDisplayedPosition(customDoc) {
      const doc = getDoc(customDoc);
      const board = this.getBoardRoot(doc);
      if (!board) return null;
      const pieces = board.querySelectorAll('.piece');
      if (!pieces || pieces.length === 0) return null;

      const map = {};
      let wK = 0;
      let bK = 0;

      for (let i = 0; i < pieces.length; i++) {
        const el = pieces[i];
        if (el.closest && el.closest('.promotion-window, .capture-hint')) continue;
        const cls = (el.getAttribute('class') || '').trim().split(/\s+/);
        if (cls.includes('dragging')) return null;
        if (cls.includes('ghost') || cls.includes('fading')) continue;

        let code = null;
        let sq = (el.getAttribute('data-square') || '').trim().toLowerCase();
        for (let c = 0; c < cls.length; c++) {
          const t = cls[c];
          if (/^[wb][pnbrqk]$/i.test(t)) code = t.toLowerCase();
          else if (/^square-[1-8][1-8]$/.test(t)) {
            sq = `${FILES[Number(t[7]) - 1]}${Number(t[8])}`;
          }
        }
        if (!code || !/^[a-h][1-8]$/.test(sq)) return null;

        const ch = code[0] === 'w' ? code[1].toUpperCase() : code[1];
        if (ch === 'K') wK++;
        else if (ch === 'k') bK++;
        map[sq] = ch;
      }

      if (wK !== 1 || bK !== 1) return null;
      const ranks = [];
      for (let r = 8; r >= 1; r--) {
        let empty = 0;
        let rowStr = '';
        for (let f = 0; f < 8; f++) {
          const ch = map[`${FILES[f]}${r}`];
          if (ch) {
            if (empty > 0) { rowStr += empty; empty = 0; }
            rowStr += ch;
          } else {
            empty++;
          }
        }
        if (empty > 0) rowStr += empty;
        ranks.push(rowStr);
      }
      return ranks.join('/');
    },

    observeChanges(onChange, customDoc, options = {}) {
      const doc = getDoc(customDoc);
      if (!doc || typeof onChange !== 'function') return () => {};
      const debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : 60;
      const Obs = options.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      if (!Obs) return () => {};

      let timer = null;
      let disposed = false;
      const observers = [];

      const notify = (mutations) => {
        if (disposed || timer !== null || !hasExternalMutation(mutations)) return;
        timer = setTimeout(() => {
          timer = null;
          if (!disposed) onChange();
        }, debounceMs);
      };

      const board = this.getBoardRoot(doc);
      if (board) {
        const bo = new Obs(notify);
        bo.observe(board, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'flipped', 'data-orientation', 'data-fen']
        });
        observers.push(bo);
      }

      const movesSelector = 'wc-simple-move-list, wc-move-list, vertical-move-list, .vertical-move-list, .move-list, .move-list-component';
      let movesRoot = null;
      let movesObserver = null;
      const bindMoves = () => {
        const next = doc.querySelector(movesSelector);
        if (next === movesRoot) return false;
        movesObserver?.disconnect();
        movesRoot = next;
        if (next && next !== board) {
          movesObserver = new Obs(notify);
          movesObserver.observe(next, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'data-ply']
          });
        }
        return true;
      };
      bindMoves();
      const container = doc.body || doc.documentElement;
      if (container) {
        const mountObserver = new Obs(() => { if (!disposed && bindMoves()) notify(); });
        mountObserver.observe(container, { childList: true, subtree: true });
        observers.push(mountObserver);
      }

      return () => {
        disposed = true;
        movesObserver?.disconnect();
        if (timer !== null) { clearTimeout(timer); timer = null; }
        for (let i = 0; i < observers.length; i++) {
          try { observers[i].disconnect(); } catch (_e) {}
        }
        observers.length = 0;
      };
    }
  };

  root.ChessComAdapter = ChessComAdapter;
  if (typeof module !== 'undefined' && module.exports) module.exports = ChessComAdapter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
