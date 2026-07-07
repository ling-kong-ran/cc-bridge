(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      getTimer: options.getTimer || (() => options.timer || null),
      setTimer: options.setTimer || (() => {}),
      clearTimeout: options.clearTimeout || window.clearTimeout.bind(window),
      setTimeout: options.setTimeout || window.setTimeout.bind(window),
      getCurrentSessionId: options.getCurrentSessionId || (() => options.currentSessionId || ''),
      getIsResponding: options.getIsResponding || (() => Boolean(options.isResponding)),
      getCwd: options.getCwd || (() => ''),
      reloadSessionHistory: options.reloadSessionHistory || (() => {}),
      delay: Number.isFinite(options.delay) ? options.delay : 600,
    };
  }

  function clearCompletionHistorySync(options = {}) {
    const ctx = getContext(options);
    const timer = ctx.getTimer();
    if (!timer) return;
    ctx.clearTimeout(timer);
    ctx.setTimer(null);
  }

  function scheduleCompletionHistorySync(sessionId, options = {}) {
    if (!sessionId) return;
    const ctx = getContext(options);
    clearCompletionHistorySync(options);
    const timer = ctx.setTimeout(() => {
      ctx.setTimer(null);
      if (sessionId === ctx.getCurrentSessionId() && !ctx.getIsResponding()) {
        ctx.reloadSessionHistory(sessionId, ctx.getCwd());
      }
    }, ctx.delay);
    ctx.setTimer(timer);
  }

  root.completionSync = {
    clearCompletionHistorySync,
    scheduleCompletionHistorySync,
  };
})();
