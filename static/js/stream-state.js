(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      tabStreamState: options.tabStreamState || new Map(),
      getState: options.getState || (() => ({})),
      setState: options.setState || (() => {}),
      emptyTokenUsage: options.emptyTokenUsage || (() => ({})),
      updateStopButton: options.updateStopButton || (() => {}),
    };
  }

  function cloneStreamBlocks(streamBlocks) {
    return JSON.parse(JSON.stringify(streamBlocks || {}));
  }

  function saveStreamState(sessionId, options = {}) {
    if (!sessionId) return;
    const ctx = getContext(options);
    const state = ctx.getState();
    ctx.tabStreamState.set(sessionId, {
      isResponding: state.isResponding,
      currentRunId: state.currentRunId,
      currentSessionId: state.currentSessionId,
      currentContent: Array.isArray(state.currentContent) ? state.currentContent.slice() : [],
      streamBlocks: cloneStreamBlocks(state.streamBlocks),
      currentAssistantMessageId: state.currentAssistantMessageId,
      currentTurnContent: state.currentTurnContent,
      currentTurnHasAssistantOutput: state.currentTurnHasAssistantOutput,
      currentTurnStartedAt: state.currentTurnStartedAt,
      currentTurnAttachmentCount: state.currentTurnAttachmentCount,
    });
  }

  function restoreStreamState(sessionId, options = {}) {
    const ctx = getContext(options);
    const saved = ctx.tabStreamState.get(sessionId);
    if (saved) {
      ctx.setState({
        isResponding: saved.isResponding,
        currentRunId: saved.currentRunId,
        currentSessionId: saved.currentSessionId || sessionId,
        currentContent: saved.currentContent,
        streamBlocks: saved.streamBlocks,
        currentAssistantMessageId: saved.currentAssistantMessageId,
        currentTurnContent: saved.currentTurnContent,
        currentTurnHasAssistantOutput: saved.currentTurnHasAssistantOutput,
        currentTurnStartedAt: saved.currentTurnStartedAt,
        currentTurnAttachmentCount: saved.currentTurnAttachmentCount,
        currentAssistantEl: null,
        totalCost: 0,
        totalTokens: ctx.emptyTokenUsage(),
      });
    } else {
      ctx.setState({
        isResponding: false,
        currentRunId: null,
        // 保留指向目标会话，避免竞态窗口内 currentSessionId 为 null
        // 导致后台会话的 session_id_captured 等事件误认领为当前会话
        currentSessionId: sessionId,
        currentContent: [],
        streamBlocks: {},
        currentAssistantMessageId: null,
        currentTurnContent: '',
        currentTurnHasAssistantOutput: false,
        currentTurnStartedAt: 0,
        currentTurnAttachmentCount: 0,
        currentAssistantEl: null,
        totalCost: 0,
        totalTokens: ctx.emptyTokenUsage(),
      });
    }
    ctx.updateStopButton();
  }

  function resetAssistantStreamState(options = {}) {
    const ctx = getContext(options);
    ctx.setState({
      currentAssistantEl: null,
      currentAssistantMessageId: null,
      currentContent: [],
      streamBlocks: {},
    });
  }

  root.streamState = {
    saveStreamState,
    restoreStreamState,
    resetAssistantStreamState,
  };
})();
