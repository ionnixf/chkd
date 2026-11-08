(function (root) {
  'use strict';

  const SessionsMod = root.KnightSessions || (typeof require === 'function' ? require('./sessions.js') : null);

  const AutoPlay = root.KnightAutoPlay || (typeof require === 'function' ? require('./autoplay.js') : null);
  const Position = root.KnightPosition || (typeof require === 'function' ? require('../content/position.js') : null);

  function createBackgroundApp(options = {}) {
    const ext = options.ext || root.browser || root.chrome;
    const controller = new SessionsMod.SessionController({
      onStatusChange: (snapshot) => {
        try {
          const p = ext?.runtime?.sendMessage?.({ type: 'STATUS_UPDATED', snapshot });
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_e) {}
      },
      ...options
    });

    // Toolbar icon mirrors the mode: white when off, green when analysis is on, red when Auto move is on.
    const applyIcon = (config) => {
      try {
        const suffix = !config || !config.enabled ? 'icon-' : config.autoPlay ? 'icon-auto-' : 'icon-on-';
        const action = ext?.action || ext?.browserAction;
        const p = action?.setIcon?.({ path: { 48: `icons/${suffix}48.png`, 96: `icons/${suffix}96.png` } });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_e) {}
    };

    if (ext && ext.runtime) {
      if (ext.runtime.onConnect && typeof ext.runtime.onConnect.addListener === 'function') {
        ext.runtime.onConnect.addListener((port) => controller.handlePortConnect(port));
      }
      const handleMessage = async (message, sender) => {
        if (!['EXECUTE_MOVE', 'GET_PLAYER_COLOR'].includes(message?.type)) return controller.handleRuntimeMessage(message, sender);
        const session = controller.sessions.get(message.sessionId);
        const request = message.payload;
        if (!session || session.tabId !== sender?.tab?.id || controller.activeSessionId !== session.sessionId ||
            !controller.config.enabled || !controller.config.autoPlay || !request) {
          return { ok: false, error: 'Auto move is disabled or session is inactive' };
        }
        if (request.fen !== session.fen || message.revision !== session.revision || request.gameId !== session.gameId) {
          return { ok: false, errorCode: 'POSITION_CHANGED', error: 'Position changed' };
        }
        if (message.type === 'EXECUTE_MOVE' &&
            (request.uci !== session.lastResult?.bestMove || !Position.validateUciMove(request.fen, request.uci).ok)) {
          return { ok: false, error: 'Move is not the current legal engine result' };
        }
        try {
          const results = await ext.scripting.executeScript({ target: { tabId: session.tabId }, world: 'MAIN',
            func: AutoPlay.executeOnPage, args: [{ ...request, readColor: message.type === 'GET_PLAYER_COLOR' }] });
          const result = results[0];
          if (result?.result?.errorCode === 'POSITION_CHANGED') return { ok: false, ...result.result };
          if (message.type === 'GET_PLAYER_COLOR' && !result?.error) {
            return { ok: true, color: ['white', 'black'].includes(result?.result?.color) ? result.result.color : null,
              error: result?.result?.error || null };
          }
          if (result?.error || !result?.result?.dispatched) throw new Error(result?.error?.message || 'Move was not dispatched');
          return { ok: true };
        } catch (error) { return { ok: false, error: error.message || 'Move execution failed' }; }
      };
      if (ext.runtime.onMessage && typeof ext.runtime.onMessage.addListener === 'function') {
        const handle = async (message, sender) => {
          const res = await handleMessage(message, sender);
          if (message && message.type === 'SET_CONFIG') applyIcon(controller.config);
          return res;
        };
        ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (root.browser && ext === root.browser) {
            return handle(message, sender);
          }
          (async () => {
            try {
              const res = await handle(message, sender);
              if (typeof sendResponse === 'function') sendResponse(res);
            } catch (err) {
              if (typeof sendResponse === 'function') {
                sendResponse({ ok: false, error: err && err.message ? err.message : 'Internal error' });
              }
            }
          })();
          return true;
        });
      }
      if (ext.runtime.onSuspend && typeof ext.runtime.onSuspend.addListener === 'function') {
        ext.runtime.onSuspend.addListener(() => controller.engine.shutdown());
      }
    }

    // Follow the focused browser tab: switching to a chess tab makes its board the analyzed one.
    const switchToTab = (tabId) => {
      if (typeof tabId !== 'number') return;
      controller.handleRuntimeMessage({ type: 'SET_ACTIVE_TAB', payload: { tabId } }).catch(() => {});
    };
    if (ext && ext.tabs && ext.tabs.onActivated && typeof ext.tabs.onActivated.addListener === 'function') {
      ext.tabs.onActivated.addListener((info) => switchToTab(info && info.tabId));
    }
    if (ext && ext.windows && ext.windows.onFocusChanged && typeof ext.windows.onFocusChanged.addListener === 'function'
      && ext.tabs && typeof ext.tabs.query === 'function') {
      ext.windows.onFocusChanged.addListener(async (windowId) => {
        if (windowId === ext.windows.WINDOW_ID_NONE) return;
        try {
          const [tab] = await ext.tabs.query({ active: true, windowId });
          if (tab) switchToTab(tab.id);
        } catch (_e) {}
      });
    }

    // Keep the icon in sync with any config write (storage is the source of truth) and on browser start.
    const storageEvents = ext && ext.storage && ext.storage.onChanged;
    if (storageEvents && typeof storageEvents.addListener === 'function') {
      storageEvents.addListener(() => setTimeout(() => applyIcon(controller.config), 50));
    }
    ['onStartup', 'onInstalled'].forEach((name) => {
      const event = ext && ext.runtime && ext.runtime[name];
      if (event && typeof event.addListener === 'function') {
        event.addListener(() => controller.init().then((cfg) => applyIcon(cfg)).catch(() => {}));
      }
    });

    controller.init().then((cfg) => applyIcon(cfg)).catch(() => {});
    return controller;
  }

  let defaultController = null;
  if (
    typeof globalThis !== 'undefined' &&
    (globalThis.browser || globalThis.chrome) &&
    !globalThis.__KNIGHT_DISABLE_AUTO_BOOT__
  ) {
    defaultController = createBackgroundApp();
  }

  const KnightBackground = { createBackgroundApp, getDefaultController: () => defaultController };
  root.KnightBackground = KnightBackground;
  if (typeof module !== 'undefined' && module.exports) module.exports = KnightBackground;
})(typeof globalThis !== 'undefined' ? globalThis : this);
