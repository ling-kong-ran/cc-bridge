(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let currentDir = '/';
  let selected = new Map();
  let items = [];
  let visibleItems = [];
  let searchTimer = null;
  let searchSeq = 0;
  let mode = 'local';
  let callback = null;
  let initialized = false;
  let defaultOptions = {};

  function getContext(options = {}) {
    options = { ...defaultOptions, ...options };
    return {
      t: options.t || ((key) => key),
      esc: options.esc || ((str) => String(str || '')),
      api: options.api || root.api,
      getParentPath: options.getParentPath || ((p) => p || '/'),
      getAccessContext: options.getAccessContext || (() => options.accessContext || { isLocalhost: true, defaultCwd: '' }),
      getRemoteTargetValue: options.getRemoteTargetValue || (() => options.remoteTargetSelect?.value || ''),
      getRemoteTargetName: options.getRemoteTargetName || (() => ''),
      addSystemMsg: options.addSystemMsg || (() => {}),
      addAttachment: options.addAttachment || ((attachment) => root.input?.addAttachment?.(attachment, false)),
      renderAttachments: options.renderAttachments || (() => {}),
      overlay: options.filePickerOverlay || document.getElementById('file-picker-overlay'),
      list: options.filePickerList || document.getElementById('file-picker-list'),
      currentPath: options.filePickerCurrentPath || document.getElementById('file-picker-current-path'),
      up: options.filePickerUp || document.getElementById('file-picker-up'),
      close: options.filePickerClose || document.getElementById('file-picker-close'),
      confirm: options.filePickerConfirm || document.getElementById('file-picker-confirm'),
      selectAll: options.filePickerSelectAll || document.getElementById('file-picker-select-all'),
      selectedCount: options.filePickerSelectedCount || document.getElementById('file-picker-selected-count'),
      search: options.filePickerSearch || document.getElementById('file-picker-search'),
      tabs: options.filePickerTabs || document.getElementById('file-picker-tabs'),
      local: options.filePickerLocal || document.getElementById('file-picker-local'),
      browser: options.filePickerBrowser || document.getElementById('file-picker-browser'),
      clientChoose: options.filePickerClientChoose || document.getElementById('file-picker-client-choose'),
      serverBrowse: options.filePickerServerBrowse || document.getElementById('file-picker-server-browse'),
      localHint: options.filePickerLocalHint || document.getElementById('file-picker-local-hint'),
      fileInput: options.fileInput || document.getElementById('file-input'),
      cwdInput: options.cwdInput || document.getElementById('cwd-input'),
    };
  }

  function initFilePicker(options = {}) {
    defaultOptions = { ...defaultOptions, ...options };
    if (initialized) return;
    const ctx = getContext(options);
    if (!ctx.overlay || !ctx.close || !ctx.up || !ctx.confirm || !ctx.search) return;
    initialized = true;
    ctx.close.addEventListener('click', () => closeFilePicker(options));
    ctx.overlay.addEventListener('click', (e) => {
      if (e.target === ctx.overlay) closeFilePicker(options);
    });
    ctx.up.addEventListener('click', () => {
      navigateFilePicker(ctx.getParentPath(currentDir), options);
    });
    ctx.confirm.addEventListener('click', () => confirmFileSelection(options));
    ctx.selectAll?.addEventListener('click', () => toggleSelectAllVisibleFiles(options));
    ctx.search.addEventListener('input', () => handleFilePickerSearchInput(options));
    ctx.clientChoose?.addEventListener('click', () => ctx.fileInput?.click());
    ctx.serverBrowse?.addEventListener('click', () => setFilePickerMode('server', options));
  }

  function normalizeFilePickerMode(nextMode, options = {}) {
    const accessContext = getContext(options).getAccessContext();
    return accessContext.isLocalhost && nextMode === 'local' ? 'server' : nextMode;
  }

  function getAttachmentSources(options = {}) {
    const ctx = getContext(options);
    const accessContext = ctx.getAccessContext();
    const hasRemote = Boolean(ctx.getRemoteTargetValue());
    const sources = [];
    if (accessContext.isLocalhost) {
      sources.push({ id: 'server', label: ctx.t('serverWorkspace') });
    } else {
      sources.push({ id: 'client', label: ctx.t('thisDevice') });
      sources.push({ id: 'server', label: ctx.t('serverWorkspace') });
    }
    if (hasRemote) sources.push({ id: 'remote', label: ctx.t('remoteTarget') });
    return sources;
  }

  function openFilePicker(nextCallback, options = {}) {
    const ctx = getContext(options);
    callback = nextCallback || null;
    selected.clear();
    if (ctx.search) ctx.search.value = '';
    updateFilePickerCount(options);
    renderFilePickerTabs(options);
    if (ctx.overlay) ctx.overlay.style.display = 'flex';
    const title = ctx.overlay?.querySelector('.picker-title');
    if (title) title.textContent = callback ? ctx.t('importMemoryFiles') : ctx.t('chooseAttachment');
    const accessContext = ctx.getAccessContext();
    setFilePickerMode(accessContext.isLocalhost ? 'server' : 'client', options);
  }

  function renderFilePickerTabs(options = {}) {
    const ctx = getContext(options);
    if (!ctx.tabs) return;
    const sources = getAttachmentSources(options);
    ctx.tabs.innerHTML = sources.map(source => `<button type="button" class="picker-tab" data-mode="${ctx.esc(source.id)}">${ctx.esc(source.label)}</button>`).join('');
    ctx.tabs.querySelectorAll('.picker-tab').forEach(btn => {
      btn.addEventListener('click', () => setFilePickerMode(btn.dataset.mode, options));
    });
  }

  function setFilePickerMode(nextMode, options = {}) {
    const ctx = getContext(options);
    mode = normalizeFilePickerMode(nextMode, options);
    ctx.tabs?.querySelectorAll('.picker-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
    const localMode = mode === 'client' || mode === 'local';
    if (ctx.local) ctx.local.style.display = localMode ? '' : 'none';
    if (ctx.browser) ctx.browser.style.display = localMode ? 'none' : '';
    if (ctx.confirm) ctx.confirm.style.display = localMode ? 'none' : '';
    if (localMode) {
      if (ctx.localHint) ctx.localHint.textContent = mode === 'local' ? ctx.t('chooseLocalHint') : ctx.t('chooseClientHint');
      if (ctx.serverBrowse) ctx.serverBrowse.style.display = mode === 'local' ? '' : 'none';
      return;
    }
    if (ctx.confirm) ctx.confirm.style.display = '';
    const accessContext = ctx.getAccessContext();
    navigateFilePicker(mode === 'remote' ? '/' : (ctx.cwdInput?.value.trim() || accessContext.defaultCwd || '/'), options);
  }

  function closeFilePicker(options = {}) {
    const overlay = getContext(options).overlay;
    if (overlay) overlay.style.display = 'none';
  }

  function isOpen(options = {}) {
    return getContext(options).overlay?.style.display === 'flex';
  }

  function hasCallback() {
    return Boolean(callback);
  }

  function handleClientFiles(files, options = {}) {
    if (!files || !callback) return false;
    for (const f of files) {
      const itemPath = `client://${f.name}`;
      selected.set(itemPath, { name: f.name, source: 'client', _file: f });
    }
    updateFilePickerCount(options);
    return true;
  }

  function updateFilePickerCount(options = {}) {
    const ctx = getContext(options);
    if (ctx.selectedCount) ctx.selectedCount.textContent = ctx.t('selectedFiles', { count: selected.size });
    if (ctx.confirm) ctx.confirm.disabled = selected.size === 0;
    updateFilePickerSelectAllButton(options);
  }

  function getVisibleSelectableFilePickerItems(options = {}) {
    const ctx = getContext(options);
    if (!ctx.list) return [];
    return Array.from(ctx.list.querySelectorAll('.file-picker-item'))
      .filter(el => el.dataset.type !== 'dir' && el.dataset.type !== 'drive')
      .map(el => ({
        path: el.dataset.path,
        name: el.dataset.name,
        source: mode === 'remote' ? 'remote' : 'server',
        originalPath: el.dataset.path,
        remoteTargetName: ctx.getRemoteTargetName(),
      }))
      .filter(item => item.path);
  }

  function updateFilePickerSelectAllButton(options = {}) {
    const ctx = getContext(options);
    if (!ctx.selectAll) return;
    const selectableItems = getVisibleSelectableFilePickerItems(options);
    const hasItems = selectableItems.length > 0;
    const allSelected = hasItems && selectableItems.every(item => selected.has(item.path));
    ctx.selectAll.style.display = mode === 'client' || mode === 'local' ? 'none' : '';
    ctx.selectAll.disabled = !hasItems;
    ctx.selectAll.textContent = allSelected ? ctx.t('clearVisibleFiles') : ctx.t('selectAllFiles');
  }

  function toggleSelectAllVisibleFiles(options = {}) {
    const selectableItems = getVisibleSelectableFilePickerItems(options);
    if (!selectableItems.length) return;
    const allSelected = selectableItems.every(item => selected.has(item.path));
    for (const item of selectableItems) {
      if (allSelected) {
        selected.delete(item.path);
      } else {
        selected.set(item.path, item);
      }
    }
    updateFilePickerCount(options);
    renderFilePickerItems(visibleItems.length ? visibleItems : items, {}, options);
  }

  async function navigateFilePicker(path, options = {}) {
    const ctx = getContext(options);
    currentDir = path;
    if (ctx.currentPath) ctx.currentPath.textContent = path || '/';
    items = [];
    visibleItems = [];
    if (ctx.search) ctx.search.value = '';
    searchSeq += 1;
    if (ctx.list) ctx.list.innerHTML = `<div class="picker-empty">${ctx.esc(ctx.t('pickerLoading'))}</div>`;

    try {
      const resp = await ctx.api.request(mode === 'remote' ? '/api/remote-files/list' : '/api/browse-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'remote' ? { target_id: ctx.getRemoteTargetValue(), path } : { path }),
      });
      const data = await resp.json();

      if (data.error) {
        if (ctx.list) ctx.list.innerHTML = `<div class="picker-empty">${ctx.esc(data.error)}</div>`;
        return;
      }

      currentDir = data.current || path;
      if (ctx.currentPath) ctx.currentPath.textContent = currentDir;
      items = data.items || [];

      if (items.length === 0) {
        if (ctx.list) ctx.list.innerHTML = `<div class="picker-empty">${ctx.esc(ctx.t('emptyDir'))}</div>`;
        return;
      }

      renderFilePickerItems(items, {}, options);
    } catch (e) {
      if (ctx.list) ctx.list.innerHTML = `<div class="picker-empty">${ctx.esc(ctx.t('requestFailed', { message: e.message }))}</div>`;
    }
  }

  function handleFilePickerSearchInput(options = {}) {
    const ctx = getContext(options);
    window.clearTimeout(searchTimer);
    const keyword = ctx.search?.value.trim() || '';

    if (!keyword) {
      renderFilePickerItems(items, {}, options);
      return;
    }

    if (mode === 'remote') {
      renderFilePickerItems(items, {}, options);
      return;
    }

    searchTimer = window.setTimeout(() => {
      searchFilePicker(keyword, options);
    }, 250);
  }

  async function searchFilePicker(keyword, options = {}) {
    const ctx = getContext(options);
    const seq = ++searchSeq;
    if (ctx.list) ctx.list.innerHTML = `<div class="picker-empty">${ctx.esc(ctx.t('searchLoading'))}</div>`;

    try {
      const resp = await fetch('/api/search-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentDir, query: keyword }),
      });
      const data = await resp.json();
      if (seq !== searchSeq || ctx.search?.value.trim() !== keyword) return;

      if (data.error) {
        if (ctx.list) ctx.list.innerHTML = `<div class="picker-empty">${ctx.esc(data.error)}</div>`;
        return;
      }

      renderFilePickerItems(data.items || [], {
        emptyText: ctx.t('noMatches'),
        truncated: data.truncated,
      }, options);
    } catch (e) {
      if (seq === searchSeq && ctx.list) {
        ctx.list.innerHTML = `<div class="picker-empty">${ctx.esc(ctx.t('searchFailed', { message: e.message }))}</div>`;
      }
    }
  }

  function renderFilePickerItems(nextItems, renderOptions = {}, options = {}) {
    const ctx = getContext(options);
    const keyword = ctx.search?.value.trim().toLowerCase() || '';
    const filteredItems = keyword && nextItems === items
      ? nextItems.filter(item => `${item.name} ${item.path}`.toLowerCase().includes(keyword))
      : nextItems;
    visibleItems = filteredItems;

    if (!ctx.list) return;
    if (filteredItems.length === 0) {
      ctx.list.innerHTML = `<div class="picker-empty">${ctx.esc(renderOptions.emptyText || (keyword ? ctx.t('noMatches') : ctx.t('emptyDir')))}</div>`;
      updateFilePickerSelectAllButton(options);
      return;
    }

    ctx.list.innerHTML = `${renderOptions.truncated ? `<div class="picker-empty compact">${ctx.esc(ctx.t('tooManyResults'))}</div>` : ''}${filteredItems.map(item => {
      const isDir = item.type === 'dir' || item.type === 'drive';
      const icon = item.type === 'drive' ? '&#128423;' : isDir ? '&#128193;' : getFileIcon(item.name);
      const isSelected = selected.has(item.path);
      const displayName = item.display || item.name;
      return `<div class="picker-item file-picker-item ${item.type === 'drive' ? 'drive' : ''} ${isSelected ? 'selected' : ''}"
          data-path="${ctx.esc(item.path)}" data-type="${ctx.esc(item.type)}" data-name="${ctx.esc(displayName)}">
        <span class="picker-item-icon">${icon}</span>
        <span class="picker-item-name">${ctx.esc(displayName)}</span>
        ${!isDir && isSelected ? '<span class="picker-check">✓</span>' : ''}
      </div>`;
    }).join('')}`;

    ctx.list.querySelectorAll('.file-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        const type = el.dataset.type;
        const itemPath = el.dataset.path;
        const itemName = el.dataset.name;

        if (type === 'dir' || type === 'drive') {
          navigateFilePicker(itemPath, options);
          return;
        }

        if (selected.has(itemPath)) {
          selected.delete(itemPath);
        } else {
          selected.set(itemPath, {
            name: itemName,
            source: mode === 'remote' ? 'remote' : 'server',
            originalPath: itemPath,
            remoteTargetName: ctx.getRemoteTargetName(),
          });
        }
        updateFilePickerCount(options);
        renderFilePickerItems(ctx.search?.value.trim() ? filteredItems : items, {}, options);
      });
    });
    updateFilePickerSelectAllButton(options);
  }

  function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
    const codeExts = ['js', 'ts', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'sh', 'bat'];
    const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
    const textExts = ['txt', 'md', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css'];
    if (imageExts.includes(ext)) return '&#128444;';
    if (codeExts.includes(ext)) return '&#128196;';
    if (docExts.includes(ext)) return '&#128209;';
    if (textExts.includes(ext)) return '&#128196;';
    return '&#128196;';
  }

  async function confirmFileSelection(options = {}) {
    const ctx = getContext(options);
    if (selected.size === 0) return;

    if (callback) {
      const selectedItems = Array.from(selected.entries()).map(([path, meta]) => ({ path, ...meta }));
      await callback(selectedItems);
      callback = null;
      closeFilePicker(options);
      return;
    }

    for (const [filePath, meta] of selected) {
      if (meta.source === 'remote') {
        await cacheRemoteAttachment(filePath, meta, options);
      } else {
        ctx.addAttachment({ name: meta.name, path: filePath, isImage: false, uploaded: false, source: 'server', originalPath: filePath }, false);
      }
    }

    ctx.renderAttachments();
    closeFilePicker(options);
  }

  async function cacheRemoteAttachment(filePath, meta, options = {}) {
    const ctx = getContext(options);
    const data = await ctx.api.postJson('/api/remote-files/cache', {
      target_id: ctx.getRemoteTargetValue(),
      path: filePath,
      cwd: ctx.cwdInput?.value.trim() || '',
    });
    if (!data.ok) {
      ctx.addSystemMsg(ctx.t('remoteFileCacheFailed', { message: data.error || 'failed' }), true);
      return;
    }
    ctx.addAttachment({
      name: data.name || meta.name,
      path: data.path,
      isImage: false,
      uploaded: true,
      source: 'remote',
      originalPath: data.original_path || filePath,
      remoteTargetName: data.remote_target_name || meta.remoteTargetName,
    }, false);
  }

  root.filePicker = {
    initFilePicker,
    normalizeFilePickerMode,
    getAttachmentSources,
    openFilePicker,
    renderFilePickerTabs,
    setFilePickerMode,
    closeFilePicker,
    isOpen,
    hasCallback,
    handleClientFiles,
    updateFilePickerCount,
    getVisibleSelectableFilePickerItems,
    updateFilePickerSelectAllButton,
    toggleSelectAllVisibleFiles,
    navigateFilePicker,
    handleFilePickerSearchInput,
    searchFilePicker,
    renderFilePickerItems,
    getFileIcon,
    confirmFileSelection,
    cacheRemoteAttachment,
  };
})();
