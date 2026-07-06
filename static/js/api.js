(function () {
  const root = window.CCBridge = window.CCBridge || {};

  async function request(url, options = {}) {
    const resp = await fetch(url, options);
    return resp;
  }

  async function json(url, options = {}) {
    const resp = await request(url, options);
    return resp.json();
  }

  async function postJson(url, data = {}) {
    const resp = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return resp.json();
  }

  root.api = {
    request,
    json,
    postJson,
  };
})();
