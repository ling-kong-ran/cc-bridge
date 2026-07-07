(function () {
  const root = window.CCBridge = window.CCBridge || {};
  let lastFocusConfigReloadAt = 0;

  function initFocusConfigReload(options = {}) {
    window.addEventListener('focus', () => {
      reloadConfigOnFocus(options)?.catch?.((e) => {
        console.warn('Reload config on focus failed:', e);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        reloadConfigOnFocus(options)?.catch?.((e) => {
          console.warn('Reload config on visibility change failed:', e);
        });
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
    await Promise.allSettled([
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
