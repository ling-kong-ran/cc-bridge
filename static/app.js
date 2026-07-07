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
let cachedSessions = [];
let sessionsLoaded = false;
let chatNavAutoOpening = false;

// 每个 workspace tab 独立的 SSE/流式状态，切换标签页时 save/restore
const _tabStreamState = new Map();

function getStreamStateOptions() {
  return {
    tabStreamState: _tabStreamState,
    emptyTokenUsage,
    updateStopButton,
    getState: () => ({
      isResponding,
      currentRunId,
      currentSessionId,
      currentContent,
      streamBlocks,
      currentAssistantMessageId,
      currentTurnContent,
      currentTurnHasAssistantOutput,
      currentTurnStartedAt,
      currentTurnAttachmentCount,
    }),
    setState: (state = {}) => {
      if ('isResponding' in state) isResponding = state.isResponding;
      if ('currentRunId' in state) currentRunId = state.currentRunId;
      if ('currentSessionId' in state) currentSessionId = state.currentSessionId;
      if ('currentContent' in state) currentContent = state.currentContent;
      if ('streamBlocks' in state) streamBlocks = state.streamBlocks;
      if ('currentAssistantMessageId' in state) currentAssistantMessageId = state.currentAssistantMessageId;
      if ('currentTurnContent' in state) currentTurnContent = state.currentTurnContent;
      if ('currentTurnHasAssistantOutput' in state) currentTurnHasAssistantOutput = state.currentTurnHasAssistantOutput;
      if ('currentTurnStartedAt' in state) currentTurnStartedAt = state.currentTurnStartedAt;
      if ('currentTurnAttachmentCount' in state) currentTurnAttachmentCount = state.currentTurnAttachmentCount;
      if ('currentAssistantEl' in state) currentAssistantEl = state.currentAssistantEl;
      if ('totalCost' in state) totalCost = state.totalCost;
      if ('totalTokens' in state) totalTokens = state.totalTokens;
    },
  };
}

function getStreamStateModule() {
  const mod = window.CCBridge?.streamState;
  if (!mod) console.error('CCBridge streamState module is not loaded');
  return mod;
}

function _saveStreamState(sessionId) {
  return getStreamStateModule()?.saveStreamState?.(sessionId, getStreamStateOptions());
}

function _restoreStreamState(sessionId) {
  return getStreamStateModule()?.restoreStreamState?.(sessionId, getStreamStateOptions());
}

function getUiModule() {
  const mod = window.CCBridge?.ui;
  if (!mod) console.error('CCBridge ui module is not loaded');
  return mod;
}

function updateStopButton() {
  return getUiModule()?.updateStopButton?.({ btnStop: document.getElementById('btn-stop'), isResponding, isViewer });
}

function setVisible(el, visible, display = '') {
  return getUiModule()?.setVisible?.(el, visible, display);
}

function isVisible(el) {
  return getUiModule()?.isVisible?.(el) || false;
}

function isDisplay(el, display) {
  return getUiModule()?.isDisplay?.(el, display) || false;
}

let sessionOffset = 0;
let sessionTotal = 0;
const SESSION_PAGE_SIZE = 50;
let sidebarCollapsed = false;
const WORKSPACE_STORAGE_KEY = 'ccb_workspace_state_v1';
const WORKSPACE_PREVIEW_MAX_CHARS = 3000;
let workspacePreviewRenderScheduled = false;
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
const btnDesktopClose = document.getElementById('btn-desktop-close');
const btnShortcuts = document.getElementById('btn-shortcuts');
const shortcutsOverlay = document.getElementById('shortcuts-overlay');
const shortcutsClose = document.getElementById('shortcuts-close');
const btnExportChat = document.getElementById('btn-export-chat');
const topbarStatusSummary = document.getElementById('topbar-status-summary');
const topbarConnection = document.getElementById('topbar-connection');
const topbarCost = document.getElementById('topbar-cost');
const topbarCostValue = document.getElementById('topbar-cost-value');
const topbarTokens = document.getElementById('topbar-tokens');
const topbarTokenValue = document.getElementById('topbar-token-value');
const topbarModel = document.getElementById('topbar-model');
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
const notifyFeishu = document.getElementById('notify-feishu');
const memoryAutoInject = document.getElementById('memory-auto-inject');
const remoteMutateRow = document.getElementById('remote-mutate-row');
const lanAccessToggle = document.getElementById('lan-access-toggle');
const lanAccessRow = document.getElementById('lan-access-row');
let currentLanguage = 'en';
let fontSizePercent = 100;
let notificationsEnabled = false;
let lastNotifyAt = 0;
let accessContext = { isLocalhost: true, defaultCwd: '' };

function getDesktopWindowModule() {
  const mod = window.CCBridge?.desktopWindow;
  if (!mod) console.error('CCBridge desktopWindow module is not loaded');
  return mod;
}

function initDesktopWindowControls() {
  return getDesktopWindowModule()?.initDesktopWindowControls?.({ btnDesktopClose, desktop: window.ccBridgeDesktop });
}

// ─── 初始化 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initDesktopWindowControls();
  initTheme();
  initShortcutsHelp();
  initInterfaceSettings();
  initNotifications();
  initMemoryAutoInjectControl();
  initLanAccessControl();
  await loadThemePreference();
  initNavigation();
  initTopbarSessionActions();
  initMobileLayout();
  initSSE();
  initMessageAutoScroll();
  initInput();
  initModelPill();
  initCliInstallModal();
  initUpdateModal();
  initMessageContextMenu();
  initCwdContextMenu();
  initMigrateSessionPopover();
  initRemote();
  initMcpManager();
  initAgentSkills();
  initRightPanel();
  initFilePreviewPanel();
  initDiffPreviewPanel();
  initMentionAutocomplete();
  initMemoryUI();
  initArtifactsUI();
  initScheduledTasksUI();
  initFeishuGatewayUI();
  initSessionWorkspace();
  loadDefaultCwd();
  loadClis();
  loadModels();
  loadConfig();
  initDirectoryPicker();
  initFilePicker();
  loadSessions();
  initFocusConfigReload();
  initToolCardInteractions();
  showPage('home');
  if (autoUpdateEnabled) setTimeout(() => checkForUpdate(), 3000);
});

function getToolCardsModule() {
  const mod = window.CCBridge?.toolCards;
  if (!mod) console.error('CCBridge toolCards module is not loaded');
  return mod;
}

function initToolCardInteractions() {
  return getToolCardsModule()?.initToolCardInteractions?.({ root: document });
}

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

function saveWorkspaceState() {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.writeState && workspace?.serializeState) {
    workspace.writeState(workspace.serializeState({
      mode: workspaceMode,
      activeSessionId: activeWorkspaceSessionId,
      sessions: workspaceSessions,
      widths: workspacePaneWidths,
    }), WORKSPACE_STORAGE_KEY);
    return;
  }
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
      runId: s.status === 'running' || s.status === 'tool' ? (s.runId || '') : '',
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
    const workspace = window.CCBridge?.workspace;
    const state = workspace?.readState ? workspace.readState(WORKSPACE_STORAGE_KEY) : JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) || 'null');
    if (!state) return;
    workspaceMode = workspace?.normalizeStoredMode ? workspace.normalizeStoredMode(state.mode) : (state.mode === 'grid' ? 'grid' : 'focus');
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
  const workspace = window.CCBridge?.workspace;
  const existing = workspaceSessions.get(sessionId) || {};
  if (workspace?.createSessionRecord) return workspace.createSessionRecord(sessionId, meta, existing, t);
  const nextStatus = meta.status || existing.status || 'idle';
  const rawPhase = Object.prototype.hasOwnProperty.call(meta, 'phase') ? meta.phase : existing.phase;
  return {
    sessionId,
    title: meta.title || existing.title || t('newChat'),
    cwd: meta.cwd || existing.cwd || '',
    model: meta.model || existing.model || '',
    cli: meta.cli || existing.cli || '',
    remoteTargetId: meta.remoteTargetId || existing.remoteTargetId || '',
    cost: Number.isFinite(meta.cost) ? meta.cost : (existing.cost || 0),
    tokens: meta.tokens || existing.tokens || null,
    status: nextStatus,
    phase: nextStatus === 'running' || nextStatus === 'tool' ? (rawPhase || '') : '',
    startedAt: meta.startedAt || existing.startedAt || 0,
    updatedAt: Date.now(),
    runId: meta.runId || existing.runId || '',
    released: Boolean(meta.released ?? existing.released),
    previewText: meta.previewText || existing.previewText || '',
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
  // 会话子页签只保留元数据和小体积文本预览，历史内容在切换时通过 resume/history 重新加载。
  // 不缓存 messagesEl.innerHTML，避免多个页签把整段聊天 DOM/HTML 复制到内存和 localStorage。
}

function getWorkspaceSessionPreview(session) {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.previewText) return workspace.previewText(session, WORKSPACE_PREVIEW_MAX_CHARS);
  if (!session) return '';
  return (session.previewText || '').slice(-WORKSPACE_PREVIEW_MAX_CHARS);
}

function appendWorkspaceSessionPreview(sessionId, text) {
  if (!sessionId || !text) return;
  const session = workspaceSessions.get(sessionId);
  const workspace = window.CCBridge?.workspace;
  const changed = workspace?.appendPreview
    ? workspace.appendPreview(session, text, WORKSPACE_PREVIEW_MAX_CHARS)
    : (() => {
      if (!session) return false;
      session.previewText = `${session.previewText || ''}${text}`.slice(-WORKSPACE_PREVIEW_MAX_CHARS);
      return true;
    })();
  if (!changed) return;
  scheduleWorkspacePreviewRender();
}

function setWorkspaceSessionPreview(sessionId, text) {
  if (!sessionId) return;
  const session = workspaceSessions.get(sessionId);
  const workspace = window.CCBridge?.workspace;
  const changed = workspace?.setPreview
    ? workspace.setPreview(session, text, WORKSPACE_PREVIEW_MAX_CHARS)
    : (() => {
      if (!session) return false;
      session.previewText = (text || '').slice(-WORKSPACE_PREVIEW_MAX_CHARS);
      return true;
    })();
  if (!changed) return;
  scheduleWorkspacePreviewRender();
}

function scheduleWorkspacePreviewRender() {
  if (workspacePreviewRenderScheduled || workspaceMode !== 'grid') return;
  workspacePreviewRenderScheduled = true;
  requestAnimationFrame(() => {
    workspacePreviewRenderScheduled = false;
    renderWorkspacePanes();
  });
}

function releaseWorkspaceSession(sessionId) {
  const session = workspaceSessions.get(sessionId);
  if (!session) return;
  if (session.status === 'running' || session.status === 'tool') return;
  if (session.released) return;
  session.released = true;
  sendAction('release_session', { session_id: sessionId, run_id: session.runId || '' });
}

function releaseInactiveWorkspaceSession(sessionId) {
  if (!sessionId || sessionId === activeWorkspaceSessionId) return;
  releaseWorkspaceSession(sessionId);
}

function activateWorkspaceSession(sessionId, opts = {}) {
  if (!sessionId || sessionId === activeWorkspaceSessionId) {
    renderWorkspace();
    return;
  }
  captureActiveWorkspaceSnapshot();
  const previousSessionId = activeWorkspaceSessionId;
  // 保存旧标签页的流式状态，以便切回时恢复
  _saveStreamState(previousSessionId);
  activeWorkspaceSessionId = sessionId;
  // 恢复新标签页的流式状态
  _restoreStreamState(sessionId);
  releaseInactiveWorkspaceSession(previousSessionId);
  const session = workspaceSessions.get(sessionId);
  if (session) {
    session.released = false;
    messagesEl.innerHTML = '';
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
  const workspace = window.CCBridge?.workspace;
  return t(workspace?.statusKey ? workspace.statusKey(status) : ({
    idle: 'workspaceIdle',
    running: 'workspaceRunning',
    tool: 'workspaceTool',
    done: 'workspaceDone',
    error: 'workspaceError',
  }[status || 'idle'] || 'workspaceIdle'));
}

function updateWorkspaceSessionStatus(sessionId, status, phase = '') {
  if (!sessionId) return;
  const nextStatus = status || 'idle';
  const nextPhase = nextStatus === 'running' || nextStatus === 'tool' ? phase : '';
  const session = ensureWorkspaceSession(sessionId, { status: nextStatus, phase: nextPhase });
  if (!session) return;
  session.status = nextStatus || session.status || 'idle';
  session.phase = nextPhase;
  session.updatedAt = Date.now();
  if (nextStatus === 'running' || nextStatus === 'tool') {
    session.released = false;
    session.startedAt = session.startedAt || Date.now();
  }
  if (nextStatus === 'done' || nextStatus === 'error' || nextStatus === 'idle') {
    session.startedAt = 0;
    releaseInactiveWorkspaceSession(sessionId);
  }
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
  workspaceFocusBtn?.setAttribute('aria-pressed', workspaceMode !== 'grid' ? 'true' : 'false');
  workspaceGridBtn?.setAttribute('aria-pressed', workspaceMode === 'grid' ? 'true' : 'false');
  saveWorkspaceState();
}

async function renameWorkspaceSession(sessionId) {
  const session = workspaceSessions.get(sessionId) || cachedSessions.find(s => s.session_id === sessionId);
  if (!session) return;
  await promptRenameSession({
    session_id: sessionId,
    title: session.title || t('newChat'),
  });
}

function getWorkspaceTabSessionId(target) {
  return target?.closest?.('.workspace-tab')?.dataset.sessionId || '';
}

function closeWorkspaceSession(sessionId) {
  if (!sessionId || !workspaceSessions.has(sessionId)) return;
  const sessionIds = Array.from(workspaceSessions.keys());
  const closingActive = sessionId === activeWorkspaceSessionId;
  const closingIndex = sessionIds.indexOf(sessionId);
  releaseWorkspaceSession(sessionId);
  workspaceSessions.delete(sessionId);
  workspacePaneWidths.delete(sessionId);
  if (closingActive) {
    const nextSessionId = sessionIds[closingIndex + 1] || sessionIds[closingIndex - 1] || '';
    if (nextSessionId && workspaceSessions.has(nextSessionId)) {
      activeWorkspaceSessionId = '';
      activateWorkspaceSession(nextSessionId);
      return;
    }
    activeWorkspaceSessionId = '';
    resetSessionViewState();
    sessionActive = false;
    isResponding = false;
    isViewer = false;
    updateUI();
  }
  renderWorkspace();
}

function getWorkspaceTabsOptions() {
  return {
    t,
    esc,
    getTabsEl: () => workspaceTabsEl,
    getSessions: () => Array.from(workspaceSessions.values()),
    getActiveSessionId: () => activeWorkspaceSessionId,
    getStatusLabel: getWorkspaceStatusLabel,
    getTabSessionId: getWorkspaceTabSessionId,
    startNewSession,
    closeWorkspaceSession,
    renameWorkspaceSession,
    activateWorkspaceSession,
  };
}

function ensureWorkspaceTabsEvents() {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.ensureWorkspaceTabsEvents) return workspace.ensureWorkspaceTabsEvents(getWorkspaceTabsOptions());
  if (!workspaceTabsEl || workspaceTabsEl.dataset.eventsBound === '1') return;
  workspaceTabsEl.dataset.eventsBound = '1';
  workspaceTabsEl.addEventListener('click', (e) => {
    if (e.target.closest('.workspace-new-session')) {
      startNewSession();
      return;
    }
    const closeBtn = e.target.closest('.workspace-close-btn');
    if (closeBtn) {
      e.preventDefault();
      e.stopPropagation();
      closeWorkspaceSession(getWorkspaceTabSessionId(closeBtn));
      return;
    }
    const renameBtn = e.target.closest('.workspace-rename-btn');
    if (renameBtn) {
      e.preventDefault();
      e.stopPropagation();
      renameWorkspaceSession(getWorkspaceTabSessionId(renameBtn));
      return;
    }
    const sessionId = getWorkspaceTabSessionId(e.target);
    if (sessionId) activateWorkspaceSession(sessionId);
  });
  workspaceTabsEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('.workspace-rename-btn, .workspace-close-btn')) return;
    const sessionId = getWorkspaceTabSessionId(e.target);
    if (!sessionId) return;
    e.preventDefault();
    renameWorkspaceSession(sessionId);
  });
  workspaceTabsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const closeBtn = e.target.closest('.workspace-close-btn');
    if (closeBtn) {
      e.preventDefault();
      e.stopPropagation();
      closeWorkspaceSession(getWorkspaceTabSessionId(closeBtn));
      return;
    }
    const renameBtn = e.target.closest('.workspace-rename-btn');
    if (renameBtn) {
      e.preventDefault();
      e.stopPropagation();
      renameWorkspaceSession(getWorkspaceTabSessionId(renameBtn));
      return;
    }
    const sessionId = getWorkspaceTabSessionId(e.target);
    if (!sessionId) return;
    e.preventDefault();
    activateWorkspaceSession(sessionId);
  });
}

function renderWorkspaceTabs() {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.renderWorkspaceTabs) return workspace.renderWorkspaceTabs(getWorkspaceTabsOptions());
  ensureWorkspaceTabsEvents();
  const sessions = Array.from(workspaceSessions.values());
  const newButton = `
    <button class="workspace-new-session" type="button" title="${esc(t('newSession'))}" aria-label="${esc(t('newSession'))}">+</button>
  `;
  if (!sessions.length) {
    workspaceTabsEl.innerHTML = `<div class="workspace-tabs-empty">${esc(t('workspaceNoTabs'))}</div>${newButton}`;
    return;
  }
  workspaceTabsEl.innerHTML = sessions.map(s => {
    const active = s.sessionId === activeWorkspaceSessionId;
    return `
    <div class="workspace-tab ${active ? 'active' : ''} status-${esc(s.status || 'idle')}" role="tab" tabindex="0" aria-selected="${active ? 'true' : 'false'}" data-session-id="${esc(s.sessionId)}">
      <span class="workspace-tab-title-row">
        <span class="workspace-tab-title">${esc(s.title || t('newChat'))}</span>
        <span class="workspace-tab-actions">
          <span class="workspace-rename-btn" role="button" tabindex="0" title="${esc(t('rename'))}" aria-label="${esc(t('rename'))}">EDIT</span>
          <span class="workspace-close-btn" role="button" tabindex="0" title="${esc(t('close'))}" aria-label="${esc(t('close'))}">×</span>
        </span>
      </span>
      <span class="workspace-tab-meta">${esc(getWorkspaceStatusLabel(s.status))}${(s.status === 'running' || s.status === 'tool') && s.phase ? ` · ${esc(s.phase)}` : ''}</span>
    </div>
  `;
  }).join('') + newButton;
}

function getWorkspacePanesOptions() {
  return {
    t,
    esc,
    getMode: () => workspaceMode,
    getSessions: () => Array.from(workspaceSessions.values()),
    getActiveSessionId: () => activeWorkspaceSessionId,
    getSessionActive: () => sessionActive,
    getLivePane: () => workspaceLivePane,
    getPanesEl: () => workspacePanesEl,
    getStatusLabel: getWorkspaceStatusLabel,
    getSessionPreview: getWorkspaceSessionPreview,
    applyPaneWidth: applyWorkspacePaneWidth,
    ensureLivePaneResizer,
    startWorkspaceResize,
    activateWorkspaceSession,
    releaseInactiveWorkspaceSession,
  };
}

function renderWorkspacePanes() {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.renderWorkspacePanes) return workspace.renderWorkspacePanes(getWorkspacePanesOptions());
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
    const previewText = getWorkspaceSessionPreview(session);
    releaseInactiveWorkspaceSession(session.sessionId);
    if (paneMessages && paneMessages.dataset.previewText !== previewText) {
      paneMessages.dataset.previewText = previewText;
      if (previewText) {
        let previewEl = paneMessages.querySelector('.workspace-live-preview');
        if (!previewEl) {
          paneMessages.innerHTML = '<div class="workspace-live-preview"></div>';
          previewEl = paneMessages.querySelector('.workspace-live-preview');
        }
        previewEl.textContent = previewText;
      } else {
        paneMessages.innerHTML = `<div class="workspace-snapshot-empty">${esc(t('workspaceOpenSession'))}</div>`;
      }
    }
    applyWorkspacePaneWidth(pane, session.sessionId);
    workspacePanesEl.appendChild(pane);
  }
  ensureLivePaneResizer();
}

function getWorkspaceResizeOptions() {
  return {
    t,
    getMode: () => workspaceMode,
    getActiveSessionId: () => activeWorkspaceSessionId,
    getLivePane: () => workspaceLivePane,
    getWidths: () => workspacePaneWidths,
    getResizeState: () => workspaceResizeState,
    setResizeState: (state) => { workspaceResizeState = state; },
    saveWorkspaceState,
    applyWorkspacePaneWidth,
  };
}

function ensureLivePaneResizer() {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.ensureLivePaneResizer) return workspace.ensureLivePaneResizer(getWorkspaceResizeOptions());
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
  const workspace = window.CCBridge?.workspace;
  if (workspace?.applyPaneWidth) {
    workspace.applyPaneWidth(pane, sessionId, {
      mode: workspaceMode,
      widths: workspacePaneWidths,
      sessionCount: workspaceSessions.size,
    });
    return;
  }
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
  const sessionCount = Math.max(1, workspaceSessions.size);
  const gapTotal = Math.max(0, sessionCount - 1) * 8;
  const width = `calc((100% - ${gapTotal}px) / ${sessionCount})`;
  pane.style.flex = `1 1 ${width}`;
  pane.style.flexBasis = width;
}

function startWorkspaceResize(event, sessionId, pane) {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.startWorkspaceResize) return workspace.startWorkspaceResize(event, sessionId, pane, getWorkspaceResizeOptions());
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
  const workspace = window.CCBridge?.workspace;
  if (workspace?.handleWorkspaceResizeMove) return workspace.handleWorkspaceResizeMove(event, getWorkspaceResizeOptions());
  if (!workspaceResizeState) return;
  const nextWidth = Math.max(260, Math.min(900, workspaceResizeState.startWidth + event.clientX - workspaceResizeState.startX));
  workspacePaneWidths.set(workspaceResizeState.sessionId, nextWidth);
  applyWorkspacePaneWidth(workspaceResizeState.pane, workspaceResizeState.sessionId);
}

function stopWorkspaceResize() {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.stopWorkspaceResize) return workspace.stopWorkspaceResize(getWorkspaceResizeOptions());
  if (!workspaceResizeState) return;
  workspaceResizeState = null;
  document.body.classList.remove('resizing-workspace-pane');
  saveWorkspaceState();
}


function loadDefaultCwd() {
  return window.CCBridge.settings?.loadDefaultCwd?.();
}

function initTheme() {
  window.CCBridge.settings?.initTheme?.();
}

function getShortcutsOptions() {
  return {
    btnShortcuts,
    shortcutsClose,
    shortcutsOverlay,
    setVisible,
    isVisible,
    openShortcutsHelp,
    closeShortcutsHelp,
    sessionSearchInput,
    startNewSession,
    sendMessage,
    interruptCurrentRun,
    copyConversationMarkdown,
  };
}

function getShortcutsModule() {
  const mod = window.CCBridge?.shortcuts;
  if (!mod) console.error('CCBridge shortcuts module is not loaded');
  return mod;
}

function initShortcutsHelp() {
  return getShortcutsModule()?.initShortcutsHelp?.(getShortcutsOptions());
}

function openShortcutsHelp() {
  return getShortcutsModule()?.openShortcutsHelp?.(getShortcutsOptions());
}

function closeShortcutsHelp() {
  return getShortcutsModule()?.closeShortcutsHelp?.(getShortcutsOptions());
}

function getStatusbarOptions() {
  return {
    t,
    sessionActive,
    sidebarCollapsed,
    connectionOnline,
    topbarStatusSummary,
    topbarConnection,
    topbarCost,
    topbarCostValue,
    topbarTokens,
    topbarTokenValue,
    costText: costValue?.textContent || '',
    totalCost,
    tokenText: tokenValue?.textContent || formatTokenUsage(totalTokens),
  };
}

function setSidebarCollapsed(collapsed) {
  const statusbar = window.CCBridge?.statusbar;
  if (statusbar?.setSidebarCollapsed) {
    sidebarCollapsed = statusbar.setSidebarCollapsed(collapsed, getStatusbarOptions());
    return;
  }
  sidebarCollapsed = Boolean(collapsed && sessionActive);
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  renderTopbarStatusSummary();
}

function renderTopbarStatusSummary() {
  const statusbar = window.CCBridge?.statusbar;
  if (statusbar?.renderTopbarStatusSummary) {
    statusbar.renderTopbarStatusSummary(getStatusbarOptions());
    return;
  }
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
  window.CCBridge.settings?.initInterfaceSettings?.();
}

function initNotifications() {
  window.CCBridge.settings?.initNotifications?.();
}

function initLanAccessControl() {
  window.CCBridge.settings?.initLanAccessControl?.();
}

function applyLanAccessPreference(settings) {
  window.CCBridge.settings?.applyLanAccessPreference?.(settings);
}

function applyNotificationPreference(enabled, persist = false) {
  window.CCBridge.settings?.applyNotificationPreference?.(enabled, persist);
}

function applyNotifyFeishuPreference(enabled, persist = false) {
  window.CCBridge.settings?.applyNotifyFeishuPreference?.(enabled, persist);
}

function initMemoryAutoInjectControl() {
  window.CCBridge.settings?.initMemoryAutoInjectControl?.();
}

function applyMemoryAutoInjectPreference(enabled) {
  window.CCBridge.settings?.applyMemoryAutoInjectPreference?.(enabled);
}

function loadContextSettings() {
  return window.CCBridge.settings?.loadContextSettings?.();
}

function saveContextSettings(settings) {
  return window.CCBridge.settings?.saveContextSettings?.(settings);
}

function getNotificationOptions() {
  return {
    t,
    summarizePrompt,
    formatDuration,
    formatUsd,
    getProjectName,
    getDisplayModelName,
    getNotificationsEnabled: () => notificationsEnabled,
    getLastNotifyAt: () => lastNotifyAt,
    setLastNotifyAt: (value) => { lastNotifyAt = value; },
    getCwd: () => cwdInput.value.trim(),
    getModelValue: () => modelSelect.value,
    getCurrentTurnContent: () => currentTurnContent,
    pageIsUnfocused,
  };
}

function getNotificationsModule() {
  const mod = window.CCBridge?.notifications;
  if (!mod) console.error('CCBridge notifications module is not loaded');
  return mod;
}

function pageIsUnfocused() {
  return getNotificationsModule()?.pageIsUnfocused?.() || false;
}

function notifyComplete(kind, detail = {}) {
  return getNotificationsModule()?.notifyComplete?.(kind, detail, getNotificationOptions());
}

function summarizePrompt(text, maxLen = 90) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.summarizePrompt) return formatters.summarizePrompt(text, maxLen);
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function formatDuration(ms) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.formatDuration) return formatters.formatDuration(ms, t);
  const seconds = Math.round(Number(ms || 0) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return t('notifyDurationSeconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? t('notifyDurationMinutesSeconds', { minutes, seconds: rest }) : t('notifyDurationMinutes', { minutes });
}

function formatCompactDuration(ms) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.formatCompactDuration) return formatters.formatCompactDuration(ms);
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function getTurnTimerOptions() {
  return {
    t,
    formatCompactDuration,
    getCurrentAssistantEl: () => currentAssistantEl,
    getCurrentTurnStartedAt: () => currentTurnStartedAt,
    getTimer: () => currentTurnTimer,
    setTimer: (value) => { currentTurnTimer = value; },
  };
}

function getTurnTimerModule() {
  const mod = window.CCBridge?.turnTimer;
  if (!mod) console.error('CCBridge turnTimer module is not loaded');
  return mod;
}

function updateAssistantMeta(state = 'running', durationMs = Date.now() - currentTurnStartedAt) {
  return getTurnTimerModule()?.updateAssistantMeta?.(state, durationMs, getTurnTimerOptions());
}

function startTurnTimer() {
  return getTurnTimerModule()?.startTurnTimer?.(getTurnTimerOptions());
}

function stopTurnTimer() {
  return getTurnTimerModule()?.stopTurnTimer?.(getTurnTimerOptions());
}

function formatUsd(value) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.formatUsd) return formatters.formatUsd(value, t);
  const cost = Number(value || 0);
  if (!Number.isFinite(cost) || cost <= 0) return '';
  return t('notifyCost', { cost: cost.toFixed(4) });
}

function getProjectName(cwd, fallback = '') {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.getProjectName) return formatters.getProjectName(cwd, fallback);
  if (!cwd) return fallback;
  const normalized = cwd.replace(/[\\\/]+$/, '');
  const parts = normalized.split(/[\\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || normalized || fallback;
}

// ─── 定时任务 ──────────────────────────────────────────────────
function initScheduledTasksUI() {
  window.CCBridge.scheduledTasks?.init?.();
}

function loadScheduledTasks() {
  return window.CCBridge.scheduledTasks?.loadTasks?.();
}

// ─── 消息网关 ────────────────────────────────────────────────
function initFeishuGatewayUI() {
  window.CCBridge.gateway?.init?.();
}

function loadFeishuGateway() {
  return window.CCBridge.gateway?.loadGateway?.();
}

function loadFeishuGatewayConfig() {
  return window.CCBridge.gateway?.loadConfig?.();
}

function loadFeishuGatewayScopes() {
  return window.CCBridge.gateway?.loadScopes?.();
}

// ─── 远程诊断目标 ────────────────────────────────────────────
function initRemote() {
  window.CCBridge.remote?.init?.();
}

function loadRemoteTargets() {
  return window.CCBridge.remote?.loadTargets?.();
}

function updateRemoteMutateRow() {
  window.CCBridge.remote?.updateMutateRow?.();
}

function populateRemoteSelect() {
  window.CCBridge.remote?.populateSelect?.();
}

function updateRuntimeSummary() {
  return getRuntimeModule()?.updateRuntimeSummary?.(getRuntimeOptions());
}

function renderInputStatus() {
  return getRuntimeModule()?.renderInputStatus?.(getRuntimeOptions());
}

function getConfigReloadOptions() {
  return {
    loadClis,
    loadModels,
    loadConfig,
    closeSlashCommandPanel,
  };
}

function getConfigReloadModule() {
  const mod = window.CCBridge?.configReload;
  if (!mod) console.error('CCBridge configReload module is not loaded');
  return mod;
}

function initFocusConfigReload() {
  return getConfigReloadModule()?.initFocusConfigReload?.(getConfigReloadOptions());
}

function reloadConfigOnFocus() {
  return getConfigReloadModule()?.reloadConfigOnFocus?.(getConfigReloadOptions());
}

async function reloadExternalConfig() {
  return getConfigReloadModule()?.reloadExternalConfig?.(getConfigReloadOptions());
}

function applyTheme(theme, persist = true) {
  window.CCBridge.settings?.applyTheme?.(theme, persist);
}

function loadThemePreference() {
  return window.CCBridge.settings?.loadThemePreference?.();
}

function saveThemePreference(theme) {
  return window.CCBridge.settings?.saveThemePreference?.(theme);
}

function saveGuiSettings(settings) {
  return window.CCBridge.settings?.saveGuiSettings?.(settings);
}

function updateThemeToggle() {
  const isLight = document.documentElement.classList.contains('light-theme');
  if (themeToggleText) themeToggleText.textContent = isLight ? t('switchToDark') : t('switchToLight');
  btnThemeToggle.setAttribute('aria-label', isLight ? t('switchToDarkTheme') : t('switchToLightTheme'));
  btnThemeToggle.title = isLight ? t('switchToDarkTheme') : t('switchToLightTheme');
}

function getLocalizationOptions() {
  return {
    t,
    loadI18n: (language) => window.CCBridge.i18n.load(language),
    getSessionActive: () => sessionActive,
    getSidebarCollapsed: () => sidebarCollapsed,
    setCurrentLanguage: (language) => { currentLanguage = language; },
    setLanguageSelectValue: (language) => {
      if (languageSelect) languageSelect.value = language;
    },
    saveGuiSettings,
    updateThemeToggle,
    updateConnectionText,
    updateUI,
    setSidebarCollapsed,
    updateFilePickerCount,
  };
}

async function applyLanguage(language, persist = true) {
  const localization = window.CCBridge?.localization;
  if (localization?.applyLanguage) return localization.applyLanguage(language, persist, getLocalizationOptions());
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
  const localization = window.CCBridge?.localization;
  if (localization?.loadLanguageMap) return localization.loadLanguageMap(language, getLocalizationOptions());
  try {
    await window.CCBridge.i18n.load(language);
  } catch (e) {
    if (language !== 'en') {
      currentLanguage = 'en';
      await loadLanguageMap('en');
    }
  }
}

function renderLocalizedText() {
  const localization = window.CCBridge?.localization;
  if (localization?.renderLocalizedText) return localization.renderLocalizedText(getLocalizationOptions());
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
  return window.CCBridge.i18n.t(key, vars);
}

function applyFontSize(value, persist = true) {
  window.CCBridge.settings?.applyFontSize?.(value, persist);
}

function normalizeFontSize(value) {
  return window.CCBridge.settings?.normalizeFontSize?.(value) || 100;
}

function getRuntimeOptions() {
  return {
    t,
    esc,
    addSystemMsg,
    renderModelPill,
    renderWelcomeRuntime,
    renderTopbarSessionActions,
    renderTopbarStatusSummary,
    renderInputStatus,
    loadSlashCommands,
    getDisplayModelName,
    formatModelName,
    shortenPlainPath,
    getSavedModelPref: () => savedModelPref,
    setSavedModelPref: (value) => { savedModelPref = value; },
    getCliInstallPromptShown: () => cliInstallPromptShown,
    setCliInstallPromptShown: (value) => { cliInstallPromptShown = value; },
    setCliInstallCommand: (value) => { cliInstallCommand = value; },
    openCliInstallModal,
    getCurrentSessionId: () => currentSessionId,
    modelSelect,
    topbarModel,
    costDisplay,
    costValue,
    tokenDisplay,
    tokenValue,
    runtimeSummaryValue: document.querySelector('.runtime-summary-value'),
    cwdInput,
    remoteTargetSelect,
    inputCliStatus,
    inputCwdStatus,
  };
}

function formatTopbarSessionId(sessionId) {
  return getRuntimeModule()?.formatTopbarSessionId?.(sessionId) || '-';
}

function getSelectedCliLabel() {
  return getRuntimeModule()?.getSelectedCliLabel?.() || '-';
}

function quoteCommandArg(value) {
  return getRuntimeModule()?.quoteCommandArg?.(value) || '';
}

function getResumeCommandText() {
  return getRuntimeModule()?.getResumeCommandText?.(getRuntimeOptions()) || '';
}

async function copyResumeCommand() {
  return getRuntimeModule()?.copyResumeCommand?.(getRuntimeOptions());
}

function renderTopbarMeta(modelOverride = '') {
  return getRuntimeModule()?.renderTopbarMeta?.(modelOverride, getRuntimeOptions());
}

function getCurrentSessionRecord() {
  return window.CCBridge.sessions?.getCurrentSessionRecord?.() || null;
}

function renderTopbarSessionActions() {
  return window.CCBridge.sessions?.renderTopbarSessionActions?.();
}

async function loadClis() {
  return getRuntimeModule()?.loadClis?.(getRuntimeOptions());
}

// 选中指定 CLI（若可用），并同步到服务端全局当前 CLI
function selectCli(path) {
  return getRuntimeModule()?.selectCli?.(path, getRuntimeOptions()) || false;
}

// ─── CLI 安装引导 ────────────────────────────────────────────
let cliInstallCommand = 'npm install -g @anthropic-ai/claude-code';
let cliInstallPromptShown = false;
let cliInstalling = false;

function getCliUpdateOptions() {
  return {
    t,
    addSystemMsg,
    loadClis,
    renderTopbarMeta,
    renderWelcomeRuntime,
    saveGuiSettings,
    getCliInstallCommand: () => cliInstallCommand,
    setCliInstallPromptShown: (value) => { cliInstallPromptShown = value; },
    getCliInstalling: () => cliInstalling,
    setCliInstalling: (value) => { cliInstalling = value; },
    getUpdateRunning: () => updateRunning,
    setUpdateRunning: (value) => { updateRunning = value; },
    getUpdateInfo: () => updateInfo,
    setUpdateInfo: (value) => { updateInfo = value; },
    getSkipUpdateVersion: () => skipUpdateVersion,
    setSkipUpdateVersion: (value) => { skipUpdateVersion = value; },
    getAutoUpdateEnabled: () => autoUpdateEnabled,
    setAutoUpdateEnabled: (value) => { autoUpdateEnabled = value; },
  };
}

function openCliInstallModal() {
  return window.CCBridge.cliUpdate?.openCliInstallModal?.(getCliUpdateOptions());
}

function closeCliInstallModal() {
  return window.CCBridge.cliUpdate?.closeCliInstallModal?.();
}

function setCliInstallStatus(text, kind) {
  return window.CCBridge.cliUpdate?.setCliInstallStatus?.(text, kind);
}

async function copyCliInstallCommand() {
  return window.CCBridge.cliUpdate?.copyCliInstallCommand?.(getCliUpdateOptions());
}

async function runCliAutoInstall() {
  return window.CCBridge.cliUpdate?.runCliAutoInstall?.(getCliUpdateOptions());
}

function initCliInstallModal() {
  return window.CCBridge.cliUpdate?.initCliInstallModal?.(getCliUpdateOptions());
}

// ─── 自动更新 ────────────────────────────────────────────────
let updateRunning = false;

function setUpdateStatus(text, kind) {
  return window.CCBridge.cliUpdate?.setUpdateStatus?.(text, kind);
}

function openUpdateModal() {
  return window.CCBridge.cliUpdate?.openUpdateModal?.();
}

function closeUpdateModal() {
  return window.CCBridge.cliUpdate?.closeUpdateModal?.();
}

async function checkForUpdate(manual = false) {
  return window.CCBridge.cliUpdate?.checkForUpdate?.(manual, getCliUpdateOptions());
}

async function runUpdate() {
  return window.CCBridge.cliUpdate?.runUpdate?.(getCliUpdateOptions());
}

function skipThisVersion() {
  return window.CCBridge.cliUpdate?.skipThisVersion?.(getCliUpdateOptions());
}

async function waitForServerAndReload(attempt = 0) {
  return window.CCBridge.cliUpdate?.waitForServerAndReload?.(attempt, getCliUpdateOptions());
}

function initUpdateModal() {
  return window.CCBridge.cliUpdate?.initUpdateModal?.(getCliUpdateOptions());
}

async function loadModels() {
  return getRuntimeModule()?.loadModels?.(getRuntimeOptions());
}

// ─── 导航 ────────────────────────────────────────────────────
function getNavigationOptions() {
  return {
    t,
    sessionActive,
    topbarSessionButtons: [btnSessionPin, btnSessionCwd, btnSessionRename, btnSessionDelete],
    renderTopbarMeta,
    renderTopbarStatusSummary,
    renderSessionList,
    getCachedSessions: () => cachedSessions,
    loadArtifacts,
    loadSkills,
    loadIntegrations,
    loadMemoryFiles,
    loadScheduledTasks,
    loadFeishuGateway,
    hideMentionPopup,
    openLatestOrNewChatSession,
    startNewSession,
    showPage,
  };
}

function showPage(page) {
  const navigation = window.CCBridge?.navigation;
  if (navigation?.showPage) {
    navigation.showPage(page, getNavigationOptions());
    return;
  }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');
  // 更新全局 titlebar
  const pageLabel = document.getElementById('titlebar-page-label');
  const pageKey = page === 'home' ? 'home' : page === 'config' ? 'settings' : page === 'artifacts' ? 'artifacts' : page === 'scheduled' ? 'scheduledTasks' : page === 'feishu-gateway' ? 'messageGateway' : page === 'sessions' ? 'sessions' : page === 'skills' ? 'skills' : page === 'integrations' ? 'integrations' : page === 'memory' ? 'memory' : 'chat';
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
  } else if (page === 'feishu-gateway') {
    loadFeishuGateway();
  }
  hideMentionPopup();
}

function compareSessionsByPinAndTime(a, b) {
  return window.CCBridge.sessions?.compareSessionsByPinAndTime?.(a, b) || 0;
}

async function openLatestOrNewChatSession() {
  return window.CCBridge.sessions?.openLatestOrNewChatSession?.();
}

function initNavigation() {
  const navigation = window.CCBridge?.navigation;
  if (navigation?.initNavigation) {
    navigation.initNavigation(getNavigationOptions());
    return;
  }
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
  return window.CCBridge.sessions?.toggleSessionPin?.(sessionId);
}

async function changeSessionCwd(session) {
  return window.CCBridge.sessions?.changeSessionCwd?.(session);
}

async function promptRenameSession(session) {
  return window.CCBridge.sessions?.promptRenameSession?.(session);
}

async function deleteSessionRecord(session, nextPage = 'sessions') {
  return window.CCBridge.sessions?.deleteSessionRecord?.(session, nextPage);
}

function initTopbarSessionActions() {
  return window.CCBridge.sessions?.initTopbarSessionActions?.();
}

function initMobileLayout() {
  const navigation = window.CCBridge?.navigation;
  if (navigation?.initMobileLayout) {
    navigation.initMobileLayout();
    return;
  }
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
  return window.CCBridge.sse?.connect?.({
    getEventSource: () => eventSource,
    setEventSource: (source) => { eventSource = source; },
    setClientId: (id) => { clientId = id; },
    bindEvents: bindSSEEvents,
  });
}

function getSseSessionState() {
  return { currentRunId, currentSessionId, activeWorkspaceSessionId };
}

function isEventForCurrentSession(data = {}) {
  return window.CCBridge.sse?.isEventForSession?.(data, getSseSessionState());
}

function noteBackgroundSessionEvent(data = {}) {
  const isBackground = window.CCBridge.sse?.isBackgroundSessionEvent?.(data, getSseSessionState());
  if (!isBackground) return false;
  updateBackgroundWorkspacePreview(data);
  scheduleCompletionHistorySync(data.session_id);
  return true;
}

function getWorkspaceEventOptions() {
  return {
    t,
    hasWorkspaceSession: (sessionId) => workspaceSessions.has(sessionId),
    appendWorkspaceSessionPreview,
    setWorkspaceSessionPreview,
  };
}

function updateBackgroundWorkspacePreview(data = {}) {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.updateBackgroundWorkspacePreview) {
    workspace.updateBackgroundWorkspacePreview(data, getWorkspaceEventOptions());
    return;
  }
  const sessionId = data.session_id;
  if (!sessionId || !workspaceSessions.has(sessionId)) return;
  if (data.event) {
    appendWorkspacePreviewEvent(sessionId, data.event);
    return;
  }
  const message = data.message;
  if (message?.content) {
    const text = extractMessagePreviewText(message);
    if (text) setWorkspaceSessionPreview(sessionId, text);
  }
}

function appendWorkspacePreviewEvent(sessionId, evt) {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.appendWorkspacePreviewEvent) {
    workspace.appendWorkspacePreviewEvent(sessionId, evt, getWorkspaceEventOptions());
    return;
  }
  if (!evt) return;
  if (evt.type === 'message_start') {
    setWorkspaceSessionPreview(sessionId, '');
    return;
  }
  if (evt.type === 'content_block_delta') {
    const text = evt.delta?.text || evt.delta?.thinking || evt.delta?.partial_json || '';
    if (text) appendWorkspaceSessionPreview(sessionId, text);
    return;
  }
  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    appendWorkspaceSessionPreview(sessionId, `\n> ${evt.content_block.name || t('tool')}\n`);
  }
}

function extractMessagePreviewText(message) {
  const workspace = window.CCBridge?.workspace;
  if (workspace?.extractMessagePreviewText) return workspace.extractMessagePreviewText(message);
  let text = '';
  for (const block of (message.content || [])) {
    if (block.type === 'text' && block.text) text += block.text;
    else if (block.type === 'thinking' && block.thinking) text += block.thinking;
    else if (block.type === 'tool_use' && block.name) text += `\n> ${block.name}\n`;
  }
  return text;
}

function getSseLifecycleOptions() {
  return {
    t,
    messagesEl,
    cwdInput,
    modelSelect,
    remoteTargetSelect,
    getCurrentRunId: () => currentRunId,
    getCurrentSessionId: () => currentSessionId,
    getSessionActive: () => sessionActive,
    getIsViewer: () => isViewer,
    setCurrentRunId: (value) => { currentRunId = value; },
    setCurrentSessionId: (value) => { currentSessionId = value; },
    setSessionActive: (value) => { sessionActive = value; },
    setIsViewer: (value) => { isViewer = value; },
    setIsResponding: (value) => { isResponding = value; },
    setActiveWorkspaceSessionId: (value) => { activeWorkspaceSessionId = value; },
    updateUI,
    getDisplayModelName,
    renderTopbarMeta,
    updateRemoteMutateRow,
    ensureWorkspaceSession,
    updateRuntimeSummary,
    refreshRightPaneFiles,
    showPage,
    loadSessionHistory,
    addSystemMsg,
    isEventForCurrentSession,
    addUserMessage,
    scrollToBottom,
  };
}

function bindSSEEvents(source = eventSource) {
  source.addEventListener('connected', (e) => {
    const data = JSON.parse(e.data);
    clientId = data.client_id;
    setConnectionStatus(true);
  });

  source.addEventListener('session_started', (e) => {
    const data = JSON.parse(e.data);
    return window.CCBridge.sse?.handleSessionStarted?.(data, getSseLifecycleOptions());
  });

  source.addEventListener('session_stopped', (e) => {
    const data = JSON.parse(e.data || '{}');
    return window.CCBridge.sse?.handleSessionStopped?.(data, getSseLifecycleOptions());
  });

  source.addEventListener('session_taken', (e) => {
    const data = JSON.parse(e.data);
    return window.CCBridge.sse?.handleSessionTaken?.(data, getSseLifecycleOptions());
  });

  source.addEventListener('user_message', (e) => {
    const data = JSON.parse(e.data);
    return window.CCBridge.sse?.handleUserMessage?.(data, getSseLifecycleOptions());
  });

  source.addEventListener('generation_started', (e) => {
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
      scrollToBottom(true);
    }
    startTurnTimer();
    updateUI();
  });

  source.addEventListener('system', (e) => {
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

  source.addEventListener('stream_event', (e) => {
    const data = JSON.parse(e.data);
    if (noteBackgroundSessionEvent(data)) return;
    handleStreamEvent(data);
  });

  source.addEventListener('assistant', (e) => {
    const data = JSON.parse(e.data);
    if (noteBackgroundSessionEvent(data)) return;
    handleAssistantFinal(data);
  });

  source.addEventListener('context_injected', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (!isEventForCurrentSession(data)) return;
    renderContextTrace(data.trace || data);
  });

  source.addEventListener('memory_consolidation_completed', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (!isEventForCurrentSession(data)) return;
    const job = data.job || data;
    const written = Number(job.written || 0);
    const skipped = Number(job.skipped || 0);
    if (written > 0) {
      showToast(t('memoryConsolidationSaved', { count: written }), 'success');
      if (typeof loadMemoryFiles === 'function') loadMemoryFiles();
    } else if (skipped > 0 || Number(job.candidates || 0) > 0) {
      showToast(t('memoryConsolidationSkipped'), 'info');
    }
  });

  source.addEventListener('memory_consolidation_failed', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (!isEventForCurrentSession(data)) return;
    const job = data.job || data;
    showToast(t('memoryConsolidationFailed', { error: job.error || '' }), 'error');
  });

  source.addEventListener('session_id_captured', (e) => {
    const data = JSON.parse(e.data);
    if (data.session_id && currentSessionId && data.session_id !== currentSessionId && data.run_id !== currentRunId) {
      scheduleCompletionHistorySync(data.session_id);
      return;
    }
    currentSessionId = data.session_id;
    currentRunId = data.run_id || currentRunId;
    if (activeWorkspaceSessionId && activeWorkspaceSessionId.startsWith('pending-') && activeWorkspaceSessionId !== data.session_id) {
      workspaceSessions.delete(activeWorkspaceSessionId);
      activeWorkspaceSessionId = data.session_id;
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

  source.addEventListener('cwd_changed', (e) => {
    const data = JSON.parse(e.data);
    if (!isEventForCurrentSession(data)) return;
    if (data.cwd) {
      cwdInput.value = data.cwd;
      updateRuntimeSummary();
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

  source.addEventListener('model_changed', (e) => {
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

  source.addEventListener('result', (e) => {
    const data = JSON.parse(e.data);
    if (noteBackgroundSessionEvent(data)) return;
    handleResult(data);
  });

  source.addEventListener('tool_result', (e) => {
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

  source.addEventListener('session_lock_changed', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (data.session_id && currentSessionId && data.session_id !== currentSessionId) return;
    const wasResponding = isResponding;
    isResponding = !!data.locked;
    if (!isResponding && wasResponding) {
      finishCurrentTurnFromProcess();
      updateWorkspaceSessionStatus(data.session_id || currentSessionId, 'done');
      scheduleCompletionHistorySync(data.session_id || currentSessionId);
    }
    updateUI();
  });

  source.addEventListener('process_ended', (e) => {
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

  source.addEventListener('generation_interrupted', (e) => {
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

  source.addEventListener('scheduled_task_started', () => {
    loadScheduledTasks();
  });

  source.addEventListener('scheduled_task_updated', () => {
    loadScheduledTasks();
  });

  source.addEventListener('scheduled_task_finished', () => {
    loadScheduledTasks();
    loadSessions();
  });

  source.addEventListener('scheduled_task_error', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (data.message) showToast(data.message, 'error');
    loadScheduledTasks();
  });

  source.addEventListener('error', (e) => {
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
    if (source.readyState === EventSource.CLOSED) {
      setConnectionStatus(false);
      setTimeout(initSSE, 3000);
    }
  });

  source.onerror = () => {
    setConnectionStatus(false);
    if (isResponding) {
      stopTurnTimer();
      addSystemMsg(t('connectionLost'), true);
    }
  };
}

function getSseOptions() {
  return {
    t,
    connectionStatus,
    topbarConnection,
    getClientId: () => clientId,
    getConnected: () => connectionOnline,
    setConnected: (connected) => { connectionOnline = connected; },
    updateConnectionText,
    renderTopbarStatusSummary,
  };
}

function setConnectionStatus(connected) {
  window.CCBridge.sse?.setConnectionStatus?.(connected, getSseOptions());
  if (btnNewSession) btnNewSession.style.opacity = connected ? '1' : '0.5';
}

function updateConnectionText() {
  return window.CCBridge.sse?.updateConnectionText?.(getSseOptions());
}

// ─── 发送 action ────────────────────────────────────────────
async function sendAction(action, extra = {}) {
  try {
    return await window.CCBridge.sse?.sendActionRequest?.(action, extra, getSseOptions());
  } catch (e) {
    addSystemMsg(t('requestFailed', { message: e.message }), true);
    return null;
  }
}

function getStreamEventOptions() {
  return {
    t,
    isResponding,
    currentSessionId,
    currentAssistantEl,
    currentTurnStartedAt,
    getStreamBlocks: () => streamBlocks,
    setStreamBlocks: (value) => { streamBlocks = value; },
    getCurrentContent: () => currentContent,
    setCurrentContent: (value) => { currentContent = value; },
    setIsResponding: (value) => { isResponding = value; },
    setCurrentTurnHasAssistantOutput: (value) => { currentTurnHasAssistantOutput = value; },
    setCurrentTurnStartedAt: (value) => { currentTurnStartedAt = value; },
    setCurrentAssistantEl: (value) => { currentAssistantEl = value; },
    createAssistantBubble,
    startTurnTimer,
    updateWorkspaceSessionStatus,
    setWorkspaceSessionPreview,
    appendWorkspaceSessionPreview,
    updateUI,
    scheduleRender,
    registerTaskBlocks,
  };
}

// ─── 流式事件处理 ────────────────────────────────────────────
function handleStreamEvent(data) {
  const streamEvents = window.CCBridge?.streamEvents;
  if (streamEvents?.handleStreamEvent) return streamEvents.handleStreamEvent(data, getStreamEventOptions());
  const evt = data.event;
  if (!evt) return;

  if (evt.type === 'message_start') setWorkspaceSessionPreview(currentSessionId, '');
  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    appendWorkspaceSessionPreview(currentSessionId, `\n> ${evt.content_block.name || t('tool')}\n`);
  }

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
        appendWorkspaceSessionPreview(currentSessionId, evt.delta.text || '');
      } else if (evt.delta?.type === 'thinking_delta') {
        block.thinking += evt.delta.thinking || '';
        appendWorkspaceSessionPreview(currentSessionId, evt.delta.thinking || '');
      } else if (evt.delta?.type === 'input_json_delta') {
        block.input += evt.delta.partial_json || '';
        appendWorkspaceSessionPreview(currentSessionId, evt.delta.partial_json || '');
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

function getChatRendererOptions() {
  return {
    esc,
    t,
    renderMd,
    sanitizeLinkHref,
    runningTasks,
    toolResults,
    toolStartTimes,
    addUserMessage,
    renderContextTrace,
    createAssistantBubble,
    scrollToBottom,
  };
}

function getChatRendererState(final = false) {
  return { currentAssistantEl, currentContent, streamBlocks, isResponding, final };
}

function renderCurrentState(final = false) {
  return window.CCBridge.chatRenderer?.renderCurrentState?.(getChatRendererState(final), getChatRendererOptions());
}

function formatToolSummary(block) {
  return window.CCBridge.chatRenderer?.formatToolSummary?.(block);
}

function formatToolBody(block) {
  return window.CCBridge.chatRenderer?.formatToolBody?.(block, getChatRendererOptions());
}

function renderToolCard(block, opts = {}) {
  return window.CCBridge.chatRenderer?.renderToolCard?.(block, opts, getChatRendererOptions());
}

function updateToolResult(toolId, content, isError) {
  return window.CCBridge.chatRenderer?.updateToolResult?.(toolId, content, isError, getChatRendererOptions());
}

function renderStreamingText(text) {
  return window.CCBridge.chatRenderer?.renderStreamingText?.(text, getChatRendererOptions());
}

function renderBlock(block) {
  return window.CCBridge.chatRenderer?.renderBlock?.(block, getChatRendererOptions());
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
  const previewText = extractMessagePreviewText(message);
  if (previewText) setWorkspaceSessionPreview(currentSessionId, previewText);

  const messageId = message.id || data.uuid || '';
  if (currentAssistantEl && currentAssistantMessageId && messageId && currentAssistantMessageId !== messageId) {
    finalizeCurrentAssistantMarkdown();
    finishAssistantStreaming(currentAssistantEl);
    currentAssistantEl = null;
    currentContent = [];
    streamBlocks = {};
  }
  if (!currentAssistantEl) {
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

function getTaskActivityOptions() {
  return {
    t,
    esc,
    renderMd,
    scrollToBottom,
    notifyComplete,
    getDisplayModelName,
    getModelValue: () => modelSelect.value,
    getCurrentAssistantEl: () => currentAssistantEl,
    getIsResponding: () => isResponding,
    scheduleRender,
    runningTasks,
    finishedTaskIds,
    subagentBubbles,
    agentStatusBar: document.getElementById('agent-status-bar'),
    messagesEl,
    colors: SUBAGENT_COLORS,
  };
}

function registerTaskBlocks(content) {
  const taskActivity = window.CCBridge?.taskActivity;
  if (taskActivity?.registerTaskBlocks) return taskActivity.registerTaskBlocks(content, getTaskActivityOptions());
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
  const taskActivity = window.CCBridge?.taskActivity;
  if (taskActivity?.updateTaskActivity) return taskActivity.updateTaskActivity(parentToolUseId, message, getTaskActivityOptions());
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
  const taskActivity = window.CCBridge?.taskActivity;
  if (taskActivity?.finishTasks) return taskActivity.finishTasks(ids, getTaskActivityOptions());
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
  const taskActivity = window.CCBridge?.taskActivity;
  if (taskActivity?.clearRunningTasks) return taskActivity.clearRunningTasks(getTaskActivityOptions(), { keepFinished });
  if (runningTasks.size) {
    runningTasks.clear();
    renderAgentStatus();
  }
  if (!keepFinished) finishedTaskIds.clear();
}

function renderAgentStatus() {
  const taskActivity = window.CCBridge?.taskActivity;
  if (taskActivity?.renderAgentStatus) return taskActivity.renderAgentStatus(getTaskActivityOptions());
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
  const taskActivity = window.CCBridge?.taskActivity;
  if (taskActivity?.getSubagentColor) return taskActivity.getSubagentColor(id, getTaskActivityOptions());
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i);
  return SUBAGENT_COLORS[Math.abs(hash) % SUBAGENT_COLORS.length];
}

function renderSubagentBubble(parentToolUseId, message) {
  const taskActivity = window.CCBridge?.taskActivity;
  if (taskActivity?.renderSubagentBubble) return taskActivity.renderSubagentBubble(parentToolUseId, message, getTaskActivityOptions());
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
  const taskActivity = window.CCBridge?.taskActivity;
  if (taskActivity?.clearSubagentBubbles) return taskActivity.clearSubagentBubbles(getTaskActivityOptions());
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

function getCompletionSyncOptions() {
  return {
    getTimer: () => completionHistorySyncTimer,
    setTimer: (value) => { completionHistorySyncTimer = value; },
    getCurrentSessionId: () => currentSessionId,
    getIsResponding: () => isResponding,
    getCwd: () => cwdInput.value.trim() || '',
    reloadSessionHistory,
  };
}

function getCompletionSyncModule() {
  const mod = window.CCBridge?.completionSync;
  if (!mod) console.error('CCBridge completionSync module is not loaded');
  return mod;
}

function clearCompletionHistorySync() {
  return getCompletionSyncModule()?.clearCompletionHistorySync?.(getCompletionSyncOptions());
}

function scheduleCompletionHistorySync(sessionId) {
  return getCompletionSyncModule()?.scheduleCompletionHistorySync?.(sessionId, getCompletionSyncOptions());
}

function getResultHandlerOptions() {
  return {
    t,
    clearCompletionHistorySync,
    normalizeTokenUsage,
    stopTurnTimer,
    finalizeCurrentAssistantMarkdown,
    updateAssistantMeta,
    removePendingAssistantBubble,
    clearRunningTasks,
    clearSubagentBubbles,
    notifyComplete,
    getDisplayModelName,
    checkMemoryHits,
    updateUI,
    renderCost,
    hasTokenUsage,
    renderTokens,
    addTokenUsage,
    ensureWorkspaceSession,
    addSystemMsg,
    isSlashCommand,
    getSlashCommandName,
    getState: () => ({
      currentTurnContent,
      currentTurnHasAssistantOutput,
      currentTurnStartedAt,
      currentAssistantEl,
      totalCost,
      totalTokens,
      currentSessionId,
    }),
    setState: (state = {}) => {
      if ('isResponding' in state) isResponding = state.isResponding;
      if ('currentAssistantEl' in state) currentAssistantEl = state.currentAssistantEl;
      if ('currentAssistantMessageId' in state) currentAssistantMessageId = state.currentAssistantMessageId;
      if ('currentContent' in state) currentContent = state.currentContent;
      if ('streamBlocks' in state) streamBlocks = state.streamBlocks;
      if ('currentTurnContent' in state) currentTurnContent = state.currentTurnContent;
      if ('currentTurnHasAssistantOutput' in state) currentTurnHasAssistantOutput = state.currentTurnHasAssistantOutput;
      if ('currentTurnStartedAt' in state) currentTurnStartedAt = state.currentTurnStartedAt;
      if ('currentTurnAttachmentCount' in state) currentTurnAttachmentCount = state.currentTurnAttachmentCount;
      if ('totalCost' in state) totalCost = state.totalCost;
      if ('totalTokens' in state) totalTokens = state.totalTokens;
      if ('currentSessionId' in state) currentSessionId = state.currentSessionId;
    },
    modelSelect,
  };
}

function getResultHandlerModule() {
  const mod = window.CCBridge?.resultHandler;
  if (!mod) console.error('CCBridge resultHandler module is not loaded');
  return mod;
}

function handleResult(data) {
  return getResultHandlerModule()?.handleResult?.(data, getResultHandlerOptions());
}

function getMessageUiOptions() {
  return {
    t,
    esc,
    quoteDisplayText,
    scrollToBottom,
    messagesEl,
  };
}

// ─── UI 组件 ─────────────────────────────────────────────────
function createAssistantBubble(streaming = true) {
  return window.CCBridge.messageUi?.createAssistantBubble?.(streaming, getMessageUiOptions());
}

function finishAssistantStreaming(el = currentAssistantEl) {
  return window.CCBridge.messageUi?.finishAssistantStreaming?.(el);
}

function removePendingAssistantBubble(keepBubble) {
  return window.CCBridge.messageUi?.removePendingAssistantBubble?.(currentAssistantEl, keepBubble);
}

function addUserMessage(text, quotes = []) {
  return window.CCBridge.messageUi?.addUserMessage?.(text, quotes, getMessageUiOptions());
}

function addSystemMsg(text, isError) {
  return window.CCBridge.messageUi?.addSystemMsg?.(text, isError, getMessageUiOptions());
}

function renderContextTrace(trace = {}) {
  return window.CCBridge.messageUi?.renderContextTrace?.(trace, getMessageUiOptions());
}

// ─── Toast 通知 ─────────────────────────────────────────────────
function getToastOptions() {
  return { toastContainer: document.getElementById('toast-container') };
}

function showToast(msg, type = 'info', duration = 3000) {
  return window.CCBridge.toast?.showToast?.(msg, type, duration, getToastOptions());
}

function dismissToast(toast) {
  return window.CCBridge.toast?.dismissToast?.(toast);
}

// ─── 输入 ────────────────────────────────────────────────────
const quotePreviewBar = document.getElementById('quote-preview-bar');

function getMessageExtrasOptions() {
  return {
    t,
    esc,
    setVisible,
    addSystemMsg,
    showPage,
    domText,
    messagesEl,
    inputEl,
    quotePreviewBar,
  };
}

function initInput() {
  window.CCBridge.input?.initInput?.();
}

function initModelPill() {
  window.CCBridge.input?.initModelPill?.();
}

function renderModelPill() {
  return window.CCBridge.input?.renderModelPill?.();
}

function scheduleSlashCommandReload() {
  return window.CCBridge.input?.scheduleSlashCommandReload?.();
}

function closeSlashCommandPanel() {
  return window.CCBridge.input?.closeSlashCommandPanel?.();
}

function loadSlashCommands() {
  return window.CCBridge.input?.loadSlashCommands?.();
}

function uploadFiles(files) {
  return window.CCBridge.input?.uploadFiles?.(files);
}

function renderAttachments() {
  return window.CCBridge.input?.renderAttachments?.();
}

function getAttachedFiles() {
  return window.CCBridge.input?.getAttachedFiles?.() || [];
}

function consumeAttachedFiles() {
  return window.CCBridge.input?.consumeAttachedFiles?.() || [];
}

async function copyConversationMarkdown() {
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.copyConversationMarkdown) return messageExtras.copyConversationMarkdown(getMessageExtrasOptions());
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
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.buildConversationMarkdown) return messageExtras.buildConversationMarkdown(getMessageExtrasOptions());
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
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.domText) return messageExtras.domText(el);
  return (el.querySelector('.msg-content') || el).textContent.trim();
}

// ─── 消息引用 ────────────────────────────────────────────────
function hideMsgContextMenu() {
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.hideMsgContextMenu) return messageExtras.hideMsgContextMenu();
  const menu = document.getElementById('msg-context-menu');
  if (menu) { menu.style.display = 'none'; menu.style.visibility = 'hidden'; }
}

function normalizeQuoteEntry(entry) {
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.normalizeQuoteEntry) return messageExtras.normalizeQuoteEntry(entry);
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
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.quoteDisplayText) return messageExtras.quoteDisplayText(entry);
  const quote = normalizeQuoteEntry(entry);
  return quote.text;
}

function quoteIntoInput(text, meta = null) {
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.quoteIntoInput) return messageExtras.quoteIntoInput(text, meta, getMessageExtrasOptions());
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
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.renderQuotePreview) return messageExtras.renderQuotePreview(getMessageExtrasOptions());
  if (!quotePreviewBar) return;
  if (quotedMessages.length === 0) {
    setVisible(quotePreviewBar, false);
    quotePreviewBar.innerHTML = '';
    return;
  }
  setVisible(quotePreviewBar, true, 'flex');
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
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.initMessageContextMenu) return messageExtras.initMessageContextMenu(getMessageExtrasOptions());
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

function getMessageSendOptions() {
  return {
    t,
    addSystemMsg,
    addUserMessage,
    updateUI,
    updateWorkspaceSessionStatus,
    createAssistantBubble,
    startTurnTimer,
    stopTurnTimer,
    renderCurrentState,
    scrollToBottom,
    sendAction,
    removePendingAssistantBubble,
    captureActiveWorkspaceSnapshot,
    quotePayloadForBackend,
    quoteBackendPayload,
    getQuotedMessagesForSend,
    clearQuotedMessagesForSend,
    quoteDisplayText,
    getAttachedFiles,
    consumeAttachedFiles,
    getState: () => ({
      sessionActive,
      isResponding,
      isViewer,
      currentSessionId,
      currentRunId,
      currentAssistantEl,
      currentAssistantMessageId,
      currentContent,
      streamBlocks,
      currentTurnContent,
      currentTurnHasAssistantOutput,
      currentTurnStartedAt,
      currentTurnAttachmentCount,
    }),
    setState: (state = {}) => {
      if ('sessionActive' in state) sessionActive = state.sessionActive;
      if ('isResponding' in state) isResponding = state.isResponding;
      if ('isViewer' in state) isViewer = state.isViewer;
      if ('currentSessionId' in state) currentSessionId = state.currentSessionId;
      if ('currentRunId' in state) currentRunId = state.currentRunId;
      if ('currentAssistantEl' in state) currentAssistantEl = state.currentAssistantEl;
      if ('currentAssistantMessageId' in state) currentAssistantMessageId = state.currentAssistantMessageId;
      if ('currentContent' in state) currentContent = state.currentContent;
      if ('streamBlocks' in state) streamBlocks = state.streamBlocks;
      if ('currentTurnContent' in state) currentTurnContent = state.currentTurnContent;
      if ('currentTurnHasAssistantOutput' in state) currentTurnHasAssistantOutput = state.currentTurnHasAssistantOutput;
      if ('currentTurnStartedAt' in state) currentTurnStartedAt = state.currentTurnStartedAt;
      if ('currentTurnAttachmentCount' in state) currentTurnAttachmentCount = state.currentTurnAttachmentCount;
    },
    inputEl,
    modelSelect,
    cliSelect: document.getElementById('cli-select'),
    remoteTargetSelect,
    remoteAllowMutate,
    memoryAutoInject,
    notifyFeishu,
  };
}

function getMessageSendModule() {
  const mod = window.CCBridge?.messageSend;
  if (!mod) console.error('CCBridge messageSend module is not loaded');
  return mod;
}

function interruptCurrentRun() {
  return getMessageSendModule()?.interruptCurrentRun?.(getMessageSendOptions()) || Promise.resolve(null);
}

function handleGlobalShortcuts(e) {
  return getShortcutsModule()?.handleGlobalShortcuts?.(e, getShortcutsOptions());
}

function quotePayloadForBackend(quotes) {
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.quotePayloadForBackend) return messageExtras.quotePayloadForBackend(quotes);
  return quotes.map(normalizeQuoteEntry).filter(q => q.text || (q.path && q.lines.length));
}

function quoteBackendPayload(quotes) {
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.quoteBackendPayload) return messageExtras.quoteBackendPayload(quotes);
  return quotes.map(normalizeQuoteEntry).map(q => {
    if (q.type === 'file_lines' && q.path && q.lines.length) {
      return { type: 'file_lines', path: q.path, lines: q.lines };
    }
    return { type: 'text', text: q.text };
  }).filter(q => q.text || (q.path && q.lines?.length));
}

function getQuotedMessagesForSend() {
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.getQuotedMessages) return messageExtras.getQuotedMessages();
  return quotedMessages;
}

function clearQuotedMessagesForSend() {
  const messageExtras = window.CCBridge?.messageExtras;
  if (messageExtras?.clearQuotedMessages) return messageExtras.clearQuotedMessages(getMessageExtrasOptions());
  quotedMessages = [];
  renderQuotePreview();
}

async function sendMessage() {
  return getMessageSendModule()?.sendMessage?.(getMessageSendOptions());
}

function isSlashCommand(content) {
  return getMessageSendModule()?.isSlashCommand?.(content) || false;
}

function getSlashCommandName(content) {
  return getMessageSendModule()?.getSlashCommandName?.(content) || '';
}

function getSessionControlOptions() {
  return {
    t,
    addSystemMsg,
    showPage,
    stopTurnTimer,
    clearQuotedMessagesForSend,
    emptyTokenUsage,
    renderTopbarMeta,
    renderCost,
    renderTokens,
    ensureWorkspaceSession,
    refreshRightPaneFiles,
    updateRuntimeSummary,
    sendAction,
    loadSessions,
    getClientId: () => clientId,
    getState: () => ({
      currentAssistantEl,
      currentAssistantMessageId,
      currentContent,
      streamBlocks,
      totalCost,
      totalTokens,
      currentSessionId,
      currentRunId,
      activeWorkspaceSessionId,
    }),
    setState: (state = {}) => {
      if ('currentAssistantEl' in state) currentAssistantEl = state.currentAssistantEl;
      if ('currentAssistantMessageId' in state) currentAssistantMessageId = state.currentAssistantMessageId;
      if ('currentContent' in state) currentContent = state.currentContent;
      if ('streamBlocks' in state) streamBlocks = state.streamBlocks;
      if ('totalCost' in state) totalCost = state.totalCost;
      if ('totalTokens' in state) totalTokens = state.totalTokens;
      if ('currentSessionId' in state) currentSessionId = state.currentSessionId;
      if ('currentRunId' in state) currentRunId = state.currentRunId;
      if ('activeWorkspaceSessionId' in state) activeWorkspaceSessionId = state.activeWorkspaceSessionId;
    },
    messagesEl,
    cwdInput,
    modelSelect,
    remoteTargetSelect,
    remoteAllowMutate,
    memoryAutoInject,
    notifyFeishu,
    skipPermissions: document.getElementById('skip-permissions'),
    cliSelect: document.getElementById('cli-select'),
  };
}

function getSessionControlModule() {
  const mod = window.CCBridge?.sessionControl;
  if (!mod) console.error('CCBridge sessionControl module is not loaded');
  return mod;
}

function resetSessionViewState() {
  return getSessionControlModule()?.resetSessionViewState?.(getSessionControlOptions());
}

function startNewSession() {
  return getSessionControlModule()?.startNewSession?.(getSessionControlOptions());
}

function createNewSession(cwd) {
  return getSessionControlModule()?.createNewSession?.(cwd, getSessionControlOptions());
}

async function startNewSessionFromCwd(cwd) {
  return getSessionControlModule()?.startNewSessionFromCwd?.(cwd, getSessionControlOptions());
}

function getMainUiOptions() {
  return {
    t,
    setSidebarCollapsed,
    getState: () => ({ sessionActive, isResponding, isViewer, sidebarCollapsed }),
    setState: (state = {}) => {
      if ('sidebarCollapsed' in state) sidebarCollapsed = state.sidebarCollapsed;
    },
    btnSend,
    btnStop,
    btnNewSession,
    modelSelect,
    remoteTargetSelect,
    inputEl,
    skipPermissions: document.getElementById('skip-permissions'),
    body: document.body,
    cliSelect: document.getElementById('cli-select'),
  };
}

function getMainUiModule() {
  const mod = window.CCBridge?.mainUi;
  if (!mod) console.error('CCBridge mainUi module is not loaded');
  return mod;
}

function updateUI() {
  return getMainUiModule()?.updateUI?.(getMainUiOptions());
}

function getMessageScrollOptions() {
  return {
    messagesEl,
    requestAnimationFrame,
  };
}

function getMessageScrollModule() {
  const mod = window.CCBridge?.messageScroll;
  if (!mod) console.error('CCBridge messageScroll module is not loaded');
  return mod;
}

function isMessagesNearBottom(threshold = 80) {
  return getMessageScrollModule()?.isMessagesNearBottom?.(threshold, getMessageScrollOptions()) ?? true;
}

function initMessageAutoScroll() {
  return getMessageScrollModule()?.initMessageAutoScroll?.(getMessageScrollOptions());
}

function scrollToBottom(force = false) {
  return getMessageScrollModule()?.scrollToBottom?.(force, getMessageScrollOptions());
}

// ─── 配置页 ──────────────────────────────────────────────────
function loadConfig() {
  return window.CCBridge.config?.loadConfig?.();
}

function initMcpManager() {
  window.CCBridge.integrations?.initMcpManager?.();
}

function loadIntegrations() {
  return window.CCBridge.integrations?.loadIntegrations?.();
}

function loadMcpServers() {
  return window.CCBridge.integrations?.loadMcpServers?.();
}

function setAgentsForIntegrations(agents) {
  window.CCBridge.sessionAgents?.setAgents?.(agents);
  window.CCBridge.agentSkills?.renderAgents?.(agents);
}

window.CCBridge.setAgentsForIntegrations = setAgentsForIntegrations;

function initAgentSkills() {
  window.CCBridge.agentSkills?.init?.();
}

function loadSkills() {
  return window.CCBridge.agentSkills?.loadSkills?.();
}

function renderAgents(agents) {
  return window.CCBridge.agentSkills?.renderAgents?.(agents);
}

function openAgentModal(name = null) {
  return window.CCBridge.agentSkills?.openAgentModal?.(name);
}

function closeAgentModal() {
  return window.CCBridge.agentSkills?.closeAgentModal?.();
}

function saveAgent() {
  return window.CCBridge.agentSkills?.saveAgent?.();
}

function deleteAgentPrompt(name) {
  return window.CCBridge.agentSkills?.deleteAgentPrompt?.(name);
}

function getSessionAgentsOptions() {
  return {
    t,
    esc,
    fetch,
    getClientId: () => clientId,
    quoteIntoInput,
    updateWorkspaceHeader,
    setVisible,
    groupMemberPanel: document.getElementById('group-member-panel'),
    groupMemberList: document.getElementById('group-member-list'),
    agentAddPopover: document.getElementById('agent-add-popover'),
    messageInput: document.getElementById('message-input'),
  };
}

// ─── 会话 Agent 面板 ──────────────────────────────────────────────
async function loadSessionAgents() {
  return window.CCBridge.sessionAgents?.loadSessionAgents?.(getSessionAgentsOptions());
}

async function addSessionAgent(name) {
  return window.CCBridge.sessionAgents?.addSessionAgent?.(name, getSessionAgentsOptions());
}

async function removeSessionAgent(name) {
  return window.CCBridge.sessionAgents?.removeSessionAgent?.(name, getSessionAgentsOptions());
}

function renderSessionAgentsPanel() {
  return window.CCBridge.sessionAgents?.renderSessionAgentsPanel?.(getSessionAgentsOptions());
}

function renderAgentAddPopover() {
  return window.CCBridge.sessionAgents?.renderAgentAddPopover?.(getSessionAgentsOptions());
}

function hideAgentAddPopover() {
  return window.CCBridge.sessionAgents?.hideAgentAddPopover?.(getSessionAgentsOptions());
}

window.CCBridge.appContext = {
  saveGuiSettings,
  shortenPlainPath,
  quoteIntoInput,
  renderAgentAddPopover,
  hideAgentAddPopover,
  addSessionAgent,
  loadSessionAgents,
  getSessionAgents,
};

function getRightPanelModule() {
  const mod = window.CCBridge?.rightPanel;
  if (!mod) console.error('CCBridge rightPanel module is not loaded');
  return mod;
}

function refreshRightPaneFiles() {
  return getRightPanelModule()?.refreshRightPaneFiles?.();
}

function initRightPanel() {
  getRightPanelModule()?.initRightPanel?.();
}

function initFilePreviewPanel() {
  getRightPanelModule()?.initFilePreviewPanel?.();
}

function initDiffPreviewPanel() {
  getRightPanelModule()?.initDiffPreviewPanel?.();
}

function closeDiffPreview() {
  return getRightPanelModule()?.closeDiffPreview?.();
}

function openFilePreview(filePath) {
  return getRightPanelModule()?.openFilePreview?.(filePath);
}

function loadFileTree(path) {
  return getRightPanelModule()?.loadFileTree?.(path);
}

function loadReview(cwd) {
  return getRightPanelModule()?.loadReview?.(cwd);
}

function loadReviewDiff(file, staged) {
  return getRightPanelModule()?.loadReviewDiff?.(file, staged);
}

function switchToSidebarTab(tab) {
  return getRightPanelModule()?.switchToSidebarTab?.(tab);
}

function updateWorkspaceHeader(tab) {
  return getRightPanelModule()?.updateWorkspaceHeader?.(tab);
}

// ─── @提及自动补全 ────────────────────────────────────────────────
function initMentionAutocomplete() {
  window.CCBridge.input?.initMentionAutocomplete?.();
}

function hideMentionPopup() {
  return window.CCBridge.input?.hideMentionPopup?.();
}

function getSessionAgents() {
  return window.CCBridge.sessionAgents?.getSessionAgents?.() || [];
}

window.CCBridge.getSessionAgents = getSessionAgents;

// ─── 会话管理 ─────────────────────────────────────────────────
function syncWorkspaceSessionsFromRecords(sessions) {
  return window.CCBridge.sessions?.syncWorkspaceSessionsFromRecords?.(sessions);
}

async function loadSessions() {
  return window.CCBridge.sessions?.loadSessions?.();
}

async function loadMoreSessions() {
  return window.CCBridge.sessions?.loadMoreSessions?.();
}

function renderLoadMore() {
  return window.CCBridge.sessions?.renderLoadMore?.();
}

function renderWelcomeSessions(sessions) {
  return window.CCBridge.sessions?.renderWelcomeSessions?.(sessions);
}

function getWelcomeRuntimeOptions() {
  return {
    t,
    esc,
    shortenPlainPath,
    openPicker,
    cwdInput,
    modelSelect,
    cliSelect: document.getElementById('cli-select'),
    remoteTargetSelect,
    welcomeRuntimeEl: document.getElementById('welcome-runtime'),
  };
}

function getWelcomeRuntimeModule() {
  const mod = window.CCBridge?.welcomeRuntime;
  if (!mod) console.error('CCBridge welcomeRuntime module is not loaded');
  return mod;
}

function renderWelcomeRuntime() {
  return getWelcomeRuntimeModule()?.renderWelcomeRuntime?.(getWelcomeRuntimeOptions());
}

function renderWelcomeSessionItem(s, isActive) {
  return window.CCBridge.sessions?.renderWelcomeSessionItem?.(s, isActive) || '';
}

function renderSessionList(sessions) {
  return window.CCBridge.sessions?.renderSessionList?.(sessions);
}

function showCwdContextMenu(e, cwd) {
  return window.CCBridge.sessions?.showCwdContextMenu?.(e, cwd);
}

function hideCwdContextMenu() {
  return window.CCBridge.sessions?.hideCwdContextMenu?.();
}

function initCwdContextMenu() {
  return window.CCBridge.sessions?.initCwdContextMenu?.();
}

// ─── 会话迁移弹窗 ────────────────────────────────────────────
async function showMigrateSessionPopover(targetCwd) {
  return window.CCBridge.sessions?.showMigrateSessionPopover?.(targetCwd);
}

function hideMigrateSessionPopover() {
  return window.CCBridge.sessions?.hideMigrateSessionPopover?.();
}

function initMigrateSessionPopover() {
  return window.CCBridge.sessions?.initMigrateSessionPopover?.();
}

async function renameSession(sessionId, title) {
  return window.CCBridge.sessions?.renameSession?.(sessionId, title);
}

function filterSessions(sessions) {
  return window.CCBridge.sessions?.filterSessions?.(sessions) || sessions;
}

function renderSessionItem(s) {
  return window.CCBridge.sessions?.renderSessionItem?.(s) || '';
}

function normalizeCwdKey(cwd) {
  return window.CCBridge.sessions?.normalizeCwdKey?.(cwd) || '__no_cwd__';
}

function isCurrentCwd(cwd) {
  return window.CCBridge.sessions?.isCurrentCwd?.(cwd) || false;
}

// ─── 目录更新辅助函数 ──────────────────────────────────────────
function getSessionCwdOptions() {
  return {
    openPicker,
    cwdInput,
  };
}

function getSessionCwdModule() {
  const mod = window.CCBridge?.sessionCwd;
  if (!mod) console.error('CCBridge sessionCwd module is not loaded');
  return mod;
}

function isCwdError(errorMsg) {
  return getSessionCwdModule()?.isCwdError?.(errorMsg) || false;
}

function promptCwdForSession(oldCwd) {
  return getSessionCwdModule()?.promptCwdForSession?.(oldCwd, getSessionCwdOptions()) || Promise.resolve(null);
}

async function updateSessionCwd(sessionId, newCwd) {
  return getSessionCwdModule()?.updateSessionCwd?.(sessionId, newCwd) || { ok: false, error: 'sessionCwd module is not loaded' };
}

function getSessionResumeOptions() {
  return {
    t,
    addSystemMsg,
    clearQuotedMessagesForSend,
    resetAssistantStreamState,
    normalizeTokenUsage,
    renderTopbarMeta,
    renderCost,
    renderTokens,
    updateRuntimeSummary,
    refreshRightPaneFiles,
    hasModelOption,
    updateRemoteMutateRow,
    renderStaticHistory,
    sendAction,
    isCwdError,
    promptCwdForSession,
    updateSessionCwd,
    updateUI,
    loadSessions,
    getClientId: () => clientId,
    getState: () => ({
      currentAssistantEl,
      currentAssistantMessageId,
      currentContent,
      streamBlocks,
      isResponding,
      currentRunId,
      currentSessionId,
      totalCost,
      totalTokens,
      sessionActive,
    }),
    setState: (state = {}) => {
      if ('currentAssistantEl' in state) currentAssistantEl = state.currentAssistantEl;
      if ('currentAssistantMessageId' in state) currentAssistantMessageId = state.currentAssistantMessageId;
      if ('currentContent' in state) currentContent = state.currentContent;
      if ('streamBlocks' in state) streamBlocks = state.streamBlocks;
      if ('isResponding' in state) isResponding = state.isResponding;
      if ('currentRunId' in state) currentRunId = state.currentRunId;
      if ('currentSessionId' in state) currentSessionId = state.currentSessionId;
      if ('totalCost' in state) totalCost = state.totalCost;
      if ('totalTokens' in state) totalTokens = state.totalTokens;
      if ('sessionActive' in state) sessionActive = state.sessionActive;
    },
    messagesEl,
    cwdInput,
    modelSelect,
    cliSelect: document.getElementById('cli-select'),
    skipPermissions: document.getElementById('skip-permissions'),
    remoteTargetSelect,
    remoteAllowMutate,
    notifyFeishu,
  };
}

function getSessionResumeModule() {
  const mod = window.CCBridge?.sessionResume;
  if (!mod) console.error('CCBridge sessionResume module is not loaded');
  return mod;
}

async function resumeSession(sessionId, cwd, model, savedCost = 0, remoteTargetId = '', savedTokens = null, cli = '') {
  return getSessionResumeModule()?.resumeSession?.(sessionId, cwd, model, savedCost, remoteTargetId, savedTokens, cli, getSessionResumeOptions());
}

function resetAssistantStreamState() {
  return getStreamStateModule()?.resetAssistantStreamState?.(getStreamStateOptions());
}

function getHistoryLoaderOptions() {
  return {
    messagesEl,
    getCwd: () => cwdInput.value.trim() || '',
    getAssistantState: () => ({
      currentAssistantEl,
      currentAssistantMessageId,
      currentContent,
      streamBlocks,
    }),
    setAssistantState: (state = {}) => {
      currentAssistantEl = state.currentAssistantEl;
      currentAssistantMessageId = state.currentAssistantMessageId;
      currentContent = state.currentContent;
      streamBlocks = state.streamBlocks;
    },
    resetAssistantStreamState,
    renderHistory,
    toolResults,
    toolStartTimes,
    captureActiveWorkspaceSnapshot,
    addSystemMsg,
  };
}

function renderStaticHistory(history) {
  const historyLoader = window.CCBridge?.historyLoader;
  if (historyLoader?.renderStaticHistory) return historyLoader.renderStaticHistory(history, getHistoryLoaderOptions());
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
  const historyLoader = window.CCBridge?.historyLoader;
  if (historyLoader?.loadSessionHistory) return historyLoader.loadSessionHistory(sessionId, cwd, getHistoryLoaderOptions());
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
  const historyLoader = window.CCBridge?.historyLoader;
  if (historyLoader?.reloadSessionHistory) return historyLoader.reloadSessionHistory(sessionId, cwd, getHistoryLoaderOptions());
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
  return window.CCBridge.chatRenderer?.renderHistory?.(history, getChatRendererOptions());
}

function renderHistoryToolCard(block) {
  return window.CCBridge.chatRenderer?.renderHistoryToolCard?.(block, getChatRendererOptions());
}

function formatTime(isoStr) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.formatTime) return formatters.formatTime(isoStr, currentLanguage);
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
  return window.CCBridge.chatRenderer?.renderMd?.(text, getChatRendererOptions());
}

function esc(str) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.esc) return formatters.esc(str);
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortenPlainPath(path, maxSegments = 3) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.shortenPlainPath) return formatters.shortenPlainPath(path, maxSegments);
  if (!path) return '';
  const normalized = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= maxSegments) return normalized;
  const prefix = /^[A-Za-z]:$/.test(parts[0]) ? `${parts[0]}/` : '';
  return `.../${prefix}${parts.slice(-maxSegments).join('/')}`;
}

function shortenPath(path, maxSegments = 3) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.shortenPath) return formatters.shortenPath(path, maxSegments);
  return esc(shortenPlainPath(path, maxSegments));
}

function sanitizeLinkHref(href) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.sanitizeLinkHref) return formatters.sanitizeLinkHref(href);
  const value = String(href || '').trim().replace(/&amp;/g, '&');
  if (/^(https?:|mailto:)/i.test(value)) return esc(value);
  return '#';
}

// ─── 目录选择器 ──────────────────────────────────────────────
function getDirectoryPickerOptions() {
  return {
    t,
    esc,
    getParentPath,
    cwdInput,
    pickerOverlay: document.getElementById('dir-picker-overlay'),
    pickerList: document.getElementById('picker-list'),
    pickerCurrentPath: document.getElementById('picker-current-path'),
    pickerUp: document.getElementById('picker-up'),
    pickerClose: document.getElementById('picker-close'),
    pickerSelect: document.getElementById('picker-select'),
    pickerNewdir: document.getElementById('picker-newdir'),
    btnBrowse: document.getElementById('btn-browse'),
    isSessionActive: () => sessionActive,
    getCurrentSessionId: () => currentSessionId,
    promptCwdForSession,
    updateSessionCwd,
    updateRuntimeSummary,
    closeSlashCommandPanel,
    loadSessions,
  };
}

function initDirectoryPicker() {
  return window.CCBridge.directoryPicker?.initDirectoryPicker?.(getDirectoryPickerOptions());
}

function openPicker(initialPath, callback) {
  return window.CCBridge.directoryPicker?.openPicker?.(initialPath, callback, getDirectoryPickerOptions());
}

function closePicker() {
  return window.CCBridge.directoryPicker?.closePicker?.(getDirectoryPickerOptions());
}

async function navigatePicker(path) {
  return window.CCBridge.directoryPicker?.navigatePicker?.(path, getDirectoryPickerOptions());
}

function getParentPath(p) {
  return window.CCBridge.directoryPicker?.getParentPath?.(p) || '/';
}

// ─── 文件选择器 ──────────────────────────────────────────────
function getFilePickerOptions() {
  return {
    t,
    esc,
    api: window.CCBridge?.api,
    getParentPath,
    getAccessContext: () => accessContext,
    getRemoteTargetValue: () => remoteTargetSelect?.value || '',
    getRemoteTargetName,
    addSystemMsg,
    addAttachment: (attachment, render) => window.CCBridge.input?.addAttachment?.(attachment, render),
    renderAttachments,
    filePickerOverlay: document.getElementById('file-picker-overlay'),
    filePickerList: document.getElementById('file-picker-list'),
    filePickerCurrentPath: document.getElementById('file-picker-current-path'),
    filePickerUp: document.getElementById('file-picker-up'),
    filePickerClose: document.getElementById('file-picker-close'),
    filePickerConfirm: document.getElementById('file-picker-confirm'),
    filePickerSelectAll: document.getElementById('file-picker-select-all'),
    filePickerSelectedCount: document.getElementById('file-picker-selected-count'),
    filePickerSearch: document.getElementById('file-picker-search'),
    filePickerTabs: document.getElementById('file-picker-tabs'),
    filePickerLocal: document.getElementById('file-picker-local'),
    filePickerBrowser: document.getElementById('file-picker-browser'),
    filePickerClientChoose: document.getElementById('file-picker-client-choose'),
    filePickerServerBrowse: document.getElementById('file-picker-server-browse'),
    filePickerLocalHint: document.getElementById('file-picker-local-hint'),
    fileInput: document.getElementById('file-input'),
    cwdInput,
  };
}

function initFilePicker() {
  return window.CCBridge.filePicker?.initFilePicker?.(getFilePickerOptions());
}

function normalizeFilePickerMode(mode) {
  return window.CCBridge.filePicker?.normalizeFilePickerMode?.(mode, getFilePickerOptions());
}

function getAttachmentSources() {
  return window.CCBridge.filePicker?.getAttachmentSources?.(getFilePickerOptions()) || [];
}

function openFilePicker(callback) {
  return window.CCBridge.filePicker?.openFilePicker?.(callback, getFilePickerOptions());
}

function renderFilePickerTabs() {
  return window.CCBridge.filePicker?.renderFilePickerTabs?.(getFilePickerOptions());
}

function setFilePickerMode(mode) {
  return window.CCBridge.filePicker?.setFilePickerMode?.(mode, getFilePickerOptions());
}

function closeFilePicker() {
  return window.CCBridge.filePicker?.closeFilePicker?.(getFilePickerOptions());
}

function updateFilePickerCount() {
  return window.CCBridge.filePicker?.updateFilePickerCount?.(getFilePickerOptions());
}

function getVisibleSelectableFilePickerItems() {
  return window.CCBridge.filePicker?.getVisibleSelectableFilePickerItems?.(getFilePickerOptions()) || [];
}

function updateFilePickerSelectAllButton() {
  return window.CCBridge.filePicker?.updateFilePickerSelectAllButton?.(getFilePickerOptions());
}

function toggleSelectAllVisibleFiles() {
  return window.CCBridge.filePicker?.toggleSelectAllVisibleFiles?.(getFilePickerOptions());
}

async function navigateFilePicker(path) {
  return window.CCBridge.filePicker?.navigateFilePicker?.(path, getFilePickerOptions());
}

function handleFilePickerSearchInput() {
  return window.CCBridge.filePicker?.handleFilePickerSearchInput?.(getFilePickerOptions());
}

async function searchFilePicker(keyword) {
  return window.CCBridge.filePicker?.searchFilePicker?.(keyword, getFilePickerOptions());
}

function renderFilePickerItems(items, options = {}) {
  return window.CCBridge.filePicker?.renderFilePickerItems?.(items, options, getFilePickerOptions());
}

function getFileIcon(name) {
  return window.CCBridge.filePicker?.getFileIcon?.(name) || '&#128196;';
}

async function confirmFileSelection() {
  return window.CCBridge.filePicker?.confirmFileSelection?.(getFilePickerOptions());
}

async function cacheRemoteAttachment(filePath, meta) {
  return window.CCBridge.filePicker?.cacheRemoteAttachment?.(filePath, meta, getFilePickerOptions());
}


function getRuntimeModule() {
  const mod = window.CCBridge?.runtime;
  if (!mod) console.error('CCBridge runtime module is not loaded');
  return mod;
}

function hasModelOption(model) {
  return getRuntimeModule()?.hasModelOption?.(model, getRuntimeOptions()) || false;
}

function renderCost() {
  return getRuntimeModule()?.renderCost?.(totalCost, getRuntimeOptions());
}

function emptyTokenUsage() {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.emptyTokenUsage) return formatters.emptyTokenUsage();
  return { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
}

function normalizeTokenUsage(value) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.normalizeTokenUsage) return formatters.normalizeTokenUsage(value);
  const usage = emptyTokenUsage();
  if (!value || typeof value !== 'object') return usage;
  usage.input = readTokenField(value, 'input', 'input_tokens');
  usage.output = readTokenField(value, 'output', 'output_tokens');
  usage.cache_creation = readTokenField(value, 'cache_creation', 'cache_creation_input_tokens', 'cache_creation_tokens');
  usage.cache_read = readTokenField(value, 'cache_read', 'cache_read_input_tokens', 'cache_read_tokens');
  return usage;
}

function readTokenField(value, ...keys) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.readTokenField) return formatters.readTokenField(value, ...keys);
  for (const key of keys) {
    const n = Number(value[key] || 0);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return 0;
}

function addTokenUsage(a, b) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.addTokenUsage) return formatters.addTokenUsage(a, b);
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
  const formatters = window.CCBridge?.formatters;
  if (formatters?.hasTokenUsage) return formatters.hasTokenUsage(usage);
  return tokenUsageTotal(usage) > 0;
}

function tokenUsageTotal(usage) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.tokenUsageTotal) return formatters.tokenUsageTotal(usage);
  const value = normalizeTokenUsage(usage);
  return value.input + value.output + value.cache_creation + value.cache_read;
}

function renderTokens() {
  return getRuntimeModule()?.renderTokens?.(totalTokens, getRuntimeOptions());
}

function formatTokenUsage(usage) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.formatTokenUsage) return formatters.formatTokenUsage(usage, t);
  const value = normalizeTokenUsage(usage);
  const main = value.input + value.output;
  const cache = value.cache_creation + value.cache_read;
  const parts = [];
  if (main > 0) parts.push(formatTokenCount(main));
  if (cache > 0) parts.push(t('cachedTokens', { count: formatTokenCount(cache) }));
  return parts.join(' · ') || '0';
}

function formatTokenCount(value) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.formatTokenCount) return formatters.formatTokenCount(value);
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.trunc(n));
}

function safeJsonParse(text, fallback = null) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.safeJsonParse) return formatters.safeJsonParse(text, fallback);
  try {
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
}

function formatModelName(model) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.formatModelName) return formatters.formatModelName(model);
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
  const formatters = window.CCBridge?.formatters;
  if (formatters?.isDisplayableModel) return formatters.isDisplayableModel(model);
  const value = (model || '').trim();
  return Boolean(value && !/^<[^>]+>$/.test(value));
}

function getDisplayModelName(model, allowSelectedFallback = true) {
  const formatters = window.CCBridge?.formatters;
  if (formatters?.getDisplayModelName) return formatters.getDisplayModelName(model, allowSelectedFallback ? modelSelect?.value : '');
  if (isDisplayableModel(model)) return formatModelName(model);
  const selected = allowSelectedFallback ? modelSelect?.value : '';
  return isDisplayableModel(selected) ? formatModelName(selected) : '';
}

function getRemoteTargetName() {
  return window.CCBridge.remote?.getTargetName?.() || '';
}
