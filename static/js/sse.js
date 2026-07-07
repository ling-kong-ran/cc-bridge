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

  function handleSessionStarted(data = {}, options = {}) {
    if (data.session_id) options.setCurrentSessionId?.(data.session_id);
    options.setCurrentRunId?.(data.run_id || null);
    const wasActive = options.getSessionActive?.();
    options.setSessionActive?.(true);
    options.setIsViewer?.(!!data.viewing);
    options.updateUI?.();
    const modelLabel = options.getDisplayModelName?.(data.model || '') || '';
    options.renderTopbarMeta?.(data.model || '');
    if (data.remote_target_id && options.remoteTargetSelect) {
      options.remoteTargetSelect.value = data.remote_target_id;
      options.updateRemoteMutateRow?.();
    }
    const cliSelectEl = document.getElementById('cli-select');
    if (data.cli && cliSelectEl && [...cliSelectEl.options].some(o => o.value === data.cli)) {
      cliSelectEl.value = data.cli;
      options.renderTopbarMeta?.(data.model || '');
    }
    if (!wasActive) {
      const welcome = options.messagesEl?.querySelector?.('.welcome-msg');
      if (welcome) welcome.remove();
      if (data.session_id) {
        options.setCurrentSessionId?.(data.session_id);
        options.setCurrentRunId?.(data.run_id || options.getCurrentRunId?.());
        options.ensureWorkspaceSession?.(data.session_id, {
          title: data.title || undefined,
          cwd: data.cwd || options.cwdInput?.value?.trim?.() || '',
          model: data.model || options.modelSelect?.value || '',
          cli: data.cli || document.getElementById('cli-select')?.value || '',
          status: data.running === false ? 'idle' : 'running',
          runId: data.run_id || '',
        });
        options.setActiveWorkspaceSessionId?.(data.session_id);
        if (data.cwd) {
          options.cwdInput.value = data.cwd;
          options.updateRuntimeSummary?.();
        }
        options.refreshRightPaneFiles?.();
        options.showPage?.('chat');
        options.loadSessionHistory?.(data.session_id, data.cwd || '');
        if (options.getIsViewer?.()) {
          options.addSystemMsg?.(options.t?.('viewingSession'));
        } else {
          options.addSystemMsg?.(modelLabel ? options.t?.('sessionStarted', { model: modelLabel }) : options.t?.('sessionStartedPlain'));
        }
      } else if (options.getIsViewer?.()) {
        options.addSystemMsg?.(options.t?.('viewingSession'));
      } else {
        options.addSystemMsg?.(modelLabel ? options.t?.('sessionStarted', { model: modelLabel }) : options.t?.('sessionStartedPlain'));
      }
    }
  }

  function handleSessionStopped(data = {}, options = {}) {
    if (!options.isEventForCurrentSession?.(data)) return;
    options.setSessionActive?.(false);
    options.setIsResponding?.(false);
    options.setIsViewer?.(false);
    options.setCurrentRunId?.(null);
    options.updateUI?.();
    options.addSystemMsg?.(options.t?.('sessionStopped'));
  }

  function handleSessionTaken(data = {}, options = {}) {
    if (data.session_id && data.session_id === options.getCurrentSessionId?.()) {
      options.addSystemMsg?.(options.t?.('sessionTaken') || '会话被其他客户端接管，切换为观察模式');
      options.setIsViewer?.(true);
      options.setIsResponding?.(false);
      options.updateUI?.();
    }
  }

  function handleUserMessage(data = {}, options = {}) {
    if (!options.isEventForCurrentSession?.(data)) return;
    if (data.content) {
      options.addUserMessage?.(data.content);
      options.scrollToBottom?.(true);
    }
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
    handleSessionStarted,
    handleSessionStopped,
    handleSessionTaken,
    handleUserMessage,
  };
})();
