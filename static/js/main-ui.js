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
    if (ctx.btnNewSession) {
      const label = state.sessionActive ? ctx.t('restartSession') : ctx.t('newSession');
      ctx.btnNewSession.innerHTML = `<span class="new-session-icon" aria-hidden="true">+</span><span>${label}</span>`;
    }
    ctx.body?.classList.toggle('has-active-session', !!state.sessionActive);
    if (!state.sessionActive && sidebarCollapsed) {
      sidebarCollapsed = false;
      ctx.setState({ sidebarCollapsed });
    }
    ctx.setSidebarCollapsed(sidebarCollapsed);
    if (ctx.cliSelect) ctx.cliSelect.disabled = false;
    if (ctx.modelSelect) ctx.modelSelect.disabled = false;
    if (ctx.skipPermissions) ctx.skipPermissions.disabled = !!state.isResponding;
    if (ctx.remoteTargetSelect) ctx.remoteTargetSelect.disabled = false;
    if (ctx.inputEl) {
      ctx.inputEl.disabled = !state.sessionActive;
      ctx.inputEl.style.opacity = state.sessionActive ? '1' : '0.5';
      const imageMode = !!window.CCBridge?.imageGeneration?.isImageModeActive?.();
      ctx.inputEl.placeholder = state.isResponding
        ? (ctx.t('respondingPlaceholder') || 'Waiting for response...')
        : imageMode
          ? (ctx.t('imageModePlaceholder') || 'Describe the image to generate...')
          : (ctx.t('messagePlaceholder') || 'Type a message...');
    }
  }

  function initVariantTweaks(options = {}) {
    const doc = options.document || document;
    const body = options.body || doc.body;
    const buttons = Array.from(doc.querySelectorAll('[data-set-variant]'));
    if (!body || !buttons.length) return;

    const applyVariant = (variant) => {
      body.dataset.variant = variant || 'calm';
      buttons.forEach((button) => {
        button.classList.toggle('active', button.dataset.setVariant === body.dataset.variant);
      });
    };

    buttons.forEach((button) => {
      button.addEventListener('click', () => applyVariant(button.dataset.setVariant));
    });
    applyVariant(body.dataset.variant || 'calm');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initVariantTweaks(), { once: true });
  } else {
    initVariantTweaks();
  }

  root.mainUi = {
    updateUI,
    initVariantTweaks,
  };
})();
