(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || root.formatters?.esc || ((value) => String(value ?? '')),
      shortenPlainPath: options.shortenPlainPath || root.formatters?.shortenPlainPath || ((value) => value || ''),
      openPicker: options.openPicker || (() => {}),
      addSystemMsg: options.addSystemMsg || root.messages?.addSystemMsg || window.addSystemMsg || (() => {}),
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

  function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
  }

  function renderMobileAccessRow(ctx, state = {}) {
    const url = state.url || '';
    const value = url || ctx.t('mobileAccessUnavailable');
    const action = url
      ? `<button type="button" class="welcome-runtime-copy" data-action="copy-mobile-url">${ctx.esc(ctx.t('copy'))}</button>`
      : '';
    return `
      <div class="welcome-runtime-row welcome-runtime-mobile ${url ? '' : 'is-muted'}" data-mobile-access-row="1">
        <span>${ctx.esc(ctx.t('mobileAccess'))}</span>
        <div class="welcome-runtime-value">
          <strong title="${ctx.esc(value)}">${ctx.esc(value)}</strong>
          ${action}
        </div>
      </div>`;
  }

  async function refreshMobileAccess(el, ctx) {
    const row = el.querySelector('[data-mobile-access-row]');
    try {
      const data = await root.api.json('/api/mobile-access');
      const url = data.lan_access_enabled === false ? '' : (data.url || (data.urls || [])[0] || '');
      const wrapper = document.createElement('div');
      wrapper.innerHTML = renderMobileAccessRow(ctx, { url });
      const nextRow = wrapper.firstElementChild;
      row?.replaceWith(nextRow);
      bindMobileAccessCopy(el, ctx, url);
    } catch (e) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = renderMobileAccessRow(ctx, { url: '' });
      const nextRow = wrapper.firstElementChild;
      row?.replaceWith(nextRow);
    }
  }

  function bindMobileAccessCopy(el, ctx, url) {
    el.querySelector('[data-action="copy-mobile-url"]')?.addEventListener('click', async () => {
      if (!url) return;
      try {
        await copyText(url);
        ctx.addSystemMsg(ctx.t('mobileAccessCopied'));
      } catch (e) {
        ctx.addSystemMsg(ctx.t('copyFailed'), true);
      }
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
      </label>
      ${renderMobileAccessRow(ctx)}`;

    el.querySelector('[data-action="browse-cwd"]')?.addEventListener('click', () => ctx.openPicker());
    bindRuntimeSelect(el, '[data-runtime="cli"]', ctx.cliSelect);
    bindRuntimeSelect(el, '[data-runtime="model"]', ctx.modelSelect);
    bindRuntimeSelect(el, '[data-runtime="remote"]', ctx.remoteTargetSelect);
    refreshMobileAccess(el, ctx);
  }

  root.welcomeRuntime = {
    renderWelcomeRuntime,
  };
})();
