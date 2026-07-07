(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      document: options.document || window.document,
      t: options.t || root.i18n?.t || ((key) => key),
      loadI18n: options.loadI18n || root.i18n?.load || (() => Promise.resolve({})),
      getSessionActive: options.getSessionActive || (() => Boolean(options.sessionActive)),
      getSidebarCollapsed: options.getSidebarCollapsed || (() => Boolean(options.sidebarCollapsed)),
      setCurrentLanguage: options.setCurrentLanguage || (() => {}),
      setLanguageSelectValue: options.setLanguageSelectValue || (() => {}),
      saveGuiSettings: options.saveGuiSettings || (() => {}),
      updateThemeToggle: options.updateThemeToggle || (() => {}),
      updateConnectionText: options.updateConnectionText || (() => {}),
      updateUI: options.updateUI || (() => {}),
      setSidebarCollapsed: options.setSidebarCollapsed || (() => {}),
      updateFilePickerCount: options.updateFilePickerCount || (() => {}),
    };
  }

  async function loadLanguageMap(language, options = {}) {
    const ctx = getContext(options);
    try {
      await ctx.loadI18n(language);
      return language;
    } catch (e) {
      if (language !== 'en') {
        ctx.setCurrentLanguage('en');
        return loadLanguageMap('en', options);
      }
      return language;
    }
  }

  function renderLocalizedText(options = {}) {
    const ctx = getContext(options);
    ctx.document.querySelectorAll('[data-i18n]').forEach(el => {
      if (el.id === 'topbar-model' && ctx.getSessionActive()) return;
      el.textContent = ctx.t(el.dataset.i18n);
    });
    ctx.document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = ctx.t(el.dataset.i18nPlaceholder);
    });
    ctx.document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = ctx.t(el.dataset.i18nTitle);
    });
  }

  async function applyLanguage(language, persist = true, options = {}) {
    const ctx = getContext(options);
    const currentLanguage = language === 'zh' ? 'zh' : 'en';
    ctx.setCurrentLanguage(currentLanguage);
    ctx.setLanguageSelectValue(currentLanguage);
    ctx.document.documentElement.lang = currentLanguage === 'zh' ? 'zh-CN' : 'en';
    const loadedLanguage = await loadLanguageMap(currentLanguage, options);
    ctx.document.title = ctx.t('pageTitle');
    renderLocalizedText(options);
    ctx.updateThemeToggle();
    ctx.updateConnectionText();
    ctx.updateUI();
    ctx.setSidebarCollapsed(ctx.getSidebarCollapsed());
    ctx.updateFilePickerCount();
    if (persist) ctx.saveGuiSettings({ language: loadedLanguage });
  }

  root.localization = {
    applyLanguage,
    loadLanguageMap,
    renderLocalizedText,
  };
})();
