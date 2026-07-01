/**
 * CC Bridge - 前端主逻辑
 * 使用 SSE (Server-Sent Events) + fetch POST 替代 WebSocket
 */

// ─── 状态 ────────────────────────────────────────────────────
let clientId = null;
let eventSource = null;
let sessionActive = false;
let isResponding = false;
let isViewer = false;  // 当前是否以观察者身份查看他人的活跃会话
let currentAssistantEl = null;
let currentAssistantMessageId = null;
let currentContent = [];
let streamBlocks = {};
let totalCost = 0;
let totalTokens = emptyTokenUsage();
let currentSessionId = null; // ccb 的 session UUID
let currentRunId = null; // 当前打开会话正在生成的 run id
let connectionOnline = false;
let currentTurnContent = '';
let currentTurnHasAssistantOutput = false;
let currentTurnStartedAt = 0;
let currentTurnTimer = null;
let currentTurnAttachmentCount = 0;
let completionHistorySyncTimer = null;
let lastFocusConfigReloadAt = 0;
let cachedSessions = [];
let sessionsLoaded = false;
let chatNavAutoOpening = false;
let sessionOffset = 0;
let sessionTotal = 0;
const SESSION_PAGE_SIZE = 50;
let scheduledTasks = [];
let skillsCache = [];
let currentSkillDir = '';
let sidebarCollapsed = false;
const WORKSPACE_STORAGE_KEY = 'ccb_workspace_state_v1';
let workspaceMode = 'focus';
let activeWorkspaceSessionId = '';
const workspaceSessions = new Map();
let workspaceResizeState = null;
const workspacePaneWidths = new Map();

// ─── DOM ─────────────────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const workspaceEl = document.getElementById('session-workspace');
const workspaceTabsEl = document.getElementById('workspace-tabs');
const workspacePanesEl = document.getElementById('workspace-panes');
const workspaceLivePane = document.getElementById('workspace-live-pane');
const workspaceFocusBtn = document.getElementById('workspace-focus-mode');
const workspaceGridBtn = document.getElementById('workspace-grid-mode');
const inputEl = document.getElementById('message-input');
const btnSend = document.getElementById('btn-send');
const btnStop = document.getElementById('btn-stop');
const btnNewSession = document.getElementById('btn-new-session');
const modelSelect = document.getElementById('model-select');
let savedModelPref = '';  // gui_settings 里上次使用的模型，刷新后用于恢复选择
let autoUpdateEnabled = true;  // 是否启动时自动检查更新
let skipUpdateVersion = '';    // 被跳过的远端版本 SHA
let updateInfo = null;         // 最近一次 check-update 的结果
let quotedMessages = [];       // 输入框上方展示的引用卡片
let contextMenuCwd = '';       // 工作目录右键菜单暂存的 cwd
const cwdInput = document.getElementById('cwd-input');
const connectionStatus = document.getElementById('connection-status');
const costDisplay = document.getElementById('cost-display');
const costValue = document.getElementById('cost-value');
const tokenDisplay = document.getElementById('token-display');
const tokenValue = document.getElementById('token-value');
const sessionSearchInput = document.getElementById('session-search');
const sessionsCountEl = document.getElementById('sessions-count');
const sessionsNewSessionBtn = document.getElementById('sessions-new-session');
const btnThemeToggle = document.getElementById('btn-theme-toggle');
const btnShortcuts = document.getElementById('btn-shortcuts');
const shortcutsOverlay = document.getElementById('shortcuts-overlay');
const shortcutsClose = document.getElementById('shortcuts-close');
const btnExportChat = document.getElementById('btn-export-chat');
const btnSidebarCollapse = document.getElementById('btn-sidebar-collapse');
const topbarStatusSummary = document.getElementById('topbar-status-summary');
const topbarConnection = document.getElementById('topbar-connection');
const topbarCost = document.getElementById('topbar-cost');
const topbarCostValue = document.getElementById('topbar-cost-value');
const topbarTokens = document.getElementById('topbar-tokens');
const topbarTokenValue = document.getElementById('topbar-token-value');
const topbarSessionId = document.getElementById('topbar-session-id');
const topbarModel = document.getElementById('topbar-model');
const topbarCli = document.getElementById('topbar-cli');
const btnSessionPin = document.getElementById('btn-session-pin');
const btnSessionCwd = document.getElementById('btn-session-cwd');
const btnSessionRename = document.getElementById('btn-session-rename');
const btnSessionDelete = document.getElementById('btn-session-delete');
const themeToggleText = document.getElementById('theme-toggle-text');
const languageSelect = document.getElementById('language-select');
const fontSizeRange = document.getElementById('font-size-range');
const fontSizeValue = document.getElementById('font-size-value');
const notificationsToggle = document.getElementById('notifications-toggle');
const notificationsRow = document.getElementById('notifications-row');
const remoteTargetSelect = document.getElementById('remote-target-select');
const remoteAllowMutate = document.getElementById('remote-allow-mutate');
const remoteMutateRow = document.getElementById('remote-mutate-row');
const lanAccessToggle = document.getElementById('lan-access-toggle');
const lanAccessRow = document.getElementById('lan-access-row');
const mcpFormSection = document.getElementById('mcp-form-section');
const mcpFormType = document.getElementById('mcp-form-type');
const mcpStdioFields = document.getElementById('mcp-stdio-fields');
const mcpUrlFields = document.getElementById('mcp-url-fields');
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
let currentLanguage = 'en';
let i18nMap = {};
let fontSizePercent = 100;
let notificationsEnabled = false;
let lastNotifyAt = 0;
let accessContext = { isLocalhost: true, defaultCwd: '' };

// ─── 初始化 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initShortcutsHelp();
  initSidebarCollapse();
  initInterfaceSettings();
  initNotifications();
  initLanAccessControl();
  await loadThemePreference();
  initNavigation();
  initTopbarSessionActions();
  initMobileLayout();
  initSSE();
  initInput();
  initModelPill();
  initCliInstallModal();
  initUpdateModal();
  initMessageContextMenu();
  initCwdContextMenu();
  initMigrateSessionPopover();
  initRemote();
  initMcpManager();
  initAgentModal();
  initRightPanel();
  initFilePreviewPanel();
  initMentionAutocomplete();
  initMemoryUI();
  initArtifactsUI();
  initScheduledTasksUI();
  initSessionWorkspace();
  loadDefaultCwd();
  loadClis();
  loadModels();
  loadConfig();
  loadSessions();
  initFocusConfigReload();
  // 工具卡片折叠事件委托（支持 Shift+点击展开/折叠全部）
  function toggleCard(card, shiftKey) {
    if (shiftKey) {
      const allCards = document.querySelectorAll('.tool-card');
      const anyCollapsed = Array.from(allCards).some(c => c.classList.contains('collapsed'));
      allCards.forEach(c => c.classList.toggle('collapsed', !anyCollapsed));
    } else {
      card.classList.toggle('collapsed');
    }
  }
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('.tool-toggle');
    if (!toggle) return;
    e.preventDefault();
    const card = toggle.closest('.tool-card');
    if (!card) return;
    toggleCard(card, e.shiftKey);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const toggle = e.target.closest('.tool-toggle');
    if (!toggle) return;
    e.preventDefault();
    const card = toggle.closest('.tool-card');
    if (!card) return;
    toggleCard(card, e.shiftKey);
  });
  showPage('home');
  if (autoUpdateEnabled) setTimeout(() => checkForUpdate(), 3000);
});

function initSessionWorkspace() {
  if (!workspaceEl || !workspaceTabsEl || !workspacePanesEl || !workspaceLivePane) return;
  loadWorkspaceState();
  workspaceFocusBtn?.addEventListener('click', () => setWorkspaceMode('focus'));
  workspaceGridBtn?.addEventListener('click', () => setWorkspaceMode('grid'));
  workspaceLivePane.querySelector('.workspace-pane-head')?.addEventListener('click', () => {
    if (activeWorkspaceSessionId) activateWorkspaceSession(activeWorkspaceSessionId, { resume: false });
  });
  document.addEventListener('pointermove', handleWorkspaceResizeMove);
  document.addEventListener('pointerup', stopWorkspaceResize);
  renderWorkspace();
}

function sanitizeWorkspaceSnapshotHtml(html) {
  if (!html) return '';
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('.message.assistant.streaming').forEach(el => el.classList.remove('streaming'));
  return template.innerHTML;
}

function saveWorkspaceState() {
  const sessions = Array.from(workspaceSessions.values())
    .filter(s => s.sessionId && !s.sessionId.startsWith('pending-'))
    .map(s => ({
      sessionId: s.sessionId,
      title: s.title || '',
      cwd: s.cwd || '',
      model: s.model || '',
      cli: s.cli || '',
      remoteTargetId: s.remoteTargetId || '',
      cost: s.cost || 0,
      tokens: s.tokens || null,
      status: s.status === 'running' || s.status === 'tool' ? 'idle' : (s.status || 'idle'),
      phase: '',
      runId: '',
      snapshotHtml: sanitizeWorkspaceSnapshotHtml(s.snapshotHtml || ''),
    }));
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      mode: workspaceMode,
      activeSessionId: activeWorkspaceSessionId && !activeWorkspaceSessionId.startsWith('pending-') ? activeWorkspaceSessionId : '',
      sessions,
      widths: Array.from(workspacePaneWidths.entries()),
    }));
  } catch (e) { /* ignore */ }
}

function loadWorkspaceState() {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    workspaceMode = state.mode === 'grid' ? 'grid' : 'focus';
    workspaceSessions.clear();
    for (const s of (Array.isArray(state.sessions) ? state.sessions : [])) {
      if (s.sessionId) workspaceSessions.set(s.sessionId, workspaceSessionFromMeta(s.sessionId, s));
    }
    workspacePaneWidths.clear();
    for (const item of (Array.isArray(state.widths) ? state.widths : [])) {
      const [sessionId, width] = item;
      if (sessionId && Number.isFinite(width)) workspacePaneWidths.set(sessionId, width);
    }
    activeWorkspaceSessionId = workspaceSessions.has(state.activeSessionId) ? state.activeSessionId : (workspaceSessions.keys().next().value || '');
  } catch (e) { /* ignore */ }
}

function workspaceSessionFromMeta(sessionId, meta = {}) {
  const existing = workspaceSessions.get(sessionId) || {};
  return {
    sessionId,
    title: meta.title || existing.title || t('newChat'),
    cwd: meta.cwd || existing.cwd || '',
    model: meta.model || existing.model || '',
    cli: meta.cli || existing.cli || '',
    remoteTargetId: meta.remoteTargetId || existing.remoteTargetId || '',
    cost: Number.isFinite(meta.cost) ? meta.cost : (existing.cost || 0),
    tokens: meta.tokens || existing.tokens || null,
    status: meta.status || existing.status || 'idle',
    phase: meta.phase || existing.phase || '',
    startedAt: meta.startedAt || existing.startedAt || 0,
    updatedAt: Date.now(),
    runId: meta.runId || existing.runId || '',
    snapshotHtml: sanitizeWorkspaceSnapshotHtml(meta.snapshotHtml || existing.snapshotHtml || ''),
  };
}

function ensureWorkspaceSession(sessionId, meta = {}) {
  if (!sessionId) return null;
  const session = workspaceSessionFromMeta(sessionId, meta);
  workspaceSessions.set(sessionId, session);
  if (!activeWorkspaceSessionId) activeWorkspaceSessionId = sessionId;
  renderWorkspace();
  return session;
}

function captureActiveWorkspaceSnapshot() {
  if (!activeWorkspaceSessionId || !messagesEl) return;
  const session = workspaceSessions.get(activeWorkspaceSessionId);
  if (session) {
    session.snapshotHtml = sanitizeWorkspaceSnapshotHtml(messagesEl.innerHTML);
    saveWorkspaceState();
  }
}

function activateWorkspaceSession(sessionId, opts = {}) {
  if (!sessionId || sessionId === activeWorkspaceSessionId) {
    renderWorkspace();
    return;
  }
  captureActiveWorkspaceSnapshot();
  activeWorkspaceSessionId = sessionId;
  const session = workspaceSessions.get(sessionId);
  if (session) {
    if (session.snapshotHtml && messagesEl) messagesEl.innerHTML = session.snapshotHtml;
    if (opts.resume !== false) {
      resumeSession(session.sessionId, session.cwd, session.model, session.cost || 0, session.remoteTargetId || '', session.tokens || null, session.cli || '');
    }
  }
  renderWorkspace();
}

function setWorkspaceMode(mode) {
  workspaceMode = mode === 'grid' ? 'grid' : 'focus';
  renderWorkspace();
}

function getWorkspaceStatusLabel(status) {
  const key = {
    idle: 'workspaceIdle',
    running: 'workspaceRunning',
    tool: 'workspaceTool',
    done: 'workspaceDone',
    error: 'workspaceError',
  }[status || 'idle'] || 'workspaceIdle';
  return t(key);
}

function updateWorkspaceSessionStatus(sessionId, status, phase = '') {
  if (!sessionId) return;
  const session = ensureWorkspaceSession(sessionId, { status, phase });
  if (!session) return;
  session.status = status || session.status || 'idle';
  session.phase = phase || session.phase || '';
  session.updatedAt = Date.now();
  if (status === 'running' || status === 'tool') session.startedAt = session.startedAt || Date.now();
  if (status === 'done' || status === 'error' || status === 'idle') session.startedAt = 0;
  renderWorkspace();
}

function renderWorkspace() {
  if (!workspaceTabsEl || !workspacePanesEl || !workspaceLivePane) return;
  renderWorkspaceTabs();
  renderWorkspacePanes();
  workspacePanesEl.classList.toggle('workspace-grid', workspaceMode === 'grid');
  workspacePanesEl.classList.toggle('workspace-focus', workspaceMode !== 'grid');
  workspaceFocusBtn?.classList.toggle('active', workspaceMode !== 'grid');
  workspaceGridBtn?.classList.toggle('active', workspaceMode === 'grid');
  saveWorkspaceState();
}

function renderWorkspaceTabs() {
  const sessions = Array.from(workspaceSessions.values());
  const newButton = `
    <button class="workspace-new-session" type="button" title="${esc(t('newSession'))}" aria-label="${esc(t('newSession'))}">+</button>
  `;
  if (!sessions.length) {
    workspaceTabsEl.innerHTML = `<div class="workspace-tabs-empty">${esc(t('workspaceNoTabs'))}</div>${newButton}`;
    workspaceTabsEl.querySelector('.workspace-new-session')?.addEventListener('click', startNewSession);
    return;
  }
  workspaceTabsEl.innerHTML = sessions.map(s => `
    <button class="workspace-tab ${s.sessionId === activeWorkspaceSessionId ? 'active' : ''} status-${esc(s.status || 'idle')}" type="button" role="tab" data-session-id="${esc(s.sessionId)}">
      <span class="workspace-tab-title">${esc(s.title || t('newChat'))}</span>
      <span class="workspace-tab-meta">${esc(getWorkspaceStatusLabel(s.status))}${s.phase ? ` · ${esc(s.phase)}` : ''}</span>
    </button>
  `).join('') + newButton;
  workspaceTabsEl.querySelectorAll('.workspace-tab').forEach(tab => {
    tab.addEventListener('click', () => activateWorkspaceSession(tab.dataset.sessionId));
  });
  workspaceTabsEl.querySelector('.workspace-new-session')?.addEventListener('click', startNewSession);
}

function renderWorkspacePanes() {
  const activeSession = workspaceSessions.get(activeWorkspaceSessionId);
  workspaceLivePane.dataset.sessionId = activeWorkspaceSessionId || '';
  workspaceLivePane.classList.toggle('active', true);
  workspaceLivePane.className = `workspace-pane active status-${activeSession?.status || 'idle'}`;
  const titleEl = workspaceLivePane.querySelector('.workspace-pane-title');
  const statusEl = workspaceLivePane.querySelector('.workspace-pane-status');
  if (titleEl) {
    titleEl.innerHTML = `${activeSession?.title ? esc(activeSession.title) : esc(t('chat'))}<span class="workspace-input-target">${esc(t('workspaceInputTarget'))}</span>`;
  }
  if (statusEl) statusEl.textContent = getWorkspaceStatusLabel(activeSession?.status || (sessionActive ? 'idle' : 'idle'));
  applyWorkspacePaneWidth(workspaceLivePane, activeWorkspaceSessionId);

  ensureLivePaneResizer();
  if (workspaceMode !== 'grid') {
    workspacePanesEl.querySelectorAll('.workspace-snapshot-pane').forEach(el => el.remove());
    return;
  }

  const inactiveSessionIds = new Set(
    Array.from(workspaceSessions.values())
      .filter(session => session.sessionId !== activeWorkspaceSessionId)
      .map(session => session.sessionId)
  );
  workspacePanesEl.querySelectorAll('.workspace-snapshot-pane').forEach(el => {
    if (!inactiveSessionIds.has(el.dataset.sessionId)) el.remove();
  });

  for (const session of workspaceSessions.values()) {
    if (session.sessionId === activeWorkspaceSessionId) continue;
    let pane = Array.from(workspacePanesEl.querySelectorAll('.workspace-snapshot-pane'))
      .find(el => el.dataset.sessionId === session.sessionId);
    if (!pane) {
      pane = document.createElement('section');
      pane.className = 'workspace-pane workspace-snapshot-pane';
      pane.dataset.sessionId = session.sessionId;
      pane.innerHTML = `
        <div class="workspace-pane-head">
          <div class="workspace-pane-title"></div>
          <div class="workspace-pane-status"></div>
        </div>
        <div class="messages workspace-snapshot-messages"></div>
        <div class="workspace-pane-resizer" title="${esc(t('workspaceResize'))}"></div>
      `;
      pane.querySelector('.workspace-pane-head')?.addEventListener('click', () => activateWorkspaceSession(session.sessionId));
      pane.querySelector('.workspace-pane-resizer')?.addEventListener('pointerdown', (e) => startWorkspaceResize(e, session.sessionId, pane));
    }
    pane.className = `workspace-pane workspace-snapshot-pane status-${session.status || 'idle'}`;
    const paneTitle = pane.querySelector('.workspace-pane-title');
    const paneStatus = pane.querySelector('.workspace-pane-status');
    const paneMessages = pane.querySelector('.workspace-snapshot-messages');
    if (paneTitle) paneTitle.textContent = session.title || t('newChat');
    if (paneStatus) paneStatus.textContent = getWorkspaceStatusLabel(session.status);
    const snapshotHtml = session.snapshotHtml || `<div class="workspace-snapshot-empty">${esc(t('workspaceOpenSession'))}</div>`;
    if (paneMessages && paneMessages.dataset.snapshotHtml !== snapshotHtml) {
      paneMessages.innerHTML = snapshotHtml;
      paneMessages.dataset.snapshotHtml = snapshotHtml;
    }
    applyWorkspacePaneWidth(pane, session.sessionId);
    workspacePanesEl.appendChild(pane);
  }
  ensureLivePaneResizer();
}

function ensureLivePaneResizer() {
  let resizer = workspaceLivePane.querySelector('.workspace-pane-resizer');
  if (workspaceMode !== 'grid') {
    if (resizer) resizer.remove();
    return;
  }
  if (!resizer) {
    resizer = document.createElement('div');
    resizer.className = 'workspace-pane-resizer';
    workspaceLivePane.appendChild(resizer);
  }
  resizer.title = t('workspaceResize');
  resizer.onpointerdown = (e) => startWorkspaceResize(e, activeWorkspaceSessionId, workspaceLivePane);
}

function applyWorkspacePaneWidth(pane, sessionId) {
  if (!pane || workspaceMode !== 'grid') {
    if (pane) {
      pane.style.flex = '';
      pane.style.flexBasis = '';
    }
    return;
  }
  const savedWidth = workspacePaneWidths.get(sessionId);
  if (savedWidth) {
    pane.style.flex = `0 0 ${savedWidth}px`;
    pane.style.flexBasis = `${savedWidth}px`;
    return;
  }
  if (workspaceSessions.size === 2) {
    pane.style.flex = '1 1 0';
    pane.style.flexBasis = '0';
    return;
  }
  const width = 420;
  pane.style.flex = `0 0 ${width}px`;
  pane.style.flexBasis = `${width}px`;
}

function startWorkspaceResize(event, sessionId, pane) {
  if (!sessionId || !pane) return;
  event.preventDefault();
  workspaceResizeState = {
    sessionId,
    pane,
    startX: event.clientX,
    startWidth: pane.getBoundingClientRect().width,
  };
  document.body.classList.add('resizing-workspace-pane');
  pane.setPointerCapture?.(event.pointerId);
}

function handleWorkspaceResizeMove(event) {
  if (!workspaceResizeState) return;
  const nextWidth = Math.max(260, Math.min(900, workspaceResizeState.startWidth + event.clientX - workspaceResizeState.startX));
  workspacePaneWidths.set(workspaceResizeState.sessionId, nextWidth);
  applyWorkspacePaneWidth(workspaceResizeState.pane, workspaceResizeState.sessionId);
}

function stopWorkspaceResize() {
  if (!workspaceResizeState) return;
  workspaceResizeState = null;
  document.body.classList.remove('resizing-workspace-pane');
  saveWorkspaceState();
}


async function loadDefaultCwd() {
  try {
    const resp = await fetch('/api/default-cwd');
    const data = await resp.json();
    if (data.cwd && !cwdInput.value.trim()) {
      cwdInput.value = data.cwd;
      updateRuntimeSummary();
      loadSessions();
      refreshRightPaneFiles();
    }
  } catch (e) { /* ignore */ }
}

function initTheme() {
  updateThemeToggle();
  btnThemeToggle.addEventListener('click', () => {
    const nextTheme = document.documentElement.classList.contains('light-theme') ? 'dark' : 'light';
    applyTheme(nextTheme);
  });
}

function initShortcutsHelp() {
  btnShortcuts?.addEventListener('click', openShortcutsHelp);
  shortcutsClose?.addEventListener('click', closeShortcutsHelp);
  shortcutsOverlay?.addEventListener('click', (e) => {
    if (e.target === shortcutsOverlay) closeShortcutsHelp();
  });
}

function openShortcutsHelp() {
  if (shortcutsOverlay) shortcutsOverlay.style.display = 'flex';
}

function closeShortcutsHelp() {
  if (shortcutsOverlay) shortcutsOverlay.style.display = 'none';
}

function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = Boolean(collapsed && sessionActive);
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  if (btnSidebarCollapse) {
    btnSidebarCollapse.style.display = sessionActive ? '' : 'none';
    btnSidebarCollapse.textContent = sidebarCollapsed ? '>' : '<';
    btnSidebarCollapse.title = sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar');
    btnSidebarCollapse.setAttribute('aria-label', btnSidebarCollapse.title);
  }
  renderTopbarStatusSummary();
}

function initSidebarCollapse() {
  btnSidebarCollapse?.addEventListener('click', () => setSidebarCollapsed(!sidebarCollapsed));
}

function renderTopbarStatusSummary() {
  if (!topbarStatusSummary) return;
  topbarStatusSummary.style.display = sidebarCollapsed ? '' : 'none';
  if (!sidebarCollapsed) return;
  if (topbarConnection) topbarConnection.textContent = connectionOnline ? t('connected') : t('connecting');
  if (topbarCost && topbarCostValue) {
    topbarCost.style.display = '';
    topbarCostValue.textContent = costValue?.textContent || totalCost.toFixed(4);
  }
  if (topbarTokens && topbarTokenValue) {
    topbarTokens.style.display = '';
    topbarTokenValue.textContent = tokenValue?.textContent || formatTokenUsage(totalTokens);
  }
}

function initInterfaceSettings() {
  languageSelect?.addEventListener('change', () => {
    applyLanguage(languageSelect.value || 'en').then(() => {
      loadConfig();
      loadSessions();
      renderSessionList(cachedSessions);
    });
  });
  fontSizeRange?.addEventListener('input', () => {
    applyFontSize(Number(fontSizeRange.value || 100));
  });
}

function initNotifications() {
  if (!notificationsToggle) return;
  if (!("Notification" in window)) {
    notificationsEnabled = false;
    notificationsToggle.checked = false;
    notificationsToggle.disabled = true;
    if (notificationsRow) notificationsRow.title = t('notifyUnsupported');
    return;
  }

  notificationsToggle.addEventListener('change', () => {
    if (!notificationsToggle.checked) {
      notificationsEnabled = false;
      saveGuiSettings({ notifications_enabled: false });
      return;
    }
    // 同步分支：权限已确定，无需弹窗
    if (Notification.permission === 'granted') {
      notificationsEnabled = true;
      saveGuiSettings({ notifications_enabled: true });
      return;
    }
    if (Notification.permission === 'denied') {
      notificationsEnabled = false;
      notificationsToggle.checked = false;
      saveGuiSettings({ notifications_enabled: false });
      addSystemMsg(t('notifyPermissionDenied'), true);
      return;
    }
    // permission === 'default'：必须同步调用 requestPermission 以保留用户手势
    Notification.requestPermission().then(permission => {
      notificationsEnabled = permission === 'granted';
      notificationsToggle.checked = notificationsEnabled;
      saveGuiSettings({ notifications_enabled: notificationsEnabled });
      if (!notificationsEnabled) {
        addSystemMsg(t('notifyPermissionDenied'), true);
      }
    });
  });
}

function initLanAccessControl() {
  lanAccessToggle?.addEventListener('change', async () => {
    await saveGuiSettings({ lan_access_enabled: lanAccessToggle.checked });
    addSystemMsg(lanAccessToggle.checked ? t('lanAccessEnabled') : t('lanAccessDisabled'));
  });
}

function applyLanAccessPreference(settings) {
  if (!lanAccessRow || !lanAccessToggle) return;
  const isLocalhost = Boolean(settings.is_localhost);
  lanAccessRow.style.display = isLocalhost ? '' : 'none';
  lanAccessToggle.checked = settings.lan_access_enabled !== false;
}

function applyNotificationPreference(enabled, persist = false) {
  const supported = "Notification" in window;
  notificationsEnabled = Boolean(enabled && supported && Notification.permission === 'granted');
  if (notificationsToggle) {
    notificationsToggle.checked = notificationsEnabled;
    notificationsToggle.disabled = !supported;
  }
  if (persist) saveGuiSettings({ notifications_enabled: notificationsEnabled });
}

function pageIsUnfocused() {
  return document.visibilityState === 'hidden' || !document.hasFocus();
}

function notifyComplete(kind, detail = {}) {
  if (!notificationsEnabled || !("Notification" in window) || Notification.permission !== 'granted' || !pageIsUnfocused()) {
    return;
  }

  const now = Date.now();
  if (now - lastNotifyAt < 1500) return;
  lastNotifyAt = now;

  const project = getProjectName(cwdInput.value.trim()) || t('appSubtitleShort');
  const model = detail.model || getDisplayModelName(modelSelect.value) || '';
  const duration = formatDuration(detail.durationMs || 0);
  const cost = formatUsd(detail.costUsd || 0);
  const prompt = summarizePrompt(detail.prompt || currentTurnContent || '');
  const meta = [model, duration, cost].filter(Boolean).join(' · ');

  let title = t('notifyTurnTitle', { project, model: model || t('model') });
  let body = [
    prompt ? t('notifyPromptLine', { prompt }) : t('notifyTurnBody', { project }),
    meta,
  ].filter(Boolean).join('\n');

  if (kind === 'subagent') {
    const agent = detail.agent || t('subagent');
    const task = summarizePrompt(detail.task || '');
    title = t('notifySubagentTitle', { agent });
    body = [task ? t('notifyTaskLine', { task }) : t('notifySubagentBody', { agent, task: project }), meta].filter(Boolean).join('\n');
  } else if (kind === 'process') {
    body = [t('notifyFallbackBody', { project }), meta].filter(Boolean).join('\n');
  }

  try {
    const notification = new Notification(title, { body, tag: `cc-bridge-${kind}`, renotify: true });
    notification.onclick = () => {
      try { window.focus(); } catch (e) { /* ignore */ }
      notification.close();
    };
    setTimeout(() => notification.close(), 8000);
  } catch (e) { console.warn('Notification creation failed:', e); }
}

function summarizePrompt(text, maxLen = 90) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function formatDuration(ms) {
  const seconds = Math.round(Number(ms || 0) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return t('notifyDurationSeconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? t('notifyDurationMinutesSeconds', { minutes, seconds: rest }) : t('notifyDurationMinutes', { minutes });
}

function formatCompactDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function updateAssistantMeta(state = 'running', durationMs = Date.now() - currentTurnStartedAt) {
  if (!currentAssistantEl) return;
  const meta = currentAssistantEl.querySelector('.msg-meta');
  if (!meta) return;
  const elapsed = Number(durationMs || 0);
  const duration = state === 'running' ? formatCompactDuration(Math.max(1000, elapsed)) : formatCompactDuration(elapsed);
  meta.textContent = duration ? t(state === 'done' ? 'responseDuration' : 'responseRunning', { duration }) : '';
}

function startTurnTimer() {
  stopTurnTimer();
  updateAssistantMeta('running');
  currentTurnTimer = setInterval(() => updateAssistantMeta('running'), 1000);
}

function stopTurnTimer() {
  if (!currentTurnTimer) return;
  clearInterval(currentTurnTimer);
  currentTurnTimer = null;
}

function formatUsd(value) {
  const cost = Number(value || 0);
  if (!Number.isFinite(cost) || cost <= 0) return '';
  return t('notifyCost', { cost: cost.toFixed(4) });
}

function getProjectName(cwd, fallback = '') {
  if (!cwd) return fallback;
  const normalized = cwd.replace(/[\\\/]+$/, '');
  const parts = normalized.split(/[\\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || normalized || fallback;
}

// ─── 定时任务 ──────────────────────────────────────────────────
function initScheduledTasksUI() {
  document.getElementById('btn-scheduled-refresh')?.addEventListener('click', loadScheduledTasks);
  document.getElementById('btn-scheduled-save')?.addEventListener('click', saveScheduledTask);
  document.getElementById('btn-scheduled-reset')?.addEventListener('click', resetScheduledForm);
  document.getElementById('scheduled-type')?.addEventListener('change', updateScheduledScheduleFields);
  updateScheduledScheduleFields();
}

function populateScheduledSelects() {
  const model = document.getElementById('scheduled-model');
  if (model && modelSelect) {
    const prev = model.value || modelSelect.value;
    model.innerHTML = Array.from(modelSelect.options).map(opt => `<option value="${esc(opt.value)}">${esc(opt.textContent)}</option>`).join('');
    if (prev && Array.from(model.options).some(opt => opt.value === prev)) model.value = prev;
  }
  const cli = document.getElementById('scheduled-cli');
  const cliSource = document.getElementById('cli-select');
  if (cli && cliSource) {
    const prev = cli.value || cliSource.value;
    cli.innerHTML = Array.from(cliSource.options).map(opt => `<option value="${esc(opt.value)}">${esc(opt.textContent)}</option>`).join('');
    if (prev && Array.from(cli.options).some(opt => opt.value === prev)) cli.value = prev;
  }
  const remote = document.getElementById('scheduled-remote');
  if (remote) {
    const prev = remote.value;
    remote.innerHTML = `<option value="">${esc(t('remoteTargetNone'))}</option>` + remoteTargets.map(tg => `<option value="${esc(tg.id)}">${esc(tg.name || tg.host)}</option>`).join('');
    if (remoteTargets.some(tg => tg.id === prev)) remote.value = prev;
  }
}

function updateScheduledScheduleFields() {
  const type = document.getElementById('scheduled-type')?.value || 'interval';
  const interval = document.getElementById('scheduled-interval-field');
  const daily = document.getElementById('scheduled-daily-field');
  const once = document.getElementById('scheduled-once-field');
  if (interval) interval.style.display = type === 'interval' ? '' : 'none';
  if (daily) daily.style.display = type === 'daily' ? '' : 'none';
  if (once) once.style.display = type === 'once' ? '' : 'none';
}

async function loadScheduledTasks() {
  const list = document.getElementById('scheduled-task-list');
  if (!list) return;
  populateScheduledSelects();
  try {
    const resp = await fetch('/api/scheduled-tasks');
    const data = await resp.json();
    scheduledTasks = Array.isArray(data.tasks) ? data.tasks : [];
    renderScheduledTasks();
  } catch (e) {
    list.innerHTML = `<p class="empty-state">${esc(t('scheduledLoadFailed'))}</p>`;
  }
}

function renderScheduledTasks() {
  const list = document.getElementById('scheduled-task-list');
  if (!list) return;
  if (!scheduledTasks.length) {
    list.innerHTML = `<p class="empty-state">${esc(t('scheduledNoTasks'))}</p>`;
    return;
  }
  list.innerHTML = scheduledTasks.map(task => `
    <article class="scheduled-task-item ${task.enabled ? '' : 'disabled'}" data-id="${esc(task.id)}">
      <div class="scheduled-task-main">
        <div class="scheduled-task-title-row">
          <strong>${esc(task.name || t('scheduledTask'))}</strong>
          <span class="scheduled-status status-${esc(task.last_status || 'idle')}">${esc(task.last_status || (task.enabled ? t('enabled') : t('disabled')))}</span>
        </div>
        <div class="scheduled-task-meta">${esc(formatSchedule(task.schedule))} · ${esc(t('nextRun'))}: ${esc(formatTaskTime(task.next_run_at))}</div>
        <div class="scheduled-task-meta">${esc(shortenPath(task.cwd || '', 4))}</div>
        ${task.last_error ? `<div class="scheduled-task-error">${esc(task.last_error)}</div>` : ''}
      </div>
      <div class="scheduled-task-actions">
        <button class="btn-mini" data-act="run">${esc(t('runNow'))}</button>
        <button class="btn-mini" data-act="toggle">${esc(task.enabled ? t('disable') : t('enable'))}</button>
        <button class="btn-mini" data-act="edit">${esc(t('edit'))}</button>
        <button class="btn-mini danger" data-act="delete">${esc(t('delete'))}</button>
      </div>
    </article>
  `).join('');
  list.querySelectorAll('.scheduled-task-item').forEach(item => {
    const task = scheduledTasks.find(t => t.id === item.dataset.id);
    item.querySelector('[data-act="run"]')?.addEventListener('click', () => runScheduledTask(task));
    item.querySelector('[data-act="toggle"]')?.addEventListener('click', () => toggleScheduledTask(task));
    item.querySelector('[data-act="edit"]')?.addEventListener('click', () => fillScheduledForm(task));
    item.querySelector('[data-act="delete"]')?.addEventListener('click', () => deleteScheduledTask(task));
  });
}

function formatSchedule(schedule) {
  const s = schedule || {};
  if (s.type === 'daily') return `${t('scheduleDaily')} ${s.time || '09:00'}`;
  if (s.type === 'once') return `${t('scheduleOnce')} ${formatTaskTime(s.run_at)}`;
  return `${t('scheduleInterval')} ${s.minutes || 60}m`;
}

function formatTaskTime(ts) {
  const value = Number(ts || 0);
  if (!value) return '-';
  try { return new Date(value * 1000).toLocaleString(); } catch (e) { return '-'; }
}

function toDateTimeLocal(ts) {
  const date = ts ? new Date(Number(ts) * 1000) : new Date(Date.now() + 3600000);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function readScheduledForm() {
  const type = document.getElementById('scheduled-type')?.value || 'interval';
  const schedule = { type };
  if (type === 'daily') schedule.time = document.getElementById('scheduled-time')?.value || '09:00';
  else if (type === 'once') {
    const raw = document.getElementById('scheduled-run-at')?.value || '';
    schedule.run_at = raw ? Math.floor(new Date(raw).getTime() / 1000) : Math.floor(Date.now() / 1000) + 3600;
  } else {
    schedule.minutes = Math.max(1, Number(document.getElementById('scheduled-minutes')?.value || 60));
  }
  return {
    id: document.getElementById('scheduled-task-id')?.value || '',
    name: document.getElementById('scheduled-name')?.value || '',
    prompt: document.getElementById('scheduled-prompt')?.value || '',
    cwd: document.getElementById('scheduled-cwd')?.value || cwdInput?.value || '',
    model: document.getElementById('scheduled-model')?.value || modelSelect?.value || '',
    cli: document.getElementById('scheduled-cli')?.value || document.getElementById('cli-select')?.value || '',
    remote_target_id: document.getElementById('scheduled-remote')?.value || '',
    allow_remote_mutate: document.getElementById('scheduled-allow-remote-mutate')?.checked || false,
    reuse_session: document.getElementById('scheduled-reuse-session')?.checked || false,
    enabled: document.getElementById('scheduled-enabled')?.checked !== false,
    schedule,
  };
}

function fillScheduledForm(task) {
  populateScheduledSelects();
  document.getElementById('scheduled-form-title').textContent = t('scheduledEditTask');
  document.getElementById('scheduled-task-id').value = task.id || '';
  document.getElementById('scheduled-name').value = task.name || '';
  document.getElementById('scheduled-prompt').value = task.prompt || '';
  document.getElementById('scheduled-cwd').value = task.cwd || cwdInput?.value || '';
  if (task.model) document.getElementById('scheduled-model').value = task.model;
  if (task.cli) document.getElementById('scheduled-cli').value = task.cli;
  document.getElementById('scheduled-remote').value = task.remote_target_id || '';
  document.getElementById('scheduled-allow-remote-mutate').checked = !!task.allow_remote_mutate;
  document.getElementById('scheduled-reuse-session').checked = !!task.reuse_session;
  document.getElementById('scheduled-enabled').checked = task.enabled !== false;
  const schedule = task.schedule || { type: 'interval', minutes: 60 };
  document.getElementById('scheduled-type').value = schedule.type || 'interval';
  document.getElementById('scheduled-minutes').value = schedule.minutes || 60;
  document.getElementById('scheduled-time').value = schedule.time || '09:00';
  document.getElementById('scheduled-run-at').value = toDateTimeLocal(schedule.run_at);
  updateScheduledScheduleFields();
}

function resetScheduledForm() {
  document.getElementById('scheduled-form-title').textContent = t('scheduledNewTask');
  document.getElementById('scheduled-task-id').value = '';
  document.getElementById('scheduled-name').value = '';
  document.getElementById('scheduled-prompt').value = '';
  document.getElementById('scheduled-cwd').value = cwdInput?.value || '';
  document.getElementById('scheduled-type').value = 'interval';
  document.getElementById('scheduled-minutes').value = 60;
  document.getElementById('scheduled-time').value = '09:00';
  document.getElementById('scheduled-run-at').value = toDateTimeLocal();
  document.getElementById('scheduled-allow-remote-mutate').checked = false;
  document.getElementById('scheduled-reuse-session').checked = false;
  document.getElementById('scheduled-enabled').checked = true;
  populateScheduledSelects();
  updateScheduledScheduleFields();
}

async function saveScheduledTask() {
  const payload = readScheduledForm();
  if (!payload.prompt.trim()) {
    showToast(t('scheduledPromptRequired'), 'warning');
    return;
  }
  const resp = await fetch('/api/scheduled-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) {
    showToast(data.error || t('scheduledSaveFailed'), 'error');
    return;
  }
  showToast(t('scheduledTaskSaved'), 'success');
  resetScheduledForm();
  loadScheduledTasks();
}

async function deleteScheduledTask(task) {
  if (!task || !confirm(t('scheduledConfirmDelete', { name: task.name || t('scheduledTask') }))) return;
  await fetch('/api/scheduled-tasks/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: task.id }),
  });
  showToast(t('scheduledTaskDeleted'), 'success');
  loadScheduledTasks();
}

async function toggleScheduledTask(task) {
  if (!task) return;
  await fetch('/api/scheduled-tasks/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: task.id, enabled: !task.enabled }),
  });
  loadScheduledTasks();
}

async function runScheduledTask(task) {
  if (!task) return;
  await fetch('/api/scheduled-tasks/run-now', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: task.id }),
  });
  showToast(t('scheduledTaskStarted'), 'info');
  loadScheduledTasks();
}

// ─── 远程诊断目标 ────────────────────────────────────────────
let remoteTargets = [];
let remotePasswordSupported = true;

function initRemote() {
  remoteTargetSelect?.addEventListener('change', updateRemoteMutateRow);
  document.getElementById('btn-remote-add')?.addEventListener('click', () => showRemoteForm());
  document.getElementById('btn-remote-cancel')?.addEventListener('click', hideRemoteForm);
  document.getElementById('btn-remote-save')?.addEventListener('click', saveRemoteTarget);
  document.getElementById('btn-remote-test')?.addEventListener('click', () => testRemoteConnection(readRemoteForm()));
  document.getElementById('remote-form-auth')?.addEventListener('change', updateRemoteAuthVisibility);
  loadRemoteTargets();
}

async function loadRemoteTargets() {
  try {
    const resp = await fetch('/api/remote-targets');
    const data = await resp.json();
    // 兼容旧的数组返回；新版本返回 { targets, password_supported }
    if (Array.isArray(data)) {
      remoteTargets = data;
    } else {
      remoteTargets = Array.isArray(data.targets) ? data.targets : [];
      remotePasswordSupported = data.password_supported !== false;
    }
  } catch (e) {
    remoteTargets = [];
  }
  renderRemoteTargetList();
  populateRemoteSelect();
}

function updateRemoteAuthVisibility() {
  const method = document.getElementById('remote-form-auth')?.value || 'key';
  const keyBox = document.getElementById('remote-auth-key');
  const passBox = document.getElementById('remote-auth-password');
  if (keyBox) keyBox.style.display = method === 'password' ? 'none' : '';
  if (passBox) passBox.style.display = method === 'password' ? '' : 'none';
  const passHint = document.getElementById('remote-pass-hint');
  if (passHint) {
    const editing = !!document.getElementById('remote-form-id').value;
    const tg = remoteTargets.find(x => x.id === document.getElementById('remote-form-id').value);
    if (!remotePasswordSupported) {
      // SSH 缺失时，根据方法显示相应提示
      if (method === 'password') {
        passHint.innerHTML = `${t('remoteSshMissing')}<br><small style="color: #666; margin-top: 0.3em; display: block;">${t('remoteSshMissingWin')}</small>`;
      } else {
        // 密钥认证不受影响
        passHint.innerHTML = `<small style="color: #999;">${t('remoteKeyAuthUnaffected')}</small>`;
      }
    } else if (editing && tg?.has_password) passHint.textContent = t('remotePasswordSaved');
    else passHint.textContent = t('remotePasswordHint');
    passHint.classList.toggle('warn', !remotePasswordSupported && method === 'password');
  }
}

function populateRemoteSelect() {
  if (!remoteTargetSelect) return;
  const prev = remoteTargetSelect.value;
  remoteTargetSelect.innerHTML = `<option value="">${esc(t('remoteTargetNone'))}</option>` +
    remoteTargets.map(tg => `<option value="${esc(tg.id)}">${esc(tg.name || tg.host)}</option>`).join('');
  if (remoteTargets.some(tg => tg.id === prev)) remoteTargetSelect.value = prev;
  updateRemoteMutateRow();
}

function updateRemoteMutateRow() {
  if (!remoteMutateRow) return;
  const active = !!(remoteTargetSelect && remoteTargetSelect.value);
  remoteMutateRow.style.display = active ? '' : 'none';
  if (!active && remoteAllowMutate) remoteAllowMutate.checked = false;
  updateRuntimeSummary();
  renderWelcomeRuntime();
}

function updateRuntimeSummary() {
  const el = document.querySelector('.runtime-summary-value');
  if (!el) return;
  const cwd = cwdInput?.value?.trim() || '';
  const cwdName = shortenPlainPath(cwd, 3) || t('cwd');
  const remoteName = remoteTargetSelect?.selectedOptions?.[0]?.textContent?.trim() || '';
  const remoteActive = !!(remoteTargetSelect && remoteTargetSelect.value);
  el.textContent = remoteActive ? `${cwdName} / ${remoteName}` : cwdName;
  el.title = remoteActive ? `${cwd || ''} / ${remoteName}` : (cwd || '');
  renderInputStatus();
}

function renderInputStatus() {
  if (inputCliStatus) {
    const cliLabel = getSelectedCliLabel();
    inputCliStatus.textContent = `${t('cliTool')}: ${cliLabel}`;
    inputCliStatus.title = document.getElementById('cli-select')?.value || cliLabel;
  }
  if (inputCwdStatus) {
    const cwd = cwdInput?.value?.trim() || '';
    inputCwdStatus.textContent = `${t('cwd')}: ${shortenPlainPath(cwd, 3) || t('unsetCwd')}`;
    inputCwdStatus.title = cwd || t('unsetCwd');
  }
}

function renderRemoteTargetList() {
  const list = document.getElementById('remote-target-list');
  if (!list) return;
  if (!remoteTargets.length) {
    list.innerHTML = `<p class="empty-state">${esc(t('remoteNoTargets'))}</p>`;
    return;
  }
  list.innerHTML = remoteTargets.map(tg => `
    <div class="remote-target-item" data-id="${esc(tg.id)}">
      <div class="remote-target-info">
        <span class="remote-target-name">${esc(tg.name || tg.host)}</span>
        <span class="remote-target-addr">${esc(tg.user)}@${esc(tg.host)}:${esc(String(tg.port || 22))} · <span class="remote-key-badge">${esc(tg.auth_method === 'password' ? t('remoteAuthPassword') : t('remoteAuthKey'))}</span></span>
      </div>
      <div class="remote-target-actions">
        <button class="remote-mini-btn" data-act="test">${esc(t('remoteTest'))}</button>
        <button class="remote-mini-btn" data-act="edit">${esc(t('edit'))}</button>
        <button class="remote-mini-btn danger" data-act="delete">${esc(t('delete'))}</button>
      </div>
      <div class="remote-target-status" style="display:none"></div>
    </div>
  `).join('');
  list.querySelectorAll('.remote-target-item').forEach(item => {
    const id = item.dataset.id;
    const tg = remoteTargets.find(x => x.id === id);
    item.querySelector('[data-act="edit"]').addEventListener('click', () => showRemoteForm(tg));
    item.querySelector('[data-act="delete"]').addEventListener('click', () => deleteRemoteTarget(tg));
    item.querySelector('[data-act="test"]').addEventListener('click', () => testRemoteConnection(tg, item.querySelector('.remote-target-status')));
  });
}

function showRemoteForm(target) {
  const section = document.getElementById('remote-form-section');
  if (!section) return;
  document.getElementById('remote-form-id').value = target?.id || '';
  document.getElementById('remote-form-name').value = target?.name || '';
  document.getElementById('remote-form-host').value = target?.host || '';
  document.getElementById('remote-form-user').value = target?.user || '';
  document.getElementById('remote-form-port').value = target?.port || 22;
  document.getElementById('remote-form-key').value = target?.key_path || '';
  document.getElementById('remote-form-key-text').value = '';
  document.getElementById('remote-form-password').value = '';
  document.getElementById('remote-form-auth').value = target?.auth_method || 'key';
  document.getElementById('remote-form-desc').value = target?.description || '';
  // 私钥内容从不回传；编辑已配置密钥的目标时提示留空即保持不变
  const hint = document.getElementById('remote-key-hint');
  if (hint) hint.textContent = target?.has_key ? t('remoteKeySaved') : t('remoteKeyHint');
  updateRemoteAuthVisibility();
  const title = document.getElementById('remote-form-title');
  if (title) title.textContent = target ? t('remoteEditTarget') : t('remoteNewTarget');
  setRemoteFormStatus('', '');
  section.style.display = '';
  section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideRemoteForm() {
  const section = document.getElementById('remote-form-section');
  if (section) section.style.display = 'none';
}

function readRemoteForm() {
  return {
    id: document.getElementById('remote-form-id').value || '',
    name: document.getElementById('remote-form-name').value.trim(),
    host: document.getElementById('remote-form-host').value.trim(),
    user: document.getElementById('remote-form-user').value.trim(),
    port: Number(document.getElementById('remote-form-port').value || 22),
    auth_method: document.getElementById('remote-form-auth').value || 'key',
    key_path: document.getElementById('remote-form-key').value.trim(),
    key_text: document.getElementById('remote-form-key-text').value,
    password: document.getElementById('remote-form-password').value,
    description: document.getElementById('remote-form-desc').value.trim(),
  };
}

function setRemoteFormStatus(text, kind) {
  const status = document.getElementById('remote-form-status');
  if (!status) return;
  status.style.display = text ? '' : 'none';
  status.textContent = text;
  status.className = `remote-form-status${kind ? ' ' + kind : ''}`;
}

async function saveRemoteTarget() {
  const target = readRemoteForm();
  if (!target.host || !target.user) {
    setRemoteFormStatus(t('remoteNeedHostUser'), 'err');
    return;
  }
  try {
    const resp = await fetch('/api/remote-targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      setRemoteFormStatus(err.error || t('remoteSaveFailed'), 'err');
      return;
    }
    await loadRemoteTargets();
    hideRemoteForm();
  } catch (e) {
    setRemoteFormStatus(t('remoteSaveFailed'), 'err');
  }
}

async function deleteRemoteTarget(target) {
  if (!target) return;
  if (!window.confirm(t('remoteConfirmDelete', { name: target.name || target.host }))) return;
  try {
    await fetch('/api/remote-targets/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: target.id }),
    });
  } catch (e) { /* ignore */ }
  await loadRemoteTargets();
}

async function testRemoteConnection(target, statusEl) {
  if (!target || !target.host || !target.user) {
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = t('remoteNeedHostUser'); statusEl.className = 'remote-target-status err'; }
    else setRemoteFormStatus(t('remoteNeedHostUser'), 'err');
    return;
  }
  const setStatus = (text, kind) => {
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = text; statusEl.className = `remote-target-status${kind ? ' ' + kind : ''}`; }
    else setRemoteFormStatus(text, kind);
  };
  setStatus(t('remoteTesting'), '');
  try {
    const resp = await fetch('/api/remote-targets/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    });
    const result = await resp.json();
    if (result.ok) {
      setStatus(t('remoteTestOk'), 'ok');
    } else {
      const reasons = {
        ssh_not_found: t('remoteSshMissing'),
        timeout: t('remoteTestTimeout'),
        missing_host_or_user: t('remoteNeedHostUser'),
        missing_password: t('remoteNeedPassword'),
        auth_failed: t('remoteAuthFailed'),
        target_not_found: t('remoteSaveFailed'),
      };
      const base = reasons[result.error] || t('remoteTestFail');
      setStatus(result.detail ? `${base} — ${result.detail}` : base, 'err');
    }
  } catch (e) {
    setStatus(t('remoteTestFail'), 'err');
  }
}

function initFocusConfigReload() {
  window.addEventListener('focus', reloadConfigOnFocus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reloadConfigOnFocus();
    }
  });
}

function reloadConfigOnFocus() {
  const now = Date.now();
  if (now - lastFocusConfigReloadAt < 1500) return;
  lastFocusConfigReloadAt = now;
  reloadExternalConfig();
}

async function reloadExternalConfig() {
  await Promise.all([
    loadClis(),
    loadModels(),
    loadConfig(),
  ]);
  slashCommands = [];
  closeSlashCommandPanel();
}

function applyTheme(theme, persist = true) {
  const isLight = theme === 'light';
  document.documentElement.classList.toggle('light-theme', isLight);
  const themeValue = isLight ? 'light' : 'dark';
  document.cookie = `ccb-theme=${encodeURIComponent(themeValue)}; Max-Age=31536000; Path=/; SameSite=Lax`;
  try {
    localStorage.setItem('ccb-theme', themeValue);
  } catch (e) { /* ignore */ }
  updateThemeToggle();
  if (persist) saveThemePreference(themeValue);
}

async function loadThemePreference() {
  try {
    const resp = await fetch('/api/gui-settings');
    const data = await resp.json();
    const language = data.language === 'zh' ? 'zh' : 'en';
    const size = normalizeFontSize(data.font_size_percent);
    savedModelPref = data.default_model || '';
    autoUpdateEnabled = data.auto_update_enabled !== false;
    skipUpdateVersion = data.skip_update_version || '';
    const autoUpdateToggle = document.getElementById('auto-update-toggle');
    if (autoUpdateToggle) autoUpdateToggle.checked = autoUpdateEnabled;

    if (data.theme === 'light' || data.theme === 'dark') {
      applyTheme(data.theme, false);
    } else {
      const currentTheme = document.documentElement.classList.contains('light-theme') ? 'light' : 'dark';
      saveGuiSettings({ theme: currentTheme });
    }

    applyFontSize(size, false);
    await applyLanguage(language, false);
    applyNotificationPreference(Boolean(data.notifications_enabled));
    accessContext = { isLocalhost: Boolean(data.is_localhost), defaultCwd: data.default_cwd || '' };
    document.body.classList.toggle('pane-right-collapsed', data.right_panel_collapsed === true);
    applyRightPaneWidth(data.right_panel_width);
    applyLanAccessPreference(data);

    if (data.language !== language || Number(data.font_size_percent) !== size) {
      saveGuiSettings({ language, font_size_percent: size });
    }
  } catch (e) {
    applyFontSize(100, false);
    await applyLanguage('en', false);
    applyNotificationPreference(false);
    applyLanAccessPreference({ is_localhost: false, lan_access_enabled: false });
  }
}

async function saveThemePreference(theme) {
  await saveGuiSettings({ theme });
}

async function saveGuiSettings(settings) {
  try {
    await fetch('/api/gui-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  } catch (e) { /* ignore */ }
}

function updateThemeToggle() {
  const isLight = document.documentElement.classList.contains('light-theme');
  if (themeToggleText) themeToggleText.textContent = isLight ? t('switchToDark') : t('switchToLight');
  btnThemeToggle.setAttribute('aria-label', isLight ? t('switchToDarkTheme') : t('switchToLightTheme'));
  btnThemeToggle.title = isLight ? t('switchToDarkTheme') : t('switchToLightTheme');
}

async function applyLanguage(language, persist = true) {
  currentLanguage = language === 'zh' ? 'zh' : 'en';
  if (languageSelect) languageSelect.value = currentLanguage;
  document.documentElement.lang = currentLanguage === 'zh' ? 'zh-CN' : 'en';
  await loadLanguageMap(currentLanguage);
  document.title = t('pageTitle');
  renderLocalizedText();
  updateThemeToggle();
  updateConnectionText();
  updateUI();
  setSidebarCollapsed(sidebarCollapsed);
  updateFilePickerCount();
  if (persist) saveGuiSettings({ language: currentLanguage });
}

async function loadLanguageMap(language) {
  try {
    const resp = await fetch(`/static/i18n/${language}.json`);
    if (!resp.ok) throw new Error(`missing locale: ${language}`);
    i18nMap = await resp.json();
  } catch (e) {
    if (language !== 'en') {
      currentLanguage = 'en';
      await loadLanguageMap('en');
    }
  }
}

function renderLocalizedText() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    if (el.id === 'topbar-model' && sessionActive) return;
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
}

function t(key, vars = {}) {
  let text = i18nMap[key] || key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

function applyFontSize(value, persist = true) {
  fontSizePercent = normalizeFontSize(value);
  document.documentElement.style.setProperty('--ui-scale', String(fontSizePercent / 100));
  if (fontSizeRange) fontSizeRange.value = String(fontSizePercent);
  if (fontSizeValue) fontSizeValue.textContent = `${fontSizePercent}%`;
  if (persist) saveGuiSettings({ font_size_percent: fontSizePercent });
}

function normalizeFontSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return 100;
  return Math.min(125, Math.max(85, Math.round(size / 5) * 5));
}

function formatTopbarSessionId(sessionId) {
  if (!sessionId) return '-';
  return sessionId.length > 13 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId;
}

function getSelectedCliLabel() {
  const cliSelect = document.getElementById('cli-select');
  const opt = cliSelect?.selectedOptions?.[0];
  return opt?.textContent?.trim() || opt?.value || '-';
}

function quoteCommandArg(value) {
  const text = String(value || '');
  if (!text) return '';
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function getResumeCommandText() {
  if (!currentSessionId) return '';
  const cliSelect = document.getElementById('cli-select');
  const cli = cliSelect?.value || getSelectedCliLabel();
  return `${quoteCommandArg(cli)} --resume ${quoteCommandArg(currentSessionId)}`;
}

async function copyResumeCommand() {
  const text = getResumeCommandText();
  if (!text) {
    addSystemMsg(t('noSession'), true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    addSystemMsg(t('resumeCommandCopied'));
  } catch (e) {
    addSystemMsg(t('copyFailed'), true);
  }
}

function renderTopbarMeta(modelOverride = '') {
  const modelLabel = getDisplayModelName(modelOverride || modelSelect?.value || '') || t('noSession');
  if (topbarSessionId) {
    topbarSessionId.textContent = formatTopbarSessionId(currentSessionId);
    const resumeCommand = getResumeCommandText();
    topbarSessionId.title = resumeCommand || t('copyResumeCommand');
    topbarSessionId.disabled = !currentSessionId;
  }
  if (topbarModel) topbarModel.textContent = modelLabel;
  if (topbarCli) {
    const cliLabel = getSelectedCliLabel();
    topbarCli.textContent = cliLabel;
    topbarCli.title = document.getElementById('cli-select')?.value || cliLabel;
  }
  renderTopbarSessionActions();
}

function getCurrentSessionRecord() {
  return cachedSessions.find(s => s.session_id === currentSessionId) || null;
}

function renderTopbarSessionActions() {
  const session = getCurrentSessionRecord();
  const disabled = !currentSessionId || !session;
  [btnSessionPin, btnSessionCwd, btnSessionRename, btnSessionDelete].forEach(btn => {
    if (!btn) return;
    btn.disabled = disabled;
  });
  if (btnSessionPin) {
    btnSessionPin.classList.toggle('pinned', !!session?.pinned);
    btnSessionPin.textContent = session?.pinned ? 'UNPIN' : 'PIN';
    btnSessionPin.title = t(session?.pinned ? 'unpinSession' : 'pinSession');
  }
  if (btnSessionCwd) btnSessionCwd.title = session?.cwd || t('changeCwd');
}

async function loadClis() {
  const cliSelect = document.getElementById('cli-select');
  const guideBtn = document.getElementById('btn-cli-install-guide');
  try {
    const resp = await fetch('/api/clis');
    const data = await resp.json();
    const available = data.available || [];
    const current = data.current || '';
    if (data.install_command) cliInstallCommand = data.install_command;
    cliSelect.innerHTML = '';
    if (available.length === 0) {
      cliSelect.innerHTML = `<option value="">${esc(t('noCli'))}</option>`;
      if (guideBtn) guideBtn.style.display = '';
      // 首次检测不到 CLI 时自动弹出安装引导
      if (!cliInstallPromptShown) {
        cliInstallPromptShown = true;
        openCliInstallModal();
      }
      renderTopbarMeta();
      renderInputStatus();
      return;
    }
    if (guideBtn) guideBtn.style.display = 'none';
    for (const cli of available) {
      const opt = document.createElement('option');
      opt.value = cli.path;
      opt.textContent = `${cli.name}`;
      opt.title = cli.path;
      if (cli.path === current) opt.selected = true;
      cliSelect.appendChild(opt);
    }
    cliSelect.onchange = async () => {
      await fetch('/api/clis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: cliSelect.value }),
      });
      renderTopbarMeta();
      renderWelcomeRuntime();
      addSystemMsg(t('cliSwitched', { path: cliSelect.value }));
      loadSlashCommands();
    };
    renderTopbarMeta();
  } catch (e) { /* ignore */ }
}

// 选中指定 CLI（若可用），并同步到服务端全局当前 CLI
function selectCli(path) {
  const cliSelect = document.getElementById('cli-select');
  if (!cliSelect || !path) return false;
  const has = Array.from(cliSelect.options).some(o => o.value === path);
  if (!has || cliSelect.value === path) return has && cliSelect.value === path;
  cliSelect.value = path;
  fetch('/api/clis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).catch(() => {});
  renderTopbarMeta();
  renderWelcomeRuntime();
  return true;
}

// ─── CLI 安装引导 ────────────────────────────────────────────
let cliInstallCommand = 'npm install -g @anthropic-ai/claude-code';
let cliInstallPromptShown = false;
let cliInstalling = false;

function openCliInstallModal() {
  const overlay = document.getElementById('cli-install-overlay');
  if (!overlay) return;
  const cmdEl = document.getElementById('cli-install-cmd');
  if (cmdEl) cmdEl.textContent = cliInstallCommand;
  setCliInstallStatus('', '');
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

async function copyCliInstallCommand() {
  let copied = false;
  try {
    await navigator.clipboard.writeText(cliInstallCommand);
    copied = true;
  } catch (e) {
    // http 环境下 clipboard API 可能不可用，回退到 execCommand
    const ta = document.createElement('textarea');
    ta.value = cliInstallCommand;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { copied = document.execCommand('copy'); } catch (e2) { /* ignore */ }
    ta.remove();
  }
  setCliInstallStatus(copied ? t('cmdCopied') : t('cmdCopyFailed'), copied ? 'ok' : 'err');
}

async function runCliAutoInstall() {
  if (cliInstalling) return;
  cliInstalling = true;
  const runBtn = document.getElementById('cli-install-run');
  const output = document.getElementById('cli-install-output');
  if (runBtn) runBtn.disabled = true;
  setCliInstallStatus(t('cliInstalling'), '');
  try {
    const resp = await fetch('/api/install-cli', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await resp.json();
    if (output && result.output) {
      output.style.display = '';
      output.textContent = result.output;
      output.scrollTop = output.scrollHeight;
    }
    if (result.ok) {
      setCliInstallStatus(t('cliInstallSuccess'), 'ok');
      await loadClis();
      addSystemMsg(t('cliInstallSuccess'));
      setTimeout(closeCliInstallModal, 1200);
    } else {
      const reasons = {
        npm_not_found: t('cliInstallNpmMissing'),
        install_in_progress: t('cliInstallInProgress'),
        install_timeout: t('cliInstallTimeout'),
        cli_not_detected_after_install: t('cliInstallNotDetected'),
      };
      setCliInstallStatus(reasons[result.error] || t('cliInstallFailed'), 'err');
    }
  } catch (e) {
    setCliInstallStatus(t('cliInstallFailed'), 'err');
  } finally {
    cliInstalling = false;
    if (runBtn) runBtn.disabled = false;
  }
}

function initCliInstallModal() {
  document.getElementById('btn-cli-install-guide')?.addEventListener('click', openCliInstallModal);
  document.getElementById('cli-install-close')?.addEventListener('click', closeCliInstallModal);
  document.getElementById('cli-install-copy')?.addEventListener('click', copyCliInstallCommand);
  document.getElementById('cli-install-run')?.addEventListener('click', runCliAutoInstall);
  document.getElementById('cli-install-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCliInstallModal();
  });
}

// ─── 自动更新 ────────────────────────────────────────────────
let updateRunning = false;

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

async function checkForUpdate(manual = false) {
  const checkBtn = document.getElementById('btn-check-update');
  const checkHint = document.getElementById('update-check-hint');
  const previousCheckText = checkBtn?.textContent || '';
  if (manual) {
    if (checkBtn) checkBtn.disabled = true;
    if (checkHint) {
      checkHint.textContent = t('updateCheckRunning');
      checkHint.className = 'update-check-hint';
    }
  }
  try {
    const resp = await fetch('/api/check-update');
    const data = await resp.json();
    updateInfo = data;
    if (!data.ok) {
      if (manual && checkHint) {
        checkHint.textContent = t('updateFailed');
        checkHint.className = 'update-check-hint err';
      }
      return;
    }
    const versionEl = document.getElementById('app-version');
    if (versionEl) {
      const localVersion = data.local_short || '—';
      versionEl.textContent = data.needs_restart && data.server_start_short
        ? `${data.server_start_short} → ${localVersion}`
        : localVersion;
    }

    if (data.has_update && (manual || data.remote !== skipUpdateVersion)) {
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
        setUpdateStatus(t('updateRestartNeeded'), '');
        const runBtn = document.getElementById('update-run');
        if (runBtn) runBtn.disabled = false;
        openUpdateModal();
      }
    } else if (manual && checkHint) {
      checkHint.textContent = t('updateUpToDate');
      checkHint.className = 'update-check-hint ok';
    }
  } catch (e) {
    if (manual && checkHint) {
      checkHint.textContent = t('updateFailed');
      checkHint.className = 'update-check-hint err';
    }
  } finally {
    if (manual && checkBtn) {
      checkBtn.disabled = false;
      checkBtn.textContent = previousCheckText || t('checkUpdate');
    }
  }
}

async function runUpdate() {
  if (updateRunning) return;
  updateRunning = true;
  const runBtn = document.getElementById('update-run');
  if (runBtn) runBtn.disabled = true;
  setUpdateStatus(t('updateChecking'), '');
  try {
    if (!updateInfo?.needs_restart || updateInfo?.has_update) {
      const resp = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await resp.json();
      const changelog = document.getElementById('update-changelog');
      if (changelog && result.output) { changelog.style.display = ''; changelog.textContent = result.output; }
      if (!result.ok) {
        setUpdateStatus(t('updateRestartManual'), 'err');
        if (runBtn) runBtn.disabled = false;
        return;
      }
    }
    setUpdateStatus(t('updateSuccess'), 'ok');
    try {
      await fetch('/api/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (e) { /* 重启会断开连接，忽略 */ }
    waitForServerAndReload();
  } catch (e) {
    setUpdateStatus(t('updateFailed'), 'err');
    if (runBtn) runBtn.disabled = false;
  } finally {
    updateRunning = false;
  }
}

function skipThisVersion() {
  if (updateInfo && updateInfo.remote) {
    skipUpdateVersion = updateInfo.remote;
    saveGuiSettings({ skip_update_version: updateInfo.remote });
  }
  closeUpdateModal();
}

async function waitForServerAndReload(attempt = 0) {
  if (attempt > 40) { setUpdateStatus(t('updateRestartManual'), 'err'); return; }
  try {
    const resp = await fetch('/api/gui-settings', { cache: 'no-store' });
    if (resp.ok) { location.reload(); return; }
  } catch (e) { /* 服务重启中，继续等待 */ }
  setTimeout(() => waitForServerAndReload(attempt + 1), 1500);
}

function initUpdateModal() {
  document.getElementById('update-close')?.addEventListener('click', closeUpdateModal);
  document.getElementById('update-skip')?.addEventListener('click', skipThisVersion);
  document.getElementById('update-run')?.addEventListener('click', runUpdate);
  document.getElementById('btn-check-update')?.addEventListener('click', () => checkForUpdate(true));
  document.getElementById('update-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeUpdateModal();
  });
  document.getElementById('auto-update-toggle')?.addEventListener('change', (e) => {
    autoUpdateEnabled = e.target.checked;
    saveGuiSettings({ auto_update_enabled: autoUpdateEnabled });
  });
}

async function loadModels() {
  // 首次加载 select 为空，回退到 gui_settings 里上次使用的模型，使刷新后保持选择
  const previousModel = modelSelect.value || savedModelPref;
  try {
    const resp = await fetch('/api/models');
    const models = await resp.json();
    const availableModels = Array.isArray(models) ? models.filter(Boolean) : [];
    if (!availableModels.length) {
      modelSelect.innerHTML = '<option value="claude-sonnet-4-6">Sonnet 4.6</option>';
      renderModelPill();
      renderWelcomeRuntime();
      return;
    }
    modelSelect.innerHTML = availableModels.map((model, idx) => (
      `<option value="${esc(model)}" ${(previousModel ? model === previousModel : idx === 0) ? 'selected' : ''}>${esc(formatModelName(model))}</option>`
    )).join('');
    if (previousModel && !availableModels.includes(previousModel)) {
      modelSelect.value = availableModels[0] || '';
    }
    renderModelPill();
    renderWelcomeRuntime();
  } catch (e) {
    modelSelect.innerHTML = '<option value="claude-sonnet-4-6">Sonnet 4.6</option>';
    renderModelPill();
    renderWelcomeRuntime();
  }
}

// ─── 导航 ────────────────────────────────────────────────────
function showPage(page) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');
  // 更新全局 titlebar
  const pageLabel = document.getElementById('titlebar-page-label');
  const pageKey = page === 'home' ? 'home' : page === 'config' ? 'settings' : page === 'artifacts' ? 'artifacts' : page === 'scheduled' ? 'scheduledTasks' : page === 'sessions' ? 'sessions' : page === 'skills' ? 'skills' : page === 'integrations' ? 'integrations' : page === 'memory' ? 'memory' : 'chat';
  if (pageLabel) pageLabel.textContent = t(pageKey);
  const isChatPage = page === 'chat';
  const backBtn = document.getElementById('btn-titlebar-back');
  if (backBtn) {
    const canBackToChat = page !== 'home' && !isChatPage && sessionActive;
    backBtn.style.display = canBackToChat ? '' : 'none';
    backBtn.textContent = t('backToChat');
  }
  const titlebarMeta = document.getElementById('titlebar-meta');
  if (titlebarMeta) titlebarMeta.style.display = isChatPage ? '' : 'none';
  const btnExport = document.getElementById('btn-export-chat');
  if (btnExport) btnExport.style.display = isChatPage ? '' : 'none';
  const btnPanel = document.getElementById('btn-toggle-right-panel');
  if (btnPanel) btnPanel.style.display = isChatPage ? '' : 'none';
  [btnSessionPin, btnSessionCwd, btnSessionRename, btnSessionDelete].forEach(btn => {
    if (btn) btn.style.display = 'none';
  });
  if (isChatPage) {
    renderTopbarMeta();
    renderTopbarStatusSummary();
  } else if (page === 'sessions') {
    renderSessionList(cachedSessions);
  } else if (page === 'artifacts') {
    loadArtifacts();
  } else if (page === 'skills') {
    loadSkills();
  } else if (page === 'integrations') {
    loadIntegrations();
  } else if (page === 'memory') {
    loadMemoryFiles();
  } else if (page === 'scheduled') {
    loadScheduledTasks();
  }
  hideMentionPopup();
}

async function openLatestOrNewChatSession() {
  if (sessionActive || currentSessionId) {
    showPage('chat');
    return;
  }
  if (!clientId) {
    showPage('chat');
    addSystemMsg(t('notConnected'), true);
    return;
  }
  if (activeWorkspaceSessionId && workspaceSessions.has(activeWorkspaceSessionId)) {
    const session = workspaceSessions.get(activeWorkspaceSessionId);
    showPage('chat');
    resumeSession(
      session.sessionId,
      session.cwd || '',
      session.model || '',
      Number(session.cost || 0),
      session.remoteTargetId || '',
      session.tokens || null,
      session.cli || '',
    );
    return;
  }
  if (!sessionsLoaded) {
    await loadSessions();
  }
  const latest = (cachedSessions || [])
    .slice()
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
  showPage('chat');
  if (latest?.session_id) {
    resumeSession(
      latest.session_id,
      latest.cwd || '',
      latest.model || '',
      Number(latest.total_cost_usd || 0),
      latest.remote_target_id || '',
      latest.total_tokens || null,
      latest.cli || '',
    );
    return;
  }
  createNewSession('');
}

function initNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.page === 'chat') {
        openLatestOrNewChatSession();
        return;
      }
      showPage(btn.dataset.page);
    });
  });
  // 全局 titlebar 设置按钮
  const btnNavSettings = document.getElementById('btn-nav-settings');
  if (btnNavSettings) {
    btnNavSettings.addEventListener('click', () => showPage('config'));
  }
  // 全局 titlebar 返回聊天按钮
  const btnBack = document.getElementById('btn-titlebar-back');
  if (btnBack) {
    btnBack.addEventListener('click', () => showPage('chat'));
  }
  sessionSearchInput?.addEventListener('input', () => renderSessionList(cachedSessions));
  // 会话页新建会话入口
  sessionsNewSessionBtn?.addEventListener('click', () => {
    showPage('chat');
    startNewSession();
  });
  document.getElementById('btn-skills-refresh')?.addEventListener('click', loadSkills);
  document.getElementById('skill-modal-close')?.addEventListener('click', closeSkillModal);
  document.getElementById('btn-skill-close')?.addEventListener('click', closeSkillModal);
  document.getElementById('skill-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target?.id === 'skill-modal-overlay') closeSkillModal();
  });
  document.getElementById('btn-skill-uninstall')?.addEventListener('click', uninstallCurrentSkill);
  // 设置页标签切换
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.config-tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.querySelector(`.config-tab-panel[data-tab="${tabName}"]`);
      if (panel) panel.classList.add('active');
    });
  });
}

async function toggleSessionPin(sessionId) {
  if (!sessionId) return;
  try {
    const resp = await fetch('/api/sessions/toggle-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (resp.ok) await loadSessions();
  } catch (err) {
    console.error('[pin] error', err);
  }
}

async function changeSessionCwd(session) {
  if (!session) return;
  const oldCwd = session.cwd || '';
  const newCwd = await promptCwdForSession(oldCwd);
  if (!newCwd || !newCwd.trim() || newCwd.trim() === oldCwd) return;
  const result = await updateSessionCwd(session.session_id, newCwd.trim());
  if (result.ok) {
    addSystemMsg(t('cwdChanged', { path: newCwd.trim() }));
    if (session.session_id === currentSessionId) {
      cwdInput.value = newCwd.trim();
      updateRuntimeSummary();
      refreshRightPaneFiles();
    }
    await loadSessions();
  } else {
    addSystemMsg(t('cwdNotChanged', { message: result.error || t('unknownError') }), true);
  }
}

async function promptRenameSession(session) {
  if (!session) return;
  const currentTitle = session.title || t('newChat');
  const nextTitle = window.prompt(t('renameSessionPrompt'), currentTitle);
  if (!nextTitle || nextTitle.trim() === currentTitle) return;
  await renameSession(session.session_id, nextTitle.trim());
}

async function deleteSessionRecord(session, nextPage = 'sessions') {
  if (!session) return;
  const title = session.title || t('newChat');
  if (!window.confirm(t('confirmDeleteSession', { title }))) return;
  await fetch('/api/sessions/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: session.session_id, cwd: session.cwd || '' }),
  });
  if (session.session_id === currentSessionId) currentSessionId = null;
  await loadSessions();
  renderTopbarMeta();
  showPage(nextPage);
}

function initTopbarSessionActions() {
  btnSessionPin?.addEventListener('click', async () => {
    const session = getCurrentSessionRecord();
    if (session) await toggleSessionPin(session.session_id);
  });

  btnSessionCwd?.addEventListener('click', async () => {
    await changeSessionCwd(getCurrentSessionRecord());
  });

  btnSessionRename?.addEventListener('click', async () => {
    await promptRenameSession(getCurrentSessionRecord());
  });

  btnSessionDelete?.addEventListener('click', async () => {
    await deleteSessionRecord(getCurrentSessionRecord(), 'sessions');
  });
}

function initMobileLayout() {
  const toggles = document.querySelectorAll('.mobile-menu-toggle');
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('mobile-sidebar-backdrop');
  const mobileQuery = window.matchMedia('(max-width: 760px)');

  if (!toggles.length || !sidebar || !backdrop) return;

  const setExpanded = (expanded) => {
    toggles.forEach(toggle => toggle.setAttribute('aria-expanded', String(expanded)));
  };

  const chatSidebar = document.getElementById('chat-sidebar');
  const closeMenu = () => {
    sidebar.classList.remove('mobile-open');
    if (chatSidebar) chatSidebar.classList.remove('open');
    backdrop.classList.remove('visible');
    document.body.classList.remove('mobile-overlay');
    setExpanded(false);
  };

  const openMenu = () => {
    sidebar.classList.add('mobile-open');
    backdrop.classList.add('visible');
    setExpanded(true);
  };

  toggles.forEach(toggle => {
    toggle.addEventListener('click', () => {
      if (sidebar.classList.contains('mobile-open')) {
        closeMenu();
      } else {
        openMenu();
      }
    });
  });

  backdrop.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  sidebar.addEventListener('click', (e) => {
    if (!mobileQuery.matches) return;
    if (e.target.closest('.nav-btn, .session-item, #btn-new-session, #welcome-new-session')) closeMenu();
  });

  document.getElementById('welcome-new-session')?.addEventListener('click', () => {
    if (mobileQuery.matches) closeMenu();
  });

  const handleQueryChange = (e) => {
    if (!e.matches) closeMenu();
  };

  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener('change', handleQueryChange);
  } else {
    mobileQuery.addListener(handleQueryChange);
  }
}

// ─── SSE 连接 ────────────────────────────────────────────────
function initSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  // sessionStorage 确保每个标签页有独立的 clientId，避免跨标签页 SSE 队列冲突
  clientId = sessionStorage.getItem('ccb_client_id') || 'c_' + Math.random().toString(36).substring(2, 10);
  sessionStorage.setItem('ccb_client_id', clientId);
  eventSource = new EventSource(`/sse?id=${clientId}`);
  bindSSEEvents();
}

function isEventForCurrentSession(data = {}) {
  if (data.run_id && currentRunId && data.run_id === currentRunId) return true;
  if (data.session_id && currentSessionId) return data.session_id === currentSessionId;
  return true;
}

function noteBackgroundSessionEvent(data = {}) {
  if (!data.session_id || !currentSessionId || data.session_id === currentSessionId) return false;
  if (data.run_id && currentRunId && data.run_id === currentRunId) return false;
  scheduleCompletionHistorySync(data.session_id);
  return true;
}

function bindSSEEvents() {
  eventSource.addEventListener('connected', (e) => {
    const data = JSON.parse(e.data);
    clientId = data.client_id;
    setConnectionStatus(true);
  });

  eventSource.addEventListener('session_started', (e) => {
    const data = JSON.parse(e.data);
    if (data.session_id) currentSessionId = data.session_id;
    currentRunId = data.run_id || null;
    const wasActive = sessionActive;
    sessionActive = true;
    isViewer = !!data.viewing;
    updateUI();
    const modelLabel = getDisplayModelName(data.model || '');
    renderTopbarMeta(data.model || '');
    // 恢复远程目标选择（刷新后 resume 时后端会回传 remote_target_id）
    if (data.remote_target_id && remoteTargetSelect) {
      remoteTargetSelect.value = data.remote_target_id;
      updateRemoteMutateRow();
    }
    // 恢复 CLI 选择
    const cliSelectEl = document.getElementById('cli-select');
    if (data.cli && cliSelectEl && [...cliSelectEl.options].some(o => o.value === data.cli)) {
      cliSelectEl.value = data.cli;
      renderTopbarMeta(data.model || '');
    }
    // 重连时清除欢迎消息，恢复会话状态
    if (!wasActive) {
      const welcome = messagesEl.querySelector('.welcome-msg');
      if (welcome) welcome.remove();
      if (data.session_id) {
        currentSessionId = data.session_id;
        currentRunId = data.run_id || currentRunId;
        ensureWorkspaceSession(data.session_id, {
          title: data.title || t('newChat'),
          cwd: data.cwd || cwdInput.value.trim() || '',
          model: data.model || modelSelect.value || '',
          cli: data.cli || document.getElementById('cli-select')?.value || '',
          status: data.running === false ? 'idle' : 'running',
          runId: data.run_id || '',
        });
        activeWorkspaceSessionId = data.session_id;
        if (data.cwd) {
          cwdInput.value = data.cwd;
          updateRuntimeSummary();
        }
        refreshRightPaneFiles();
        showPage('chat');
        loadSessionHistory(data.session_id, data.cwd || '');
        if (isViewer) {
          addSystemMsg(t('viewingSession'));
        } else {
          addSystemMsg(modelLabel ? t('sessionStarted', { model: modelLabel }) : t('sessionStartedPlain'));
        }
      } else if (isViewer) {
        addSystemMsg(t('viewingSession'));
      } else {
        addSystemMsg(modelLabel ? t('sessionStarted', { model: modelLabel }) : t('sessionStartedPlain'));
      }
    }
  });

  eventSource.addEventListener('session_stopped', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (!isEventForCurrentSession(data)) return;
    sessionActive = false;
    isResponding = false;
    isViewer = false;
    currentRunId = null;
    updateUI();
    addSystemMsg(t('sessionStopped'));
  });

  eventSource.addEventListener('session_taken', (e) => {
    // 会话被其他客户端接管，服务端已自动注册本端为 viewer 并推送 session_started(viewing=true)
    // 前端只需显示提示，无需调用 resumeSession（避免 ping-pong 循环）
    const data = JSON.parse(e.data);
    if (data.session_id && data.session_id === currentSessionId) {
      addSystemMsg(t('sessionTaken') || '会话被其他客户端接管，切换为观察模式');
      isViewer = true;
      isResponding = false;
      updateUI();
    }
  });

  eventSource.addEventListener('user_message', (e) => {
    // viewer 收到 owner 发送的用户消息（一问一答中的"问"）
    const data = JSON.parse(e.data);
    if (!isEventForCurrentSession(data)) return;
    if (data.content) {
      addUserMessage(data.content);
      scrollToBottom();
    }
  });

  eventSource.addEventListener('generation_started', (e) => {
    // 刷新后重连到正在回复的会话，恢复响应状态和 server 端真实耗时。
    // 未收到实际 assistant 输出前不创建空回复气泡，避免历史加载/进程结束竞态造成短暂流式闪烁。
    const data = JSON.parse(e.data || '{}');
    if (!isEventForCurrentSession(data)) return;
    if (data.running === false) return;
    currentRunId = data.run_id || currentRunId;
    isResponding = true;
    currentTurnStartedAt = data.started_at ? data.started_at * 1000 : Date.now() - Number(data.elapsed_ms || 0);
    currentTurnContent = data.prompt || currentTurnContent || '';
    currentTurnHasAssistantOutput = !!data.has_output;
    updateWorkspaceSessionStatus(currentSessionId, 'running', t('streamingReply'));
    if (currentTurnHasAssistantOutput) {
      if (!currentAssistantEl) {
        currentAssistantEl = createAssistantBubble();
        currentContent = [];
        streamBlocks = {};
        renderCurrentState();
      } else {
        currentAssistantEl.classList.add('streaming');
      }
      scrollToBottom();
    }
    startTurnTimer();
    updateUI();
  });

  eventSource.addEventListener('system', (e) => {
    const data = JSON.parse(e.data);
    if (!isEventForCurrentSession(data)) return;
    if (data.subtype === 'init') {
      const modelLabel = getDisplayModelName(data.model || '');
      addSystemMsg(t('initStatus', {
        model: modelLabel || t('model'),
        tools: (data.tools || []).length,
        skills: (data.skills || []).length,
      }));
    }
  });

  eventSource.addEventListener('stream_event', (e) => {
    const data = JSON.parse(e.data);
    if (noteBackgroundSessionEvent(data)) return;
    handleStreamEvent(data);
  });

  eventSource.addEventListener('assistant', (e) => {
    const data = JSON.parse(e.data);
    if (noteBackgroundSessionEvent(data)) return;
    handleAssistantFinal(data);
  });

  eventSource.addEventListener('session_id_captured', (e) => {
    const data = JSON.parse(e.data);
    if (data.session_id && currentSessionId && data.session_id !== currentSessionId && data.run_id !== currentRunId) {
      scheduleCompletionHistorySync(data.session_id);
      return;
    }
    currentSessionId = data.session_id;
    currentRunId = data.run_id || currentRunId;
    if (activeWorkspaceSessionId && activeWorkspaceSessionId.startsWith('pending-') && activeWorkspaceSessionId !== data.session_id) {
      const pending = workspaceSessions.get(activeWorkspaceSessionId);
      workspaceSessions.delete(activeWorkspaceSessionId);
      activeWorkspaceSessionId = data.session_id;
      if (pending?.snapshotHtml && !workspaceSessions.get(data.session_id)?.snapshotHtml) {
        ensureWorkspaceSession(data.session_id, { snapshotHtml: pending.snapshotHtml });
      }
    }
    ensureWorkspaceSession(data.session_id, {
      cwd: cwdInput.value.trim() || '',
      model: modelSelect.value || '',
      cli: document.getElementById('cli-select')?.value || '',
      status: 'running',
      runId: currentRunId || '',
    });
    activeWorkspaceSessionId = data.session_id;
    renderTopbarMeta();
    loadSessions();
  });

  eventSource.addEventListener('cwd_changed', (e) => {
    const data = JSON.parse(e.data);
    if (!isEventForCurrentSession(data)) return;
    if (data.cwd) {
      cwdInput.value = data.cwd;
      updateRuntimeSummary();
      slashCommands = [];
      closeSlashCommandPanel();
      loadSessions();
      if (data.session_id) {
        updateWorkspaceSessionStatus(data.session_id, 'idle');
      }
      if (!isViewer) {
        addSystemMsg(t('cwdChanged', { path: data.cwd }));
      }
    }
  });

  eventSource.addEventListener('model_changed', (e) => {
    const data = JSON.parse(e.data);
    if (!isEventForCurrentSession(data)) return;
    const modelLabel = getDisplayModelName(data.model || '');
    renderTopbarMeta(data.model || '');
    if (data.session_id) {
      const session = ensureWorkspaceSession(data.session_id, { model: data.model || '', status: 'idle' });
      if (session && data.model) session.model = data.model;
    }
    if (data.model && modelSelect) { modelSelect.value = data.model; }
    renderModelPill();
    renderWelcomeRuntime();
    if (modelLabel) addSystemMsg(t('modelChanged', { model: modelLabel }));
  });

  eventSource.addEventListener('result', (e) => {
    const data = JSON.parse(e.data);
    if (noteBackgroundSessionEvent(data)) return;
    handleResult(data);
  });

  eventSource.addEventListener('tool_result', (e) => {
    const data = JSON.parse(e.data);
    if (noteBackgroundSessionEvent(data)) return;
    // 存结果，更新工具卡片
    if (data.results) {
      for (const r of data.results) {
        toolResults.set(r.tool_use_id, r);
        updateToolResult(r.tool_use_id, r.content, r.is_error);
      }
      updateWorkspaceSessionStatus(currentSessionId, 'running', t('streamingReply'));
    }
    finishTasks(data.results ? data.results.map(r => r.tool_use_id) : []);
  });

  eventSource.addEventListener('session_lock_changed', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (data.session_id && currentSessionId && data.session_id !== currentSessionId) return;
    const wasResponding = isResponding;
    isResponding = !!data.locked;
    if (!isResponding && wasResponding) {
      finishCurrentTurnFromProcess();
      scheduleCompletionHistorySync(data.session_id || currentSessionId);
    }
    updateUI();
  });

  eventSource.addEventListener('process_ended', (e) => {
    // ccb 进程结束 —— 确保前端退出 responding 状态；即使锁事件已先到达，也要补齐清理/通知。
    const data = JSON.parse(e.data || '{}');
    if (noteBackgroundSessionEvent(data)) return;
    const finishedTurn = finishCurrentTurnFromProcess();
    updateWorkspaceSessionStatus(data.session_id || currentSessionId, Number(data.exit_code || 0) === 0 ? 'done' : 'error');
    if (isSlashCommand(finishedTurn.prompt) && !finishedTurn.hadAssistantOutput) {
      const command = getSlashCommandName(finishedTurn.prompt);
      if (Number(data.exit_code || 0) === 0) {
        addSystemMsg(t('commandCompleted', { command }));
      } else {
        addSystemMsg(t('commandEnded', { command }), true);
      }
    }
    scheduleCompletionHistorySync(data.session_id || currentSessionId);
    currentRunId = null;
  });

  eventSource.addEventListener('generation_interrupted', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (!isEventForCurrentSession(data)) return;
    const hadAssistantOutput = currentTurnHasAssistantOutput;
    isResponding = false;
    if (currentAssistantEl) currentAssistantEl.classList.remove('streaming');
    currentTurnContent = '';
    currentTurnHasAssistantOutput = false;
    stopTurnTimer();
    removePendingAssistantBubble(hadAssistantOutput);
    currentAssistantEl = null;
    currentAssistantMessageId = null;
    currentRunId = null;
    updateWorkspaceSessionStatus(data.session_id || currentSessionId, 'idle');
    clearRunningTasks({ keepFinished: true });
    clearSubagentBubbles();
    updateUI();
    addSystemMsg(t('interrupted'));
  });

  eventSource.addEventListener('scheduled_task_started', () => {
    loadScheduledTasks();
  });

  eventSource.addEventListener('scheduled_task_updated', () => {
    loadScheduledTasks();
  });

  eventSource.addEventListener('scheduled_task_finished', () => {
    loadScheduledTasks();
    loadSessions();
  });

  eventSource.addEventListener('scheduled_task_error', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (data.message) showToast(data.message, 'error');
    loadScheduledTasks();
  });

  eventSource.addEventListener('error', (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      if (noteBackgroundSessionEvent(data)) return;
      addSystemMsg(data.message || t('unknownError'), true);
      // 收到错误事件也要退出 responding 状态
      isResponding = false;
      if (currentAssistantEl) currentAssistantEl.classList.remove('streaming');
      currentTurnContent = '';
      currentTurnHasAssistantOutput = false;
      stopTurnTimer();
      removePendingAssistantBubble(false);
      currentAssistantEl = null;
      currentAssistantMessageId = null;
      currentRunId = null;
      updateWorkspaceSessionStatus(data.session_id || currentSessionId, 'error');
      updateUI();
      notifyComplete('process');
    }
    if (eventSource.readyState === EventSource.CLOSED) {
      setConnectionStatus(false);
      setTimeout(initSSE, 3000);
    }
  });

  eventSource.onerror = () => {
    setConnectionStatus(false);
    if (isResponding) {
      stopTurnTimer();
      addSystemMsg(t('connectionLost'), true);
    }
  };
}

function setConnectionStatus(connected) {
  connectionOnline = connected;
  const dot = connectionStatus.querySelector('.status-dot');
  dot.className = `status-dot ${connected ? 'online' : 'offline'}`;
  updateConnectionText();
  renderTopbarStatusSummary();
  if (btnNewSession) btnNewSession.style.opacity = connected ? '1' : '0.5';
}

function updateConnectionText() {
  const text = connectionStatus.querySelector('.status-text');
  if (text) text.textContent = connectionOnline ? t('connected') : t('connecting');
}

// ─── 发送 action ────────────────────────────────────────────
async function sendAction(action, extra = {}) {
  try {
    const resp = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, action, ...extra }),
    });
    return await resp.json();
  } catch (e) {
    addSystemMsg(t('requestFailed', { message: e.message }), true);
    return null;
  }
}

// ─── 流式事件处理 ────────────────────────────────────────────
function handleStreamEvent(data) {
  const evt = data.event;
  if (!evt) return;

  isResponding = true;
  currentTurnHasAssistantOutput = true;
  updateWorkspaceSessionStatus(currentSessionId, evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' ? 'tool' : 'running', evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' ? t('tool') : t('streamingReply'));
  updateUI();

  switch (evt.type) {
    case 'message_start':
      if (!currentAssistantEl) {
        currentAssistantEl = createAssistantBubble();
        currentContent = [];
        streamBlocks = {};
        currentTurnStartedAt = Date.now();
        startTurnTimer();
      }
      break;

    case 'content_block_start': {
      const idx = evt.index;
      const blockType = evt.content_block?.type;
      streamBlocks[idx] = { type: blockType, text: '', thinking: '', input: '', name: evt.content_block?.name || '', id: evt.content_block?.id || '' };
      break;
    }

    case 'content_block_delta': {
      const block = streamBlocks[evt.index];
      if (!block) break;
      if (evt.delta?.type === 'text_delta') {
        block.text += evt.delta.text || '';
      } else if (evt.delta?.type === 'thinking_delta') {
        block.thinking += evt.delta.thinking || '';
      } else if (evt.delta?.type === 'input_json_delta') {
        block.input += evt.delta.partial_json || '';
      }
      scheduleRender();
      break;
    }

    case 'content_block_stop': {
      const finishedBlock = streamBlocks[evt.index];
      if (finishedBlock) {
        if (finishedBlock.type === 'thinking') {
          currentContent.push({ type: 'thinking', thinking: finishedBlock.thinking });
        } else if (finishedBlock.type === 'text') {
          currentContent.push({ type: 'text', text: finishedBlock.text });
        } else if (finishedBlock.type === 'tool_use') {
          let input = finishedBlock.input;
          try { input = JSON.parse(input); } catch(e) {}
          const toolBlock = { type: 'tool_use', name: finishedBlock.name, id: finishedBlock.id, input };
          currentContent.push(toolBlock);
          registerTaskBlocks([toolBlock]);
        }
        delete streamBlocks[evt.index];
      }
      scheduleRender();
      break;
    }
  }
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderCurrentState();
    scrollToBottom();
  });
}

function renderCurrentState(final = false) {
  if (!currentAssistantEl) return;
  const el = currentAssistantEl.querySelector('.msg-content');
  let html = '';

  for (const block of currentContent) {
    if (!final && isResponding && block.type === 'text' && block.text) {
      html += `<div class="text-block">${renderStreamingText(block.text)}</div>`;
    } else {
      html += renderBlock(block);
    }
  }

  for (const idx of Object.keys(streamBlocks).sort((a,b) => a-b)) {
    const block = streamBlocks[idx];
    if (block.type === 'thinking' && block.thinking) {
      html += renderBlock({ type: 'thinking', thinking: block.thinking });
    } else if (block.type === 'text' && block.text) {
      html += `<div class="text-block">${renderStreamingText(block.text)}<span class="typing-cursor"></span></div>`;
    } else if (block.type === 'tool_use') {
      html += renderToolCard(block);
    }
  }

  if (isResponding && !Object.values(streamBlocks).some(b => b.type === 'text') && currentContent.length === 0 && Object.keys(streamBlocks).length === 0) {
    html += '<span class="stream-placeholder">正在接收回复<span class="typing-cursor"></span></span>';
  }

  el.innerHTML = html;
}

function formatToolSummary(block) {
  let input = {};
  try {
    input = typeof block.input === 'string' ? JSON.parse(block.input) : (block.input || {});
  } catch (e) {}

  const name = block.name || '';
  switch (name) {
    case 'Read':
      return { icon: '📄', label: 'Read', summary: (input.file_path || '').split('/').pop() + (input.offset ? ` L${input.offset}-${input.offset + (input.limit || 0)}` : '') };
    case 'Write':
      return { icon: '✏', label: 'Write', summary: (input.file_path || '').split('/').pop() };
    case 'Edit': {
      const oldStr = (input.old_string || '').substring(0, 40);
      return { icon: '✏', label: 'Edit', summary: (input.file_path || '').split('/').pop() + (oldStr ? ` · "${oldStr}..."` : '') };
    }
    case 'Bash':
      return { icon: '>$', label: 'Bash', summary: (input.command || '').substring(0, 80) };
    case 'Grep':
      return { icon: '🔍', label: 'Grep', summary: `"${(input.pattern || '').substring(0, 40)}"` + (input.path ? ` in ${input.path}` : '') };
    case 'Glob':
      return { icon: '📁', label: 'Glob', summary: (input.pattern || '') };
    case 'Task':
      return { icon: '🤖', label: 'Task', summary: (input.description || input.subagent_type || '').substring(0, 60) };
    case 'TodoWrite':
      return { icon: '☑', label: 'TodoWrite', summary: (input.todos || []).length + ' items' };
    default: {
      const keys = Object.keys(input);
      const firstKV = keys.length > 0 ? `${keys[0]}: ${String(input[keys[0]]).substring(0, 50)}` : '';
      return { icon: '⚙', label: name || 'Tool', summary: firstKV };
    }
  }
}

function formatToolBody(block) {
  let input = {};
  try {
    input = typeof block.input === 'string' ? JSON.parse(block.input) : (block.input || {});
  } catch (e) {}

  const name = block.name || '';
  const rows = [];

  function row(label, value) {
    if (value === undefined || value === null || value === '') return;
    rows.push(`<div class="tb-row"><span class="tb-label">${esc(label)}</span><span class="tb-value">${esc(String(value))}</span></div>`);
  }
  function codeBlock(value) {
    if (!value) return;
    rows.push(`<pre class="tb-code">${esc(String(value))}</pre>`);
  }

  switch (name) {
    case 'Read':
      row('File', input.file_path);
      if (input.offset != null) {
        const end = input.limit ? input.offset + input.limit : input.offset;
        row('Lines', `${input.offset} — ${end}${input.limit ? ` (${input.limit} lines)` : ''}`);
      } else if (input.limit) {
        row('Lines', `${input.limit} lines`);
      }
      break;
    case 'Write':
      row('File', input.file_path);
      codeBlock(input.content);
      break;
    case 'Edit':
      row('File', input.file_path);
      if (input.old_string) {
        rows.push(`<div class="tb-label">Replace</div>`);
        codeBlock(input.old_string);
      }
      if (input.new_string) {
        rows.push(`<div class="tb-label">With</div>`);
        codeBlock(input.new_string);
      }
      break;
    case 'Bash':
      row('Description', input.description);
      codeBlock(input.command);
      break;
    case 'Grep':
      row('Pattern', input.pattern);
      row('Path', input.path);
      row('Glob', input.glob);
      if (input.type) row('Type', input.type);
      if (input.output_mode) row('Output', input.output_mode);
      break;
    case 'Glob':
      row('Pattern', input.pattern);
      row('Path', input.path);
      break;
    case 'Task':
      row('Subagent', input.subagent_type);
      row('Description', input.description);
      if (input.prompt) {
        rows.push(`<div class="tb-label">Prompt</div>`);
        codeBlock(input.prompt);
      }
      break;
    case 'TodoWrite': {
      const todos = input.todos || input.newTodos || [];
      if (todos.length > 0) {
        rows.push(`<div class="tb-label">Todos (${todos.length})</div>`);
        for (const t of todos) {
          const isDone = t.status === 'completed' || t.completed === true;
          const status = isDone ? '✓' : '○';
          const cls = isDone ? 'tb-todo-done' : 'tb-todo-pending';
          rows.push(`<div class="tb-row ${cls}"><span class="tb-todo-mark">${status}</span><span class="tb-value">${esc(String(t.content || t.name || t.task || ''))}</span></div>`);
        }
      }
      break;
    }
    case 'Agent':
    case 'Skill':
    case 'ToolSearch':
    default: {
      const keys = Object.keys(input);
      if (keys.length > 0) {
        for (const k of keys) {
          const v = input[k];
          if (typeof v === 'string' && v.length > 200) {
            row(k, v.substring(0, 200) + '…');
          } else if (typeof v === 'object') {
            row(k, JSON.stringify(v));
          } else {
            row(k, v);
          }
        }
      } else {
        rows.push(`<div class="tb-row tb-empty">(no input)</div>`);
      }
    }
  }

  return rows.length > 0 ? rows.join('') : `<div class="tb-row tb-empty">(no input)</div>`;
}

function renderToolCard(block, opts = {}) {
  const info = formatToolSummary(block);
  const bodyHtml = formatToolBody(block);
  const isHistory = !!opts.history;
  const isRunning = !isHistory && (opts.isRunning || false);
  if (!isHistory && block.id && !toolStartTimes.has(block.id) && !toolResults.has(block.id)) {
    toolStartTimes.set(block.id, Date.now());
  }
  const runningBadge = isRunning
    ? `<span class="tool-running-badge"><span class="agent-spinner"></span>${esc(t('running'))}</span>`
    : '';
  const hasResult = block.id && toolResults.has(block.id);
  const result = hasResult ? toolResults.get(block.id) : null;
  const resultBadge = hasResult
    ? `<span class="tool-status ${result.is_error ? 'tool-error' : 'tool-ok'}">${result.is_error ? '✗' : '✓'}</span>`
    : '';
  const resultHtml = hasResult
    ? `<div class="tool-result${result.is_error ? ' tool-result-error' : ''}">${esc(result.content)}</div>`
    : '';
  const cls = ['tool-card'];
  if (isRunning) cls.push('tool-card-running');
  cls.push('collapsed');

  return `<div class="${cls.join(' ')}" data-tool-id="${esc(block.id || '')}">
    <div class="tool-header tool-toggle" role="button" tabindex="0">
      <span class="tool-arrow">&#9654;</span>
      <span class="tool-icon">${info.icon}</span>
      <span class="tool-label">${esc(info.label)}</span>
      <span class="tool-summary">${esc(info.summary)}</span>
      ${runningBadge}${resultBadge}
    </div>
    <div class="tool-body">${bodyHtml}</div>
    ${resultHtml}
  </div>`;
}

function updateToolResult(toolId, content, isError) {
  const card = document.querySelector(`.tool-card[data-tool-id="${toolId}"]`);
  if (!card) return;
  card.classList.remove('tool-card-running');
  // 计算耗时
  const startTime = toolStartTimes.get(toolId);
  let durationStr = '';
  if (startTime) {
    const elapsed = (Date.now() - startTime) / 1000;
    durationStr = elapsed >= 1 ? `${elapsed.toFixed(1)}s` : `${Math.round(elapsed * 1000)}ms`;
    toolStartTimes.delete(toolId);
  }
  // 添加状态+耗时标记
  const header = card.querySelector('.tool-header');
  if (header) {
    // 移除运行中标记
    const runningBadge = header.querySelector('.tool-running-badge');
    if (runningBadge) runningBadge.remove();
    // 添加完成状态
    const existing = header.querySelector('.tool-status');
    if (!existing) {
      const badge = document.createElement('span');
      badge.className = `tool-status ${isError ? 'tool-error' : 'tool-ok'}`;
      badge.textContent = isError ? '✗' : '✓';
      header.appendChild(badge);
    }
    // 显示耗时
    const dur = header.querySelector('.tool-duration');
    if (!dur && durationStr) {
      const durSpan = document.createElement('span');
      durSpan.className = 'tool-duration';
      durSpan.textContent = durationStr;
      header.appendChild(durSpan);
    }
  }
  // 添加结果内容
  const existingResult = card.querySelector('.tool-result');
  if (!existingResult) {
    const resultDiv = document.createElement('div');
    resultDiv.className = `tool-result${isError ? ' tool-result-error' : ''}`;
    resultDiv.textContent = content;
    card.appendChild(resultDiv);
  }
}

function renderStreamingText(text) {
  return esc(text).replace(/\n/g, '<br>');
}

function renderBlock(block) {
  if (block.type === 'thinking' && block.thinking) {
    const preview = block.thinking.replace(/\n/g, ' ').substring(0, 100);
    return `<div class="thinking-block">
      <div class="thinking-header" onclick="this.parentElement.classList.toggle('open')">
        <span class="thinking-arrow">&#9654;</span>
        <span class="thinking-label">${esc(t('thinking'))}</span>
        <span class="thinking-preview">${esc(preview)}</span>
      </div>
      <div class="thinking-content">${esc(block.thinking)}</div>
    </div>`;
  } else if (block.type === 'text' && block.text) {
    return `<div class="text-block">${renderMd(block.text)}</div>`;
  } else if (block.type === 'tool_use') {
    const isRunningTask = block.name === 'Task' && block.id && runningTasks.has(block.id);
    return renderToolCard(block, { isRunning: isRunningTask });
  }
  return '';
}

function handleAssistantFinal(data) {
  // subagent 的 assistant 消息带 parent_tool_use_id
  if (data.parent_tool_use_id) {
    updateTaskActivity(data.parent_tool_use_id, data.message);
    renderSubagentBubble(data.parent_tool_use_id, data.message);
    return;
  }

  // ccb 的 assistant 事件在工具调用回合里可能按 block 拆成多条同 message.id 事件。
  isResponding = true;
  currentTurnHasAssistantOutput = true;
  updateUI();

  const message = data.message;
  if (!message || !message.content) return;

  const messageId = message.id || data.uuid || '';
  if (!currentAssistantEl || (currentAssistantMessageId && messageId && currentAssistantMessageId !== messageId)) {
    currentAssistantEl = createAssistantBubble();
    currentContent = [];
    streamBlocks = {};
  }
  currentAssistantMessageId = messageId || currentAssistantMessageId;

  for (const block of message.content) {
    if (block.type === 'thinking' && block.thinking) {
      upsertCurrentBlock({ type: 'thinking', thinking: block.thinking }, (existing) => existing.type === 'thinking');
    } else if (block.type === 'text' && block.text) {
      upsertCurrentBlock({ type: 'text', text: block.text }, (existing) => existing.type === 'text');
    } else if (block.type === 'tool_use') {
      upsertCurrentBlock(
        { type: 'tool_use', name: block.name, id: block.id, input: block.input },
        (existing) => existing.type === 'tool_use' && existing.id && existing.id === block.id
      );
    }
  }
  registerTaskBlocks(currentContent);

  streamBlocks = {};
  renderCurrentState(true);
  scrollToBottom();
}

function upsertCurrentBlock(nextBlock, matcher) {
  const index = currentContent.findIndex(matcher);
  if (index >= 0) {
    currentContent[index] = { ...currentContent[index], ...nextBlock };
  } else {
    currentContent.push(nextBlock);
  }
}

// ─── Subagent 运行状态跟踪 ───────────────────────────────────
// tool_use_id -> {type, desc, last}
const runningTasks = new Map();
const toolResults = new Map();
const toolStartTimes = new Map();
// 已结束的 Task id（partial assistant 事件会重复携带同一 tool_use 块，避免重新标记为运行中）
const finishedTaskIds = new Set();

function registerTaskBlocks(content) {
  let changed = false;
  for (const block of content) {
    if (block.type !== 'tool_use' || block.name !== 'Task' || !block.id) continue;
    if (finishedTaskIds.has(block.id)) continue;
    let input = block.input;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch (e) { input = {}; } }
    if (!input || typeof input !== 'object') input = {};
    const existing = runningTasks.get(block.id) || {};
    runningTasks.set(block.id, {
      type: input.subagent_type || existing.type || '',
      desc: input.description || existing.desc || '',
      last: existing.last || '',
    });
    changed = true;
  }
  if (changed) renderAgentStatus();
}

function updateTaskActivity(parentToolUseId, message) {
  if (!parentToolUseId || finishedTaskIds.has(parentToolUseId)) return;
  // 会话恢复到一半时可能没见过对应 Task 块，此处兜底注册
  const entry = runningTasks.get(parentToolUseId) || { type: '', desc: '', last: '' };
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        entry.last = block.text.replace(/\s+/g, ' ').trim().slice(-60);
      } else if (block.type === 'tool_use' && block.name) {
        entry.last = `> ${block.name}`;
      }
    }
  }
  runningTasks.set(parentToolUseId, entry);
  renderAgentStatus();
}

function finishTasks(ids) {
  let changed = false;
  let completedTask = null;
  for (const id of ids || []) {
    const taskInfo = runningTasks.get(id);
    if (taskInfo && !completedTask) completedTask = taskInfo;
    finishedTaskIds.add(id);
    if (runningTasks.delete(id)) changed = true;
  }
  if (changed) {
    notifyComplete('subagent', {
      agent: completedTask?.type || t('subagent'),
      task: completedTask?.last || completedTask?.desc || '',
      model: getDisplayModelName(modelSelect.value),
    });
    renderAgentStatus();
    if (currentAssistantEl) scheduleRender();
  }
}

function clearRunningTasks({ keepFinished = false } = {}) {
  if (runningTasks.size) {
    runningTasks.clear();
    renderAgentStatus();
  }
  if (!keepFinished) finishedTaskIds.clear();
}

function renderAgentStatus() {
  const bar = document.getElementById('agent-status-bar');
  if (!bar) return;
  if (runningTasks.size === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = '';
  let html = `<span class="agent-status-title">${esc(t('agentsRunning', { count: runningTasks.size }))}</span>`;
  for (const [id, info] of runningTasks) {
    const label = info.type || t('subagent');
    const detail = info.last || info.desc || '';
    html += `<span class="agent-chip" title="${esc(info.desc || '')}">` +
      `<span class="agent-spinner"></span>${esc(label)}` +
      `${detail ? `<span class="agent-chip-detail">${esc(detail.substring(0, 40))}</span>` : ''}` +
      `</span>`;
  }
  bar.innerHTML = html;
}

// ─── Subagent 行内消息渲染 ────────────────────────────────────────
// parent_tool_use_id -> DOM element
const subagentBubbles = new Map();
const SUBAGENT_COLORS = ['#c792ea', '#82aaff', '#c3e88d', '#ffcb6b', '#f78c6c', '#89ddff'];

function getSubagentColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i);
  return SUBAGENT_COLORS[Math.abs(hash) % SUBAGENT_COLORS.length];
}

function renderSubagentBubble(parentToolUseId, message) {
  if (!currentAssistantEl && !isResponding) return;
  const taskInfo = runningTasks.get(parentToolUseId);
  const agentName = taskInfo?.type || t('subagent');
  const desc = taskInfo?.desc || '';
  const color = getSubagentColor(parentToolUseId);

  let el = subagentBubbles.get(parentToolUseId);
  if (!el) {
    el = document.createElement('div');
    el.className = 'subagent-bubble';
    el.style.borderLeftColor = color;
    const container = currentAssistantEl || document.querySelector('#chat-messages .assistant:last-child');
    if (container) {
      container.after(el);
    } else {
      document.getElementById('chat-messages')?.appendChild(el);
    }
    subagentBubbles.set(parentToolUseId, el);
  }

  const content = message?.content;
  if (!Array.isArray(content)) return;

  let textParts = [];
  let toolParts = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolParts.push(block.name || 'tool');
    }
  }

  const text = textParts.join('\n\n');
  const toolInfo = toolParts.length ? `<span class="subagent-tools">${toolParts.map(t => esc(t)).join(', ')}</span>` : '';

  el.innerHTML = `
    <div class="subagent-head">
      <span class="subagent-dot" style="background:${color}"></span>
      <span class="subagent-name">${esc(agentName)}</span>
      ${desc ? `<span class="subagent-desc">${esc(desc)}</span>` : ''}
      ${toolInfo}
    </div>
    <div class="subagent-body">${text ? renderMd(text) : ''}</div>
  `;

  scrollToBottom();
}

// 清理 subagent 气泡
function clearSubagentBubbles() {
  subagentBubbles.forEach(el => el.remove());
  subagentBubbles.clear();
}

function finalizeCurrentAssistantMarkdown() {
  if (!currentAssistantEl) return;
  const finishedToolBlocks = [];
  for (const idx of Object.keys(streamBlocks).sort((a,b) => a-b)) {
    const block = streamBlocks[idx];
    if (!block) continue;
    if (block.type === 'thinking' && block.thinking) {
      currentContent.push({ type: 'thinking', thinking: block.thinking });
    } else if (block.type === 'text' && block.text) {
      currentContent.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      let input = block.input;
      try { input = JSON.parse(input); } catch(e) {}
      const toolBlock = { type: 'tool_use', name: block.name, id: block.id, input };
      currentContent.push(toolBlock);
      finishedToolBlocks.push(toolBlock);
    }
  }
  if (finishedToolBlocks.length) registerTaskBlocks(finishedToolBlocks);
  streamBlocks = {};
  renderCurrentState(true);
}

function finishCurrentTurnFromProcess() {
  const finishedTurn = currentTurnContent;
  const hadAssistantOutput = currentTurnHasAssistantOutput;
  const durationMs = currentTurnStartedAt ? Date.now() - currentTurnStartedAt : 0;
  const assistantEl = currentAssistantEl;
  clearRunningTasks({ keepFinished: true });
  clearSubagentBubbles();
  stopTurnTimer();
  if (assistantEl) {
    finalizeCurrentAssistantMarkdown();
    updateAssistantMeta('done', durationMs);
    assistantEl.classList.remove('streaming');
  }
  isResponding = false;
  removePendingAssistantBubble(hadAssistantOutput);
  currentAssistantEl = null;
  currentAssistantMessageId = null;
  currentContent = [];
  streamBlocks = {};
  currentTurnContent = '';
  currentTurnHasAssistantOutput = false;
  currentTurnStartedAt = 0;
  currentTurnAttachmentCount = 0;
  if (finishedTurn || hadAssistantOutput || assistantEl) {
    notifyComplete('process', {
      prompt: finishedTurn,
      durationMs,
      model: getDisplayModelName(modelSelect.value),
    });
  }
  if (assistantEl && hadAssistantOutput) checkMemoryHits(assistantEl, finishedTurn);
  updateUI();
  return { prompt: finishedTurn, hadAssistantOutput, durationMs };
}

function clearCompletionHistorySync() {
  if (!completionHistorySyncTimer) return;
  clearTimeout(completionHistorySyncTimer);
  completionHistorySyncTimer = null;
}

function scheduleCompletionHistorySync(sessionId) {
  if (!sessionId) return;
  clearCompletionHistorySync();
  completionHistorySyncTimer = setTimeout(() => {
    completionHistorySyncTimer = null;
    if (sessionId === currentSessionId && !isResponding) {
      reloadSessionHistory(sessionId, cwdInput.value.trim() || '');
    }
  }, 600);
}

function handleResult(data) {
  clearCompletionHistorySync();
  const finishedTurn = currentTurnContent;
  const hadAssistantOutput = currentTurnHasAssistantOutput;
  const durationMs = Date.now() - currentTurnStartedAt;
  const turnCost = Number(data.total_cost_usd || 0);
  const persistedCost = Number(data.session_total_cost_usd || 0);
  const turnTokens = normalizeTokenUsage(data.turn_tokens || data.usage || data);
  const persistedTokens = normalizeTokenUsage(data.session_total_tokens);
  stopTurnTimer();
  if (currentAssistantEl) finalizeCurrentAssistantMarkdown();
  updateAssistantMeta('done', durationMs);
  removePendingAssistantBubble(hadAssistantOutput);
  const assistantEl = currentAssistantEl;
  isResponding = false;
  currentAssistantEl = null;
  currentAssistantMessageId = null;
  currentContent = [];
  streamBlocks = {};
  clearRunningTasks();
  clearSubagentBubbles();
  notifyComplete('turn', {
    prompt: finishedTurn,
    durationMs,
    costUsd: turnCost,
    model: getDisplayModelName(data.model || modelSelect.value),
  });
  if (assistantEl && hadAssistantOutput) checkMemoryHits(assistantEl, finishedTurn);
  currentTurnContent = '';
  currentTurnHasAssistantOutput = false;
  currentTurnStartedAt = 0;
  currentTurnAttachmentCount = 0;
  updateUI();

  if (Number.isFinite(persistedCost) && persistedCost > 0) {
    totalCost = persistedCost;
    renderCost();
  } else if (Number.isFinite(turnCost) && turnCost > 0) {
    totalCost += turnCost;
    renderCost();
  }

  if (hasTokenUsage(persistedTokens)) {
    totalTokens = persistedTokens;
    renderTokens();
  } else if (hasTokenUsage(turnTokens)) {
    totalTokens = addTokenUsage(totalTokens, turnTokens);
    renderTokens();
  }

  if (currentSessionId) {
    const session = ensureWorkspaceSession(currentSessionId, {
      cost: totalCost,
      tokens: totalTokens,
      status: data.is_error ? 'error' : 'done',
      snapshotHtml: sanitizeWorkspaceSnapshotHtml(messagesEl.innerHTML),
    });
    if (session) {
      session.cost = totalCost;
      session.tokens = totalTokens;
      session.snapshotHtml = sanitizeWorkspaceSnapshotHtml(messagesEl.innerHTML);
    }
  }

  if (data.is_error && data.errors) {
    data.errors.forEach(e => addSystemMsg(e, true));
  } else if (isSlashCommand(finishedTurn) && !hadAssistantOutput) {
    addSystemMsg(t('commandCompleted', { command: getSlashCommandName(finishedTurn) }));
  }
}

// ─── UI 组件 ─────────────────────────────────────────────────
function createAssistantBubble(streaming = true) {
  const el = document.createElement('div');
  el.className = streaming ? 'message assistant streaming' : 'message assistant';
  el.innerHTML = `
    <div class="avatar assistant-avatar">C</div>
    <div class="msg-bubble">
      <div class="stream-status"><span class="stream-dot"></span><span>${esc(t('streamingReply'))}</span></div>
      <div class="msg-content"></div>
      <div class="msg-meta"></div>
      <button class="msg-quote-btn" type="button" title="${esc(t('quoteMessage'))}" aria-label="${esc(t('quoteMessage'))}">${esc(t('quoteMessage'))}</button>
    </div>
  `;
  messagesEl.appendChild(el);
  return el;
}

function finishAssistantStreaming() {
  if (currentAssistantEl) currentAssistantEl.classList.remove('streaming');
}

function removePendingAssistantBubble(keepBubble) {
  finishAssistantStreaming();
  if (!keepBubble && currentAssistantEl && !currentAssistantEl.querySelector('.msg-content')?.textContent.trim()) {
    currentAssistantEl.remove();
  }
}

function addUserMessage(text, quotes = []) {
  const el = document.createElement('div');
  el.className = 'message user';
  const quoteHtml = quotes.length ? `
    <div class="msg-quoted-list">
      ${quotes.map(q => `<div class="msg-quoted-item">${esc(quoteDisplayText(q))}</div>`).join('')}
    </div>
  ` : '';
  el.innerHTML = `
    <div class="avatar user-avatar">U</div>
    <div class="msg-bubble">
      <div class="msg-content">${quoteHtml}${esc(text)}</div>
      <button class="msg-quote-btn" type="button" title="${esc(t('quoteMessage'))}" aria-label="${esc(t('quoteMessage'))}">${esc(t('quoteMessage'))}</button>
    </div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addSystemMsg(text, isError) {
  const el = document.createElement('div');
  el.className = `system-msg${isError ? ' error' : ''}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

// ─── Toast 通知 ─────────────────────────────────────────────────
const toastContainer = document.getElementById('toast-container');
let toastTimer = null;

function showToast(msg, type = 'info', duration = 3000) {
  const icon = { success: '✓', error: '✗', warning: '!', info: 'i' }[type] || 'i';
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${msg}</span><button class="toast-close">&times;</button>`;
  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  toast.addEventListener('mouseenter', () => { if (toast._timer) clearTimeout(toast._timer); });
  toast.addEventListener('mouseleave', () => { toast._timer = setTimeout(() => dismissToast(toast), 2000); });
  toastContainer.appendChild(toast);
  toast._timer = setTimeout(() => dismissToast(toast), duration);
  // 最多保留 5 条，旧的自上而下消失
  while (toastContainer.children.length > 5) {
    dismissToast(toastContainer.firstElementChild);
  }
}

function dismissToast(toast) {
  if (toast._dismissing) return;
  toast._dismissing = true;
  if (toast._timer) { clearTimeout(toast._timer); toast._timer = null; }
  toast.classList.add('dismissing');
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 200);
}

// ─── 输入 ────────────────────────────────────────────────────
const btnAttach = document.getElementById('btn-attach');
const fileInput = document.getElementById('file-input');
const attachmentsBar = document.getElementById('attachments-bar');
const modelPill = document.getElementById('model-pill');
const modelPillPopover = document.getElementById('model-pill-popover');
const inputCliStatus = document.getElementById('input-cli-status');
const inputCwdStatus = document.getElementById('input-cwd-status');
const quotePreviewBar = document.getElementById('quote-preview-bar');
const slashCommandPanel = document.getElementById('slash-command-panel');
const inputWrapper = document.querySelector('.input-wrapper');
let attachedFiles = []; // [{name, path, isImage, uploaded}]
let slashCommands = [];
let slashCommandMatches = [];
let slashCommandIndex = 0;
let slashCommandLoadTimer = null;
let inputDragDepth = 0;

function initInput() {
  inputEl.addEventListener('keydown', (e) => {
    if (handleSlashCommandKeydown(e)) return;
    // 提及弹窗打开时不发送
    if (mentionPopup && mentionPopup.style.display === 'block') return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    const query = getSlashQuery();
    if (query !== null && !slashCommands.length) {
      slashCommandPanel.innerHTML = `<div class="slash-command-empty">${esc(t('loading'))}</div>`;
      slashCommandPanel.style.display = 'block';
      ensureSlashCommandsLoaded();
      return;
    }
    updateSlashCommandPanel();
  });

  // 粘贴图片
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
  topbarSessionId?.addEventListener('click', copyResumeCommand);
  sessionSearchInput?.addEventListener('input', () => renderSessionList(cachedSessions));
  document.addEventListener('keydown', handleGlobalShortcuts);
  document.getElementById('welcome-new-session')?.addEventListener('click', startNewSession);
  modelSelect.addEventListener('change', () => {
    renderTopbarMeta();
    renderModelPill();
    renderWelcomeRuntime();
    slashCommands = [];
    closeSlashCommandPanel();
    // 记住选择，刷新后恢复
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
      if (newCwd) {
        await updateSessionCwd(currentSessionId, newCwd);
        // SSE cwd_changed 事件会更新 UI（cwdInput.value、loadSessions、addSystemMsg）
      }
    }
  });

  // 附件按钮 —— 打开自定义文件选择器
  btnAttach.addEventListener('click', () => openFilePicker());
  fileInput.addEventListener('change', () => {
    uploadFiles(fileInput.files);
    fileInput.value = '';
    if (filePickerOverlay?.style.display === 'flex') closeFilePicker();
  });
  initInputFileDrop();

  document.addEventListener('click', (e) => {
    if (!slashCommandPanel.contains(e.target) && e.target !== inputEl) {
      closeSlashCommandPanel();
    }
  });
}

async function copyConversationMarkdown() {
  const markdown = buildConversationMarkdown();
  if (!markdown) {
    addSystemMsg(t('nothingToExport'), true);
    return;
  }
  try {
    await navigator.clipboard.writeText(markdown);
    addSystemMsg(t('markdownCopied'));
  } catch (e) {
    addSystemMsg(t('copyFailed'), true);
  }
}

function buildConversationMarkdown() {
  const lines = [];
  messagesEl.querySelectorAll('.message, .system-msg').forEach(el => {
    if (el.classList.contains('user')) {
      lines.push(`## User\n\n${domText(el)}`);
    } else if (el.classList.contains('assistant')) {
      lines.push(`## Assistant\n\n${domText(el)}`);
    } else if (el.classList.contains('system-msg')) {
      lines.push(`> ${domText(el).replace(/\n/g, '\n> ')}`);
    }
  });
  return lines.filter(Boolean).join('\n\n');
}

function domText(el) {
  return (el.querySelector('.msg-content') || el).textContent.trim();
}

// ─── 消息引用 ────────────────────────────────────────────────
function hideMsgContextMenu() {
  const menu = document.getElementById('msg-context-menu');
  if (menu) { menu.style.display = 'none'; menu.style.visibility = 'hidden'; }
}

function normalizeQuoteEntry(entry) {
  if (entry && typeof entry === 'object') {
    return {
      type: entry.type || 'text',
      text: String(entry.text || entry.display || '').trim(),
      path: entry.path || '',
      lines: Array.isArray(entry.lines) ? entry.lines.map(n => Number(n)).filter(Boolean) : [],
    };
  }
  return { type: 'text', text: String(entry || '').trim(), path: '', lines: [] };
}

function quoteDisplayText(entry) {
  const quote = normalizeQuoteEntry(entry);
  return quote.text;
}

function quoteIntoInput(text, meta = null) {
  const normalized = (text || '').trim();
  if (!normalized) return;
  quotedMessages.push(normalizeQuoteEntry({ ...(meta || {}), text: normalized }));
  showPage('chat');
  requestAnimationFrame(() => {
    renderQuotePreview();
    quotePreviewBar?.scrollIntoView({ block: 'nearest' });
    inputEl.focus();
  });
}

function renderQuotePreview() {
  if (!quotePreviewBar) return;
  if (quotedMessages.length === 0) {
    quotePreviewBar.style.display = 'none';
    quotePreviewBar.innerHTML = '';
    return;
  }
  quotePreviewBar.style.display = 'flex';
  quotePreviewBar.innerHTML = quotedMessages.map((quote, i) => `
    <div class="quote-preview-item">
      <div class="quote-preview-head">
        <span>${esc(t('quotedMessage'))}</span>
        <button class="quote-preview-remove" data-idx="${i}" title="${esc(t('removeQuote'))}" type="button">&times;</button>
      </div>
      <div class="quote-preview-text">${esc(quoteDisplayText(quote))}</div>
    </div>
  `).join('');
  quotePreviewBar.querySelectorAll('.quote-preview-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      quotedMessages.splice(parseInt(btn.dataset.idx), 1);
      renderQuotePreview();
    });
  });
}

function initMessageContextMenu() {
  const menu = document.getElementById('msg-context-menu');
  menu?.remove();

  messagesEl.addEventListener('click', (e) => {
    const quoteBtn = e.target.closest('.msg-quote-btn');
    if (!quoteBtn) return;
    const msgEl = quoteBtn.closest('.message');
    const text = domText(msgEl);
    if (text) quoteIntoInput(text);
  });
}

function interruptCurrentRun() {
  if (!isResponding || !currentSessionId) return Promise.resolve(null);
  return sendAction('interrupt', { session_id: currentSessionId, run_id: currentRunId });
}

function handleGlobalShortcuts(e) {
  if (e.key === 'Escape' && shortcutsOverlay && shortcutsOverlay.style.display !== 'none') {
    e.preventDefault();
    closeShortcutsHelp();
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === '/') {
    e.preventDefault();
    openShortcutsHelp();
  } else if (key === 'k') {
    e.preventDefault();
    sessionSearchInput?.focus();
    sessionSearchInput?.select();
  } else if (key === 'n') {
    e.preventDefault();
    startNewSession();
  } else if (key === 'enter') {
    e.preventDefault();
    sendMessage();
  } else if (key === '.') {
    e.preventDefault();
    interruptCurrentRun();
  } else if (key === 'e') {
    e.preventDefault();
    copyConversationMarkdown();
  }
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
    if (inputDragDepth === 0) {
      inputWrapper.classList.remove('drag-over');
    }
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

let slashCommandLoadPromise = null;

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
    const resp = await fetch(`/api/slash-commands?${params.toString()}`);
    const data = await resp.json();
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
  if (!value.startsWith('/') || cursor !== value.length || value.includes('\n') || /\s/.test(value)) {
    return null;
  }
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
    slashCommandPanel.style.display = 'block';
    return;
  }

  slashCommandPanel.innerHTML = slashCommandMatches.map((cmd, idx) => `
    <button type="button" class="slash-command-item${idx === slashCommandIndex ? ' active' : ''}" data-idx="${idx}">
      <span class="slash-command-name">${esc(cmd.name)}</span>
      <span class="slash-command-desc">${esc(cmd.description || '')}</span>
    </button>
  `).join('');
  slashCommandPanel.style.display = 'block';

  slashCommandPanel.querySelectorAll('.slash-command-item').forEach(btn => {
    btn.addEventListener('mouseenter', () => {
      slashCommandIndex = Number(btn.dataset.idx || 0);
      renderSlashCommandActiveState();
    });
    btn.addEventListener('click', () => {
      selectSlashCommand(Number(btn.dataset.idx || 0));
    });
  });
}

function renderSlashCommandActiveState() {
  slashCommandPanel.querySelectorAll('.slash-command-item').forEach((item, idx) => {
    item.classList.toggle('active', idx === slashCommandIndex);
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
  slashCommandPanel.style.display = 'none';
  slashCommandMatches = [];
  slashCommandIndex = 0;
}

// ─── 模型胶囊 (输入栏内模型切换) ──────────────────────────────

function renderModelPill() {
  if (!modelPill) return;
  const val = modelSelect.value;
  modelPill.textContent = getDisplayModelName(val) || 'Model';
  renderInputStatus();
  // 同步刷新弹出列表里的选项选中态
  if (modelPillPopover && modelPillPopover.style.display === 'block') {
    renderModelPillPopoverOptions();
  }
}

function renderModelPillPopoverOptions() {
  if (!modelPillPopover) return;
  const current = modelSelect.value;
  modelPillPopover.innerHTML = Array.from(modelSelect.options)
    .filter(function(o) { return o.value; })
    .map(function(o) {
      return '<button class="model-pill-option' + (o.value === current ? ' active' : '') + '" data-model="' + esc(o.value) + '">' + esc(o.textContent) + '</button>';
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
  if (modelPillPopover.style.display === 'block') { closeModelPillPopover(); return; }
  closeSlashCommandPanel();
  renderModelPillPopoverOptions();
  modelPillPopover.style.display = 'block';
  modelPill.classList.add('open');
}

function closeModelPillPopover() {
  if (!modelPillPopover) return;
  modelPillPopover.style.display = 'none';
  modelPill.classList.remove('open');
}

function initModelPill() {
  if (!modelPill) return;
  modelPill.addEventListener('click', function(e) {
    e.stopPropagation();
    openModelPillPopover();
  });
  document.addEventListener('click', function(e) {
    if (modelPillPopover && modelPillPopover.style.display === 'block' &&
        !modelPillPopover.contains(e.target) && e.target !== modelPill) {
      closeModelPillPopover();
    }
  });
  renderModelPill();
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
        attachedFiles.push({ name: file.name, path, isImage, uploaded: true, source: 'client', originalPath: file.name });
      }
      renderAttachments();
    }
  } catch (e) {
    addSystemMsg(t('uploadFailed', { message: e.message }), true);
  }
}

function renderAttachments() {
  if (attachedFiles.length === 0) {
    attachmentsBar.style.display = 'none';
    attachmentsBar.innerHTML = '';
    return;
  }
  attachmentsBar.style.display = 'flex';
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

function quotePayloadForBackend(quotes) {
  return quotes.map(normalizeQuoteEntry).filter(q => q.text || (q.path && q.lines.length));
}

function quoteBackendPayload(quotes) {
  return quotes.map(normalizeQuoteEntry).map(q => {
    if (q.type === 'file_lines' && q.path && q.lines.length) {
      return { type: 'file_lines', path: q.path, lines: q.lines };
    }
    return { type: 'text', text: q.text };
  }).filter(q => q.text || (q.path && q.lines?.length));
}

async function sendMessage() {
  let content = inputEl.value.trim();
  const quotesForThisTurn = quotePayloadForBackend(quotedMessages);
  const isLiveFollowup = isResponding;
  if ((!content && attachedFiles.length === 0 && quotesForThisTurn.length === 0) || !sessionActive) return;
  if (isViewer && !isLiveFollowup) {
    isViewer = false;
    updateUI();
  }
  const originalContent = content;
  const attachmentCount = attachedFiles.length;

  if (quotesForThisTurn.length > 0) {
    const inlineQuotes = quotesForThisTurn.filter(q => q.type !== 'file_lines' || !q.path || !q.lines.length);
    if (inlineQuotes.length) {
      const quotedText = inlineQuotes
        .map(q => quoteDisplayText(q).split('\n').map(line => `> ${line}`).join('\n'))
        .join('\n\n');
      content = content ? `${quotedText}\n\n${content}` : quotedText;
    }
    quotedMessages = [];
    renderQuotePreview();
  }

  // 注入文件路径。上传缓存文件会保留在工作目录中，供历史会话和资产页继续打开。
  if (attachedFiles.length > 0) {
    const filesForThisTurn = attachedFiles.slice();
    const filePaths = filesForThisTurn.map(f => `- ${f.path}`).join('\n');
    const prefix = `${t('attachmentIntro')}\n${filePaths}\n\n`;
    content = prefix + content;
    attachedFiles = [];
    renderAttachments();
  }

  addUserMessage(originalContent, quotesForThisTurn);
  captureActiveWorkspaceSnapshot();
  inputEl.value = '';
  inputEl.style.height = 'auto';

  if (!isLiveFollowup) {
    currentTurnContent = originalContent || (attachmentCount ? t('notifyAttachmentPrompt', { count: attachmentCount }) : (quotesForThisTurn.length ? t('quotedMessage') : ''));
    currentTurnAttachmentCount = attachmentCount;
    currentTurnStartedAt = Date.now();
    currentTurnHasAssistantOutput = false;
    isResponding = true;
    updateWorkspaceSessionStatus(currentSessionId, 'running', t('streamingReply'));
    currentAssistantEl = createAssistantBubble();
    currentAssistantMessageId = null;
    currentContent = [];
    streamBlocks = {};
    startTurnTimer();
    renderCurrentState();
    if (isSlashCommand(originalContent)) {
      addSystemMsg(t('commandRunning', { command: getSlashCommandName(originalContent) }));
    }
  }

  scrollToBottom();
  updateUI();

  const result = await sendAction('send_message', {
    content,
    quotes: quoteBackendPayload(quotesForThisTurn),
    model: modelSelect.value,
    cli: document.getElementById('cli-select')?.value || '',
    remote_target_id: remoteTargetSelect?.value || '',
    allow_remote_mutate: !!remoteAllowMutate?.checked,
  });

  if (!result?.ok) {
    if (!isLiveFollowup) {
      stopTurnTimer();
      removePendingAssistantBubble(false);
      isResponding = false;
      currentAssistantEl = null;
      currentContent = [];
      streamBlocks = {};
      currentTurnContent = '';
      currentTurnHasAssistantOutput = false;
      currentTurnStartedAt = 0;
      currentTurnAttachmentCount = 0;
      updateUI();
    }
    addSystemMsg(result?.error || t('requestFailed', { message: 'send_message' }), true);
    return;
  }

  if (result.run_id) currentRunId = result.run_id;
  captureActiveWorkspaceSnapshot();
}

function isSlashCommand(content) {
  return /^\/[^\s]+/.test((content || '').trim());
}

function getSlashCommandName(content) {
  const match = (content || '').trim().match(/^\/[^\s]+/);
  return match ? match[0] : '';
}

function resetSessionViewState() {
  stopTurnTimer();
  quotedMessages = [];
  renderQuotePreview();
  messagesEl.innerHTML = '';
  currentAssistantEl = null;
  currentAssistantMessageId = null;
  currentContent = [];
  streamBlocks = {};
  totalCost = 0;
  totalTokens = emptyTokenUsage();
  currentSessionId = null;
  currentRunId = null;
  renderTopbarMeta();
  renderCost();
  renderTokens();
}

function startNewSession() {
  if (!clientId) {
    addSystemMsg(t('notConnected'), true);
    return;
  }

  showPage('chat');
  createNewSession(cwdInput.value.trim());
}

function createNewSession(cwd) {
  resetSessionViewState();
  const pendingSessionId = `pending-${Date.now()}`;
  activeWorkspaceSessionId = pendingSessionId;
  ensureWorkspaceSession(pendingSessionId, {
    title: t('newChat'),
    cwd: cwd || cwdInput.value.trim() || '',
    model: modelSelect.value || '',
    cli: document.getElementById('cli-select')?.value || '',
    status: 'idle',
  });

  if (cwd) {
    cwdInput.value = cwd;
    updateRuntimeSummary();
  }
  refreshRightPaneFiles();
  sendAction('new_session', {
    model: modelSelect.value,
    cli: document.getElementById('cli-select')?.value || '',
    cwd: cwdInput.value.trim() || null,
    skip_permissions: document.getElementById('skip-permissions').checked,
    remote_target_id: remoteTargetSelect?.value || '',
    allow_remote_mutate: !!remoteAllowMutate?.checked,
  });
  loadSessions();
}

async function startNewSessionFromCwd(cwd) {
  const nextCwd = (cwd || '').trim();
  if (!nextCwd || !clientId) {
    if (!clientId) addSystemMsg(t('notConnected'), true);
    return;
  }

  showPage('chat');
  createNewSession(nextCwd);
}

function updateUI() {
  btnSend.disabled = !sessionActive;
  // viewer 模式下 Stop 按钮可见但禁用，补充发送仍可用。
  btnStop.classList.toggle('visible', isResponding);
  btnStop.disabled = isViewer;
  if (btnNewSession) btnNewSession.innerHTML = `<span class="btn-prefix">&gt;</span> ${sessionActive ? t('restartSession') : t('newSession')}`;
  document.body.classList.toggle('has-active-session', sessionActive);
  if (!sessionActive && sidebarCollapsed) sidebarCollapsed = false;
  setSidebarCollapsed(sidebarCollapsed);
  // viewer 模式时禁用部分配置修改（CWD 可随时更换）
  const cliSelect = document.getElementById('cli-select');
  if (cliSelect) cliSelect.disabled = false;
  if (modelSelect) modelSelect.disabled = false;
  const skipPermissions = document.getElementById('skip-permissions');
  if (skipPermissions) skipPermissions.disabled = sessionActive;
  // 远程目标和写入开关可随时切换，下一条消息生效
  if (remoteTargetSelect) remoteTargetSelect.disabled = false;
  inputEl.disabled = !sessionActive;
  inputEl.style.opacity = sessionActive ? '1' : '0.5';
  if (isResponding) {
    inputEl.placeholder = t('respondingPlaceholder') || 'Waiting for response...';
  } else {
    inputEl.placeholder = t('messagePlaceholder') || 'Type a message...';
  }
}

let _scrollPending = false;
function scrollToBottom() {
  if (_scrollPending) return;
  _scrollPending = true;
  requestAnimationFrame(() => {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'instant' });
    _scrollPending = false;
  });
}

// ─── 配置页 ──────────────────────────────────────────────────
async function loadConfig() {
  try {
    const env = await (await fetch('/api/env')).json();
    renderEnvEditor(env);
    renderEnvPasteSection();
    loadEnvProfiles();
  } catch (e) {
    console.error('配置加载失败:', e);
  }
}

let _envProfilesCache = {};

function renderEnvEditor(env) {
  const container = document.getElementById('env-fields');
  container.innerHTML = Object.entries(env).map(([k, v]) => `
    <div class="env-row">
      <input class="env-key" value="${esc(k)}">
      <input class="env-val" value="${esc(v)}">
      <button class="env-row-del" title="${esc(t('delete'))}">×</button>
    </div>
  `).join('') + `<div class="env-row env-row-add"><button class="env-add-btn">+</button></div>`;

  container.querySelectorAll('.env-row-del').forEach(btn => {
    btn.onclick = () => btn.closest('.env-row').remove();
  });
  container.querySelector('.env-add-btn').onclick = () => {
    const addRow = container.querySelector('.env-row-add');
    const row = document.createElement('div');
    row.className = 'env-row';
    row.innerHTML = `<input class="env-key" placeholder="KEY"><input class="env-val" placeholder="value"><button class="env-row-del" title="${esc(t('delete'))}">×</button>`;
    row.querySelector('.env-row-del').onclick = () => row.remove();
    container.insertBefore(row, addRow);
    row.querySelector('.env-key').focus();
  };

  document.getElementById('btn-save-env').onclick = async () => {
    const newEnv = {};
    container.querySelectorAll('.env-row:not(.env-row-add)').forEach(row => {
      const key = row.querySelector('.env-key').value.trim();
      const val = row.querySelector('.env-val').value;
      if (key) newEnv[key] = val;
    });
    await fetch('/api/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newEnv),
    });
    addSystemMsg(t('envSaved'));
  };
}

function collectEditorEnv() {
  const newEnv = {};
  document.querySelectorAll('#env-fields .env-row:not(.env-row-add)').forEach(row => {
    const key = row.querySelector('.env-key').value.trim();
    const val = row.querySelector('.env-val').value;
    if (key) newEnv[key] = val;
  });
  return newEnv;
}

async function loadEnvProfiles() {
  try {
    const data = await (await fetch('/api/env-profiles')).json();
    _envProfilesCache = data.profiles || {};
  } catch (e) { _envProfilesCache = {}; }
  renderEnvProfilesBar(_envProfilesCache);
}

function renderEnvProfilesBar(profiles) {
  const bar = document.getElementById('env-profiles-bar');
  if (!bar) return;
  const names = Object.keys(profiles);
  const options = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  bar.innerHTML = `
    <select id="profile-select">
      <option value="">${esc(t('profileSelect'))}</option>
      ${options}
    </select>
    <button class="profile-btn" id="profile-load-btn">${esc(t('profileLoad'))}</button>
    <button class="profile-btn" id="profile-save-btn">${esc(t('profileSaveAs'))}</button>
    <button class="profile-btn" id="profile-del-btn">${esc(t('profileDelete'))}</button>
  `;
  bar.querySelector('#profile-load-btn').onclick = loadSelectedProfile;
  bar.querySelector('#profile-save-btn').onclick = saveAsEnvProfile;
  bar.querySelector('#profile-del-btn').onclick = deleteSelectedProfile;
}

function loadSelectedProfile() {
  const sel = document.getElementById('profile-select');
  const name = sel ? sel.value : '';
  if (!name || !_envProfilesCache[name]) return;
  renderEnvEditor(_envProfilesCache[name].env || {});
  renderEnvPasteSection();
  addSystemMsg(t('profileLoaded', { name }));
}

async function saveAsEnvProfile() {
  showEnvProfileSavePicker();
}

function showEnvProfileSavePicker() {
  let overlay = document.getElementById('env-profile-save-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'env-profile-save-overlay';
    overlay.className = 'profile-save-overlay';
    document.body.appendChild(overlay);
  }

  const names = Object.keys(_envProfilesCache || {}).sort((a, b) => a.localeCompare(b));
  overlay.innerHTML = `
    <div class="profile-save-modal" role="dialog" aria-modal="true">
      <div class="profile-save-head">
        <div>
          <div class="profile-save-title">${esc(t('profileSaveTitle'))}</div>
          <div class="profile-save-hint">${esc(t('profileSaveHint'))}</div>
        </div>
        <button type="button" class="profile-save-close" title="${esc(t('close'))}">&times;</button>
      </div>
      <div class="profile-save-new">
        <input id="profile-save-name" class="profile-save-input" type="text" placeholder="${esc(t('profileNamePlaceholder'))}">
        <button type="button" id="profile-save-new-btn" class="profile-save-primary">${esc(t('profileSaveNew'))}</button>
      </div>
      <div class="profile-save-section-title">${esc(t('profileOverwriteExisting'))}</div>
      <div class="profile-save-list">
        ${names.length ? names.map(name => `
          <button type="button" class="profile-save-item" data-name="${esc(name)}">
            <span>${esc(name)}</span>
            <span>${esc(t('profileOverwrite'))}</span>
          </button>
        `).join('') : `<div class="profile-save-empty">${esc(t('profileNoExisting'))}</div>`}
      </div>
    </div>
  `;

  const close = () => hideEnvProfileSavePicker();
  overlay.querySelector('.profile-save-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }, { once: true });
  overlay.querySelector('#profile-save-new-btn')?.addEventListener('click', () => {
    const input = overlay.querySelector('#profile-save-name');
    saveEnvProfileFromEditor(input?.value || '');
  });
  overlay.querySelector('#profile-save-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveEnvProfileFromEditor(e.currentTarget.value || '');
    if (e.key === 'Escape') close();
  });
  overlay.querySelectorAll('.profile-save-item').forEach(btn => {
    btn.addEventListener('click', () => saveEnvProfileFromEditor(btn.dataset.name || '', true));
  });

  overlay.style.display = 'flex';
  overlay.querySelector('#profile-save-name')?.focus();
}

function hideEnvProfileSavePicker() {
  const overlay = document.getElementById('env-profile-save-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function saveEnvProfileFromEditor(name, overwriting = false) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) {
    addSystemMsg(t('profileNameEmpty'));
    return;
  }
  if (overwriting && !confirm(t('profileConfirmOverwrite', { name: trimmedName }))) return;

  const env = collectEditorEnv();
  await fetch('/api/env-profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: trimmedName, env }),
  });
  addSystemMsg(t('profileSaved', { name: trimmedName }));
  hideEnvProfileSavePicker();
  await loadEnvProfiles();
  const nextSel = document.getElementById('profile-select');
  if (nextSel) nextSel.value = trimmedName;
}

async function deleteSelectedProfile() {
  const sel = document.getElementById('profile-select');
  const name = sel ? sel.value : '';
  if (!name) return;
  if (!confirm(t('profileConfirmDelete', { name }))) return;
  await fetch('/api/env-profiles/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  addSystemMsg(t('profileDeleted', { name }));
  await loadEnvProfiles();
}

function renderEnvPasteSection() {
  const container = document.getElementById('env-paste-section');
  if (!container) return;
  container.innerHTML = `
    <div class="env-paste-section">
      <div class="env-paste-toggle">${esc(t('pasteJson'))}</div>
      <div class="env-paste-body">
        <textarea class="env-paste-textarea" placeholder='{"KEY": "value", ...}'></textarea>
        <button class="env-paste-apply">${esc(t('pasteJsonApply'))}</button>
      </div>
    </div>
  `;
  const toggle = container.querySelector('.env-paste-toggle');
  const body = container.querySelector('.env-paste-body');
  toggle.onclick = () => {
    toggle.classList.toggle('open');
    body.classList.toggle('open');
  };
  container.querySelector('.env-paste-apply').onclick = applyPastedJson;
}

function applyPastedJson() {
  const ta = document.querySelector('.env-paste-textarea');
  if (!ta) return;
  const raw = ta.value.trim();
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('not object');
    const env = {};
    for (const [k, v] of Object.entries(obj)) env[k] = String(v);
    renderEnvEditor(env);
    renderEnvPasteSection();
    ta.value = '';
    addSystemMsg(t('pasteJsonApplied'));
  } catch (e) {
    addSystemMsg(t('pasteJsonError'));
  }
}

function renderMcpServers(servers) {
  const el = document.getElementById('mcp-list');
  if (!el) return;
  if (!Array.isArray(servers) || !servers.length) {
    el.innerHTML = `<p class="empty-state">${esc(t('mcpNoServers'))}</p>`;
    return;
  }
  el.innerHTML = servers.map(s => {
    const isUrl = s.url || s.type === 'sse' || s.type === 'http' || s.type === 'url';
    const target = isUrl ? (s.url || '') : [s.command, ...(s.args || [])].filter(Boolean).join(' ');
    const badge = s.scope === 'project' ? t('mcpScopeProjectShort') : t('mcpScopeGlobalShort');
    return `<div class="mcp-item">
      <div class="mcp-main">
        <span class="mcp-name">${esc(s.name || '')}</span>
        <span class="mcp-meta">${esc(badge)} · ${esc(s.type || 'stdio')}</span>
      </div>
      <div class="mcp-target" title="${esc(target)}">${esc(target || '-')}</div>
    </div>`;
  }).join('');
}

async function loadMcpServers() {
  try {
    const url = `/api/mcp-servers?cwd=${encodeURIComponent(cwdInput?.value?.trim() || '')}`;
    const servers = await (await fetch(url)).json();
    renderMcpServers(servers);
  } catch (e) {
    renderMcpServers([]);
  }
}

async function loadIntegrations() {
  loadMcpServers();
  try {
    const agents = await (await fetch('/api/agents')).json();
    agentsCache = agents;
    renderAgents(agents);
  } catch (e) {
    agentsCache = [];
    renderAgents([]);
  }
}

function initMcpManager() {
  document.getElementById('btn-mcp-add')?.addEventListener('click', showMcpForm);
  document.getElementById('btn-mcp-cancel')?.addEventListener('click', hideMcpForm);
  document.getElementById('btn-mcp-save')?.addEventListener('click', saveMcpServer);
  mcpFormType?.addEventListener('change', updateMcpFormVisibility);
}

function showMcpForm() {
  if (!mcpFormSection) return;
  mcpFormSection.style.display = '';
  document.getElementById('mcp-form-name').value = '';
  document.getElementById('mcp-form-scope').value = 'global';
  document.getElementById('mcp-form-type').value = 'stdio';
  document.getElementById('mcp-form-command').value = '';
  document.getElementById('mcp-form-args').value = '';
  document.getElementById('mcp-form-url').value = '';
  document.getElementById('mcp-form-env').value = '';
  setMcpStatus('');
  updateMcpFormVisibility();
  document.getElementById('mcp-form-name')?.focus();
}

function hideMcpForm() {
  if (mcpFormSection) mcpFormSection.style.display = 'none';
}

function updateMcpFormVisibility() {
  const type = mcpFormType?.value || 'stdio';
  const isUrl = type === 'sse' || type === 'http' || type === 'url';
  if (mcpStdioFields) mcpStdioFields.style.display = isUrl ? 'none' : '';
  if (mcpUrlFields) mcpUrlFields.style.display = isUrl ? '' : 'none';
}

function setMcpStatus(message, isError = false) {
  const el = document.getElementById('mcp-form-status');
  if (!el) return;
  el.style.display = message ? '' : 'none';
  el.textContent = message || '';
  el.classList.toggle('error', Boolean(isError));
}

async function saveMcpServer() {
  let env = {};
  const envText = document.getElementById('mcp-form-env')?.value?.trim() || '';
  if (envText) {
    try {
      env = JSON.parse(envText);
      if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('not object');
    } catch (e) {
      setMcpStatus(t('mcpInvalidEnv'), true);
      return;
    }
  }
  const payload = {
    name: document.getElementById('mcp-form-name')?.value?.trim() || '',
    scope: document.getElementById('mcp-form-scope')?.value || 'global',
    type: document.getElementById('mcp-form-type')?.value || 'stdio',
    command: document.getElementById('mcp-form-command')?.value?.trim() || '',
    args: splitShellLike(document.getElementById('mcp-form-args')?.value || ''),
    url: document.getElementById('mcp-form-url')?.value?.trim() || '',
    env,
    cwd: cwdInput?.value?.trim() || '',
  };
  try {
    const resp = await fetch('/api/mcp-servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'save failed');
    hideMcpForm();
    await loadMcpServers();
    addSystemMsg(t('mcpSaved'));
  } catch (e) {
    setMcpStatus(t('mcpSaveFailed', { message: e.message || e }), true);
  }
}

function splitShellLike(text) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|\S+/g;
  let match;
  while ((match = re.exec(text || ''))) {
    args.push(match[1] ?? match[2] ?? match[0]);
  }
  return args;
}

async function loadSkills() {
  const el = document.getElementById('skills-list');
  if (!el) return;
  try {
    const resp = await fetch('/api/skills');
    skillsCache = await resp.json();
    renderSkills(skillsCache);
  } catch (e) {
    console.error('技能加载失败:', e);
    el.innerHTML = `<p class="empty-state">${esc(t('requestFailed', { message: e.message || e }))}</p>`;
  }
}

function renderSkills(skills) {
  const el = document.getElementById('skills-list');
  const countEl = document.getElementById('skills-count');
  if (!el) return;
  const list = Array.isArray(skills) ? skills : [];
  if (countEl) countEl.textContent = t('skillsCount', { count: list.length });
  if (!list.length) {
    el.innerHTML = `<p class="empty-state">${esc(t('noSkills'))}</p>`;
    return;
  }
  el.innerHTML = list.map(s => `
    <button class="skill-card" type="button" data-dir="${esc(s.dir)}" title="${esc(t('skillOpen'))}">
      <span class="skill-card-prefix">/</span>
      <span class="skill-card-title">${esc(s.name)}</span>
      <span class="skill-card-desc">${esc(s.description || t('noDescription'))}</span>
      <span class="skill-card-dir">~/.claude/skills/${esc(s.dir)}</span>
    </button>
  `).join('');
  el.querySelectorAll('.skill-card').forEach(card => {
    card.addEventListener('click', () => openSkillModal(card.dataset.dir));
  });
}

async function openSkillModal(dir) {
  if (!dir) return;
  const overlay = document.getElementById('skill-modal-overlay');
  const title = document.getElementById('skill-modal-title');
  const desc = document.getElementById('skill-modal-desc');
  const dirEl = document.getElementById('skill-modal-dir');
  const body = document.getElementById('skill-modal-body');
  if (!overlay || !title || !desc || !dirEl || !body) return;
  currentSkillDir = dir;
  overlay.style.display = 'flex';
  const cached = skillsCache.find(s => s.dir === dir) || {};
  title.textContent = '/' + (cached.name || dir);
  desc.textContent = cached.description || '';
  dirEl.textContent = `~/.claude/skills/${dir}`;
  body.textContent = t('loading');
  try {
    const resp = await fetch(`/api/skills/detail?dir=${encodeURIComponent(dir)}`);
    const skill = await resp.json();
    if (!resp.ok) throw new Error(skill.error || resp.statusText);
    title.textContent = '/' + (skill.name || dir);
    desc.textContent = skill.description || '';
    dirEl.textContent = `~/.claude/skills/${skill.dir || dir}`;
    body.textContent = skill.content || '';
  } catch (e) {
    body.textContent = t('requestFailed', { message: e.message || e });
  }
}

function closeSkillModal() {
  currentSkillDir = '';
  const overlay = document.getElementById('skill-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function uninstallCurrentSkill() {
  if (!currentSkillDir) return;
  const skill = skillsCache.find(s => s.dir === currentSkillDir) || { name: currentSkillDir };
  if (!confirm(t('confirmUninstallSkill', { name: skill.name || currentSkillDir }))) return;
  try {
    const resp = await fetch('/api/skills/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: currentSkillDir }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || resp.statusText);
    closeSkillModal();
    await loadSkills();
    showToast(t('skillUninstalled'), 'success');
  } catch (e) {
    showToast(t('skillUninstallFailed', { message: e.message || e }), 'error');
  }
}

function renderAgents(agents) {
  const el = document.getElementById('agents-list');
  if (!agents.length) {
    el.innerHTML = `<p class="empty-state">${esc(t('noAgents'))}</p>`;
    return;
  }
  el.innerHTML = agents.map(a => {
    const toolsStr = Array.isArray(a.tools) ? a.tools.join(', ') : '';
    const modelStr = a.model && a.model !== 'inherit' ? a.model : '';
    const memoryStr = a.memory ? ` · ${a.memory}` : '';
    const scopeBadge = a.scope === 'project' ? ` <span class="agent-scope-badge">${esc(t('agentScopeProject'))}</span>` : '';
    return `
      <div class="agent-item" data-name="${esc(a.name)}">
        <div class="agent-item-info">
          <div class="agent-item-head">
            <span class="agent-name">${esc(a.name)}${scopeBadge}</span>
            <div class="agent-item-actions">
              <button class="agent-action-btn agent-edit-btn" data-name="${esc(a.name)}" title="${esc(t('edit'))}">&#9998;</button>
              <button class="agent-action-btn agent-del-btn" data-name="${esc(a.name)}" title="${esc(t('delete'))}">&times;</button>
            </div>
          </div>
          <span class="agent-desc">${esc(a.description)}</span>
          ${toolsStr ? `<span class="agent-meta"><span class="agent-meta-label">${esc(t('agentTools'))}:</span> ${esc(toolsStr)}</span>` : ''}
          ${modelStr || memoryStr ? `<span class="agent-meta">${modelStr}${memoryStr}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.agent-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openAgentModal(btn.dataset.name));
  });
  el.querySelectorAll('.agent-del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteAgentPrompt(btn.dataset.name));
  });
}

// ─── Agent 管理 ─────────────────────────────────────────────────
let agentModalEditingName = null;

function openAgentModal(name = null) {
  agentModalEditingName = name;
  const overlay = document.getElementById('agent-modal-overlay');
  const title = document.getElementById('agent-modal-title');
  const formName = document.getElementById('agent-form-name');
  const formDesc = document.getElementById('agent-form-desc');
  const formScope = document.getElementById('agent-form-scope');
  const formModel = document.getElementById('agent-form-model');
  const formTools = document.getElementById('agent-form-tools');
  const formColor = document.getElementById('agent-form-color');
  const formMemory = document.getElementById('agent-form-memory');
  const formPrompt = document.getElementById('agent-form-prompt');
  const status = document.getElementById('agent-form-status');

  overlay.style.display = 'flex';
  status.style.display = 'none';
  status.textContent = '';

  if (name) {
    title.textContent = t('editAgent') + ': ' + name;
    formName.disabled = true;
    formScope.disabled = true;
    fetch(`/api/agents`).then(r => r.json()).then(agents => {
      const agent = agents.find(a => a.name === name);
      if (agent) {
        formName.value = agent.name || '';
        formDesc.value = agent.description || '';
        formScope.value = agent.scope || 'user';
        formModel.value = agent.model || '';
        formTools.value = Array.isArray(agent.tools) ? agent.tools.join(', ') : (agent.tools || '');
        formColor.value = agent.color || '';
        formMemory.value = agent.memory || '';
        formPrompt.value = agent.body || '';
      }
    });
  } else {
    title.textContent = t('newAgent');
    formName.disabled = false;
    formScope.disabled = false;
    formName.value = '';
    formDesc.value = '';
    formScope.value = 'user';
    formModel.value = '';
    formTools.value = '';
    formColor.value = '';
    formMemory.value = '';
    formPrompt.value = '';
  }
}

function closeAgentModal() {
  document.getElementById('agent-modal-overlay').style.display = 'none';
  agentModalEditingName = null;
}

async function saveAgent() {
  const status = document.getElementById('agent-form-status');
  const data = {
    name: document.getElementById('agent-form-name').value.trim(),
    description: document.getElementById('agent-form-desc').value.trim(),
    scope: document.getElementById('agent-form-scope').value,
    model: document.getElementById('agent-form-model').value,
    tools: document.getElementById('agent-form-tools').value,
    color: document.getElementById('agent-form-color').value,
    memory: document.getElementById('agent-form-memory').value,
    body: document.getElementById('agent-form-prompt').value.trim(),
  };
  if (!data.name) {
    status.textContent = 'Name required';
    status.className = 'remote-form-status err';
    status.style.display = '';
    return;
  }

  const url = agentModalEditingName ? '/api/agents/update' : '/api/agents';
  if (agentModalEditingName) data.name = agentModalEditingName;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await resp.json();
    if (!resp.ok || result.error) {
      status.textContent = result.error || 'Save failed';
      status.className = 'remote-form-status err';
      status.style.display = '';
      return;
    }
    closeAgentModal();
    loadConfig();
  } catch (e) {
    status.textContent = e.message;
    status.className = 'remote-form-status err';
    status.style.display = '';
  }
}

async function deleteAgentPrompt(name) {
  if (!confirm(t('confirmDeleteAgent', { name }))) return;
  try {
    const resp = await fetch('/api/agents/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (resp.ok) loadConfig();
  } catch (e) {
    console.error('Delete agent failed:', e);
  }
}

function initAgentModal() {
  document.getElementById('btn-agent-add')?.addEventListener('click', () => openAgentModal());
  document.getElementById('btn-agent-save')?.addEventListener('click', saveAgent);
  document.getElementById('btn-agent-cancel')?.addEventListener('click', closeAgentModal);
  document.getElementById('agent-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAgentModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('agent-modal-overlay')?.style.display === 'flex') {
      closeAgentModal();
    }
  });
}

let agentsCache = [];
let sessionAgents = [];

// ─── 会话 Agent 面板 ──────────────────────────────────────────────
async function loadSessionAgents() {
  try {
    const resp = await fetch(`/api/session/agents?id=${clientId}`);
    const data = await resp.json();
    sessionAgents = data.agents || [];
    renderSessionAgentsPanel();
  } catch (e) { console.error('Load session agents failed:', e); }
}

async function addSessionAgent(name) {
  if (!name || sessionAgents.includes(name)) return;
  try {
    const resp = await fetch('/api/session/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientId, action: 'add', agent: name }),
    });
    if (!resp.ok) { console.error('Add session agent failed:', resp.status); return; }
    const data = await resp.json();
    sessionAgents = data.agents || [];
    renderSessionAgentsPanel();
    hideAgentAddPopover();
  } catch (e) { console.error('Add session agent failed:', e); }
}

async function removeSessionAgent(name) {
  try {
    const resp = await fetch('/api/session/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientId, action: 'remove', agent: name }),
    });
    const data = await resp.json();
    sessionAgents = data.agents || [];
    renderSessionAgentsPanel();
  } catch (e) { console.error('Remove session agent failed:', e); }
}

function renderSessionAgentsPanel() {
  const panel = document.getElementById('group-member-panel');
  const list = document.getElementById('group-member-list') || panel;
  if (!panel || !list) return;

  if (!sessionAgents.length) {
    list.innerHTML = `<div class="group-member-empty">${esc(t('noSessionAgents'))}</div>`;
    updateWorkspaceHeader('members');
    return;
  }

  list.innerHTML = sessionAgents.map(a => `
    <span class="group-member-chip" data-agent="${esc(a)}">
      <span class="chip-name" title="${esc(a)}">${esc(a)}</span>
      <span class="chip-remove" data-action="remove" data-agent="${esc(a)}">&times;</span>
    </span>
  `).join('');
  updateWorkspaceHeader('members');

  // 点击芯片名 → 插入 @名称
  list.querySelectorAll('.group-member-chip .chip-name').forEach(nameEl => {
    nameEl.addEventListener('click', () => {
      const name = nameEl.parentElement.dataset.agent;
      const input = document.getElementById('message-input');
      if (!input || !name) return;
      const cursor = input.selectionStart || input.value.length;
      const before = input.value.substring(0, cursor);
      const after = input.value.substring(cursor);
      const prefix = (cursor > 0 && before[cursor - 1] !== ' ' && before[cursor - 1] !== '\n') ? ' ' : '';
      input.value = before + prefix + '@' + name + ' ' + after;
      const newPos = cursor + prefix.length + name.length + 2;
      input.setSelectionRange(newPos, newPos);
      input.focus();
    });
  });

  // 点击 × → 移除 agent
  list.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSessionAgent(btn.dataset.agent);
    });
  });
}

function renderAgentAddPopover() {
  const popover = document.getElementById('agent-add-popover');
  if (!popover) return;
  const all = agentsCache.filter(a => {
    const name = a.name || a;
    return name && !sessionAgents.includes(name);
  });
  if (!all.length) {
    popover.innerHTML = `<div class="agent-add-popover-empty">${esc(t('noAgents'))}</div>`;
  } else {
    popover.innerHTML = `
      <div class="agent-add-popover-search">
        <input type="text" id="agent-add-search" placeholder="${esc(t('searchAgent'))}">
      </div>
      ${all.map(a => {
        const name = a.name || a;
        return `<div class="agent-add-popover-item" data-agent="${esc(name)}">${esc(name)}</div>`;
      }).join('')}
    `;
    const searchInput = document.getElementById('agent-add-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        popover.querySelectorAll('.agent-add-popover-item').forEach(item => {
          item.style.display = item.dataset.agent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
      setTimeout(() => searchInput.focus(), 0);
    }
  }
  popover.style.display = 'block';
}

function hideAgentAddPopover() {
  const popover = document.getElementById('agent-add-popover');
  if (popover) popover.style.display = 'none';
}

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

  // 文件树刷新按钮
  document.getElementById('btn-file-tree-refresh')?.addEventListener('click', () => {
    const cwd = (cwdInput?.value || '').trim();
    if (cwd) loadFileTree(cwd);
  });
  document.getElementById('file-tree-filter')?.addEventListener('input', applyFileTreeFilter);

  // 添加 agent 按钮
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (popover && popover.style.display === 'block') {
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
    if (!pv || pv.style.display !== 'block') return;
    if (!pv.contains(e.target) && e.target.id !== 'btn-session-agent-add') {
      hideAgentAddPopover();
    }
  });

  // Escape 关闭移动端浮层；桌面端保持 Hermes 式常驻 Pane
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
  document.querySelectorAll('.chat-sidebar-tab').forEach(t => t.classList.remove('active'));
  const tabEl = document.querySelector(`.chat-sidebar-tab[data-tab="${tab}"]`);
  if (tabEl) tabEl.classList.add('active');
  document.getElementById('file-tree-panel').style.display = tab === 'files' ? '' : 'none';
  document.getElementById('review-panel').style.display = tab === 'review' ? '' : 'none';
  document.getElementById('group-member-panel').style.display = tab === 'members' ? '' : 'none';
  updateWorkspaceHeader(tab);
}

let fileTreePath = '';

async function loadReview(cwd) {
  const panel = document.getElementById('review-panel');
  if (!panel) return;
  panel.innerHTML = `<div class="review-loading">${esc(t('reviewLoading'))}</div>`;
  updateWorkspaceHeader('review');
  try {
    const resp = await fetch(`/api/review?cwd=${encodeURIComponent(cwd)}`);
    const data = await resp.json();
    if (data.error) {
      panel.innerHTML = `<div class="review-empty">${esc(data.error)}</div>`;
      updateWorkspaceHeader('review');
      return;
    }
    if (!data.git) {
      panel.innerHTML = `<div class="review-empty">${esc(data.message || t('reviewNoGit'))}</div>`;
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
      const renderReviewFileList = (items) => {
        if (!items.length) return `<div class="review-empty compact">${esc(t('reviewNoChanges'))}</div>`;
        return `<div class="review-file-list">${items.map(f => `<div class="review-file-item"><span class="rf-name">${esc(f.file)}</span><span class="rf-badge ${esc(f.status)}">${esc(statusLabel[f.status] || f.status)}</span></div>`).join('')}</div>`;
      };
      const stagedFiles = data.stagedFiles || [];
      const unstagedFiles = data.unstagedFiles || [];
      const hasSplitFiles = stagedFiles.length || unstagedFiles.length;
      if (hasSplitFiles) {
        html += `<div class="review-change-group staged"><div class="review-section-title" data-i18n="reviewStaged">${esc(t('reviewStaged'))}</div>${renderReviewFileList(stagedFiles)}</div>`;
        html += `<div class="review-change-group unstaged"><div class="review-section-title" data-i18n="reviewUnstaged">${esc(t('reviewUnstaged'))}</div>${renderReviewFileList(unstagedFiles)}</div>`;
      } else if (files.length === 0) {
        html += `<div class="review-empty">${esc(t('reviewNoChanges'))}</div>`;
      } else {
        html += `<div class="review-section-title" data-i18n="filesTab">${esc(t('filesTab'))}</div>`;
        html += renderReviewFileList(files);
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
    if (e.key === 'Escape' && previewPanel?.style.display !== 'none') closeFilePreview();
  });
}

function positionFilePreviewAtMessagesCenter() {
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
      previewContentEl.innerHTML = `<div class="file-preview-state">${esc(t('filePreviewUnsupported'))}</div>`;
      if (previewMetaEl) previewMetaEl.textContent = data.error || '';
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

// ─── @提及自动补全 ────────────────────────────────────────────────
let mentionPopup = null;
let mentionStartIdx = -1;

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

  inputEl.addEventListener('input', () => {
    updateMentionPopup();
  });
}

function updateMentionPopup() {
  // 只在聊天页面显示 @提及补全
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

  // 确保 @ 前面是空格或行首
  if (atIdx > 0 && before[atIdx - 1] !== ' ' && before[atIdx - 1] !== '\n') {
    hideMentionPopup();
    return;
  }

  const query = before.substring(atIdx + 1).toLowerCase();
  mentionStartIdx = atIdx;

  // 只可 @提及当前会话已拉入的 agent，外加 @all 全体
  const items = [];
  // @all 始终出现在顶部（需要至少有一个 agent 才有意义）
  if (sessionAgents.length >= 1 && (!query || 'all'.includes(query) || t('mentionAll').toLowerCase().includes(query))) {
    items.push({ type: 'all', name: 'all', label: t('mentionAll') || '@全体成员' });
  }
  sessionAgents.forEach(name => {
    if (!query || name.toLowerCase().includes(query)) {
      items.push({ type: 'agent', name, label: `@${name}` });
    }
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

// ─── 会话管理 ─────────────────────────────────────────────────
async function loadSessions() {
  try {
    const resp = await fetch(`/api/sessions?offset=0&limit=${SESSION_PAGE_SIZE}`);
    const data = await resp.json();
    cachedSessions = data.sessions || [];
    sessionOffset = cachedSessions.length;
    sessionTotal = data.total || 0;
    sessionsLoaded = true;
    renderSessionList(cachedSessions);
    renderWelcomeSessions(cachedSessions);
    renderWelcomeRuntime();
    renderLoadMore();
  } catch (e) {
    console.error('历史会话加载失败:', e);
  }
}

async function loadMoreSessions() {
  try {
    const resp = await fetch(`/api/sessions?offset=${sessionOffset}&limit=${SESSION_PAGE_SIZE}`);
    const data = await resp.json();
    const more = data.sessions || [];
    cachedSessions = cachedSessions.concat(more);
    sessionOffset = cachedSessions.length;
    sessionTotal = data.total || 0;
    renderSessionList(cachedSessions);
    renderLoadMore();
  } catch (e) {
    console.error('加载更多会话失败:', e);
  }
}

function renderLoadMore() {
  const el = document.getElementById('session-list');
  if (!el) return;
  let btn = document.getElementById('btn-load-more');
  if (sessionOffset < sessionTotal) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btn-load-more';
      btn.className = 'btn-load-more';
      btn.textContent = t('loadMore');
      btn.addEventListener('click', loadMoreSessions);
    }
    el.appendChild(btn);
  } else if (btn) {
    btn.remove();
  }
}

function renderWelcomeSessions(sessions) {
  const el = document.getElementById('welcome-sessions');
  if (!el) return;
  const current = sessions.filter(s => isCurrentCwd(s.cwd)).slice(0, 3);
  const currentIds = new Set(current.map(s => s.session_id));
  const recent = sessions.filter(s => !currentIds.has(s.session_id)).slice(0, Math.max(0, 5 - current.length));
  if (!current.length && !recent.length) {
    el.innerHTML = `<div class="welcome-empty">${esc(t('noHistory'))}</div>`;
    return;
  }

  let html = '';
  if (current.length) {
    html += `<div class="welcome-session-section current">
      <div class="welcome-session-label">${esc(t('currentProject'))}</div>
      ${current.map(s => renderWelcomeSessionItem(s, s.is_active)).join('')}
    </div>`;
  }
  if (recent.length) {
    html += `<div class="welcome-session-section">
      <div class="welcome-session-label">${esc(t('recentSessions') || 'Recent')}</div>
      ${recent.map(s => renderWelcomeSessionItem(s, s.is_active)).join('')}
    </div>`;
  }
  el.innerHTML = html;

  // bind click to resume
  el.querySelectorAll('.welcome-session-item').forEach(item => {
    item.addEventListener('click', () => {
      const tokens = safeJsonParse(item.dataset.tokens, null);
      const sid = item.dataset.sid;
      ensureWorkspaceSession(sid, {
        title: item.querySelector('.welcome-session-item-title')?.textContent?.trim() || t('newChat'),
        cwd: item.dataset.cwd || '',
        model: item.dataset.model || '',
        cli: item.dataset.cli || '',
        cost: Number(item.dataset.cost || 0),
        tokens,
        remoteTargetId: item.dataset.remoteTarget || '',
        status: item.classList.contains('active') ? 'running' : 'idle',
      });
      showPage('chat');
      resumeSession(sid, item.dataset.cwd, item.dataset.model, Number(item.dataset.cost || 0), item.dataset.remoteTarget || '', tokens, item.dataset.cli || '');
    });
  });
}

function renderWelcomeRuntime() {
  const el = document.getElementById('welcome-runtime');
  if (!el) return;
  const cwd = cwdInput?.value?.trim() || '';
  const modelOptions = Array.from(modelSelect?.options || [])
    .map(opt => `<option value="${esc(opt.value)}" ${opt.selected ? 'selected' : ''}>${esc(opt.textContent || opt.value)}</option>`)
    .join('');
  const cliSelect = document.getElementById('cli-select');
  const cliOptions = Array.from(cliSelect?.options || [])
    .map(opt => `<option value="${esc(opt.value)}" ${opt.selected ? 'selected' : ''}>${esc(opt.textContent || opt.value)}</option>`)
    .join('');
  const remoteOptions = Array.from(remoteTargetSelect?.options || [])
    .map(opt => `<option value="${esc(opt.value)}" ${opt.selected ? 'selected' : ''}>${esc(opt.textContent || opt.value)}</option>`)
    .join('');
  el.innerHTML = `
    <button type="button" class="welcome-runtime-row welcome-runtime-action" data-action="browse-cwd">
      <span>${esc(t('cwd'))}</span><strong title="${esc(cwd || t('unsetCwd'))}">${esc(shortenPlainPath(cwd, 4) || t('unsetCwd'))}</strong>
    </button>
    <label class="welcome-runtime-row welcome-runtime-field">
      <span>${esc(t('cliTool'))}</span><select class="welcome-runtime-select" data-runtime="cli">${cliOptions}</select>
    </label>
    <label class="welcome-runtime-row welcome-runtime-field">
      <span>${esc(t('model'))}</span><select class="welcome-runtime-select" data-runtime="model">${modelOptions}</select>
    </label>
    <label class="welcome-runtime-row welcome-runtime-field">
      <span>${esc(t('remote'))}</span><select class="welcome-runtime-select" data-runtime="remote">${remoteOptions}</select>
    </label>`;
  el.querySelector('[data-action="browse-cwd"]')?.addEventListener('click', () => openPicker());
  el.querySelector('[data-runtime="cli"]')?.addEventListener('change', (e) => {
    if (!cliSelect) return;
    cliSelect.value = e.target.value;
    cliSelect.dispatchEvent(new Event('change'));
  });
  el.querySelector('[data-runtime="model"]')?.addEventListener('change', (e) => {
    if (!modelSelect) return;
    modelSelect.value = e.target.value;
    modelSelect.dispatchEvent(new Event('change'));
  });
  el.querySelector('[data-runtime="remote"]')?.addEventListener('change', (e) => {
    if (!remoteTargetSelect) return;
    remoteTargetSelect.value = e.target.value;
    remoteTargetSelect.dispatchEvent(new Event('change'));
  });
}

function renderWelcomeSessionItem(s, isActive) {
  const title = s.title || t('newChat');
  const time = formatTime(s.updated_at);
  const savedCost = Number(s.total_cost_usd || 0);
  const modelLabel = getDisplayModelName(s.model || '', false);
  const costStr = savedCost > 0 ? ` · $${savedCost.toFixed(4)}` : '';
  return `<div class="welcome-session-item${isActive ? ' active' : ''}" data-sid="${esc(s.session_id)}" data-cwd="${esc(s.cwd)}" data-model="${esc(s.model)}" data-cli="${esc(s.cli || '')}" data-cost="${esc(savedCost)}" data-tokens="${esc(JSON.stringify(s.total_tokens || {}))}" data-remote-target="${esc(s.remote_target_id || '')}">
    <div class="welcome-session-item-title">${esc(title)}</div>
    <div class="welcome-session-item-meta">${esc(modelLabel || '')}${modelLabel ? ' · ' : ''}${esc(time)}${esc(costStr)}</div>
    ${isActive ? '<span class="welcome-session-dot" title="正在回复中..."></span>' : ''}
  </div>`;
}

function renderSessionList(sessions) {
  const el = document.getElementById('session-list');
  if (!el) return;
  const allSessions = sessions || [];
  const filtered = filterSessions(allSessions).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (sessionsCountEl) {
    sessionsCountEl.textContent = filtered.length === allSessions.length
      ? t('sessionsCount', { count: filtered.length })
      : t('sessionsCountFiltered', { shown: filtered.length, total: allSessions.length });
  }
  if (!filtered.length) {
    el.innerHTML = `<div class="session-empty">${esc(t(allSessions.length ? 'noMatches' : 'noHistory'))}</div>`;
    renderTopbarSessionActions();
    return;
  }

  el.innerHTML = filtered.map(s => renderSessionItem(s)).join('');

  el.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', () => {
      const tokens = safeJsonParse(item.dataset.tokens, null);
      const sid = item.dataset.sid;
      ensureWorkspaceSession(sid, {
        title: item.querySelector('.session-item-title')?.textContent?.trim() || t('newChat'),
        cwd: item.dataset.cwd || '',
        model: item.dataset.model || '',
        cli: item.dataset.cli || '',
        cost: Number(item.dataset.cost || 0),
        tokens,
        remoteTargetId: item.dataset.remoteTarget || '',
        status: item.classList.contains('active') ? 'running' : 'idle',
      });
      showPage('chat');
      resumeSession(sid, item.dataset.cwd, item.dataset.model, Number(item.dataset.cost || 0), item.dataset.remoteTarget || '', tokens, item.dataset.cli || '');
    });
  });
  el.querySelectorAll('.session-action').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = btn.closest('.session-item');
      if (!item) return;
      const session = cachedSessions.find(s => s.session_id === item.dataset.sid);
      if (!session) return;
      const action = btn.dataset.action;
      if (action === 'pin') await toggleSessionPin(session.session_id);
      if (action === 'cwd') await changeSessionCwd(session);
      if (action === 'rename') await promptRenameSession(session);
      if (action === 'delete') await deleteSessionRecord(session, 'sessions');
    });
  });
  renderTopbarSessionActions();
}

function showCwdContextMenu(e, cwd) {
  const menu = document.getElementById('cwd-context-menu');
  const nextCwd = (cwd || '').trim();
  if (!menu || !nextCwd) return;
  e.preventDefault();
  hideMsgContextMenu();
  contextMenuCwd = nextCwd;
  menu.style.display = 'block';
  const rect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = Math.max(4, x) + 'px';
  menu.style.top = Math.max(4, y) + 'px';
  menu.style.visibility = 'visible';
}

function hideCwdContextMenu() {
  const menu = document.getElementById('cwd-context-menu');
  if (menu) { menu.style.display = 'none'; menu.style.visibility = 'hidden'; }
}

function initCwdContextMenu() {
  const menu = document.getElementById('cwd-context-menu');
  if (!menu) return;

  menu.querySelector('[data-action="new-session-from-cwd"]')?.addEventListener('click', () => {
    const cwd = contextMenuCwd;
    hideCwdContextMenu();
    startNewSessionFromCwd(cwd);
  });

  menu.querySelector('[data-action="migrate-session-to-cwd"]')?.addEventListener('click', () => {
    const cwd = contextMenuCwd;
    hideCwdContextMenu();
    showMigrateSessionPopover(cwd);
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) hideCwdContextMenu();
  });
  document.addEventListener('scroll', hideCwdContextMenu, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCwdContextMenu();
  });
}

// ─── 会话迁移弹窗 ────────────────────────────────────────────
let migrateTargetCwd = '';

async function showMigrateSessionPopover(targetCwd) {
  const overlay = document.getElementById('session-migrate-overlay');
  const list = document.getElementById('session-migrate-list');
  const footer = document.getElementById('session-migrate-footer');
  if (!overlay || !list) return;

  migrateTargetCwd = targetCwd;
  const normalizedTarget = targetCwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  let sessionsForMigration = cachedSessions;
  if (!sessionsForMigration.length) {
    const data = await (await fetch(`/api/sessions?offset=0&limit=${SESSION_PAGE_SIZE}`)).json();
    sessionsForMigration = data.sessions || [];
  }
  const otherSessions = sessionsForMigration.filter(s => {
    const sCwd = (s.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return sCwd && sCwd !== normalizedTarget && s.session_id;
  });

  if (!otherSessions.length) {
    list.innerHTML = `<div class="session-migrate-empty">
      <p>${esc(t('migrateSessionEmpty'))}</p>
      <button id="session-migrate-empty-close" class="btn-save" type="button" style="margin-top:10px; font-size:12px;" data-i18n="close">Close</button>
    </div>`;
    if (footer) footer.style.display = 'none';
    document.getElementById('session-migrate-empty-close')?.addEventListener('click', hideMigrateSessionPopover);
  } else {
    list.innerHTML = otherSessions.map(s => `
      <label class="session-migrate-item" data-sid="${esc(s.session_id)}">
        <input type="checkbox" class="session-migrate-check">
        <span class="session-migrate-item-title">${esc(s.title || s.session_id)}</span>
        <span class="session-migrate-item-cwd" title="${esc(s.cwd || '')}">${shortenPath(s.cwd)}</span>
      </label>
    `).join('');
    if (footer) footer.style.display = 'flex';
    const checkAll = document.getElementById('session-migrate-check-all');
    if (checkAll) checkAll.checked = false;
  }

  overlay.style.display = 'flex';
}

function hideMigrateSessionPopover() {
  const overlay = document.getElementById('session-migrate-overlay');
  if (overlay) overlay.style.display = 'none';
}

function initMigrateSessionPopover() {
  const overlay = document.getElementById('session-migrate-overlay');
  if (!overlay) return;
  document.getElementById('session-migrate-close')?.addEventListener('click', hideMigrateSessionPopover);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideMigrateSessionPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') hideMigrateSessionPopover();
  });

  // 全选
  document.getElementById('session-migrate-check-all')?.addEventListener('change', function () {
    const list = document.getElementById('session-migrate-list');
    if (!list) return;
    list.querySelectorAll('.session-migrate-check').forEach(cb => { cb.checked = this.checked; });
  });

  // 批量迁移
  document.getElementById('session-migrate-confirm')?.addEventListener('click', async function () {
    const list = document.getElementById('session-migrate-list');
    const footer = document.getElementById('session-migrate-footer');
    if (!list || !footer) return;
    const checked = list.querySelectorAll('.session-migrate-check:checked');
    if (!checked.length) return;

    // 禁用交互
    const btn = this;
    btn.disabled = true;
    btn.textContent = t('migrating') || 'Migrating...';
    footer.style.pointerEvents = 'none';
    footer.style.opacity = '0.6';

    let okCount = 0;
    const total = checked.length;
    for (let i = 0; i < checked.length; i++) {
      const sid = checked[i].closest('.session-migrate-item')?.dataset.sid;
      if (!sid) continue;
      btn.textContent = `${t('migrating') || 'Migrating'} (${i + 1}/${total})`;
      const result = await updateSessionCwd(sid, migrateTargetCwd);
      if (result.ok) okCount++;
    }

    if (okCount > 0) {
      hideMigrateSessionPopover();
      loadSessions();
      addSystemMsg(t('migrateSessionMoved', { count: okCount }));
    }
    // 恢复状态（弹窗已关闭则不需要）
    btn.disabled = false;
    footer.style.pointerEvents = '';
    footer.style.opacity = '';
  });
}

async function renameSession(sessionId, title) {
  try {
    const resp = await fetch('/api/sessions/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, title }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'renameFailed');
    await loadSessions();
  } catch (e) {
    addSystemMsg(t(e.message || 'renameFailed') || t('renameFailed'), true);
  }
}

function filterSessions(sessions) {
  const keywords = (sessionSearchInput?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!keywords.length) return sessions;
  return sessions.filter(s => {
    const haystack = [s.title, s.cwd, s.model, s.updated_at, s.remote_target_id, s.scheduled_task_name].map(value => String(value || '').toLowerCase());
    return keywords.every(keyword => haystack.some(value => value.includes(keyword)));
  });
}

function renderSessionItem(s) {
  const isActive = s.session_id === currentSessionId;
  const title = s.title || t('newChat');
  const time = formatTime(s.updated_at);
  const savedCost = Number(s.total_cost_usd || 0);
  const savedTokens = normalizeTokenUsage(s.total_tokens);
  const tokenTotal = tokenUsageTotal(savedTokens);
  const modelLabel = getDisplayModelName(s.model || '', false);
  const scheduledTaskName = s.scheduled_task_name || '';
  const isScheduled = Boolean(s.scheduled_task_id || scheduledTaskName);
  const scheduledBadge = isScheduled ? `<span class="session-item-badge scheduled" title="${esc(scheduledTaskName || t('scheduledSession'))}">${esc(t('scheduledSession'))}</span>` : '';
  const pinnedBadge = s.pinned ? `<span class="session-item-badge pinned" title="${esc(t('pinnedSessions'))}">PIN</span>` : '';
  const metaParts = [
    `<span class="session-item-meta-primary">${esc(time)}</span>`,
    modelLabel ? `<span>${esc(modelLabel)}</span>` : '',
    isScheduled && scheduledTaskName ? `<span>${esc(t('scheduledTaskName', { name: scheduledTaskName }))}</span>` : '',
    savedCost > 0 ? `<span>$${savedCost.toFixed(4)}</span>` : '',
    tokenTotal > 0 ? `<span>${formatTokenCount(tokenTotal)} tok</span>` : '',
  ].filter(Boolean).join('');
  return `<div class="session-item${isActive ? ' active' : ''}" data-sid="${esc(s.session_id)}" data-cwd="${esc(s.cwd)}" data-model="${esc(s.model)}" data-cli="${esc(s.cli || '')}" data-cost="${esc(savedCost)}" data-tokens="${esc(JSON.stringify(savedTokens))}" data-remote-target="${esc(s.remote_target_id || '')}">
    <div class="session-item-main">
      <div class="session-item-title-row">
        <div class="session-item-title" title="${esc(title)}">${esc(title)}</div>
        ${pinnedBadge}
        ${scheduledBadge}
      </div>
      <div class="session-item-meta">${metaParts}</div>
    </div>
    <div class="session-item-actions" aria-label="Session actions">
      <button class="session-action session-action-pin${s.pinned ? ' pinned' : ''}" type="button" data-action="pin" title="${esc(t(s.pinned ? 'unpinSession' : 'pinSession'))}">${esc(s.pinned ? 'UNPIN' : 'PIN')}</button>
      <button class="session-action" type="button" data-action="cwd" title="${esc(s.cwd || t('changeCwd'))}">DIR</button>
      <button class="session-action" type="button" data-action="rename" title="${esc(t('rename'))}">EDIT</button>
      <button class="session-action danger" type="button" data-action="delete" title="${esc(t('delete'))}">×</button>
    </div>
  </div>`;
}

function normalizeCwdKey(cwd) {
  const value = (cwd || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return value ? value.toLowerCase() : '__no_cwd__';
}

function isCurrentCwd(cwd) {
  const current = cwdInput.value.trim();
  if (!current || !cwd) return false;
  return normalizeCwdKey(current) === normalizeCwdKey(cwd);
}

// ─── 目录更新辅助函数 ──────────────────────────────────────────
function isCwdError(errorMsg) {
  if (!errorMsg) return false;
  return /\u5de5\u4f5c\u76ee\u5f55\u4e0d\u53ef\u7528|director|not exist|find the (file|path)/i.test(errorMsg);
}

function promptCwdForSession(oldCwd) {
  return new Promise((resolve) => {
    openPicker(oldCwd || cwdInput.value.trim() || '/', (selectedPath) => {
      resolve(selectedPath || null);
    });
  });
}

async function updateSessionCwd(sessionId, newCwd) {
  try {
    const resp = await fetch('/api/sessions/update-cwd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, cwd: newCwd }),
    });
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function resumeSession(sessionId, cwd, model, savedCost = 0, remoteTargetId = '', savedTokens = null, cli = '') {
  if (!clientId) {
    addSystemMsg(t('notConnected'), true);
    return;
  }

  // 清空当前消息区
  quotedMessages = [];
  renderQuotePreview();
  messagesEl.innerHTML = '';
  currentAssistantEl = null;
  currentAssistantMessageId = null;
  currentContent = [];
  streamBlocks = {};
  currentSessionId = sessionId;
  resetAssistantStreamState();
  totalCost = Number.isFinite(savedCost) ? savedCost : 0;
  totalTokens = normalizeTokenUsage(savedTokens);
  renderTopbarMeta(model || modelSelect.value);
  renderCost();
  renderTokens();

  // 设置 UI
  if (cwd) {
    cwdInput.value = cwd;
    updateRuntimeSummary();
  }
  refreshRightPaneFiles();
  if (model && hasModelOption(model)) {
    modelSelect.value = model;
    renderTopbarMeta(model);
  }
  // 恢复远程目标选择
  if (remoteTargetSelect) {
    remoteTargetSelect.value = remoteTargetId || '';
    updateRemoteMutateRow();
  }
  // 恢复 CLI 选择
  const cliSelectEl = document.getElementById('cli-select');
  if (cliSelectEl && cli && [...cliSelectEl.options].some(o => o.value === cli)) {
    cliSelectEl.value = cli;
    renderTopbarMeta(model || modelSelect.value);
  }

  addSystemMsg(t('restoring'));

  // 加载历史消息
  try {
    const resp = await fetch('/api/sessions/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, cwd: cwd }),
    });
    const history = await resp.json();
    if (history && history.length > 0) {
      renderStaticHistory(history);
    }
  } catch(e) {
    console.error('历史消息加载失败:', e);
  }

  let resumeCwd = cwd || cwdInput.value.trim() || null;
  let result = await sendAction('resume_session', {
    session_id: sessionId,
    model: model || modelSelect.value,
    cli: cli || document.getElementById('cli-select')?.value || '',
    cwd: resumeCwd,
    skip_permissions: document.getElementById('skip-permissions').checked,
    remote_target_id: remoteTargetId || '',
    allow_remote_mutate: !!remoteAllowMutate?.checked,
  });

  // 目录无效时，让用户手动指定新目录
  if (result && !result.ok && isCwdError(result.error || '')) {
    addSystemMsg(t('cwdNotExist', { path: resumeCwd || '(空)' }), true);
    const newCwd = await promptCwdForSession(resumeCwd);
    if (newCwd) {
      const updateResult = await updateSessionCwd(sessionId, newCwd);
      if (updateResult.ok) {
        addSystemMsg(t('cwdChanged', { path: newCwd }));
        cwdInput.value = newCwd;
        updateRuntimeSummary();
        resumeCwd = newCwd;
        // 重试 resume
        result = await sendAction('resume_session', {
          session_id: sessionId,
          model: model || modelSelect.value,
          cli: cli || document.getElementById('cli-select')?.value || '',
          cwd: resumeCwd,
          skip_permissions: document.getElementById('skip-permissions').checked,
          remote_target_id: remoteTargetId || '',
          allow_remote_mutate: !!remoteAllowMutate?.checked,
        });
      } else {
        addSystemMsg(t('cwdNotChanged', { message: updateResult.error || t('unknownError') }), true);
      }
    }
  }

  if (result && result.ok) {
    sessionActive = true;
    updateUI();
    addSystemMsg(t('restored'));
  } else {
    addSystemMsg(t('restoreFailed', { message: result?.error || t('unknownError') }), true);
  }
  loadSessions();
}

function resetAssistantStreamState() {
  currentAssistantEl = null;
  currentAssistantMessageId = null;
  currentContent = [];
  streamBlocks = {};
}

function renderStaticHistory(history) {
  const previousAssistantEl = currentAssistantEl;
  const previousAssistantMessageId = currentAssistantMessageId;
  const previousContent = currentContent;
  const previousStreamBlocks = streamBlocks;
  resetAssistantStreamState();
  renderHistory(history);
  currentAssistantEl = previousAssistantEl;
  currentAssistantMessageId = previousAssistantMessageId;
  currentContent = previousContent;
  streamBlocks = previousStreamBlocks;
}

async function loadSessionHistory(sessionId, cwd) {
  try {
    const resp = await fetch('/api/sessions/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, cwd: cwd || cwdInput.value.trim() || '' }),
    });
    const history = await resp.json();
    if (history && history.length > 0) {
      renderStaticHistory(history);
    }
  } catch(e) {
    console.error('History load failed:', e);
  }
}

async function reloadSessionHistory(sessionId, cwd) {
  try {
    const resp = await fetch('/api/sessions/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, cwd: cwd || cwdInput.value.trim() || '' }),
    });
    const history = await resp.json();
    if (!Array.isArray(history) || history.length === 0) return;
    const systemMessages = Array.from(messagesEl.querySelectorAll('.system-msg')).map(el => ({
      text: el.textContent || '',
      isError: el.classList.contains('error'),
    }));
    messagesEl.innerHTML = '';
    resetAssistantStreamState();
    toolResults.clear();
    toolStartTimes.clear();
    renderStaticHistory(history);
    captureActiveWorkspaceSnapshot();
    for (const msg of systemMessages) {
      if (msg.text) addSystemMsg(msg.text, msg.isError);
    }
  } catch(e) {
    console.error('History reload failed:', e);
  }
}

function renderHistory(history) {
  for (const msg of history) {
    if (msg.role === 'user') {
      addUserMessage(msg.text);
    } else if (msg.role === 'assistant') {
      const el = createAssistantBubble(false);
      const contentEl = el.querySelector('.msg-content');
      let html = '';
      for (const block of (msg.blocks || [])) {
        if (block.type === 'text') {
          html += `<div class="text-block">${renderMd(block.text)}</div>`;
        } else if (block.type === 'thinking') {
          html += renderBlock(block);
        } else if (block.type === 'tool_use') {
          html += renderHistoryToolCard(block);
        }
      }
      contentEl.innerHTML = html;
    }
  }
  scrollToBottom();
}

function renderHistoryToolCard(block) {
  if (block.id && block.result) {
    toolResults.set(block.id, {
      tool_use_id: block.id,
      content: block.result.content || '',
      is_error: !!block.result.is_error,
    });
  }
  return renderToolCard(block, { history: true });
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const locale = currentLanguage === 'zh' ? 'zh-CN' : 'en-US';
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
  } catch(e) {
    return isoStr.substring(5, 16);
  }
}

// ─── Markdown 渲染 ──────────────────────────────────────────
function renderMd(text) {
  if (!text) return '';

  const codeBlocks = [];
  let html = String(text).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `\u0000CODE_BLOCK_${codeBlocks.length}\u0000`;
    codeBlocks.push(`<pre><code class="lang-${esc(lang)}">${esc(code)}</code></pre>`);
    return token;
  });

  html = esc(html);

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safeHref = sanitizeLinkHref(href);
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>(<h[1-4]>)/g, '$1');
  html = html.replace(/(<\/h[1-4]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<pre>)/g, '$1');
  html = html.replace(/(<\/pre>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');
  html = html.replace(/<p>(<blockquote>)/g, '$1');
  html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');
  html = html.replace(/<p>(<hr>)<\/p>/g, '$1');
  codeBlocks.forEach((block, index) => {
    html = html.replace(`\u0000CODE_BLOCK_${index}\u0000`, block);
  });
  return html;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortenPlainPath(path, maxSegments = 3) {
  if (!path) return '';
  const normalized = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= maxSegments) return normalized;
  const prefix = /^[A-Za-z]:$/.test(parts[0]) ? `${parts[0]}/` : '';
  return `.../${prefix}${parts.slice(-maxSegments).join('/')}`;
}

function shortenPath(path, maxSegments = 3) {
  return esc(shortenPlainPath(path, maxSegments));
}

function sanitizeLinkHref(href) {
  const value = String(href || '').trim().replace(/&amp;/g, '&');
  if (/^(https?:|mailto:)/i.test(value)) return esc(value);
  return '#';
}

// ─── 目录选择器 ──────────────────────────────────────────────
const pickerOverlay = document.getElementById('dir-picker-overlay');
const pickerList = document.getElementById('picker-list');
const pickerCurrentPath = document.getElementById('picker-current-path');
const pickerUp = document.getElementById('picker-up');
const pickerClose = document.getElementById('picker-close');
const pickerSelect = document.getElementById('picker-select');
const pickerNewdir = document.getElementById('picker-newdir');
const btnBrowse = document.getElementById('btn-browse');
let pickerCurrentDir = '/';
let pickerCallback = null;  // 选择后回调，用于 CWD 更新等场景

btnBrowse.addEventListener('click', async () => {
  if (sessionActive && currentSessionId) {
    const newCwd = await promptCwdForSession(cwdInput.value.trim());
    if (newCwd) {
      await updateSessionCwd(currentSessionId, newCwd);
      // SSE cwd_changed 事件会更新 UI（cwdInput.value、loadSessions、addSystemMsg）
    }
    return;
  }
  openPicker();
});
pickerClose.addEventListener('click', closePicker);
pickerOverlay.addEventListener('click', (e) => {
  if (e.target === pickerOverlay) closePicker();
});
pickerUp.addEventListener('click', () => {
  navigatePicker(pickerCurrentDir === '/' ? '/' : getParentPath(pickerCurrentDir));
});
pickerSelect.addEventListener('click', () => {
  if (pickerCallback) {
    const cb = pickerCallback;
    pickerCallback = null;
    cb(pickerCurrentDir);
    closePicker();
    return;
  }
  cwdInput.value = pickerCurrentDir;
  updateRuntimeSummary();
  slashCommands = [];
  closeSlashCommandPanel();
  loadSessions();
  closePicker();
});

pickerNewdir.addEventListener('click', async () => {
  const parent = pickerCurrentDir;
  if (!parent || parent === '/') {
    alert(t('newFolderNeedDir'));
    return;
  }
  const name = prompt(t('newFolderPrompt'));
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
      alert(data.error || t('requestFailed', { message: '' }));
      return;
    }
    await navigatePicker(parent);
  } catch (e) {
    alert(t('requestFailed', { message: e.message }));
  }
});

function openPicker(initialPath, callback) {
  pickerOverlay.style.display = 'flex';
  if (callback) {
    pickerCallback = callback;
  }
  navigatePicker(initialPath || cwdInput.value || '/');
}

function closePicker() {
  const cb = pickerCallback;
  pickerOverlay.style.display = 'none';
  pickerCallback = null;
  if (cb) cb(null);  // 未选择就关闭，通知调用方
}

async function navigatePicker(path) {
  pickerCurrentDir = path;
  pickerCurrentPath.textContent = path || '/';
  pickerList.innerHTML = `<div class="picker-empty">${esc(t('pickerLoading'))}</div>`;

  try {
    const resp = await fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await resp.json();

    if (data.error) {
      pickerList.innerHTML = `<div class="picker-empty">${esc(data.error)}</div>`;
      return;
    }

    pickerCurrentDir = data.current || path;
    pickerCurrentPath.textContent = pickerCurrentDir;

    if (!data.items || data.items.length === 0) {
      pickerList.innerHTML = `<div class="picker-empty">${esc(t('emptyDirFolders'))}</div>`;
      return;
    }

    pickerList.innerHTML = data.items.map(item => `
      <div class="picker-item ${item.type === 'drive' ? 'drive' : ''}" data-path="${esc(item.path)}">
        <span class="picker-item-icon">${item.type === 'drive' ? '&#128423;' : '&#128193;'}</span>
        <span class="picker-item-name">${esc(item.name)}</span>
      </div>
    `).join('');

    pickerList.querySelectorAll('.picker-item').forEach(el => {
      el.addEventListener('dblclick', () => navigatePicker(el.dataset.path));
      el.addEventListener('click', () => {
        pickerList.querySelectorAll('.picker-item').forEach(i => i.classList.remove('selected'));
        el.classList.add('selected');
        pickerCurrentDir = el.dataset.path;
        pickerCurrentPath.textContent = pickerCurrentDir;
      });
    });
  } catch (e) {
    pickerList.innerHTML = `<div class="picker-empty">${esc(t('requestFailed', { message: e.message }))}</div>`;
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

// ─── 文件选择器 ──────────────────────────────────────────────
const filePickerOverlay = document.getElementById('file-picker-overlay');
const filePickerList = document.getElementById('file-picker-list');
const filePickerCurrentPath = document.getElementById('file-picker-current-path');
const filePickerUp = document.getElementById('file-picker-up');
const filePickerClose = document.getElementById('file-picker-close');
const filePickerConfirm = document.getElementById('file-picker-confirm');
const filePickerSelectedCount = document.getElementById('file-picker-selected-count');
const filePickerSearch = document.getElementById('file-picker-search');
const filePickerTabs = document.getElementById('file-picker-tabs');
const filePickerLocal = document.getElementById('file-picker-local');
const filePickerBrowser = document.getElementById('file-picker-browser');
const filePickerClientChoose = document.getElementById('file-picker-client-choose');
const filePickerServerBrowse = document.getElementById('file-picker-server-browse');
const filePickerLocalHint = document.getElementById('file-picker-local-hint');

let filePickerCurrentDir = '/';
let filePickerSelected = new Map(); // path -> { name, source, originalPath, remoteTargetName }
let filePickerItems = [];
let filePickerSearchTimer = null;
let filePickerSearchSeq = 0;
let filePickerMode = 'local';

filePickerClose.addEventListener('click', closeFilePicker);
filePickerOverlay.addEventListener('click', (e) => {
  if (e.target === filePickerOverlay) closeFilePicker();
});
filePickerUp.addEventListener('click', () => {
  navigateFilePicker(getParentPath(filePickerCurrentDir));
});
filePickerConfirm.addEventListener('click', confirmFileSelection);
filePickerSearch.addEventListener('input', handleFilePickerSearchInput);
filePickerClientChoose?.addEventListener('click', () => fileInput.click());
filePickerServerBrowse?.addEventListener('click', () => setFilePickerMode('server'));

function normalizeFilePickerMode(mode) {
  return accessContext.isLocalhost && mode === 'local' ? 'server' : mode;
}

function getAttachmentSources() {
  const hasRemote = Boolean(remoteTargetSelect?.value);
  const sources = [];
  if (accessContext.isLocalhost) {
    sources.push({ id: 'server', label: t('serverWorkspace') });
  } else {
    sources.push({ id: 'client', label: t('thisDevice') });
    sources.push({ id: 'server', label: t('serverWorkspace') });
  }
  if (hasRemote) sources.push({ id: 'remote', label: t('remoteTarget') });
  return sources;
}

function openFilePicker() {
  filePickerSelected.clear();
  filePickerSearch.value = '';
  updateFilePickerCount();
  renderFilePickerTabs();
  filePickerOverlay.style.display = 'flex';
  setFilePickerMode(accessContext.isLocalhost ? 'server' : 'client');
}

function renderFilePickerTabs() {
  const sources = getAttachmentSources();
  filePickerTabs.innerHTML = sources.map(source => `<button type="button" class="picker-tab" data-mode="${esc(source.id)}">${esc(source.label)}</button>`).join('');
  filePickerTabs.querySelectorAll('.picker-tab').forEach(btn => {
    btn.addEventListener('click', () => setFilePickerMode(btn.dataset.mode));
  });
}

function setFilePickerMode(mode) {
  filePickerMode = normalizeFilePickerMode(mode);
  filePickerTabs.querySelectorAll('.picker-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === filePickerMode));
  const localMode = filePickerMode === 'client' || filePickerMode === 'local';
  filePickerLocal.style.display = localMode ? '' : 'none';
  filePickerBrowser.style.display = localMode ? 'none' : '';
  filePickerConfirm.style.display = localMode ? 'none' : '';
  if (localMode) {
    filePickerLocalHint.textContent = filePickerMode === 'local' ? t('chooseLocalHint') : t('chooseClientHint');
    filePickerServerBrowse.style.display = filePickerMode === 'local' ? '' : 'none';
    return;
  }
  filePickerConfirm.style.display = '';
  navigateFilePicker(filePickerMode === 'remote' ? '/' : (cwdInput.value.trim() || accessContext.defaultCwd || '/'));
}

function closeFilePicker() {
  filePickerOverlay.style.display = 'none';
}

function updateFilePickerCount() {
  filePickerSelectedCount.textContent = t('selectedFiles', { count: filePickerSelected.size });
  filePickerConfirm.disabled = filePickerSelected.size === 0;
}

async function navigateFilePicker(path) {
  filePickerCurrentDir = path;
  filePickerCurrentPath.textContent = path || '/';
  filePickerItems = [];
  filePickerSearch.value = '';
  filePickerSearchSeq += 1;
  filePickerList.innerHTML = `<div class="picker-empty">${esc(t('pickerLoading'))}</div>`;

  try {
    const resp = await fetch(filePickerMode === 'remote' ? '/api/remote-files/list' : '/api/browse-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filePickerMode === 'remote' ? { target_id: remoteTargetSelect?.value || '', path } : { path }),
    });
    const data = await resp.json();

    if (data.error) {
      filePickerList.innerHTML = `<div class="picker-empty">${esc(data.error)}</div>`;
      return;
    }

    filePickerCurrentDir = data.current || path;
    filePickerCurrentPath.textContent = filePickerCurrentDir;

    filePickerItems = data.items || [];

    if (filePickerItems.length === 0) {
      filePickerList.innerHTML = `<div class="picker-empty">${esc(t('emptyDir'))}</div>`;
      return;
    }

    renderFilePickerItems(filePickerItems);
  } catch (e) {
    filePickerList.innerHTML = `<div class="picker-empty">${esc(t('requestFailed', { message: e.message }))}</div>`;
  }
}

function hasModelOption(model) {
  if (!model) return false;
  for (const opt of modelSelect.options) {
    if (opt.value === model) return true;
  }
  return false;
}

function renderCost() {
  costDisplay.style.display = totalCost > 0 ? 'block' : 'none';
  costValue.textContent = totalCost.toFixed(4);
  renderTopbarStatusSummary();
}

function emptyTokenUsage() {
  return { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
}

function normalizeTokenUsage(value) {
  const usage = emptyTokenUsage();
  if (!value || typeof value !== 'object') return usage;
  usage.input = readTokenField(value, 'input', 'input_tokens');
  usage.output = readTokenField(value, 'output', 'output_tokens');
  usage.cache_creation = readTokenField(value, 'cache_creation', 'cache_creation_input_tokens', 'cache_creation_tokens');
  usage.cache_read = readTokenField(value, 'cache_read', 'cache_read_input_tokens', 'cache_read_tokens');
  return usage;
}

function readTokenField(value, ...keys) {
  for (const key of keys) {
    const n = Number(value[key] || 0);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return 0;
}

function addTokenUsage(a, b) {
  const left = normalizeTokenUsage(a);
  const right = normalizeTokenUsage(b);
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cache_creation: left.cache_creation + right.cache_creation,
    cache_read: left.cache_read + right.cache_read,
  };
}

function hasTokenUsage(usage) {
  return tokenUsageTotal(usage) > 0;
}

function tokenUsageTotal(usage) {
  const value = normalizeTokenUsage(usage);
  return value.input + value.output + value.cache_creation + value.cache_read;
}

function renderTokens() {
  const total = tokenUsageTotal(totalTokens);
  tokenDisplay.style.display = total > 0 ? 'block' : 'none';
  tokenValue.textContent = formatTokenUsage(totalTokens);
  renderTopbarStatusSummary();
}

function formatTokenUsage(usage) {
  const value = normalizeTokenUsage(usage);
  const main = value.input + value.output;
  const cache = value.cache_creation + value.cache_read;
  const parts = [];
  if (main > 0) parts.push(formatTokenCount(main));
  if (cache > 0) parts.push(t('cachedTokens', { count: formatTokenCount(cache) }));
  return parts.join(' · ') || '0';
}

function formatTokenCount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.trunc(n));
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
}

function formatModelName(model) {
  model = (model || '').trim();
  if (!model) return '';
  const names = {
    'claude-opus-4-6': 'Opus 4.6',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-haiku-4-6': 'Haiku 4.6',
  };
  return names[model] || model.replace(/^claude-/, '');
}

function isDisplayableModel(model) {
  const value = (model || '').trim();
  return Boolean(value && !/^<[^>]+>$/.test(value));
}

function getDisplayModelName(model, allowSelectedFallback = true) {
  if (isDisplayableModel(model)) return formatModelName(model);
  const selected = allowSelectedFallback ? modelSelect?.value : '';
  return isDisplayableModel(selected) ? formatModelName(selected) : '';
}

function handleFilePickerSearchInput() {
  window.clearTimeout(filePickerSearchTimer);
  const keyword = filePickerSearch.value.trim();

  if (!keyword) {
    renderFilePickerItems(filePickerItems);
    return;
  }

  if (filePickerMode === 'remote') {
    renderFilePickerItems(filePickerItems);
    return;
  }

  filePickerSearchTimer = window.setTimeout(() => {
    searchFilePicker(keyword);
  }, 250);
}

async function searchFilePicker(keyword) {
  const seq = ++filePickerSearchSeq;
  filePickerList.innerHTML = `<div class="picker-empty">${esc(t('searchLoading'))}</div>`;

  try {
    const resp = await fetch('/api/search-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePickerCurrentDir, query: keyword }),
    });
    const data = await resp.json();
    if (seq !== filePickerSearchSeq || filePickerSearch.value.trim() !== keyword) return;

    if (data.error) {
      filePickerList.innerHTML = `<div class="picker-empty">${esc(data.error)}</div>`;
      return;
    }

    renderFilePickerItems(data.items || [], {
      emptyText: t('noMatches'),
      truncated: data.truncated,
    });
  } catch (e) {
    if (seq === filePickerSearchSeq) {
      filePickerList.innerHTML = `<div class="picker-empty">${esc(t('searchFailed', { message: e.message }))}</div>`;
    }
  }
}

function renderFilePickerItems(items, options = {}) {
  const keyword = filePickerSearch.value.trim().toLowerCase();
  const filteredItems = keyword && items === filePickerItems
    ? items.filter(item => `${item.name} ${item.path}`.toLowerCase().includes(keyword))
    : items;

  if (filteredItems.length === 0) {
    filePickerList.innerHTML = `<div class="picker-empty">${esc(options.emptyText || (keyword ? t('noMatches') : t('emptyDir')))}</div>`;
    return;
  }

  filePickerList.innerHTML = `${options.truncated ? `<div class="picker-empty compact">${esc(t('tooManyResults'))}</div>` : ''}${filteredItems.map(item => {
    const isDir = item.type === 'dir' || item.type === 'drive';
    const icon = item.type === 'drive' ? '&#128423;' : isDir ? '&#128193;' : getFileIcon(item.name);
    const isSelected = filePickerSelected.has(item.path);
    const displayName = item.display || item.name;
    return `<div class="picker-item file-picker-item ${item.type === 'drive' ? 'drive' : ''} ${isSelected ? 'selected' : ''}"
        data-path="${esc(item.path)}" data-type="${esc(item.type)}" data-name="${esc(displayName)}">
      <span class="picker-item-icon">${icon}</span>
      <span class="picker-item-name">${esc(displayName)}</span>
      ${!isDir && isSelected ? '<span class="picker-check">✓</span>' : ''}
    </div>`;
  }).join('')}`;

  filePickerList.querySelectorAll('.file-picker-item').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.dataset.type;
      const itemPath = el.dataset.path;
      const itemName = el.dataset.name;

      if (type === 'dir' || type === 'drive') {
        navigateFilePicker(itemPath);
        return;
      }

      if (filePickerSelected.has(itemPath)) {
        filePickerSelected.delete(itemPath);
      } else {
          filePickerSelected.set(itemPath, {
            name: itemName,
            source: filePickerMode === 'remote' ? 'remote' : 'server',
            originalPath: itemPath,
            remoteTargetName: getRemoteTargetName(),
          });
      }
      updateFilePickerCount();
      renderFilePickerItems(filePickerSearch.value.trim() ? filteredItems : filePickerItems);
    });
  });
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

async function confirmFileSelection() {
  if (filePickerSelected.size === 0) return;

  for (const [filePath, meta] of filePickerSelected) {
    if (meta.source === 'remote') {
      await cacheRemoteAttachment(filePath, meta);
    } else {
      attachedFiles.push({ name: meta.name, path: filePath, isImage: false, uploaded: false, source: 'server', originalPath: filePath });
    }
  }

  renderAttachments();
  closeFilePicker();
}

async function cacheRemoteAttachment(filePath, meta) {
  const resp = await fetch('/api/remote-files/cache', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_id: remoteTargetSelect?.value || '', path: filePath, cwd: cwdInput.value.trim() || '' }),
  });
  const data = await resp.json();
  if (!data.ok) {
    addSystemMsg(t('remoteFileCacheFailed', { message: data.error || 'failed' }), true);
    return;
  }
  attachedFiles.push({
    name: data.name || meta.name,
    path: data.path,
    isImage: false,
    uploaded: true,
    source: 'remote',
    originalPath: data.original_path || filePath,
    remoteTargetName: data.remote_target_name || meta.remoteTargetName,
  });
}

function getRemoteTargetName() {
  const opt = remoteTargetSelect?.selectedOptions?.[0];
  return opt ? opt.textContent.trim() : '';
}
