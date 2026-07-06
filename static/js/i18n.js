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

  root.i18n = {
    load,
    t,
  };
})();
