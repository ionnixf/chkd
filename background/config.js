(function (root) {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const PORT_NAME = 'knight:session';
  const STORAGE_KEY = 'knight_config';
  const ALLOWED_MOVETIMES = Object.freeze([100, 300, 1000]);
  const ALLOWED_HASH_MB = Object.freeze([8, 16, 32]);
  const SUPPORTED_MODES = Object.freeze(['ai', 'analysis', 'human', 'unknown']);

  const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    autoPlay: false,
    movetimeMs: 300,
    hashMb: 16,
    multiPv: 1,
    showArrow: true,
    showEval: true,
    keepWorkerWarmMs: 30000
  });

  const ERROR_CODES = Object.freeze({
    NO_PERMISSION: 'NO_PERMISSION',
    UNSUPPORTED_CONTEXT: 'UNSUPPORTED_CONTEXT',
    BOARD_NOT_FOUND: 'BOARD_NOT_FOUND',
    POSITION_UNCERTAIN: 'POSITION_UNCERTAIN',
    ENGINE_BOOT_FAILED: 'ENGINE_BOOT_FAILED',
    ENGINE_TIMEOUT: 'ENGINE_TIMEOUT',
    STALE_RESULT: 'STALE_RESULT',
    SESSION_CLOSED: 'SESSION_CLOSED',
    GAME_OVER: 'GAME_OVER'
  });

  function sanitizeConfig(partial, base = DEFAULT_CONFIG) {
    const b = base && typeof base === 'object' ? base : DEFAULT_CONFIG;
    const s = partial && typeof partial === 'object' ? partial : {};
    const mt = Number(s.movetimeMs);
    const hash = Number(s.hashMb);
    const validWarm = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 300000;
    return {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : Boolean(b.enabled),
      autoPlay: typeof s.autoPlay === 'boolean' ? s.autoPlay : b.autoPlay === true,
      movetimeMs: ALLOWED_MOVETIMES.includes(mt) ? mt : ALLOWED_MOVETIMES.includes(b.movetimeMs) ? b.movetimeMs : DEFAULT_CONFIG.movetimeMs,
      hashMb: ALLOWED_HASH_MB.includes(hash) ? hash : ALLOWED_HASH_MB.includes(b.hashMb) ? b.hashMb : DEFAULT_CONFIG.hashMb,
      multiPv: DEFAULT_CONFIG.multiPv,
      showArrow: typeof s.showArrow === 'boolean' ? s.showArrow : b.showArrow !== false,
      showEval: typeof s.showEval === 'boolean' ? s.showEval : b.showEval !== false,
      keepWorkerWarmMs: Math.floor(validWarm(s.keepWorkerWarmMs) ? s.keepWorkerWarmMs : validWarm(b.keepWorkerWarmMs) ? b.keepWorkerWarmMs : DEFAULT_CONFIG.keepWorkerWarmMs)
    };
  }

  function isValidFenStructure(fen) {
    if (typeof fen !== 'string') return false;
    const t = fen.trim();
    if (t.length < 15 || t.length > 120) return false;
    const parts = t.split(/\s+/);
    if (parts.length !== 6) return false;
    const [placement, turn, castling, ep, half, full] = parts;
    if ((turn !== 'w' && turn !== 'b') || (castling !== '-' && !/^(?!$)K?Q?k?q?$/.test(castling))) return false;
    if (ep !== '-' && (!/^[a-h][36]$/.test(ep) || (turn === 'w' ? ep[1] !== '6' : ep[1] !== '3'))) return false;
    if (!/^\d{1,3}$/.test(half) || !/^[1-9]\d{0,3}$/.test(full)) return false;

    const ranks = placement.split('/');
    if (ranks.length !== 8) return false;
    let wK = 0, bK = 0;
    for (let r = 0; r < 8; r++) {
      const rank = ranks[r];
      if (!rank || rank.length > 8) return false;
      let files = 0, prevDigit = false;
      for (let i = 0; i < rank.length; i++) {
        const c = rank[i];
        if (c >= '1' && c <= '8') {
          if (prevDigit) return false;
          files += c.charCodeAt(0) - 48;
          prevDigit = true;
        } else if ('pnbrqkPNBRQK'.includes(c)) {
          prevDigit = false;
          files++;
          if (c === 'K') wK++;
          else if (c === 'k') bK++;
          else if ((r === 0 || r === 7) && (c === 'P' || c === 'p')) return false;
        } else return false;
      }
      if (files !== 8) return false;
    }
    return wK === 1 && bK === 1;
  }

  const isSupportedMode = (mode) => SUPPORTED_MODES.includes(mode);
  const getStorage = (custom) => custom || ((root.browser || root.chrome)?.storage?.local ?? null);

  async function loadConfig(customStorage) {
    const st = getStorage(customStorage);
    if (!st) return { ...DEFAULT_CONFIG };
    try {
      const raw = await st.get(null);
      if (raw && typeof raw === 'object') {
        const src = raw[STORAGE_KEY] && typeof raw[STORAGE_KEY] === 'object' ? { ...raw, ...raw[STORAGE_KEY] } : raw;
        return sanitizeConfig(src, DEFAULT_CONFIG);
      }
    } catch (_e) {}
    return { ...DEFAULT_CONFIG };
  }

  async function saveConfig(partial, current = DEFAULT_CONFIG, customStorage = null) {
    const merged = sanitizeConfig(partial, current);
    const st = getStorage(customStorage);
    if (st) {
      try { await st.set({ [STORAGE_KEY]: merged, ...merged }); } catch (_e) {}
    }
    return merged;
  }

  const KnightConfig = {
    PROTOCOL_VERSION, PORT_NAME, STORAGE_KEY, ALLOWED_MOVETIMES, ALLOWED_HASH_MB,
    SUPPORTED_MODES, DEFAULT_CONFIG, ERROR_CODES, sanitizeConfig,
    isValidFenStructure, isSupportedMode, loadConfig, saveConfig
  };
  root.KnightConfig = KnightConfig;
  if (typeof module !== 'undefined' && module.exports) module.exports = KnightConfig;
})(typeof globalThis !== 'undefined' ? globalThis : this);
