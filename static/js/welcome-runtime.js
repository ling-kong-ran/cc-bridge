(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || root.formatters?.esc || ((value) => String(value ?? '')),
      shortenPlainPath: options.shortenPlainPath || root.formatters?.shortenPlainPath || ((value) => value || ''),
      openPicker: options.openPicker || (() => {}),
      cwdInput: options.cwdInput || document.getElementById('cwd'),
      modelSelect: options.modelSelect || document.getElementById('model-select'),
      cliSelect: options.cliSelect || document.getElementById('cli-select'),
      remoteTargetSelect: options.remoteTargetSelect || document.getElementById('remote-target-select'),
      welcomeRuntimeEl: options.welcomeRuntimeEl || document.getElementById('welcome-runtime'),
    };
  }

  function renderSelectOptions(selectEl, esc) {
    return Array.from(selectEl?.options || [])
      .map(opt => `<option value="${esc(opt.value)}" ${opt.selected ? 'selected' : ''}>${esc(opt.textContent || opt.value)}</option>`)
      .join('');
  }

  function bindRuntimeSelect(el, selector, targetSelect) {
    el.querySelector(selector)?.addEventListener('change', (e) => {
      if (!targetSelect) return;
      targetSelect.value = e.target.value;
      targetSelect.dispatchEvent(new Event('change'));
    });
  }

  function renderWelcomeRuntime(options = {}) {
    const ctx = getContext(options);
    const el = ctx.welcomeRuntimeEl;
    if (!el) return;

    const cwd = ctx.cwdInput?.value?.trim() || '';
    const modelOptions = renderSelectOptions(ctx.modelSelect, ctx.esc);
    const cliOptions = renderSelectOptions(ctx.cliSelect, ctx.esc);
    const remoteOptions = renderSelectOptions(ctx.remoteTargetSelect, ctx.esc);

    el.innerHTML = `
      <button type="button" class="welcome-runtime-row welcome-runtime-action" data-action="browse-cwd">
        <span>${ctx.esc(ctx.t('cwd'))}</span><strong title="${ctx.esc(cwd || ctx.t('unsetCwd'))}">${ctx.esc(ctx.shortenPlainPath(cwd, 4) || ctx.t('unsetCwd'))}</strong>
      </button>
      <label class="welcome-runtime-row welcome-runtime-field">
        <span>${ctx.esc(ctx.t('cliTool'))}</span><select class="welcome-runtime-select" data-runtime="cli">${cliOptions}</select>
      </label>
      <label class="welcome-runtime-row welcome-runtime-field">
        <span>${ctx.esc(ctx.t('model'))}</span><select class="welcome-runtime-select" data-runtime="model">${modelOptions}</select>
      </label>
      <label class="welcome-runtime-row welcome-runtime-field">
        <span>${ctx.esc(ctx.t('remote'))}</span><select class="welcome-runtime-select" data-runtime="remote">${remoteOptions}</select>
      </label>`;

    el.querySelector('[data-action="browse-cwd"]')?.addEventListener('click', () => ctx.openPicker());
    bindRuntimeSelect(el, '[data-runtime="cli"]', ctx.cliSelect);
    bindRuntimeSelect(el, '[data-runtime="model"]', ctx.modelSelect);
    bindRuntimeSelect(el, '[data-runtime="remote"]', ctx.remoteTargetSelect);
  }

  root.welcomeRuntime = {
    renderWelcomeRuntime,
  };
})();
