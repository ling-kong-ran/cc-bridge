(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      clearCompletionHistorySync: options.clearCompletionHistorySync || (() => {}),
      normalizeTokenUsage: options.normalizeTokenUsage || root.formatters?.normalizeTokenUsage || ((value) => value || {}),
      stopTurnTimer: options.stopTurnTimer || (() => {}),
      finalizeCurrentAssistantMarkdown: options.finalizeCurrentAssistantMarkdown || (() => {}),
      updateAssistantMeta: options.updateAssistantMeta || (() => {}),
      removePendingAssistantBubble: options.removePendingAssistantBubble || (() => {}),
      clearRunningTasks: options.clearRunningTasks || (() => {}),
      clearSubagentBubbles: options.clearSubagentBubbles || (() => {}),
      notifyComplete: options.notifyComplete || (() => {}),
      getDisplayModelName: options.getDisplayModelName || ((model) => model || ''),
      checkMemoryHits: options.checkMemoryHits || (() => {}),
      updateUI: options.updateUI || (() => {}),
      renderCost: options.renderCost || (() => {}),
      hasTokenUsage: options.hasTokenUsage || (() => false),
      renderTokens: options.renderTokens || (() => {}),
      addTokenUsage: options.addTokenUsage || ((left) => left),
      ensureWorkspaceSession: options.ensureWorkspaceSession || (() => null),
      addSystemMsg: options.addSystemMsg || (() => {}),
      isSlashCommand: options.isSlashCommand || root.messageSend?.isSlashCommand || (() => false),
      getSlashCommandName: options.getSlashCommandName || root.messageSend?.getSlashCommandName || (() => ''),
      getState: options.getState || (() => ({})),
      setState: options.setState || (() => {}),
      modelSelect: options.modelSelect || document.getElementById('model-select'),
    };
  }

  function handleResult(data, options = {}) {
    const ctx = getContext(options);
    const state = ctx.getState();
    ctx.clearCompletionHistorySync();
    const finishedTurn = state.currentTurnContent;
    const hadAssistantOutput = state.currentTurnHasAssistantOutput;
    const durationMs = Date.now() - state.currentTurnStartedAt;
    const turnCost = Number(data.total_cost_usd || 0);
    const persistedCost = Number(data.session_total_cost_usd || 0);
    const turnTokens = ctx.normalizeTokenUsage(data.turn_tokens || data.usage || data);
    const persistedTokens = ctx.normalizeTokenUsage(data.session_total_tokens);
    ctx.stopTurnTimer();
    if (state.currentAssistantEl) ctx.finalizeCurrentAssistantMarkdown();
    ctx.updateAssistantMeta('done', durationMs);
    ctx.removePendingAssistantBubble(hadAssistantOutput);
    const assistantEl = state.currentAssistantEl;
    ctx.setState({
      isResponding: false,
      currentAssistantEl: null,
      currentAssistantMessageId: null,
      currentContent: [],
      streamBlocks: {},
    });
    ctx.clearRunningTasks();
    ctx.clearSubagentBubbles();
    ctx.notifyComplete('turn', {
      prompt: finishedTurn,
      durationMs,
      costUsd: turnCost,
      model: ctx.getDisplayModelName(data.model || ctx.modelSelect?.value),
    });
    if (assistantEl && hadAssistantOutput) ctx.checkMemoryHits(assistantEl, finishedTurn);
    ctx.setState({
      currentTurnContent: '',
      currentTurnHasAssistantOutput: false,
      currentTurnStartedAt: 0,
      currentTurnAttachmentCount: 0,
    });
    ctx.updateUI();

    let nextTotalCost = state.totalCost;
    if (Number.isFinite(persistedCost) && persistedCost > 0) {
      nextTotalCost = persistedCost;
      ctx.setState({ totalCost: nextTotalCost });
      ctx.renderCost();
    } else if (Number.isFinite(turnCost) && turnCost > 0) {
      nextTotalCost = Number(nextTotalCost || 0) + turnCost;
      ctx.setState({ totalCost: nextTotalCost });
      ctx.renderCost();
    }

    let nextTotalTokens = state.totalTokens;
    if (ctx.hasTokenUsage(persistedTokens)) {
      nextTotalTokens = persistedTokens;
      ctx.setState({ totalTokens: nextTotalTokens });
      ctx.renderTokens();
    } else if (ctx.hasTokenUsage(turnTokens)) {
      nextTotalTokens = ctx.addTokenUsage(nextTotalTokens, turnTokens);
      ctx.setState({ totalTokens: nextTotalTokens });
      ctx.renderTokens();
    }

    const currentSessionId = ctx.getState().currentSessionId;
    if (currentSessionId) {
      const session = ctx.ensureWorkspaceSession(currentSessionId, {
        cost: nextTotalCost,
        tokens: nextTotalTokens,
        status: data.is_error ? 'error' : 'done',
      });
      if (session) {
        session.cost = nextTotalCost;
        session.tokens = nextTotalTokens;
      }
    }

    if (data.is_error && data.errors) {
      data.errors.forEach(e => ctx.addSystemMsg(e, true));
    } else if (ctx.isSlashCommand(finishedTurn) && !hadAssistantOutput) {
      ctx.addSystemMsg(ctx.t('commandCompleted', { command: ctx.getSlashCommandName(finishedTurn) }));
    }
  }

  root.resultHandler = {
    handleResult,
  };
})();
