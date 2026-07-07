(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      addSystemMsg: options.addSystemMsg || (() => {}),
      showPage: options.showPage || (() => {}),
      stopTurnTimer: options.stopTurnTimer || (() => {}),
      clearQuotedMessagesForSend: options.clearQuotedMessagesForSend || (() => {}),
      emptyTokenUsage: options.emptyTokenUsage || root.formatters?.emptyTokenUsage || (() => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0 })),
      renderTopbarMeta: options.renderTopbarMeta || (() => {}),
      renderCost: options.renderCost || (() => {}),
      renderTokens: options.renderTokens || (() => {}),
      ensureWorkspaceSession: options.ensureWorkspaceSession || (() => {}),
      refreshRightPaneFiles: options.refreshRightPaneFiles || (() => {}),
      updateRuntimeSummary: options.updateRuntimeSummary || (() => {}),
      sendAction: options.sendAction || (() => {}),
      loadSessions: options.loadSessions || (() => {}),
      getClientId: options.getClientId || (() => options.clientId || ''),
      getState: options.getState || (() => ({})),
      setState: options.setState || (() => {}),
      messagesEl: options.messagesEl || document.getElementById('messages'),
      cwdInput: options.cwdInput || document.getElementById('cwd'),
      modelSelect: options.modelSelect || document.getElementById('model-select'),
      remoteTargetSelect: options.remoteTargetSelect || document.getElementById('remote-target-select'),
      remoteAllowMutate: options.remoteAllowMutate || document.getElementById('remote-allow-mutate'),
      memoryAutoInject: options.memoryAutoInject || document.getElementById('memory-auto-inject'),
      notifyFeishu: options.notifyFeishu || document.getElementById('notify-feishu'),
      skipPermissions: options.skipPermissions || document.getElementById('skip-permissions'),
      cliSelect: options.cliSelect || document.getElementById('cli-select'),
    };
  }

  function resetSessionViewState(options = {}) {
    const ctx = getContext(options);
    ctx.stopTurnTimer();
    ctx.clearQuotedMessagesForSend();
    if (ctx.messagesEl) ctx.messagesEl.innerHTML = '';
    ctx.setState({
      currentAssistantEl: null,
      currentAssistantMessageId: null,
      currentContent: [],
      streamBlocks: {},
      totalCost: 0,
      totalTokens: ctx.emptyTokenUsage(),
      currentSessionId: null,
      currentRunId: null,
    });
    ctx.renderTopbarMeta();
    ctx.renderCost();
    ctx.renderTokens();
  }

  function startNewSession(options = {}) {
    const ctx = getContext(options);
    if (!ctx.getClientId()) {
      ctx.addSystemMsg(ctx.t('notConnected'), true);
      return;
    }

    ctx.showPage('chat');
    createNewSession(ctx.cwdInput?.value.trim() || '', options);
  }

  function createNewSession(cwd, options = {}) {
    const ctx = getContext(options);
    resetSessionViewState(options);
    const pendingSessionId = `pending-${Date.now()}`;
    ctx.setState({ activeWorkspaceSessionId: pendingSessionId });
    ctx.ensureWorkspaceSession(pendingSessionId, {
      title: ctx.t('newChat'),
      cwd: cwd || ctx.cwdInput?.value.trim() || '',
      model: ctx.modelSelect?.value || '',
      cli: ctx.cliSelect?.value || '',
      status: 'idle',
    });

    if (cwd && ctx.cwdInput) {
      ctx.cwdInput.value = cwd;
      ctx.updateRuntimeSummary();
    }
    ctx.refreshRightPaneFiles();
    ctx.sendAction('new_session', {
      model: ctx.modelSelect?.value,
      cli: ctx.cliSelect?.value || '',
      cwd: ctx.cwdInput?.value.trim() || null,
      skip_permissions: !!ctx.skipPermissions?.checked,
      remote_target_id: ctx.remoteTargetSelect?.value || '',
      allow_remote_mutate: !!ctx.remoteAllowMutate?.checked,
      skip_memory_inject: ctx.memoryAutoInject?.checked === false,
      notify_platforms: ctx.notifyFeishu?.checked ? ['feishu'] : [],
    });
    ctx.loadSessions();
  }

  async function startNewSessionFromCwd(cwd, options = {}) {
    const ctx = getContext(options);
    const nextCwd = (cwd || '').trim();
    if (!nextCwd || !ctx.getClientId()) {
      if (!ctx.getClientId()) ctx.addSystemMsg(ctx.t('notConnected'), true);
      return;
    }

    ctx.showPage('chat');
    createNewSession(nextCwd, options);
  }

  root.sessionControl = {
    resetSessionViewState,
    startNewSession,
    createNewSession,
    startNewSessionFromCwd,
  };
})();
