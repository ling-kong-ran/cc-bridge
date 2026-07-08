(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      addSystemMsg: options.addSystemMsg || (() => {}),
      addUserMessage: options.addUserMessage || (() => {}),
      updateUI: options.updateUI || (() => {}),
      updateWorkspaceSessionStatus: options.updateWorkspaceSessionStatus || (() => {}),
      createAssistantBubble: options.createAssistantBubble || (() => null),
      startTurnTimer: options.startTurnTimer || (() => {}),
      stopTurnTimer: options.stopTurnTimer || (() => {}),
      renderCurrentState: options.renderCurrentState || (() => {}),
      scrollToBottom: options.scrollToBottom || (() => {}),
      sendAction: options.sendAction || (() => Promise.resolve(null)),
      removePendingAssistantBubble: options.removePendingAssistantBubble || (() => {}),
      captureActiveWorkspaceSnapshot: options.captureActiveWorkspaceSnapshot || (() => {}),
      quotePayloadForBackend: options.quotePayloadForBackend || ((quotes) => quotes || []),
      quoteBackendPayload: options.quoteBackendPayload || ((quotes) => quotes || []),
      getQuotedMessagesForSend: options.getQuotedMessagesForSend || (() => []),
      clearQuotedMessagesForSend: options.clearQuotedMessagesForSend || (() => {}),
      quoteDisplayText: options.quoteDisplayText || ((quote) => String(quote?.text || quote || '')),
      getAttachedFiles: options.getAttachedFiles || (() => []),
      consumeAttachedFiles: options.consumeAttachedFiles || (() => []),
      getState: options.getState || (() => ({})),
      setState: options.setState || (() => {}),
      inputEl: options.inputEl || document.getElementById('message-input'),
      modelSelect: options.modelSelect || document.getElementById('model-select'),
      cliSelect: options.cliSelect || document.getElementById('cli-select'),
      remoteTargetSelect: options.remoteTargetSelect || document.getElementById('remote-target-select'),
      remoteAllowMutate: options.remoteAllowMutate || document.getElementById('remote-allow-mutate'),
      memoryAutoInject: options.memoryAutoInject || document.getElementById('memory-auto-inject'),
      notifyFeishu: options.notifyFeishu || document.getElementById('notify-feishu'),
    };
  }

  function isSlashCommand(content) {
    return /^\/[^\s]+/.test((content || '').trim());
  }

  function getSlashCommandName(content) {
    const match = (content || '').trim().match(/^\/[^\s]+/);
    return match ? match[0] : '';
  }

  function interruptCurrentRun(options = {}) {
    const ctx = getContext(options);
    const state = ctx.getState();
    if (!state.isResponding || !state.currentSessionId) return Promise.resolve(null);
    return ctx.sendAction('interrupt', { session_id: state.currentSessionId, run_id: state.currentRunId });
  }

  async function sendMessage(options = {}) {
    const ctx = getContext(options);
    const state = ctx.getState();
    let content = ctx.inputEl?.value?.trim() || '';
    const quotesForThisTurn = ctx.quotePayloadForBackend(ctx.getQuotedMessagesForSend());
    const isLiveFollowup = !!state.isResponding;
    const attachedFiles = ctx.getAttachedFiles();
    if ((!content && attachedFiles.length === 0 && quotesForThisTurn.length === 0) || !state.sessionActive) return;
    if (state.isViewer && !isLiveFollowup) {
      ctx.setState({ isViewer: false });
      ctx.updateUI();
    }
    const originalContent = content;
    const attachmentCount = attachedFiles.length;

    if (quotesForThisTurn.length > 0) {
      const inlineQuotes = quotesForThisTurn.filter(q => q.type !== 'file_lines' || !q.path || !q.lines.length);
      if (inlineQuotes.length) {
        const quotedText = inlineQuotes
          .map(q => ctx.quoteDisplayText(q).split('\n').map(line => `> ${line}`).join('\n'))
          .join('\n\n');
        content = content ? `${quotedText}\n\n${content}` : quotedText;
      }
      ctx.clearQuotedMessagesForSend();
    }

    if (attachedFiles.length > 0) {
      const filesForThisTurn = ctx.consumeAttachedFiles();
      const filePaths = filesForThisTurn.map(f => `- ${f.path}`).join('\n');
      const prefix = `${ctx.t('attachmentIntro')}\n${filePaths}\n\n`;
      content = prefix + content;
    }

    ctx.addUserMessage(originalContent, quotesForThisTurn);
    ctx.captureActiveWorkspaceSnapshot();
    if (ctx.inputEl) ctx.inputEl.value = '';

    if (!isLiveFollowup) {
      const currentSessionId = ctx.getState().currentSessionId;
      ctx.setState({
        currentTurnContent: originalContent || (attachmentCount ? ctx.t('notifyAttachmentPrompt', { count: attachmentCount }) : (quotesForThisTurn.length ? ctx.t('quotedMessage') : '')),
        currentTurnAttachmentCount: attachmentCount,
        currentTurnStartedAt: Date.now(),
        currentTurnHasAssistantOutput: false,
        isResponding: true,
        currentAssistantEl: ctx.createAssistantBubble(),
        currentAssistantMessageId: null,
        currentContent: [],
        streamBlocks: {},
      });
      ctx.updateWorkspaceSessionStatus(currentSessionId, 'running', ctx.t('streamingReply'));
      ctx.startTurnTimer();
      ctx.renderCurrentState();
      if (isSlashCommand(originalContent)) {
        ctx.addSystemMsg(ctx.t('commandRunning', { command: getSlashCommandName(originalContent) }));
      }
    }

    ctx.scrollToBottom(true);
    ctx.updateUI();

    const result = await ctx.sendAction('send_message', {
      content,
      quotes: ctx.quoteBackendPayload(quotesForThisTurn),
      model: ctx.modelSelect?.value,
      cli: ctx.cliSelect?.value || '',
      remote_target_id: ctx.remoteTargetSelect?.value || '',
      allow_remote_mutate: !!ctx.remoteAllowMutate?.checked,
      skip_memory_inject: ctx.memoryAutoInject?.checked === false,
      notify_platforms: ctx.notifyFeishu?.checked ? ['feishu'] : [],
    });

    if (!result?.ok) {
      if (!isLiveFollowup) {
        ctx.stopTurnTimer();
        ctx.removePendingAssistantBubble(false);
        ctx.setState({
          isResponding: false,
          currentAssistantEl: null,
          currentContent: [],
          streamBlocks: {},
          currentTurnContent: '',
          currentTurnHasAssistantOutput: false,
          currentTurnStartedAt: 0,
          currentTurnAttachmentCount: 0,
        });
        ctx.updateUI();
      }
      const formatMessage = root.i18n?.formatMessage || ((data) => data?.error || data?.message || ctx.t('unknownError'));
      ctx.addSystemMsg(formatMessage(result, 'requestFailed'), true);
      return;
    }

    if (result.run_id) ctx.setState({ currentRunId: result.run_id });
    ctx.captureActiveWorkspaceSnapshot();
  }

  root.messageSend = {
    isSlashCommand,
    getSlashCommandName,
    interruptCurrentRun,
    sendMessage,
  };
})();
