(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      formatCompactDuration: options.formatCompactDuration || ((ms) => String(ms || '')),
      getCurrentAssistantEl: options.getCurrentAssistantEl || (() => options.currentAssistantEl || null),
      getCurrentTurnStartedAt: options.getCurrentTurnStartedAt || (() => Number(options.currentTurnStartedAt || 0)),
      getTimer: options.getTimer || (() => options.timer || null),
      setTimer: options.setTimer || (() => {}),
      setInterval: options.setInterval || window.setInterval.bind(window),
      clearInterval: options.clearInterval || window.clearInterval.bind(window),
    };
  }

  function updateAssistantMeta(state = 'running', durationMs = null, options = {}) {
    const ctx = getContext(options);
    const assistantEl = ctx.getCurrentAssistantEl();
    if (!assistantEl) return;
    const meta = assistantEl.querySelector('.msg-meta');
    if (!meta) return;
    const elapsed = durationMs === null ? Date.now() - ctx.getCurrentTurnStartedAt() : Number(durationMs || 0);
    const duration = state === 'running' ? ctx.formatCompactDuration(Math.max(1000, elapsed)) : ctx.formatCompactDuration(elapsed);
    meta.textContent = duration ? ctx.t(state === 'done' ? 'responseDuration' : 'responseRunning', { duration }) : '';
  }

  function startTurnTimer(options = {}) {
    const ctx = getContext(options);
    stopTurnTimer(options);
    updateAssistantMeta('running', null, options);
    ctx.setTimer(ctx.setInterval(() => updateAssistantMeta('running', null, options), 1000));
  }

  function stopTurnTimer(options = {}) {
    const ctx = getContext(options);
    const timer = ctx.getTimer();
    if (!timer) return;
    ctx.clearInterval(timer);
    ctx.setTimer(null);
  }

  root.turnTimer = {
    updateAssistantMeta,
    startTurnTimer,
    stopTurnTimer,
  };
})();
