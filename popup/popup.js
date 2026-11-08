(function (root) {
  'use strict';

  const SITE_LABELS = Object.freeze({ lichess: 'Lichess', chesscom: 'Chess.com' });
  const MODE_LABELS = Object.freeze({
    ai: 'AI',
    analysis: 'Analysis',
    human: 'Human',
    unknown: 'Unknown'
  });
  const STATUS_LABELS = Object.freeze({
    disabled: 'Disabled',
    ready: 'Ready',
    thinking: 'Thinking...',
    error: 'Error'
  });

  function formatSiteAndMode(session) {
    if (!session) return 'No active board';
    const site = SITE_LABELS[session.site] || session.site || 'Unknown';
    const mode = MODE_LABELS[session.mode] || session.mode || 'Unknown';
    return `${site} / ${mode}`;
  }

  function getEvaluationView(result) {
    if (!result) return null;
    const mate = result.whiteMate;
    if (Number.isFinite(mate)) {
      if (mate === 0) return null; // UCI mate zero alone does not identify the winner.
      return { whitePercent: mate > 0 ? 100 : 0, lead: mate > 0 ? 'white' : 'black', text: `M${Math.abs(mate)}`,
        label: `${mate > 0 ? 'White' : 'Black'} mates in ${Math.abs(mate)}` };
    }
    const cp = Number.isFinite(result.whiteCp) ? result.whiteCp
      : /^[+-]?\d+(?:\.\d+)?$/.test(result.evalText || '') ? Number(result.evalText) * 100 : null;
    if (cp === null) return null;
    // A bounded visual scale, not a probability of winning.
    const whitePercent = 50 + 50 * Math.tanh(cp / 400);
    const score = `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`;
    const lead = cp === 0 ? 'even' : cp > 0 ? 'white' : 'black';
    const text = cp === 0 ? '0.00' : `+${(Math.abs(cp) / 100).toFixed(2)}`;
    return { whitePercent, lead, text, label: cp === 0 ? 'Equal position' :
      `${cp > 0 ? 'White' : 'Black'} advantage, ${score}` };
  }

  class PopupController {
    constructor(options = {}) {
      this.doc = options.document || (typeof document !== 'undefined' ? document : null);
      this.ext = options.ext || root.browser || root.chrome || null;
      this.config = { enabled: false, movetimeMs: 300, hashMb: 16, showArrow: true, showEval: true };
      this.lastHasPermission = true;
      this.updateQueue = Promise.resolve();
    }

    async init() {
      if (!this.doc) return;
      this._bindElements();
      this._bindEvents();
      await this.refresh();
    }

    _bindElements() {
      this.toggleBtn = this.doc.getElementById('toggle-enabled');
      this.logoMark = this.doc.getElementById('logo-mark');
      this.siteValue = this.doc.getElementById('site-value');
      this.statusValue = this.doc.getElementById('status-value');
      this.bestValue = this.doc.getElementById('best-value');
      this.depthValue = this.doc.getElementById('depth-value');
      this.evalBar = this.doc.getElementById('eval-bar');
      this.evalWhite = this.doc.getElementById('eval-white');
      this.evalText = this.doc.getElementById('eval-text');
      this.errorBanner = this.doc.getElementById('error-banner');
      this.movetimeGroup = this.doc.getElementById('movetime-group');
      this.hashGroup = this.doc.getElementById('hash-group');
      this.autoPlayCheckbox = this.doc.getElementById('auto-play');
      this.showEvalCheckbox = this.doc.getElementById('show-eval');
      this.showArrowCheckbox = this.doc.getElementById('show-arrow');
      this.choiceGroups = [
        { element: this.movetimeGroup, attribute: 'data-movetime', key: 'movetimeMs' },
        { element: this.hashGroup, attribute: 'data-hash', key: 'hashMb' }
      ].map(group => ({ ...group, buttons: Array.from(group.element?.querySelectorAll(`[${group.attribute}]`) || []) }));
    }

    _bindEvents() {
      if (this.toggleBtn) {
        this.toggleBtn.addEventListener('click', () => this.updateConfig(config => ({ enabled: !config.enabled })));
      }
      for (const group of this.choiceGroups) {
        for (const button of group.buttons) {
          button.addEventListener('click', () => {
            this.updateConfig({ [group.key]: Number(button.getAttribute(group.attribute)) });
          });
        }
      }
      this.autoPlayCheckbox?.addEventListener('change', () => {
        this.updateConfig({ autoPlay: Boolean(this.autoPlayCheckbox.checked) });
      });
      if (this.showEvalCheckbox) {
        this.showEvalCheckbox.addEventListener('change', () => {
          this.updateConfig({ showEval: Boolean(this.showEvalCheckbox.checked) });
        });
      }
      if (this.showArrowCheckbox) {
        this.showArrowCheckbox.addEventListener('change', () => {
          this.updateConfig({ showArrow: Boolean(this.showArrowCheckbox.checked) });
        });
      }
      if (this.ext?.runtime?.onMessage && typeof this.ext.runtime.onMessage.addListener === 'function') {
        this.ext.runtime.onMessage.addListener((msg) => {
          if (msg && msg.type === 'STATUS_UPDATED' && msg.snapshot) {
            this.render(msg.snapshot, this.lastHasPermission);
          }
        });
      }
    }

    async _checkHostPermissions() {
      if (!this.ext || !this.ext.permissions || typeof this.ext.permissions.contains !== 'function') {
        return true;
      }
      try {
        const cc = await this.ext.permissions.contains({ origins: ['https://www.chess.com/*'] });
        const li = await this.ext.permissions.contains({ origins: ['https://lichess.org/*'] });
        return Boolean(cc || li);
      } catch (_e) {
        return true;
      }
    }

    async _sendMessage(msg) {
      if (!this.ext || !this.ext.runtime || typeof this.ext.runtime.sendMessage !== 'function') return null;
      try { return await this.ext.runtime.sendMessage(msg); } catch (_e) { return null; }
    }

    async _syncActiveTab() {
      const tabs = this.ext && this.ext.tabs;
      if (!tabs || typeof tabs.query !== 'function') return;
      try {
        const [tab] = await tabs.query({ active: true, currentWindow: true });
        if (tab && typeof tab.id === 'number') {
          await this._sendMessage({ type: 'SET_ACTIVE_TAB', payload: { tabId: tab.id } });
        }
      } catch (_e) {}
    }

    async refresh() {
      const hasPerm = await this._checkHostPermissions();
      this.lastHasPermission = hasPerm;
      if (hasPerm) await this._syncActiveTab();
      const snap = await this._sendMessage({ type: 'GET_STATUS' });
      this.render(snap, hasPerm);
      return snap;
    }

    updateConfig(partial) {
      // Serialize writes so fast clicks cannot overwrite a previous choice.
      const update = this.updateQueue.then(async () => {
        const patch = typeof partial === 'function' ? partial(this.config) : partial;
        const hasPerm = await this._checkHostPermissions();
        this.lastHasPermission = hasPerm;
        if (!hasPerm && patch?.enabled) {
          this.render(null, false);
          return null;
        }
        if (Object.keys(patch).every(key => patch[key] === this.config[key])) return null;
        const snap = await this._sendMessage({ type: 'SET_CONFIG', payload: patch });
        if (snap?.ok !== false && snap?.config) this.render(snap, hasPerm);
        return snap;
      });
      this.updateQueue = update.catch(() => {});
      return update;
    }

    render(snapshot, hasPermission = true) {
      if (!this.doc) return;
      if (snapshot && snapshot.config) this.config = { ...this.config, ...snapshot.config };

      if (this.toggleBtn) {
        const on = Boolean(this.config.enabled);
        this.toggleBtn.textContent = on ? 'ON' : 'OFF';
        this.toggleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        this.toggleBtn.classList.toggle('on', on);
      }
      if (this.logoMark) this.logoMark.setAttribute('data-state',
        !this.config.enabled ? 'off' : this.config.autoPlay ? 'auto' : 'on');
      for (const group of this.choiceGroups || []) {
        for (const button of group.buttons) {
          const selected = Number(button.getAttribute(group.attribute)) === this.config[group.key];
          button.classList.toggle('active', selected);
          button.setAttribute('aria-pressed', String(selected));
        }
      }
      if (this.autoPlayCheckbox) this.autoPlayCheckbox.checked = Boolean(this.config.autoPlay);
      if (this.showEvalCheckbox) this.showEvalCheckbox.checked = Boolean(this.config.showEval);
      if (this.showArrowCheckbox) this.showArrowCheckbox.checked = Boolean(this.config.showArrow);

      if (this.evalBar) this.evalBar.hidden = true;

      if (!hasPermission) {
        if (this.siteValue) {
          this.siteValue.textContent = 'No permission';
          this.siteValue.setAttribute('data-site', 'none');
        }
        if (this.statusValue) this.statusValue.textContent = 'NO_PERMISSION';
        if (this.bestValue) this.bestValue.textContent = '—';
        if (this.depthValue) this.depthValue.textContent = '—';
        if (this.errorBanner) {
          this.errorBanner.hidden = false;
          this.errorBanner.textContent =
            'NO_PERMISSION: Grant host access for Chess.com / Lichess in Firefox Add-ons Manager.';
        }
        return;
      }

      const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
      const active = snapshot?.activeSession || (sessions.length === 1 ? sessions[0] : null);
      if (this.siteValue) {
        this.siteValue.textContent = formatSiteAndMode(active);
        this.siteValue.setAttribute('data-site', active && SITE_LABELS[active.site] ? active.site : 'none');
      }
      if (this.statusValue) {
        this.statusValue.textContent = !this.config.enabled
          ? 'Disabled'
          : !active
            ? 'Idle'
            : STATUS_LABELS[active.status] || active.status || 'Ready';
      }

      const res = active && !active.lastError && active.status !== 'error' ? active.lastResult : null;
      const fresh = this.config.enabled && this.config.showEval ? getEvaluationView(res) : null;
      // Keep the bar visible between moves: show the last known score (dimmed) until a new one arrives.
      const sessionKey = active ? active.sessionId : null;
      if (sessionKey !== this.evalSessionKey) { this.lastEvaluation = null; this.evalSessionKey = sessionKey; }
      const barWanted = Boolean(this.config.enabled && this.config.showEval && active && !active.lastError);
      if (fresh) this.lastEvaluation = fresh;
      else if (!barWanted) this.lastEvaluation = null;
      const evaluation = fresh || (barWanted
        ? this.lastEvaluation || { whitePercent: 50, lead: 'even', text: '—', label: 'Waiting for analysis' }
        : null);
      if (this.evalBar) this.evalBar.classList.toggle('stale', Boolean(evaluation && !fresh));
      if (this.evalBar && this.evalWhite && evaluation) {
        this.evalBar.hidden = false;
        this.evalWhite.style.width = `${evaluation.whitePercent}%`;
        if (this.evalText) {
          this.evalText.textContent = evaluation.text;
          this.evalText.setAttribute('data-lead', evaluation.lead);
        }
        this.evalBar.setAttribute('aria-valuenow', String(Math.round(evaluation.whitePercent)));
        this.evalBar.setAttribute('aria-valuetext', evaluation.label);
        this.evalBar.title = evaluation.label;
      }

      if (this.bestValue) {
        if (this.config.enabled && res && res.bestMove) {
          const ev = this.config.showEval && res.evalText ? ` (${res.evalText})` : '';
          this.bestValue.textContent = `${res.bestMove}${ev}`;
        } else {
          this.bestValue.textContent = '—';
        }
      }
      if (this.depthValue) {
        this.depthValue.textContent = this.config.enabled && res && res.depth ? String(res.depth) : '—';
      }

      if (this.errorBanner) {
        const err = active && active.lastError ? active.lastError : null;
        if (err && err.code) {
          this.errorBanner.hidden = false;
          this.errorBanner.textContent = `${err.code}: ${err.message || ''}`;
        } else {
          this.errorBanner.hidden = true;
          this.errorBanner.textContent = '';
        }
      }
    }
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__KNIGHT_DISABLE_AUTO_BOOT__) {
    const popup = new PopupController();
    popup.init();
  }

  const KnightPopup = { formatSiteAndMode, getEvaluationView, PopupController };
  root.KnightPopup = KnightPopup;
  if (typeof module !== 'undefined' && module.exports) module.exports = KnightPopup;
})(typeof globalThis !== 'undefined' ? globalThis : this);
