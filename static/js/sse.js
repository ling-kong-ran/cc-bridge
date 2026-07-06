(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getClientId() {
    const key = 'ccb_client_id';
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const clientId = 'c_' + Math.random().toString(36).substring(2, 10);
    sessionStorage.setItem(key, clientId);
    return clientId;
  }

  function createEventSource(clientId = getClientId()) {
    return new EventSource(`/sse?id=${encodeURIComponent(clientId)}`);
  }

  function closeEventSource(source) {
    if (source) source.close();
  }

  root.sse = {
    getClientId,
    createEventSource,
    closeEventSource,
  };
})();
