(function (root) {
  'use strict';

  const Rules = root.ChessRules || (typeof require === 'function' ? require('../vendor/chess-rules.iife.js') : null);
  const Chess = Rules ? Rules.Chess : root.Chess;
  const DEFAULT_POSITION = (Rules && Rules.DEFAULT_POSITION) || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const FIGURINE_MAP = Object.freeze({
    '♔': 'K', '♕': 'Q', '♖': 'R', '♗': 'B', '♘': 'N', '♙': '',
    '♚': 'K', '♛': 'Q', '♜': 'R', '♝': 'B', '♞': 'N', '♟': ''
  });

  function validateFullFen(fen) {
    if (typeof fen !== 'string') return { ok: false, error: 'FEN must be a string' };
    const t = fen.trim();
    if (t.length < 15 || t.length > 120) return { ok: false, error: 'FEN length out of bounds' };
    const parts = t.split(/\s+/);
    if (parts.length !== 6) return { ok: false, error: 'FEN must have all 6 fields' };
    const [, turn, castling, ep, half, full] = parts;
    if ((turn !== 'w' && turn !== 'b') || (castling !== '-' && !/^(?!$)K?Q?k?q?$/.test(castling))) {
      return { ok: false, error: 'Invalid turn or castling in FEN' };
    }
    if (ep !== '-' && (!/^[a-h][36]$/.test(ep) || (turn === 'w' ? ep[1] !== '6' : ep[1] !== '3'))) {
      return { ok: false, error: 'Invalid en passant square in FEN' };
    }
    if (!/^\d{1,3}$/.test(half) || !/^[1-9]\d{0,3}$/.test(full)) {
      return { ok: false, error: 'Invalid move counters in FEN' };
    }
    if (Rules?.validateFen) {
      const check = Rules.validateFen(t);
      if (!check || !check.ok) return { ok: false, error: check?.error || 'FEN validation failed' };
    }
    try {
      const inst = new Chess(t);
      return { ok: true, fen: t, normalizedFen: inst.fen() };
    } catch (err) {
      return { ok: false, error: err?.message || 'Failed to parse FEN' };
    }
  }

  function normalizeMoveToken(raw) {
    if (typeof raw !== 'string') return '';
    let token = raw.trim().replace(/^\d+\.+/, '').trim();
    if (!token) return '';
    token = token.replace(/[♔♕♖♗♘♙♚♛♜♝♞♟]/g, (ch) => FIGURINE_MAP[ch] ?? '');
    if (/^0-0-0([+#!?]*)$/.test(token)) token = token.replace(/^0-0-0/, 'O-O-O');
    else if (/^0-0([+#!?]*)$/.test(token)) token = token.replace(/^0-0/, 'O-O');
    return token.trim();
  }

  function applyMoveToChess(chess, rawMove) {
    const token = normalizeMoveToken(rawMove);
    if (!token) return null;
    const uci = /^([a-h][1-8])([a-h][1-8])([qrbnQRBN])?$/.exec(token);
    if (uci) {
      const from = uci[1], to = uci[2], promotion = uci[3] ? uci[3].toLowerCase() : undefined;
      try {
        const res = chess.move({ from, to, promotion });
        if (res) return res;
      } catch (_e) {
        const piece = chess.get(from);
        if (piece && piece.type === 'k') {
          if ((from === 'e1' && to === 'h1') || (from === 'e8' && to === 'h8')) {
            try { return chess.move('O-O'); } catch (_e2) { return null; }
          }
          if ((from === 'e1' && to === 'a1') || (from === 'e8' && to === 'a8')) {
            try { return chess.move('O-O-O'); } catch (_e2) { return null; }
          }
        }
        return null;
      }
    }
    try { const res = chess.move(token); if (res) return res; } catch (_e) {}
    try { const res = chess.move(token.replace(/[!?]+$/g, ''), { strict: false }); if (res) return res; } catch (_e) {}
    return null;
  }

  function squareMapToPlacement(squareMap) {
    if (!squareMap || typeof squareMap !== 'object') return null;
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = [];
    for (let r = 8; r >= 1; r--) {
      let empty = 0, row = '';
      for (let f = 0; f < 8; f++) {
        const entry = squareMap[`${files[f]}${r}`];
        let ch = null;
        if (typeof entry === 'string' && entry) {
          if (entry.length === 1 && 'pnbrqkPNBRQK'.includes(entry)) ch = entry;
          else if (entry.length === 2 && (entry[0] === 'w' || entry[0] === 'b')) {
            const role = entry[1].toLowerCase();
            if ('pnbrqk'.includes(role)) ch = entry[0] === 'w' ? role.toUpperCase() : role;
          }
        } else if (entry && typeof entry === 'object' && entry.type && entry.color) {
          const role = String(entry.type).toLowerCase();
          if ('pnbrqk'.includes(role)) ch = entry.color === 'w' ? role.toUpperCase() : role;
        }
        if (ch) {
          if (empty > 0) { row += empty; empty = 0; }
          row += ch;
        } else empty++;
      }
      if (empty > 0) row += empty;
      ranks.push(row);
    }
    return ranks.join('/');
  }

  function normalizePlacement(displayedBoard) {
    if (!displayedBoard) return null;
    if (typeof displayedBoard === 'string') {
      const first = displayedBoard.trim().split(/\s+/)[0];
      return first && first.split('/').length === 8 ? first : null;
    }
    return typeof displayedBoard === 'object' ? squareMapToPlacement(displayedBoard) : null;
  }

  function verifyBoardPlacement(fen, displayedBoard) {
    if (displayedBoard === null || displayedBoard === undefined) return { ok: true, checked: false };
    const expected = typeof fen === 'string' ? fen.trim().split(/\s+/)[0] : '';
    const actual = normalizePlacement(displayedBoard);
    if (!actual) return { ok: false, checked: true, reason: 'Displayed board placement unparseable' };
    return expected === actual
      ? { ok: true, checked: true }
      : { ok: false, checked: true, reason: `DOM board (${actual}) != FEN (${expected})` };
  }

  function reconstructPosition(options = {}) {
    if (!Chess) return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: 'Rules missing' };
    const { directFen = null, initialFen = 'startpos', moves = null, displayedBoard = null } = options;
    const hasMoves = Array.isArray(moves);
    let chess = null;

    if (hasMoves && moves.length > 0) {
      if (initialFen && initialFen !== 'startpos') {
        const ic = validateFullFen(initialFen);
        if (!ic.ok) return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: ic.error };
        chess = new Chess(ic.fen);
      } else chess = new Chess();

      for (let i = 0; i < moves.length; i++) {
        if (!applyMoveToChess(chess, moves[i])) {
          return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: `Illegal move #${i + 1}: ${String(moves[i])}` };
        }
      }
      if (typeof directFen === 'string' && directFen.trim()) {
        const dc = validateFullFen(directFen);
        if (!dc.ok) return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: dc.error };
        const dp = dc.fen.split(/\s+/), rp = chess.fen().split(/\s+/);
        if (dp[0] !== rp[0] || dp[1] !== rp[1]) {
          if (displayedBoard !== null && displayedBoard !== undefined) {
            const rMatch = verifyBoardPlacement(chess.fen(), displayedBoard).ok;
            const dMatch = verifyBoardPlacement(dc.fen, displayedBoard).ok;
            if (dMatch && !rMatch) chess = new Chess(dc.fen);
            else if (!rMatch) {
              return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: 'Direct FEN conflicts with move history' };
            }
          } else {
            return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: 'Direct FEN conflicts with move history' };
          }
        }
      }
    } else if (typeof directFen === 'string' && directFen.trim()) {
      const dc = validateFullFen(directFen);
      if (!dc.ok) return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: dc.error };
      chess = new Chess(dc.fen);
    } else if (hasMoves && moves.length === 0) {
      if (initialFen && initialFen !== 'startpos') {
        const ic = validateFullFen(initialFen);
        if (!ic.ok) return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: ic.error };
        chess = new Chess(ic.fen);
      } else chess = new Chess();
    } else {
      return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: 'History unavailable; refusing to fabricate FEN' };
    }

    const fullFen = chess.fen();
    const check = verifyBoardPlacement(fullFen, displayedBoard);
    if (!check.ok) return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: check.reason };

    return {
      ok: true, fen: fullFen, turn: chess.turn(), moveCount: hasMoves ? moves.length : 0,
      isGameOver: chess.isGameOver(), isCheckmate: chess.isCheckmate(),
      isStalemate: chess.isStalemate(), isDraw: chess.isDraw()
    };
  }

  function validateUciMove(fen, uciMove) {
    if (typeof fen !== 'string' || typeof uciMove !== 'string') return { ok: false, reason: 'Invalid input' };
    const fc = validateFullFen(fen);
    if (!fc.ok) return { ok: false, reason: fc.error };
    const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uciMove.trim().toLowerCase());
    if (!m) return { ok: false, reason: 'Invalid UCI move syntax' };
    try {
      const chess = new Chess(fc.fen);
      const res = chess.move({ from: m[1], to: m[2], promotion: m[3] || undefined });
      if (!res) return { ok: false, reason: 'Move is illegal in position' };
      return { ok: true, uci: res.lan, san: res.san, from: res.from, to: res.to, promotion: res.promotion || null, afterFen: chess.fen() };
    } catch (err) {
      return { ok: false, reason: err?.message || 'Illegal UCI move' };
    }
  }

  function computeFingerprint(gameId, fullFen, settingsRevision = 0) {
    const rev = Number.isFinite(Number(settingsRevision)) ? Number(settingsRevision) : 0;
    return `${String(gameId || 'unknown-game').trim()}:${String(fullFen || '').trim()}:${rev}`;
  }

  class MoveExecutor {
    constructor(options = {}) {
      this.boardContract = options.boardContract || null;
      this.autoplayAuthorized = options.autoplayAuthorized === true;
      this.hostname = (options.hostname ?? root.location?.hostname ?? 'localhost').toLowerCase();
      this.confirmTimeoutMs = options.confirmTimeoutMs || 3000;
      this.pendingExecution = null;
    }
    isAllowedEnvironment() {
      if (!this.autoplayAuthorized && /(?:^|\.)(?:lichess\.org|chess\.com)$/.test(this.hostname)) return false;
      return typeof this.boardContract?.executeMove === 'function';
    }
    async executeMove(request) {
      if (!this.isAllowedEnvironment()) {
        return { ok: false, errorCode: 'UNSUPPORTED_CONTEXT', reason: 'MoveExecutor forbidden on external chess sites' };
      }
      if (this.pendingExecution || !request || typeof request !== 'object') {
        return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: 'Executor busy or invalid request' };
      }
      const v = validateUciMove(request.fen, request.bestMove);
      if (!v.ok) return { ok: false, errorCode: 'POSITION_UNCERTAIN', reason: v.reason };

      let resolveConfirm, rejectConfirm;
      const confirmPromise = new Promise((res, rej) => { resolveConfirm = res; rejectConfirm = rej; });
      confirmPromise.catch(() => {});
      const timer = setTimeout(() => {
        if (this.pendingExecution) { this.pendingExecution = null; rejectConfirm(new Error('Confirmation timeout')); }
      }, this.confirmTimeoutMs);

      this.pendingExecution = { expectedFen: v.afterFen, uci: v.uci, san: v.san, timer, resolve: resolveConfirm, reject: rejectConfirm };
      try {
        await this.boardContract.executeMove({
          uci: v.uci, san: v.san, from: v.from, to: v.to, promotion: v.promotion, expectedFen: v.afterFen
        });
        const confirmedFen = await confirmPromise;
        return { ok: true, executedMove: v.uci, san: v.san, confirmedFen };
      } catch (err) {
        if (this.pendingExecution) { clearTimeout(this.pendingExecution.timer); this.pendingExecution = null; }
        return { ok: false, errorCode: err?.code || 'POSITION_UNCERTAIN', reason: err?.message || 'Move execution failed' };
      }
    }
    cancel(reason = 'Auto move canceled') {
      const pending = this.pendingExecution;
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingExecution = null;
      pending.reject(new Error(reason));
    }
    confirmPosition(observedFen) {
      if (!this.pendingExecution) return false;
      const check = validateFullFen(observedFen);
      if (!check.ok) return false;
      const exp = this.pendingExecution.expectedFen.split(/\s+/), obs = check.fen.split(/\s+/);
      if (exp[0] === obs[0] && exp[1] === obs[1]) {
        const pending = this.pendingExecution;
        clearTimeout(pending.timer);
        this.pendingExecution = null;
        pending.resolve(check.fen);
        return true;
      }
      return false;
    }
  }

  const KnightPosition = {
    DEFAULT_POSITION, validateFullFen, normalizeMoveToken, applyMoveToChess,
    squareMapToPlacement, normalizePlacement, verifyBoardPlacement,
    reconstructPosition, validateUciMove, computeFingerprint, MoveExecutor
  };
  root.KnightPosition = KnightPosition;
  if (typeof module !== 'undefined' && module.exports) module.exports = KnightPosition;
})(typeof globalThis !== 'undefined' ? globalThis : this);
