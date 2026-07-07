(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      addSystemMsg: options.addSystemMsg || (() => {}),
      clearQuotedMessagesForSend: options.clearQuotedMessagesForSend || (() => {}),
      resetAssistantStreamState: options.resetAssistantStreamState || (() => {}),
      normalizeTokenUsage: options.normalizeTokenUsage || root.formatters?.normalizeTokenUsage || ((value) => value || {}),
      renderTopbarMeta: options.renderTopbarMeta || (() => {}),
      renderCost: options.renderCost || (() => {}),
      renderTokens: options.renderTokens || (() => {}),
      updateRuntimeSummary: options.updateRuntimeSummary || (() => {}),
      refreshRightPaneFiles: options.refreshRightPaneFiles || (() => {}),
      hasModelOption: options.hasModelOption || (() => false),
      updateRemoteMutateRow: options.updateRemoteMutateRow || (() => {}),
      renderStaticHistory: options.renderStaticHistory || (() => {}),
      sendAction: options.sendAction || (() => Promise.resolve(null)),
      isCwdError: options.isCwdError || (() => false),
      promptCwdForSession: options.promptCwdForSession || (() => Promise.resolve(null)),
      updateSessionCwd: options.updateSessionCwd || (() => Promise.resolve({ ok: false })),
      updateUI: options.updateUI || (() => {}),
      loadSessions: options.loadSessions || (() => {}),
      getClientId: options.getClientId || (() => options.clientId || ''),
      getState: options.getState || (() => ({})),
      setState: options.setState || (() => {}),
      messagesEl: options.messagesEl || document.getElementById('messages'),
      cwdInput: options.cwdInput || document.getElementById('cwd'),
      modelSelect: options.modelSelect || document.getElementById('model-select'),
      cliSelect: options.cliSelect || document.getElementById('cli-select'),
      skipPermissions: options.skipPermissions || document.getElementById('skip-permissions'),
      remoteTargetSelect: options.remoteTargetSelect || document.getElementById('remote-target-select'),
      remoteAllowMutate: options.remoteAllowMutate || document.getElementById('remote-allow-mutate'),
      notifyFeishu: options.notifyFeishu || document.getElementById('notify-feishu'),
    };
  }

  async function loadSessionHistory(sessionId, cwd, ctx) {
    try {
      const resp = await fetch('/api/sessions/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, cwd }),
      });
      const history = await resp.json();
      if (history && history.length > 0) {
        ctx.renderStaticHistory(history);
      }
    } catch (e) {
      console.error('历史消息加载失败:', e);
    }
  }

  function buildResumePayload(ctx, sessionId, model, cli, cwd, remoteTargetId, notifyPlatforms) {
    return {
      session_id: sessionId,
      model: model || ctx.modelSelect?.value,
      cli: cli || ctx.cliSelect?.value || '',
      cwd,
      skip_permissions: !!ctx.skipPermissions?.checked,
      remote_target_id: remoteTargetId || '',
      allow_remote_mutate: !!ctx.remoteAllowMutate?.checked,
      notify_platforms: notifyPlatforms,
    };
  }

  async function resumeSession(sessionId, cwd, model, savedCost = 0, remoteTargetId = '', savedTokens = null, cli = '', options = {}) {
    const ctx = getContext(options);
    if (!ctx.getClientId()) {
      ctx.addSystemMsg(ctx.t('notConnected'), true);
      return;
    }

    ctx.clearQuotedMessagesForSend();
    if (ctx.messagesEl) ctx.messagesEl.innerHTML = '';
    ctx.setState({
      currentAssistantEl: null,
      currentAssistantMessageId: null,
      currentContent: [],
      streamBlocks: {},
      isResponding: false,
      currentRunId: null,
      currentSessionId: sessionId,
      totalCost: Number.isFinite(savedCost) ? savedCost : 0,
      totalTokens: ctx.normalizeTokenUsage(savedTokens),
    });
    ctx.resetAssistantStreamState();
    ctx.renderTopbarMeta(model || ctx.modelSelect?.value);
    ctx.renderCost();
    ctx.renderTokens();

    if (cwd && ctx.cwdInput) {
      ctx.cwdInput.value = cwd;
      ctx.updateRuntimeSummary();
    }
    ctx.refreshRightPaneFiles();
    if (model && ctx.hasModelOption(model) && ctx.modelSelect) {
      ctx.modelSelect.value = model;
      ctx.renderTopbarMeta(model);
    }
    if (ctx.remoteTargetSelect) {
      ctx.remoteTargetSelect.value = remoteTargetId || '';
      ctx.updateRemoteMutateRow();
    }
    if (ctx.cliSelect && cli && [...ctx.cliSelect.options].some(o => o.value === cli)) {
      ctx.cliSelect.value = cli;
      ctx.renderTopbarMeta(model || ctx.modelSelect?.value);
    }

    ctx.addSystemMsg(ctx.t('restoring'));
    await loadSessionHistory(sessionId, cwd, ctx);

    let resumeCwd = cwd || ctx.cwdInput?.value?.trim() || null;
    const notifyPlatforms = ctx.notifyFeishu?.checked ? ['feishu'] : [];
    let result = await ctx.sendAction('resume_session', buildResumePayload(ctx, sessionId, model, cli, resumeCwd, remoteTargetId, notifyPlatforms));

    if (result && !result.ok && ctx.isCwdError(result.error || '')) {
      ctx.addSystemMsg(ctx.t('cwdNotExist', { path: resumeCwd || '(空)' }), true);
      const newCwd = await ctx.promptCwdForSession(resumeCwd);
      if (newCwd) {
        const updateResult = await ctx.updateSessionCwd(sessionId, newCwd);
        if (updateResult.ok) {
          ctx.addSystemMsg(ctx.t('cwdChanged', { path: newCwd }));
          if (ctx.cwdInput) ctx.cwdInput.value = newCwd;
          ctx.updateRuntimeSummary();
          resumeCwd = newCwd;
          result = await ctx.sendAction('resume_session', buildResumePayload(ctx, sessionId, model, cli, resumeCwd, remoteTargetId, notifyPlatforms));
        } else {
          ctx.addSystemMsg(ctx.t('cwdNotChanged', { message: updateResult.error || ctx.t('unknownError') }), true);
        }
      }
    }

    if (result && result.ok) {
      ctx.setState({ sessionActive: true });
      ctx.updateUI();
      ctx.addSystemMsg(ctx.t('restored'));
    } else {
      ctx.addSystemMsg(ctx.t('restoreFailed', { message: result?.error || ctx.t('unknownError') }), true);
    }
    ctx.loadSessions();
  }

  root.sessionResume = {
    resumeSession,
  };
})();
