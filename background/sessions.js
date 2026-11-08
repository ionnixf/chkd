(function (root) {
  'use strict';

  const Config = root.KnightConfig || (typeof require === 'function' ? require('./config.js') : null);
  const EngineMod = root.KnightEngine || (typeof require === 'function' ? require('./engine.js') : null);

  function isValidProtocolMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.v !== Config.PROTOCOL_VERSION) return false;
    if (typeof msg.type !== 'string' || !msg.type) return false;
    if (typeof msg.sessionId !== 'string' || !msg.sessionId || msg.sessionId.length > 128) return false;
    return msg.revision === undefined || (typeof msg.revision === 'number' && Number.isInteger(msg.revision) && msg.revision >= 0);
  }

  class SessionController {
    constructor(options = {}) {
      this.storage = options.storage || null;
      this.config = Config ? { ...Config.DEFAULT_CONFIG, ...(options.initialConfig || {}) } : { ...options.initialConfig };
      this.configLoaded = Boolean(options.initialConfig);
      this.configRevision = 1;
      this.sessions = new Map();
      this.activeSessionId = null;
      this.onStatusChange = typeof options.onStatusChange === 'function' ? options.onStatusChange : null;

      this.engine = options.engine || new EngineMod.EngineController({
        config: this.config,
        workerFactory: options.workerFactory,
        moveValidator: options.moveValidator,
        onResult: (res) => this._handleEngineResult(res),
        onError: (err) => this._handleEngineError(err)
      });
      if (options.engine) {
        this.engine.onResult = (res) => this._handleEngineResult(res);
        this.engine.onError = (err) => this._handleEngineError(err);
      }
    }

    async init() {
      if (Config) {
        this.config = await Config.loadConfig(this.storage);
        this.configLoaded = true;
        this.engine.updateConfig(this.config);
      }
      return this.config;
    }

    async _ensureConfig() { if (!this.configLoaded && Config) await this.init(); }

    handlePortConnect(port) {
      if (!port || port.name !== Config.PORT_NAME) return;
      let boundId = null;

      const processMsg = (msg) => {
        if (!isValidProtocolMessage(msg)) {
          this._safePost(port, {
            type: 'ERROR', v: Config.PROTOCOL_VERSION,
            sessionId: (msg && msg.sessionId) || 'unknown', revision: (msg && msg.revision) || 0,
            payload: { code: Config.ERROR_CODES.POSITION_UNCERTAIN, message: 'Invalid protocol message rejected' }
          });
          return;
        }
        boundId = msg.sessionId;
        this._handleSessionMessage(port, msg);
      };

      const onMessage = (msg) => {
        if (this.configLoaded) processMsg(msg);
        else this._ensureConfig().then(() => processMsg(msg));
      };

      const onDisconnect = () => {
        if (boundId) {
          this._handleSessionDisconnect(boundId, port);
        } else {
          for (const [sid, s] of this.sessions.entries()) {
            if (s.port === port) { this._handleSessionDisconnect(sid, port); break; }
          }
        }
      };

      port.onMessage?.addListener?.(onMessage);
      port.onDisconnect?.addListener?.(onDisconnect);
    }

    _getOrCreateSession(port, msg) {
      const sid = msg.sessionId;
      const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const tab = port?.sender?.tab || null;
      let s = this.sessions.get(sid);
      if (!s) {
        s = {
          sessionId: sid, port,
          tabId: typeof tab?.id === 'number' ? tab.id : null,
          url: typeof tab?.url === 'string' ? tab.url : null,
          site: typeof p.site === 'string' ? p.site : 'unknown',
          mode: typeof p.mode === 'string' ? p.mode : 'unknown',
          gameId: typeof p.gameId === 'string' ? p.gameId : null,
          revision: typeof msg.revision === 'number' ? msg.revision : 0,
          fen: null, lastAnalyzedFingerprint: null,
          status: this.config.enabled ? 'ready' : 'disabled',
          lastResult: null, lastError: null
        };
        this.sessions.set(sid, s);
      } else {
        s.port = port;
        if (typeof tab?.id === 'number') s.tabId = tab.id;
        if (typeof p.site === 'string') s.site = p.site;
        if (typeof p.mode === 'string') s.mode = p.mode;
      }
      if (!this.activeSessionId && Config.isSupportedMode(s.mode)) this.activeSessionId = sid;
      return s;
    }

    _handleSessionMessage(port, msg) {
      const s = this._getOrCreateSession(port, msg);
      const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};

      switch (msg.type) {
        case 'HELLO': {
          if (typeof p.gameId === 'string') s.gameId = p.gameId;
          if (typeof msg.revision === 'number') s.revision = msg.revision;
          if (!Config.isSupportedMode(s.mode)) {
            s.status = 'disabled';
            s.lastError = { code: Config.ERROR_CODES.UNSUPPORTED_CONTEXT, message: 'Analysis restricted to AI/Analysis' };
            this._sendError(s, s.lastError.code, s.lastError.message);
          } else {
            s.lastError = null;
            s.status = this.config.enabled ? 'ready' : 'disabled';
          }
          this._sendSessionStatus(s);
          break;
        }
        case 'POSITION_CHANGED': {
          s.mode = typeof p.mode === 'string' ? p.mode : s.mode;
          if (!Config.isSupportedMode(s.mode)) {
            if (this.activeSessionId === s.sessionId) this.engine.cancelCurrentSearch();
            s.status = 'disabled';
            s.lastResult = null;
            s.lastError = { code: Config.ERROR_CODES.UNSUPPORTED_CONTEXT, message: 'Unsupported game context' };
            this._sendError(s, s.lastError.code, s.lastError.message);
            this._sendSessionStatus(s);
            return;
          }

          const gameId = typeof p.gameId === 'string' && p.gameId.trim() ? p.gameId.trim() : s.gameId || 'default-game';
          const fen = typeof p.fen === 'string' ? p.fen.trim() : '';
          if (!Config.isValidFenStructure(fen)) {
            if (this.activeSessionId === s.sessionId) this.engine.cancelCurrentSearch();
            s.status = 'error';
            s.lastError = { code: Config.ERROR_CODES.POSITION_UNCERTAIN, message: 'Invalid or uncertain FEN rejected' };
            this._sendError(s, s.lastError.code, s.lastError.message);
            this._sendSessionStatus(s);
            return;
          }

          if (s.gameId !== gameId || s.fen !== fen) {
            s.lastResult = null;
            s.lastAnalyzedFingerprint = null;
          }
          s.gameId = gameId;
          s.fen = fen;
          s.revision = typeof msg.revision === 'number' ? msg.revision : s.revision + 1;
          s.lastError = null;
          if (!this.activeSessionId) this.activeSessionId = s.sessionId;
          if (!this.config.enabled) { s.status = 'disabled'; this._sendSessionStatus(s); return; }
          if (this.activeSessionId !== s.sessionId) { s.status = 'ready'; this._sendSessionStatus(s); return; }
          this._triggerAnalysisForSession(s);
          break;
        }
        case 'GAME_ENDED': {
          if (this.activeSessionId === s.sessionId) this.engine.cancelCurrentSearch();
          s.status = this.config.enabled ? 'ready' : 'disabled';
          s.lastResult = null;
          s.lastAnalyzedFingerprint = null;
          this._sendSessionStatus(s, Config.ERROR_CODES.GAME_OVER);
          break;
        }
        case 'DISABLE_SESSION': {
          if (this.activeSessionId === s.sessionId) this.engine.cancelCurrentSearch();
          const code = typeof p.errorCode === 'string' ? p.errorCode : null;
          if (code) {
            s.status = 'error';
            s.lastError = { code, message: typeof p.message === 'string' ? p.message : `Session paused: ${code}` };
            this._sendError(s, s.lastError.code, s.lastError.message);
          } else s.status = 'disabled';
          s.lastResult = null;
          s.lastAnalyzedFingerprint = null;
          this._sendSessionStatus(s);
          break;
        }
        default: break;
      }
    }

    _triggerAnalysisForSession(s, force = false) {
      if (!s || !this.config.enabled || this.activeSessionId !== s.sessionId) return;
      if (!Config.isSupportedMode(s.mode) || !s.fen || !Config.isValidFenStructure(s.fen)) return;

      const fp = `${s.gameId || 'game'}:${s.fen}:${this.configRevision}`;
      if (!force && s.lastAnalyzedFingerprint === fp) {
        if (s.lastResult && s.lastResult.fen === s.fen) {
          this._sendEngineResult(s, { ...s.lastResult, revision: s.revision });
        }
        return;
      }
      s.lastAnalyzedFingerprint = fp;
      s.status = 'thinking';
      this._sendSessionStatus(s);
      this.engine.analyze({
        sessionId: s.sessionId, gameId: s.gameId || 'game', revision: s.revision, fen: s.fen,
        movetimeMs: this.config.movetimeMs, hashMb: this.config.hashMb, multiPv: this.config.multiPv
      });
    }

    _handleEngineResult(res) {
      if (!res || typeof res !== 'object') return;
      const s = this.sessions.get(res.sessionId);
      if (!s || this.activeSessionId !== s.sessionId || s.gameId !== res.gameId || s.revision !== res.revision || s.fen !== res.fen) {
        return;
      }
      if (res.gameOver || !res.bestMove) {
        s.status = this.config.enabled ? 'ready' : 'disabled';
        s.lastResult = null;
        this._sendSessionStatus(s, Config.ERROR_CODES.GAME_OVER);
        return;
      }
      s.status = this.config.enabled ? 'ready' : 'disabled';
      s.lastError = null;
      s.lastResult = {
        gameId: res.gameId, fen: res.fen, revision: res.revision, bestMove: res.bestMove,
        ponder: res.ponder || null, depth: res.depth, scoreCp: res.scoreCp, scoreMate: res.scoreMate,
        whiteCp: res.whiteCp, whiteMate: res.whiteMate, evalText: res.evalText
      };
      this._sendEngineResult(s, s.lastResult);
      this._sendSessionStatus(s);
    }

    _handleEngineError(err) {
      if (!err || typeof err !== 'object') return;
      if (err.disableEngine) {
        this.config = { ...this.config, enabled: false };
        if (Config) Config.saveConfig(this.config, this.config, this.storage);
      }
      const target = (err.sessionId && this.sessions.get(err.sessionId)) || (this.activeSessionId && this.sessions.get(this.activeSessionId)) || null;
      if (target) {
        target.status = 'error';
        target.lastError = { code: err.code || Config.ERROR_CODES.ENGINE_BOOT_FAILED, message: err.message || 'Engine error' };
        this._sendError(target, target.lastError.code, target.lastError.message);
        this._sendSessionStatus(target);
      }
    }

    _handleSessionDisconnect(sessionId, port) {
      const s = this.sessions.get(sessionId);
      if (!s || (port && s.port !== port)) return;
      this.sessions.delete(sessionId);
      if (this.activeSessionId === sessionId) {
        this.engine.cancelCurrentSearch();
        this.activeSessionId = null;
        for (const [cid, cand] of this.sessions.entries()) {
          if (Config.isSupportedMode(cand.mode)) {
            this.activeSessionId = cid;
            this._sendSessionStatus(cand);
            break;
          }
        }
      }
      if (this.sessions.size === 0) {
        if (this.config.keepWorkerWarmMs <= 0 || !this.config.enabled) this.engine.shutdown();
        else this.engine.scheduleIdleShutdown(this.config.keepWorkerWarmMs);
      }
      this._notifyStatusChange();
    }

    async handleRuntimeMessage(message) {
      await this._ensureConfig();
      if (!message || typeof message !== 'object') return { ok: false, error: 'Invalid message' };

      switch (message.type) {
        case 'GET_STATUS': return this.getStatusSnapshot();
        case 'SET_CONFIG': {
          const p = (message.payload && typeof message.payload === 'object' ? message.payload : message.config) || {};
          const prev = this.config;
          this.config = await Config.saveConfig(p, prev, this.storage);
          this.configRevision += 1;
          this.engine.updateConfig(this.config);

          if (!this.config.enabled) {
            this.engine.shutdown();
            for (const s of this.sessions.values()) {
              s.status = 'disabled';
              s.lastAnalyzedFingerprint = null;
              this._sendSessionStatus(s);
            }
          } else {
            for (const s of this.sessions.values()) {
              s.status = s.lastError ? 'error' : Config.isSupportedMode(s.mode) ? 'ready' : 'disabled';
              this._sendSessionStatus(s);
            }
            const active = this.activeSessionId && this.sessions.get(this.activeSessionId);
            if (active && Config.isSupportedMode(active.mode) && active.fen) {
              if (!prev.enabled || prev.movetimeMs !== this.config.movetimeMs || prev.hashMb !== this.config.hashMb) {
                this._triggerAnalysisForSession(active, true);
              }
            }
          }
          return this.getStatusSnapshot();
        }
        case 'SET_ACTIVE_TAB': {
          const p = message.payload && typeof message.payload === 'object' ? message.payload : message;
          let target = p.sessionId ? this.sessions.get(p.sessionId) : null;
          if (!target && typeof p.tabId === 'number') {
            for (const s of this.sessions.values()) {
              if (s.tabId === p.tabId) { target = s; break; }
            }
          }
          if (!target) return { ok: false, error: 'Target session not found' };
          if (this.activeSessionId !== target.sessionId) {
            const prevActive = this.activeSessionId && this.sessions.get(this.activeSessionId);
            this.engine.cancelCurrentSearch();
            this.activeSessionId = target.sessionId;
            if (prevActive) {
              prevActive.status = this.config.enabled ? 'ready' : 'disabled';
              this._sendSessionStatus(prevActive);
            }
            if (this.config.enabled && Config.isSupportedMode(target.mode) && target.fen) {
              this._triggerAnalysisForSession(target, true);
            } else {
              this._sendSessionStatus(target);
            }
          }
          return this.getStatusSnapshot();
        }
        default: return { ok: false, error: `Unknown message type: ${message.type}` };
      }
    }

    getStatusSnapshot() {
      const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) || null : null;
      const sessions = [];
      for (const s of this.sessions.values()) {
        sessions.push({
          sessionId: s.sessionId, tabId: s.tabId, site: s.site, mode: s.mode, gameId: s.gameId,
          status: s.status, isActive: s.sessionId === this.activeSessionId,
          hasPosition: Boolean(s.fen), lastResult: s.lastResult, lastError: s.lastError
        });
      }
      return {
        ok: true, config: { ...this.config }, engineState: this.engine.state,
        activeWorkerCount: this.engine.getActiveWorkerCount(),
        activeSessionId: this.activeSessionId,
        activeSession: active ? {
          sessionId: active.sessionId, tabId: active.tabId, site: active.site, mode: active.mode,
          gameId: active.gameId, revision: active.revision, fen: active.fen, status: active.status,
          lastResult: active.lastResult, lastError: active.lastError
        } : null,
        sessions
      };
    }

    _sendSessionStatus(s, reason = null) {
      if (!s || !s.port) return;
      this._safePost(s.port, {
        type: 'SESSION_STATUS', v: Config.PROTOCOL_VERSION, sessionId: s.sessionId, revision: s.revision,
        payload: {
          status: s.status, isActiveSession: this.activeSessionId === s.sessionId, reason,
          configRevision: this.configRevision,
          config: {
            autoPlay: this.config.autoPlay,
            enabled: this.config.enabled, movetimeMs: this.config.movetimeMs, hashMb: this.config.hashMb,
            showArrow: this.config.showArrow, showEval: this.config.showEval
          }
        }
      });
      this._notifyStatusChange();
    }

    _notifyStatusChange() {
      if (this.onStatusChange) {
        try { this.onStatusChange(this.getStatusSnapshot()); } catch (_e) {}
      }
    }

    _sendEngineResult(s, r) {
      if (!s || !s.port || !r) return;
      this._safePost(s.port, {
        type: 'ENGINE_RESULT', v: Config.PROTOCOL_VERSION, sessionId: s.sessionId, revision: r.revision,
        payload: {
          gameId: r.gameId, fen: r.fen, bestMove: r.bestMove, ponder: r.ponder, depth: r.depth,
          scoreCp: r.scoreCp, scoreMate: r.scoreMate, whiteCp: r.whiteCp, whiteMate: r.whiteMate, evalText: r.evalText
        }
      });
    }

    _sendError(s, code, message) {
      if (!s || !s.port) return;
      this._safePost(s.port, {
        type: 'ERROR', v: Config.PROTOCOL_VERSION, sessionId: s.sessionId, revision: s.revision,
        payload: { code, message }
      });
    }

    _safePost(port, msg) { try { port.postMessage(msg); } catch (_e) {} }
  }

  const KnightSessions = { isValidProtocolMessage, SessionController };
  root.KnightSessions = KnightSessions;
  if (typeof module !== 'undefined' && module.exports) module.exports = KnightSessions;
})(typeof globalThis !== 'undefined' ? globalThis : this);
