(function (root) {
  'use strict';

  // Serialized by scripting.executeScript into the page's own JS world.
  async function executeOnPage(request) {
    const stale = () => ({ dispatched: false, errorCode: 'POSITION_CHANGED', error: 'Position changed' });
    const { uci, token, orientation } = request;
    const host = location.hostname.toLowerCase();
    const lichess = /(^|\.)lichess\.org$/.test(host);
    const board = lichess
      ? document.querySelector('.main-board cg-board') || document.querySelector('.analyse__board cg-board') || document.querySelector('cg-board')
      : document.querySelector('wc-chess-board') || document.querySelector('chess-board');
    const normalizeColor = value => value === 1 || value === 'white' || value === 'w' ? 'white'
      : value === 2 || value === 'black' || value === 'b' ? 'black' : null;
    const round = lichess ? window.__KNIGHT_LICHESS_BRIDGE__?.round : null;
    const ground = round?.chessground || (lichess && typeof window.lichess?.chessground === 'function' ? window.lichess.chessground() : null);
    // Playing side is independent of the current turn and the camera orientation.
    // Analysis/spectator boards have no assigned player; never infer a side there.
    const color = lichess
      ? (round ? (round.data?.player?.spectator ? null : normalizeColor(round.data?.player?.color))
        : window.lichess?.analysis || ground?.state?.viewOnly ? null : normalizeColor(ground?.state?.movable?.color))
      : normalizeColor(board?.game?.getPlayingAs?.());
    if (request.readColor) return { color,
      error: lichess && !round && !ground ? 'Lichess game bridge is not ready. Reload the game tab after reloading the extension.' : null };
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Invalid move');
    if (!color) throw new Error('Playing side is not available on this board');
    if (request.fen?.split(/\s+/)[1] !== color[0]) throw new Error('Waiting for your turn');
    if (!board || board.getAttribute('data-knight-move-token') !== token) return stale();
    board.setAttribute('data-knight-move-running', token);
    board.removeAttribute('data-knight-move-token');
    const from = uci.slice(0, 2), to = uci.slice(2, 4), promotion = uci[4];
    if (/(^|\.)lichess\.org$/.test(host)) {
      if (round) {
        if (!round.canMove?.()) return stale();
        const actual = round.stepAt?.(round.ply)?.fen;
        // Live round steps contain board-only FEN. Turn and ply live separately.
        const expected = request.fen.trim().split(/\s+/);
        const fields = typeof actual === 'string' ? actual.trim().split(/\s+/) : [];
        const expectedPly = (Number(expected[5]) - 1) * 2 + (expected[1] === 'b' ? 1 : 0);
        if (!fields[0] || fields[0] !== expected[0] || round.ply !== expectedPly ||
            ground?.state?.turnColor !== color ||
            fields.slice(1, 3).some((field, index) => field !== expected[index + 1])) return stale();
        const roles = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
        if (typeof round.pluginMove !== 'function') throw new Error('Lichess move API unavailable');
        round.pluginMove(from, to, promotion ? roles[promotion] : undefined, true);
        return { dispatched: true };
      }
      if (typeof window.lichess?.analysis?.playUci === 'function') {
        window.lichess.analysis.playUci(uci);
        return { dispatched: true };
      }
      if (!ground?.selectSquare) throw new Error('Lichess board API unavailable');
      if (!ground.state?.movable?.dests?.get(from)?.includes(to)) throw new Error('Move no longer available');
      ground.cancelMove();
      ground.selectSquare(from);
      ground.selectSquare(to);
    } else if (/(^|\.)chess\.com$/.test(host)) {
      // Use the board's move API when present, including explicit promotion.
      if (typeof board.game?.move === 'function') {
        const actual = board.game.getFEN?.();
        if (actual && request.fen && actual.split(' ').slice(0, 3).join(' ') !== request.fen.split(' ').slice(0, 3).join(' ')) {
          return stale();
        }
        const result = board.game.move({ from, to, userGenerated: true, ...(promotion ? { promotion } : {}) });
        if (result?.type && result.type !== 'Move') throw new Error(`Board rejected move: ${result.type}`);
        return { dispatched: true };
      }
      const rect = board.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error('Board is hidden');
      for (const square of [from, to]) {
        const file = square.charCodeAt(0) - 97, rank = Number(square[1]) - 1;
        const x = rect.left + ((orientation === 'black' ? 7 - file : file) + .5) * rect.width / 8;
        const y = rect.top + ((orientation === 'black' ? rank : 7 - rank) + .5) * rect.height / 8;
        const target = document.elementFromPoint(x, y);
        if (!target || !board.contains(target)) throw new Error('Board is covered or outside the viewport');
        for (const type of ['pointerdown', 'pointerup']) {
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0, buttons: type === 'pointerdown' ? 1 : 0,
            pointerType: 'mouse', pointerId: 1, isPrimary: true }));
        }
      }
    } else throw new Error('Unsupported board');

    if (promotion) {
      const roles = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
      // Promotion controls are mounted after the destination is selected.
      for (let attempt = 0; attempt < 10; attempt++) {
        if (board.getAttribute('data-knight-move-running') !== token) throw new Error('Auto move canceled');
        const choice = host.endsWith('lichess.org')
          ? document.querySelector(`#promotion-choice piece.${roles[promotion]}.${color}, .promotion-choice piece.${roles[promotion]}.${color}`)
          : document.querySelector(`.promotion-window .promotion-piece.${color[0]}${promotion}, .promotion-window .piece.${color[0]}${promotion}`);
        if (choice) { choice.click(); break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    return { dispatched: true };
  }

  const api = { executeOnPage };
  root.KnightAutoPlay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
