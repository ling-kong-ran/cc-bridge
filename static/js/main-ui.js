(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      setSidebarCollapsed: options.setSidebarCollapsed || root.statusbar?.setSidebarCollapsed || (() => {}),
      getState: options.getState || (() => ({
        sessionActive: false,
        isResponding: false,
        isViewer: false,
        sidebarCollapsed: false,
      })),
      setState: options.setState || (() => {}),
      btnSend: options.btnSend || document.getElementById('btn-send'),
      btnStop: options.btnStop || document.getElementById('btn-stop'),
      btnNewSession: options.btnNewSession || document.getElementById('btn-new-session'),
      modelSelect: options.modelSelect || document.getElementById('model-select'),
      remoteTargetSelect: options.remoteTargetSelect || document.getElementById('remote-target-select'),
      inputEl: options.inputEl || document.getElementById('message-input'),
      skipPermissions: options.skipPermissions || document.getElementById('skip-permissions'),
      body: options.body || document.body,
      cliSelect: options.cliSelect || document.getElementById('cli-select'),
    };
  }

  function updateUI(options = {}) {
    const ctx = getContext(options);
    const state = ctx.getState();
    let sidebarCollapsed = !!state.sidebarCollapsed;
    if (ctx.btnSend) ctx.btnSend.disabled = !state.sessionActive;
    if (ctx.btnStop) {
      ctx.btnStop.classList.toggle('visible', !!state.isResponding);
      ctx.btnStop.disabled = !!state.isViewer;
    }
    if (ctx.btnNewSession) ctx.btnNewSession.innerHTML = `<span class="btn-prefix">&gt;</span> ${state.sessionActive ? ctx.t('restartSession') : ctx.t('newSession')}`;
    ctx.body?.classList.toggle('has-active-session', !!state.sessionActive);
    if (!state.sessionActive && sidebarCollapsed) {
      sidebarCollapsed = false;
      ctx.setState({ sidebarCollapsed });
    }
    ctx.setSidebarCollapsed(sidebarCollapsed);
    if (ctx.cliSelect) ctx.cliSelect.disabled = false;
    if (ctx.modelSelect) ctx.modelSelect.disabled = false;
    if (ctx.skipPermissions) ctx.skipPermissions.disabled = !!state.sessionActive;
    if (ctx.remoteTargetSelect) ctx.remoteTargetSelect.disabled = false;
    if (ctx.inputEl) {
      ctx.inputEl.disabled = !state.sessionActive;
      ctx.inputEl.style.opacity = state.sessionActive ? '1' : '0.5';
      ctx.inputEl.placeholder = state.isResponding
        ? (ctx.t('respondingPlaceholder') || 'Waiting for response...')
        : (ctx.t('messagePlaceholder') || 'Type a message...');
    }
  }

  root.mainUi = {
    updateUI,
  };
})();
