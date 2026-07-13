(function () {
  const root = window.CCBridge = window.CCBridge || {};

  async function loadDefaultCwd() {
    try {
      const data = await root.api.json('/api/default-cwd');
      if (data.cwd && !cwdInput.value.trim()) {
        cwdInput.value = data.cwd;
        updateRuntimeSummary();
        loadSessions();
        refreshRightPaneFiles();
      }
    } catch (e) { /* ignore */ }
  }

  function initInterfaceSettings() {
    languageSelect?.addEventListener('change', () => {
      applyLanguage(languageSelect.value || 'en').then(() => {
        loadConfig();
        loadSessions();
        renderSessionList(cachedSessions);
      }).catch((e) => {
        console.warn('Apply language failed:', e);
      });
    });
    fontSizeRange?.addEventListener('input', () => {
      applyFontSize(Number(fontSizeRange.value || 100));
    });
  }

  function initNotifications() {
    if (!notificationsToggle) return;
    const desktopNotifications = Boolean(window.ccBridgeDesktop?.notify);
    if (!desktopNotifications && !("Notification" in window)) {
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
      if (desktopNotifications) {
        notificationsEnabled = true;
        saveGuiSettings({ notifications_enabled: true });
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

    // 网关通知复选框：只有对应网关已完成必备参数配置时才允许开启。
    if (notifyFeishu) {
      notifyFeishu.addEventListener('change', async () => {
        if (!notifyFeishu.checked) {
          applyNotifyFeishuPreference(false, true);
          return;
        }
        const configured = await isFeishuNotifyGatewayConfigured();
        if (!configured) {
          applyNotifyFeishuPreference(false, true);
          showToast?.(t('gatewayNotifyUnconfigured'), 'error');
          return;
        }
        applyNotifyFeishuPreference(true, true);
      });
    }
  }

  function initLanAccessControl() {
    lanAccessToggle?.addEventListener('change', async () => {
      await saveGuiSettings({ lan_access_enabled: lanAccessToggle.checked });
      addSystemMsg(lanAccessToggle.checked ? t('lanAccessEnabled') : t('lanAccessDisabled'));
    });
  }

  function initSkipPermissionsControl() {
    const toggle = document.getElementById('skip-permissions');
    toggle?.addEventListener('change', () => {
      saveGuiSettings({ skip_permissions: toggle.checked });
    });
  }

  function applySkipPermissionsPreference(value) {
    const toggle = document.getElementById('skip-permissions');
    if (toggle) toggle.checked = value !== false;
  }

  function applyLanAccessPreference(settings) {
    if (!lanAccessRow || !lanAccessToggle) return;
    const isLocalhost = Boolean(settings.is_localhost);
    lanAccessRow.style.display = isLocalhost ? '' : 'none';
    lanAccessToggle.checked = settings.lan_access_enabled !== false;
  }

  function applyNotificationPreference(enabled, persist = false) {
    const desktopNotifications = Boolean(window.ccBridgeDesktop?.notify);
    const supported = desktopNotifications || "Notification" in window;
    const granted = desktopNotifications || ("Notification" in window && Notification.permission === 'granted');
    notificationsEnabled = Boolean(enabled && supported && granted);
    if (notificationsToggle) {
      notificationsToggle.checked = notificationsEnabled;
      notificationsToggle.disabled = !supported;
    }
    if (persist) saveGuiSettings({ notifications_enabled: notificationsEnabled });
  }

  async function isFeishuNotifyGatewayConfigured() {
    try {
      const config = await root.gateway?.getConfig?.();
      return Boolean(String(config?.app_id || '').trim() && String(config?.app_secret || '').trim());
    } catch (e) {
      return false;
    }
  }

  function applyNotifyFeishuPreference(enabled, persist = false) {
    if (notifyFeishu) {
      notifyFeishu.checked = Boolean(enabled);
    }
    if (persist) saveGuiSettings({ notify_feishu: Boolean(enabled) });
  }

  function initMemoryAutoInjectControl() {
    memoryAutoInject?.addEventListener('change', async () => {
      await saveContextSettings({ memoryAutoInject: memoryAutoInject.checked });
    });
  }

  function applyMemoryAutoInjectPreference(enabled) {
    if (memoryAutoInject) memoryAutoInject.checked = enabled !== false;
  }

  function initMemoryAssistantModelControl() {
    const sel = document.getElementById('memory-assistant-model-select');
    if (!sel) return;
    _populateMemoryAssistantModels(sel);
    sel.addEventListener('change', () => {
      saveGuiSettings({ memory_assistant_model: sel.value || '' });
    });
  }

  async function _populateMemoryAssistantModels(sel) {
    try {
      const data = await root.api.json('/api/models');
      // 保留默认「跟随会话模型」选项，追加每个可用模型
      const models = Array.isArray(data) ? data : [];
      for (const m of models) {
        const value = typeof m === 'string' ? m : (m && m.value);
        if (!value) continue;
        const label = (m && m.label) || value;
        if (Array.from(sel.options).some(o => o.value === value)) continue;
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
      }
    } catch (e) { /* 拉取失败时仅保留默认选项 */ }
  }

  function applyMemoryAssistantModelPreference(value) {
    const sel = document.getElementById('memory-assistant-model-select');
    if (!sel) return;
    const v = value || '';
    // 值不在列表里（异步填充竞态）时临时补一个选项，保证可见
    if (v && !Array.from(sel.options).some(o => o.value === v)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    sel.value = v;
  }

  function initMemoryAutoConsolidateControl() {
    const toggle = document.getElementById('memory-auto-consolidate');
    toggle?.addEventListener('change', () => {
      saveGuiSettings({ memoryAutoConsolidate: toggle.checked ? 'auto' : 'off' });
    });
  }

  function applyMemoryAutoConsolidatePreference(value) {
    const toggle = document.getElementById('memory-auto-consolidate');
    if (toggle) toggle.checked = value !== 'off';
  }

  async function loadContextSettings() {
    try {
      const resp = await root.api.request('/api/context/settings');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      applyMemoryAutoInjectPreference(data.memoryAutoInject);
    } catch (e) {
      applyMemoryAutoInjectPreference(true);
    }
  }

  async function saveContextSettings(settings) {
    try {
      const resp = await root.api.request('/api/context/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      applyMemoryAutoInjectPreference(data.memoryAutoInject);
    } catch (e) {
      addSystemMsg(t('contextSettingsSaveFailed'), true);
    }
  }

  async function loadThemePreference() {
    let data;
    try {
      data = await root.api.json('/api/gui-settings');
    } catch (e) {
      applyFontSize(100, false);
      try {
        await applyLanguage('en', false);
      } catch (err) {
        console.warn('Apply fallback language failed:', err);
      }
      applyNotificationPreference(false);
      applyNotifyFeishuPreference(false);
      applyMemoryAutoInjectPreference(true);
      applyLanAccessPreference({ is_localhost: false, lan_access_enabled: false });
      applySkipPermissionsPreference(true);
      applyMemoryAssistantModelPreference('');
      applyMemoryAutoConsolidatePreference('auto');
      return;
    }

    const language = data.language === 'zh' ? 'zh' : 'en';
    const size = normalizeFontSize(data.font_size_percent);
    savedModelPref = data.default_model || '';
    autoUpdateEnabled = data.auto_update_enabled !== false;
    skipUpdateVersion = data.skip_update_version || '';
    const autoUpdateToggle = document.getElementById('auto-update-toggle');
    if (autoUpdateToggle) autoUpdateToggle.checked = autoUpdateEnabled;

    if (languageSelect) languageSelect.value = language;
    if (notifyFeishu) notifyFeishu.checked = data.notify_feishu === true;

    applyFontSize(size, false);
    try {
      await applyLanguage(language, false);
    } catch (e) {
      console.warn('Apply saved language failed:', e);
      if (languageSelect) languageSelect.value = language;
    }
    applyNotificationPreference(Boolean(data.notifications_enabled));
    applyNotifyFeishuPreference(data.notify_feishu === true && await isFeishuNotifyGatewayConfigured());
    try {
      await loadContextSettings();
    } catch (e) {
      console.warn('Load context settings failed:', e);
      applyMemoryAutoInjectPreference(true);
    }
    accessContext = { isLocalhost: Boolean(data.is_localhost), defaultCwd: data.default_cwd || '' };
    document.body.classList.toggle('pane-right-collapsed', data.right_panel_collapsed === true);
    try {
      applyRightPaneWidth(data.right_panel_width);
    } catch (e) {
      console.warn('Apply right pane width failed:', e);
    }
    applyLanAccessPreference(data);
    applySkipPermissionsPreference(data.skip_permissions);
    applyMemoryAssistantModelPreference(data.memory_assistant_model);
    applyMemoryAutoConsolidatePreference(data.memoryAutoConsolidate);

    if (data.language !== language || Number(data.font_size_percent) !== size) {
      saveGuiSettings({ language, font_size_percent: size });
    }
  }

  async function saveGuiSettings(settings) {
    try {
      await root.api.postJson('/api/gui-settings', settings);
    } catch (e) { /* ignore */ }
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

  root.settings = {
    loadDefaultCwd,
    initInterfaceSettings,
    initNotifications,
    initLanAccessControl,
    applyLanAccessPreference,
    initSkipPermissionsControl,
    applySkipPermissionsPreference,
    applyNotificationPreference,
    applyNotifyFeishuPreference,
    initMemoryAutoInjectControl,
    applyMemoryAutoInjectPreference,
    initMemoryAssistantModelControl,
    applyMemoryAssistantModelPreference,
    initMemoryAutoConsolidateControl,
    applyMemoryAutoConsolidatePreference,
    loadContextSettings,
    saveContextSettings,
    loadThemePreference,
    saveGuiSettings,
    applyFontSize,
    normalizeFontSize,
  };
})();
