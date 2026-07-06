// Memory 浏览与编辑

function currentCwdParam() {
  return `cwd=${encodeURIComponent(cwdInput.value.trim() || '')}`;
}

// ─── 状态 ─────────────────────────────────────────────────────

function updateMemoryStatus(files) {
  var el = document.getElementById("memory-status-info");
  if (!el) return;
  if (!files || !files.length) {
    el.textContent = "\uD83D\uDCC1 0 files";
    return;
  }
  var latest = files.reduce(function(max, f) { return Math.max(max, f.updated_at || 0); }, 0);
  var timeStr = latest ? new Date(latest * 1000).toLocaleString() : "";
  el.textContent = "\uD83D\uDCC1 " + files.length + " files" + (timeStr ? " \u00b7 last updated " + timeStr : "");
}

async function loadMemoryFiles() {
  try {
    const resp = await fetch(`/api/memory/files?${currentCwdParam()}`);
    const files = await resp.json();
    updateMemoryStatus(files);
    if (typeof initWikiGraph === 'function') {
      initWikiGraph();
    }
  } catch (e) {
    console.error('Memory load failed:', e);
  }
}

async function viewMemoryFile(filename) {
  try {
    const resp = await fetch('/api/memory/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, cwd: cwdInput.value.trim() || '' }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const titleEl = document.getElementById('memory-modal-title');
    const bodyEl = document.getElementById('memory-modal-body');
    titleEl.textContent = data.title || data.name;
    titleEl.dataset.filename = data.name || filename;
    bodyEl.innerHTML = renderMd(data.body || data.content || '');
    document.getElementById('memory-modal-overlay').style.display = 'flex';
  } catch (e) {
    console.error('Memory file load failed:', e);
  }
}

function currentMemoryModalFilename() {
  return document.getElementById('memory-modal-title')?.dataset.filename || '';
}

function editCurrentMemoryFile() {
  const filename = currentMemoryModalFilename();
  if (!filename) return;
  closeMemoryModal();
  openMemoryEditor(filename);
}

async function deleteCurrentMemoryFile() {
  const filename = currentMemoryModalFilename();
  if (!filename) return;
  if (!confirm(t('memoryDeleteConfirm', { name: filename }))) return;
  try {
    const resp = await fetch('/api/memory/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, cwd: cwdInput.value.trim() || '' }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      showToast(data.error || t('memoryDeleteFailed'), 'error');
      return;
    }
    closeMemoryModal();
    showToast(t('memoryDeleted'), 'success');
    await loadMemoryFiles();
    if (typeof refreshWikiGraph === 'function') refreshWikiGraph();
  } catch (e) {
    console.error('Memory delete failed:', e);
    showToast(t('memoryDeleteFailed'), 'error');
  }
}

function closeMemoryModal() {
  document.getElementById('memory-modal-overlay').style.display = 'none';
}

async function indexMemoryFiles() {
  const btn = document.getElementById('btn-memory-index');
  if (btn) btn.disabled = true;
  try {
    await fetch('/api/memory/index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: cwdInput.value.trim() || '' }),
    });
    loadMemoryFiles();
  } catch (e) {
    console.error('Memory index failed:', e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function checkMemoryHits(assistantEl, userPrompt) {
  if (!cwdInput.value.trim()) return;
  const contentEl = assistantEl.querySelector('.msg-content');
  if (!contentEl) return;
  let text = (contentEl.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length < 40) return;
  text = text.substring(0, 600);
  try {
    const resp = await fetch(`/api/memory/search?q=${encodeURIComponent(text)}&${currentCwdParam()}`);
    const results = await resp.json();
    if (results && results.length > 0) {
      renderMemoryHit(assistantEl, results);
    }
  } catch (e) {
    console.error('Memory hit check failed:', e);
  }
}

function renderMemoryHit(el, results) {
  const existing = el.querySelector('.memory-hint');
  if (existing) existing.remove();
  const hint = document.createElement('div');
  hint.className = 'memory-hint';
  const count = results.length;
  hint.innerHTML = `
    <div class="memory-hint-head">
      <span class="memory-hint-icon">&#128451;</span>
      <span class="memory-hint-title">${esc(t('memoryHint'))} (${count})</span>
    </div>
    <div class="memory-hint-list">
      ${results.slice(0, 5).map(r => `
        <span class="memory-hint-tag" title="${esc(t('view'))}: ${esc(r.title || r.name)}" data-file="${esc(r.name)}">${esc(r.title || r.name)}</span>
      `).join('')}
      ${count > 5 ? `<span class="memory-hint-more">+${count - 5} ${esc(t('itemCount', { count: count - 5 }))}</span>` : ''}
    </div>
  `;
  hint.querySelectorAll('.memory-hint-tag').forEach(tag => {
    tag.addEventListener('click', () => viewMemoryFile(tag.dataset.file));
  });
  el.appendChild(hint);
}

function openMemoryEditor(filename, preset) {
  const overlay = document.getElementById('memory-edit-overlay');
  const nameInput = document.getElementById('memory-edit-filename');
  const contentArea = document.getElementById('memory-edit-content');

  if (preset && preset.content) {
    // 从外部预填充（如存入记忆/整理入 Wiki）
    nameInput.value = preset.filename || '';
    delete nameInput.dataset.original;
    contentArea.value = preset.content;
  } else if (filename) {
    nameInput.value = filename;
    nameInput.dataset.original = filename;
    fetch('/api/memory/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, cwd: cwdInput.value.trim() || '' }),
    }).then(r => r.json()).then(data => {
      contentArea.value = data.body || data.content || '';
    }).catch(() => {});
  } else {
    nameInput.value = '';
    delete nameInput.dataset.original;
    contentArea.value = '';
  }
  overlay.style.display = 'flex';
  (nameInput.value ? contentArea : nameInput).focus();
}

function closeMemoryEditor() {
  document.getElementById('memory-edit-overlay').style.display = 'none';
}

async function saveMemoryEdit() {
  const filename = document.getElementById('memory-edit-filename').value.trim();
  const content = document.getElementById('memory-edit-content').value;
  if (!filename || !content) return;
  try {
    await fetch('/api/memory/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content, cwd: cwdInput.value.trim() || '' }),
    });
    closeMemoryEditor();
    loadMemoryFiles();
  } catch (e) {
    console.error('Memory save failed:', e);
  }
}

function initMemoryUI() {
  document.getElementById('btn-memory-import')?.addEventListener('click', () => openFilePicker(handleMemoryImport));
  document.getElementById('btn-memory-organize')?.addEventListener('click', organizeMemoryLinks);
  document.getElementById('btn-memory-new')?.addEventListener('click', () => openMemoryEditor());
  document.getElementById('memory-modal-close')?.addEventListener('click', closeMemoryModal);
  document.getElementById('memory-modal-edit')?.addEventListener('click', editCurrentMemoryFile);
  document.getElementById('memory-modal-delete')?.addEventListener('click', deleteCurrentMemoryFile);
  document.getElementById('memory-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMemoryModal();
  });
  document.getElementById('btn-memory-edit-save')?.addEventListener('click', saveMemoryEdit);
  document.getElementById('btn-memory-edit-cancel')?.addEventListener('click', closeMemoryEditor);
  document.getElementById('memory-edit-close')?.addEventListener('click', closeMemoryEditor);
  document.getElementById('memory-edit-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMemoryEditor();
  });

  // Graph reset button
  document.getElementById('btn-graph-reset')?.addEventListener('click', function() {
    if (typeof refreshWikiGraph === 'function') {
      refreshWikiGraph();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('memory-modal-overlay')?.style.display === 'flex') {
      closeMemoryModal();
    }
    if (e.key === 'Escape' && document.getElementById('memory-edit-overlay')?.style.display === 'flex') {
      closeMemoryEditor();
    }
  });
}

async function handleMemoryImport(selectedItems) {
  const serverPaths = selectedItems.filter(item => item.source === 'server').map(item => item.path);
  const clientFiles = selectedItems.filter(item => item.source === 'client' || item.source === 'local');

  let imported = 0;
  // 服务端文件：发送路径列表
  if (serverPaths.length > 0) {
    try {
      const resp = await fetch('/api/memory/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: serverPaths, cwd: cwdInput.value.trim() || '' }),
      });
      const data = await resp.json();
      if (data.ok) imported += data.imported.length;
    } catch (e) {
      console.error('Memory import failed:', e);
    }
  }
  // 客户端文件：逐个上传
  for (const item of clientFiles) {
    if (item._file) {
      try {
        const fd = new FormData();
        fd.append('file', item._file);
        fd.append('cwd', cwdInput.value.trim() || '');
        const resp = await fetch('/api/memory/upload', { method: 'POST', body: fd });
        const data = await resp.json();
        if (data.ok) imported++;
      } catch (e) {
        console.error('Memory upload failed:', e);
      }
    }
  }

  if (imported > 0) {
    showToast(t('importMemorySuccess', { count: imported }), 'success');
    await indexMemoryFiles();
  } else {
    showToast(t('importMemoryEmpty'), 'error');
  }
}

async function organizeMemoryLinks() {
  const btn = document.getElementById('btn-memory-organize');
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/memory/organize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: cwdInput.value.trim() || '' }),
    });
    const data = await resp.json();
    if (data.linked > 0) {
      showToast(t('organizeMemorySuccess', { linked: data.linked }), 'success');
      await indexMemoryFiles();
      if (typeof initWikiGraph === 'function') initWikiGraph();
    } else if (data.skipped > 0) {
      showToast(t('noMemoryResults'), 'info');
    } else {
      showToast(t('noMemoryResults'), 'info');
    }
  } catch (e) {
    console.error('Organize memory failed:', e);
  } finally {
    if (btn) btn.disabled = false;
  }
}
