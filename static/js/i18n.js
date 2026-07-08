(function () {
  const root = window.CCBridge = window.CCBridge || {};
  let i18nMap = {};

  async function load(language) {
    const resp = await fetch(`/static/i18n/${language}.json`);
    if (!resp.ok) throw new Error(`missing locale: ${language}`);
    i18nMap = await resp.json();
    return i18nMap;
  }

  function t(key, vars = {}) {
    let text = i18nMap[key] || key;
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }

  function formatMessage(data, fallbackKey = 'unknownError') {
    if (!data) return t(fallbackKey);
    if (typeof data === 'string') return i18nMap[data] ? t(data) : data;
    const key = data.message_key || data.error_key || data.key;
    const params = data.message_params || data.error_params || data.params || {};
    if (key) return t(key, params);
    const text = data.message || data.error;
    if (typeof text === 'string' && i18nMap[text]) return t(text, params);
    return text || t(fallbackKey);
  }

  root.i18n = {
    load,
    t,
    formatMessage,
  };
})();
