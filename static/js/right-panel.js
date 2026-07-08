(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getAppContext() {
    return root.appContext || {};
  }

  function t(key, vars = {}) {
    return root.i18n?.t ? root.i18n.t(key, vars) : key;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatMessage(data, fallbackKey = 'unknownError') {
    return root.i18n?.formatMessage ? root.i18n.formatMessage(data, fallbackKey) : String(data?.error || data?.message || t(fallbackKey) || '');
  }

  function setVisible(el, visible, display = '') {
    if (!el) return;
    el.style.display = visible ? display : 'none';
  }

  function isDisplay(el, display) {
    return !!el && el.style.display === display;
  }

  function saveGuiSettings(settings) {
    return getAppContext().saveGuiSettings?.(settings);
  }

  function shortenPlainPath(path, maxSegments = 3) {
    return getAppContext().shortenPlainPath?.(path, maxSegments) || String(path || '');
  }

  function quoteIntoInput(text, meta = null) {
    return getAppContext().quoteIntoInput?.(text, meta);
  }

  function renderAgentAddPopover() {
    return getAppContext().renderAgentAddPopover?.();
  }

  function hideAgentAddPopover() {
    return getAppContext().hideAgentAddPopover?.();
  }

  function addSessionAgent(name) {
    return getAppContext().addSessionAgent?.(name);
  }

  function loadSessionAgents() {
    return getAppContext().loadSessionAgents?.();
  }

  function getSessionAgents() {
    return getAppContext().getSessionAgents?.() || [];
  }

  const cwdInput = {
    get value() {
      return document.getElementById('cwd-input')?.value || '';
    },
  };

  const previewPanel = document.getElementById('file-preview-panel');
  const previewNameEl = document.getElementById('file-preview-name');
  const previewMetaEl = document.getElementById('file-preview-meta');
  const previewContentEl = document.getElementById('file-preview-content');
  const previewSearchEl = document.getElementById('file-preview-search');
  const previewCloseBtn = document.getElementById('file-preview-close');
  const previewQuoteSelectionBtn = document.getElementById('file-preview-quote-selection');
  let currentPreviewFile = null;
  let previewSelectedLines = new Set();
  let lastPreviewSelectedLine = 0;
  let previewDragState = null;
  let previewResizeState = null;

  const diffPreviewPanel = document.getElementById('diff-preview-panel');
  const diffPreviewNameEl = document.getElementById('diff-preview-name');
  const diffPreviewMetaEl = document.getElementById('diff-preview-meta');
  const diffPreviewContentEl = document.getElementById('diff-preview-content');
  const diffPreviewCloseBtn = document.getElementById('diff-preview-close');
  let diffPreviewDragState = null;
  let diffPreviewResizeState = null;

function refreshRightPaneFiles() {
  const cwd = (cwdInput?.value || '').trim();
  const filePanel = document.getElementById('file-tree-panel');
  if (!cwd || !filePanel || filePanel.style.display === 'none') return;
  loadFileTree(cwd);
}

const RIGHT_PANE_MIN = 300;
const RIGHT_PANE_MAX = 520;
const RIGHT_PANE_DEFAULT = 340;

function clampRightPaneWidth(value) {
  const viewportMax = Math.max(RIGHT_PANE_MIN, Math.min(RIGHT_PANE_MAX, Math.round(window.innerWidth * 0.42)));
  const width = Number(value) || RIGHT_PANE_DEFAULT;
  return Math.max(RIGHT_PANE_MIN, Math.min(viewportMax, Math.round(width)));
}

function applyRightPaneWidth(value) {
  if (window.matchMedia('(max-width: 760px)').matches) {
    document.documentElement.style.removeProperty('--pane-right');
    return;
  }
  document.documentElement.style.setProperty('--pane-right', `${clampRightPaneWidth(value)}px`);
}

function getCurrentRightPaneWidth() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--pane-right').trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : RIGHT_PANE_DEFAULT;
}

function initRightPanel() {
  const sidebar = document.getElementById('chat-sidebar');
  const toggleBtn = document.getElementById('btn-toggle-right-panel');
  const closeBtn = document.getElementById('btn-chat-sidebar-close');
  const resizer = document.getElementById('chat-sidebar-resizer');
  const addBtn = document.getElementById('btn-session-agent-add');
  const popover = document.getElementById('agent-add-popover');

  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

  const syncDesktopState = () => {
    if (!isMobile()) {
      sidebar.classList.remove('open');
      document.body.classList.remove('mobile-overlay', 'pane-right-open');
      document.getElementById('mobile-sidebar-backdrop')?.classList.remove('visible');
      applyRightPaneWidth(getCurrentRightPaneWidth());
      if (toggleBtn) toggleBtn.classList.toggle('active', !document.body.classList.contains('pane-right-collapsed'));
    }
  };

  const persistDesktopState = () => {
    if (isMobile()) return;
    saveGuiSettings({ right_panel_collapsed: document.body.classList.contains('pane-right-collapsed') });
  };

  const ensurePaneContent = (resetTab = false) => {
    if (resetTab) switchToSidebarTab('files');
    refreshRightPaneFiles();
  };

  const initResize = () => {
    if (!resizer) return;
    let startX = 0;
    let startWidth = 0;
    let nextWidth = 0;

    const finishResize = () => {
      document.body.classList.remove('resizing-right-pane');
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', finishResize);
      document.removeEventListener('pointercancel', finishResize);
      if (nextWidth) saveGuiSettings({ right_panel_width: nextWidth });
    };

    const onPointerMove = (e) => {
      nextWidth = clampRightPaneWidth(startWidth + startX - e.clientX);
      applyRightPaneWidth(nextWidth);
    };

    resizer.addEventListener('pointerdown', (e) => {
      if (isMobile() || document.body.classList.contains('pane-right-collapsed')) return;
      e.preventDefault();
      startX = e.clientX;
      startWidth = getCurrentRightPaneWidth();
      nextWidth = startWidth;
      document.body.classList.add('resizing-right-pane');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', finishResize);
      document.addEventListener('pointercancel', finishResize);
    });
  };

  const openPanel = () => {
    if (isMobile()) {
      sidebar.classList.add('open');
      document.body.classList.add('mobile-overlay');
      document.getElementById('mobile-sidebar-backdrop')?.classList.add('visible');
      if (toggleBtn) toggleBtn.classList.add('active');
      ensurePaneContent(true);
      return;
    }
    document.body.classList.remove('pane-right-collapsed');
    if (toggleBtn) toggleBtn.classList.add('active');
    persistDesktopState();
    ensurePaneContent(false);
  };

  const closePanel = (force = false) => {
    if (!force && !isMobile()) return;
    sidebar.classList.remove('open');
    document.body.classList.remove('mobile-overlay', 'pane-right-open');
    document.getElementById('mobile-sidebar-backdrop')?.classList.remove('visible');
    if (isMobile()) {
      if (toggleBtn) toggleBtn.classList.remove('active');
    } else {
      document.body.classList.add('pane-right-collapsed');
      if (toggleBtn) toggleBtn.classList.remove('active');
      persistDesktopState();
    }
  };

  const panelOpen = () => isMobile()
    ? sidebar.classList.contains('open')
    : !document.body.classList.contains('pane-right-collapsed');

  // Titlebar 切换按钮：桌面端折叠/展开常驻 Pane，移动端打开/关闭浮层
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (panelOpen()) closePanel(true); else openPanel();
    });
  }

  // 面板内 × 关闭按钮
  if (closeBtn) {
    closeBtn.addEventListener('click', () => closePanel(true));
  }

  // 标签切换
  document.querySelectorAll('.chat-sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      switchToSidebarTab(tabName);
      const cwd = (cwdInput?.value || '').trim();
      if (tabName === 'files' && cwd) loadFileTree(cwd);
      if (tabName === 'review' && cwd) loadReview(cwd);
    });
  });

  // review panel 文件点击 → 弹出 diff 预览浮动面板
  const reviewPanel = document.getElementById('review-panel');
  if (reviewPanel) {
    reviewPanel.addEventListener('click', (e) => {
      const item = e.target.closest('.review-file-item');
      if (!item) return;
      const file = item.dataset.file;
      const staged = item.dataset.staged === '1';
      if (file) loadReviewDiff(file, staged);
    });
  }

  // 文件树刷新按钮
  document.getElementById('btn-file-tree-refresh')?.addEventListener('click', () => {
    const cwd = (cwdInput?.value || '').trim();
    if (cwd) loadFileTree(cwd);
  });
  document.getElementById('file-tree-filter')?.addEventListener('input', applyFileTreeFilter);

  // 添加 agent 按钮
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (popover && isDisplay(popover, 'block')) {
        hideAgentAddPopover();
      } else {
        renderAgentAddPopover();
      }
    });
  }

  // 弹窗内点击 agent → 拉入
  if (popover) {
    popover.addEventListener('click', (e) => {
      const item = e.target.closest('.agent-add-popover-item');
      if (!item || !item.dataset.agent) return;
      e.stopPropagation();
      addSessionAgent(item.dataset.agent);
    });
  }

  // 点击面板外侧关闭（仅移动端浮层）
  document.addEventListener('click', (e) => {
    if (!isMobile() || !panelOpen()) return;
    if (!sidebar.contains(e.target) && e.target !== toggleBtn && !toggleBtn?.contains(e.target)) {
      closePanel();
    }
  });

  // 点击面板外关闭 agent 弹窗
  document.addEventListener('click', (e) => {
    const pv = document.getElementById('agent-add-popover');
    if (!isDisplay(pv, 'block')) return;
    if (!pv.contains(e.target) && e.target.id !== 'btn-session-agent-add') {
      hideAgentAddPopover();
    }
  });

  // Escape 关闭移动端浮层；桌面端保持常驻 Pane
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMobile() && panelOpen()) {
      closePanel();
    }
  });

  syncDesktopState();
  ensurePaneContent(false);
  const desktopQuery = window.matchMedia('(max-width: 760px)');
  const handleRightPaneQueryChange = () => syncDesktopState();
  if (desktopQuery.addEventListener) {
    desktopQuery.addEventListener('change', handleRightPaneQueryChange);
  } else {
    desktopQuery.addListener(handleRightPaneQueryChange);
  }
  initResize();

  loadSessionAgents();
}

function getWorkspaceSubtitle(tab) {
  if (tab === 'files') {
    return (fileTreePath || cwdInput?.value || '').replace(/\\/g, '/') || '-';
  }
  if (tab === 'review') {
    const branch = document.querySelector('#review-panel .review-branch-name')?.textContent?.trim();
    const count = document.querySelector('#review-panel .review-branch-count')?.textContent?.trim();
    return [branch, count].filter(Boolean).join(' · ') || ((cwdInput?.value || '').trim() ? t('reviewLoading') : '-');
  }
  if (tab === 'members') {
    const sessionAgents = getSessionAgents();
    return sessionAgents.length ? t('itemCount', { count: sessionAgents.length }) : t('workspaceMembersHint');
  }
  return '';
}

function updateWorkspaceHeader(tab = document.querySelector('.chat-sidebar-tab.active')?.dataset.tab || 'files') {
  const titleEl = document.getElementById('chat-sidebar-title');
  const subtitleEl = document.getElementById('chat-sidebar-subtitle');
  const titleKey = tab === 'review' ? 'reviewTab' : tab === 'members' ? 'sessionMembers' : 'filesTab';
  if (titleEl) titleEl.textContent = t(titleKey);
  if (subtitleEl) {
    const subtitle = getWorkspaceSubtitle(tab);
    subtitleEl.textContent = subtitle || '-';
    subtitleEl.title = subtitle || '';
  }
}

function switchToSidebarTab(tab) {
  document.querySelectorAll('.chat-sidebar-tab').forEach(t => {
    const active = t.dataset.tab === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  setVisible(document.getElementById('file-tree-panel'), tab === 'files');
  setVisible(document.getElementById('review-panel'), tab === 'review');
  setVisible(document.getElementById('group-member-panel'), tab === 'members');
  updateWorkspaceHeader(tab);
}

let fileTreePath = '';

async function loadReview(cwd) {
  _reviewCwd = cwd || '';
  const panel = document.getElementById('review-panel');
  if (!panel) return;
  panel.innerHTML = `<div class="review-loading">${esc(t('reviewLoading'))}</div>`;
  updateWorkspaceHeader('review');
  try {
    const resp = await fetch(`/api/review?cwd=${encodeURIComponent(cwd)}`);
    const data = await resp.json();
    if (data.error) {
      panel.innerHTML = `<div class="review-empty">${esc(formatMessage(data))}</div>`;
      updateWorkspaceHeader('review');
      return;
    }
    if (!data.git) {
      panel.innerHTML = `<div class="review-empty">${esc(formatMessage(data, 'reviewNoGit'))}</div>`;
      updateWorkspaceHeader('review');
      return;
    }
    const files = data.files || [];
    let html = '';
    // 分支名
    html += `<div class="review-branch"><span data-i18n="reviewBranch">${esc(t('reviewBranch'))}</span><span class="review-branch-name">${esc(data.branch)}</span><span class="review-branch-count">${esc(t('itemCount', { count: files.length }))}</span></div>`;
      const statusLabel = {
        modified: t('statusModified'), added: t('statusAdded'), deleted: t('statusDeleted'),
        renamed: t('statusRenamed'), untracked: t('statusUntracked'), changed: t('statusChanged')
      };
      const renderReviewFileList = (items, staged) => {
        if (!items.length) return `<div class="review-empty compact">${esc(t('reviewNoChanges'))}</div>`;
        return `<div class="review-file-list">${items.map(f => {
          const flag = staged ? '1' : '0';
          return `<div class="review-file-item" data-file="${esc(f.file)}" data-staged="${flag}" title="${esc(t('reviewClickToDiff'))}"><span class="rf-name">${esc(f.file)}</span><span class="rf-badge ${esc(f.status)}">${esc(statusLabel[f.status] || f.status)}</span></div>`;
        }).join('')}</div>`;
      };
      const stagedFiles = data.stagedFiles || [];
      const unstagedFiles = data.unstagedFiles || [];
      const hasSplitFiles = stagedFiles.length || unstagedFiles.length;
      if (hasSplitFiles) {
        html += `<div class="review-change-group staged"><div class="review-section-title" data-i18n="reviewStaged">${esc(t('reviewStaged'))}</div>${renderReviewFileList(stagedFiles, true)}</div>`;
        html += `<div class="review-change-group unstaged"><div class="review-section-title" data-i18n="reviewUnstaged">${esc(t('reviewUnstaged'))}</div>${renderReviewFileList(unstagedFiles, false)}</div>`;
      } else if (files.length === 0) {
        html += `<div class="review-empty">${esc(t('reviewNoChanges'))}</div>`;
      } else {
        html += `<div class="review-section-title" data-i18n="filesTab">${esc(t('filesTab'))}</div>`;
        html += renderReviewFileList(files, false);
      }
    // 变更统计
    if (data.stagedStat) {
      html += `<div class="review-section-title" data-i18n="reviewStaged">${esc(t('reviewStaged'))}</div>`;
      html += `<div class="review-stat-block">${esc(data.stagedStat)}</div>`;
    }
    if (data.unstagedStat) {
      html += `<div class="review-section-title" data-i18n="reviewUnstaged">${esc(t('reviewUnstaged'))}</div>`;
      html += `<div class="review-stat-block">${esc(data.unstagedStat)}</div>`;
    }
    if (!data.stagedStat && !data.unstagedStat && files.length > 0) {
      html += `<div class="review-stat-block" style="color:var(--text-ghost)">${esc(data.stat || '')}</div>`;
    }
    panel.innerHTML = html;
    updateWorkspaceHeader('review');
  } catch (e) {
    panel.innerHTML = `<div class="review-empty">${esc(t('unknownError'))}</div>`;
    updateWorkspaceHeader('review');
  }
}

let _reviewCwd = '';

async function loadReviewDiff(file, staged) {
  if (!diffPreviewPanel || !_reviewCwd) return;
  // 打开面板
  diffPreviewPanel.style.display = 'flex';
  const wasHidden = !diffPreviewPanel._wasOpen;
  if (wasHidden) {
    diffPreviewPanel.style.left = '';
    diffPreviewPanel.style.right = '';
    diffPreviewPanel.style.top = '';
    diffPreviewPanel.style.bottom = '';
    diffPreviewPanel.style.width = '';
    diffPreviewPanel.style.height = '';
    diffPreviewPanel.style.transform = '';
    requestAnimationFrame(() => positionDiffPreviewAtCenter());
  }
  diffPreviewPanel._wasOpen = true;
  diffPreviewNameEl.textContent = file.split('/').pop() || file;
  diffPreviewMetaEl.innerHTML = `<span>${esc(file)}</span><span class="diff-staged-tag">${staged ? esc(t('reviewStaged')) : esc(t('reviewUnstaged'))}</span>`;
  diffPreviewContentEl.innerHTML = `<div class="file-preview-state">${esc(t('reviewLoading'))}</div>`;

  try {
    const resp = await fetch(`/api/review-diff?cwd=${encodeURIComponent(_reviewCwd)}&file=${encodeURIComponent(file)}&staged=${staged ? '1' : '0'}`);
    const data = await resp.json();
    if (data.error) {
      diffPreviewContentEl.innerHTML = `<div class="file-preview-state">${esc(formatMessage(data))}</div>`;
      return;
    }
    renderDiffContent(data);
  } catch (e) {
    diffPreviewContentEl.innerHTML = `<div class="file-preview-state">${esc(t('unknownError'))}</div>`;
  }
}

function renderDiffContent(data) {
  const diffText = data.diff || '';
  if (!diffText) {
    diffPreviewContentEl.innerHTML = `<div class="file-preview-state">${esc(t('reviewNoChanges'))}</div>`;
    return;
  }

  // 解析 unified diff 并渲染为表格
  const lines = diffText.split('\n');
  let html = '<table class="review-diff-table">';
  let oldLine = 0, newLine = 0;
  let inHunk = false;

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.startsWith('@@')) {
      inHunk = true;
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        oldLine = parseInt(m[1]) || 0;
        newLine = parseInt(m[3]) || 0;
      }
      html += `<tr class="diff-hunk-header"><td colspan="3">${esc(line)}</td></tr>`;
    } else if (line.startsWith('+') && inHunk) {
      html += `<tr class="diff-add"><td class="diff-ln diff-ln-old"></td><td class="diff-ln diff-ln-new">${newLine}</td><td class="diff-code"><span>${esc(line)}</span></td></tr>`;
      newLine++;
    } else if (line.startsWith('-') && inHunk) {
      html += `<tr class="diff-del"><td class="diff-ln diff-ln-old">${oldLine}</td><td class="diff-ln diff-ln-new"></td><td class="diff-code"><span>${esc(line)}</span></td></tr>`;
      oldLine++;
    } else if (line.startsWith(' ') && inHunk) {
      html += `<tr class="diff-context"><td class="diff-ln diff-ln-old">${oldLine}</td><td class="diff-ln diff-ln-new">${newLine}</td><td class="diff-code"><span>${esc(line)}</span></td></tr>`;
      oldLine++;
      newLine++;
    }
  }

  html += '</table>';
  diffPreviewContentEl.innerHTML = html;
}

function updateFileTreePathLabel(path = fileTreePath || cwdInput?.value || '') {
  const label = document.getElementById('file-tree-path');
  if (!label) return;
  const normalized = String(path || '').replace(/\\/g, '/');
  label.textContent = normalized || '-';
  label.title = normalized;
  updateWorkspaceHeader('files');
}

function applyFileTreeFilter() {
  const input = document.getElementById('file-tree-filter');
  const q = (input?.value || '').trim().toLowerCase();
  document.querySelectorAll('#file-tree-content .file-tree-entry').forEach(el => {
    const name = el.textContent.replace(/^📁|^📄/, '').trim().toLowerCase();
    el.style.display = !q || name.includes(q) ? '' : 'none';
  });
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function initFilePreviewPanel() {
  previewCloseBtn?.addEventListener('click', closeFilePreview);
  previewSearchEl?.addEventListener('input', () => renderFilePreviewContent());
  previewQuoteSelectionBtn?.addEventListener('mousedown', (e) => e.preventDefault());
  previewQuoteSelectionBtn?.addEventListener('click', quoteSelectedPreviewText);
  previewPanel?.querySelector('.file-preview-header')?.addEventListener('mousedown', startFilePreviewDrag);
  previewPanel?.querySelector('.file-preview-resizer')?.addEventListener('mousedown', startFilePreviewResize);
  document.addEventListener('mousemove', handleFilePreviewPointerMove);
  document.addEventListener('mouseup', stopFilePreviewPointerAction);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (diffPreviewPanel?.style.display !== 'none') closeDiffPreview();
      else if (previewPanel?.style.display !== 'none') closeFilePreview();
    }
  });
}

function initDiffPreviewPanel() {
  diffPreviewCloseBtn?.addEventListener('click', closeDiffPreview);
  diffPreviewPanel?.querySelector('.diff-preview-header')?.addEventListener('mousedown', startDiffPreviewDrag);
  diffPreviewPanel?.querySelector('.diff-preview-resizer')?.addEventListener('mousedown', startDiffPreviewResize);
  document.addEventListener('mousemove', handleDiffPreviewPointerMove);
  document.addEventListener('mouseup', stopDiffPreviewPointerAction);
}

function positionFilePreviewAtMessagesCenter() {
  const messagesEl = document.getElementById('messages');
  if (!previewPanel || !messagesEl) return;
  const parent = previewPanel.offsetParent || previewPanel.parentElement;
  if (!parent) return;
  const rect = previewPanel.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const messagesRect = messagesEl.getBoundingClientRect();
  const minLeft = 8;
  const minTop = 8;
  const maxLeft = Math.max(minLeft, parentRect.width - rect.width - 8);
  const maxTop = Math.max(minTop, parentRect.height - rect.height - 8);
  const nextLeft = Math.min(maxLeft, Math.max(minLeft, messagesRect.left - parentRect.left + (messagesRect.width - rect.width) / 2));
  const nextTop = Math.min(maxTop, Math.max(minTop, messagesRect.top - parentRect.top + (messagesRect.height - rect.height) / 2));
  previewPanel.style.left = `${nextLeft}px`;
  previewPanel.style.top = `${nextTop}px`;
  previewPanel.style.right = 'auto';
  previewPanel.style.bottom = 'auto';
  previewPanel.style.transform = 'none';
}

function ensureFilePreviewBox() {
  if (!previewPanel) return null;
  const parent = previewPanel.offsetParent || previewPanel.parentElement;
  if (!parent) return null;
  const rect = previewPanel.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  previewPanel.style.width = `${rect.width}px`;
  previewPanel.style.height = `${rect.height}px`;
  previewPanel.style.right = 'auto';
  previewPanel.style.bottom = 'auto';
  previewPanel.style.left = `${rect.left - parentRect.left}px`;
  previewPanel.style.top = `${rect.top - parentRect.top}px`;
  return { rect, parentRect };
}

function startFilePreviewDrag(e) {
  if (!previewPanel || e.button !== 0 || e.target.closest('button, input')) return;
  const box = ensureFilePreviewBox();
  if (!box) return;
  const { rect, parentRect } = box;
  previewDragState = {
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    parentLeft: parentRect.left,
    parentTop: parentRect.top,
    parentWidth: parentRect.width,
    parentHeight: parentRect.height,
    width: rect.width,
    height: rect.height,
  };
  previewPanel.classList.add('dragging');
  e.preventDefault();
}

function dragFilePreviewPanel(e) {
  if (!previewPanel || !previewDragState) return;
  const s = previewDragState;
  const maxLeft = Math.max(0, s.parentWidth - s.width - 8);
  const maxTop = Math.max(0, s.parentHeight - s.height - 8);
  const nextLeft = Math.min(maxLeft, Math.max(8, e.clientX - s.parentLeft - s.offsetX));
  const nextTop = Math.min(maxTop, Math.max(8, e.clientY - s.parentTop - s.offsetY));
  previewPanel.style.left = `${nextLeft}px`;
  previewPanel.style.top = `${nextTop}px`;
}

function startFilePreviewResize(e) {
  if (!previewPanel || e.button !== 0) return;
  const box = ensureFilePreviewBox();
  if (!box) return;
  const { rect, parentRect } = box;
  previewResizeState = {
    startX: e.clientX,
    startY: e.clientY,
    left: rect.left - parentRect.left,
    top: rect.top - parentRect.top,
    width: rect.width,
    height: rect.height,
    parentWidth: parentRect.width,
    parentHeight: parentRect.height,
  };
  previewPanel.classList.add('resizing');
  e.preventDefault();
  e.stopPropagation();
}

function resizeFilePreviewPanel(e) {
  if (!previewPanel || !previewResizeState) return;
  const s = previewResizeState;
  const minWidth = Math.min(420, Math.max(280, s.parentWidth - 16));
  const minHeight = Math.min(220, Math.max(180, s.parentHeight - 16));
  const maxWidth = Math.max(minWidth, s.parentWidth - s.left - 8);
  const maxHeight = Math.max(minHeight, s.parentHeight - s.top - 8);
  const nextWidth = Math.min(maxWidth, Math.max(minWidth, s.width + e.clientX - s.startX));
  const nextHeight = Math.min(maxHeight, Math.max(minHeight, s.height + e.clientY - s.startY));
  previewPanel.style.width = `${nextWidth}px`;
  previewPanel.style.height = `${nextHeight}px`;
}

function handleFilePreviewPointerMove(e) {
  if (previewResizeState) resizeFilePreviewPanel(e);
  else if (previewDragState) dragFilePreviewPanel(e);
}

function stopFilePreviewPointerAction() {
  if (!previewPanel) return;
  if (previewDragState) {
    previewDragState = null;
    previewPanel.classList.remove('dragging');
  }
  if (previewResizeState) {
    previewResizeState = null;
    previewPanel.classList.remove('resizing');
  }
}

function stopFilePreviewDrag() {
  stopFilePreviewPointerAction();
}

// ─── Diff preview 浮动面板 ─────────────────────────────────

function positionDiffPreviewAtCenter() {
  const messagesEl = document.getElementById('messages');
  if (!diffPreviewPanel || !messagesEl) return;
  const parent = diffPreviewPanel.offsetParent || diffPreviewPanel.parentElement;
  if (!parent) return;
  const rect = diffPreviewPanel.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const messagesRect = messagesEl.getBoundingClientRect();
  const minLeft = 8;
  const minTop = 8;
  const maxLeft = Math.max(minLeft, parentRect.width - rect.width - 8);
  const maxTop = Math.max(minTop, parentRect.height - rect.height - 8);
  const nextLeft = Math.min(maxLeft, Math.max(minLeft, messagesRect.left - parentRect.left + (messagesRect.width - rect.width) / 2));
  const nextTop = Math.min(maxTop, Math.max(minTop, messagesRect.top - parentRect.top + (messagesRect.height - rect.height) / 2));
  diffPreviewPanel.style.left = `${nextLeft}px`;
  diffPreviewPanel.style.top = `${nextTop}px`;
  diffPreviewPanel.style.right = 'auto';
  diffPreviewPanel.style.bottom = 'auto';
  diffPreviewPanel.style.transform = 'none';
}

function ensureDiffPreviewBox() {
  if (!diffPreviewPanel) return null;
  const parent = diffPreviewPanel.offsetParent || diffPreviewPanel.parentElement;
  if (!parent) return null;
  const rect = diffPreviewPanel.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  diffPreviewPanel.style.width = `${rect.width}px`;
  diffPreviewPanel.style.height = `${rect.height}px`;
  diffPreviewPanel.style.right = 'auto';
  diffPreviewPanel.style.bottom = 'auto';
  diffPreviewPanel.style.left = `${rect.left - parentRect.left}px`;
  diffPreviewPanel.style.top = `${rect.top - parentRect.top}px`;
  return { rect, parentRect };
}

function startDiffPreviewDrag(e) {
  if (!diffPreviewPanel || e.button !== 0 || e.target.closest('button, input')) return;
  const box = ensureDiffPreviewBox();
  if (!box) return;
  const { rect, parentRect } = box;
  diffPreviewDragState = {
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    parentLeft: parentRect.left,
    parentTop: parentRect.top,
    parentWidth: parentRect.width,
    parentHeight: parentRect.height,
    width: rect.width,
    height: rect.height,
  };
  diffPreviewPanel.classList.add('dragging');
  e.preventDefault();
}

function dragDiffPreviewPanel(e) {
  if (!diffPreviewPanel || !diffPreviewDragState) return;
  const s = diffPreviewDragState;
  const maxLeft = Math.max(0, s.parentWidth - s.width - 8);
  const maxTop = Math.max(0, s.parentHeight - s.height - 8);
  const nextLeft = Math.min(maxLeft, Math.max(8, e.clientX - s.parentLeft - s.offsetX));
  const nextTop = Math.min(maxTop, Math.max(8, e.clientY - s.parentTop - s.offsetY));
  diffPreviewPanel.style.left = `${nextLeft}px`;
  diffPreviewPanel.style.top = `${nextTop}px`;
}

function startDiffPreviewResize(e) {
  if (!diffPreviewPanel || e.button !== 0) return;
  const box = ensureDiffPreviewBox();
  if (!box) return;
  const { rect, parentRect } = box;
  diffPreviewResizeState = {
    startX: e.clientX,
    startY: e.clientY,
    left: rect.left - parentRect.left,
    top: rect.top - parentRect.top,
    width: rect.width,
    height: rect.height,
    parentWidth: parentRect.width,
    parentHeight: parentRect.height,
  };
  diffPreviewPanel.classList.add('resizing');
  e.preventDefault();
  e.stopPropagation();
}

function resizeDiffPreviewPanel(e) {
  if (!diffPreviewPanel || !diffPreviewResizeState) return;
  const s = diffPreviewResizeState;
  const minWidth = Math.min(420, Math.max(280, s.parentWidth - 16));
  const minHeight = Math.min(220, Math.max(180, s.parentHeight - 16));
  const maxWidth = Math.max(minWidth, s.parentWidth - s.left - 8);
  const maxHeight = Math.max(minHeight, s.parentHeight - s.top - 8);
  const nextWidth = Math.min(maxWidth, Math.max(minWidth, s.width + e.clientX - s.startX));
  const nextHeight = Math.min(maxHeight, Math.max(minHeight, s.height + e.clientY - s.startY));
  diffPreviewPanel.style.width = `${nextWidth}px`;
  diffPreviewPanel.style.height = `${nextHeight}px`;
}

function handleDiffPreviewPointerMove(e) {
  if (diffPreviewResizeState) resizeDiffPreviewPanel(e);
  else if (diffPreviewDragState) dragDiffPreviewPanel(e);
}

function stopDiffPreviewPointerAction() {
  if (!diffPreviewPanel) return;
  if (diffPreviewDragState) {
    diffPreviewDragState = null;
    diffPreviewPanel.classList.remove('dragging');
  }
  if (diffPreviewResizeState) {
    diffPreviewResizeState = null;
    diffPreviewPanel.classList.remove('resizing');
  }
}

function closeDiffPreview() {
  if (!diffPreviewPanel) return;
  diffPreviewPanel.style.display = 'none';
  diffPreviewPanel._wasOpen = false;
  diffPreviewDragState = null;
  diffPreviewResizeState = null;
  diffPreviewPanel.classList.remove('dragging', 'resizing');
  if (diffPreviewContentEl) diffPreviewContentEl.innerHTML = '';
}

function closeFilePreview() {
  if (!previewPanel) return;
  previewPanel.style.display = 'none';
  currentPreviewFile = null;
  previewSelectedLines.clear();
  lastPreviewSelectedLine = 0;
  previewDragState = null;
  previewResizeState = null;
  previewPanel.classList.remove('dragging', 'resizing');
  if (previewContentEl) previewContentEl.innerHTML = '';
  if (previewSearchEl) previewSearchEl.value = '';
}

async function openFilePreview(filePath) {
  if (!previewPanel || !previewContentEl) return;
  const wasHidden = previewPanel.style.display === 'none' || !previewPanel.style.display;
  previewPanel.style.display = 'flex';
  if (wasHidden) {
    previewPanel.style.left = '';
    previewPanel.style.right = '';
    previewPanel.style.top = '';
    previewPanel.style.bottom = '';
    previewPanel.style.width = '';
    previewPanel.style.height = '';
    previewPanel.style.transform = '';
    requestAnimationFrame(positionFilePreviewAtMessagesCenter);
  }
  previewSelectedLines.clear();
  lastPreviewSelectedLine = 0;
  currentPreviewFile = { path: filePath, content: '' };
  if (previewNameEl) previewNameEl.textContent = filePath.split('/').pop() || filePath;
  if (previewMetaEl) previewMetaEl.textContent = shortenPlainPath(filePath);
  previewContentEl.innerHTML = `<div class="file-preview-state">${esc(t('loading'))}</div>`;
  if (previewSearchEl) previewSearchEl.value = '';
  try {
    const cwd = cwdInput?.value || '';
    const resp = await fetch(`/api/file-preview?path=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}`);
    const data = await resp.json();
    if (!data.ok) {
      const message = formatMessage(data, 'filePreviewUnsupported');
      previewContentEl.innerHTML = `<div class="file-preview-state">${esc(message)}</div>`;
      if (previewMetaEl) previewMetaEl.textContent = message;
      return;
    }
    currentPreviewFile = data;
    if (previewNameEl) previewNameEl.textContent = data.name || filePath.split('/').pop() || filePath;
    if (previewMetaEl) {
      const sizeKb = Math.max(1, Math.ceil((data.size || 0) / 1024));
      previewMetaEl.textContent = `${shortenPlainPath(data.path || filePath)} · ${sizeKb} KB${data.truncated ? ' · truncated' : ''}`;
    }
    renderFilePreviewContent();
  } catch (e) {
    previewContentEl.innerHTML = `<div class="file-preview-state">${esc(t('filePreviewLoadFailed', { message: e.message }))}</div>`;
  }
}

function updatePreviewLineSelection() {
  if (!previewContentEl) return;
  previewContentEl.querySelectorAll('.file-preview-line').forEach(row => {
    const lineNo = Number(row.dataset.line || 0);
    row.classList.toggle('selected', previewSelectedLines.has(lineNo));
  });
}

function selectPreviewLine(lineNo, extend = false) {
  if (!lineNo) return;
  if (extend && lastPreviewSelectedLine) {
    const start = Math.min(lastPreviewSelectedLine, lineNo);
    const end = Math.max(lastPreviewSelectedLine, lineNo);
    previewSelectedLines.clear();
    for (let n = start; n <= end; n++) previewSelectedLines.add(n);
  } else if (previewSelectedLines.has(lineNo)) {
    previewSelectedLines.delete(lineNo);
    lastPreviewSelectedLine = lineNo;
  } else {
    previewSelectedLines.add(lineNo);
    lastPreviewSelectedLine = lineNo;
  }
  updatePreviewLineSelection();
}

function getSelectedPreviewText() {
  if (!currentPreviewFile || !previewSelectedLines.size) return '';
  const lines = String(currentPreviewFile.content || '').split(/\r?\n/);
  return Array.from(previewSelectedLines).sort((a,b) => a-b).map(lineNo => {
    const text = lines[lineNo - 1] || '';
    return `${lineNo}: ${text}`;
  }).join('\n');
}

function getSortedPreviewSelectedLines() {
  return Array.from(previewSelectedLines).sort((a,b) => a-b);
}

function renderFilePreviewContent() {
  if (!previewContentEl || !currentPreviewFile) return;
  const content = currentPreviewFile.content || '';
  const query = (previewSearchEl?.value || '').trim();
  const matcher = query ? new RegExp(`(${escapeRegExp(query)})`, 'ig') : null;
  const lines = content.split(/\r?\n/);
  previewContentEl.innerHTML = lines.map((line, idx) => {
    const lineNo = idx + 1;
    const text = matcher ? esc(line).replace(matcher, '<mark>$1</mark>') : esc(line);
    return `<div class="file-preview-line${previewSelectedLines.has(lineNo) ? ' selected' : ''}" data-line="${lineNo}"><button class="file-preview-line-no" type="button" title="${esc(t('quoteLine'))}">${lineNo}</button><code>${text || ' '}</code></div>`;
  }).join('') || `<div class="file-preview-state">${esc(t('historyEmpty'))}</div>`;
  previewContentEl.querySelectorAll('.file-preview-line').forEach(row => {
    row.addEventListener('click', (e) => {
      selectPreviewLine(Number(row.dataset.line || 0), e.shiftKey);
    });
  });
  previewContentEl.querySelectorAll('.file-preview-line-no').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.file-preview-line');
      const lineNo = row?.dataset.line || '';
      const text = lines[Number(lineNo) - 1] || '';
      const path = currentPreviewFile.path || currentPreviewFile.name || '';
      quoteIntoInput(`${path}:${lineNo}\n${text}`);
    });
  });
}

function quoteSelectedPreviewText() {
  if (!previewPanel || previewPanel.style.display === 'none') return;
  const path = currentPreviewFile?.path || currentPreviewFile?.name || '';
  const selectedLinesText = getSelectedPreviewText();
  if (selectedLinesText) {
    quoteIntoInput(path ? `${path}\n${selectedLinesText}` : selectedLinesText, {
      type: 'file_lines',
      path,
      lines: getSortedPreviewSelectedLines(),
    });
    return;
  }
  const sel = window.getSelection();
  const text = String(sel?.toString() || '').trim();
  if (!text || !previewPanel.contains(sel.anchorNode)) return;
  quoteIntoInput(path ? `${path}\n${text}` : text);
}

async function loadFileTree(path) {
  const content = document.getElementById('file-tree-content');
  if (!content) return;
  content.innerHTML = '<div class="file-tree-empty">Loading...</div>';
  updateFileTreePathLabel(path);
  try {
    const resp = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
    const data = await resp.json();
    fileTreePath = path;
    updateFileTreePathLabel(path);
    if (data.items) {
      let html = '';
      if (data.parent) {
        html += `<div class="file-tree-entry dir" data-path="${esc(data.parent)}"><span class="ft-icon">📁</span>..</div>`;
      }
      const dirs = (data.items || []).filter(c => c.type === 'dir').sort((a,b) => a.name.localeCompare(b.name));
      const files = (data.items || []).filter(c => c.type !== 'dir').sort((a,b) => a.name.localeCompare(b.name));
      for (const d of dirs) {
        const fullPath = path.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + d.name;
        html += `<div class="file-tree-entry dir" data-path="${esc(fullPath)}"><span class="ft-icon">📁</span>${esc(d.name)}</div>`;
      }
      for (const f of files) {
        const fPath = path.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + f.name;
        html += `<div class="file-tree-entry" data-path="${esc(fPath)}"><span class="ft-icon">📄</span>${esc(f.name)}</div>`;
      }
      content.innerHTML = html || '<div class="file-tree-empty">' + esc(t('emptyDir')) + '</div>';
      applyFileTreeFilter();
      content.querySelectorAll('.file-tree-entry.dir').forEach(el => {
        el.addEventListener('click', (e) => { e.stopPropagation(); loadFileTree(el.dataset.path); });
      });
      content.querySelectorAll('.file-tree-entry:not(.dir)').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          openFilePreview(el.dataset.path);
        });
      });
    } else {
      content.innerHTML = '<div class="file-tree-empty">' + esc(t('emptyDir')) + '</div>';
    }
  } catch (e) {
    content.innerHTML = '<div class="file-tree-empty">' + esc(t('unknownError')) + '</div>';
  }
}


  root.rightPanel = {
    initRightPanel,
    initFilePreviewPanel,
    initDiffPreviewPanel,
    refreshRightPaneFiles,
    loadFileTree,
    loadReview,
    loadReviewDiff,
    openFilePreview,
    closeFilePreview,
    closeDiffPreview,
    switchToSidebarTab,
    updateWorkspaceHeader,
  };
})();
