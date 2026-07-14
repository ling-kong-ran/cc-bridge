// Memory 浏览与编辑

const memoryState = {
  loading: false,
  error: '',
  files: [],
  selectedPath: '',
  query: '',
  filters: { type: 'all', source: 'all', inject: 'all' },
  view: 'browse',
};

const memoryOrganizeState = { actions: [], applying: false };
let memorySearchTimer = null;

function currentCwdParam() {
  return `cwd=${encodeURIComponent(cwdInput.value.trim() || '')}`;
}

async function memoryApi(url, options) {
  const resp = await fetch(url, options || {});
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || data.message || `HTTP ${resp.status}`);
  }
  return data;
}

function memoryItemPath(item) {
  return item.path || item.file || item.name || '';
}

function updateMemoryStatus(files) {
  var el = document.getElementById('memory-status-info');
  if (!el) return;
  if (memoryState.loading) {
    el.textContent = t('loading');
    return;
  }
  if (memoryState.error) {
    el.textContent = t('memoryLoadFailed', { message: memoryState.error });
    return;
  }
  if (!files || !files.length) {
    el.textContent = t('memoryNoFiles');
    return;
  }
  var latest = files.reduce(function(max, f) { return Math.max(max, f.updated_at || 0); }, 0);
  var timeStr = latest ? new Date(latest * 1000).toLocaleString() : '';
  el.textContent = t('memoryStatusSummary', { count: files.length, time: timeStr || '-' });
}

function renderMemoryFilterOptions() {
  [['type', 'memory-filter-type'], ['source', 'memory-filter-source'], ['inject', 'memory-filter-inject']].forEach(([field, id]) => {
    const select = document.getElementById(id);
    if (!select) return;
    const values = Array.from(new Set(memoryState.files.map(f => String(f[field] || '').trim()).filter(Boolean))).sort();
    const current = memoryState.filters[field] || 'all';
    select.innerHTML = `<option value="all">${esc(t('all'))}</option>` + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    select.value = values.includes(current) ? current : 'all';
    memoryState.filters[field] = select.value;
  });
}

function filteredMemoryFiles() {
  const query = (memoryState.query || '').trim().toLowerCase();
  return memoryState.files.filter(f => {
    if (memoryState.filters.type !== 'all' && String(f.type || '') !== memoryState.filters.type) return false;
    if (memoryState.filters.source !== 'all' && String(f.source || '') !== memoryState.filters.source) return false;
    if (memoryState.filters.inject !== 'all' && String(f.inject || '') !== memoryState.filters.inject) return false;
    if (!query) return true;
    const blob = [f.title, f.name, f.path, f.file, f.type, f.source, (f.tags || []).join(' ')].join(' ').toLowerCase();
    return blob.includes(query);
  }).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

function renderMemoryList() {
  const listEl = document.getElementById('memory-file-list');
  const stateEl = document.getElementById('memory-list-state');
  if (!listEl) return;
  if (memoryState.loading) {
    listEl.innerHTML = '';
    if (stateEl) stateEl.textContent = t('loading');
    return;
  }
  if (memoryState.error) {
    listEl.innerHTML = `<div class="memory-empty-enhanced"><div class="empty-title">${esc(t('memoryLoadFailed', { message: memoryState.error }))}</div><button class="btn-mini" type="button" id="memory-retry-load">${esc(t('retry') || 'Retry')}</button></div>`;
    document.getElementById('memory-retry-load')?.addEventListener('click', loadMemoryFiles);
    if (stateEl) stateEl.textContent = '';
    return;
  }
  const files = filteredMemoryFiles();
  if (stateEl) stateEl.textContent = t('memoryListCount', { shown: files.length, total: memoryState.files.length });
  if (!memoryState.files.length) {
    listEl.innerHTML = `<div class="memory-empty-enhanced"><div class="empty-icon">☷</div><div class="empty-title">${esc(t('memoryNoFiles'))}</div><div class="empty-hint">${esc(t('memoryEmptyHint'))}</div></div>`;
    return;
  }
  if (!files.length) {
    listEl.innerHTML = `<div class="memory-empty-enhanced"><div class="empty-title">${esc(t('memoryNoSearchResults'))}</div></div>`;
    return;
  }
  listEl.innerHTML = files.map(f => {
    const path = memoryItemPath(f);
    const meta = [f.type, f.source, f.inject, f.updated_at ? new Date(f.updated_at * 1000).toLocaleString() : ''].filter(Boolean).join(' · ');
    return `<button class="memory-file-item ${path === memoryState.selectedPath ? 'active' : ''}" type="button" data-path="${esc(path)}">
      <div class="memory-file-head"><span class="memory-file-name">${esc(f.title || f.name || path)}</span></div>
      <div class="memory-file-meta">${esc(path)}</div>
      <div class="memory-file-snippet">${esc(meta || t('noDescription'))}</div>
    </button>`;
  }).join('');
  listEl.querySelectorAll('.memory-file-item').forEach(item => item.addEventListener('click', () => selectMemory(item.dataset.path || '')));
}

function renderMemoryPage() {
  updateMemoryStatus(memoryState.files);
  renderMemoryFilterOptions();
  renderMemoryList();
}

async function loadMemoryFiles() {
  memoryState.loading = true;
  memoryState.error = '';
  renderMemoryPage();
  try {
    const files = await memoryApi(`/api/memory/files?${currentCwdParam()}`);
    memoryState.files = Array.isArray(files) ? files : (files.items || []);
    if (memoryState.selectedPath && !memoryState.files.some(f => memoryItemPath(f) === memoryState.selectedPath)) {
      memoryState.selectedPath = '';
      renderMemoryDetail(null);
    }
  } catch (e) {
    console.error('Memory load failed:', e);
    memoryState.error = e.message || String(e);
    showToast(t('memoryLoadFailed', { message: memoryState.error }), 'error');
  } finally {
    memoryState.loading = false;
    renderMemoryPage();
    if (typeof initWikiGraph === 'function') initWikiGraph();
  }
}

function renderMemoryDetail(data) {
  const emptyEl = document.getElementById('memory-detail-empty');
  const contentEl = document.getElementById('memory-detail-content');
  if (!emptyEl || !contentEl) return;
  if (!data) {
    emptyEl.hidden = false;
    contentEl.hidden = true;
    contentEl.innerHTML = '';
    return;
  }
  emptyEl.hidden = true;
  contentEl.hidden = false;
  const path = data.path || data.file || data.name || memoryState.selectedPath;
  const meta = [data.type, data.source, data.inject].filter(Boolean).join(' · ');
  contentEl.innerHTML = `
    <div class="memory-detail-head">
      <h3>${esc(data.title || data.name || path)}</h3>
      <div class="memory-file-meta">${esc(path)}${meta ? ' · ' + esc(meta) : ''}</div>
      <div class="memory-actions"><button class="btn-mini" type="button" id="memory-detail-edit">${esc(t('edit'))}</button><button class="btn-mini danger" type="button" id="memory-detail-delete">${esc(t('delete'))}</button></div>
    </div>
    <div class="memory-detail-body">${renderMd(data.body || data.content || '')}</div>`;
  document.getElementById('memory-detail-edit')?.addEventListener('click', () => openMemoryEditor(path));
  document.getElementById('memory-detail-delete')?.addEventListener('click', deleteCurrentMemoryFile);
}

async function selectMemory(path) {
  if (!path) return;
  memoryState.selectedPath = path;
  renderMemoryList();
  try {
    const data = await memoryApi('/api/memory/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: path, cwd: cwdInput.value.trim() || '' }),
    });
    renderMemoryDetail(data);
  } catch (e) {
    showToast(t('memoryFileLoadFailed', { message: e.message }), 'error');
  }
}

async function viewMemoryFile(filename) {
  await selectMemory(filename);
}

function currentMemoryModalFilename() {
  return memoryState.selectedPath || document.getElementById('memory-modal-title')?.dataset.filename || '';
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
    await memoryApi('/api/memory/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, cwd: cwdInput.value.trim() || '' }),
    });
    closeMemoryModal();
    renderMemoryDetail(null);
    memoryState.selectedPath = '';
    showToast(t('memoryDeleted'), 'success');
    await loadMemoryFiles();
    if (typeof refreshWikiGraph === 'function') refreshWikiGraph();
  } catch (e) {
    console.error('Memory delete failed:', e);
    showToast(e.message || t('memoryDeleteFailed'), 'error');
  }
}

function closeMemoryModal() {
  const overlay = document.getElementById('memory-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function indexMemoryFiles() {
  const btn = document.getElementById('btn-memory-index');
  if (btn) btn.disabled = true;
  try {
    await memoryApi('/api/memory/index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: cwdInput.value.trim() || '' }),
    });
    showToast(t('memoryIndexed'), 'success');
    await loadMemoryFiles();
  } catch (e) {
    console.error('Memory index failed:', e);
    showToast(t('memoryIndexFailed', { message: e.message }), 'error');
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
    const results = await memoryApi(`/api/memory/search?q=${encodeURIComponent(text)}&${currentCwdParam()}`);
    if (results && results.length > 0) renderMemoryHit(assistantEl, results);
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
      ${results.slice(0, 5).map(r => `<span class="memory-hint-tag" title="${esc(t('view'))}: ${esc(r.title || r.name)}" data-file="${esc(r.file || r.path || r.name)}">${esc(r.title || r.name)}</span>`).join('')}
      ${count > 5 ? `<span class="memory-hint-more">+${count - 5} ${esc(t('itemCount', { count: count - 5 }))}</span>` : ''}
    </div>`;
  hint.querySelectorAll('.memory-hint-tag').forEach(tag => tag.addEventListener('click', () => viewMemoryFile(tag.dataset.file)));
  const bubble = el.querySelector('.msg-bubble');
  if (bubble) bubble.insertBefore(hint, bubble.querySelector('.msg-content') || null);
}

function openMemoryEditor(filename, preset) {
  const overlay = document.getElementById('memory-edit-overlay');
  const nameInput = document.getElementById('memory-edit-filename');
  const contentArea = document.getElementById('memory-edit-content');
  if (!overlay || !nameInput || !contentArea) return;
  if (preset && preset.content) {
    nameInput.value = preset.filename || '';
    delete nameInput.dataset.original;
    contentArea.value = preset.content;
  } else if (filename) {
    nameInput.value = filename;
    nameInput.dataset.original = filename;
    contentArea.value = t('loading');
    memoryApi('/api/memory/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, cwd: cwdInput.value.trim() || '' }),
    }).then(data => {
      contentArea.value = data.content || data.body || '';
    }).catch(e => {
      contentArea.value = '';
      showToast(t('memoryFileLoadFailed', { message: e.message }), 'error');
    });
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
  const btn = document.getElementById('btn-memory-edit-save');
  if (!filename || !content) return;
  if (btn) btn.disabled = true;
  try {
    const saved = await memoryApi('/api/memory/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content, cwd: cwdInput.value.trim() || '' }),
    });
    closeMemoryEditor();
    showToast(t('memorySaved'), 'success');
    await loadMemoryFiles();
    await selectMemory(saved.path || saved.file || saved.name || filename);
  } catch (e) {
    console.error('Memory save failed:', e);
    showToast(t('memorySaveFailed', { message: e.message }), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function initMemoryUI() {
  document.getElementById('btn-memory-import')?.addEventListener('click', () => openFilePicker(handleMemoryImport));
  document.getElementById('btn-memory-organize')?.addEventListener('click', organizeMemoryLinks);
  document.getElementById('btn-memory-new')?.addEventListener('click', () => openMemoryEditor());
  document.getElementById('memory-modal-close')?.addEventListener('click', closeMemoryModal);
  document.getElementById('memory-modal-edit')?.addEventListener('click', editCurrentMemoryFile);
  document.getElementById('memory-modal-delete')?.addEventListener('click', deleteCurrentMemoryFile);
  document.getElementById('memory-modal-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeMemoryModal(); });
  document.getElementById('btn-memory-edit-save')?.addEventListener('click', saveMemoryEdit);
  document.getElementById('btn-memory-edit-cancel')?.addEventListener('click', closeMemoryEditor);
  document.getElementById('memory-edit-close')?.addEventListener('click', closeMemoryEditor);
  document.getElementById('memory-edit-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeMemoryEditor(); });
  document.getElementById('btn-memory-organize-apply')?.addEventListener('click', applySelectedMemoryOrganizeActions);
  document.getElementById('btn-memory-organize-cancel')?.addEventListener('click', closeMemoryOrganizeReview);
  document.getElementById('memory-organize-close')?.addEventListener('click', closeMemoryOrganizeReview);
  document.getElementById('memory-organize-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget && !memoryOrganizeState.applying) closeMemoryOrganizeReview(); });
  document.getElementById('btn-graph-reset')?.addEventListener('click', () => { if (typeof refreshWikiGraph === 'function') refreshWikiGraph(); });
  document.querySelectorAll('[data-memory-view]').forEach(btn => btn.addEventListener('click', () => switchMemoryView(btn.dataset.memoryView)));
  document.getElementById('memory-search-input')?.addEventListener('input', e => {
    clearTimeout(memorySearchTimer);
    memorySearchTimer = setTimeout(() => { memoryState.query = e.target.value || ''; renderMemoryList(); }, 300);
  });
  ['type', 'source', 'inject'].forEach(field => {
    document.getElementById(`memory-filter-${field}`)?.addEventListener('change', e => { memoryState.filters[field] = e.target.value || 'all'; renderMemoryList(); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.getElementById('page-memory')?.classList.contains('active')) {
      const input = document.getElementById('memory-search-input');
      if (input && document.activeElement !== input) { e.preventDefault(); input.focus(); }
    }
    if (e.key === 'Escape' && document.getElementById('memory-modal-overlay')?.style.display === 'flex') closeMemoryModal();
    if (e.key === 'Escape' && document.getElementById('memory-edit-overlay')?.style.display === 'flex') closeMemoryEditor();
    if (e.key === 'Escape' && document.getElementById('memory-organize-overlay')?.style.display === 'flex') closeMemoryOrganizeReview();
  });
}

function switchMemoryView(view) {
  memoryState.view = view || 'browse';
  document.getElementById('memory-browse-view').hidden = memoryState.view !== 'browse';
  document.getElementById('memory-graph-view').hidden = memoryState.view !== 'graph';
  document.querySelectorAll('[data-memory-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.memoryView === memoryState.view));
  if (memoryState.view === 'graph' && typeof refreshWikiGraph === 'function') refreshWikiGraph();
}

async function handleMemoryImport(selectedItems) {
  const serverPaths = selectedItems.filter(item => item.source === 'server').map(item => item.path);
  const clientFiles = selectedItems.filter(item => item.source === 'client' || item.source === 'local');
  let imported = 0;
  if (serverPaths.length > 0) {
    try {
      const data = await memoryApi('/api/memory/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: serverPaths, cwd: cwdInput.value.trim() || '' }) });
      if (data.ok) imported += data.imported.length;
    } catch (e) { showToast(t('memoryImportFailed', { message: e.message }), 'error'); }
  }
  for (const item of clientFiles) {
    if (item._file) {
      try {
        const fd = new FormData();
        fd.append('file', item._file);
        fd.append('cwd', cwdInput.value.trim() || '');
        const data = await memoryApi('/api/memory/upload', { method: 'POST', body: fd });
        if (data.ok) imported++;
      } catch (e) { showToast(t('memoryImportFailed', { message: e.message }), 'error'); }
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
  openMemoryOrganizeLoading();
  try {
    const data = await memoryApi('/api/memory/organize/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: cwdInput.value.trim() || '' }) });
    if (data.linked > 0) {
      showToast(t('organizeMemorySuccess', { linked: data.linked }), 'success');
      await indexMemoryFiles();
    }
    if (data.message) showToast(data.message, data.actions && data.actions.length ? 'info' : 'error');
    if (data.actions && data.actions.length) openMemoryOrganizeReview(data);
    else {
      closeMemoryOrganizeReview();
      if (!data.linked) showToast(t('organizeNoActions'), 'info');
    }
    if (typeof initWikiGraph === 'function') initWikiGraph();
  } catch (e) {
    console.error('Organize memory failed:', e);
    showToast(t('memoryOrganizeFailed'), 'error');
    closeMemoryOrganizeReview();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function memoryOrganizeActionLabel(action) {
  return t('memoryAction' + String(action || '').charAt(0).toUpperCase() + String(action || '').slice(1));
}

function openMemoryOrganizeLoading() {
  const overlay = document.getElementById('memory-organize-overlay');
  const summaryEl = document.getElementById('memory-organize-summary');
  const listEl = document.getElementById('memory-organize-list');
  const errorsEl = document.getElementById('memory-organize-errors');
  const applyBtn = document.getElementById('btn-memory-organize-apply');
  memoryOrganizeState.actions = [];
  memoryOrganizeState.applying = false;
  if (!overlay || !summaryEl || !listEl) return;
  summaryEl.textContent = t('memoryOrganizingStatus');
  listEl.innerHTML = `<div class="memory-organize-loading" role="status" aria-live="polite"><span class="memory-organize-spinner" aria-hidden="true"></span><div><div class="memory-organize-loading-title">${esc(t('memoryOrganizingTitle'))}</div><div class="memory-organize-loading-desc">${esc(t('memoryOrganizingDesc'))}</div></div></div>`;
  if (errorsEl) { errorsEl.style.display = 'none'; errorsEl.textContent = ''; }
  if (applyBtn) applyBtn.disabled = true;
  overlay.style.display = 'flex';
}

function openMemoryOrganizeReview(data) {
  const overlay = document.getElementById('memory-organize-overlay');
  const summaryEl = document.getElementById('memory-organize-summary');
  const listEl = document.getElementById('memory-organize-list');
  const errorsEl = document.getElementById('memory-organize-errors');
  if (!overlay || !summaryEl || !listEl) return;
  const actions = data.actions || [];
  memoryOrganizeState.actions = actions;
  memoryOrganizeState.applying = false;
  const applyBtn = document.getElementById('btn-memory-organize-apply');
  if (applyBtn) applyBtn.disabled = false;
  summaryEl.textContent = t('memoryOrganizeSummary', { count: actions.length, links: data.link_candidates || data.linked || 0, model: data.model || '-' });
  const lowRisk = new Set(['link', 'refine']);
  listEl.innerHTML = actions.map(action => {
    const checked = lowRisk.has(action.action) ? 'checked' : '';
    const risk = lowRisk.has(action.action) ? t('memoryLowRisk') : t('memoryHighRisk');
    const contentPreview = action.new_content ? `<details class="memory-organize-preview"><summary>${esc(t('previewNewContent'))}</summary><pre>${esc(action.new_content.slice(0, 1200))}${action.new_content.length > 1200 ? '\n...' : ''}</pre></details>` : '';
    const newFileLabel = action.action === 'refine' ? t('refineAs') : t('mergeAs');
    const newFile = action.new_filename ? `<div class="memory-organize-newfile">${esc(newFileLabel)}: <code>${esc(action.new_filename)}</code></div>` : '';
    return `<label class="memory-organize-item" data-action-id="${esc(String(action.id))}"><div class="memory-organize-row"><input type="checkbox" class="memory-organize-check" ${checked}><span class="memory-organize-badge action-${esc(action.action)}">${esc(memoryOrganizeActionLabel(action.action))}</span><span class="memory-organize-risk">${esc(risk)}</span><span class="memory-organize-targets">${esc((action.targets || []).join(' + '))}</span></div><div class="memory-organize-reason">${esc(action.reason || t('noDescription'))}</div>${newFile}${contentPreview}</label>`;
  }).join('');
  if (errorsEl) { errorsEl.style.display = 'none'; errorsEl.textContent = ''; }
  overlay.style.display = 'flex';
}

function closeMemoryOrganizeReview() {
  if (memoryOrganizeState.applying) return;
  const overlay = document.getElementById('memory-organize-overlay');
  const applyBtn = document.getElementById('btn-memory-organize-apply');
  if (overlay) overlay.style.display = 'none';
  if (applyBtn) applyBtn.disabled = false;
}

async function applySelectedMemoryOrganizeActions() {
  const listEl = document.getElementById('memory-organize-list');
  const errorsEl = document.getElementById('memory-organize-errors');
  const btn = document.getElementById('btn-memory-organize-apply');
  if (!listEl || memoryOrganizeState.applying) return;
  const selectedIds = Array.from(listEl.querySelectorAll('.memory-organize-item')).filter(item => item.querySelector('.memory-organize-check')?.checked).map(item => Number(item.dataset.actionId));
  const selected = memoryOrganizeState.actions.filter(action => selectedIds.includes(Number(action.id)) && action.action !== 'keep');
  if (!selected.length) { showToast(t('memoryOrganizeNoSelected'), 'info'); return; }
  memoryOrganizeState.applying = true;
  if (btn) btn.disabled = true;
  try {
    const data = await memoryApi('/api/memory/organize/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: cwdInput.value.trim() || '', actions: selected }) });
    if (data.errors && data.errors.length) {
      if (errorsEl) { errorsEl.style.display = 'block'; errorsEl.innerHTML = data.errors.map(err => `<div>${esc(err.action)} ${esc((err.targets || []).join(', '))}: ${esc(err.error)}</div>`).join(''); }
      showToast(t('memoryOrganizeApplyPartial'), 'error');
    } else {
      showToast(t('memoryOrganizeApplied', { merged: data.merged || 0, refined: data.refined || 0, linked: data.linked || 0, deleted: data.deleted || 0, rewritten: data.rewritten || 0 }), 'success');
      memoryOrganizeState.applying = false;
      closeMemoryOrganizeReview();
    }
    await indexMemoryFiles();
    if (typeof initWikiGraph === 'function') initWikiGraph();
  } catch (e) {
    console.error('Apply memory organize failed:', e);
    showToast(t('memoryOrganizeApplyFailed'), 'error');
  } finally {
    memoryOrganizeState.applying = false;
    if (btn) btn.disabled = false;
  }
}
