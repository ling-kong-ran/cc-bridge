// 资产页逻辑
let artifacts = [];
let artifactFilter = 'all';
let artifactSearch = '';

function initArtifactsUI() {
  document.getElementById('btn-artifacts-refresh')?.addEventListener('click', () => loadArtifacts(true));
  document.querySelectorAll('.artifacts-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      artifactFilter = tab.dataset.filter || 'all';
      document.querySelectorAll('.artifacts-tab').forEach(t => t.classList.toggle('active', t === tab));
      renderArtifacts();
    });
  });
  const search = document.getElementById('artifacts-search');
  if (search) {
    search.addEventListener('input', () => {
      artifactSearch = search.value.trim().toLowerCase();
      renderArtifacts();
    });
  }
}

async function loadArtifacts(force = false) {
  const content = document.getElementById('artifacts-content');
  if (!force && artifacts.length) {
    renderArtifacts();
    return;
  }
  if (content) content.innerHTML = `<div class="artifacts-empty">${esc(t('loading'))}</div>`;
  try {
    const resp = await fetch('/api/artifacts?limit_sessions=30');
    const data = await resp.json();
    artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
    renderArtifacts();
  } catch (e) {
    if (content) content.innerHTML = `<div class="artifacts-empty error">${esc(t('artifactsLoadFailed'))}</div>`;
  }
}

function filteredArtifacts() {
  return artifacts.filter(item => {
    if (artifactFilter !== 'all' && item.kind !== artifactFilter) return false;
    if (!artifactSearch) return true;
    return [item.label, item.value, item.session_title, item.cwd].some(value => String(value || '').toLowerCase().includes(artifactSearch));
  });
}

function renderArtifacts() {
  const content = document.getElementById('artifacts-content');
  const summary = document.getElementById('artifacts-summary');
  if (!content) return;
  const visible = filteredArtifacts();
  const counts = artifacts.reduce((acc, item) => {
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
    content.innerHTML = `<div class="artifacts-empty">${esc(t(artifacts.length ? 'noMatches' : 'noArtifacts'))}</div>`;
    return;
  }
  const imageItems = visible.filter(item => item.kind === 'image');
  const otherItems = visible.filter(item => item.kind !== 'image');
  content.innerHTML = [
    imageItems.length ? `<div class="artifacts-grid">${imageItems.map(renderArtifactImageCard).join('')}</div>` : '',
    otherItems.length ? `<div class="artifacts-table">${otherItems.map(renderArtifactRow).join('')}</div>` : '',
  ].join('');
  bindArtifactActions(content);
}

function renderArtifactImageCard(item) {
  const href = item.href || item.value;
  const preview = item.href || '';
  return `<article class="artifact-card">
    <button class="artifact-preview" type="button" data-open="${esc(href)}" ${href ? '' : 'disabled'}>
      ${preview ? `<img src="${esc(preview)}" alt="${esc(item.label)}">` : '<span class="artifact-file-icon">IMG</span>'}
    </button>
    <div class="artifact-card-body">
      <div class="artifact-title" title="${esc(item.value)}">${esc(item.label)}</div>
      <div class="artifact-meta">${esc(item.session_title || t('newChat'))} · ${esc(formatTime(item.timestamp))}</div>
      <div class="artifact-actions">${renderArtifactButtons(item)}</div>
    </div>
  </article>`;
}

function renderArtifactRow(item) {
  const icon = item.kind === 'file' ? 'FILE' : 'LINK';
  return `<article class="artifact-row">
    <div class="artifact-row-icon">${icon}</div>
    <div class="artifact-row-main">
      <div class="artifact-title" title="${esc(item.value)}">${esc(item.label)}</div>
      <div class="artifact-value">${esc(item.value)}</div>
      <div class="artifact-meta">${esc(item.session_title || t('newChat'))} · ${esc(formatTime(item.timestamp))}</div>
    </div>
    <div class="artifact-actions">${renderArtifactButtons(item)}</div>
  </article>`;
}

function renderArtifactButtons(item) {
  const href = item.href || (/^https?:/i.test(item.value || '') ? item.value : '');
  return `${href ? `<button class="btn-mini" type="button" data-open="${esc(href)}">${esc(t('open'))}</button>` : ''}
    <button class="btn-mini" type="button" data-copy="${esc(item.value)}">${esc(t('copy'))}</button>
    <button class="btn-mini" type="button" data-session="${esc(item.session_id)}">${esc(t('chat'))}</button>`;
}

function bindArtifactActions(root) {
  root.querySelectorAll('[data-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      const href = btn.dataset.open;
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    });
  });
  root.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy || '');
        addSystemMsg(t('copied'));
      } catch (e) {
        addSystemMsg(t('copyFailed'), true);
      }
    });
  });
  root.querySelectorAll('[data-session]').forEach(btn => {
    btn.addEventListener('click', () => {
      const session = cachedSessions.find(s => s.session_id === btn.dataset.session) || artifacts.find(a => a.session_id === btn.dataset.session);
      showPage('chat');
      if (session?.session_id) resumeSession(session.session_id, session.cwd || '', session.model || '', Number(session.total_cost_usd || 0), session.remote_target_id || '', session.total_tokens || null, session.cli || '');
    });
  });
}
