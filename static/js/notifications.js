(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      summarizePrompt: options.summarizePrompt || ((text) => String(text || '')),
      formatDuration: options.formatDuration || (() => ''),
      formatUsd: options.formatUsd || (() => ''),
      getProjectName: options.getProjectName || ((cwd, fallback = '') => cwd || fallback),
      getDisplayModelName: options.getDisplayModelName || ((model) => model || ''),
      getNotificationsEnabled: options.getNotificationsEnabled || (() => Boolean(options.notificationsEnabled)),
      getLastNotifyAt: options.getLastNotifyAt || (() => Number(options.lastNotifyAt || 0)),
      setLastNotifyAt: options.setLastNotifyAt || (() => {}),
      getCwd: options.getCwd || (() => ''),
      getModelValue: options.getModelValue || (() => options.modelValue || ''),
      getCurrentTurnContent: options.getCurrentTurnContent || (() => options.currentTurnContent || ''),
      pageIsUnfocused: options.pageIsUnfocused || (() => document.visibilityState === 'hidden' || !document.hasFocus()),
      Notification: options.Notification || window.Notification,
      focusWindow: options.focusWindow || (() => window.focus()),
      setTimeout: options.setTimeout || window.setTimeout.bind(window),
      console: options.console || window.console,
    };
  }

  function pageIsUnfocused() {
    return document.visibilityState === 'hidden' || !document.hasFocus();
  }

  function notifyComplete(kind, detail = {}, options = {}) {
    const ctx = getContext(options);
    const NotificationCtor = ctx.Notification;
    if (!ctx.getNotificationsEnabled() || !NotificationCtor || NotificationCtor.permission !== 'granted' || !ctx.pageIsUnfocused()) {
      return;
    }

    const now = Date.now();
    if (now - ctx.getLastNotifyAt() < 1500) return;
    ctx.setLastNotifyAt(now);

    const project = ctx.getProjectName(ctx.getCwd()) || ctx.t('appSubtitleShort');
    const model = detail.model || ctx.getDisplayModelName(ctx.getModelValue()) || '';
    const duration = ctx.formatDuration(detail.durationMs || 0);
    const cost = ctx.formatUsd(detail.costUsd || 0);
    const prompt = ctx.summarizePrompt(detail.prompt || ctx.getCurrentTurnContent() || '');
    const meta = [model, duration, cost].filter(Boolean).join(' · ');

    let title = ctx.t('notifyTurnTitle', { project, model: model || ctx.t('model') });
    let body = [
      prompt ? ctx.t('notifyPromptLine', { prompt }) : ctx.t('notifyTurnBody', { project }),
      meta,
    ].filter(Boolean).join('\n');

    if (kind === 'subagent') {
      const agent = detail.agent || ctx.t('subagent');
      const task = ctx.summarizePrompt(detail.task || '');
      title = ctx.t('notifySubagentTitle', { agent });
      body = [task ? ctx.t('notifyTaskLine', { task }) : ctx.t('notifySubagentBody', { agent, task: project }), meta].filter(Boolean).join('\n');
    } else if (kind === 'process') {
      body = [ctx.t('notifyFallbackBody', { project }), meta].filter(Boolean).join('\n');
    }

    try {
      const notification = new NotificationCtor(title, { body, tag: `cc-bridge-${kind}`, renotify: true });
      notification.onclick = () => {
        try { ctx.focusWindow(); } catch (e) { /* ignore */ }
        notification.close();
      };
      ctx.setTimeout(() => notification.close(), 8000);
    } catch (e) { ctx.console.warn('Notification creation failed:', e); }
  }

  root.notifications = {
    pageIsUnfocused,
    notifyComplete,
  };
})();
