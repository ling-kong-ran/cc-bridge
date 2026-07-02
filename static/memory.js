// Memory 浏览与编辑
let memoryFilesCache = [];
var currentMemoryView = "graph";
var memoryTreeCache = null;

function currentCwdParam() {
  return `cwd=${encodeURIComponent(cwdInput.value.trim() || '')}`;
}

function switchMemoryView(view) {
  currentMemoryView = view;
  document.querySelectorAll(".view-toggle-btn").forEach(function(b) { b.classList.toggle("active", b.dataset.view === view); });
  var treePanel = document.getElementById("memory-tree-panel");
  var graphPanel = document.getElementById("memory-graph-panel");
  var listPanel = document.querySelector(".memory-list-panel");
  var layout = document.querySelector(".memory-layout");
  if (view === "graph") {
    if (graphPanel) graphPanel.style.display = "block";
    if (treePanel) treePanel.style.display = "none";
    if (listPanel) listPanel.style.display = "none";
    if (layout) layout.classList.remove("has-tree");
    if (typeof initWikiGraph === "function") {
      initWikiGraph();
    }
  } else if (view === "wiki") {
    if (graphPanel) graphPanel.style.display = "none";
    if (treePanel) treePanel.style.display = "block";
    if (listPanel) listPanel.style.display = "block";
    if (layout) layout.classList.add("has-tree");
    loadMemoryTree();
    if (typeof initWikiGraph === "function") {
      initWikiGraph();
    }
  } else {
    if (graphPanel) graphPanel.style.display = "none";
    if (treePanel) treePanel.style.display = "none";
    if (listPanel) listPanel.style.display = "block";
    if (layout) layout.classList.remove("has-tree");
    var searchVal = document.getElementById("memory-search-input")?.value?.trim() || "";
    if (searchVal) { searchMemory(); }
    else { renderMemoryFiles(memoryFilesCache); }
  }
}

async function loadMemoryTree() {
  var treeEl = document.getElementById("memory-tree");
  if (!treeEl) return;
  try {
    var resp = await fetch("/api/memory/tree?" + currentCwdParam());
    var data = await resp.json();
    memoryTreeCache = data.tree || [];
    renderMemoryTree(memoryTreeCache, treeEl);
  } catch (e) {
    console.error("Memory tree load failed:", e);
  }
}

function renderMemoryTree(tree, el) {
  if (!tree || !tree.length) {
    el.innerHTML = "<div class=\"memory-empty-enhanced\"><div class=\"empty-icon\">📂</div><div class=\"empty-title\">" + esc(t("noMemoryFiles")) + "</div><div class=\"memory-empty-actions\"><button class=\"btn-mini\" id=\"btn-memory-new-from-tree\">+ " + esc(t("newMemory")) + "</button></div></div>";
    var newBtn = el.querySelector("#btn-memory-new-from-tree");
    if (newBtn) newBtn.addEventListener("click", function() { openMemoryEditor(); });
    return;
  }
  el.innerHTML = tree.map(function(node) { return renderTreeNode(node); }).join("");
  el.querySelectorAll(".dir-node").forEach(function(label) {
    label.addEventListener("click", function(e) {
      var node = label.closest(".memory-tree-node");
      if (node) node.classList.toggle("collapsed");
    });
  });
  el.querySelectorAll(".file-node").forEach(function(label) {
    label.addEventListener("click", function() {
      var filePath = label.dataset.file;
      if (filePath) viewMemoryFile(filePath);
    });
  });
}

function renderTreeNode(node) {
  if (node.type === "dir") {
    var childrenHtml = (node.children && node.children.length) ? node.children.map(function(c) { return renderTreeNode(c); }).join("") : "";
    return "<div class=\"memory-tree-node collapsed\"><div class=\"node-label dir-node\"><span class=\"node-arrow\">▼</span><span class=\"node-icon\">📁</span><span>" + esc(node.title || node.name) + "</span></div><div class=\"node-children\">" + (childrenHtml || "") + "</div></div>";
  } else {
    return "<div class=\"memory-tree-node\"><div class=\"node-label file-node\" data-file=\"" + esc(node.name) + "\"><span class=\"node-arrow\" style=\"visibility:hidden\">▸</span><span class=\"node-icon\">📄</span><span>" + esc(node.title || node.name) + "</span></div></div>";
  }
}

function updateMemoryStatus(files) {
  var el = document.getElementById("memory-status-info");
  if (!el) return;
  if (!files || !files.length) {
    el.textContent = "📁 0 files";
    return;
  }
  var latest = files.reduce(function(max, f) { return Math.max(max, f.updated_at || 0); }, 0);
  var timeStr = latest ? new Date(latest * 1000).toLocaleString() : "";
  el.textContent = "📁 " + files.length + " files" + (timeStr ? " · last updated " + timeStr : "");
}

async function loadMemoryFiles() {
  try {
    const resp = await fetch(`/api/memory/files?${currentCwdParam()}`);
    memoryFilesCache = await resp.json();
    updateMemoryStatus(memoryFilesCache);
    if (currentMemoryView !== 'graph') {
      renderMemoryFiles(memoryFilesCache);
    } else if (typeof initWikiGraph === 'function') {
      initWikiGraph();
    }
  } catch (e) {
    console.error('Memory load failed:', e);
  }
}

function renderMemoryFiles(files) {
  const el = document.getElementById('memory-list');
  if (!el) return;
  if (!files || !files.length) {
    el.innerHTML = "<div class=\"memory-empty-enhanced\"><div class=\"empty-icon\">📂</div><div class=\"empty-title\">" + esc(t('noMemoryFiles')) + "</div><div class=\"empty-hint\">" + esc(t('memoryEmptyHint')) + "</div><div class=\"memory-empty-actions\"><button class=\"btn-mini\" id=\"btn-memory-new-from-empty\">+ " + esc(t('newMemory')) + "</button></div></div>";
    var newBtn = el.querySelector("#btn-memory-new-from-empty");
    if (newBtn) newBtn.addEventListener("click", function() { openMemoryEditor(); });
    return;
  }
  el.innerHTML = files.map(function(f) {
    var d = new Date(f.updated_at * 1000);
    var timeStr = d.toLocaleString();
    var sizeStr = f.size < 1024 ? f.size + "B" : f.size < 1048576 ? (f.size / 1024).toFixed(1) + "KB" : (f.size / 1048576).toFixed(1) + "MB";
    var displayPath = f.file || f.name || "";
    return "<div class=\"memory-file-item\" data-file=\"" + esc(f.name) + "\"><div class=\"memory-file-head\"><span class=\"memory-file-name\">" + esc(f.title || f.name) + "</span><div class=\"memory-file-actions\"><button class=\"agent-action-btn memory-edit-btn\" data-file=\"" + esc(f.name) + "\" title=\"" + esc(t('editMemory')) + "\">✏️</button><button class=\"agent-action-btn memory-view-btn\" data-file=\"" + esc(f.name) + "\" title=\"" + esc(t('view')) + "\">👁️</button><button class=\"agent-action-btn agent-del-btn memory-del-btn\" data-file=\"" + esc(f.name) + "\" title=\"" + esc(t('delete')) + "\">🗑️</button></div></div><div style=\"display:flex;gap:12px;align-items:center\"><span class=\"memory-file-meta\">" + esc(sizeStr) + " · " + esc(timeStr) + "</span>" + (displayPath ? "<span class=\"memory-file-path\">" + esc(displayPath) + "</span>" : "") + "</div></div>";
  }).join('');

  el.querySelectorAll('.memory-edit-btn').forEach(btn => {
    btn.addEventListener('click', function(e) { e.stopPropagation(); openMemoryEditor(btn.dataset.file); });
  });
  el.querySelectorAll('.memory-view-btn').forEach(btn => {
    btn.addEventListener('click', function(e) { e.stopPropagation(); viewMemoryFile(btn.dataset.file); });
  });
  el.querySelectorAll('.memory-del-btn').forEach(btn => {
    btn.addEventListener('click', function(e) { e.stopPropagation(); deleteMemoryFilePrompt(btn.dataset.file); });
  });
}

async function searchMemory() {
  const q = document.getElementById('memory-search-input')?.value.trim();
  if (!q) {
    // If currently in wiki view, switch back to list
    if (currentMemoryView === 'wiki') {
      switchMemoryView('list');
    }
    renderMemoryFiles(memoryFilesCache);
    updateMemoryStatus(memoryFilesCache);
    return;
  }
  // Switch to list view when searching
  if (currentMemoryView === 'wiki') {
    switchMemoryView('list');
  }
  try {
    const resp = await fetch(`/api/memory/search?q=${encodeURIComponent(q)}&${currentCwdParam()}`);
    const results = await resp.json();
    const el = document.getElementById('memory-list');
    if (!results || !results.length) {
      el.innerHTML = `<p class="empty-state">${esc(t('noMemoryResults'))}</p>`;
      return;
    }
    el.innerHTML = results.map(r => {
      const snippet = r.snippet ? r.snippet.replace(/<mark>/g, '<mark class="memory-hl">').replace(/<\/mark>/g, '</mark>') : esc(r.title);
      return `
        <div class="memory-file-item" data-file="${esc(r.name)}">
          <div class="memory-file-head">
            <span class="memory-file-name">${esc(r.title || r.name)}</span>
            <button class="agent-action-btn memory-view-btn" data-file="${esc(r.name)}" title="${esc(t('view'))}">&#128065;</button>
          </div>
          <div class="memory-file-snippet">${snippet}</div>
        </div>
      `;
    }).join('');
    el.querySelectorAll('.memory-view-btn').forEach(btn => {
      btn.addEventListener('click', () => viewMemoryFile(btn.dataset.file));
    });
  } catch (e) {
    console.error('Memory search failed:', e);
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
    document.getElementById('memory-modal-title').textContent = data.title || data.name;
    document.getElementById('memory-modal-body').innerHTML = renderMd(data.body || data.content || '');
    document.getElementById('memory-modal-overlay').style.display = 'flex';
  } catch (e) {
    console.error('Memory file load failed:', e);
  }
}

function closeMemoryModal() {
  document.getElementById('memory-modal-overlay').style.display = 'none';
}

async function deleteMemoryFilePrompt(filename) {
  if (!confirm(t('confirmDeleteMemory', { name: filename }))) return;
  try {
    await fetch('/api/memory/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, cwd: cwdInput.value.trim() || '' }),
    });
    loadMemoryFiles();
  } catch (e) {
    console.error('Memory delete failed:', e);
  }
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
  const searchInput = document.getElementById('memory-search-input');
  if (searchInput) {
    let timer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(searchMemory, 300);
    });
  }
  document.getElementById('btn-memory-index')?.addEventListener('click', indexMemoryFiles);
  document.getElementById('btn-memory-import')?.addEventListener('click', () => openFilePicker(handleMemoryImport));
  document.getElementById('btn-memory-organize')?.addEventListener('click', organizeMemoryLinks);
  document.getElementById('btn-memory-new')?.addEventListener('click', () => openMemoryEditor());
  document.getElementById('memory-modal-close')?.addEventListener('click', closeMemoryModal);
  document.getElementById('memory-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMemoryModal();
  });
  document.getElementById('btn-memory-edit-save')?.addEventListener('click', saveMemoryEdit);
  document.getElementById('btn-memory-edit-cancel')?.addEventListener('click', closeMemoryEditor);
  document.getElementById('memory-edit-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMemoryEditor();
  });

  // View toggle
  document.querySelectorAll('.view-toggle-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchMemoryView(btn.dataset.view); });
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
