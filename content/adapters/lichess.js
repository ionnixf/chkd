(function (root) {
  'use strict';

  const ROLE_TO_FEN = Object.freeze({
    pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k',
    p: 'p', n: 'n', b: 'b', r: 'r', q: 'q', k: 'k'
  });
  const FILES = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

  function getDoc(d) { return d || (typeof document !== 'undefined' ? document : null); }
  function getLoc(l, d) { return l || (d && d.location) || (typeof location !== 'undefined' ? location : null); }

  function getBoardWrap(board, doc) {
    // Global orientation selectors can pick unrelated preview boards.
    if (board && typeof board.closest === 'function') {
      return board.closest('.cg-wrap, [data-orientation], .orientation-white, .orientation-black');
    }
    return doc.querySelector('.cg-wrap, .main-board, .analyse__board, [data-orientation]');
  }

  function hasBotBadge(doc) {
    const els = doc.querySelectorAll('.utitle, .user-link .title, [data-bot]');
    for (let i = 0; i < els.length; i++) {
      if (els[i].getAttribute && els[i].getAttribute('data-bot') === 'true') return true;
      if ((els[i].textContent || '').trim().toUpperCase() === 'BOT') return true;
    }
    return false;
  }

  function hasBuiltInAi(doc) {
    if (doc.querySelector('[data-ai-level], .player .ai-name, .ai-name')) return true;
    const els = doc.querySelectorAll('.ruser, .player, .game__meta, .round__app__table');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (
        el.querySelector &&
        el.querySelector('.user-link') &&
        !el.classList?.contains('game__meta') &&
        !el.classList?.contains('round__app__table')
      ) {
        continue;
      }
      if (/\b(?:Stockfish|A\.I\.|ИИ)\s*(?:level|уровень|niveau|stufe|nivel|livello|poziom)?\s*[1-8]\b/i.test(el.textContent || '')) {
        return true;
      }
    }
    return false;
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

  function extractSan(el) {
    if (!el) return '';
    const uci = el.getAttribute && el.getAttribute('data-uci');
    if (uci && /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(uci.trim())) return uci.trim();
    const san = el.getAttribute && el.getAttribute('data-san');
    if (san && san.trim()) return san.trim();
    const sanEl = el.querySelector ? el.querySelector('san') : null;
    const raw = sanEl ? sanEl.textContent : el.textContent;
    return raw ? raw.replace(/^\d+\.+/, '').trim() : '';
  }

  const LichessAdapter = {
    id: 'lichess',

    detect(customLoc, customDoc) {
      const doc = getDoc(customDoc);
      const loc = getLoc(customLoc, doc);
      if (!loc || typeof loc.hostname !== 'string') return false;
      const h = loc.hostname.toLowerCase();
      return h === 'lichess.org' || h.endsWith('.lichess.org');
    },

    getGameMode(customLoc, customDoc) {
      const doc = getDoc(customDoc);
      const loc = getLoc(customLoc, doc);
      if (!doc || !this.detect(loc, doc)) return 'unknown';

      const explicit = doc.documentElement && doc.documentElement.getAttribute('data-knight-mode');
      if (explicit === 'ai' || explicit === 'analysis' || explicit === 'human') {
        return explicit === 'ai' && hasBotBadge(doc) ? 'human' : explicit;
      }

      const path = (loc && typeof loc.pathname === 'string' ? loc.pathname : '').toLowerCase();
      if (path.startsWith('/editor')) return 'unknown';
      if (hasBotBadge(doc)) return 'human';

      if (doc.querySelector('.round__app, .round')) {
        return hasBuiltInAi(doc) ? 'ai' : 'human';
      }
      if (
        path.startsWith('/analysis') ||
        path.startsWith('/study') ||
        path.startsWith('/paste') ||
        Boolean(doc.querySelector('.analyse__board, .analyse'))
      ) {
        return 'analysis';
      }
      if (hasBuiltInAi(doc)) return 'ai';
      if (doc.querySelector('.main-board .user-link')) return 'human';
      return 'unknown';
    },

    getBoardRoot(customDoc) {
      const doc = getDoc(customDoc);
      if (!doc) return null;
      return (
        doc.querySelector('.main-board cg-board') ||
        doc.querySelector('.analyse__board cg-board') ||
        doc.querySelector('.round__app__board cg-board') ||
        doc.querySelector('cg-board') ||
        null
      );
    },

    getOrientation(customDoc) {
      const doc = getDoc(customDoc);
      if (!doc) return 'unknown';
      const board = this.getBoardRoot(doc);
      const wrap = getBoardWrap(board, doc);
      if (wrap) {
        const attr = wrap.getAttribute && wrap.getAttribute('data-orientation');
        if (attr === 'black' || attr === 'white') return attr;
        if (wrap.classList) {
          if (wrap.classList.contains('orientation-black')) return 'black';
          if (wrap.classList.contains('orientation-white')) return 'white';
        }
      }
      return board ? 'white' : 'unknown';
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
        const raw = (el.getAttribute('data-full-fen') || el.getAttribute('data-fen') || '').trim();
        if (raw.split(/\s+/).length === 6) return raw;
      }
      const inp = doc.querySelector('.copyables input.fen, input[data-fen-input], .fen-input');
      if (inp && typeof inp.value === 'string' && inp.value.trim().split(/\s+/).length === 6) {
        return inp.value.trim();
      }
      return null;
    },

    getMoveHistory(customDoc) {
      const doc = getDoc(customDoc);
      if (!doc) return null;

      // Lichess changes its custom element names between deployments.
      const current = doc.querySelector('.round__app .a1t, .round .a1t');
      if (current && current.parentElement && current.tagName) {
        const nodes = current.parentElement.children;
        const moves = [];
        for (const node of nodes) {
          if (node.tagName !== current.tagName) continue;
          const san = extractSan(node);
          if (san && san !== '…' && san !== '...') moves.push(san);
          if (node === current) return moves;
        }
      }

      const roundRoot = doc.querySelector('l4x, .rmoves, .moves');
      if (roundRoot) {
        if (
          roundRoot.querySelector &&
          roundRoot.querySelector('[data-ply="0"].a1t, [data-ply="0"].active, .empty.a1t, .empty.active')
        ) {
          return [];
        }
        const nodes = roundRoot.querySelectorAll('kwdb');
        const moves = [];
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (n.closest && n.closest('interrupt, variation')) continue;
          const san = extractSan(n);
          if (san && san !== '...' && san !== '…') moves.push(san);
          if (n.classList && (n.classList.contains('a1t') || n.classList.contains('active'))) break;
        }
        return moves;
      }

      const analysisRoot = doc.querySelector('.tview2, .analyse__moves');
      if (analysisRoot) {
        const nodes = analysisRoot.querySelectorAll('move');
        const mainline = [];
        let activeIdx = -1;
        let plyZeroActive = Boolean(
          analysisRoot.querySelector &&
          analysisRoot.querySelector('[data-ply="0"].active, [data-ply="0"].current, [data-ply="0"].a1t')
        );
        let variationActive = false;
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const isAct = Boolean(
            n.classList &&
            (n.classList.contains('active') || n.classList.contains('current') || n.classList.contains('a1t'))
          );
          if (n.closest && n.closest('variation, interrupt')) {
            if (isAct) variationActive = true;
            continue;
          }
          if (n.classList && n.classList.contains('empty')) {
            if (isAct) plyZeroActive = true;
            continue;
          }
          const san = extractSan(n);
          if (!san || san === '...' || san === '…') {
            if (isAct) plyZeroActive = true;
            continue;
          }
          mainline.push(san);
          if (isAct) activeIdx = mainline.length - 1;
        }
        if (plyZeroActive && activeIdx < 0) return [];
        if (variationActive && activeIdx < 0) return null;
        return activeIdx >= 0 ? mainline.slice(0, activeIdx + 1) : mainline;
      }

      if (doc.querySelector('[data-ply="0"], .game__meta')) {
        if (this.readDisplayedPosition(doc) === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR') {
          return [];
        }
      }
      return null;
    },

    getGameIdentity(customLoc, customDoc) {
      const doc = getDoc(customDoc);
      const loc = getLoc(customLoc, doc);
      if (doc) {
        const el = doc.querySelector('[data-game-id]');
        if (el && (el.getAttribute('data-game-id') || '').trim()) {
          return `lichess:${el.getAttribute('data-game-id').trim()}`;
        }
      }
      const p = loc && typeof loc.pathname === 'string' && loc.pathname
        ? loc.pathname.replace(/\/+$/, '') || '/root'
        : '/unknown';
      return `lichess:${p}`;
    },

    readDisplayedPosition(customDoc) {
      const doc = getDoc(customDoc);
      const board = this.getBoardRoot(doc);
      if (!board) return null;
      const pieces = board.querySelectorAll('piece');
      if (!pieces || pieces.length === 0) return null;

      const orient = this.getOrientation(doc) === 'black' ? 'black' : 'white';
      const rect = typeof board.getBoundingClientRect === 'function'
        ? board.getBoundingClientRect()
        : { width: 0, height: 0 };
      const bw = rect.width || Number(board.getAttribute('data-board-size')) || 0;
      const bh = rect.height || Number(board.getAttribute('data-board-size')) || 0;

      const map = {};
      let wK = 0;
      let bK = 0;

      for (let i = 0; i < pieces.length; i++) {
        const el = pieces[i];
        const cls = (el.getAttribute('class') || '').toLowerCase().split(/\s+/);
        if (cls.includes('ghost') || cls.includes('fading')) continue;
        if (cls.includes('dragging') || cls.includes('anim')) return null;

        const color = cls.includes('white') ? 'w' : cls.includes('black') ? 'b' : null;
        let role = null;
        for (let c = 0; c < cls.length; c++) {
          if (ROLE_TO_FEN[cls[c]]) { role = ROLE_TO_FEN[cls[c]]; break; }
        }
        if (!color || !role) continue;

        let sq = (el.getAttribute('data-square') || el.getAttribute('square') || '').trim().toLowerCase();
        if (!/^[a-h][1-8]$/.test(sq)) {
          const style = el.getAttribute('style') || '';
          const m = /translate(?:3d)?\(\s*(-?\d+(?:\.\d+)?)(px|%)?\s*,\s*(-?\d+(?:\.\d+)?)(px|%)?/i.exec(style);
          if (!m) return null;
          const x = parseFloat(m[1]);
          const y = parseFloat(m[3]);
          const ux = m[2] ? m[2].toLowerCase() : (x === 0 ? (m[4] ? m[4].toLowerCase() : '%') : '');
          const uy = m[4] ? m[4].toLowerCase() : (y === 0 ? ux : '');
          let col;
          let row;
          if (ux === '%' && uy === '%') {
            col = Math.round(x / 100);
            row = Math.round(y / 100);
          } else if ((ux === 'px' || x === 0) && (uy === 'px' || y === 0) && bw > 0 && bh > 0) {
            col = Math.round((x / bw) * 8);
            row = Math.round((y / bh) * 8);
          } else {
            return null;
          }
          if (col < 0 || col > 7 || row < 0 || row > 7) return null;
          sq = `${FILES[orient === 'black' ? 7 - col : col]}${orient === 'black' ? row + 1 : 8 - row}`;
        }

        const ch = color === 'w' ? role.toUpperCase() : role;
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
          attributeFilter: ['class', 'style', 'data-square', 'square']
        });
        observers.push(bo);
      }

      const wrap = getBoardWrap(board, doc);
      if (wrap && wrap !== board) {
        const wo = new Obs(notify);
        wo.observe(wrap, {
          attributes: true,
          attributeFilter: ['class', 'data-orientation']
        });
        observers.push(wo);
      }

      const movesRoot = doc.querySelector('l4x, .rmoves, .moves, .tview2, .analyse__moves') || doc.querySelector('.round__app__table, .round__app');
      if (movesRoot && movesRoot !== board) {
        const mo = new Obs(notify);
        mo.observe(movesRoot, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class']
        });
        observers.push(mo);
      }

      return () => {
        disposed = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        for (let i = 0; i < observers.length; i++) {
          try { observers[i].disconnect(); } catch (_e) {}
        }
        observers.length = 0;
      };
    }
  };

  root.LichessAdapter = LichessAdapter;
  if (typeof module !== 'undefined' && module.exports) module.exports = LichessAdapter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
