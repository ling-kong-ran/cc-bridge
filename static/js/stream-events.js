(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      isResponding: options.isResponding || false,
      currentSessionId: options.currentSessionId || '',
      currentAssistantEl: options.currentAssistantEl || null,
      currentTurnStartedAt: options.currentTurnStartedAt || 0,
      getStreamBlocks: options.getStreamBlocks || (() => ({})),
      setStreamBlocks: options.setStreamBlocks || (() => {}),
      getCurrentContent: options.getCurrentContent || (() => []),
      setCurrentContent: options.setCurrentContent || (() => {}),
      setIsResponding: options.setIsResponding || (() => {}),
      setCurrentTurnHasAssistantOutput: options.setCurrentTurnHasAssistantOutput || (() => {}),
      setCurrentTurnStartedAt: options.setCurrentTurnStartedAt || (() => {}),
      setCurrentAssistantEl: options.setCurrentAssistantEl || (() => {}),
      cleanupStaleAssistantStreamingBubbles: options.cleanupStaleAssistantStreamingBubbles || (() => {}),
      createAssistantBubble: options.createAssistantBubble || (() => null),
      startTurnTimer: options.startTurnTimer || (() => {}),
      updateWorkspaceSessionStatus: options.updateWorkspaceSessionStatus || (() => {}),
      setWorkspaceSessionPreview: options.setWorkspaceSessionPreview || (() => {}),
      appendWorkspaceSessionPreview: options.appendWorkspaceSessionPreview || (() => {}),
      updateUI: options.updateUI || (() => {}),
      scheduleRender: options.scheduleRender || (() => {}),
      registerTaskBlocks: options.registerTaskBlocks || (() => {}),
    };
  }

  function updateStreamBlock(block, evt, ctx) {
    if (!block) return false;
    if (evt.delta?.type === 'text_delta') {
      block.text += evt.delta.text || '';
      ctx.appendWorkspaceSessionPreview(ctx.currentSessionId, evt.delta.text || '');
    } else if (evt.delta?.type === 'thinking_delta') {
      block.thinking += evt.delta.thinking || '';
      ctx.appendWorkspaceSessionPreview(ctx.currentSessionId, evt.delta.thinking || '');
    } else if (evt.delta?.type === 'input_json_delta') {
      block.input += evt.delta.partial_json || '';
      ctx.appendWorkspaceSessionPreview(ctx.currentSessionId, evt.delta.partial_json || '');
    }
    return true;
  }

  function finishStreamBlock(block) {
    if (!block) return null;
    if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking };
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'tool_use') {
      let input = block.input;
      try { input = JSON.parse(input); } catch (e) {}
      return { type: 'tool_use', name: block.name, id: block.id, input };
    }
    return null;
  }

  function handleStreamEvent(data, options = {}) {
    const ctx = getContext(options);
    const evt = data?.event;
    if (!evt) return;

    if (evt.type === 'message_start') ctx.setWorkspaceSessionPreview(ctx.currentSessionId, '');
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      ctx.appendWorkspaceSessionPreview(ctx.currentSessionId, `\n> ${evt.content_block.name || ctx.t('tool')}\n`);
    }

    ctx.setIsResponding(true);
    ctx.setCurrentTurnHasAssistantOutput(true);
    const isToolStart = evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use';
    ctx.updateWorkspaceSessionStatus(ctx.currentSessionId, isToolStart ? 'tool' : 'running', isToolStart ? ctx.t('tool') : ctx.t('streamingReply'));
    ctx.updateUI();

    const streamBlocks = ctx.getStreamBlocks();
    const currentContent = ctx.getCurrentContent();

    switch (evt.type) {
      case 'message_start':
        if (!ctx.currentAssistantEl) {
          ctx.cleanupStaleAssistantStreamingBubbles();
          ctx.setCurrentAssistantEl(ctx.createAssistantBubble());
          ctx.setCurrentContent([]);
          ctx.setStreamBlocks({});
          ctx.setCurrentTurnStartedAt(Date.now());
          ctx.startTurnTimer();
        }
        break;

      case 'content_block_start': {
        const idx = evt.index;
        const blockType = evt.content_block?.type;
        streamBlocks[idx] = {
          type: blockType,
          text: '',
          thinking: '',
          input: '',
          name: evt.content_block?.name || '',
          id: evt.content_block?.id || '',
        };
        break;
      }

      case 'content_block_delta': {
        if (updateStreamBlock(streamBlocks[evt.index], evt, ctx)) ctx.scheduleRender();
        break;
      }

      case 'content_block_stop': {
        const block = finishStreamBlock(streamBlocks[evt.index]);
        if (block) {
          currentContent.push(block);
          if (block.type === 'tool_use') ctx.registerTaskBlocks([block]);
          delete streamBlocks[evt.index];
        }
        ctx.scheduleRender();
        break;
      }
    }
  }

  root.streamEvents = {
    handleStreamEvent,
    updateStreamBlock,
    finishStreamBlock,
  };
})();
