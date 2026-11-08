(function (root) {
  'use strict';

  const Config = root.KnightConfig || (typeof require === 'function' ? require('./config.js') : null);
  const ENGINE_STATES = Object.freeze({
    STOPPED: 'STOPPED', BOOTING: 'BOOTING', READY: 'READY', SEARCHING: 'SEARCHING', STOPPING: 'STOPPING'
  });

  class LruCache {
    constructor(maxEntries = 32) {
      this.maxEntries = maxEntries;
      this.map = new Map();
    }
    get(key) {
      if (!this.map.has(key)) return null;
      const val = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, val);
      return val;
    }
    set(key, val) {
      if (this.maxEntries <= 0) return;
      if (this.map.has(key)) this.map.delete(key);
      else if (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value);
      this.map.set(key, val);
    }
    clear() { this.map.clear(); }
    get size() { return this.map.size; }
  }

  function formatWhiteEval(whiteCp, whiteMate) {
    if (typeof whiteMate === 'number' && Number.isFinite(whiteMate)) {
      return whiteMate === 0 ? 'M0' : (whiteMate > 0 ? '+M' : '-M') + Math.abs(whiteMate);
    }
    if (typeof whiteCp === 'number' && Number.isFinite(whiteCp)) {
      return (whiteCp >= 0 ? '+' : '') + (whiteCp / 100).toFixed(2);
    }
    return '0.00';
  }

  function parseUciInfo(line, turn = 'w') {
    if (typeof line !== 'string' || !line.startsWith('info ') || line.startsWith('info string ')) return null;
    const mpv = /\bmultipv\s+(\d+)/.exec(line);
    if (mpv && Number(mpv[1]) > 1) return null;
    const dM = /\bdepth\s+(\d+)/.exec(line);
    const sdM = /\bseldepth\s+(\d+)/.exec(line);
    const cpM = /\bscore\s+cp\s+(-?\d+)/.exec(line);
    const mateM = /\bscore\s+mate\s+(-?\d+)/.exec(line);
    const pvM = /\bpv\s+([a-h][1-8][a-h][1-8][qrbnQRBN]?(?:\s+\S+)*)/.exec(line);
    if (!dM && !cpM && !mateM) return null;

    const sign = turn === 'b' ? -1 : 1;
    const scoreCp = cpM ? Number(cpM[1]) : null;
    const scoreMate = mateM ? Number(mateM[1]) : null;
    const whiteCp = scoreCp !== null ? scoreCp * sign : null;
    const whiteMate = scoreMate !== null ? scoreMate * sign : null;
    return {
      depth: dM ? Number(dM[1]) : null,
      seldepth: sdM ? Number(sdM[1]) : null,
      scoreCp, scoreMate, whiteCp, whiteMate,
      evalText: scoreCp !== null || scoreMate !== null ? formatWhiteEval(whiteCp, whiteMate) : null,
      pv: pvM ? pvM[1].trim() : null
    };
  }

  function parseUciBestMove(line) {
    if (typeof line !== 'string' || !line.trim().startsWith('bestmove ')) return null;
    const parts = line.trim().split(/\s+/);
    const rawMove = parts[1] || '';
    const pIdx = parts.indexOf('ponder');
    const rawPonder = pIdx !== -1 && parts[pIdx + 1] ? parts[pIdx + 1] : null;
    if (!rawMove || rawMove === '(none)' || rawMove === '0000') {
      return { bestMove: null, rawBestMove: rawMove || '(none)', ponder: null, isNone: true };
    }
    const norm = rawMove.toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(norm)) {
      return { bestMove: null, rawBestMove: rawMove, ponder: null, isNone: true, invalidFormat: true };
    }
    const ponder = rawPonder && /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(rawPonder) ? rawPonder.toLowerCase() : null;
    return { bestMove: norm, rawBestMove: rawMove, ponder, isNone: false };
  }

  class EngineController {
    constructor(options = {}) {
      this.config = Config ? Config.sanitizeConfig(options.config) : { ...options.config };
      this.workerFactory = options.workerFactory || (() => this._createDefaultWorker());
      this.onResult = typeof options.onResult === 'function' ? options.onResult : () => {};
      this.onError = typeof options.onError === 'function' ? options.onError : () => {};
      this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
      this.moveValidator = typeof options.moveValidator === 'function' ? options.moveValidator : null;
      this.bootTimeoutMs = options.bootTimeoutMs || 8000;
      this.stopTimeoutMs = options.stopTimeoutMs || 2500;
      this.searchTimeoutPaddingMs = options.searchTimeoutPaddingMs || 2500;
      this.cache = new LruCache(typeof options.cacheSize === 'number' ? options.cacheSize : 32);

      this.state = ENGINE_STATES.STOPPED;
      this.worker = null;
      this.workerCount = 0;
      this.bootRetries = 0;
      this.bootStage = null;
      this._configuringOptions = false;
      this.appliedHashMb = null;
      this.appliedMultiPv = null;
      this.activeRequest = null;
      this.stopSentForActive = false;
      this.latestPending = null;
      this.bootTimer = null;
      this.searchTimer = null;
      this.idleTimer = null;
    }

    _createDefaultWorker() {
      const ext = root.browser || root.chrome;
      const rel = 'vendor/stockfish/stockfish-19-lite-single.js';
      return new Worker(ext?.runtime?.getURL ? ext.runtime.getURL(rel) : rel);
    }

    _setState(next) {
      if (this.state !== next) {
        this.state = next;
        try { this.onStateChange(next); } catch (_e) {}
      }
    }

    _makeCacheKey(fen, mt, hash, mpv) { return `${fen}|mt:${mt}|hash:${hash}|mpv:${mpv || 1}`; }
    getActiveWorkerCount() { return this.worker ? 1 : 0; }

    updateConfig(partial) {
      const prevHash = this.config.hashMb;
      this.config = Config ? Config.sanitizeConfig(partial, this.config) : { ...this.config, ...partial };
      if (!this.config.enabled) {
        this.shutdown();
        return this.config;
      }
      if (prevHash !== this.config.hashMb) {
        this.cache.clear();
      }
      if (this.state === ENGINE_STATES.READY && !this._configuringOptions && this.worker && this.appliedHashMb !== this.config.hashMb) {
        this._syncEngineOptions(this.config.hashMb);
      }
      return this.config;
    }

    analyze(request) {
      this._clearIdleTimer();
      if (!request || typeof request !== 'object') return { accepted: false, errorCode: 'POSITION_UNCERTAIN' };
      const fen = typeof request.fen === 'string' ? request.fen.trim() : '';
      if (Config && !Config.isValidFenStructure(fen)) {
        this.onError({
          code: Config.ERROR_CODES.POSITION_UNCERTAIN,
          message: 'Invalid FEN structure rejected before engine search',
          sessionId: request.sessionId || null,
          revision: request.revision
        });
        return { accepted: false, errorCode: 'POSITION_UNCERTAIN' };
      }

      const movetimeMs = Config?.ALLOWED_MOVETIMES.includes(Number(request.movetimeMs)) ? Number(request.movetimeMs) : this.config.movetimeMs;
      const hashMb = Config?.ALLOWED_HASH_MB.includes(Number(request.hashMb)) ? Number(request.hashMb) : this.config.hashMb;
      const req = {
        sessionId: String(request.sessionId || ''),
        gameId: String(request.gameId || ''),
        revision: Number(request.revision) || 0,
        fen,
        turn: fen.split(/\s+/)[1] || 'w',
        movetimeMs, hashMb, multiPv: 1,
        bypassCache: Boolean(request.bypassCache)
      };

      if (!req.bypassCache) {
        const cached = this.cache.get(this._makeCacheKey(fen, movetimeMs, hashMb, 1));
        if (cached) {
          if (this.state === ENGINE_STATES.SEARCHING || this.state === ENGINE_STATES.STOPPING) {
            this.latestPending = null;
            this._sendStopOnce();
          }
          const payload = { ...cached, sessionId: req.sessionId, gameId: req.gameId, revision: req.revision, fen: req.fen, cached: true };
          Promise.resolve().then(() => this.onResult(payload));
          if (this.state === ENGINE_STATES.READY) this.scheduleIdleShutdown();
          return { accepted: true, cached: true };
        }
      }

      if (this.state === ENGINE_STATES.STOPPED) {
        this.latestPending = req;
        this._boot();
        return { accepted: true, queued: true };
      }
      if (this.state === ENGINE_STATES.BOOTING || this.state === ENGINE_STATES.STOPPING) {
        this.latestPending = req;
        return { accepted: true, queued: true };
      }
      if (this.state === ENGINE_STATES.READY) {
        if (this._configuringOptions) {
          this.latestPending = req;
          return { accepted: true, queued: true };
        }
        this._startSearch(req);
        return { accepted: true, started: true };
      }
      if (this.state === ENGINE_STATES.SEARCHING) {
        this.latestPending = req;
        this._sendStopOnce();
        return { accepted: true, queued: true };
      }
      return { accepted: false };
    }

    cancelCurrentSearch() {
      this.latestPending = null;
      if (this.state === ENGINE_STATES.SEARCHING) this._sendStopOnce();
      else if (this.state === ENGINE_STATES.STOPPING && this.activeRequest) this.activeRequest.cancelled = true;
      else if (this.state === ENGINE_STATES.READY && !this._configuringOptions) this.scheduleIdleShutdown();
    }

    _sendStopOnce() {
      if (this.activeRequest) this.activeRequest.cancelled = true;
      if (this.state === ENGINE_STATES.SEARCHING && !this.stopSentForActive) {
        this.stopSentForActive = true;
        this._setState(ENGINE_STATES.STOPPING);
        this._clearSearchTimer();
        this.searchTimer = setTimeout(() => this._handleWatchdogTimeout(), this.stopTimeoutMs);
        this._post('stop');
      }
    }

    _boot() {
      if (this.worker || this.state !== ENGINE_STATES.STOPPED) return;
      this._clearBootTimer();
      this._clearSearchTimer();
      this._clearIdleTimer();
      this._setState(ENGINE_STATES.BOOTING);
      this.bootStage = 'WAIT_UCIOK';
      this._configuringOptions = false;
      this.appliedHashMb = null;
      this.appliedMultiPv = null;
      this.bootTimer = setTimeout(() => this._handleBootFailure('UCI boot timeout'), this.bootTimeoutMs);

      try {
        const w = this.workerFactory();
        this.worker = w;
        this.workerCount = 1;
        const onMsg = (ev) => {
          if (this.worker === w) this._handleWorkerOutput(ev && typeof ev === 'object' && 'data' in ev ? ev.data : ev);
        };
        const onErr = (err) => {
          if (this.worker !== w) return;
          if (this.state === ENGINE_STATES.BOOTING) this._handleBootFailure(err?.message || 'Worker boot error');
          else this._handleWatchdogTimeout();
        };
        if (typeof w.addEventListener === 'function') {
          w.addEventListener('message', onMsg);
          w.addEventListener('error', onErr);
        } else {
          w.onmessage = onMsg;
          w.onerror = onErr;
        }
        this._post('uci');
      } catch (err) {
        this._handleBootFailure(err?.message || 'Failed to create Worker');
      }
    }

    _handleBootFailure(reason) {
      this._clearBootTimer();
      this._terminateWorkerOnly();
      this._setState(ENGINE_STATES.STOPPED);
      if (this.bootRetries < 1) {
        this.bootRetries += 1;
        this._boot();
        return;
      }
      const failed = this.latestPending;
      this.latestPending = null;
      this.bootRetries = 0;
      this.onError({
        code: Config ? Config.ERROR_CODES.ENGINE_BOOT_FAILED : 'ENGINE_BOOT_FAILED',
        message: reason || 'Failed to initialize Stockfish Worker',
        sessionId: failed ? failed.sessionId : null,
        revision: failed ? failed.revision : null,
        disableEngine: true
      });
    }

    _syncEngineOptions(targetHashMb) {
      this._configuringOptions = true;
      const hash = Config?.ALLOWED_HASH_MB.includes(Number(targetHashMb)) ? Number(targetHashMb) : this.config.hashMb;
      this.appliedHashMb = hash;
      this.appliedMultiPv = 1;
      this._clearBootTimer();
      this.bootTimer = setTimeout(() => this._handleWatchdogTimeout(), this.bootTimeoutMs);
      this._post(`setoption name Hash value ${hash}`);
      this._post('setoption name MultiPV value 1');
      this._post('isready');
    }

    _handleWorkerOutput(raw) {
      if (typeof raw !== 'string') return;
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) this._handleWorkerLine(trimmed);
      }
    }

    _handleWorkerLine(line) {
      if (line === 'uciok') {
        if (this.state === ENGINE_STATES.BOOTING && this.bootStage === 'WAIT_UCIOK') {
          this.bootStage = 'WAIT_READYOK';
          const hash = this.latestPending ? this.latestPending.hashMb : this.config.hashMb;
          this.appliedHashMb = hash;
          this.appliedMultiPv = 1;
          this._post(`setoption name Hash value ${hash}`);
          this._post('setoption name MultiPV value 1');
          this._post('isready');
        }
        return;
      }
      if (line === 'readyok') {
        this._clearBootTimer();
        this.bootRetries = 0;
        this.bootStage = null;
        this._configuringOptions = false;
        if (this.state === ENGINE_STATES.BOOTING || this.state === ENGINE_STATES.READY) {
          this._setState(ENGINE_STATES.READY);
          this._drainPendingInReady();
        }
        return;
      }
      if (line.startsWith('info ')) {
        if (this.activeRequest && !this.activeRequest.cancelled && this.state === ENGINE_STATES.SEARCHING) {
          const p = parseUciInfo(line, this.activeRequest.turn);
          if (p) {
            const hasScoreOrPv = p.scoreCp !== null || p.scoreMate !== null || p.pv !== null;
            if (p.depth !== null && (hasScoreOrPv || !this.activeRequest.depth)) {
              this.activeRequest.depth = p.depth;
            }
            if (p.scoreCp !== null || p.scoreMate !== null) {
              Object.assign(this.activeRequest, {
                scoreCp: p.scoreCp, scoreMate: p.scoreMate, whiteCp: p.whiteCp, whiteMate: p.whiteMate, evalText: p.evalText
              });
            }
            if (p.pv !== null) this.activeRequest.pv = p.pv;
          }
        }
        return;
      }
      if (line.startsWith('bestmove ')) {
        this._clearSearchTimer();
        const completed = this.activeRequest;
        this.activeRequest = null;
        this.stopSentForActive = false;
        this._setState(ENGINE_STATES.READY);
        const parsedBest = parseUciBestMove(line);
        if (completed && !completed.cancelled && !this.latestPending && parsedBest) {
          this._emitCompletedSearch(completed, parsedBest);
        }
        this._drainPendingInReady();
      }
    }

    _emitCompletedSearch(c, parsedBest) {
      const base = {
        sessionId: c.sessionId, gameId: c.gameId, revision: c.revision, fen: c.fen,
        depth: c.depth || (parsedBest.isNone ? 0 : 1),
        scoreCp: c.scoreCp, scoreMate: c.scoreMate, whiteCp: c.whiteCp, whiteMate: c.whiteMate,
        evalText: c.evalText || '0.00'
      };
      if (parsedBest.isNone) {
        this.onResult({ ...base, bestMove: null, ponder: null, gameOver: true });
        return;
      }
      if (this.moveValidator) {
        const check = this.moveValidator(c.fen, parsedBest.bestMove);
        if (!check || !check.ok) {
          this.onError({
            code: Config ? Config.ERROR_CODES.POSITION_UNCERTAIN : 'POSITION_UNCERTAIN',
            message: `Engine returned illegal move ${parsedBest.bestMove}`,
            sessionId: c.sessionId, revision: c.revision
          });
          return;
        }
      }
      const res = { ...base, bestMove: parsedBest.bestMove, ponder: parsedBest.ponder, gameOver: false };
      this.cache.set(this._makeCacheKey(c.fen, c.movetimeMs, c.hashMb, 1), {
        bestMove: res.bestMove, ponder: res.ponder, depth: res.depth,
        scoreCp: res.scoreCp, scoreMate: res.scoreMate, whiteCp: res.whiteCp, whiteMate: res.whiteMate,
        evalText: res.evalText, gameOver: false
      });
      this.onResult(res);
    }

    _drainPendingInReady() {
      if (this.state !== ENGINE_STATES.READY || !this.worker || this._configuringOptions) return;
      const targetHash = this.latestPending ? (this.latestPending.hashMb || this.config.hashMb) : this.config.hashMb;
      if (this.appliedHashMb !== targetHash) {
        this._syncEngineOptions(targetHash);
        return;
      }
      if (this.latestPending) {
        const next = this.latestPending;
        this.latestPending = null;
        this._startSearch(next);
      } else {
        this.scheduleIdleShutdown();
      }
    }

    _startSearch(req) {
      if (!this.worker || this.state !== ENGINE_STATES.READY) {
        this.latestPending = req;
        return;
      }
      const targetHash = req.hashMb || this.config.hashMb;
      if (this.appliedHashMb !== targetHash) {
        this.latestPending = req;
        this._syncEngineOptions(targetHash);
        return;
      }
      this._clearIdleTimer();
      this._clearSearchTimer();
      this.activeRequest = {
        ...req, cancelled: false, depth: 0,
        scoreCp: null, scoreMate: null, whiteCp: null, whiteMate: null, evalText: null, pv: null
      };
      this.stopSentForActive = false;
      this._setState(ENGINE_STATES.SEARCHING);
      this.searchTimer = setTimeout(
        () => this._handleWatchdogTimeout(),
        Math.max(3000, req.movetimeMs * 3 + this.searchTimeoutPaddingMs)
      );
      this._post(`position fen ${req.fen}`);
      this._post(`go movetime ${req.movetimeMs}`);
    }

    _handleWatchdogTimeout() {
      this._clearBootTimer();
      this._clearSearchTimer();
      this._clearIdleTimer();
      const timedOut = this.activeRequest;
      this.activeRequest = null;
      this.stopSentForActive = false;
      this._configuringOptions = false;
      this._terminateWorkerOnly();
      this._setState(ENGINE_STATES.STOPPED);
      this.onError({
        code: Config ? Config.ERROR_CODES.ENGINE_TIMEOUT : 'ENGINE_TIMEOUT',
        message: 'Engine search watchdog timeout; Worker restarted',
        sessionId: timedOut ? timedOut.sessionId : null,
        revision: timedOut ? timedOut.revision : null
      });
      if (this.latestPending && this.config.enabled) this._boot();
    }

    scheduleIdleShutdown(customWarmMs) {
      this._clearIdleTimer();
      if (this.state !== ENGINE_STATES.READY || !this.worker) return;
      const warmMs = typeof customWarmMs === 'number' ? customWarmMs : this.config.keepWorkerWarmMs;
      if (warmMs <= 0) {
        this.shutdown();
        return;
      }
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.state === ENGINE_STATES.READY && !this.activeRequest && !this.latestPending) this.shutdown();
      }, warmMs);
      if (this.idleTimer && typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
    }

    shutdown() {
      this._clearBootTimer();
      this._clearSearchTimer();
      this._clearIdleTimer();
      this.latestPending = null;
      this.activeRequest = null;
      this.stopSentForActive = false;
      this._configuringOptions = false;
      this.bootStage = null;
      this._terminateWorkerOnly();
      this._setState(ENGINE_STATES.STOPPED);
    }

    _terminateWorkerOnly() {
      if (this.worker) {
        try { this.worker.terminate(); } catch (_e) {}
        this.worker = null;
        this.workerCount = 0;
      }
    }

    _post(cmd) {
      if (!this.worker) return;
      try { this.worker.postMessage(cmd); } catch (_e) { this._handleWatchdogTimeout(); }
    }

    _clearBootTimer() { if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; } }
    _clearSearchTimer() { if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; } }
    _clearIdleTimer() { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } }
  }

  const KnightEngine = {
    ENGINE_STATES, LruCache, formatWhiteEval, parseUciInfo, parseUciBestMove, EngineController
  };
  root.KnightEngine = KnightEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = KnightEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
