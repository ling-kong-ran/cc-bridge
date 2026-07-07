(function () {
  const root = window.CCBridge = window.CCBridge || {};
  let pickerCurrentDir = '/';
  let pickerCallback = null;

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || ((str) => String(str || '')),
      getParentPath: options.getParentPath || getParentPath,
      cwdInput: options.cwdInput || document.getElementById('cwd'),
      pickerOverlay: options.pickerOverlay || document.getElementById('dir-picker-overlay'),
      pickerList: options.pickerList || document.getElementById('picker-list'),
      pickerCurrentPath: options.pickerCurrentPath || document.getElementById('picker-current-path'),
      pickerUp: options.pickerUp || document.getElementById('picker-up'),
      pickerClose: options.pickerClose || document.getElementById('picker-close'),
      pickerSelect: options.pickerSelect || document.getElementById('picker-select'),
      pickerNewdir: options.pickerNewdir || document.getElementById('picker-newdir'),
      btnBrowse: options.btnBrowse || document.getElementById('btn-browse'),
      isSessionActive: options.isSessionActive || (() => !!options.sessionActive),
      getCurrentSessionId: options.getCurrentSessionId || (() => options.currentSessionId || ''),
      promptCwdForSession: options.promptCwdForSession,
      updateSessionCwd: options.updateSessionCwd,
      updateRuntimeSummary: options.updateRuntimeSummary,
      closeSlashCommandPanel: options.closeSlashCommandPanel,
      loadSessions: options.loadSessions,
    };
  }

  function initDirectoryPicker(options = {}) {
    const ctx = getContext(options);
    ctx.btnBrowse?.addEventListener('click', async () => {
      const currentSessionId = ctx.getCurrentSessionId();
      if (ctx.isSessionActive() && currentSessionId) {
        const newCwd = await ctx.promptCwdForSession?.(ctx.cwdInput?.value.trim() || '');
        if (newCwd) await ctx.updateSessionCwd?.(currentSessionId, newCwd);
        return;
      }
      openPicker(null, null, options);
    });
    ctx.pickerClose?.addEventListener('click', () => closePicker(options));
    ctx.pickerOverlay?.addEventListener('click', (e) => {
      if (e.target === ctx.pickerOverlay) closePicker(options);
    });
    ctx.pickerUp?.addEventListener('click', () => {
      navigatePicker(pickerCurrentDir === '/' ? '/' : ctx.getParentPath(pickerCurrentDir), options);
    });
    ctx.pickerSelect?.addEventListener('click', () => selectCurrentDirectory(options));
    ctx.pickerNewdir?.addEventListener('click', () => createDirectory(options));
  }

  function selectCurrentDirectory(options = {}) {
    const ctx = getContext(options);
    if (pickerCallback) {
      const cb = pickerCallback;
      pickerCallback = null;
      cb(pickerCurrentDir);
      closePicker(options);
      return;
    }
    if (ctx.cwdInput) ctx.cwdInput.value = pickerCurrentDir;
    ctx.updateRuntimeSummary?.();
    ctx.closeSlashCommandPanel?.();
    ctx.loadSessions?.();
    closePicker(options);
  }

  async function createDirectory(options = {}) {
    const ctx = getContext(options);
    const parent = pickerCurrentDir;
    if (!parent || parent === '/') {
      alert(ctx.t('newFolderNeedDir'));
      return;
    }
    const name = prompt(ctx.t('newFolderPrompt'));
    if (name === null) return;
    if (!name.trim()) return;
    try {
      const resp = await fetch('/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent, name: name.trim() }),
      });
      const data = await resp.json();
      if (!data.ok) {
        alert(data.error || ctx.t('requestFailed', { message: '' }));
        return;
      }
      await navigatePicker(parent, options);
    } catch (e) {
      alert(ctx.t('requestFailed', { message: e.message }));
    }
  }

  function openPicker(initialPath, callback, options = {}) {
    const ctx = getContext(options);
    if (!ctx.pickerOverlay) return;
    ctx.pickerOverlay.style.display = 'flex';
    if (callback) pickerCallback = callback;
    navigatePicker(initialPath || ctx.cwdInput?.value || '/', options);
  }

  function closePicker(options = {}) {
    const ctx = getContext(options);
    const cb = pickerCallback;
    if (ctx.pickerOverlay) ctx.pickerOverlay.style.display = 'none';
    pickerCallback = null;
    if (cb) cb(null);
  }

  async function navigatePicker(path, options = {}) {
    const ctx = getContext(options);
    pickerCurrentDir = path;
    if (ctx.pickerCurrentPath) ctx.pickerCurrentPath.textContent = path || '/';
    if (ctx.pickerList) ctx.pickerList.innerHTML = `<div class="picker-empty">${ctx.esc(ctx.t('pickerLoading'))}</div>`;

    try {
      const resp = await fetch('/api/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await resp.json();

      if (data.error) {
        if (ctx.pickerList) ctx.pickerList.innerHTML = `<div class="picker-empty">${ctx.esc(data.error)}</div>`;
        return;
      }

      pickerCurrentDir = data.current || path;
      if (ctx.pickerCurrentPath) ctx.pickerCurrentPath.textContent = pickerCurrentDir;

      if (!data.items || data.items.length === 0) {
        if (ctx.pickerList) ctx.pickerList.innerHTML = `<div class="picker-empty">${ctx.esc(ctx.t('emptyDirFolders'))}</div>`;
        return;
      }

      if (!ctx.pickerList) return;
      ctx.pickerList.innerHTML = data.items.map(item => `
        <div class="picker-item ${item.type === 'drive' ? 'drive' : ''}" data-path="${ctx.esc(item.path)}">
          <span class="picker-item-icon">${item.type === 'drive' ? '&#128423;' : '&#128193;'}</span>
          <span class="picker-item-name">${ctx.esc(item.name)}</span>
        </div>
      `).join('');

      ctx.pickerList.querySelectorAll('.picker-item').forEach(el => {
        el.addEventListener('dblclick', () => navigatePicker(el.dataset.path, options));
        el.addEventListener('click', () => {
          ctx.pickerList.querySelectorAll('.picker-item').forEach(i => i.classList.remove('selected'));
          el.classList.add('selected');
          pickerCurrentDir = el.dataset.path;
          if (ctx.pickerCurrentPath) ctx.pickerCurrentPath.textContent = pickerCurrentDir;
        });
      });
    } catch (e) {
      if (ctx.pickerList) ctx.pickerList.innerHTML = `<div class="picker-empty">${ctx.esc(ctx.t('requestFailed', { message: e.message }))}</div>`;
    }
  }

  function getParentPath(p) {
    if (!p || p === '/') return '/';
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 1) return '/';
    parts.pop();
    if (parts.length === 1 && parts[0].endsWith(':')) return parts[0] + '/';
    return parts.join('/');
  }

  root.directoryPicker = {
    initDirectoryPicker,
    openPicker,
    closePicker,
    navigatePicker,
    getParentPath,
  };
})();
