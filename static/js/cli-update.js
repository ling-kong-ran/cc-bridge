(function () {
  const root = window.CCBridge = window.CCBridge || {};
  let defaultOptions = {};

  function getContext(options = {}) {
    options = { ...defaultOptions, ...options };
    return {
      t: options.t || ((key) => key),
      addSystemMsg: options.addSystemMsg || (() => {}),
      loadClis: options.loadClis || (() => {}),
      renderTopbarMeta: options.renderTopbarMeta || (() => {}),
      renderWelcomeRuntime: options.renderWelcomeRuntime || (() => {}),
      saveGuiSettings: options.saveGuiSettings || (() => {}),
      getCliInstallCommand: options.getCliInstallCommand || (() => options.cliInstallCommand || ''),
      setCliInstallPromptShown: options.setCliInstallPromptShown || (() => {}),
      getCliInstalling: options.getCliInstalling || (() => false),
      setCliInstalling: options.setCliInstalling || (() => {}),
      getUpdateRunning: options.getUpdateRunning || (() => false),
      setUpdateRunning: options.setUpdateRunning || (() => {}),
      getUpdateInfo: options.getUpdateInfo || (() => null),
      setUpdateInfo: options.setUpdateInfo || (() => {}),
      getSkipUpdateVersion: options.getSkipUpdateVersion || (() => ''),
      setSkipUpdateVersion: options.setSkipUpdateVersion || (() => {}),
      getAutoUpdateEnabled: options.getAutoUpdateEnabled || (() => false),
      setAutoUpdateEnabled: options.setAutoUpdateEnabled || (() => {}),
    };
  }

  function initCliUpdate(options = {}) {
    defaultOptions = { ...defaultOptions, ...options };
  }

  function openCliInstallModal(options = {}) {
    const ctx = getContext(options);
    const overlay = document.getElementById('cli-install-overlay');
    if (!overlay) return;
    const cmdEl = document.getElementById('cli-install-cmd');
    if (cmdEl) cmdEl.textContent = ctx.getCliInstallCommand();
    setCliInstallStatus('', '', options);
    const output = document.getElementById('cli-install-output');
    if (output) { output.style.display = 'none'; output.textContent = ''; }
    overlay.style.display = '';
  }

  function closeCliInstallModal() {
    const overlay = document.getElementById('cli-install-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function setCliInstallStatus(text, kind) {
    const status = document.getElementById('cli-install-status');
    if (!status) return;
    if (!text) { status.style.display = 'none'; status.textContent = ''; return; }
    status.style.display = '';
    status.textContent = text;
    status.className = `cli-install-status${kind ? ' ' + kind : ''}`;
  }

  async function copyCliInstallCommand(options = {}) {
    const ctx = getContext(options);
    let copied = false;
    const command = ctx.getCliInstallCommand();
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = command;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { copied = document.execCommand('copy'); } catch (e2) { /* ignore */ }
      ta.remove();
    }
    setCliInstallStatus(copied ? ctx.t('cmdCopied') : ctx.t('cmdCopyFailed'), copied ? 'ok' : 'err');
  }

  async function runCliAutoInstall(options = {}) {
    const ctx = getContext(options);
    if (ctx.getCliInstalling()) return;
    ctx.setCliInstalling(true);
    const runBtn = document.getElementById('cli-install-run');
    const output = document.getElementById('cli-install-output');
    if (runBtn) runBtn.disabled = true;
    setCliInstallStatus(ctx.t('cliInstalling'), '');
    try {
      const resp = await fetch('/api/install-cli', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await resp.json();
      if (output && result.output) {
        output.style.display = '';
        output.textContent = result.output;
        output.scrollTop = output.scrollHeight;
      }
      if (result.ok) {
        setCliInstallStatus(ctx.t('cliInstallSuccess'), 'ok');
        await ctx.loadClis();
        ctx.addSystemMsg(ctx.t('cliInstallSuccess'));
        setTimeout(closeCliInstallModal, 1200);
      } else {
        const reasons = {
          npm_not_found: ctx.t('cliInstallNpmMissing'),
          install_in_progress: ctx.t('cliInstallInProgress'),
          install_timeout: ctx.t('cliInstallTimeout'),
          cli_not_detected_after_install: ctx.t('cliInstallNotDetected'),
        };
        setCliInstallStatus(reasons[result.error] || ctx.t('cliInstallFailed'), 'err');
      }
    } catch (e) {
      setCliInstallStatus(ctx.t('cliInstallFailed'), 'err');
    } finally {
      ctx.setCliInstalling(false);
      if (runBtn) runBtn.disabled = false;
    }
  }

  function initCliInstallModal(options = {}) {
    initCliUpdate(options);
    document.getElementById('btn-cli-install-guide')?.addEventListener('click', () => openCliInstallModal());
    document.getElementById('cli-install-close')?.addEventListener('click', closeCliInstallModal);
    document.getElementById('cli-install-copy')?.addEventListener('click', () => copyCliInstallCommand());
    document.getElementById('cli-install-run')?.addEventListener('click', () => runCliAutoInstall());
    document.getElementById('cli-install-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeCliInstallModal();
    });
  }

  function setUpdateStatus(text, kind) {
    const status = document.getElementById('update-status');
    if (!status) return;
    if (!text) { status.style.display = 'none'; status.textContent = ''; return; }
    status.style.display = '';
    status.textContent = text;
    status.className = `cli-install-status${kind ? ' ' + kind : ''}`;
  }

  function openUpdateModal() {
    const overlay = document.getElementById('update-overlay');
    if (overlay) overlay.style.display = '';
  }

  function closeUpdateModal() {
    const overlay = document.getElementById('update-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function loadNavVersionBadge() {
    if (!window.ccBridgeDesktop?.getVersion) return;
    try {
      const version = await window.ccBridgeDesktop.getVersion();
      renderNavVersionBadge({ ok: true, local: version });
    } catch (e) { /* ignore */ }
  }

  function renderNavVersionBadge(data) {
    const badge = document.getElementById('nav-version-badge');
    const text = document.getElementById('nav-version-text');
    const dot = document.getElementById('nav-update-dot');
    if (!badge || !text) return;
    const localVersion = data?.local_short || data?.local || '';
    if (!localVersion) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = '';
    badge.classList.toggle('has-update', Boolean(data?.has_update));
    text.textContent = data?.has_update ? `${localVersion} → ${data.remote || ''}` : localVersion;
    badge.title = data?.has_update ? `更新可用：${data.remote || ''}` : `版本 ${localVersion}`;
    badge.setAttribute('aria-label', badge.title);
    if (dot) dot.style.display = data?.has_update ? '' : 'none';
  }

  async function promptAndRunUpdate(options = {}) {
    const ctx = getContext(options);
    const info = ctx.getUpdateInfo();
    if (!info?.has_update) return;
    const remote = info.remote || '';
    if (!window.confirm(ctx.t('updateConfirm', { version: remote }))) return;
    openUpdateModal();
    await runUpdate(options);
  }

  async function checkForUpdate(manual = false, options = {}) {
    const ctx = getContext(options);
    const checkBtn = document.getElementById('btn-check-update');
    const checkHint = document.getElementById('update-check-hint');
    const previousCheckText = checkBtn?.textContent || '';
    if (manual) {
      if (checkBtn) checkBtn.disabled = true;
      if (checkHint) {
        checkHint.textContent = ctx.t('updateCheckRunning');
        checkHint.className = 'update-check-hint';
      }
    }
    try {
      const data = window.ccBridgeDesktop?.checkUpdate
        ? await window.ccBridgeDesktop.checkUpdate()
        : await (async () => {
          const resp = await fetch('/api/check-update');
          return resp.json();
        })();
      ctx.setUpdateInfo(data);
      renderNavVersionBadge(data);
      if (!data.ok) {
        if (manual && checkHint) {
          checkHint.textContent = data.error ? `${ctx.t('updateFailed')}: ${data.error}` : ctx.t('updateFailed');
          checkHint.className = 'update-check-hint err';
        }
        return;
      }
      const versionEl = document.getElementById('app-version');
      if (versionEl) {
        const localVersion = data.local_short || data.local || '—';
        versionEl.textContent = data.needs_restart && data.server_start_short
          ? `${data.server_start_short} → ${localVersion}`
          : localVersion;
      }

      if (data.has_update && (manual || data.remote !== ctx.getSkipUpdateVersion())) {
        const changelog = document.getElementById('update-changelog');
        if (changelog) {
          if (data.commits) { changelog.style.display = ''; changelog.textContent = data.commits; }
          else { changelog.style.display = 'none'; changelog.textContent = ''; }
        }
        if (manual && checkHint) checkHint.textContent = '';
        setUpdateStatus('', '');
        const runBtn = document.getElementById('update-run');
        if (runBtn) runBtn.disabled = false;
        openUpdateModal();
      } else if (data.needs_restart) {
        const changelog = document.getElementById('update-changelog');
        if (changelog) {
          changelog.style.display = '';
          changelog.textContent = data.commits || `${data.server_start_short || ''} → ${data.local_short || ''}`;
        }
        if (manual) {
          if (checkHint) checkHint.textContent = '';
          setUpdateStatus(ctx.t('updateRestartNeeded'), '');
          const runBtn = document.getElementById('update-run');
          if (runBtn) runBtn.disabled = false;
          openUpdateModal();
        }
      } else if (manual && checkHint) {
        checkHint.textContent = ctx.t('updateUpToDate');
        checkHint.className = 'update-check-hint ok';
      }
    } catch (e) {
      if (manual && checkHint) {
        checkHint.textContent = ctx.t('updateFailed');
        checkHint.className = 'update-check-hint err';
      }
    } finally {
      if (manual && checkBtn) {
        checkBtn.disabled = false;
        checkBtn.textContent = previousCheckText || ctx.t('checkUpdate');
      }
    }
  }

  async function runUpdate(options = {}) {
    const ctx = getContext(options);
    if (ctx.getUpdateRunning()) return;
    ctx.setUpdateRunning(true);
    const runBtn = document.getElementById('update-run');
    if (runBtn) runBtn.disabled = true;
    setUpdateStatus(ctx.t('updateChecking'), '');
    try {
      const updateInfo = ctx.getUpdateInfo();
      if (window.ccBridgeDesktop?.installUpdate) {
        const result = await window.ccBridgeDesktop.installUpdate();
        if (!result.ok) {
          setUpdateStatus(result.error ? `${ctx.t('updateRestartManual')}: ${result.error}` : ctx.t('updateRestartManual'), 'err');
          if (runBtn) runBtn.disabled = false;
          return;
        }
      } else if (!updateInfo?.needs_restart || updateInfo?.has_update) {
        const resp = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const result = await resp.json();
        const changelog = document.getElementById('update-changelog');
        if (changelog && result.output) { changelog.style.display = ''; changelog.textContent = result.output; }
        if (!result.ok) {
          setUpdateStatus(ctx.t('updateRestartManual'), 'err');
          if (runBtn) runBtn.disabled = false;
          return;
        }
      }
      setUpdateStatus(ctx.t('updateSuccess'), 'ok');
      if (window.ccBridgeDesktop?.installUpdate) return;
      try {
        await fetch('/api/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      } catch (e) { /* 重启会断开连接，忽略 */ }
      waitForServerAndReload(0, options);
    } catch (e) {
      setUpdateStatus(ctx.t('updateFailed'), 'err');
      if (runBtn) runBtn.disabled = false;
    } finally {
      ctx.setUpdateRunning(false);
    }
  }

  function skipThisVersion(options = {}) {
    const ctx = getContext(options);
    const updateInfo = ctx.getUpdateInfo();
    if (updateInfo && updateInfo.remote) {
      ctx.setSkipUpdateVersion(updateInfo.remote);
      ctx.saveGuiSettings({ skip_update_version: updateInfo.remote });
    }
    closeUpdateModal();
  }

  async function waitForServerAndReload(attempt = 0, options = {}) {
    const ctx = getContext(options);
    if (attempt > 40) { setUpdateStatus(ctx.t('updateRestartManual'), 'err'); return; }
    try {
      const resp = await fetch('/api/gui-settings', { cache: 'no-store' });
      if (resp.ok) { location.reload(); return; }
    } catch (e) { /* 服务重启中，继续等待 */ }
    setTimeout(() => waitForServerAndReload(attempt + 1, options), 1500);
  }

  function initUpdateModal(options = {}) {
    initCliUpdate(options);
    loadNavVersionBadge();
    document.getElementById('update-close')?.addEventListener('click', closeUpdateModal);
    document.getElementById('update-skip')?.addEventListener('click', () => skipThisVersion());
    document.getElementById('update-run')?.addEventListener('click', () => runUpdate());
    document.getElementById('btn-check-update')?.addEventListener('click', () => checkForUpdate(true));
    document.getElementById('nav-version-badge')?.addEventListener('click', () => promptAndRunUpdate(options));
    document.getElementById('update-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeUpdateModal();
    });
    document.getElementById('auto-update-toggle')?.addEventListener('change', (e) => {
      ctxSetAutoUpdate(e.target.checked, options);
    });
  }

  function ctxSetAutoUpdate(enabled, options = {}) {
    const ctx = getContext(options);
    ctx.setAutoUpdateEnabled(enabled);
    ctx.saveGuiSettings({ auto_update_enabled: enabled });
  }

  root.cliUpdate = {
    initCliUpdate,
    openCliInstallModal,
    closeCliInstallModal,
    setCliInstallStatus,
    copyCliInstallCommand,
    runCliAutoInstall,
    initCliInstallModal,
    setUpdateStatus,
    openUpdateModal,
    closeUpdateModal,
    loadNavVersionBadge,
    renderNavVersionBadge,
    promptAndRunUpdate,
    checkForUpdate,
    runUpdate,
    skipThisVersion,
    waitForServerAndReload,
    initUpdateModal,
  };
})();
