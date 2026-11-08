(function (root) {
  'use strict';

  const PositionMod = root.KnightPosition || (typeof require === 'function' ? require('./position.js') : null);
  const OverlayMod = root.KnightOverlay || (typeof require === 'function' ? require('./overlay.js') : null);
  const LichessAdapter = root.LichessAdapter || (typeof require === 'function' ? require('./adapters/lichess.js') : null);
  const ChessComAdapter = root.ChessComAdapter || (typeof require === 'function' ? require('./adapters/chesscom.js') : null);

  const PROTOCOL_VERSION = 1;
  const PORT_NAME = 'knight:session';

  function generateSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'sess-' + Math.random().toString(36).slice(2, 11) + '-' + Date.now().toString(36);
  }

  function selectAdapter(loc, doc, adapters) {
    const list = adapters || [LichessAdapter, ChessComAdapter].filter(Boolean);
    for (const a of list) {
      if (a && typeof a.detect === 'function' && a.detect(loc, doc)) return a;
    }
    return null;
  }

  class ContentController {
    constructor(options = {}) {
      this.doc = options.document || (typeof document !== 'undefined' ? document : null);
      this.win = options.window || (typeof window !== 'undefined' ? window : null);
      this.loc = options.location || this.doc?.location || (typeof location !== 'undefined' ? location : null);
      this.ext = options.ext || root.browser || root.chrome || null;
      this.MutationObserverCtor = options.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      this.adapter = options.adapter || selectAdapter(this.loc, this.doc, options.adapters);
      this.overlay = options.overlay || (OverlayMod ? new OverlayMod.BoardOverlay({ document: this.doc }) : null);

      this.sessionId = options.sessionId || generateSessionId();
      this.revision = 0;
      this.settingsRevision = 0;
      this.currentGameId = null;
      this.currentFen = null;
      this.lastFingerprint = null;
      this.lastDisabledKey = null;
      this.observedBoardRoot = null;
      this.autoPlay = false;
      this.autoPlayColor = null;
      this.autoBusy = false;
      this.lastAutoAttempt = null;
      this.lastEngineResult = null;
      this.moveExecutor = new PositionMod.MoveExecutor({
        hostname: this.loc?.hostname, autoplayAuthorized: true,
        boardContract: { executeMove: info => this._dispatchAutoMove(info) }
      });
      this.enabled = false;
      this.isActiveSession = false;
      this.port = null;
      this.reconnectTimer = null;
      this.reconnectDelayMs = 250;
      this.disposeAdapterObserver = null;
      this.bootstrapObserver = null;
      this.destroyed = false;
      this._onNavOrVis = () => { if (!this.destroyed) this.evaluatePosition(); };
    }

    start() {
      if (this.destroyed || !this.adapter || !this.doc) return false;
      this.doc.addEventListener?.('visibilitychange', this._onNavOrVis);
      this.win?.addEventListener?.('popstate', this._onNavOrVis);
      this.win?.addEventListener?.('hashchange', this._onNavOrVis);
      this._connectPort();
      this._bindBoardAndObserve();
      this.evaluatePosition();
      return true;
    }

    _connectPort() {
      if (this.destroyed || this.port || typeof this.ext?.runtime?.connect !== 'function') return;
      try {
        const port = this.ext.runtime.connect({ name: PORT_NAME });
        this.port = port;
        this._clearReconnectTimer();
        this.lastFingerprint = null;
        this.lastDisabledKey = null;
        port.onMessage?.addListener?.((msg) => {
          if (this.port === port) this._handleBackgroundMessage(msg);
        });
        port.onDisconnect?.addListener?.(() => this._handlePortDisconnect(port));
        const mode = this.adapter.getGameMode(this.loc, this.doc);
        const gameId = this.adapter.getGameIdentity(this.loc, this.doc);
        this.currentGameId = gameId;
        this._post({
          type: 'HELLO', v: PROTOCOL_VERSION, sessionId: this.sessionId, revision: this.revision,
          payload: { site: this.adapter.id, mode, gameId }
        });
      } catch (_e) {
        this._handlePortDisconnect(this.port);
      }
    }

    _clearReconnectTimer() {
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    _scheduleReconnect() {
      if (this.destroyed || this.reconnectTimer !== null) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        // Re-register and resend the position even if the board has not changed.
        this.evaluatePosition();
      }, this.reconnectDelayMs);
      this.reconnectTimer.unref?.();
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
    }

    _handlePortDisconnect(port) {
      if (this.port !== port) return;
      this.port = null;
      this.lastFingerprint = null;
      this.lastDisabledKey = null;
      this.enabled = false;
      this.isActiveSession = false;
      this.overlay?.clear();
      this._cancelAutoMove('Connection lost');
      this.lastEngineResult = null;
      this._scheduleReconnect();
    }

    _sendDisableOnce(errorCode, message, extra = {}) {
      const key = `${errorCode}:${message || ''}:${extra.mode || ''}`;
      if (this.lastDisabledKey === key) return;
      this.lastDisabledKey = key;
      this._post({
        type: 'DISABLE_SESSION', v: PROTOCOL_VERSION, sessionId: this.sessionId, revision: this.revision,
        payload: { errorCode, message, ...extra }
      });
    }

    _bindBoardAndObserve() {
      if (this.destroyed || !this.doc || !this.adapter) return;
      const boardRoot = this.adapter.getBoardRoot(this.doc);
      if (boardRoot) {
        this._stopBootstrapObserver();
        this.observedBoardRoot = boardRoot;
        this.overlay?.attach(boardRoot, this.adapter.getOrientation(this.doc));
        if (this.disposeAdapterObserver) this.disposeAdapterObserver();
        this.disposeAdapterObserver = this.adapter.observeChanges(
          () => this.evaluatePosition(),
          this.doc,
          { MutationObserver: this.MutationObserverCtor }
        );
        return;
      }

      this.observedBoardRoot = null;
      this._sendDisableOnce('BOARD_NOT_FOUND', 'Board root element not found');

      if (!this.bootstrapObserver && this.MutationObserverCtor) {
        const target = this.doc.body || this.doc.documentElement;
        if (target) {
          this.bootstrapObserver = new this.MutationObserverCtor(() => {
            if (!this.destroyed && this.adapter.getBoardRoot(this.doc)) {
              this._stopBootstrapObserver();
              this._bindBoardAndObserve();
              this.evaluatePosition();
            }
          });
          this.bootstrapObserver.observe(target, { childList: true, subtree: true });
        }
      }
    }

    _stopBootstrapObserver() {
      if (this.bootstrapObserver) {
        try { this.bootstrapObserver.disconnect(); } catch (_e) {}
        this.bootstrapObserver = null;
      }
    }

    evaluatePosition() {
      if (this.destroyed || !this.adapter || !this.doc) return null;
      if (!this.port) this._connectPort();

      const boardRoot = this.adapter.getBoardRoot(this.doc);
      if (!boardRoot) {
        this.overlay?.detach();
        this.lastFingerprint = null;
        this._bindBoardAndObserve();
        return { ok: false, errorCode: 'BOARD_NOT_FOUND' };
      }

      if (boardRoot !== this.observedBoardRoot) {
        this._bindBoardAndObserve();
      }

      const orientation = this.adapter.getOrientation(this.doc);
      if (this.overlay) {
        this.overlay.attach(boardRoot, orientation);
        this.overlay.setOrientation(orientation);
      }

      const mode = this.adapter.getGameMode(this.loc, this.doc);
      const gameId = this.adapter.getGameIdentity(this.loc, this.doc);
      const history = this.adapter.getMoveHistory(this.doc);
      const recon = PositionMod.reconstructPosition({
        directFen: typeof this.adapter.getDirectFen === 'function' ? this.adapter.getDirectFen(this.doc) : null,
        initialFen: this.adapter.getInitialPosition(this.doc),
        moves: history,
        displayedBoard: this.adapter.readDisplayedPosition(this.doc)
      });

      if (!recon.ok) {
        this.overlay?.clear();
        if (this.moveExecutor.pendingExecution) return recon;
        this.lastFingerprint = null;
        this.currentFen = null;
        this._sendDisableOnce(recon.errorCode || 'POSITION_UNCERTAIN', recon.reason);
        return recon;
      }

      this.lastDisabledKey = null;
      if (this.currentGameId !== gameId) this._cancelAutoMove('Game changed');
      if (this.moveExecutor.pendingExecution) {
        this.moveExecutor.confirmPosition(recon.fen);
        if (this.moveExecutor.pendingExecution && Array.isArray(history) && Number.isInteger(this.autoHistoryLength)) {
          const prefix = PositionMod.reconstructPosition({ initialFen: this.adapter.getInitialPosition(this.doc),
            moves: history.slice(0, this.autoHistoryLength + 1) });
          if (prefix.ok) this.moveExecutor.confirmPosition(prefix.fen);
        }
      }

      if (recon.isGameOver) {
        this.overlay?.clear();
        const fp = PositionMod.computeFingerprint(gameId, recon.fen, this.settingsRevision);
        if (fp !== this.lastFingerprint) {
          this.currentGameId = gameId;
          this.currentFen = recon.fen;
          this.lastFingerprint = fp;
          this._post({
            type: 'GAME_ENDED', v: PROTOCOL_VERSION, sessionId: this.sessionId, revision: this.revision,
            payload: { gameId, fen: recon.fen }
          });
        }
        return recon;
      }

      const fp = PositionMod.computeFingerprint(gameId, recon.fen, this.settingsRevision);
      if (fp === this.lastFingerprint) return { ok: true, deduplicated: true, fen: recon.fen };

      this.lastFingerprint = fp;
      this.currentGameId = gameId;
      this.currentFen = recon.fen;
      this.lastEngineResult = null;
      boardRoot.removeAttribute?.('data-knight-move-token');
      this.revision += 1;
      this.overlay?.clear();

      this._post({
        type: 'POSITION_CHANGED', v: PROTOCOL_VERSION, sessionId: this.sessionId, revision: this.revision,
        payload: { gameId, mode, fen: recon.fen }
      });
      return { ok: true, deduplicated: false, fen: recon.fen, revision: this.revision };
    }

    _handleBackgroundMessage(msg) {
      if (this.destroyed || !msg || typeof msg !== 'object') return;
      if (msg.v !== PROTOCOL_VERSION || msg.sessionId !== this.sessionId) return;
      const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};

      if (msg.type === 'SESSION_STATUS') {
        this.reconnectDelayMs = 250;
        this.isActiveSession = Boolean(p.isActiveSession);
        if (typeof p.configRevision === 'number' && p.configRevision !== this.settingsRevision) {
          this.settingsRevision = p.configRevision;
          if (this.currentGameId && this.currentFen) {
            this.lastFingerprint = PositionMod.computeFingerprint(this.currentGameId, this.currentFen, this.settingsRevision);
          }
        }
        if (p.config && typeof p.config === 'object') {
          const wasAutoPlay = this.autoPlay;
          this.autoPlay = p.config.autoPlay === true;
          if (!wasAutoPlay && this.autoPlay) this.lastAutoAttempt = null;
          this.enabled = Boolean(p.config.enabled);
          if (!this.enabled || !this.autoPlay) this._cancelAutoMove();
          this.overlay?.setConfig({ showArrow: p.config.showArrow, showEval: p.config.showEval });
        }
        if (!this.enabled || !this.isActiveSession || p.status === 'disabled' || p.reason === 'GAME_OVER') {
          this.overlay?.clear();
          this._cancelAutoMove();
        }
        this._maybeAutoMove();
      } else if (msg.type === 'ENGINE_RESULT') {
        if (msg.revision !== this.revision || p.gameId !== this.currentGameId || p.fen !== this.currentFen || !p.bestMove) {
          return;
        }
        const check = PositionMod.validateUciMove(this.currentFen, p.bestMove);
        if (!check || !check.ok) {
          this.overlay?.clear();
          return;
        }
        this.lastEngineResult = { ...p, revision: msg.revision };
        if (this.overlay && this.enabled && this.isActiveSession) {
          this.overlay.setOrientation(this.adapter.getOrientation(this.doc));
          this.overlay.renderResult({
            bestMove: check.uci, san: check.san, depth: p.depth,
            evalText: p.evalText, scoreCp: p.scoreCp, scoreMate: p.scoreMate
          });
        }
        this._maybeAutoMove();
      } else if (msg.type === 'ERROR') {
        this.overlay?.clear();
        this.lastEngineResult = null;
        this._cancelAutoMove();
      }
    }

    _cancelAutoMove(reason) {
      this.moveExecutor.cancel(reason);
      const board = this.adapter?.getBoardRoot(this.doc);
      board?.removeAttribute?.('data-knight-move-token');
      board?.removeAttribute?.('data-knight-move-running');
    }

    async _dispatchAutoMove(info) {
      const request = this.autoRequest;
      if (!this.autoPlay || !this.enabled || !this.isActiveSession || this.destroyed ||
          !request || request.fen !== this.currentFen || request.revision !== this.revision) {
        throw Object.assign(new Error('Position changed'), { code: 'POSITION_CHANGED' });
      }
      const board = this.adapter.getBoardRoot(this.doc);
      if (!board?.setAttribute) throw new Error('Board unavailable');
      const token = generateSessionId();
      board.setAttribute('data-knight-move-token', token);
      try {
        const response = await this.ext.runtime.sendMessage({ type: 'EXECUTE_MOVE', sessionId: this.sessionId,
          revision: request.revision, payload: { gameId: request.gameId, fen: request.fen,
            uci: info.uci, token, orientation: this.adapter.getOrientation(this.doc) } });
        if (!response?.ok) throw Object.assign(new Error(response?.error || 'No response from move executor'),
          { code: response?.errorCode });
      } finally {
        board.removeAttribute?.('data-knight-move-token');
        board.removeAttribute?.('data-knight-move-running');
      }
    }

    async _maybeAutoMove() {
      const result = this.lastEngineResult;
      if (this.destroyed || !this.enabled || !this.autoPlay || !this.isActiveSession || this.autoBusy || !result ||
          result.fen !== this.currentFen || result.gameId !== this.currentGameId || result.revision !== this.revision) return;
      const key = `${this.currentGameId}:${this.currentFen}`;
      if (key === this.lastAutoAttempt) return;
      this.lastAutoAttempt = key;
      this.autoBusy = true;
      this.autoRequest = { ...result };
      const history = this.adapter.getMoveHistory(this.doc);
      this.autoHistoryLength = Array.isArray(history) ? history.length : null;
      try {
        const detected = await this.ext.runtime.sendMessage({ type: 'GET_PLAYER_COLOR', sessionId: this.sessionId,
          revision: result.revision, payload: { gameId: result.gameId, fen: result.fen } });
        if (this.destroyed || !this.autoPlay || !this.enabled || !this.isActiveSession ||
            result.fen !== this.currentFen || result.gameId !== this.currentGameId || result.revision !== this.revision) return;
        if (detected?.errorCode === 'POSITION_CHANGED') {
          this.evaluatePosition();
          return;
        }
        this.autoPlayColor = ['white', 'black'].includes(detected?.color) ? detected.color : null;
        if (!this.autoPlayColor) {
          this._sendDisableOnce('AUTO_MOVE_FAILED', detected?.error || 'Could not determine your playing side');
          return;
        }
        if (result.fen.split(/\s+/)[1] !== this.autoPlayColor[0]) return;
        this.autoRequest.color = this.autoPlayColor;
        const outcome = await this.moveExecutor.executeMove({ fen: result.fen, bestMove: result.bestMove });
        if (outcome.errorCode === 'POSITION_CHANGED') {
          this.evaluatePosition();
          return;
        }
        if (!outcome.ok && this.autoPlay && this.enabled && !this.destroyed && this.port &&
            this.autoRequest.color === this.autoPlayColor && result.gameId === this.currentGameId &&
            result.fen === this.currentFen && result.revision === this.revision) {
          this._sendDisableOnce('AUTO_MOVE_FAILED', outcome.reason);
        }
      } catch (error) {
        if (!this.destroyed && this.autoPlay && this.enabled && result.gameId === this.currentGameId &&
            result.fen === this.currentFen && result.revision === this.revision) {
          this._sendDisableOnce('AUTO_MOVE_FAILED', error.message || 'Side detection failed');
        }
      } finally {
        this.autoBusy = false;
        this.autoRequest = null;
        this._maybeAutoMove();
      }
    }

    _post(msg) {
      if (!this.port) return;
      const port = this.port;
      try { port.postMessage(msg); } catch (_e) { this._handlePortDisconnect(port); }
    }

    destroy() {
      this.destroyed = true;
      this._cancelAutoMove();
      this._clearReconnectTimer();
      this.doc?.removeEventListener?.('visibilitychange', this._onNavOrVis);
      this.win?.removeEventListener?.('popstate', this._onNavOrVis);
      this.win?.removeEventListener?.('hashchange', this._onNavOrVis);
      this._stopBootstrapObserver();
      if (this.disposeAdapterObserver) { this.disposeAdapterObserver(); this.disposeAdapterObserver = null; }
      this.overlay?.detach();
      if (this.port) {
        this._post({
          type: 'DISABLE_SESSION', v: PROTOCOL_VERSION, sessionId: this.sessionId, revision: this.revision,
          payload: { reason: 'SESSION_CLOSED' }
        });
        try { this.port.disconnect?.(); } catch (_e) {}
        this.port = null;
      }
    }
  }

  let activeContentController = null;
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && (root.browser || root.chrome) && !root.__KNIGHT_DISABLE_AUTO_BOOT__) {
    activeContentController = new ContentController();
    activeContentController.start();
    window.addEventListener('pagehide', () => activeContentController?.destroy());
  }

  const KnightContent = { PORT_NAME, PROTOCOL_VERSION, selectAdapter, ContentController, getActiveController: () => activeContentController };
  root.KnightContent = KnightContent;
  if (typeof module !== 'undefined' && module.exports) module.exports = KnightContent;
})(typeof globalThis !== 'undefined' ? globalThis : this);
