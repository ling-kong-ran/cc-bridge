(function () {
  const root = window.CCBridge = window.CCBridge || {};

  const btnAttach = document.getElementById('btn-attach');
  const fileInput = document.getElementById('file-input');
  const attachmentsBar = document.getElementById('attachments-bar');
  const modelPill = document.getElementById('model-pill');
  const modelPillPopover = document.getElementById('model-pill-popover');
  const inputCliStatus = document.getElementById('input-cli-status');
  const inputCwdStatus = document.getElementById('input-cwd-status');
  const slashCommandPanel = document.getElementById('slash-command-panel');
  const inputWrapper = document.querySelector('.input-wrapper');

  let attachedFiles = [];
  let slashCommands = [];
  let slashCommandMatches = [];
  let slashCommandIndex = 0;
  let slashCommandLoadTimer = null;
  let slashCommandLoadPromise = null;
  let inputDragDepth = 0;
  let mentionPopup = null;
  let mentionStartIdx = -1;

  function initInput() {
    inputEl.addEventListener('keydown', (e) => {
      if (handleSlashCommandKeydown(e)) return;
      if (mentionPopup && mentionPopup.style.display === 'block') return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    inputEl.addEventListener('input', () => {
      const query = getSlashQuery();
      if (query !== null && !slashCommands.length) {
        slashCommandPanel.innerHTML = `<div class="slash-command-empty">${esc(t('loading'))}</div>`;
        setVisible(slashCommandPanel, true, 'block');
        ensureSlashCommandsLoaded();
        return;
      }
      updateSlashCommandPanel();
    });

    inputEl.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) uploadFiles([blob]);
          break;
        }
      }
    });

    btnSend.addEventListener('click', sendMessage);
    btnStop.addEventListener('click', interruptCurrentRun);
    btnNewSession?.addEventListener('click', startNewSession);
    btnExportChat?.addEventListener('click', copyConversationMarkdown);
    sessionSearchInput?.addEventListener('input', () => renderSessionList(cachedSessions));
    document.addEventListener('keydown', handleGlobalShortcuts);
    document.getElementById('welcome-new-session')?.addEventListener('click', startNewSession);
    modelSelect.addEventListener('change', () => {
      renderTopbarMeta();
      renderModelPill();
      renderWelcomeRuntime();
      slashCommands = [];
      closeSlashCommandPanel();
      savedModelPref = modelSelect.value;
      saveGuiSettings({ default_model: modelSelect.value });
    });
    cwdInput.addEventListener('change', () => {
      slashCommands = [];
      closeSlashCommandPanel();
      updateRuntimeSummary();
      renderWelcomeRuntime();
      loadSessions();
      loadMcpServers();
    });
    cwdInput.addEventListener('click', async () => {
      if (sessionActive && currentSessionId) {
        const newCwd = await promptCwdForSession(cwdInput.value.trim());
        if (newCwd) await updateSessionCwd(currentSessionId, newCwd);
      }
    });

    btnAttach.addEventListener('click', () => openFilePicker());
    fileInput.addEventListener('change', () => {
      if (filePickerOverlay?.style.display === 'flex' && filePickerCallback) {
        for (const f of fileInput.files) {
          const itemPath = `client://${f.name}`;
          filePickerSelected.set(itemPath, { name: f.name, source: 'client', _file: f });
        }
        updateFilePickerCount();
        fileInput.value = '';
        return;
      }
      uploadFiles(fileInput.files);
      fileInput.value = '';
      if (filePickerOverlay?.style.display === 'flex') closeFilePicker();
    });
    initInputFileDrop();

    document.addEventListener('click', (e) => {
      if (!slashCommandPanel.contains(e.target) && e.target !== inputEl) closeSlashCommandPanel();
    });
  }

  function initInputFileDrop() {
    if (!inputWrapper) return;

    inputWrapper.addEventListener('dragenter', (e) => {
      if (!dragEventHasFiles(e)) return;
      e.preventDefault();
      inputDragDepth += 1;
      inputWrapper.classList.add('drag-over');
    });

    inputWrapper.addEventListener('dragover', (e) => {
      if (!dragEventHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    inputWrapper.addEventListener('dragleave', (e) => {
      if (!dragEventHasFiles(e)) return;
      e.preventDefault();
      inputDragDepth = Math.max(0, inputDragDepth - 1);
      if (inputDragDepth === 0) inputWrapper.classList.remove('drag-over');
    });

    inputWrapper.addEventListener('drop', (e) => {
      if (!dragEventHasFiles(e)) return;
      e.preventDefault();
      inputDragDepth = 0;
      inputWrapper.classList.remove('drag-over');
      uploadFiles(e.dataTransfer.files);
    });
  }

  function dragEventHasFiles(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
  }

  function uploadFiles(files) {
    Array.from(files || []).forEach((file) => {
      if (file) uploadFile(file);
    });
  }

  async function uploadFile(file) {
    const formData = new FormData();
    formData.append('cwd', cwdInput.value.trim() || '');
    formData.append('file', file);
    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await resp.json();
      if (data.files && data.files.length > 0) {
        for (const path of data.files) {
          const isImage = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(path);
          addAttachment({ name: file.name, path, isImage, uploaded: true, source: 'client', originalPath: file.name }, false);
        }
        renderAttachments();
      }
    } catch (e) {
      addSystemMsg(t('uploadFailed', { message: e.message }), true);
    }
  }

  function addAttachment(file, render = true) {
    attachedFiles.push(file);
    if (render) renderAttachments();
  }

  function addAttachments(files) {
    Array.from(files || []).forEach(file => addAttachment(file, false));
    renderAttachments();
  }

  function getAttachedFiles() {
    return attachedFiles.slice();
  }

  function consumeAttachedFiles() {
    const files = attachedFiles.slice();
    attachedFiles = [];
    renderAttachments();
    return files;
  }

  function renderAttachments() {
    if (attachedFiles.length === 0) {
      setVisible(attachmentsBar, false);
      attachmentsBar.innerHTML = '';
      return;
    }
    setVisible(attachmentsBar, true, 'flex');
    attachmentsBar.innerHTML = attachedFiles.map((f, i) => `
      <div class="attachment-item" title="${esc(getAttachmentTitle(f))}">
        <span class="attachment-source">${esc(getAttachmentSourceLabel(f))}</span>
        ${f.isImage ? `<img src="/api/file?path=${encodeURIComponent(f.path)}" class="attachment-thumb">` : '<span class="attachment-icon">&#128196;</span>'}
        <span class="attachment-name">${esc(f.name)}</span>
        <button class="attachment-remove" data-idx="${i}">&times;</button>
      </div>
    `).join('');
    attachmentsBar.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        attachedFiles.splice(idx, 1);
        renderAttachments();
      });
    });
  }

  function getAttachmentSourceLabel(file) {
    if (file.source === 'remote') return t('remote');
    if (file.source === 'server') return accessContext.isLocalhost ? t('localFiles') : t('serverWorkspace');
    return accessContext.isLocalhost ? t('localFiles') : t('thisDevice');
  }

  function getAttachmentTitle(file) {
    if (file.source === 'remote') return `${file.remoteTargetName || t('remote')}:${file.originalPath || file.path}`;
    return file.originalPath || file.path || file.name;
  }

  function scheduleSlashCommandReload() {
    clearTimeout(slashCommandLoadTimer);
    slashCommandLoadTimer = setTimeout(loadSlashCommands, 150);
  }

  async function ensureSlashCommandsLoaded() {
    if (slashCommands.length || slashCommandLoadPromise) return slashCommandLoadPromise;
    slashCommandLoadPromise = loadSlashCommands().finally(() => { slashCommandLoadPromise = null; });
    return slashCommandLoadPromise;
  }

  async function loadSlashCommands() {
    const params = new URLSearchParams();
    if (modelSelect.value) params.set('model', modelSelect.value);
    if (cwdInput.value.trim()) params.set('cwd', cwdInput.value.trim());

    try {
      const data = await root.api.json(`/api/slash-commands?${params.toString()}`);
      const commands = Array.isArray(data) ? data : (data.commands || []);
      const seen = new Set();
      slashCommands = commands
        .filter(cmd => cmd.name && !seen.has(cmd.name) && seen.add(cmd.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      slashCommands = [];
    }

    updateSlashCommandPanel();
  }

  function getSlashQuery() {
    const value = inputEl.value;
    const cursor = inputEl.selectionStart || 0;
    if (!value.startsWith('/') || cursor !== value.length || value.includes('\n') || /\s/.test(value)) return null;
    return value.slice(1).toLowerCase();
  }

  function updateSlashCommandPanel() {
    const query = getSlashQuery();
    if (query === null) {
      closeSlashCommandPanel();
      return;
    }

    slashCommandMatches = slashCommands.filter(cmd => (
      cmd.name.slice(1).toLowerCase().includes(query) ||
      (cmd.description || '').toLowerCase().includes(query)
    )).slice(0, 10);
    slashCommandIndex = Math.min(slashCommandIndex, Math.max(slashCommandMatches.length - 1, 0));

    if (!slashCommandMatches.length) {
      slashCommandPanel.innerHTML = `<div class="slash-command-empty">${esc(t('noCommandMatches'))}</div>`;
      setVisible(slashCommandPanel, true, 'block');
      return;
    }

    slashCommandPanel.innerHTML = slashCommandMatches.map((cmd, idx) => `
      <button type="button" class="slash-command-item${idx === slashCommandIndex ? ' active' : ''}" data-idx="${idx}" role="option" aria-selected="${idx === slashCommandIndex ? 'true' : 'false'}">
        <span class="slash-command-name">${esc(cmd.name)}</span>
        <span class="slash-command-desc">${esc(cmd.description || '')}</span>
      </button>
    `).join('');
    setVisible(slashCommandPanel, true, 'block');

    slashCommandPanel.querySelectorAll('.slash-command-item').forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        slashCommandIndex = Number(btn.dataset.idx || 0);
        renderSlashCommandActiveState();
      });
      btn.addEventListener('click', () => selectSlashCommand(Number(btn.dataset.idx || 0)));
    });
  }

  function renderSlashCommandActiveState() {
    slashCommandPanel.querySelectorAll('.slash-command-item').forEach((item, idx) => {
      const active = idx === slashCommandIndex;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function handleSlashCommandKeydown(e) {
    if (slashCommandPanel.style.display === 'none') return false;
    if (!slashCommandMatches.length && e.key !== 'Escape') return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashCommandIndex = (slashCommandIndex + 1) % slashCommandMatches.length;
      renderSlashCommandActiveState();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashCommandIndex = (slashCommandIndex - 1 + slashCommandMatches.length) % slashCommandMatches.length;
      renderSlashCommandActiveState();
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      selectSlashCommand(slashCommandIndex);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSlashCommandPanel();
      return true;
    }
    return false;
  }

  function selectSlashCommand(index) {
    const cmd = slashCommandMatches[index];
    if (!cmd) return;
    inputEl.value = `${cmd.name} `;
    inputEl.focus();
    inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
    closeSlashCommandPanel();
  }

  function closeSlashCommandPanel() {
    setVisible(slashCommandPanel, false);
    slashCommandMatches = [];
    slashCommandIndex = 0;
  }

  function renderModelPill() {
    if (!modelPill) return;
    const val = modelSelect.value;
    modelPill.textContent = getDisplayModelName(val) || 'Model';
    renderInputStatus();
    if (isDisplay(modelPillPopover, 'block')) renderModelPillPopoverOptions();
  }

  function renderModelPillPopoverOptions() {
    if (!modelPillPopover) return;
    const current = modelSelect.value;
    modelPillPopover.innerHTML = Array.from(modelSelect.options)
      .filter(function(o) { return o.value; })
      .map(function(o) {
        return '<button class="model-pill-option' + (o.value === current ? ' active' : '') + '" data-model="' + esc(o.value) + '" type="button" role="option" aria-selected="' + (o.value === current ? 'true' : 'false') + '">' + esc(o.textContent) + '</button>';
      })
      .join('');
    modelPillPopover.querySelectorAll('.model-pill-option').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var model = btn.dataset.model;
        if (model && model !== modelSelect.value) {
          modelSelect.value = model;
          modelSelect.dispatchEvent(new Event('change'));
        }
        closeModelPillPopover();
      });
    });
  }

  function openModelPillPopover() {
    if (!modelPillPopover) return;
    if (isDisplay(modelPillPopover, 'block')) { closeModelPillPopover(); return; }
    closeSlashCommandPanel();
    renderModelPillPopoverOptions();
    setVisible(modelPillPopover, true, 'block');
    modelPill.classList.add('open');
    modelPill.setAttribute('aria-expanded', 'true');
  }

  function closeModelPillPopover() {
    if (!modelPillPopover) return;
    setVisible(modelPillPopover, false);
    modelPill.classList.remove('open');
    modelPill.setAttribute('aria-expanded', 'false');
  }

  function initModelPill() {
    if (!modelPill) return;
    modelPill.addEventListener('click', function(e) {
      e.stopPropagation();
      openModelPillPopover();
    });
    document.addEventListener('click', function(e) {
      if (isDisplay(modelPillPopover, 'block') && !modelPillPopover.contains(e.target) && e.target !== modelPill) closeModelPillPopover();
    });
    renderModelPill();
  }

  function initMentionAutocomplete() {
    if (mentionPopup) return;
    mentionPopup = document.createElement('div');
    mentionPopup.className = 'mention-popup';
    mentionPopup.style.display = 'none';
    document.body.appendChild(mentionPopup);

    inputEl.addEventListener('keydown', (e) => {
      if (mentionPopup.style.display === 'block') {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionSelection(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionSelection(-1); }
        else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectMention(); }
        else if (e.key === 'Escape') { hideMentionPopup(); }
      }
    });

    inputEl.addEventListener('input', () => updateMentionPopup());
  }

  function updateMentionPopup() {
    const chatPage = document.getElementById('page-chat');
    if (!chatPage || !chatPage.classList.contains('active')) {
      hideMentionPopup();
      return;
    }

    const value = inputEl.value;
    const cursor = inputEl.selectionStart || 0;
    const before = value.substring(0, cursor);
    const atIdx = before.lastIndexOf('@');

    if (atIdx === -1 || atIdx < cursor - 30) {
      hideMentionPopup();
      return;
    }

    if (atIdx > 0 && before[atIdx - 1] !== ' ' && before[atIdx - 1] !== '\n') {
      hideMentionPopup();
      return;
    }

    const query = before.substring(atIdx + 1).toLowerCase();
    mentionStartIdx = atIdx;
    const currentSessionAgents = typeof root.getSessionAgents === 'function' ? root.getSessionAgents() : [];
    const items = [];
    if (currentSessionAgents.length >= 1 && (!query || 'all'.includes(query) || t('mentionAll').toLowerCase().includes(query))) {
      items.push({ type: 'all', name: 'all', label: t('mentionAll') || '@全体成员' });
    }
    currentSessionAgents.forEach(name => {
      if (!query || name.toLowerCase().includes(query)) items.push({ type: 'agent', name, label: `@${name}` });
    });

    if (!items.length) {
      hideMentionPopup();
      return;
    }

    mentionPopup._items = items;
    mentionPopup._selectedIdx = 0;
    mentionPopup.innerHTML = `
      <div class="mention-popup-hint">${esc(t('mentionHint'))}</div>
      ${items.map((item, i) => `
        <div class="mention-item ${i === 0 ? 'mention-item-active' : ''}" data-idx="${i}">
          <span class="mention-type-tag ${item.type === 'all' ? 'mention-type-all' : 'mention-type-agent'}">${esc(item.type === 'all' ? (t('mentionAllTag') || 'ALL') : t('agents'))}</span>
          <span class="mention-name">${esc(item.label)}</span>
        </div>
      `).join('')}
    `;

    mentionPopup.style.display = 'block';
    mentionPopup.style.visibility = 'hidden';
    const rect = inputEl.getBoundingClientRect();
    mentionPopup.style.left = Math.max(4, rect.left) + 'px';
    const popupHeight = mentionPopup.scrollHeight;
    mentionPopup.style.top = Math.max(4, rect.top - popupHeight - 6) + 'px';
    mentionPopup.style.visibility = 'visible';

    mentionPopup.querySelectorAll('.mention-item').forEach(el => {
      el.addEventListener('click', () => {
        mentionPopup._selectedIdx = parseInt(el.dataset.idx);
        selectMention();
      });
    });
  }

  function moveMentionSelection(dir) {
    if (!mentionPopup._items) return;
    const items = mentionPopup.querySelectorAll('.mention-item');
    if (!items.length) return;
    mentionPopup._selectedIdx = (mentionPopup._selectedIdx + dir + mentionPopup._items.length) % mentionPopup._items.length;
    items.forEach(el => {
      el.classList.toggle('mention-item-active', parseInt(el.dataset.idx) === mentionPopup._selectedIdx);
    });
  }

  function selectMention() {
    if (!mentionPopup._items || mentionPopup._selectedIdx < 0) return;
    const item = mentionPopup._items[mentionPopup._selectedIdx];
    if (!item) return;
    const value = inputEl.value;
    const cursor = inputEl.selectionStart || 0;
    const before = value.substring(0, mentionStartIdx);
    const after = value.substring(cursor);
    const insert = `@${item.name} `;

    inputEl.value = before + insert + after;
    const newCursor = before.length + insert.length;
    inputEl.selectionStart = inputEl.selectionEnd = newCursor;
    inputEl.focus();
    hideMentionPopup();
  }

  function hideMentionPopup() {
    if (mentionPopup) { mentionPopup.style.display = 'none'; mentionPopup.style.visibility = ''; }
    mentionStartIdx = -1;
  }

  root.input = {
    initInput,
    initModelPill,
    initMentionAutocomplete,
    renderModelPill,
    scheduleSlashCommandReload,
    closeSlashCommandPanel,
    loadSlashCommands,
    uploadFiles,
    renderAttachments,
    addAttachment,
    addAttachments,
    getAttachedFiles,
    consumeAttachedFiles,
    hideMentionPopup,
  };
})();
