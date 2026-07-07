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

  function initTheme() {
    updateThemeToggle();
    btnThemeToggle.addEventListener('click', () => {
      const nextTheme = document.documentElement.classList.contains('light-theme') ? 'dark' : 'light';
      applyTheme(nextTheme);
    });
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

    // 网关通知复选框：变化时持久化到 gui_settings
    if (notifyFeishu) {
      notifyFeishu.addEventListener('change', () => {
        applyNotifyFeishuPreference(notifyFeishu.checked, true);
      });
    }
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
      const data = await root.api.json('/api/gui-settings');
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
      applyNotifyFeishuPreference(Boolean(data.notify_feishu));
      await loadContextSettings();
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
      applyNotifyFeishuPreference(false);
      applyMemoryAutoInjectPreference(true);
      applyLanAccessPreference({ is_localhost: false, lan_access_enabled: false });
    }
  }

  async function saveThemePreference(theme) {
    await saveGuiSettings({ theme });
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
    initTheme,
    initInterfaceSettings,
    initNotifications,
    initLanAccessControl,
    applyLanAccessPreference,
    applyNotificationPreference,
    applyNotifyFeishuPreference,
    initMemoryAutoInjectControl,
    applyMemoryAutoInjectPreference,
    loadContextSettings,
    saveContextSettings,
    applyTheme,
    loadThemePreference,
    saveThemePreference,
    saveGuiSettings,
    applyFontSize,
    normalizeFontSize,
  };
})();
