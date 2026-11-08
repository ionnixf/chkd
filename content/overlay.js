(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FILES = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

  function squareToCoords(square, orientation = 'white', boardWidth = 800, boardHeight = 800) {
    if (typeof square !== 'string' || !/^[a-h][1-8]$/.test(square)) return null;
    const f = FILES.indexOf(square[0]);
    const r = Number(square[1]);
    const isBlack = orientation === 'black';
    const col = isBlack ? 7 - f : f;
    const row = isBlack ? r - 1 : 8 - r;
    const sw = boardWidth / 8;
    const sh = boardHeight / 8;
    return { col, row, x: (col + 0.5) * sw, y: (row + 0.5) * sh, sqWidth: sw, sqHeight: sh };
  }

  function computeArrowGeometry(uciMove, orientation = 'white', width = 800, height = 800) {
    if (typeof uciMove !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(uciMove)) return null;
    const fromSq = uciMove.slice(0, 2).toLowerCase();
    const toSq = uciMove.slice(2, 4).toLowerCase();
    const w = width > 0 ? width : 800;
    const h = height > 0 ? height : 800;
    const from = squareToCoords(fromSq, orientation, w, h);
    const to = squareToCoords(toSq, orientation, w, h);
    if (!from || !to) return null;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return null;

    const squareSize = Math.min(from.sqWidth, from.sqHeight);
    const shorten = squareSize * 0.38;
    const baseX = to.x - (dx / dist) * shorten;
    const baseY = to.y - (dy / dist) * shorten;
    const halfHeadWidth = squareSize * 0.24;
    const round = (value) => Number(value.toFixed(2));
    return {
      fromSquare: fromSq,
      toSquare: toSq,
      orientation: orientation === 'black' ? 'black' : 'white',
      width: w,
      height: h,
      x1: Number(from.x.toFixed(2)),
      y1: Number(from.y.toFixed(2)),
      x2: Number((to.x - (dx / dist) * shorten).toFixed(2)),
      y2: Number((to.y - (dy / dist) * shorten).toFixed(2)),
      targetX: Number(to.x.toFixed(2)),
      targetY: Number(to.y.toFixed(2)),
      headPoints: [
        [round(to.x), round(to.y)],
        [round(baseX - (dy / dist) * halfHeadWidth), round(baseY + (dx / dist) * halfHeadWidth)],
        [round(baseX + (dy / dist) * halfHeadWidth), round(baseY - (dx / dist) * halfHeadWidth)]
      ],
      strokeWidth: Number((Math.min(from.sqWidth, from.sqHeight) * 0.16).toFixed(2))
    };
  }

  class BoardOverlay {
    constructor(options = {}) {
      this.doc = options.document || (typeof document !== 'undefined' ? document : null);
      this.ResizeObserverCtor =
        options.ResizeObserver || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
      this.boardRoot = null;
      this.container = null;
      this.svg = null;
      this.lineEl = null;
      this.arrowheadEl = null;
      this.originCircleEl = null;
      this.badgeEl = null;
      this.resizeObserver = null;
      this.orientation = 'white';
      this.showArrow = true;
      this.showEval = true;
      this.currentMove = null;
      this.currentResult = null;
    }

    attach(boardRoot, orientation = 'white') {
      if (!boardRoot || !this.doc) return;
      if (this.boardRoot === boardRoot && this.container && this.container.parentNode === boardRoot) {
        if (orientation && orientation !== this.orientation) this.setOrientation(orientation);
        return;
      }

      this.detach();
      this.boardRoot = boardRoot;
      this.orientation = orientation === 'black' ? 'black' : 'white';

      const container = this.doc.createElement('div');
      container.setAttribute('data-knight-overlay', 'true');
      container.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:99;overflow:hidden;';

      const svg = this.doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 800 800');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:none;';

      const circle = this.doc.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('fill', 'rgba(46, 160, 67, 0.45)');
      svg.appendChild(circle);

      const line = this.doc.createElementNS(SVG_NS, 'line');
      line.setAttribute('stroke', 'rgba(46, 160, 67, 0.88)');
      line.setAttribute('stroke-linecap', 'butt');
      svg.appendChild(line);

      // Draw the head directly: fragment-based markers can resolve against a
      // host page's <base> URL or collide with another overlay's marker ID.
      const head = this.doc.createElementNS(SVG_NS, 'polygon');
      head.setAttribute('fill', 'rgba(46, 160, 67, 0.88)');
      head.setAttribute('stroke', 'none');
      svg.appendChild(head);

      const badge = this.doc.createElement('div');
      badge.setAttribute('data-knight-badge', 'true');
      badge.style.cssText =
        'position:absolute;top:6px;right:6px;padding:3px 7px;background:rgba(10,10,10,0.92);color:#ededed;border:1px solid #242424;border-radius:0;font:600 11px/1.3 ui-monospace,Menlo,Consolas,monospace;pointer-events:none;display:none;white-space:nowrap;';

      container.appendChild(svg);
      container.appendChild(badge);

      const pos = typeof root.getComputedStyle === 'function' && boardRoot.nodeType === 1
        ? root.getComputedStyle(boardRoot).position
        : '';
      if (pos === 'static' && boardRoot.style) boardRoot.style.position = 'relative';
      boardRoot.appendChild(container);

      this.container = container;
      this.svg = svg;
      this.lineEl = line;
      this.arrowheadEl = head;
      this.originCircleEl = circle;
      this.badgeEl = badge;

      if (this.ResizeObserverCtor) {
        this.resizeObserver = new this.ResizeObserverCtor(() => this._recalculateArrow());
        try { this.resizeObserver.observe(boardRoot); } catch (_e) {}
      }
      if (this.currentResult) this.renderResult(this.currentResult);
    }

    setConfig({ showArrow, showEval } = {}) {
      if (typeof showArrow === 'boolean') this.showArrow = showArrow;
      if (typeof showEval === 'boolean') this.showEval = showEval;
      if (this.currentResult) this.renderResult(this.currentResult);
      else this._updateVisibility(false, false);
    }

    setOrientation(orientation) {
      const norm = orientation === 'black' ? 'black' : 'white';
      if (this.orientation !== norm) {
        this.orientation = norm;
        this._recalculateArrow();
      }
    }

    renderResult(result) {
      if (!result || !result.bestMove) {
        this.clear();
        return;
      }
      this.currentResult = result;
      this.currentMove = result.bestMove;
      if (!this.container) return;

      this._recalculateArrow();
      if (this.badgeEl) {
        const moveLabel = result.san || result.bestMove;
        const evalPart = this.showEval && result.evalText ? ` (${result.evalText})` : '';
        const depthPart = result.depth ? ` d${result.depth}` : '';
        const nextText = `${moveLabel}${evalPart}${depthPart}`;
        if (this.badgeEl.textContent !== nextText) this.badgeEl.textContent = nextText;
      }
      this._updateVisibility(Boolean(this.showArrow), true);
    }

    renderStatusText(text) {
      this.clearArrowOnly();
      if (!this.badgeEl) return;
      const nextText = text ? String(text) : '';
      if (this.badgeEl.textContent !== nextText) this.badgeEl.textContent = nextText;
      const nextDisp = nextText ? 'block' : 'none';
      if (this.badgeEl.style.display !== nextDisp) this.badgeEl.style.display = nextDisp;
    }

    clearArrowOnly() {
      this.currentMove = null;
      this.currentResult = null;
      if (this.svg && this.svg.style.display !== 'none') this.svg.style.display = 'none';
    }

    clear() {
      this.clearArrowOnly();
      if (this.badgeEl) {
        if (this.badgeEl.textContent !== '') this.badgeEl.textContent = '';
        if (this.badgeEl.style.display !== 'none') this.badgeEl.style.display = 'none';
      }
    }

    _recalculateArrow() {
      if (!this.svg || !this.lineEl || !this.currentMove) return;
      const rect = this.boardRoot && typeof this.boardRoot.getBoundingClientRect === 'function'
        ? this.boardRoot.getBoundingClientRect()
        : { width: 800, height: 800 };
      const w = rect && rect.width > 0 ? rect.width : 800;
      const h = rect && rect.height > 0 ? rect.height : 800;

      const geom = computeArrowGeometry(this.currentMove, this.orientation, w, h);
      if (!geom) {
        if (this.svg.style.display !== 'none') this.svg.style.display = 'none';
        return;
      }
      this.svg.setAttribute('viewBox', `0 0 ${geom.width} ${geom.height}`);
      this.lineEl.setAttribute('x1', String(geom.x1));
      this.lineEl.setAttribute('y1', String(geom.y1));
      this.lineEl.setAttribute('x2', String(geom.x2));
      this.lineEl.setAttribute('y2', String(geom.y2));
      this.lineEl.setAttribute('stroke-width', String(geom.strokeWidth));
      if (this.arrowheadEl) {
        this.arrowheadEl.setAttribute('points', geom.headPoints.map(point => point.join(',')).join(' '));
      }
      if (this.originCircleEl) {
        this.originCircleEl.setAttribute('cx', String(geom.x1));
        this.originCircleEl.setAttribute('cy', String(geom.y1));
        this.originCircleEl.setAttribute('r', String(geom.strokeWidth * 0.75));
      }
    }

    _updateVisibility(arrowVisible, badgeVisible) {
      if (this.svg) {
        const nextSvg = arrowVisible && this.currentMove ? 'block' : 'none';
        if (this.svg.style.display !== nextSvg) this.svg.style.display = nextSvg;
      }
      if (this.badgeEl) {
        const nextBadge = badgeVisible && this.badgeEl.textContent ? 'block' : 'none';
        if (this.badgeEl.style.display !== nextBadge) this.badgeEl.style.display = nextBadge;
      }
    }

    detach() {
      this.clear();
      if (this.resizeObserver) {
        try { this.resizeObserver.disconnect(); } catch (_e) {}
        this.resizeObserver = null;
      }
      if (this.container && this.container.parentNode) {
        try { this.container.parentNode.removeChild(this.container); } catch (_e) {}
      }
      this.boardRoot = null;
      this.container = null;
      this.svg = null;
      this.lineEl = null;
      this.arrowheadEl = null;
      this.originCircleEl = null;
      this.badgeEl = null;
    }
  }

  const KnightOverlay = { squareToCoords, computeArrowGeometry, BoardOverlay };
  root.KnightOverlay = KnightOverlay;
  if (typeof module !== 'undefined' && module.exports) module.exports = KnightOverlay;
})(typeof globalThis !== 'undefined' ? globalThis : this);
