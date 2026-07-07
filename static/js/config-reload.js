(function () {
  const root = window.CCBridge = window.CCBridge || {};
  let lastFocusConfigReloadAt = 0;

  function initFocusConfigReload(options = {}) {
    window.addEventListener('focus', () => reloadConfigOnFocus(options));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        reloadConfigOnFocus(options);
      }
    });
  }

  function reloadConfigOnFocus(options = {}) {
    const now = Date.now();
    const minInterval = Number(options.minInterval || 1500);
    if (now - lastFocusConfigReloadAt < minInterval) return;
    lastFocusConfigReloadAt = now;
    return reloadExternalConfig(options);
  }

  async function reloadExternalConfig(options = {}) {
    await Promise.all([
      options.loadClis?.(),
      options.loadModels?.(),
      options.loadConfig?.(),
    ]);
    options.closeSlashCommandPanel?.();
  }

  root.configReload = {
    initFocusConfigReload,
    reloadConfigOnFocus,
    reloadExternalConfig,
  };
})();
