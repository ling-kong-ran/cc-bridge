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
const sessionUiStates = new Map();
let _activeRenderSessionId = '';

function createSessionMessagesEl(sessionId) {
  const el = document.createElement('div');
  el.className = 'messages workspace-session-messages';
  el.dataset.sessionId = sessionId || '';
  el.setAttribute('role', 'log');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-relevant', 'additions text');
  return el;
}

function createSessionUiState(sessionId) {
  return {
    sessionId,
    sessionActive: false,
    isResponding: false,
    isViewer: false,
    currentAssistantEl: null,
    currentAssistantMessageId: null,
    currentContent: [],
    streamBlocks: {},
    totalCost: 0,
    totalTokens: emptyTokenUsage(),
    currentSessionId: sessionId,
    currentRunId: null,
    currentTurnContent: '',
    currentTurnHasAssistantOutput: false,
    currentTurnStartedAt: 0,
    currentTurnAttachmentCount: 0,
    runningTasks: new Map(),
    toolResults: new Map(),
    toolStartTimes: new Map(),
    finishedTaskIds: new Set(),
    subagentBubbles: new Map(),
    renderScheduled: false,
    historyLoaded: false,
    historyLoading: false,
    messagesEl: createSessionMessagesEl(sessionId),
  };
}

function getSessionUiState(sessionId) {
  if (!sessionId) return null;
  if (!sessionUiStates.has(sessionId)) sessionUiStates.set(sessionId, createSessionUiState(sessionId));
  return sessionUiStates.get(sessionId);
}

function getRenderSessionId() {
  return _activeRenderSessionId || currentSessionId || activeWorkspaceSessionId || '';
}

function getActiveMessagesEl() {
  return getSessionUiState(getRenderSessionId())?.messagesEl || messagesEl;
}

function applySessionUiState(state) {
  if (!state) return;
  sessionActive = state.sessionActive;
  isResponding = state.isResponding;
  isViewer = state.isViewer;
  currentAssistantEl = state.currentAssistantEl;
  currentAssistantMessageId = state.currentAssistantMessageId;
  currentContent = state.currentContent;
  streamBlocks = state.streamBlocks;
  totalCost = state.totalCost;
  totalTokens = state.totalTokens;
  currentSessionId = state.currentSessionId || state.sessionId;
  currentRunId = state.currentRunId;
  currentTurnContent = state.currentTurnContent;
  currentTurnHasAssistantOutput = state.currentTurnHasAssistantOutput;
  currentTurnStartedAt = state.currentTurnStartedAt;
  currentTurnAttachmentCount = state.currentTurnAttachmentCount;
}

function captureSessionUiState(state) {
  if (!state) return;
  state.sessionActive = sessionActive;
  state.isResponding = isResponding;
  state.isViewer = isViewer;
  state.currentAssistantEl = currentAssistantEl;
  state.currentAssistantMessageId = currentAssistantMessageId;
  state.currentContent = currentContent;
  state.streamBlocks = streamBlocks;
  state.totalCost = totalCost;
  state.totalTokens = totalTokens;
  state.currentSessionId = currentSessionId || state.sessionId;
  state.currentRunId = currentRunId;
  state.currentTurnContent = currentTurnContent;
  state.currentTurnHasAssistantOutput = currentTurnHasAssistantOutput;
  state.currentTurnStartedAt = currentTurnStartedAt;
  state.currentTurnAttachmentCount = currentTurnAttachmentCount;
}

function withSessionUiState(sessionId, fn) {
  const state = getSessionUiState(sessionId || currentSessionId || activeWorkspaceSessionId);
  if (!state) return fn?.();
  const previousRenderSessionId = _activeRenderSessionId;
  const previousSnapshot = {
    sessionActive, isResponding, isViewer, currentAssistantEl, currentAssistantMessageId,
    currentContent, streamBlocks, totalCost, totalTokens, currentSessionId, currentRunId,
    currentTurnContent, currentTurnHasAssistantOutput, currentTurnStartedAt, currentTurnAttachmentCount,
  };
  _activeRenderSessionId = state.sessionId;
  applySessionUiState(state);
  try {
    return fn?.(state);
  } finally {
    captureSessionUiState(state);
    _activeRenderSessionId = previousRenderSessionId;
    sessionActive = previousSnapshot.sessionActive;
    isResponding = previousSnapshot.isResponding;
    isViewer = previousSnapshot.isViewer;
    currentAssistantEl = previousSnapshot.currentAssistantEl;
    currentAssistantMessageId = previousSnapshot.currentAssistantMessageId;
    currentContent = previousSnapshot.currentContent;
    streamBlocks = previousSnapshot.streamBlocks;
    totalCost = previousSnapshot.totalCost;
    totalTokens = previousSnapshot.totalTokens;
    currentSessionId = previousSnapshot.currentSessionId;
    currentRunId = previousSnapshot.currentRunId;
    currentTurnContent = previousSnapshot.currentTurnContent;
    currentTurnHasAssistantOutput = previousSnapshot.currentTurnHasAssistantOutput;
    currentTurnStartedAt = previousSnapshot.currentTurnStartedAt;
    currentTurnAttachmentCount = previousSnapshot.currentTurnAttachmentCount;
    const activeState = getSessionUiState(activeWorkspaceSessionId);
    if (activeState && !_activeRenderSessionId) applySessionUiState(activeState);
  }
}

function routeSessionEvent(data = {}, handler) {
  const sid = data.session_id || currentSessionId || activeWorkspaceSessionId;
  if (!sid) return handler?.();
  ensureWorkspaceSession(sid, { status: data.running === false ? 'idle' : undefined, runId: data.run_id || '' });
  return withSessionUiState(sid, handler);
}

function getSessionScopedMap(name) {
  const state = getSessionUiState(getRenderSessionId());
  return state?.[name] || ({ runningTasks, toolResults, toolStartTimes, finishedTaskIds, subagentBubbles }[name]);
}

function attachSessionMessagesToPane(sessionId, pane) {
  const state = getSessionUiState(sessionId);
  if (!state || !pane) return;
  pane.querySelectorAll(':scope > .messages:not(.workspace-session-messages), :scope > .workspace-snapshot-messages').forEach(el => el.remove());
  let host = pane.querySelector('.workspace-pane-messages-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'workspace-pane-messages-host';
    pane.appendChild(host);
  }
  if (state.messagesEl.parentElement !== host) {
    host.innerHTML = '';
    host.appendChild(state.messagesEl);
  }
}


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
const btnScrollLatest = document.getElementById('btn-scroll-latest');
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
const btnDesktopMinimize = document.getElementById('btn-desktop-minimize');
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
const modelPill = document.getElementById('model-pill');
const btnSessionPin = document.getElementById('btn-session-pin');
const btnSessionCwd = document.getElementById('btn-session-cwd');
const btnSessionRename = document.getElementById('btn-session-rename');
const btnSessionDelete = document.getElementById('btn-session-delete');
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
const workflowState = {
  initialized: false,
  loading: false,
  workflows: [],
  runs: [],
  selectedWorkflowId: '',
  selectedNodeId: '',
  currentRun: null,
  nodeStatuses: {},
  nodeOutputs: {},
  log: [],
  backendAvailable: true,
  connectFromNodeId: '',
  selectedEdgeId: '',
  dragging: null,
};

function getDesktopWindowModule() {
  const mod = window.CCBridge?.desktopWindow;
  if (!mod) console.error('CCBridge desktopWindow module is not loaded');
  return mod;
}

function initDesktopWindowControls() {
  return getDesktopWindowModule()?.initDesktopWindowControls?.({ btnDesktopMinimize, btnDesktopClose, desktop: window.ccBridgeDesktop });
}

// ─── 初始化 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initUnhandledRejectionGuard();
  initDesktopWindowControls();
  initShortcutsHelp();
  initInterfaceSettings();
  initNotifications();
  initMemoryAutoInjectControl();
  initMemoryAssistantModelControl();
  initMemoryAutoConsolidateControl();
  initSkipPermissionsControl();
  initLanAccessControl();
  await loadThemePreference();
  initNavigation();
  initTopbarSessionActions();
  initMobileLayout();
  initSSE();
  initMessageAutoScroll();
  initInput();
  initImageGeneration();
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
  if (!sessionId) {
    renderWorkspace();
    return;
  }
  if (sessionId === activeWorkspaceSessionId) {
    const session = workspaceSessions.get(sessionId);
    renderWorkspace();
    ensureSessionHistoryLoaded(sessionId, session?.cwd || cwdInput?.value?.trim() || '');
    updateUI();
    return;
  }
  captureActiveWorkspaceSnapshot();
  const previousSessionId = activeWorkspaceSessionId;
  if (previousSessionId) captureSessionUiState(getSessionUiState(previousSessionId));
  activeWorkspaceSessionId = sessionId;
  const state = getSessionUiState(sessionId);
  applySessionUiState(state);
  currentSessionId = sessionId;
  releaseInactiveWorkspaceSession(previousSessionId);
  const session = workspaceSessions.get(sessionId);
  if (session) {
    session.released = false;
    if (opts.resume !== false) {
      resumeSession(session.sessionId, session.cwd, session.model, session.cost || 0, session.remoteTargetId || '', session.tokens || null, session.cli || '');
    }
  }
  renderWorkspace();
  updateUI();
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
  workspacePanesEl.classList.toggle('workspace-card-grid', workspaceMode === 'grid' && workspaceSessions.size > 2);
  attachSessionMessagesToPane(activeWorkspaceSessionId, workspaceLivePane);
  // grid 模式下自动加载非活跃 session 的历史，避免空白 pane
  if (workspaceMode === 'grid') {
    for (const [sid, ws] of workspaceSessions) {
      if (sid === activeWorkspaceSessionId) continue;
      ensureSessionHistoryLoaded(sid, ws.cwd || '');
    }
  }
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
    attachSessionMessagesToPane,
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

function initMemoryAssistantModelControl() {
  window.CCBridge.settings?.initMemoryAssistantModelControl?.();
}

function applyMemoryAssistantModelPreference(value) {
  window.CCBridge.settings?.applyMemoryAssistantModelPreference?.(value);
}

function initMemoryAutoConsolidateControl() {
  window.CCBridge.settings?.initMemoryAutoConsolidateControl?.();
}

function applyMemoryAutoConsolidatePreference(value) {
  window.CCBridge.settings?.applyMemoryAutoConsolidatePreference?.(value);
}

function initSkipPermissionsControl() {
  window.CCBridge.settings?.initSkipPermissionsControl?.();
}

function applySkipPermissionsPreference(value) {
  window.CCBridge.settings?.applySkipPermissionsPreference?.(value);
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

function loadThemePreference() {
  return window.CCBridge.settings?.loadThemePreference?.();
}

function saveGuiSettings(settings) {
  return window.CCBridge.settings?.saveGuiSettings?.(settings);
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
    topbarModel: modelPill,
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
  window.CCBridge.cliUpdate?.initUpdateModal?.(getCliUpdateOptions());

  // 桌面端：监听更新事件，立即更新左下角 badge
  if (window.ccBridgeDesktop?.onUpdateAvailable) {
    window.ccBridgeDesktop.onUpdateAvailable(info => {
      updateInfo = { ok: true, has_update: true, local: '', remote: info.version || '', commits: info.commits || '' };
      window.CCBridge.cliUpdate?.renderNavVersionBadge?.(updateInfo);
    });
  }
  if (window.ccBridgeDesktop?.onUpdateDownloaded) {
    window.ccBridgeDesktop.onUpdateDownloaded(info => {
      updateInfo = { ok: true, has_update: true, local: '', remote: info.version || '', downloaded: true };
      window.CCBridge.cliUpdate?.renderNavVersionBadge?.(updateInfo);
    });
  }
}

async function loadModels() {
  return getRuntimeModule()?.loadModels?.(getRuntimeOptions());
}

// ─── 导航 ────────────────────────────────────────────────────
function workflowSampleDefinitions() {
  return [{
    id: 'wf-code-change-preview',
    name: t('workflowSampleCodeChange'),
    description: t('workflowSampleCodeChangeDesc'),
    status: 'idle',
    nodes: [
      { id: 'start', type: 'start', title: 'Start', config: { note: '入口节点' } },
      { id: 'analyze', type: 'agent', title: 'Analyze request', config: { prompt: '分析当前任务、git diff 与风险。', output_key: 'analysis' } },
      { id: 'implement', type: 'agent', title: 'Implement changes', config: { prompt: '根据分析结果修改代码。', output_key: 'implementation' } },
      { id: 'test', type: 'condition', title: 'Need tests?', config: { expression: "outputs.analysis.summary contains '测试'" } },
      { id: 'approval', type: 'approval', title: 'Human approval', config: { message: '高风险动作前暂停并等待人工确认。' } },
      { id: 'end', type: 'end', title: 'Done', config: {} },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'analyze' }, { id: 'e2', from: 'analyze', to: 'implement' },
      { id: 'e3', from: 'implement', to: 'test' }, { id: 'e4', from: 'test', to: 'approval', when: 'true' },
      { id: 'e5', from: 'approval', to: 'end' },
    ],
  }];
}

function workflowEls() {
  return {
    list: document.getElementById('workflow-list'), search: document.getElementById('workflow-search'),
    title: document.getElementById('workflow-canvas-title'), summary: document.getElementById('workflow-canvas-summary'),
    edges: document.getElementById('workflow-edges'), nodes: document.getElementById('workflow-nodes'), empty: document.getElementById('workflow-empty'), canvas: document.getElementById('workflow-canvas'),
    inspectorTitle: document.getElementById('workflow-inspector-title'), inspectorStatus: document.getElementById('workflow-inspector-status'), inspectorBody: document.getElementById('workflow-inspector-body'),
    runId: document.getElementById('workflow-run-id'), runStatus: document.getElementById('workflow-run-status'), runProgress: document.getElementById('workflow-run-progress'), runCost: document.getElementById('workflow-run-cost'), status: document.getElementById('workflow-status-message'),
    log: document.getElementById('workflow-log'), progress: document.getElementById('workflow-progress-bar'), timelineTitle: document.getElementById('workflow-timeline-title'),
    approval: document.getElementById('workflow-approval-card'), approvalMsg: document.getElementById('workflow-approval-message'),
  };
}

function currentWorkflow() {
  return workflowState.workflows.find(w => w.id === workflowState.selectedWorkflowId) || workflowState.workflows[0] || null;
}

async function workflowFetchJson(url, options = {}) {
  const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.status === 204 ? null : resp.json();
}

function initWorkflowsUI() {
  if (workflowState.initialized) return;
  workflowState.initialized = true;
  document.getElementById('btn-workflows-refresh')?.addEventListener('click', () => loadWorkflowsPage(true));
  document.getElementById('btn-workflow-run')?.addEventListener('click', runSelectedWorkflow);
  document.getElementById('btn-workflow-cancel')?.addEventListener('click', cancelWorkflowRun);
  document.getElementById('btn-workflow-approve')?.addEventListener('click', () => approveWorkflowRun(true));
  document.getElementById('btn-workflow-approve-card')?.addEventListener('click', () => approveWorkflowRun(true));
  document.getElementById('btn-workflow-reject-card')?.addEventListener('click', () => approveWorkflowRun(false));
  document.getElementById('btn-workflow-save')?.addEventListener('click', saveSelectedWorkflowDraft);
  document.getElementById('btn-workflow-template')?.addEventListener('click', () => showToast(t('workflowTemplateHint'), 'info'));
  document.getElementById('btn-workflow-add-node')?.addEventListener('click', addWorkflowNode);
  document.getElementById('btn-workflow-delete-node')?.addEventListener('click', deleteSelectedWorkflowNode);
  document.getElementById('btn-workflow-connect')?.addEventListener('click', toggleWorkflowConnectMode);
  document.getElementById('btn-workflow-clear-log')?.addEventListener('click', () => { workflowState.log = []; renderWorkflowLog(); });
  document.getElementById('workflow-search')?.addEventListener('input', renderWorkflowList);
  window.addEventListener('pointermove', onWorkflowPointerMove);
  window.addEventListener('pointerup', onWorkflowPointerUp);
}

async function loadWorkflowsPage(force = false) {
  initWorkflowsUI();
  if (workflowState.loading || (workflowState.workflows.length && !force)) { renderWorkflowsPage(); return; }
  workflowState.loading = true;
  const els = workflowEls();
  if (els.status) { els.status.textContent = t('loading'); els.status.className = 'workflow-status-message'; }
  try {
    const [defs, runs] = await Promise.all([
      workflowFetchJson('/api/workflows'),
      workflowFetchJson('/api/workflows/runs').catch(() => []),
    ]);
    const list = Array.isArray(defs) ? defs : (Array.isArray(defs?.workflows) ? defs.workflows : []);
    workflowState.workflows = list.length ? list : workflowSampleDefinitions();
    workflowState.runs = Array.isArray(runs) ? runs : (Array.isArray(runs?.runs) ? runs.runs : []);
    workflowState.backendAvailable = true;
    if (!workflowState.selectedWorkflowId || !workflowState.workflows.some(w => w.id === workflowState.selectedWorkflowId)) workflowState.selectedWorkflowId = workflowState.workflows[0]?.id || '';
    if (els.status) { els.status.textContent = list.length ? t('workflowLoaded') : t('workflowNoWorkflowsUsingPreview'); els.status.className = 'workflow-status-message success'; }
  } catch (e) {
    workflowState.backendAvailable = false;
    workflowState.workflows = workflowState.workflows.length ? workflowState.workflows : workflowSampleDefinitions();
    workflowState.selectedWorkflowId = workflowState.selectedWorkflowId || workflowState.workflows[0]?.id || '';
    if (els.status) { els.status.textContent = t('workflowBackendUnavailable'); els.status.className = 'workflow-status-message error'; }
  } finally {
    workflowState.loading = false;
    renderWorkflowsPage();
  }
}

function renderWorkflowsPage() {
  renderWorkflowList(); renderWorkflowCanvas(); renderWorkflowInspector(); renderWorkflowRunbar(); renderWorkflowLog();
}

function renderWorkflowList() {
  const els = workflowEls();
  if (!els.list) return;
  const q = (els.search?.value || '').trim().toLowerCase();
  const items = workflowState.workflows.filter(w => !q || `${w.name || ''} ${w.description || ''}`.toLowerCase().includes(q));
  if (!items.length) { els.list.innerHTML = `<p class="empty-state">${esc(t('workflowNoWorkflows'))}</p>`; return; }
  els.list.innerHTML = items.map(w => `<article class="workflow-card ${w.id === workflowState.selectedWorkflowId ? 'active' : ''}" data-workflow-id="${esc(w.id)}"><h4>${esc(w.name || w.id)}</h4><p>${esc(w.description || t('workflowNoDescription'))}</p><div class="workflow-card-meta"><span>${esc(w.status || 'idle')}</span><span>${(w.nodes || []).length} nodes</span></div></article>`).join('');
  els.list.querySelectorAll('.workflow-card').forEach(card => card.addEventListener('click', () => { workflowState.selectedWorkflowId = card.dataset.workflowId || ''; workflowState.selectedNodeId = ''; workflowState.nodeStatuses = {}; workflowState.nodeOutputs = {}; renderWorkflowsPage(); }));
}

function markWorkflowDirty() {
  const wf = currentWorkflow();
  if (wf) wf.updated_at = Date.now() / 1000;
}

function workflowNodeLayout(nodes) {
  return nodes.reduce((acc, node, idx) => {
    const saved = node.position || node.ui?.position;
    if (saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))) acc[node.id] = { x: Number(saved.x), y: Number(saved.y) };
    else { const col = idx % 3; const row = Math.floor(idx / 3); acc[node.id] = { x: 44 + col * 245, y: 44 + row * 150 }; }
    return acc;
  }, {});
}

function workflowNodeStatus(nodeId) {
  return workflowState.nodeStatuses[nodeId] || 'pending';
}

function workflowNodeInput(pos) {
  return { x: pos.x, y: pos.y + 54 };
}

function workflowNodeOutput(pos) {
  return { x: pos.x + 190, y: pos.y + 54 };
}

function renderWorkflowCanvas() {
  const wf = currentWorkflow(); const els = workflowEls();
  if (!els.nodes || !els.edges) return;
  const nodes = wf?.nodes || []; const edges = wf?.edges || []; const layout = workflowNodeLayout(nodes);
  if (els.title) els.title.textContent = wf?.name || '—';
  if (els.summary) els.summary.textContent = `${nodes.length} nodes · ${edges.length} edges${workflowState.connectFromNodeId ? ' · connect mode' : ''}`;
  if (els.empty) els.empty.style.display = nodes.length ? 'none' : '';
  const maxX = Math.max(760, ...Object.values(layout).map(p => p.x + 260));
  const maxY = Math.max(430, ...Object.values(layout).map(p => p.y + 180));
  els.nodes.style.minWidth = els.edges.style.minWidth = `${maxX}px`; els.nodes.style.minHeight = els.edges.style.minHeight = `${maxY}px`;
  els.edges.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
  els.edges.innerHTML = edges.map(edge => {
    const a = layout[edge.from], b = layout[edge.to]; if (!a || !b) return '';
    const start = workflowNodeOutput(a), end = workflowNodeInput(b);
    const active = ['succeeded', 'done', 'running', 'paused'].includes(workflowNodeStatus(edge.from));
    const selected = edge.id === workflowState.selectedEdgeId;
    return `<g class="workflow-edge ${selected ? 'selected' : ''}" data-edge-id="${esc(edge.id || '')}"><path class="workflow-edge-hit" d="M${start.x} ${start.y} C${start.x + 55} ${start.y}, ${end.x - 55} ${end.y}, ${end.x} ${end.y}"></path><path class="workflow-edge-path ${active ? 'active' : ''} ${edge.when ? 'approval' : ''}" d="M${start.x} ${start.y} C${start.x + 55} ${start.y}, ${end.x - 55} ${end.y}, ${end.x} ${end.y}"></path>${edge.when ? `<text class="workflow-edge-label" x="${(start.x + end.x) / 2}" y="${(start.y + end.y) / 2 - 8}">${esc(edge.when)}</text>` : ''}</g>`;
  }).join('');
  els.nodes.innerHTML = nodes.map((node, idx) => {
    const pos = layout[node.id]; const status = workflowNodeStatus(node.id); const selected = node.id === workflowState.selectedNodeId; const connecting = node.id === workflowState.connectFromNodeId;
    return `<article class="workflow-node-card ${status} ${selected ? 'selected' : ''} ${connecting ? 'connecting' : ''}" data-node-id="${esc(node.id)}" style="left:${pos.x}px;top:${pos.y}px"><button class="workflow-port workflow-port-in" type="button" data-port="in" title="Connect to this node"></button><button class="workflow-port workflow-port-out" type="button" data-port="out" title="Connect from this node"></button><div class="workflow-node-topline"><span class="workflow-node-type">${String(idx + 1).padStart(2, '0')} · ${esc(node.type || 'node')}</span><span class="workflow-node-dot ${status}"></span></div><div class="workflow-node-title">${esc(node.title || node.id)}</div><div class="workflow-node-desc">${esc(node.config?.prompt || node.config?.expression || node.config?.message || node.type || '')}</div><div class="workflow-node-meta">${esc(status)}</div></article>`;
  }).join('');
  els.edges.querySelectorAll('.workflow-edge').forEach(edge => edge.addEventListener('click', () => { workflowState.selectedEdgeId = edge.dataset.edgeId || ''; workflowState.selectedNodeId = ''; renderWorkflowCanvas(); renderWorkflowInspector(); }));
  els.nodes.querySelectorAll('.workflow-node-card').forEach(card => {
    card.addEventListener('click', event => { if (!event.target?.classList?.contains('workflow-port')) handleWorkflowNodeClick(card.dataset.nodeId || ''); });
    card.addEventListener('pointerdown', event => startWorkflowNodeDrag(event, card.dataset.nodeId || ''));
  });
  els.nodes.querySelectorAll('.workflow-port-out').forEach(port => port.addEventListener('click', event => {
    event.stopPropagation();
    const nodeId = port.closest('.workflow-node-card')?.dataset.nodeId || '';
    workflowState.connectFromNodeId = nodeId;
    workflowState.selectedNodeId = nodeId;
    workflowState.selectedEdgeId = '';
    renderWorkflowCanvas(); renderWorkflowInspector();
  }));
  els.nodes.querySelectorAll('.workflow-port-in').forEach(port => port.addEventListener('click', event => {
    event.stopPropagation();
    const nodeId = port.closest('.workflow-node-card')?.dataset.nodeId || '';
    if (workflowState.connectFromNodeId && workflowState.connectFromNodeId !== nodeId) {
      addWorkflowEdge(workflowState.connectFromNodeId, nodeId);
      workflowState.connectFromNodeId = '';
      workflowState.selectedNodeId = nodeId;
      workflowState.selectedEdgeId = '';
      renderWorkflowCanvas(); renderWorkflowInspector();
    } else handleWorkflowNodeClick(nodeId);
  }));
}

function handleWorkflowNodeClick(nodeId) {
  if (!nodeId) return;
  if (workflowState.dragging) return;
  if (workflowState.connectFromNodeId && workflowState.connectFromNodeId !== nodeId) {
    addWorkflowEdge(workflowState.connectFromNodeId, nodeId);
    workflowState.connectFromNodeId = '';
  }
  workflowState.selectedNodeId = nodeId;
  workflowState.selectedEdgeId = '';
  renderWorkflowCanvas(); renderWorkflowInspector();
}

function startWorkflowNodeDrag(event, nodeId) {
  if (!nodeId || event.target?.classList?.contains('workflow-port')) return;
  const wf = currentWorkflow(); const node = (wf?.nodes || []).find(n => n.id === nodeId); const els = workflowEls();
  if (!node || !els.canvas) return;
  const pos = workflowNodeLayout(wf.nodes)[nodeId];
  workflowState.dragging = { nodeId, startX: event.clientX, startY: event.clientY, originX: pos.x, originY: pos.y };
  workflowState.selectedNodeId = nodeId; workflowState.selectedEdgeId = '';
  event.currentTarget.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function onWorkflowPointerMove(event) {
  const drag = workflowState.dragging; if (!drag) return;
  const wf = currentWorkflow(); const node = (wf?.nodes || []).find(n => n.id === drag.nodeId); if (!node) return;
  node.position = { x: Math.max(12, Math.round(drag.originX + event.clientX - drag.startX)), y: Math.max(12, Math.round(drag.originY + event.clientY - drag.startY)) };
  markWorkflowDirty();
  renderWorkflowCanvas();
}

function onWorkflowPointerUp() {
  if (!workflowState.dragging) return;
  workflowState.dragging = null;
  renderWorkflowCanvas(); renderWorkflowInspector();
}

function uniqueWorkflowNodeId(type) {
  const wf = currentWorkflow(); const used = new Set((wf?.nodes || []).map(n => n.id));
  let i = 1; let id = `${type || 'node'}-${i}`;
  while (used.has(id)) id = `${type || 'node'}-${++i}`;
  return id;
}

function addWorkflowNode() {
  const wf = currentWorkflow(); if (!wf) return;
  wf.nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const id = uniqueWorkflowNodeId('agent');
  const node = { id, type: 'agent', title: 'New agent', position: { x: 80 + wf.nodes.length * 24, y: 80 + wf.nodes.length * 18 }, config: { prompt: '描述这个节点要完成的任务。', output_key: id, mode: 'mock' } };
  wf.nodes.push(node);
  workflowState.selectedNodeId = id; workflowState.selectedEdgeId = ''; markWorkflowDirty(); renderWorkflowsPage();
}

function deleteSelectedWorkflowNode() {
  const wf = currentWorkflow(); const nodeId = workflowState.selectedNodeId; if (!wf || !nodeId) return;
  wf.nodes = (wf.nodes || []).filter(n => n.id !== nodeId);
  wf.edges = (wf.edges || []).filter(e => e.from !== nodeId && e.to !== nodeId);
  delete workflowState.nodeStatuses[nodeId]; delete workflowState.nodeOutputs[nodeId];
  workflowState.selectedNodeId = wf.nodes[0]?.id || ''; workflowState.selectedEdgeId = ''; workflowState.connectFromNodeId = ''; markWorkflowDirty(); renderWorkflowsPage();
}

function toggleWorkflowConnectMode() {
  if (workflowState.connectFromNodeId) workflowState.connectFromNodeId = '';
  else workflowState.connectFromNodeId = workflowState.selectedNodeId || currentWorkflow()?.nodes?.[0]?.id || '';
  renderWorkflowCanvas();
}

function addWorkflowEdge(from, to) {
  const wf = currentWorkflow(); if (!wf || !from || !to || from === to) return;
  wf.edges = Array.isArray(wf.edges) ? wf.edges : [];
  if (wf.edges.some(e => e.from === from && e.to === to)) return;
  wf.edges.push({ id: `edge-${Date.now().toString(36)}`, from, to });
  markWorkflowDirty();
}

function updateSelectedWorkflowNodeConfig(key, value) {
  const wf = currentWorkflow(); const node = (wf?.nodes || []).find(n => n.id === workflowState.selectedNodeId); if (!node) return;
  node.config = node.config || {};
  if (value === '') delete node.config[key]; else node.config[key] = value;
  markWorkflowDirty(); renderWorkflowCanvas(); renderWorkflowInspector();
}

function updateSelectedWorkflowEdge(key, value) {
  const wf = currentWorkflow(); const edge = (wf?.edges || []).find(e => e.id === workflowState.selectedEdgeId); if (!edge) return;
  if (value === '') delete edge[key]; else edge[key] = value;
  markWorkflowDirty(); renderWorkflowCanvas(); renderWorkflowInspector();
}

function deleteSelectedWorkflowEdge() {
  const wf = currentWorkflow(); if (!wf || !workflowState.selectedEdgeId) return;
  wf.edges = (wf.edges || []).filter(e => e.id !== workflowState.selectedEdgeId);
  workflowState.selectedEdgeId = ''; markWorkflowDirty(); renderWorkflowsPage();
}

function renderWorkflowInspector() {
  const wf = currentWorkflow(); const els = workflowEls();
  const edge = (wf?.edges || []).find(e => e.id === workflowState.selectedEdgeId);
  const node = edge ? null : ((wf?.nodes || []).find(n => n.id === workflowState.selectedNodeId) || (wf?.nodes || [])[0]);
  if (edge) {
    if (els.inspectorTitle) els.inspectorTitle.textContent = 'Edge';
    if (els.inspectorStatus) { els.inspectorStatus.textContent = edge.when || 'default'; els.inspectorStatus.className = 'workflow-node-pill'; }
    if (els.inspectorBody) els.inspectorBody.innerHTML = `<section class="workflow-inspector-section"><h4>Edge config</h4><label class="workflow-form-row"><span>From</span><input class="input" value="${esc(edge.from || '')}" readonly></label><label class="workflow-form-row"><span>To</span><input class="input" value="${esc(edge.to || '')}" readonly></label><label class="workflow-form-row"><span>When</span><select class="select" data-edge-field="when"><option value="" ${!edge.when ? 'selected' : ''}>default</option><option value="true" ${edge.when === 'true' ? 'selected' : ''}>true</option><option value="false" ${edge.when === 'false' ? 'selected' : ''}>false</option><option value="approved" ${edge.when === 'approved' ? 'selected' : ''}>approved</option><option value="succeeded" ${edge.when === 'succeeded' ? 'selected' : ''}>succeeded</option></select></label><button class="btn btn-danger btn-medium" type="button" id="btn-workflow-delete-edge">Delete edge</button></section>`;
    els.inspectorBody.querySelector('[data-edge-field="when"]')?.addEventListener('change', e => updateSelectedWorkflowEdge('when', e.target.value));
    els.inspectorBody.querySelector('#btn-workflow-delete-edge')?.addEventListener('click', deleteSelectedWorkflowEdge);
    if (els.approval) els.approval.hidden = true;
    return;
  }
  if (!node) { if (els.inspectorBody) els.inspectorBody.innerHTML = `<p class="empty-state">${esc(t('workflowSelectNode'))}</p>`; return; }
  workflowState.selectedNodeId = workflowState.selectedNodeId || node.id;
  const status = workflowNodeStatus(node.id);
  if (els.inspectorTitle) els.inspectorTitle.textContent = node.title || node.id;
  if (els.inspectorStatus) { els.inspectorStatus.textContent = status; els.inspectorStatus.className = `workflow-node-pill ${status}`; }
  const cfg = node.config || {}; const output = workflowState.nodeOutputs[node.id] || {};
  if (els.inspectorBody) {
    els.inspectorBody.innerHTML = `<section class="workflow-inspector-section"><h4>${esc(t('workflowNodeConfig'))}</h4><label class="workflow-form-row"><span>ID</span><input class="input" data-node-field="id" value="${esc(node.id)}"></label><label class="workflow-form-row"><span>Title</span><input class="input" data-node-field="title" value="${esc(node.title || '')}"></label><label class="workflow-form-row"><span>Type</span><select class="select" data-node-field="type">${['start','agent','command','condition','approval','artifact','end'].map(type => `<option value="${type}" ${node.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label><label class="workflow-form-row"><span>Prompt</span><textarea class="input" rows="4" data-config-field="prompt">${esc(cfg.prompt || '')}</textarea></label><label class="workflow-form-row"><span>Expression</span><input class="input" data-config-field="expression" value="${esc(cfg.expression || '')}"></label><label class="workflow-form-row"><span>Message</span><input class="input" data-config-field="message" value="${esc(cfg.message || '')}"></label><label class="workflow-form-row"><span>Output key</span><input class="input" data-config-field="output_key" value="${esc(cfg.output_key || '')}"></label><label class="workflow-form-row"><span>Mode</span><select class="select" data-config-field="mode"><option value="" ${!cfg.mode ? 'selected' : ''}>default</option><option value="mock" ${cfg.mode === 'mock' ? 'selected' : ''}>mock</option><option value="real" ${cfg.mode === 'real' ? 'selected' : ''}>real</option></select></label></section><section class="workflow-inspector-section"><h4>${esc(t('workflowNodeOutput'))}</h4><div class="workflow-inspector-row"><span>Status</span><code>${esc(status)}</code></div><div class="workflow-inspector-row"><span>Session</span><code>${esc(output.session_id || '—')}</code></div><div class="workflow-inspector-row"><span>Summary</span><code>${esc(output.summary || output.message || output.text || '—')}</code></div></section>`;
    els.inspectorBody.querySelectorAll('[data-node-field]').forEach(input => input.addEventListener('change', e => {
      const field = e.target.dataset.nodeField; const value = e.target.value.trim(); const wfNow = currentWorkflow(); const current = (wfNow?.nodes || []).find(n => n.id === workflowState.selectedNodeId); if (!current) return;
      if (field === 'id' && value && value !== current.id) {
        const oldId = current.id; current.id = value; (wfNow.edges || []).forEach(edge => { if (edge.from === oldId) edge.from = value; if (edge.to === oldId) edge.to = value; }); workflowState.selectedNodeId = value;
      } else current[field] = value;
      markWorkflowDirty(); renderWorkflowsPage();
    }));
    els.inspectorBody.querySelectorAll('[data-config-field]').forEach(input => input.addEventListener('change', e => updateSelectedWorkflowNodeConfig(e.target.dataset.configField, e.target.value.trim())));
  }
  const approvalNeeded = status === 'paused' || (workflowState.currentRun?.status === 'paused' && node.type === 'approval');
  if (els.approval) els.approval.hidden = !approvalNeeded;
  if (els.approvalMsg) els.approvalMsg.textContent = cfg.message || t('workflowApprovalRequired');
}

function renderWorkflowRunbar() {
  const wf = currentWorkflow(); const run = workflowState.currentRun; const els = workflowEls(); const nodes = wf?.nodes || [];
  const done = nodes.filter(n => ['succeeded', 'done'].includes(workflowNodeStatus(n.id))).length;
  const total = nodes.length || 0; const status = run?.status || 'idle';
  if (els.runId) els.runId.textContent = run?.id || run?.run_id || '—';
  if (els.runStatus) els.runStatus.textContent = status;
  if (els.runProgress) els.runProgress.textContent = `${done} / ${total}`;
  if (els.runCost) els.runCost.textContent = `$${Number(run?.cost_usd || run?.total_cost_usd || 0).toFixed(4)}`;
  if (els.progress) els.progress.style.width = total ? `${Math.round(done / total * 100)}%` : '0%';
  if (els.timelineTitle) els.timelineTitle.textContent = `${status} · ${wf?.name || t('workflows')}`;
}

function renderWorkflowLog() {
  const els = workflowEls(); if (!els.log) return;
  els.log.innerHTML = (workflowState.log.length ? workflowState.log : [{ time: new Date(), event: 'idle', message: t('workflowNoEvents') }]).map(item => `<div class="workflow-log-line"><span class="workflow-log-time">${esc(new Date(item.time).toLocaleTimeString())}</span><span class="workflow-log-event">${esc(item.event)}</span><span>${esc(item.message || '')}</span></div>`).join('');
  els.log.scrollTop = els.log.scrollHeight;
}

function appendWorkflowLog(event, message) {
  workflowState.log.push({ time: new Date(), event, message });
  if (workflowState.log.length > 120) workflowState.log.shift();
  renderWorkflowLog();
}

async function runSelectedWorkflow() {
  const wf = currentWorkflow(); if (!wf) return;
  try {
    const data = await workflowFetchJson(`/api/workflows/${encodeURIComponent(wf.id)}/runs`, { method: 'POST', body: JSON.stringify({}) });
    workflowState.currentRun = data?.run || data || { id: data?.run_id, status: 'running' };
    workflowState.nodeStatuses = {}; appendWorkflowLog('run_started', t('workflowRunStarted'));
  } catch (e) {
    workflowState.currentRun = { id: `preview-${Date.now()}`, status: 'running' };
    workflowState.nodeStatuses = {}; appendWorkflowLog('preview', t('workflowPreviewRunStarted'));
    if (workflowEls().status) { workflowEls().status.textContent = t('workflowBackendUnavailable'); workflowEls().status.className = 'workflow-status-message error'; }
  }
  renderWorkflowsPage();
}

async function cancelWorkflowRun() {
  const runId = workflowState.currentRun?.id || workflowState.currentRun?.run_id; if (!runId) return;
  try { await workflowFetchJson(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' }); } catch (e) { showToast(t('workflowCancelFailed'), 'error'); }
  workflowState.currentRun.status = 'cancelled'; appendWorkflowLog('run_cancelled', t('workflowRunCancelled')); renderWorkflowsPage();
}

async function approveWorkflowRun(approved) {
  const runId = workflowState.currentRun?.id || workflowState.currentRun?.run_id; if (!runId) return;
  try { await workflowFetchJson(`/api/workflows/runs/${encodeURIComponent(runId)}/approve`, { method: 'POST', body: JSON.stringify({ approved }) }); } catch (e) { showToast(t('workflowApproveFailed'), 'error'); }
  workflowState.currentRun.status = approved ? 'running' : 'cancelled'; appendWorkflowLog(approved ? 'run_resumed' : 'run_cancelled', approved ? t('workflowApproved') : t('workflowRejected')); renderWorkflowsPage();
}

async function saveSelectedWorkflowDraft() {
  const wf = currentWorkflow(); if (!wf) return;
  try {
    const method = wf.id && !String(wf.id).startsWith('wf-code-change-preview') ? 'PUT' : 'POST';
    const url = method === 'PUT' ? `/api/workflows/${encodeURIComponent(wf.id)}` : '/api/workflows';
    const saved = await workflowFetchJson(url, { method, body: JSON.stringify(wf) });
    if (saved?.id) {
      const idx = workflowState.workflows.findIndex(item => item.id === wf.id);
      if (idx >= 0) workflowState.workflows[idx] = saved;
      else workflowState.workflows.unshift(saved);
      workflowState.selectedWorkflowId = saved.id;
    }
    showToast(t('workflowDraftSaved'), 'success');
  } catch (e) { showToast(t('workflowDraftSaveFailed'), 'error'); }
}

function handleWorkflowEvent(data = {}) {
  if (!data || data.type && data.type !== 'workflow_event') return;
  if (data.workflow_id && data.workflow_id !== workflowState.selectedWorkflowId) workflowState.selectedWorkflowId = data.workflow_id;
  workflowState.currentRun = { ...(workflowState.currentRun || {}), id: data.run_id || workflowState.currentRun?.id, status: data.payload?.status || workflowState.currentRun?.status || 'running' };
  const ev = data.event || 'workflow_event';
  if (data.node_id) {
    if (ev === 'node_started') workflowState.nodeStatuses[data.node_id] = 'running';
    else if (ev === 'node_succeeded') workflowState.nodeStatuses[data.node_id] = 'succeeded';
    else if (ev === 'node_failed') workflowState.nodeStatuses[data.node_id] = 'failed';
    else if (ev === 'node_cancelled') workflowState.nodeStatuses[data.node_id] = 'cancelled';
    else if (ev === 'approval_required') workflowState.nodeStatuses[data.node_id] = 'paused';
    const output = data.payload?.output && typeof data.payload.output === 'object' ? data.payload.output : data.payload;
    if (output) workflowState.nodeOutputs[data.node_id] = { ...(workflowState.nodeOutputs[data.node_id] || {}), ...output };
  }
  if (ev === 'run_paused' || ev === 'approval_required') workflowState.currentRun.status = 'paused';
  if (ev === 'run_succeeded') workflowState.currentRun.status = 'succeeded';
  if (ev === 'run_failed') workflowState.currentRun.status = 'failed';
  if (ev === 'run_cancelled') {
    workflowState.currentRun.status = 'cancelled';
    Object.keys(workflowState.nodeStatuses).forEach((nodeId) => { if (workflowState.nodeStatuses[nodeId] === 'running' || workflowState.nodeStatuses[nodeId] === 'paused') workflowState.nodeStatuses[nodeId] = 'cancelled'; });
  }
  appendWorkflowLog(ev, data.payload?.message || data.node_id || data.run_id || '');
  renderWorkflowsPage();
}

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
    loadTools,
    loadIntegrations,
    loadMemoryFiles,
    loadScheduledTasks,
    loadFeishuGateway,
    loadWorkflowsPage,
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
    messagesEl: getActiveMessagesEl(),
    cwdInput,
    modelSelect,
    remoteTargetSelect,
    getCurrentRunId: () => currentRunId,
    getCurrentSessionId: () => currentSessionId,
    getActiveWorkspaceSessionId: () => activeWorkspaceSessionId,
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
    strictActiveSession: true,
  };
}

function bindSSEEvents(source = eventSource) {
  source.addEventListener('connected', (e) => {
    const data = JSON.parse(e.data);
    clientId = data.client_id;
    setConnectionStatus(true);
    // SSE 重连后，若之前处于响应中状态（断连前在等 reply），强制刷新当前会话历史
    // 以同步最终状态。这处理了 tab 长时间后台化后 SSE 断开、会话已完成但 UI 仍卡在
    // "流式回复中" 的场景——刷新后 history 不含 streaming 标记，UI 自然恢复。
    (async () => {
      if (isResponding && currentSessionId) {
        await reloadSessionHistory(currentSessionId, cwdInput?.value?.trim?.() || '');
        resetAssistantStreamState();
        stopTurnTimer();
        clearRunningTasks?.();
        clearSubagentBubbles?.();
        isResponding = false;
        currentContent = [];
        streamBlocks = {};
        currentAssistantEl = null;
        currentAssistantMessageId = null;
        currentRunId = null;
        currentTurnContent = '';
        currentTurnHasAssistantOutput = false;
        currentTurnStartedAt = 0;
        updateUI();
      }
    })();
  });

  source.addEventListener('session_started', (e) => {
    const data = JSON.parse(e.data);
    routeSessionEvent(data, () => window.CCBridge.sse?.handleSessionStarted?.(data, getSseLifecycleOptions()));
  });

  source.addEventListener('session_stopped', (e) => {
    const data = JSON.parse(e.data || '{}');
    routeSessionEvent(data, () => window.CCBridge.sse?.handleSessionStopped?.(data, getSseLifecycleOptions()));
  });

  source.addEventListener('session_taken', (e) => {
    const data = JSON.parse(e.data);
    routeSessionEvent(data, () => window.CCBridge.sse?.handleSessionTaken?.(data, getSseLifecycleOptions()));
  });

  source.addEventListener('user_message', (e) => {
    const data = JSON.parse(e.data);
    routeSessionEvent(data, () => window.CCBridge.sse?.handleUserMessage?.(data, getSseLifecycleOptions()));
  });

  source.addEventListener('generation_started', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (data.running === false) return;
    routeSessionEvent(data, () => {
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
    routeSessionEvent(data, () => handleStreamEvent(data));
  });

  source.addEventListener('assistant', (e) => {
    const data = JSON.parse(e.data);
    routeSessionEvent(data, () => handleAssistantFinal(data));
  });

  source.addEventListener('context_injected', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (!isEventForCurrentSession(data)) return;
    renderContextTrace(data.trace || data);
  });

  source.addEventListener('workflow_event', (e) => {
    try {
      handleWorkflowEvent(JSON.parse(e.data || '{}'));
    } catch (err) {
      console.warn('Invalid workflow event:', err);
    }
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
    // 判定是否属于当前活跃页签：active 为空 / pending- 前缀 / 已等于该 session
    const isActiveSession = !activeWorkspaceSessionId
      || activeWorkspaceSessionId.startsWith('pending-')
      || activeWorkspaceSessionId === data.session_id
      || (currentSessionId && currentSessionId === data.session_id);
    if (!isActiveSession) {
      // 后台会话的 session_id_captured：仅同步元数据，不抢 currentSessionId / active
      ensureWorkspaceSession(data.session_id, {
        cwd: cwdInput.value.trim() || '',
        model: modelSelect.value || '',
        cli: document.getElementById('cli-select')?.value || '',
        status: 'running',
        runId: data.run_id || '',
      });
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
    // 仅在 active 还未确定（空或 pending- 前缀）或本就是该会话时才认领 active。
    // 否则用户已手动切到别的页签，后台会话的 session_id_captured 不应把 active 抢回，
    // 否则会导致响应中切不动页签、且老会话事件被渲染进新页签。
    if (!activeWorkspaceSessionId
        || activeWorkspaceSessionId.startsWith('pending-')
        || activeWorkspaceSessionId === data.session_id) {
      activeWorkspaceSessionId = data.session_id;
    }
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
    handleResult(data);
  });

  source.addEventListener('tool_result', (e) => {
    const data = JSON.parse(e.data);
    routeSessionEvent(data, () => {
      if (data.results) {
        const scopedToolResults = getSessionScopedMap('toolResults');
        for (const r of data.results) {
          scopedToolResults.set(r.tool_use_id, r);
          updateToolResult(r.tool_use_id, r.content, r.is_error);
        }
        updateWorkspaceSessionStatus(currentSessionId, 'running', t('streamingReply'));
      }
      finishTasks(data.results ? data.results.map(r => r.tool_use_id) : []);
    });
  });

  source.addEventListener('session_lock_changed', (e) => {
    const data = JSON.parse(e.data || '{}');
    routeSessionEvent(data, () => {
      const wasResponding = isResponding;
      isResponding = !!data.locked;
      if (!isResponding && wasResponding) {
        finishCurrentTurnFromProcess();
        updateWorkspaceSessionStatus(data.session_id || currentSessionId, 'done');
        scheduleCompletionHistorySync(data.session_id || currentSessionId);
      }
      updateUI();
    });
  });

  source.addEventListener('process_ended', (e) => {
    const data = JSON.parse(e.data || '{}');
    routeSessionEvent(data, () => {
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
  });

  source.addEventListener('generation_interrupted', (e) => {
    const data = JSON.parse(e.data || '{}');
    routeSessionEvent(data, () => {
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
  });

  source.addEventListener('scheduled_task_started', () => {
    loadScheduledTasks();
  });

  source.addEventListener('scheduled_task_updated', () => {
    loadScheduledTasks();
  });

  source.addEventListener('scheduled_task_finished', (e) => {
    const data = JSON.parse(e.data || '{}');
    loadScheduledTasks();
    loadSessions();
    if ((data.task?.notify_platforms || []).includes('desktop')) {
      window.CCBridge.notifications?.notifyScheduledTask?.(data, getNotificationOptions());
    }
  });

  source.addEventListener('scheduled_task_error', (e) => {
    const data = JSON.parse(e.data || '{}');
    if (data.message) showToast(data.message, 'error');
    if ((data.task?.notify_platforms || []).includes('desktop')) {
      window.CCBridge.notifications?.notifyScheduledTask?.({ ...data, error: true }, getNotificationOptions());
    }
    loadScheduledTasks();
  });

  source.addEventListener('error', (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      routeSessionEvent(data, () => {
        addSystemMsg(data.message || t('unknownError'), true);
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
      });
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
    runningTasks: getSessionScopedMap('runningTasks'),
    toolResults: getSessionScopedMap('toolResults'),
    toolStartTimes: getSessionScopedMap('toolStartTimes'),
    addUserMessage,
    renderContextTrace,
    createAssistantBubble,
    scrollToBottom,
    messagesEl: getActiveMessagesEl(),
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
    runningTasks: getSessionScopedMap('runningTasks'),
    finishedTaskIds: getSessionScopedMap('finishedTaskIds'),
    subagentBubbles: getSessionScopedMap('subagentBubbles'),
    agentStatusBar: document.getElementById('agent-status-bar'),
    messagesEl: getActiveMessagesEl(),
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
  return routeSessionEvent(data, () => getResultHandlerModule()?.handleResult?.(data, getResultHandlerOptions()));
}

function getMessageUiOptions() {
  return {
    t,
    esc,
    quoteDisplayText,
    scrollToBottom,
    messagesEl: getActiveMessagesEl(),
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
    getMessagesEl: getActiveMessagesEl,
    inputEl,
    quotePreviewBar,
  };
}

function initInput() {
  window.CCBridge.input?.initInput?.();
}

function initImageGeneration() {
  if (window.CCBridge.imageGeneration) {
    window.CCBridge.imageGeneration.getMessagesEl = getActiveMessagesEl;
    window.CCBridge.imageGeneration.initImageGeneration?.();
  }
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
    messagesEl: getActiveMessagesEl(),
    btnScrollLatest,
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

function loadTools() {
  return window.CCBridge.agentSkills?.loadTools?.();
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
    loadSessionHistory,
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

function getHistoryLoaderOptions(sessionId = '') {
  const state = getSessionUiState(sessionId || getRenderSessionId());
  const runInSession = (fn) => state ? withSessionUiState(state.sessionId, fn) : fn();
  return {
    messagesEl: state?.messagesEl || getActiveMessagesEl(),
    getCwd: () => cwdInput.value.trim() || '',
    getAssistantState: () => ({
      currentAssistantEl: state?.currentAssistantEl || null,
      currentAssistantMessageId: state?.currentAssistantMessageId || null,
      currentContent: state?.currentContent || [],
      streamBlocks: state?.streamBlocks || {},
    }),
    setAssistantState: (next = {}) => {
      if (!state) return;
      state.currentAssistantEl = next.currentAssistantEl;
      state.currentAssistantMessageId = next.currentAssistantMessageId;
      state.currentContent = next.currentContent;
      state.streamBlocks = next.streamBlocks;
    },
    resetAssistantStreamState: () => {
      if (!state) return;
      state.currentAssistantEl = null;
      state.currentAssistantMessageId = null;
      state.currentContent = [];
      state.streamBlocks = {};
    },
    renderHistory: (history) => runInSession(() => renderHistory(history)),
    prependHistory: (history, options = {}) => runInSession(() => prependHistory(history, options)),
    toolResults: state?.toolResults || getSessionScopedMap('toolResults'),
    toolStartTimes: state?.toolStartTimes || getSessionScopedMap('toolStartTimes'),
    captureActiveWorkspaceSnapshot,
    addSystemMsg: (text, isError = false) => runInSession(() => addSystemMsg(text, isError)),
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
  return getHistoryLoaderModule()?.loadSessionHistory?.(sessionId, cwd, getHistoryLoaderOptions(sessionId));
}

async function ensureSessionHistoryLoaded(sessionId, cwd) {
  if (!sessionId) return;
  const state = getSessionUiState(sessionId);
  if (!state || state.historyLoaded || state.historyLoading) return;
  state.historyLoading = true;
  const prevRenderSessionId = _activeRenderSessionId;
  _activeRenderSessionId = sessionId;
  try {
    await loadSessionHistory(sessionId, cwd);
    state.historyLoaded = true;
  } catch (e) {
    console.error('[ensureSessionHistoryLoaded]', e);
  } finally {
    state.historyLoading = false;
    _activeRenderSessionId = prevRenderSessionId;
  }
}

async function reloadSessionHistory(sessionId, cwd) {
  return getHistoryLoaderModule()?.reloadSessionHistory?.(sessionId, cwd, getHistoryLoaderOptions(sessionId));
}

function renderHistory(history) {
  return window.CCBridge.chatRenderer?.renderHistory?.(history, getChatRendererOptions());
}

function prependHistory(history) {
  return window.CCBridge.chatRenderer?.prependHistory?.(history, { ...getChatRendererOptions(), messagesEl: getActiveMessagesEl() });
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
