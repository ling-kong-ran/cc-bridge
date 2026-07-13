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
    // session_id 是最强的归属判据：带 session_id 的事件，必须匹配当前 active 或 currentSessionId，
    // 否则一律视为别的会话（后台）。不能仅凭 run_id 相同就当成当前会话——
    // 切换页签时 currentRunId 还未更新为新会话的 run_id，老会话的流式事件会借 run_id 误判为当前会话，
    // 被渲染进刚切到/新建的页签。
    if (data.session_id) {
      if (state.activeWorkspaceSessionId && data.session_id === state.activeWorkspaceSessionId) return true;
      if (state.currentSessionId && data.session_id === state.currentSessionId) return true;
      return false;
    }
    // 无 session_id 的事件，退而用 run_id 匹配（如早期流式块）。
    if (data.run_id && state.currentRunId && data.run_id === state.currentRunId) return true;
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
    // 仅当事件属于当前活跃页签时才更新 currentSessionId，
    // 否则后台会话的 session_started 会把 currentSessionId 抢走，
    // 导致后续事件被渲染进错误的页签。
    const activeId = options.getActiveWorkspaceSessionId?.() || '';
    const isPending = activeId.startsWith('pending-');
    const currentMatches = !options.strictActiveSession && options.getCurrentSessionId?.() && options.getCurrentSessionId() === data.session_id;
    const isActiveSession = !activeId || isPending || activeId === data.session_id || currentMatches;
    if (data.session_id && isActiveSession) {
      options.setCurrentSessionId?.(data.session_id);
    }
    if (isActiveSession) {
      options.setCurrentRunId?.(data.run_id || null);
    }
    const wasActive = options.getSessionActive?.();
    options.setSessionActive?.(true);
    options.setIsViewer?.(!!data.viewing);
    options.updateUI?.();
    const modelLabel = options.getDisplayModelName?.(data.model || '') || '';
    if (isActiveSession) options.renderTopbarMeta?.(data.model || '');
    if (data.remote_target_id && options.remoteTargetSelect && isActiveSession) {
      options.remoteTargetSelect.value = data.remote_target_id;
      options.updateRemoteMutateRow?.();
    }
    const cliSelectEl = document.getElementById('cli-select');
    if (data.cli && cliSelectEl && [...cliSelectEl.options].some(o => o.value === data.cli) && isActiveSession) {
      cliSelectEl.value = data.cli;
      options.renderTopbarMeta?.(data.model || '');
    }
    if (!wasActive) {
      const welcome = options.messagesEl?.querySelector?.('.welcome-msg');
      if (welcome) welcome.remove();
      if (data.session_id) {
        if (isActiveSession) {
          options.setCurrentSessionId?.(data.session_id);
          options.setCurrentRunId?.(data.run_id || options.getCurrentRunId?.());
        }
        options.ensureWorkspaceSession?.(data.session_id, {
          title: data.title || undefined,
          cwd: data.cwd || options.cwdInput?.value?.trim?.() || '',
          model: data.model || options.modelSelect?.value || '',
          cli: data.cli || document.getElementById('cli-select')?.value || '',
          status: data.running === false ? 'idle' : 'running',
          runId: data.run_id || '',
        });
        // 仅在 active 还未确定（空或 pending- 前缀）或本就是该会话时才认领 active。
        if (isActiveSession) {
          options.setActiveWorkspaceSessionId?.(data.session_id);
        }
        if (data.cwd && isActiveSession) {
          options.cwdInput.value = data.cwd;
          options.updateRuntimeSummary?.();
        }
        if (isActiveSession) options.refreshRightPaneFiles?.();
        options.showPage?.('chat');
        if (isActiveSession) {
          options.loadSessionHistory?.(data.session_id, data.cwd || '');
        }
        if (options.getIsViewer?.()) {
          if (isActiveSession) options.addSystemMsg?.(options.t?.('viewingSession'));
        } else {
          if (isActiveSession) {
            options.addSystemMsg?.(modelLabel ? options.t?.('sessionStarted', { model: modelLabel }) : options.t?.('sessionStartedPlain'));
          }
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
