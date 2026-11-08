(function (root) {
  'use strict';
  if (root.__KNIGHT_LICHESS_BRIDGE__) return;
  const bridge = root.__KNIGHT_LICHESS_BRIDGE__ = { round: null, error: null };
  const wrappedAssets = new WeakMap();

  function install(asset) {
    if (!asset || typeof asset.loadEsmPage !== 'function' || typeof asset.loadEsm !== 'function') return asset;
    if (wrappedAssets.has(asset)) return wrappedAssets.get(asset);
    const original = asset.loadEsmPage;
    const loadPage = function (name, ...args) {
      if (name !== 'round') return original.call(this, name, ...args);
      const element = root.document.getElementById('page-init-data');
      if (!element) return original.call(this, name, ...args);
      // Initialize the same module once, retaining the controller it returns.
      // The normal page loader discards this return value.
      let data;
      try { data = JSON.parse(element.textContent); }
      catch (_error) { return original.call(this, name, ...args); }
      element.remove();
      bridge.round = null;
      bridge.error = null;
      return asset.loadEsm(name, { init: data }).then(controller => {
        bridge.round = controller;
        return controller;
      }).catch(error => {
        bridge.error = error?.message || 'Lichess game initialization failed';
        throw error;
      });
    };
    // asset is an immutable ES module namespace. Wrap reads instead of writing
    // its exports; site.asset itself is a writable property on the page.
    const proxy = new Proxy(asset, { get: (target, key) =>
      key === 'loadEsmPage' ? loadPage : Reflect.get(target, key)
    });
    wrappedAssets.set(asset, proxy);
    wrappedAssets.set(proxy, proxy);
    return proxy;
  }

  function watch(object, key, onValue) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const current = object[key];
    // Respect custom accessors owned by the page.
    if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) return;
    let value = current !== undefined ? onValue(current) ?? current : current;
    Object.defineProperty(object, key, { configurable: true, enumerable: descriptor?.enumerable ?? true,
      get: () => value,
      set: next => { value = onValue(next) ?? next; }
    });
  }

  watch(root, 'site', site => {
    if (site && typeof site === 'object') watch(site, 'asset', install);
  });
})(window);
