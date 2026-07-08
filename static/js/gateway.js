(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let gatewayConfig = null;
  let gatewayScopes = [];
  let onboardState = null;

  function formatMessage(data, fallbackKey = 'unknownError') {
    return root.i18n?.formatMessage ? root.i18n.formatMessage(data, fallbackKey) : String(data?.error || data?.message || t(fallbackKey) || '');
  }

  function init() {
    document.getElementById('btn-feishu-gateway-refresh')?.addEventListener('click', loadGateway);
    document.getElementById('btn-feishu-gateway-save')?.addEventListener('click', () => saveConfig());
    document.getElementById('btn-feishu-copy-url')?.addEventListener('click', copyEventUrl);
    document.getElementById('btn-feishu-onboard-start')?.addEventListener('click', beginOnboard);
    document.getElementById('btn-feishu-onboard-cancel')?.addEventListener('click', () => cancelOnboard(false));
    document.getElementById('feishu-gateway-enabled')?.addEventListener('change', () => saveConfig({ silent: true }));
    document.getElementById('btn-feishu-platform-config')?.addEventListener('click', () => {
      document.getElementById('gateway-platform-detail-feishu')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function loadGateway() {
    await Promise.all([loadConfig(), loadScopes()]);
    updateQR();
  }

  function getEventUrl() {
    const lanIps = gatewayConfig?.lan_ips || [];
    if (lanIps.length > 0) {
      return `http://${lanIps[0]}:${location.port}/api/feishu-gateway/events`;
    }
    return `${location.origin}/api/feishu-gateway/events`;
  }

  function updateQR() {
    const img = document.getElementById('feishu-qr-image');
    if (!img) return;
    if (!gatewayConfig?.qrcode_available) {
      img.style.display = 'none';
      return;
    }
    img.style.display = '';
    const eventUrlInput = document.getElementById('feishu-event-url');
    const fullUrl = eventUrlInput?.value || '/api/feishu-gateway/events';
    const absoluteUrl = fullUrl.startsWith('http') ? fullUrl : getEventUrl();
    img.src = `/api/feishu-gateway/qr?url=${encodeURIComponent(absoluteUrl)}`;
  }

  function updateUIState(config) {
    const hasCredentials = !!(config?.app_id && config?.app_secret);
    const onboardArea = document.getElementById('feishu-onboard-area');
    const eventQrArea = document.getElementById('feishu-event-qr-area');

    if (onboardArea) onboardArea.style.display = hasCredentials ? 'none' : '';
    if (eventQrArea) eventQrArea.style.display = hasCredentials ? '' : 'none';

    if (!hasCredentials) updateOnboardQR();
    else updateQR();
  }

  function updateOnboardQR() {
    if (!onboardState?.qr_url) return;
    const img = document.getElementById('feishu-onboard-qr-image');
    const box = document.getElementById('feishu-onboard-qr-box');
    if (!img || !box) return;
    img.src = `/api/feishu-gateway/qr?url=${encodeURIComponent(onboardState.qr_url)}`;
    box.style.display = '';
  }

  async function beginOnboard() {
    const startBtn = document.getElementById('btn-feishu-onboard-start');
    const cancelBtn = document.getElementById('btn-feishu-onboard-cancel');
    const progress = document.getElementById('feishu-onboard-progress');
    const status = document.getElementById('feishu-onboard-status');

    if (startBtn) startBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = '';
    if (progress) progress.style.display = '';
    if (status) status.textContent = t('feishuOnboardConnecting') || 'Connecting to Feishu...';

    try {
      const resp = await root.api.request('/api/feishu-gateway/onboard/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'feishu' }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(formatMessage(data, 'unknownError'));

      onboardState = {
        device_code: data.device_code,
        qr_url: data.qr_url,
        user_code: data.user_code,
        expire_in: data.expire_in,
      };
      updateOnboardQR();

      if (status) {
        if (data.user_code) {
          status.textContent = (t('feishuOnboardScanHint') || 'Scan QR with Feishu app. Code:') + ' ' + data.user_code;
        } else {
          status.textContent = t('feishuOnboardScanHint') || 'Scan the QR code with Feishu app to authorize.';
        }
      }

      pollOnboard();
    } catch (e) {
      if (status) status.textContent = (t('feishuOnboardFailed') || 'Failed: ') + (e.message || t('unknownError'));
      cancelOnboard(true);
    }
  }

  async function pollOnboard() {
    if (!onboardState) return;
    const deviceCode = onboardState.device_code;
    let data;

    try {
      const resp = await root.api.request('/api/feishu-gateway/onboard/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      });
      data = await resp.json();
    } catch (e) { data = { status: 'error', error: e.message }; }

    if (data.status === 'completed') {
      handleOnboardSuccess(data);
      return;
    }
    if (data.status === 'failed') {
      const status = document.getElementById('feishu-onboard-status');
      if (status) status.textContent = (t('feishuOnboardFailed') || 'Registration failed: ') + formatMessage(data);
      cancelOnboard(true);
      return;
    }
    onboardState.timer = setTimeout(pollOnboard, 3000);
  }

  function handleOnboardSuccess(data) {
    const appId = document.getElementById('feishu-app-id');
    const appSecret = document.getElementById('feishu-app-secret');
    const connMode = document.getElementById('feishu-connection-mode');
    if (appId) appId.value = data.app_id || '';
    if (appSecret) appSecret.value = data.app_secret || '';
    if (connMode) connMode.value = 'websocket';

    if (data.open_id) {
      const allowedUsers = document.getElementById('feishu-allowed-users');
      if (allowedUsers) allowedUsers.value = data.open_id;
    }

    const enabledToggle = document.getElementById('feishu-gateway-enabled');
    if (enabledToggle) enabledToggle.checked = true;

    const status = document.getElementById('feishu-onboard-status');
    const botName = data.bot_name || '';
    if (status) {
      status.textContent = (t('feishuOnboardSuccess') || 'Bot created successfully!') +
        (botName ? ' (' + botName + ')' : '');
    }

    cancelOnboard();
    const onboardArea = document.getElementById('feishu-onboard-area');
    if (onboardArea) {
      const startBtn = document.getElementById('btn-feishu-onboard-start');
      const progress = document.getElementById('feishu-onboard-progress');
      const cancelBtn = document.getElementById('btn-feishu-onboard-cancel');
      const qrBox = document.getElementById('feishu-onboard-qr-box');
      if (startBtn) startBtn.style.display = 'none';
      if (progress) progress.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (qrBox) qrBox.style.display = 'none';
    }

    const eventQrArea = document.getElementById('feishu-event-qr-area');
    if (eventQrArea) eventQrArea.style.display = '';

    saveConfig();
  }

  function cancelOnboard(keepStatus) {
    if (onboardState?.timer) clearTimeout(onboardState.timer);
    onboardState = null;

    const startBtn = document.getElementById('btn-feishu-onboard-start');
    const cancelBtn = document.getElementById('btn-feishu-onboard-cancel');
    const progress = document.getElementById('feishu-onboard-progress');
    const qrBox = document.getElementById('feishu-onboard-qr-box');

    if (!keepStatus) {
      if (startBtn) startBtn.style.display = '';
      if (progress) progress.style.display = 'none';
    }
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (qrBox) qrBox.style.display = 'none';
  }

  async function loadConfig() {
    const status = document.getElementById('feishu-gateway-form-status');
    try {
      const resp = await root.api.request('/api/feishu-gateway/config');
      const data = await resp.json();
      if (!resp.ok) throw new Error(formatMessage(data, 'unknownError'));
      gatewayConfig = data.config || data || {};
      fillConfig(gatewayConfig);
      renderStatus(gatewayConfig);
      if (status) status.style.display = 'none';
    } catch (e) {
      gatewayConfig = null;
      renderStatus(null, e.message);
      if (status) {
        status.textContent = t('feishuGatewayLoadFailed');
        status.style.display = '';
      }
    }
  }

  async function loadScopes() {
    const list = document.getElementById('feishu-gateway-scope-list');
    if (!list) return;
    try {
      const resp = await root.api.request('/api/feishu-gateway/scopes');
      const data = await resp.json();
      if (!resp.ok) throw new Error(formatMessage(data, 'unknownError'));
      gatewayScopes = Array.isArray(data.scopes) ? data.scopes : (Array.isArray(data) ? data : []);
      renderScopes();
    } catch (e) {
      gatewayScopes = [];
      list.innerHTML = `<p class="empty-state error">${esc(t('feishuGatewayScopesLoadFailed'))}</p>`;
    }
  }

  function fillConfig(config) {
    const get = id => document.getElementById(id);
    const enabled = get('feishu-gateway-enabled');
    if (enabled) enabled.checked = !!config.enabled;
    const appId = get('feishu-app-id');
    if (appId) appId.value = config.app_id || '';
    const appSecret = get('feishu-app-secret');
    if (appSecret) appSecret.value = config.app_secret || '';
    const token = get('feishu-verification-token');
    if (token) token.value = config.verification_token || '';
    const busyMode = get('feishu-busy-mode');
    if (busyMode) busyMode.value = config.busy_mode === 'reject' ? 'reject' : 'queue';
    const allowedUsers = get('feishu-allowed-users');
    if (allowedUsers) allowedUsers.value = listToLines(config.allowed_users);
    const allowedChats = get('feishu-allowed-chats');
    if (allowedChats) allowedChats.value = listToLines(config.allowed_chats);
    const connMode = get('feishu-connection-mode');
    if (connMode) connMode.value = config.connection_mode === 'webhook' ? 'webhook' : 'websocket';
    const eventUrl = get('feishu-event-url');
    if (eventUrl) eventUrl.value = config.event_url || getEventUrl();
    updateUIState(config);
  }

  function readConfig() {
    return {
      enabled: !!document.getElementById('feishu-gateway-enabled')?.checked,
      app_id: document.getElementById('feishu-app-id')?.value.trim() || '',
      app_secret: document.getElementById('feishu-app-secret')?.value || '',
      verification_token: document.getElementById('feishu-verification-token')?.value || '',
      connection_mode: document.getElementById('feishu-connection-mode')?.value || 'websocket',
      busy_mode: document.getElementById('feishu-busy-mode')?.value === 'reject' ? 'reject' : 'queue',
      allowed_users: readDelimitedList(document.getElementById('feishu-allowed-users')?.value || ''),
      allowed_chats: readDelimitedList(document.getElementById('feishu-allowed-chats')?.value || ''),
    };
  }

  async function saveConfig(opts) {
    const silent = opts && opts.silent;
    const payload = readConfig();
    const status = document.getElementById('feishu-gateway-form-status');
    try {
      const resp = await root.api.request('/api/feishu-gateway/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(formatMessage(data, 'unknownError'));
      gatewayConfig = data.config || data || payload;
      fillConfig(gatewayConfig);
      renderStatus(gatewayConfig);
      if (status) {
        status.textContent = t('feishuGatewaySaved');
        status.style.display = silent ? 'none' : '';
      }
      if (!silent) showToast(t('feishuGatewaySaved'), 'success');
    } catch (e) {
      if (status) {
        status.textContent = t('feishuGatewaySaveFailed', { message: e.message || t('unknownError') });
        status.style.display = '';
      }
      showToast(t('feishuGatewaySaveFailed', { message: e.message || t('unknownError') }), 'error');
    }
  }

  function renderStatus(config, error = '') {
    const dots = [
      document.getElementById('feishu-gateway-status-dot'),
      document.getElementById('feishu-quick-status-dot'),
      document.getElementById('message-gateway-overall-dot'),
    ].filter(Boolean);
    const label = document.getElementById('feishu-gateway-status-label');
    const quickLabel = document.getElementById('feishu-quick-status-label');
    const overallLabel = document.getElementById('message-gateway-overall-label');
    const detail = document.getElementById('feishu-gateway-status-detail');
    const overallDetail = document.getElementById('message-gateway-overall-detail');
    const card = document.getElementById('gateway-platform-card-feishu');
    const appId = String(config?.app_id || '').trim();
    const appSecret = String(config?.app_secret || '').trim();
    const configured = !!(appId && appSecret);
    const enabled = !!config?.enabled;
    const statusKey = error ? 'workspaceError' : (enabled ? 'enabled' : (configured ? 'gatewayConfiguredDisabled' : 'gatewayUnconfigured'));
    const detailKey = error
      ? 'feishuGatewayUnavailable'
      : (enabled ? 'feishuGatewayEnabledHint' : (configured ? 'gatewayConfiguredDisabledHint' : 'feishuGatewayDisabledHint'));

    dots.forEach(dot => {
      dot.classList.toggle('online', enabled && !error);
      dot.classList.toggle('error', !!error);
      dot.classList.toggle('ready', configured && !enabled && !error);
    });
    card?.classList.toggle('configured', configured);
    card?.classList.toggle('enabled', enabled && !error);
    card?.classList.toggle('error', !!error);
    if (label) label.textContent = t(statusKey);
    if (quickLabel) quickLabel.textContent = t(enabled ? 'connected' : 'gatewayQuickConnect');
    if (overallLabel) overallLabel.textContent = t(statusKey);
    const qrcodeAvailable = !!config?.qrcode_available;
    const qrBox = document.querySelector('.feishu-qr-box');
    const scanTitle = document.querySelector('.feishu-scan-card h3');
    if (qrBox) qrBox.style.display = qrcodeAvailable ? '' : 'none';
    if (scanTitle) scanTitle.style.display = qrcodeAvailable ? '' : 'none';
    if (detail) {
      if (!qrcodeAvailable) {
        detail.textContent = t('feishuQrcodeUnavailable');
      } else {
        detail.textContent = error
          ? t(detailKey, { message: error })
          : t(detailKey);
      }
    }
    if (overallDetail) {
      overallDetail.textContent = error
        ? t('gatewayOverallError', { message: error })
        : (enabled ? t('gatewayOverallEnabled') : (configured ? t('gatewayOverallDisabled') : t('gatewayNoPlatformConfigured')));
    }
  }

  function renderScopes() {
    const list = document.getElementById('feishu-gateway-scope-list');
    if (!list) return;
    if (!gatewayScopes.length) {
      list.innerHTML = `<p class="empty-state">${esc(t('feishuGatewayNoScopes'))}</p>`;
      return;
    }
    list.innerHTML = gatewayScopes.map(scope => {
      const key = scope.scope_key || scope.key || scope.scope_id || '';
      const title = scope.chat_name || scope.scope_name || scope.chat_id || scope.scope_id || key;
      const sessionId = scope.session_id || '';
      const status = scope.running ? t('workspaceRunning') : (scope.status || t('workspaceIdle'));
      const updated = scope.updated_at || scope.last_active_at || scope.last_seen_at || '';
      return `
        <article class="feishu-scope-item" data-scope-key="${esc(key)}">
          <div class="feishu-scope-main">
            <div class="feishu-scope-title-row">
              <strong>${esc(title || t('feishuGatewayScope'))}</strong>
              <span class="scheduled-status ${scope.running ? 'status-running' : ''}">${esc(status)}</span>
            </div>
            <div class="feishu-scope-meta">${esc(key || '-')}</div>
            <div class="feishu-scope-meta">${esc(t('sessionId'))}: ${esc(sessionId || '-')}</div>
            ${updated ? `<div class="feishu-scope-meta">${esc(t('feishuLastActive'))}: ${esc(updated)}</div>` : ''}
          </div>
          <div class="feishu-scope-actions">
            <button class="btn-mini" data-act="stop">${esc(t('stop'))}</button>
            <button class="btn-mini danger" data-act="reset">${esc(t('restartSession'))}</button>
          </div>
        </article>
      `;
    }).join('');
    list.querySelectorAll('.feishu-scope-item').forEach(item => {
      item.querySelector('[data-act="stop"]')?.addEventListener('click', () => stopScope(item.dataset.scopeKey));
      item.querySelector('[data-act="reset"]')?.addEventListener('click', () => resetScope(item.dataset.scopeKey));
    });
  }

  async function stopScope(scopeKey) {
    if (!scopeKey) return;
    await postScopeAction('/api/feishu-gateway/stop-scope', scopeKey, t('sessionStopped'));
  }

  async function resetScope(scopeKey) {
    if (!scopeKey || !confirm(t('feishuConfirmResetScope', { scope: scopeKey }))) return;
    await postScopeAction('/api/feishu-gateway/reset-scope', scopeKey, t('feishuScopeReset'));
  }

  async function postScopeAction(url, scopeKey, successMessage) {
    try {
      const resp = await root.api.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope_key: scopeKey }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(formatMessage(data, 'unknownError'));
      showToast(successMessage, 'success');
      await loadScopes();
    } catch (e) {
      showToast(t('requestFailed', { message: e.message || t('unknownError') }), 'error');
    }
  }

  async function copyEventUrl() {
    const value = document.getElementById('feishu-event-url')?.value || getEventUrl();
    try {
      await navigator.clipboard.writeText(value);
      showToast(t('copied'), 'success');
    } catch (e) {
      showToast(t('copyFailed'), 'error');
    }
  }

  function readDelimitedList(value) {
    return String(value || '').split(/[\n,]/).map(v => v.trim()).filter(Boolean);
  }

  function listToLines(value) {
    return Array.isArray(value) ? value.join('\n') : String(value || '');
  }

  root.gateway = {
    init,
    loadGateway,
    loadConfig,
    loadScopes,
  };
})();
