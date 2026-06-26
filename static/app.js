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
let currentContent = [];
let streamBlocks = {};
let totalCost = 0;
let totalTokens = emptyTokenUsage();
let currentSessionId = null; // ccb 的 session UUID
const sessionGroupOpenState = new Map();
let connectionOnline = false;
let currentTurnContent = '';
let currentTurnHasAssistantOutput = false;
let currentTurnStartedAt = 0;
let currentTurnTimer = null;
let currentTurnAttachmentCount = 0;
let lastFocusConfigReloadAt = 0;
let cachedSessions = [];
let sidebarCollapsed = false;

// ─── DOM ─────────────────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('message-input');
const btnSend = document.getElementById('btn-send');
const btnStop = document.getElementById('btn-stop');
const btnNewSession = document.getElementById('btn-new-session');
const modelSelect = document.getElementById('model-select');
let savedModelPref = '';  // gui_settings 里上次使用的模型，刷新后用于恢复选择
let autoUpdateEnabled = true;  // 是否启动时自动检查更新
let skipUpdateVersion = '';    // 被跳过的远端版本 SHA
let updateInfo = null;         // 最近一次 check-update 的结果
let quoteSourceText = '';      // 右键引用时暂存的消息文本
let quotedMessages = [];       // 输入框上方展示的引用卡片
let contextMenuCwd = '';       // 工作目录右键菜单暂存的 cwd
const cwdInput = document.getElementById('cwd-input');
const connectionStatus = document.getElementById('connection-status');
const costDisplay = document.getElementById('cost-display');
const costValue = document.getElementById('cost-value');
const tokenDisplay = document.getElementById('token-display');
const tokenValue = document.getElementById('token-value');
const sessionSearchInput = document.getElementById('session-search');
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
  initMobileLayout();
  initSSE();
  initInput();
  initCliInstallModal();
  initUpdateModal();
  initMessageContextMenu();
  initCwdContextMenu();
  initRemote();
  initMcpManager();
  initAgentModal();
  initSessionAgentPanel();
  initMentionAutocomplete();
  initMemoryUI();
  loadDefaultCwd();
  loadClis();
  loadModels();
  loadConfig();
  loadSessions();
  initFocusConfigReload();
  if (autoUpdateEnabled) setTimeout(() => checkForUpdate(), 3000);
});

async function loadDefaultCwd() {
  try {
    const resp = await fetch('/api/default-cwd');
    const data = await resp.json();
    if (data.cwd && !cwdInput.value.trim()) {
      cwdInput.value = data.cwd;
      loadSessions();
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
    topbarCost.style.display = totalCost > 0 ? '' : 'none';
    topbarCostValue.textContent = totalCost.toFixed(4);
  }
  if (topbarTokens && topbarTokenValue) {
    const total = tokenUsageTotal(totalTokens);
    topbarTokens.style.display = total > 0 ? '' : 'none';
    topbarTokenValue.textContent = formatTokenUsage(totalTokens);
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

  notificationsToggle.addEventListener('change', async () => {
    if (!notificationsToggle.checked) {
      notificationsEnabled = false;
      await saveGuiSettings({ notifications_enabled: false });
      return;
    }

    const permission = await requestNotificationPermission();
    notificationsEnabled = permission === 'granted';
    notificationsToggle.checked = notificationsEnabled;
    await saveGuiSettings({ notifications_enabled: notificationsEnabled });
    if (!notificationsEnabled) {
      addSystemMsg(t('notifyPermissionDenied'), true);
    }
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

async function requestNotificationPermission() {
  if (!("Notification" in window)) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch (e) {
    return Notification.permission || 'default';
  }
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
  } catch (e) { /* ignore */ }
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
  const duration = formatCompactDuration(durationMs);
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
      return;
    }
    modelSelect.innerHTML = availableModels.map((model, idx) => (
      `<option value="${esc(model)}" ${(previousModel ? model === previousModel : idx === 0) ? 'selected' : ''}>${esc(formatModelName(model))}</option>`
    )).join('');
    if (previousModel && !availableModels.includes(previousModel)) {
      modelSelect.value = availableModels[0] || '';
    }
  } catch (e) {
    modelSelect.innerHTML = '<option value="claude-sonnet-4-6">Sonnet 4.6</option>';
  }
}

// ─── 导航 ────────────────────────────────────────────────────
function showPage(page) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');
  hideMentionPopup();
}

function initNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      showPage(btn.dataset.page);
    });
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

  const closeMenu = () => {
    sidebar.classList.remove('mobile-open');
    backdrop.classList.remove('visible');
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
    if (e.target.closest('.nav-btn, .session-item, #btn-new-session')) closeMenu();
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

function bindSSEEvents() {
  eventSource.addEventListener('connected', (e) => {
    const data = JSON.parse(e.data);
    clientId = data.client_id;
    setConnectionStatus(true);
  });

  eventSource.addEventListener('session_started', (e) => {
    const data = JSON.parse(e.data);
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
    // 重连时清除欢迎消息
    if (!wasActive) {
      const welcome = messagesEl.querySelector('.welcome-msg');
      if (welcome) welcome.remove();
    }
    if (isViewer) {
      addSystemMsg(t('viewingSession'));
    } else {
      addSystemMsg(modelLabel ? t('sessionStarted', { model: modelLabel }) : t('sessionStartedPlain'));
    }
  });

  eventSource.addEventListener('session_stopped', (e) => {
    sessionActive = false;
    isResponding = false;
    isViewer = false;
    updateUI();
    addSystemMsg(t('sessionStopped'));
  });

  eventSource.addEventListener('generation_started', (e) => {
    // 刷新后重连到正在回复的会话，恢复响应状态
    isResponding = true;
    currentAssistantEl = createAssistantBubble();
    currentContent = [];
    streamBlocks = {};
    startTurnTimer();
    updateUI();
    scrollToBottom();
  });

  eventSource.addEventListener('system', (e) => {
    const data = JSON.parse(e.data);
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
    handleStreamEvent(JSON.parse(e.data));
  });

  eventSource.addEventListener('assistant', (e) => {
    handleAssistantFinal(JSON.parse(e.data));
  });

  eventSource.addEventListener('session_id_captured', (e) => {
    const data = JSON.parse(e.data);
    currentSessionId = data.session_id;
    renderTopbarMeta();
    openCurrentCwdSessionGroup();
    loadSessions();
  });

  eventSource.addEventListener('model_changed', (e) => {
    const data = JSON.parse(e.data);
    const modelLabel = getDisplayModelName(data.model || '');
    renderTopbarMeta(data.model || '');
    if (modelLabel) addSystemMsg(t('modelChanged', { model: modelLabel }));
  });

  eventSource.addEventListener('result', (e) => {
    handleResult(JSON.parse(e.data));
  });

  eventSource.addEventListener('tool_result', (e) => {
    const data = JSON.parse(e.data);
    finishTasks(data.tool_use_ids);
  });

  eventSource.addEventListener('process_ended', (e) => {
    // ccb 进程结束 —— 确保前端退出 responding 状态
    const data = JSON.parse(e.data || '{}');
    clearRunningTasks();
    clearSubagentBubbles();
    cleanupUploadedFiles(uploadedFilesPendingCleanup);
    uploadedFilesPendingCleanup = [];
    if (isResponding) {
      const finishedTurn = currentTurnContent;
      const hadAssistantOutput = currentTurnHasAssistantOutput;
      const durationMs = Date.now() - currentTurnStartedAt;
      stopTurnTimer();
      updateAssistantMeta('done', durationMs);
      isResponding = false;
      const assistantEl = currentAssistantEl;
      currentTurnContent = '';
      currentTurnHasAssistantOutput = false;
      currentTurnStartedAt = 0;
      currentTurnAttachmentCount = 0;
      removePendingAssistantBubble(hadAssistantOutput);
      currentAssistantEl = null;
      notifyComplete('process', {
        prompt: finishedTurn,
        durationMs,
        model: getDisplayModelName(modelSelect.value),
      });
      if (assistantEl && hadAssistantOutput) checkMemoryHits(assistantEl, finishedTurn);
      updateUI();
      if (isSlashCommand(finishedTurn) && !hadAssistantOutput) {
        const command = getSlashCommandName(finishedTurn);
        if (Number(data.exit_code || 0) === 0) {
          addSystemMsg(t('commandCompleted', { command }));
        } else {
          addSystemMsg(t('commandEnded', { command }), true);
        }
      }
    }
  });

  eventSource.addEventListener('generation_interrupted', () => {
    const hadAssistantOutput = currentTurnHasAssistantOutput;
    isResponding = false;
    currentTurnContent = '';
    currentTurnHasAssistantOutput = false;
    stopTurnTimer();
    removePendingAssistantBubble(hadAssistantOutput);
    currentAssistantEl = null;
    clearRunningTasks();
    clearSubagentBubbles();
    cleanupUploadedFiles(uploadedFilesPendingCleanup);
    uploadedFilesPendingCleanup = [];
    updateUI();
    addSystemMsg(t('interrupted'));
  });

  eventSource.addEventListener('error', (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      addSystemMsg(data.message || t('unknownError'), true);
      // 收到错误事件也要退出 responding 状态
      isResponding = false;
      currentTurnContent = '';
      currentTurnHasAssistantOutput = false;
      stopTurnTimer();
      removePendingAssistantBubble(false);
      currentAssistantEl = null;
      cleanupUploadedFiles(uploadedFilesPendingCleanup);
      uploadedFilesPendingCleanup = [];
      updateUI();
    }
    if (eventSource.readyState === EventSource.CLOSED) {
      setConnectionStatus(false);
      setTimeout(initSSE, 3000);
    }
  });

  eventSource.onerror = () => {
    setConnectionStatus(false);
    // SSE 断开时清除 responding 状态，避免 UI 卡在"运行中"
    if (isResponding) {
      isResponding = false;
      currentTurnContent = '';
      currentTurnHasAssistantOutput = false;
      stopTurnTimer();
      removePendingAssistantBubble(false);
      currentAssistantEl = null;
      clearRunningTasks();
      clearSubagentBubbles();
      updateUI();
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
  btnNewSession.style.opacity = connected ? '1' : '0.5';
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
  updateUI();

  switch (evt.type) {
    case 'message_start':
      if (!currentAssistantEl) {
        currentAssistantEl = createAssistantBubble();
        currentContent = [];
        streamBlocks = {};
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
      html += `<div class="tool-card">
        <div class="tool-header"><span class="tool-icon">&#9881;</span> ${esc(block.name || t('tool'))}</div>
        <div class="tool-body">${esc(block.input)}</div>
      </div>`;
    }
  }

  if (isResponding && !Object.values(streamBlocks).some(b => b.type === 'text') && currentContent.length === 0 && Object.keys(streamBlocks).length === 0) {
    html += '<span class="typing-cursor"></span>';
  }

  el.innerHTML = html;
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
    const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
    const isRunningTask = block.name === 'Task' && block.id && runningTasks.has(block.id);
    const runningBadge = isRunningTask
      ? `<span class="tool-running-badge"><span class="agent-spinner"></span>${esc(t('running'))}</span>`
      : '';
    return `<div class="tool-card${isRunningTask ? ' tool-card-running' : ''}">
      <div class="tool-header"><span class="tool-icon">&#9881;</span> ${esc(block.name || t('tool'))}${runningBadge}</div>
      <div class="tool-body">${esc(input)}</div>
    </div>`;
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

  // ccb 的 assistant 事件带增量消息（partial messages）
  isResponding = true;
  currentTurnHasAssistantOutput = true;
  updateUI();

  if (!currentAssistantEl) {
    currentAssistantEl = createAssistantBubble();
    currentContent = [];
  }

  const message = data.message;
  if (!message || !message.content) return;

  currentContent = [];
  for (const block of message.content) {
    if (block.type === 'thinking' && block.thinking) {
      currentContent.push({ type: 'thinking', thinking: block.thinking });
    } else if (block.type === 'text' && block.text) {
      currentContent.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      currentContent.push({ type: 'tool_use', name: block.name, id: block.id, input: block.input });
    }
  }
  registerTaskBlocks(currentContent);

  streamBlocks = {};
  renderCurrentState(true);
  scrollToBottom();
}

// ─── Subagent 运行状态跟踪 ───────────────────────────────────
// tool_use_id -> {type, desc, last}
const runningTasks = new Map();
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

function clearRunningTasks() {
  if (runningTasks.size) {
    runningTasks.clear();
    renderAgentStatus();
  }
  finishedTaskIds.clear();
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

function handleResult(data) {
  const finishedTurn = currentTurnContent;
  const hadAssistantOutput = currentTurnHasAssistantOutput;
  const durationMs = Date.now() - currentTurnStartedAt;
  const turnCost = Number(data.total_cost_usd || 0);
  const persistedCost = Number(data.session_total_cost_usd || 0);
  const turnTokens = normalizeTokenUsage(data.turn_tokens || data.usage || data);
  const persistedTokens = normalizeTokenUsage(data.session_total_tokens);
  stopTurnTimer();
  updateAssistantMeta('done', durationMs);
  removePendingAssistantBubble(hadAssistantOutput);
  const assistantEl = currentAssistantEl;
  isResponding = false;
  currentAssistantEl = null;
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
  cleanupUploadedFiles(uploadedFilesPendingCleanup);
  uploadedFilesPendingCleanup = [];
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

  if (data.is_error && data.errors) {
    data.errors.forEach(e => addSystemMsg(e, true));
  } else if (isSlashCommand(finishedTurn) && !hadAssistantOutput) {
    addSystemMsg(t('commandCompleted', { command: getSlashCommandName(finishedTurn) }));
  }
}

// ─── UI 组件 ─────────────────────────────────────────────────
function createAssistantBubble() {
  const el = document.createElement('div');
  el.className = 'message assistant';
  el.innerHTML = `
    <div class="avatar assistant-avatar">C</div>
    <div class="msg-bubble">
      <div class="msg-content"></div>
      <div class="msg-meta"></div>
    </div>
  `;
  messagesEl.appendChild(el);
  return el;
}

function removePendingAssistantBubble(keepBubble) {
  if (!keepBubble && currentAssistantEl && !currentAssistantEl.querySelector('.msg-content')?.textContent.trim()) {
    currentAssistantEl.remove();
  }
}

function addUserMessage(text, quotes = []) {
  const el = document.createElement('div');
  el.className = 'message user';
  const quoteHtml = quotes.length ? `
    <div class="msg-quoted-list">
      ${quotes.map(q => `<div class="msg-quoted-item">${esc(q)}</div>`).join('')}
    </div>
  ` : '';
  el.innerHTML = `
    <div class="avatar user-avatar">U</div>
    <div class="msg-bubble"><div class="msg-content">${quoteHtml}${esc(text)}</div></div>
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

// ─── 输入 ────────────────────────────────────────────────────
const btnAttach = document.getElementById('btn-attach');
const fileInput = document.getElementById('file-input');
const attachmentsBar = document.getElementById('attachments-bar');
const quotePreviewBar = document.getElementById('quote-preview-bar');
const slashCommandPanel = document.getElementById('slash-command-panel');
const inputWrapper = document.querySelector('.input-wrapper');
let attachedFiles = []; // [{name, path, isImage, uploaded}]
let uploadedFilesPendingCleanup = []; // 本轮已发送、等待回合结束后删除的上传缓存文件
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
  btnStop.addEventListener('click', () => sendAction('interrupt'));
  btnNewSession.addEventListener('click', startNewSession);
  btnExportChat?.addEventListener('click', copyConversationMarkdown);
  topbarSessionId?.addEventListener('click', copyResumeCommand);
  sessionSearchInput?.addEventListener('input', () => renderSessionList(cachedSessions));
  document.addEventListener('keydown', handleGlobalShortcuts);
  document.getElementById('welcome-new-session')?.addEventListener('click', startNewSession);
  modelSelect.addEventListener('change', () => {
    renderTopbarMeta();
    slashCommands = [];
    closeSlashCommandPanel();
    // 记住选择，刷新后恢复
    savedModelPref = modelSelect.value;
    saveGuiSettings({ default_model: modelSelect.value });
  });
  cwdInput.addEventListener('change', () => {
    slashCommands = [];
    closeSlashCommandPanel();
    openCurrentCwdSessionGroup();
    loadSessions();
    loadMcpServers();
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

// ─── 消息右键引用 ────────────────────────────────────────────
function hideMsgContextMenu() {
  const menu = document.getElementById('msg-context-menu');
  if (menu) { menu.style.display = 'none'; menu.style.visibility = 'hidden'; }
}

function quoteIntoInput(text) {
  const normalized = (text || '').trim();
  if (!normalized) return;
  quotedMessages.push(normalized);
  renderQuotePreview();
  showPage('chat');
  inputEl.focus();
}

function renderQuotePreview() {
  if (!quotePreviewBar) return;
  if (quotedMessages.length === 0) {
    quotePreviewBar.style.display = 'none';
    quotePreviewBar.innerHTML = '';
    return;
  }
  quotePreviewBar.style.display = 'flex';
  quotePreviewBar.innerHTML = quotedMessages.map((text, i) => `
    <div class="quote-preview-item">
      <div class="quote-preview-head">
        <span>${esc(t('quotedMessage'))}</span>
        <button class="quote-preview-remove" data-idx="${i}" title="${esc(t('removeQuote'))}" type="button">&times;</button>
      </div>
      <div class="quote-preview-text">${esc(text)}</div>
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
  if (!menu) return;

  messagesEl.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('.message');
    if (!msgEl) return;
    e.preventDefault();
    quoteSourceText = domText(msgEl);
    if (!quoteSourceText) return;
    // 先显示以便测量尺寸，再做视口边界收敛（visibility:hidden 防止闪烁）
    menu.style.display = 'block';
    const rect = menu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = Math.max(4, x) + 'px';
    menu.style.top = Math.max(4, y) + 'px';
    menu.style.visibility = 'visible';
  });

  menu.querySelector('[data-action="quote"]')?.addEventListener('click', () => {
    quoteIntoInput(quoteSourceText);
    hideMsgContextMenu();
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) hideMsgContextMenu();
  });
  document.addEventListener('scroll', hideMsgContextMenu, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMsgContextMenu();
  });
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
    sendAction('interrupt');
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

function cleanupUploadedFiles(files) {
  const paths = (files || []).filter(f => f && f.uploaded && f.path).map(f => f.path);
  if (!paths.length) return;
  fetch('/api/upload/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
    keepalive: true,
  }).catch(() => {});
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
      const [removed] = attachedFiles.splice(idx, 1);
      cleanupUploadedFiles([removed]);
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

function sendMessage() {
  let content = inputEl.value.trim();
  const quotesForThisTurn = quotedMessages.slice();
  if ((!content && attachedFiles.length === 0 && quotesForThisTurn.length === 0) || !sessionActive || isResponding) return;
  const originalContent = content;
  const attachmentCount = attachedFiles.length;

  if (quotesForThisTurn.length > 0) {
    const quotedText = quotesForThisTurn
      .map(text => text.split('\n').map(line => `> ${line}`).join('\n'))
      .join('\n\n');
    content = content ? `${quotedText}\n\n${content}` : quotedText;
    quotedMessages = [];
    renderQuotePreview();
  }

  // 注入文件路径。上传缓存文件只需要保留到本轮消息发出，之后异步删除以节省磁盘。
  let sentUploadedFiles = [];
  if (attachedFiles.length > 0) {
    const filesForThisTurn = attachedFiles.slice();
    sentUploadedFiles = filesForThisTurn.filter(f => f.uploaded);
    const filePaths = filesForThisTurn.map(f => `- ${f.path}`).join('\n');
    const prefix = `${t('attachmentIntro')}\n${filePaths}\n\n`;
    content = prefix + content;
    uploadedFilesPendingCleanup.push(...sentUploadedFiles);
    attachedFiles = [];
    renderAttachments();
  }

  addUserMessage(originalContent, quotesForThisTurn);
  currentTurnContent = originalContent || (attachmentCount ? t('notifyAttachmentPrompt', { count: attachmentCount }) : (quotesForThisTurn.length ? t('quotedMessage') : ''));
  currentTurnAttachmentCount = attachmentCount;
  currentTurnStartedAt = Date.now();
  currentTurnHasAssistantOutput = false;
  isResponding = true;
  currentAssistantEl = createAssistantBubble();
  currentContent = [];
  streamBlocks = {};
  startTurnTimer();
  renderCurrentState();
  scrollToBottom();
  updateUI();
  if (isSlashCommand(originalContent)) {
    addSystemMsg(t('commandRunning', { command: getSlashCommandName(originalContent) }));
  }
  sendAction('send_message', {
    content,
    model: modelSelect.value,
    cli: document.getElementById('cli-select')?.value || '',
    remote_target_id: remoteTargetSelect?.value || '',
    allow_remote_mutate: !!remoteAllowMutate?.checked,
  });
  inputEl.value = '';
  inputEl.style.height = 'auto';
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
  currentContent = [];
  streamBlocks = {};
  totalCost = 0;
  totalTokens = emptyTokenUsage();
  currentSessionId = null;
  renderTopbarMeta();
  renderCost();
  renderTokens();
}

function startNewSession() {
  if (!clientId) {
    addSystemMsg(t('notConnected'), true);
    return;
  }

  // 如果当前有活跃会话，先停止并解锁 UI，让用户可以修改配置
  if (sessionActive) {
    sendAction('stop');
    sessionActive = false;
    isResponding = false;
    updateUI();
    resetSessionViewState();
    addSystemMsg(t('stoppedEditable'));
    return;
  }

  createNewSession(cwdInput.value.trim());
}

function createNewSession(cwd) {
  resetSessionViewState();

  if (cwd) cwdInput.value = cwd;
  openCurrentCwdSessionGroup();
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

  if (sessionActive) {
    await sendAction('stop');
    sessionActive = false;
    isResponding = false;
    updateUI();
  }

  showPage('chat');
  createNewSession(nextCwd);
}

function updateUI() {
  btnSend.disabled = !sessionActive || isResponding || isViewer;
  // viewer 模式下 Stop 按钮可见但禁用
  btnStop.classList.toggle('visible', isResponding);
  btnStop.disabled = isViewer;
  btnNewSession.innerHTML = `<span class="btn-prefix">&gt;</span> ${sessionActive ? t('restartSession') : t('newSession')}`;
  if (!sessionActive && sidebarCollapsed) sidebarCollapsed = false;
  setSidebarCollapsed(sidebarCollapsed);
  // viewer 模式和会话活跃时禁用配置修改
  const locked = sessionActive || isViewer;
  cwdInput.disabled = sessionActive;
  btnBrowse.disabled = sessionActive;
  btnBrowse.style.opacity = sessionActive ? '0.4' : '1';
  const cliSelect = document.getElementById('cli-select');
  if (cliSelect) cliSelect.disabled = false;
  if (modelSelect) modelSelect.disabled = false;
  const skipPermissions = document.getElementById('skip-permissions');
  if (skipPermissions) skipPermissions.disabled = sessionActive;
  // 远程目标和写入开关可随时切换，下一条消息生效
  if (remoteTargetSelect) remoteTargetSelect.disabled = false;
  // viewer 时禁用输入
  inputEl.disabled = isViewer;
  inputEl.style.opacity = isViewer ? '0.5' : '1';
  if (isViewer) {
    inputEl.placeholder = t('viewingPlaceholder') || 'Viewing live session...';
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
    const skills = await (await fetch('/api/skills')).json();
    renderSkills(skills);
    const agents = await (await fetch('/api/agents')).json();
    agentsCache = agents;
    renderAgents(agents);
    loadMcpServers();
    loadMemoryFiles();
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
  bar.innerHTML = `
    <select id="profile-select">
      <option value="">${esc(t('profileSelect'))}</option>
      ${names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
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
  const name = prompt(t('profileNamePrompt'));
  if (!name || !name.trim()) {
    if (name !== null) addSystemMsg(t('profileNameEmpty'));
    return;
  }
  const env = collectEditorEnv();
  await fetch('/api/env-profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), env }),
  });
  addSystemMsg(t('profileSaved', { name: name.trim() }));
  await loadEnvProfiles();
  const sel = document.getElementById('profile-select');
  if (sel) sel.value = name.trim();
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

function renderSkills(skills) {
  const el = document.getElementById('skills-list');
  if (!skills.length) {
    el.innerHTML = `<p class="empty-state">${esc(t('noSkills'))}</p>`;
    return;
  }
  el.innerHTML = skills.map(s => `
    <div class="skill-item">
      <span class="skill-name">/${s.name}</span>
      <span class="skill-desc">${esc(s.description)}</span>
    </div>
  `).join('');
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
  if (!panel) return;

  if (!sessionAgents.length) {
    panel.innerHTML = `<div class="group-member-empty">${esc(t('noSessionAgents'))}</div>`;
    return;
  }

  panel.innerHTML = sessionAgents.map(a => `
    <span class="group-member-chip" data-agent="${esc(a)}">
      <span class="chip-name" title="${esc(a)}">${esc(a)}</span>
      <span class="chip-remove" data-action="remove" data-agent="${esc(a)}">&times;</span>
    </span>
  `).join('');

  // 点击芯片名 → 插入 @名称
  panel.querySelectorAll('.group-member-chip .chip-name').forEach(nameEl => {
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
  panel.querySelectorAll('.chip-remove').forEach(btn => {
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

function initSessionAgentPanel() {
  const addBtn = document.getElementById('btn-session-agent-add');
  const popover = document.getElementById('agent-add-popover');
  const sidebar = document.getElementById('chat-sidebar');
  const toggleBtn = document.getElementById('btn-members-toggle');

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (popover && popover.style.display === 'block') {
        hideAgentAddPopover();
      } else {
        renderAgentAddPopover();
      }
    });
  }

  // 统一浮动按钮：点击展开/收起面板（PC + 移动端）
  if (toggleBtn && sidebar) {
    const openPanel = () => {
      sidebar.classList.add('open');
      toggleBtn.classList.add('active');
    };
    const closePanel = () => {
      sidebar.classList.remove('open');
      toggleBtn.classList.remove('active');
    };

    toggleBtn.addEventListener('click', () => {
      if (sidebar.classList.contains('open')) {
        closePanel();
      } else {
        openPanel();
      }
    });

    // 点击面板外部关闭
    document.addEventListener('click', (e) => {
      if (!sidebar.classList.contains('open')) return;
      if (!sidebar.contains(e.target) && e.target !== toggleBtn && !toggleBtn.contains(e.target)) {
        closePanel();
      }
    });

    // Escape 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) {
        closePanel();
      }
    });

    // 面板内 X 关闭按钮
    const closeBtn = document.getElementById('btn-chat-sidebar-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', closePanel);
    }
  }

  // 弹窗内事件委托：点击 agent 项 → 拉入
  if (popover) {
    popover.addEventListener('click', (e) => {
      const item = e.target.closest('.agent-add-popover-item');
      if (!item || !item.dataset.agent) return;
      e.stopPropagation();
      addSessionAgent(item.dataset.agent);
    });
  }

  // 点击面板外关闭弹窗
  document.addEventListener('click', (e) => {
    const pv = document.getElementById('agent-add-popover');
    if (!pv || pv.style.display !== 'block') return;
    if (!pv.contains(e.target) && e.target.id !== 'btn-session-agent-add') {
      hideAgentAddPopover();
    }
  });
  loadSessionAgents();
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

  // 只可 @提及当前会话已拉入的 agent
  const items = [];
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
        <span class="mention-type-tag mention-type-agent">${esc(t('agents'))}</span>
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

// ─── Memory 浏览 ────────────────────────────────────────────────
let memoryFilesCache = [];

function currentCwdParam() {
  return `cwd=${encodeURIComponent(cwdInput.value.trim() || '')}`;
}

async function loadMemoryFiles() {
  try {
    const resp = await fetch(`/api/memory/files?${currentCwdParam()}`);
    memoryFilesCache = await resp.json();
    renderMemoryFiles(memoryFilesCache);
  } catch (e) {
    console.error('Memory load failed:', e);
  }
}

function renderMemoryFiles(files) {
  const el = document.getElementById('memory-list');
  if (!files || !files.length) {
    el.innerHTML = `<p class="empty-state">${esc(t('noMemoryFiles'))}</p>`;
    return;
  }
  el.innerHTML = files.map(f => {
    const d = new Date(f.updated_at * 1000);
    const timeStr = d.toLocaleString();
    const sizeStr = f.size < 1024 ? `${f.size}B` : f.size < 1048576 ? `${(f.size / 1024).toFixed(1)}KB` : `${(f.size / 1048576).toFixed(1)}MB`;
    return `
      <div class="memory-file-item" data-file="${esc(f.name)}">
        <div class="memory-file-head">
          <span class="memory-file-name">${esc(f.title || f.name)}</span>
          <div class="memory-file-actions">
            <button class="agent-action-btn memory-edit-btn" data-file="${esc(f.name)}" title="${esc(t('editMemory'))}">&#9998;</button>
            <button class="agent-action-btn memory-view-btn" data-file="${esc(f.name)}" title="${esc(t('view'))}">&#128065;</button>
            <button class="agent-action-btn agent-del-btn memory-del-btn" data-file="${esc(f.name)}" title="${esc(t('delete'))}">&times;</button>
          </div>
        </div>
        <span class="memory-file-meta">${esc(sizeStr)} · ${esc(timeStr)}</span>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.memory-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openMemoryEditor(btn.dataset.file));
  });
  el.querySelectorAll('.memory-view-btn').forEach(btn => {
    btn.addEventListener('click', () => viewMemoryFile(btn.dataset.file));
  });
  el.querySelectorAll('.memory-del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteMemoryFilePrompt(btn.dataset.file));
  });
}

async function searchMemory() {
  const q = document.getElementById('memory-search-input')?.value.trim();
  if (!q) {
    renderMemoryFiles(memoryFilesCache);
    return;
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

// ─── Memory 编辑 ──────────────────────────────────────────────────
function openMemoryEditor(filename) {
  const overlay = document.getElementById('memory-edit-overlay');
  const nameInput = document.getElementById('memory-edit-filename');
  const contentArea = document.getElementById('memory-edit-content');

  if (filename) {
    nameInput.value = filename;
    nameInput.dataset.original = filename;
    // 加载现有内容
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

function dreamSummary() {
  if (!sessionActive || isResponding) return;
  const prev = inputEl.value;
  inputEl.value = '/dream';
  sendMessage();
  inputEl.value = prev;
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
  document.getElementById('btn-memory-new')?.addEventListener('click', () => openMemoryEditor());
  document.getElementById('btn-dream')?.addEventListener('click', dreamSummary);
  document.getElementById('memory-modal-close')?.addEventListener('click', closeMemoryModal);
  document.getElementById('memory-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMemoryModal();
  });
  // 编辑模态框
  document.getElementById('btn-memory-edit-save')?.addEventListener('click', saveMemoryEdit);
  document.getElementById('btn-memory-edit-cancel')?.addEventListener('click', closeMemoryEditor);
  document.getElementById('memory-edit-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMemoryEditor();
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

// ─── 会话管理 ─────────────────────────────────────────────────
async function loadSessions() {
  try {
    cachedSessions = await (await fetch('/api/sessions')).json();
    renderSessionList(cachedSessions);
  } catch (e) {
    console.error('历史会话加载失败:', e);
  }
}

function renderSessionList(sessions) {
  const el = document.getElementById('session-list');
  const filtered = filterSessions(sessions || []);
  if (!filtered.length) {
    el.innerHTML = `<div class="session-empty">${esc(t(sessions?.length ? 'noMatches' : 'noHistory'))}</div>`;
    return;
  }

  const groups = groupSessionsByCwd(filtered);

  el.innerHTML = groups.map(group => {
    const forcedOpen = group.sessions.some(s => s.session_id === currentSessionId);
    const savedOpen = sessionGroupOpenState.get(group.key);
    const defaultOpen = isCurrentCwd(group.cwd) || groups.length === 1;
    const isOpen = forcedOpen || (savedOpen === undefined ? defaultOpen : savedOpen);
    const latestTime = formatTime(group.latest);
    const groupCost = group.sessions.reduce((sum, s) => sum + Number(s.total_cost_usd || 0), 0);
    const sessionsHtml = group.sessions.map(s => renderSessionItem(s)).join('');

    return `<div class="session-group${isOpen ? ' open' : ' collapsed'}" data-group-key="${esc(group.key)}" data-cwd="${esc(group.cwd || '')}">
      <button type="button" class="session-group-header" aria-expanded="${isOpen ? 'true' : 'false'}">
        <span class="session-group-chevron">${isOpen ? '▾' : '▸'}</span>
        <span class="session-group-main">
          <span class="session-group-title">${esc(group.name)}</span>
        <span class="session-group-path">${esc(group.cwd || t('unsetCwd'))}</span>
      </span>
      <span class="session-group-meta">${esc(t('itemCount', { count: group.sessions.length }))} · ${esc(latestTime)}${groupCost > 0 ? ` · $${groupCost.toFixed(4)}` : ''}</span>
      </button>
      <div class="session-group-body" ${isOpen ? '' : 'hidden'}>
        ${sessionsHtml}
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.session-group-header').forEach(header => {
    header.addEventListener('click', () => {
      const groupEl = header.closest('.session-group');
      const key = groupEl?.dataset.groupKey || '';
      if (!key) return;
      const body = groupEl.querySelector('.session-group-body');
      const isOpen = !body.hasAttribute('hidden');
      body.toggleAttribute('hidden', isOpen);
      groupEl.classList.toggle('open', !isOpen);
      groupEl.classList.toggle('collapsed', isOpen);
      header.setAttribute('aria-expanded', String(!isOpen));
      const chevron = header.querySelector('.session-group-chevron');
      if (chevron) chevron.textContent = isOpen ? '▸' : '▾';
      sessionGroupOpenState.set(key, !isOpen);
    });
    header.addEventListener('contextmenu', (e) => showCwdContextMenu(e, header.closest('.session-group')?.dataset.cwd || ''));
  });

  el.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('session-item-delete') || e.target.classList.contains('session-item-rename')) return;
      const tokens = safeJsonParse(item.dataset.tokens, null);
      showPage('chat');
      resumeSession(item.dataset.sid, item.dataset.cwd, item.dataset.model, Number(item.dataset.cost || 0), item.dataset.remoteTarget || '', tokens, item.dataset.cli || '');
    });
    item.querySelector('.session-item-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const title = item.querySelector('.session-item-title')?.textContent?.trim() || t('newChat');
      if (!window.confirm(t('confirmDeleteSession', { title }))) return;
      await fetch('/api/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: item.dataset.sid, cwd: item.dataset.cwd || '' }),
      });
      loadSessions();
    });
    item.querySelector('.session-item-rename').addEventListener('click', async (e) => {
      e.stopPropagation();
      const currentTitle = item.querySelector('.session-item-title')?.textContent?.trim() || '';
      const nextTitle = window.prompt(t('renameSessionPrompt'), currentTitle);
      if (!nextTitle || nextTitle.trim() === currentTitle) return;
      await renameSession(item.dataset.sid, nextTitle.trim());
    });
  });
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

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) hideCwdContextMenu();
  });
  document.addEventListener('scroll', hideCwdContextMenu, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCwdContextMenu();
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
    const haystack = [s.title, s.cwd, s.model, s.updated_at, s.remote_target_id].map(value => String(value || '').toLowerCase());
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
  return `<div class="session-item${isActive ? ' active' : ''}" data-sid="${esc(s.session_id)}" data-cwd="${esc(s.cwd)}" data-model="${esc(s.model)}" data-cli="${esc(s.cli || '')}" data-cost="${esc(savedCost)}" data-tokens="${esc(JSON.stringify(savedTokens))}" data-remote-target="${esc(s.remote_target_id || '')}">
    <div class="session-item-main">
      <div class="session-item-title">${esc(title)}</div>
      <div class="session-item-meta">${modelLabel ? `${esc(modelLabel)} · ` : ''}${esc(time)}${savedCost > 0 ? ` · $${savedCost.toFixed(4)}` : ''}${tokenTotal > 0 ? ` · ${formatTokenCount(tokenTotal)} tok` : ''}</div>
    </div>
    <div class="session-item-actions">
      <button class="session-item-rename" title="${esc(t('rename'))}">✎</button>
      <button class="session-item-delete" title="${esc(t('delete'))}">&times;</button>
    </div>
  </div>`;
}

function groupSessionsByCwd(sessions) {
  const map = new Map();
  for (const session of sessions) {
    const cwd = (session.cwd || '').trim();
    const key = normalizeCwdKey(cwd);
    if (!map.has(key)) {
      map.set(key, {
        key,
        cwd,
        name: getProjectName(cwd, t('unsetCwd')),
        latest: session.updated_at || '',
        sessions: [],
      });
    }
    const group = map.get(key);
    group.sessions.push(session);
    if ((session.updated_at || '') > (group.latest || '')) {
      group.latest = session.updated_at || '';
    }
  }
  return [...map.values()].sort((a, b) => (b.latest || '').localeCompare(a.latest || ''));
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

function openCurrentCwdSessionGroup() {
  const current = cwdInput.value.trim();
  if (!current) return;
  sessionGroupOpenState.set(normalizeCwdKey(current), true);
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
  currentContent = [];
  streamBlocks = {};
  currentSessionId = sessionId;
  totalCost = Number.isFinite(savedCost) ? savedCost : 0;
  totalTokens = normalizeTokenUsage(savedTokens);
  renderTopbarMeta(model || modelSelect.value);
  renderCost();
  renderTokens();

  // 设置 UI
  if (cwd) cwdInput.value = cwd;
  openCurrentCwdSessionGroup();
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
      renderHistory(history);
    }
  } catch(e) {
    console.error('历史消息加载失败:', e);
  }

  const result = await sendAction('resume_session', {
    session_id: sessionId,
    model: model || modelSelect.value,
    cli: cli || document.getElementById('cli-select')?.value || '',
    cwd: cwd || cwdInput.value.trim() || null,
    skip_permissions: document.getElementById('skip-permissions').checked,
    remote_target_id: remoteTargetId || '',
    allow_remote_mutate: !!remoteAllowMutate?.checked,
  });

  if (result && result.ok) {
    sessionActive = true;
    updateUI();
    addSystemMsg(t('restored'));
  } else {
    addSystemMsg(t('restoreFailed', { message: result?.error || t('unknownError') }), true);
  }
  loadSessions();
}

function renderHistory(history) {
  for (const msg of history) {
    if (msg.role === 'user') {
      addUserMessage(msg.text);
    } else if (msg.role === 'assistant') {
      const el = createAssistantBubble();
      const contentEl = el.querySelector('.msg-content');
      let html = '';
      for (const block of (msg.blocks || [])) {
        if (block.type === 'text') {
          html += `<div class="text-block">${renderMd(block.text)}</div>`;
        } else if (block.type === 'tool_use') {
          html += renderHistoryToolCard(block);
        }
      }
      contentEl.innerHTML = html;
      initHistoryToolCards(contentEl);
    }
  }
  scrollToBottom();
}

function renderHistoryToolCard(block) {
  const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
  const preview = input.replace(/\s+/g, ' ').trim().substring(0, 100);
  return `<div class="tool-card history-tool-collapsible">
    <button type="button" class="tool-header history-tool-toggle">
      <span class="history-arrow">&#9654;</span>
      <span class="tool-icon">&#9881;</span>
      <span class="history-label">${esc(block.name || t('tool'))}</span>
      <span class="history-preview">${esc(preview || t('historyEmpty'))}</span>
    </button>
    <div class="tool-body">${esc(input)}</div>
  </div>`;
}

function initHistoryToolCards(root) {
  root.querySelectorAll('.history-tool-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      toggle.closest('.history-tool-collapsible')?.classList.toggle('history-tool-open');
    });
  });
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

btnBrowse.addEventListener('click', () => {
  if (!sessionActive) openPicker();
});
pickerClose.addEventListener('click', closePicker);
pickerOverlay.addEventListener('click', (e) => {
  if (e.target === pickerOverlay) closePicker();
});
pickerUp.addEventListener('click', () => {
  navigatePicker(pickerCurrentDir === '/' ? '/' : getParentPath(pickerCurrentDir));
});
pickerSelect.addEventListener('click', () => {
  cwdInput.value = pickerCurrentDir;
  slashCommands = [];
  closeSlashCommandPanel();
  openCurrentCwdSessionGroup();
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

function openPicker() {
  pickerOverlay.style.display = 'flex';
  navigatePicker(cwdInput.value || '/');
}

function closePicker() {
  pickerOverlay.style.display = 'none';
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
