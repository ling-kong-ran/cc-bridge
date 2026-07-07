(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || ((str) => String(str || '')),
      fetch: options.fetch || window.fetch.bind(window),
      addSystemMsg: options.addSystemMsg || (() => {}),
      renderModelPill: options.renderModelPill || (() => {}),
      renderWelcomeRuntime: options.renderWelcomeRuntime || (() => {}),
      renderTopbarSessionActions: options.renderTopbarSessionActions || (() => {}),
      renderTopbarStatusSummary: options.renderTopbarStatusSummary || (() => {}),
      getDisplayModelName: options.getDisplayModelName || ((model) => model || ''),
      formatModelName: options.formatModelName || ((model) => model || ''),
      getSavedModelPref: options.getSavedModelPref || (() => ''),
      setSavedModelPref: options.setSavedModelPref || (() => {}),
      getCliInstallPromptShown: options.getCliInstallPromptShown || (() => false),
      setCliInstallPromptShown: options.setCliInstallPromptShown || (() => {}),
      setCliInstallCommand: options.setCliInstallCommand || (() => {}),
      openCliInstallModal: options.openCliInstallModal || (() => {}),
      renderInputStatus: options.renderInputStatus || (() => {}),
      loadSlashCommands: options.loadSlashCommands || (() => {}),
      getCurrentSessionId: options.getCurrentSessionId || (() => ''),
      modelSelect: options.modelSelect || document.getElementById('model-select'),
      topbarModel: options.topbarModel || document.getElementById('topbar-model'),
      costDisplay: options.costDisplay || document.getElementById('cost-display'),
      costValue: options.costValue || document.getElementById('cost-value'),
      tokenDisplay: options.tokenDisplay || document.getElementById('token-display'),
      tokenValue: options.tokenValue || document.getElementById('token-value'),
    };
  }

  function hasModelOption(model, options = {}) {
    const ctx = getContext(options);
    if (!model || !ctx.modelSelect) return false;
    for (const opt of ctx.modelSelect.options) {
      if (opt.value === model) return true;
    }
    return false;
  }

  function renderCost(totalCost = 0, options = {}) {
    const ctx = getContext(options);
    if (ctx.costDisplay) ctx.costDisplay.style.display = totalCost > 0 ? 'block' : 'none';
    if (ctx.costValue) ctx.costValue.textContent = Number(totalCost || 0).toFixed(4);
    ctx.renderTopbarStatusSummary();
  }

  function renderTokens(totalTokens, options = {}) {
    const ctx = getContext(options);
    const formatters = root.formatters;
    const total = formatters?.tokenUsageTotal ? formatters.tokenUsageTotal(totalTokens) : 0;
    if (ctx.tokenDisplay) ctx.tokenDisplay.style.display = total > 0 ? 'block' : 'none';
    if (ctx.tokenValue) ctx.tokenValue.textContent = formatters?.formatTokenUsage ? formatters.formatTokenUsage(totalTokens, ctx.t) : '0';
    ctx.renderTopbarStatusSummary();
  }

  function formatTopbarSessionId(sessionId) {
    if (!sessionId) return '-';
    return sessionId.length > 13 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId;
  }

  function getSelectedCliLabel() {
    const cliSelect = document.getElementById('cli-select');
    const opt = cliSelect?.selectedOptions?.[0];
    return opt?.textContent?.trim() || opt?.value || '-';
  }

  function quoteCommandArg(value) {
    const text = String(value || '');
    if (!text) return '';
    return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
  }

  function getResumeCommandText(options = {}) {
    const ctx = getContext(options);
    const currentSessionId = ctx.getCurrentSessionId();
    if (!currentSessionId) return '';
    const cliSelect = document.getElementById('cli-select');
    const cli = cliSelect?.value || getSelectedCliLabel();
    return `${quoteCommandArg(cli)} --resume ${quoteCommandArg(currentSessionId)}`;
  }

  async function copyResumeCommand(options = {}) {
    const ctx = getContext(options);
    const text = getResumeCommandText(options);
    if (!text) {
      ctx.addSystemMsg(ctx.t('noSession'), true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      ctx.addSystemMsg(ctx.t('resumeCommandCopied'));
    } catch (e) {
      ctx.addSystemMsg(ctx.t('copyFailed'), true);
    }
  }

  function renderTopbarMeta(modelOverride = '', options = {}) {
    const ctx = getContext(options);
    const modelLabel = ctx.getDisplayModelName(modelOverride || ctx.modelSelect?.value || '') || ctx.t('noSession');
    if (ctx.topbarModel) ctx.topbarModel.textContent = modelLabel;
    ctx.renderTopbarSessionActions();
  }

  async function loadClis(options = {}) {
    const ctx = getContext(options);
    const cliSelect = document.getElementById('cli-select');
    const guideBtn = document.getElementById('btn-cli-install-guide');
    if (!cliSelect) return;
    try {
      const resp = await ctx.fetch('/api/clis');
      const data = await resp.json();
      const available = data.available || [];
      const current = data.current || '';
      if (data.install_command) ctx.setCliInstallCommand(data.install_command);
      cliSelect.innerHTML = '';
      if (available.length === 0) {
        cliSelect.innerHTML = `<option value="">${ctx.esc(ctx.t('noCli'))}</option>`;
        if (guideBtn) guideBtn.style.display = '';
        if (!ctx.getCliInstallPromptShown()) {
          ctx.setCliInstallPromptShown(true);
          ctx.openCliInstallModal();
        }
        renderTopbarMeta('', options);
        ctx.renderInputStatus();
        return;
      }
      if (guideBtn) guideBtn.style.display = 'none';
      for (const cli of available) {
        const opt = document.createElement('option');
        opt.value = cli.path;
        opt.textContent = `${cli.name}`;
        opt.title = cli.path;
        if (cli.path === current) opt.selected = true;
        cliSelect.appendChild(opt);
      }
      cliSelect.onchange = async () => {
        await ctx.fetch('/api/clis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: cliSelect.value }),
        });
        renderTopbarMeta('', options);
        ctx.renderWelcomeRuntime();
        ctx.addSystemMsg(ctx.t('cliSwitched', { path: cliSelect.value }));
        ctx.loadSlashCommands();
      };
      renderTopbarMeta('', options);
    } catch (e) { /* ignore */ }
  }

  function selectCli(path, options = {}) {
    const ctx = getContext(options);
    const cliSelect = document.getElementById('cli-select');
    if (!cliSelect || !path) return false;
    const has = Array.from(cliSelect.options).some(o => o.value === path);
    if (!has || cliSelect.value === path) return has && cliSelect.value === path;
    cliSelect.value = path;
    ctx.fetch('/api/clis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).catch(() => {});
    renderTopbarMeta('', options);
    ctx.renderWelcomeRuntime();
    return true;
  }

  async function loadModels(options = {}) {
    const ctx = getContext(options);
    if (!ctx.modelSelect) return;
    const previousModel = ctx.modelSelect.value || ctx.getSavedModelPref();
    try {
      const resp = await ctx.fetch('/api/models');
      const raw = await resp.json();
      const items = Array.isArray(raw) ? raw : [];
      const availableModels = items.map(item => typeof item === 'string' ? { value: item, label: ctx.formatModelName(item), profile: '' } : item);
      if (!availableModels.length) {
        ctx.modelSelect.innerHTML = '<option value="claude-sonnet-4-6">Sonnet 4.6</option>';
        ctx.renderModelPill();
        ctx.renderWelcomeRuntime();
        return;
      }
      const modelValues = availableModels.map(m => m.value);
      ctx.modelSelect.innerHTML = availableModels.map((m, idx) => (
        `<option value="${ctx.esc(m.value)}" ${(previousModel ? m.value === previousModel : idx === 0) ? 'selected' : ''}>${ctx.esc(m.label)}</option>`
      )).join('');
      if (previousModel && !modelValues.includes(previousModel)) {
        ctx.modelSelect.value = availableModels[0]?.value || '';
      }
      ctx.renderModelPill();
      ctx.renderWelcomeRuntime();
    } catch (e) {
      ctx.modelSelect.innerHTML = '<option value="claude-sonnet-4-6">Sonnet 4.6</option>';
      ctx.renderModelPill();
      ctx.renderWelcomeRuntime();
    }
  }

  root.runtime = {
    hasModelOption,
    renderCost,
    renderTokens,
    formatTopbarSessionId,
    getSelectedCliLabel,
    quoteCommandArg,
    getResumeCommandText,
    copyResumeCommand,
    renderTopbarMeta,
    loadClis,
    selectCli,
    loadModels,
  };
})();
