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

  function connect(options = {}) {
    const currentSource = options.getEventSource?.();
    if (currentSource) closeEventSource(currentSource);

    const clientId = getClientId();
    sessionStorage.setItem('ccb_client_id', clientId);
    const source = createEventSource(clientId);
    options.setClientId?.(clientId);
    options.setEventSource?.(source);
    options.bindEvents?.(source);
    return { clientId, source };
  }

  function isEventForSession(data = {}, state = {}) {
    if (data.run_id && state.currentRunId && data.run_id === state.currentRunId) return true;
    if (data.session_id) {
      if (state.activeWorkspaceSessionId && data.session_id === state.activeWorkspaceSessionId) return true;
      if (state.currentSessionId && data.session_id === state.currentSessionId) return true;
      return false;
    }
    return true;
  }

  function isBackgroundSessionEvent(data = {}, state = {}) {
    if (!data.session_id) return false;
    if (state.activeWorkspaceSessionId && data.session_id === state.activeWorkspaceSessionId) return false;
    if (state.currentSessionId && data.session_id === state.currentSessionId) return false;
    if (data.run_id && state.currentRunId && data.run_id === state.currentRunId) return false;
    return true;
  }

  async function sendAction(clientId, action, extra = {}) {
    const api = root.api;
    if (api?.postJson) return api.postJson('/api/action', { client_id: clientId, action, ...extra });
    if (api?.json) {
      return api.json('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, action, ...extra }),
      });
    }

    const resp = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, action, ...extra }),
    });
    return resp.json();
  }

  function setConnectionStatus(connected, options = {}) {
    options.setConnected?.(connected);
    const dot = options.connectionStatus?.querySelector?.('.status-dot');
    if (dot) dot.className = `status-dot ${connected ? 'online' : 'offline'}`;
    options.updateConnectionText?.();
    options.renderTopbarStatusSummary?.();
  }

  function updateConnectionText(options = {}) {
    const text = options.connectionStatus?.querySelector?.('.status-text');
    if (text) text.textContent = options.getConnected?.() ? options.t?.('connected') || 'connected' : options.t?.('connecting') || 'connecting';
  }

  async function sendActionRequest(action, extra = {}, options = {}) {
    const clientId = options.getClientId?.() || '';
    if (!clientId) return { error: options.t?.('notConnected') || 'notConnected' };
    return sendAction(clientId, action, extra);
  }

  root.sse = {
    getClientId,
    createEventSource,
    closeEventSource,
    connect,
    isEventForSession,
    isBackgroundSessionEvent,
    sendAction,
    setConnectionStatus,
    updateConnectionText,
    sendActionRequest,
  };
})();
