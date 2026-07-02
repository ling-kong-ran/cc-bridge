// 资产页逻辑
let artifacts = [];
let artifactFilter = 'all';
let artifactSearch = '';

function initArtifactsUI() {
  document.getElementById('btn-artifacts-refresh')?.addEventListener('click', function() { loadArtifacts(true); });
  document.getElementById('btn-artifacts-organize')?.addEventListener('click', function() {
    var cwd = (cwdInput?.value?.trim()) || '';
    if (!cwd) { addSystemMsg(t('setCwdFirst'), true); return; }
    var items = filteredArtifacts();
    if (!items.length) { addSystemMsg(t('noMatches'), true); return; }
    organizeArtifactsToWiki(items, cwd);
  });
  document.querySelectorAll('.artifacts-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      artifactFilter = tab.dataset.filter || 'all';
      document.querySelectorAll('.artifacts-tab').forEach(function(t) { t.classList.toggle('active', t === tab); });
      renderArtifacts();
    });
  });
  var search = document.getElementById('artifacts-search');
  if (search) {
    search.addEventListener('input', function() {
      artifactSearch = search.value.trim().toLowerCase();
      renderArtifacts();
    });
  }
}

async function loadArtifacts(force) {
  if (force === undefined) force = false;
  var content = document.getElementById('artifacts-content');
  if (!force && artifacts.length) {
    renderArtifacts();
    return;
  }
  if (content) content.innerHTML = '<div class="artifacts-empty">' + esc(t('loading')) + '</div>';
  try {
    var resp = await fetch('/api/artifacts?limit_sessions=30');
    var data = await resp.json();
    artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
    renderArtifacts();
  } catch (e) {
    if (content) content.innerHTML = '<div class="artifacts-empty error">' + esc(t('artifactsLoadFailed')) + '</div>';
  }
}

function filteredArtifacts() {
  return artifacts.filter(function(item) {
    if (artifactFilter !== 'all' && item.kind !== artifactFilter) return false;
    if (!artifactSearch) return true;
    return [item.label, item.value, item.session_title, item.cwd].some(function(v) {
      return String(v || '').toLowerCase().includes(artifactSearch);
    });
  });
}

function renderArtifacts() {
  var content = document.getElementById('artifacts-content');
  var summary = document.getElementById('artifacts-summary');
  if (!content) return;
  var visible = filteredArtifacts();
  var counts = artifacts.reduce(function(acc, item) {
    acc[item.kind] = (acc[item.kind] || 0) + 1;
    return acc;
  }, {});
  if (summary) {
    summary.textContent = t('artifactsSummary', {
      total: artifacts.length,
      images: counts.image || 0,
      files: counts.file || 0,
      links: counts.link || 0,
    });
  }
  if (!visible.length) {
    content.innerHTML = artifacts.length ? '<div class="artifacts-empty">' + esc(t('noMatches')) + '</div>' : '<div class="artifacts-empty-enhanced"><div class="empty-icon">📦</div><div class="empty-title">' + esc(t('noArtifacts')) + '</div><div class="empty-hint">' + esc(t('artifactsEmptyHint')) + '</div></div>';
    return;
  }
  var imageItems = visible.filter(function(item) { return item.kind === 'image'; });
  var otherItems = visible.filter(function(item) { return item.kind !== 'image'; });
  var html = '';
  if (imageItems.length) {
    html += '<div class="artifacts-grid">';
    html += imageItems.map(renderArtifactImageCard).join('');
    html += '</div>';
  }
  if (otherItems.length) {
    html += '<div class="artifacts-table">' + otherItems.map(renderArtifactRow).join('') + '</div>';
  }
  content.innerHTML = html;
  bindArtifactActions(content);
}

function renderArtifactImageCard(item) {
  var href = item.href || item.value;
  var preview = item.href || '';
  return '<article class="artifact-card">' +
    '<button class="artifact-preview" type="button" data-open="' + esc(href) + '"' + (href ? '' : ' disabled') + '>' +
    (preview ? '<img src="' + esc(preview) + '" alt="' + esc(item.label) + '">' : '<span class="artifact-file-icon">IMG</span>') +
    '</button>' +
    '<div class="artifact-card-body">' +
    '<div class="artifact-title" title="' + esc(item.value) + '">' + esc(item.label) + '</div>' +
    '<div class="artifact-meta">' + esc(item.session_title || t('newChat')) + ' · ' + esc(formatTime(item.timestamp)) + '</div>' +
    '<div class="artifact-actions">' + renderArtifactButtons(item) + '</div>' +
    '</div></article>';
}

function renderArtifactRow(item) {
  var icon = item.kind === 'file' ? 'FILE' : 'LINK';
  return '<article class="artifact-row">' +
    '<div class="artifact-row-icon">' + icon + '</div>' +
    '<div class="artifact-row-main">' +
    '<div class="artifact-title" title="' + esc(item.value) + '">' + esc(item.label) + '</div>' +
    '<div class="artifact-value">' + esc(item.value) + '</div>' +
    '<div class="artifact-meta">' + esc(item.session_title || t('newChat')) + ' · ' + esc(formatTime(item.timestamp)) + '</div>' +
    '</div>' +
    '<div class="artifact-actions">' + renderArtifactButtons(item) + '</div>' +
    '</article>';
}

function renderArtifactButtons(item) {
  var href = item.href || (/^https?:/i.test(item.value || '') ? item.value : '');
  var html = '';
  if (href) html += '<button class="btn-mini" type="button" data-open="' + esc(href) + '">' + esc(t('open')) + '</button>';
  html += '<button class="btn-mini" type="button" data-copy="' + esc(item.value) + '">' + esc(t('copy')) + '</button>';
  html += '<button class="btn-mini" type="button" data-session="' + esc(item.session_id) + '">' + esc(t('chat')) + '</button>';
  return html;
}

function bindArtifactActions(root) {
  root.querySelectorAll('[data-open]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var href = btn.dataset.open;
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    });
  });
  root.querySelectorAll('[data-copy]').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy || '');
        addSystemMsg(t('copied'));
      } catch (e) {
        addSystemMsg(t('copyFailed'), true);
      }
    });
  });
  root.querySelectorAll('[data-session]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var session = cachedSessions.find(function(s) { return s.session_id === btn.dataset.session; }) || artifacts.find(function(a) { return a.session_id === btn.dataset.session; });
      showPage('chat');
      if (session && session.session_id) {
        resumeSession(session.session_id, session.cwd || '', session.model || '', Number(session.total_cost_usd || 0), session.remote_target_id || '', session.total_tokens || null, session.cli || '');
      }
    });
  });
}

// 整理所有资产到 Wiki — 整体按钮（不是每个 Item 一个按钮）
async function organizeArtifactsToWiki(items, cwd) {
  var dateStr = new Date().toISOString().slice(0, 10);
  // 按 kind 分组
  var groups = {};
  items.forEach(function(item) {
    var kind = item.kind || 'file';
    if (!groups[kind]) groups[kind] = [];
    groups[kind].push(item);
  });
  var kindLabels = { image: '图片', file: '文件', link: '链接' };
  var kindLabelsEn = { image: 'Image', file: 'File', link: 'Link' };
  var totalCount = items.length;
  var saved = 0;
  addSystemMsg(t('organizingToWiki', { total: totalCount }));
  for (var kind in groups) {
    var kindItems = groups[kind];
    var label = (typeof lang !== 'undefined' && lang === 'zh') ? (kindLabels[kind] || kind) : (kindLabelsEn[kind] || kind);
    var lines = kindItems.map(function(item, i) {
      var itemLabel = item.label || 'unnamed';
      var value = item.value || '';
      return '### ' + (i + 1) + '. ' + label + ': ' + itemLabel + '\n\n> ' + value + '\n';
    }).join('\n');
    var content = '---\nname: Artifacts - ' + label + '\nsource: ccb-gui Artifacts, ' + dateStr + '\nkind: artifact-collection\n---\n\n# ' + label + ' (' + dateStr + ')\n\n共 ' + kindItems.length + ' 项。\n\n' + lines + '\n---\n\n## 要点\n\n（请在下方补充人工整理的要点）\n';
    var filename = 'artifacts-' + kind + '-' + dateStr + '.md';
    try {
      var resp = await fetch('/api/memory/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: filename, content: content, cwd: cwd }),
      });
      if (resp.ok) saved++;
    } catch (e) {
      console.error('Save artifact memory failed:', e);
    }
  }
  addSystemMsg(t('organizeToWikiDone', { saved: saved, total: totalCount }));
}

function buildArtifactWikiEntries(items) {
  var dateStr = new Date().toISOString().slice(0, 10);
  var lines = items.map(function(item, i) {
    var label = item.label || 'unnamed';
    var value = item.value || '';
    var kind = item.kind || 'file';
    var kindLabel = kind === 'image' ? '图片' : kind === 'file' ? '文件' : '链接';
    return '### ' + (i + 1) + '. ' + kindLabel + ': ' + label + '\n\n> 路径/地址: `' + value + '`\n';
  }).join('\n');
  var itemCount = items.length;
  return {
    filename: 'artifacts-' + dateStr + '.md',
    content: '---\nname: Artifacts 整理\nsource: ccb-gui Artifacts, ' + dateStr + '\nkind: auto-collection\n---\n\n# 资产整理 (' + dateStr + ')\n\n共整理 ' + itemCount + ' 项资产。\n\n' + lines + '\n---\n\n## 要点\n\n（请在下方补充人工整理的要点）\n',
  };
}

// 导入 memory.js 的 openMemoryEditor
