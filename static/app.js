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
function runAsyncTask(task, label = 'Async task') {
  try {
    const result = typeof task === 'function' ? task() : task;
    result?.catch?.((e) => {
      console.warn(`${label} failed:`, e);
    });
    return result;
  } catch (e) {
    console.warn(`${label} failed:`, e);
    return null;
  }
}

function initUnhandledRejectionGuard() {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = String(reason?.message || reason?.httpStatusText || reason || '');
    const isNetworkFailure = reason?.httpStatus === 0
      || reason?.code === 0
      || message.includes('Failed to fetch')
      || message.includes('NetworkError');
    if (!isNetworkFailure) return;
    event.preventDefault();
    console.warn('Network request failed:', reason);
  });
}

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
let contextMenuCwd = '';       // 工作目录右键菜单暂存的 cwd
const cwdInput = document.getElementById('cwd-input');
const connectionStatus = document.getElementById('connection-status');
const costDisplay = document.getElementById('cost-display');
const costValue = document.getElementById('cost-value');
const tokenDisplay = document.getElementById('token-display');
const tokenValue = document.getElementById('token-value');
const inputCliStatus = document.getElementById('input-cli-status');
const inputCwdStatus = document.getElementById('input-cwd-status');
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
  initUnhandledRejectionGuard();
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
  runAsyncTask(loadDefaultCwd, 'Load default cwd');
  runAsyncTask(loadClis, 'Load CLIs');
  runAsyncTask(loadModels, 'Load models');
  runAsyncTask(loadConfig, 'Load config');
  initDirectoryPicker();
  initFilePicker();
  runAsyncTask(loadSessions, 'Load sessions');
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

function getWorkspaceModule() {
  const mod = window.CCBridge?.workspace;
  if (!mod) console.error('CCBridge workspace module is not loaded');
  return mod;
}

function saveWorkspaceState() {
  const workspace = getWorkspaceModule();
  return workspace?.writeState?.(workspace.serializeState({
    mode: workspaceMode,
    activeSessionId: activeWorkspaceSessionId,
    sessions: workspaceSessions,
    widths: workspacePaneWidths,
  }), WORKSPACE_STORAGE_KEY);
}

function loadWorkspaceState() {
  try {
    const workspace = getWorkspaceModule();
    const state = workspace?.readState?.(WORKSPACE_STORAGE_KEY);
    if (!state) return;
    workspaceMode = workspace.normalizeStoredMode(state.mode);
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
  return getWorkspaceModule()?.createSessionRecord?.(sessionId, meta, existing, t);
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
  return getWorkspaceModule()?.previewText?.(session, WORKSPACE_PREVIEW_MAX_CHARS) || '';
}

function appendWorkspaceSessionPreview(sessionId, text) {
  if (!sessionId || !text) return;
  const session = workspaceSessions.get(sessionId);
  const changed = getWorkspaceModule()?.appendPreview?.(session, text, WORKSPACE_PREVIEW_MAX_CHARS);
  if (!changed) return;
  scheduleWorkspacePreviewRender();
}

function setWorkspaceSessionPreview(sessionId, text) {
  if (!sessionId) return;
  const session = workspaceSessions.get(sessionId);
  const changed = getWorkspaceModule()?.setPreview?.(session, text, WORKSPACE_PREVIEW_MAX_CHARS);
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
  return t(getWorkspaceModule()?.statusKey?.(status) || 'workspaceIdle');
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
  return getWorkspaceModule()?.ensureWorkspaceTabsEvents?.(getWorkspaceTabsOptions());
}

function renderWorkspaceTabs() {
  return getWorkspaceModule()?.renderWorkspaceTabs?.(getWorkspaceTabsOptions());
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
  return getWorkspaceModule()?.renderWorkspacePanes?.(getWorkspacePanesOptions());
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
  return getWorkspaceModule()?.ensureLivePaneResizer?.(getWorkspaceResizeOptions());
}

function applyWorkspacePaneWidth(pane, sessionId) {
  return getWorkspaceModule()?.applyPaneWidth?.(pane, sessionId, {
    mode: workspaceMode,
    widths: workspacePaneWidths,
    sessionCount: workspaceSessions.size,
  });
}

function startWorkspaceResize(event, sessionId, pane) {
  return getWorkspaceModule()?.startWorkspaceResize?.(event, sessionId, pane, getWorkspaceResizeOptions());
}

function handleWorkspaceResizeMove(event) {
  return getWorkspaceModule()?.handleWorkspaceResizeMove?.(event, getWorkspaceResizeOptions());
}

function stopWorkspaceResize() {
  return getWorkspaceModule()?.stopWorkspaceResize?.(getWorkspaceResizeOptions());
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

function getFormattersModule() {
  const mod = window.CCBridge?.formatters;
  if (!mod) console.error('CCBridge formatters module is not loaded');
  return mod;
}

function summarizePrompt(text, maxLen = 90) {
  return getFormattersModule()?.summarizePrompt?.(text, maxLen) || '';
}

function formatDuration(ms) {
  return getFormattersModule()?.formatDuration?.(ms, t) || '';
}

function formatCompactDuration(ms) {
  return getFormattersModule()?.formatCompactDuration?.(ms) || '';
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
  return getFormattersModule()?.formatUsd?.(value, t) || '';
}

function getProjectName(cwd, fallback = '') {
  return getFormattersModule()?.getProjectName?.(cwd, fallback) || fallback;
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

function getLocalizationModule() {
  const mod = window.CCBridge?.localization;
  if (!mod) console.error('CCBridge localization module is not loaded');
  return mod;
}

async function applyLanguage(language, persist = true) {
  return getLocalizationModule()?.applyLanguage?.(language, persist, getLocalizationOptions());
}

async function loadLanguageMap(language) {
  return getLocalizationModule()?.loadLanguageMap?.(language, getLocalizationOptions());
}

function renderLocalizedText() {
  return getLocalizationModule()?.renderLocalizedText?.(getLocalizationOptions());
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

function getNavigationModule() {
  const mod = window.CCBridge?.navigation;
  if (!mod) console.error('CCBridge navigation module is not loaded');
  return mod;
}

function showPage(page) {
  return getNavigationModule()?.showPage?.(page, getNavigationOptions());
}

function compareSessionsByPinAndTime(a, b) {
  return window.CCBridge.sessions?.compareSessionsByPinAndTime?.(a, b) || 0;
}

async function openLatestOrNewChatSession() {
  return window.CCBridge.sessions?.openLatestOrNewChatSession?.();
}

function initNavigation() {
  return getNavigationModule()?.initNavigation?.(getNavigationOptions());
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
  return getNavigationModule()?.initMobileLayout?.();
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
  return getWorkspaceModule()?.updateBackgroundWorkspacePreview?.(data, getWorkspaceEventOptions());
}

function appendWorkspacePreviewEvent(sessionId, evt) {
  return getWorkspaceModule()?.appendWorkspacePreviewEvent?.(sessionId, evt, getWorkspaceEventOptions());
}

function extractMessagePreviewText(message) {
  return getWorkspaceModule()?.extractMessagePreviewText?.(message) || '';
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
    // 工具回合里 final assistant 可能使用新的 message.id，但仍属于同一轮回复。
    // 这时应复用当前气泡，否则会得到“工具调用+完成内容”和“完成内容”两个面板。
    const sameTurnFinal = isResponding || currentTurnHasAssistantOutput;
    if (!sameTurnFinal) {
      finalizeCurrentAssistantMarkdown();
      finishAssistantStreaming(currentAssistantEl);
      currentAssistantEl = null;
      currentContent = [];
      streamBlocks = {};
    }
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

function getTaskActivityModule() {
  const mod = window.CCBridge?.taskActivity;
  if (!mod) console.error('CCBridge taskActivity module is not loaded');
  return mod;
}

function registerTaskBlocks(content) {
  return getTaskActivityModule()?.registerTaskBlocks?.(content, getTaskActivityOptions());
}

function updateTaskActivity(parentToolUseId, message) {
  return getTaskActivityModule()?.updateTaskActivity?.(parentToolUseId, message, getTaskActivityOptions());
}

function finishTasks(ids) {
  return getTaskActivityModule()?.finishTasks?.(ids, getTaskActivityOptions());
}

function clearRunningTasks({ keepFinished = false } = {}) {
  return getTaskActivityModule()?.clearRunningTasks?.(getTaskActivityOptions(), { keepFinished });
}

function renderAgentStatus() {
  return getTaskActivityModule()?.renderAgentStatus?.(getTaskActivityOptions());
}

// ─── Subagent 行内消息渲染 ────────────────────────────────────────
// parent_tool_use_id -> DOM element
const subagentBubbles = new Map();
const SUBAGENT_COLORS = ['#c792ea', '#82aaff', '#c3e88d', '#ffcb6b', '#f78c6c', '#89ddff'];

function getSubagentColor(id) {
  return getTaskActivityModule()?.getSubagentColor?.(id, getTaskActivityOptions());
}

function renderSubagentBubble(parentToolUseId, message) {
  return getTaskActivityModule()?.renderSubagentBubble?.(parentToolUseId, message, getTaskActivityOptions());
}

// 清理 subagent 气泡
function clearSubagentBubbles() {
  return getTaskActivityModule()?.clearSubagentBubbles?.(getTaskActivityOptions());
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

function getMessageExtrasModule() {
  const mod = window.CCBridge?.messageExtras;
  if (!mod) console.error('CCBridge messageExtras module is not loaded');
  return mod;
}

async function copyConversationMarkdown() {
  return getMessageExtrasModule()?.copyConversationMarkdown?.(getMessageExtrasOptions());
}

function buildConversationMarkdown() {
  return getMessageExtrasModule()?.buildConversationMarkdown?.(getMessageExtrasOptions()) || '';
}

function domText(el) {
  return getMessageExtrasModule()?.domText?.(el) || '';
}

// ─── 消息引用 ────────────────────────────────────────────────
function hideMsgContextMenu() {
  return getMessageExtrasModule()?.hideMsgContextMenu?.();
}

function normalizeQuoteEntry(entry) {
  return getMessageExtrasModule()?.normalizeQuoteEntry?.(entry) || { type: 'text', text: '', path: '', lines: [] };
}

function quoteDisplayText(entry) {
  return getMessageExtrasModule()?.quoteDisplayText?.(entry) || '';
}

function quoteIntoInput(text, meta = null) {
  return getMessageExtrasModule()?.quoteIntoInput?.(text, meta, getMessageExtrasOptions());
}

function renderQuotePreview() {
  return getMessageExtrasModule()?.renderQuotePreview?.(getMessageExtrasOptions());
}

function initMessageContextMenu() {
  return getMessageExtrasModule()?.initMessageContextMenu?.(getMessageExtrasOptions());
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
  return getMessageExtrasModule()?.quotePayloadForBackend?.(quotes) || [];
}

function quoteBackendPayload(quotes) {
  return getMessageExtrasModule()?.quoteBackendPayload?.(quotes) || [];
}

function getQuotedMessagesForSend() {
  return getMessageExtrasModule()?.getQuotedMessages?.() || [];
}

function clearQuotedMessagesForSend() {
  return getMessageExtrasModule()?.clearQuotedMessages?.(getMessageExtrasOptions());
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
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
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
    fetch: window.fetch.bind(window),
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
    addSystemMsg,
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

function getHistoryLoaderModule() {
  const mod = window.CCBridge?.historyLoader;
  if (!mod) console.error('CCBridge historyLoader module is not loaded');
  return mod;
}

function renderStaticHistory(history) {
  return getHistoryLoaderModule()?.renderStaticHistory?.(history, getHistoryLoaderOptions());
}

async function loadSessionHistory(sessionId, cwd) {
  return getHistoryLoaderModule()?.loadSessionHistory?.(sessionId, cwd, getHistoryLoaderOptions());
}

async function reloadSessionHistory(sessionId, cwd) {
  return getHistoryLoaderModule()?.reloadSessionHistory?.(sessionId, cwd, getHistoryLoaderOptions());
}

function renderHistory(history) {
  return window.CCBridge.chatRenderer?.renderHistory?.(history, getChatRendererOptions());
}

function renderHistoryToolCard(block) {
  return window.CCBridge.chatRenderer?.renderHistoryToolCard?.(block, getChatRendererOptions());
}

function formatTime(isoStr) {
  return getFormattersModule()?.formatTime?.(isoStr, currentLanguage) || '';
}

// ─── Markdown 渲染 ──────────────────────────────────────────
function renderMd(text) {
  return window.CCBridge.chatRenderer?.renderMd?.(text, getChatRendererOptions());
}

function esc(str) {
  return getFormattersModule()?.esc?.(str) || '';
}

function shortenPlainPath(path, maxSegments = 3) {
  return getFormattersModule()?.shortenPlainPath?.(path, maxSegments) || '';
}

function shortenPath(path, maxSegments = 3) {
  return getFormattersModule()?.shortenPath?.(path, maxSegments) || '';
}

function sanitizeLinkHref(href) {
  return getFormattersModule()?.sanitizeLinkHref?.(href) || '#';
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
  return getFormattersModule()?.emptyTokenUsage?.() || { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
}

function normalizeTokenUsage(value) {
  return getFormattersModule()?.normalizeTokenUsage?.(value) || emptyTokenUsage();
}

function readTokenField(value, ...keys) {
  return getFormattersModule()?.readTokenField?.(value, ...keys) || 0;
}

function addTokenUsage(a, b) {
  return getFormattersModule()?.addTokenUsage?.(a, b) || emptyTokenUsage();
}

function hasTokenUsage(usage) {
  return getFormattersModule()?.hasTokenUsage?.(usage) || false;
}

function tokenUsageTotal(usage) {
  return getFormattersModule()?.tokenUsageTotal?.(usage) || 0;
}

function renderTokens() {
  return getRuntimeModule()?.renderTokens?.(totalTokens, getRuntimeOptions());
}

function formatTokenUsage(usage) {
  return getFormattersModule()?.formatTokenUsage?.(usage, t) || '0';
}

function formatTokenCount(value) {
  return getFormattersModule()?.formatTokenCount?.(value) || '0';
}

function safeJsonParse(text, fallback = null) {
  return getFormattersModule()?.safeJsonParse?.(text, fallback) ?? fallback;
}

function formatModelName(model) {
  return getFormattersModule()?.formatModelName?.(model) || '';
}

function isDisplayableModel(model) {
  return getFormattersModule()?.isDisplayableModel?.(model) || false;
}

function getDisplayModelName(model, allowSelectedFallback = true) {
  return getFormattersModule()?.getDisplayModelName?.(model, allowSelectedFallback ? modelSelect?.value : '') || '';
}

function getRemoteTargetName() {
  return window.CCBridge.remote?.getTargetName?.() || '';
}
