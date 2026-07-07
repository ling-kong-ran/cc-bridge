(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      fetch: options.fetch || window.fetch.bind(window),
      console: options.console || window.console,
      messagesEl: options.messagesEl || document.getElementById('messages'),
      getCwd: options.getCwd || (() => ''),
      getAssistantState: options.getAssistantState || (() => ({})),
      setAssistantState: options.setAssistantState || (() => {}),
      resetAssistantStreamState: options.resetAssistantStreamState || (() => {}),
      renderHistory: options.renderHistory || (() => {}),
      toolResults: options.toolResults || null,
      toolStartTimes: options.toolStartTimes || null,
      captureActiveWorkspaceSnapshot: options.captureActiveWorkspaceSnapshot || (() => {}),
      addSystemMsg: options.addSystemMsg || (() => {}),
    };
  }

  function renderStaticHistory(history, options = {}) {
    const ctx = getContext(options);
    const previous = ctx.getAssistantState();
    ctx.resetAssistantStreamState();
    ctx.renderHistory(history);
    ctx.setAssistantState(previous);
  }

  async function fetchSessionHistory(sessionId, cwd, ctx) {
    const resp = await ctx.fetch('/api/sessions/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, cwd: cwd || ctx.getCwd() || '' }),
    });
    return resp.json();
  }

  async function loadSessionHistory(sessionId, cwd, options = {}) {
    const ctx = getContext(options);
    try {
      const history = await fetchSessionHistory(sessionId, cwd, ctx);
      if (history && history.length > 0) {
        renderStaticHistory(history, options);
      }
    } catch (e) {
      ctx.console.error('History load failed:', e);
    }
  }

  async function reloadSessionHistory(sessionId, cwd, options = {}) {
    const ctx = getContext(options);
    try {
      const history = await fetchSessionHistory(sessionId, cwd, ctx);
      if (!Array.isArray(history) || history.length === 0) return;
      const systemMessages = Array.from(ctx.messagesEl.querySelectorAll('.system-msg')).map(el => ({
        text: el.textContent || '',
        isError: el.classList.contains('error'),
      }));
      ctx.messagesEl.innerHTML = '';
      ctx.resetAssistantStreamState();
      ctx.toolResults?.clear?.();
      ctx.toolStartTimes?.clear?.();
      renderStaticHistory(history, options);
      ctx.captureActiveWorkspaceSnapshot();
      for (const msg of systemMessages) {
        if (msg.text) ctx.addSystemMsg(msg.text, msg.isError);
      }
    } catch (e) {
      ctx.console.error('History reload failed:', e);
    }
  }

  root.historyLoader = {
    renderStaticHistory,
    loadSessionHistory,
    reloadSessionHistory,
  };
})();
