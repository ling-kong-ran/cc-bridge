(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let modelsData = null;
  let settingsData = null;
  let generating = false;
  let imageModeActive = false;

  function t(key, vars = {}) {
    return root.i18n?.t?.(key, vars) || key;
  }

  function esc(value) {
    return root.formatters?.esc?.(value) || String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getActiveMessagesEl() {
    return root.imageGeneration?.getMessagesEl?.()
      || document.querySelector('.workspace-pane.active .messages')
      || document.getElementById('messages');
  }

  function isSafeGeneratedImageUrl(value) {
    try {
      const parsed = new URL(String(value || ''), window.location.origin);
      return parsed.origin === window.location.origin && parsed.pathname === '/api/file' ? parsed.href : '';
    } catch (e) {
      return '';
    }
  }

  async function loadModels(force = false) {
    if (modelsData && !force) return modelsData;
    modelsData = await root.api.json('/api/images/models');
    return modelsData;
  }

  async function loadSettings(force = false) {
    if (settingsData && !force) return settingsData;
    try {
      settingsData = await root.api.json('/api/images/settings');
    } catch (e) {
      settingsData = {};
    }
    return settingsData;
  }

  function providerConfigFields(providerId) {
    if (providerId === 'gemini') {
      return [
        { key: 'GEMINI_API_KEY', type: 'password', required: true },
        { key: 'GEMINI_BASE_URL', type: 'text', placeholder: 'https://generativelanguage.googleapis.com/v1beta' },
        { key: 'GEMINI_IMAGE_MODELS', type: 'text', placeholder: 'gemini-2.5-flash-image' },
      ];
    }
    return [
      { key: 'OPENAI_API_KEY', type: 'password', required: true },
      { key: 'OPENAI_BASE_URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'OPENAI_IMAGE_MODELS', type: 'text', placeholder: 'gpt-image-1' },
    ];
  }

  function getDefaultProviderId() {
    return settingsData?.provider || modelsData?.defaults?.provider || modelsData?.providers?.[0]?.id || '';
  }

  function getProvider(providerId = '') {
    const id = providerId || getDefaultProviderId();
    return (modelsData?.providers || []).find(item => item.id === id) || {};
  }

  function getDefaultModelId(provider) {
    return settingsData?.model || modelsData?.defaults?.model || provider?.models?.find?.(model => model.default)?.id || provider?.models?.[0]?.id || '';
  }

  function getDefaultSizeValue(provider) {
    return provider?.sizes ? (settingsData?.size || modelsData?.defaults?.size || '1024x1024') : (settingsData?.aspect_ratio || modelsData?.defaults?.aspect_ratio || '1:1');
  }

  function addOption(select, value, label, selected = false) {
    const opt = document.createElement('option');
    opt.value = String(value || '');
    opt.textContent = String(label || value || '');
    opt.selected = !!selected;
    select.appendChild(opt);
  }

  function createModeBanner() {
    let banner = document.getElementById('image-generation-mode-banner');
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'image-generation-mode-banner';
    banner.className = 'image-generation-mode-banner is-hidden';
    banner.innerHTML = `
      <span class="image-generation-mode-dot"></span>
      <span class="image-generation-mode-text"></span>
      <button type="button" class="btn-mini image-generation-mode-config"></button>
      <button type="button" class="btn-icon-mini image-generation-mode-close" aria-label="${esc(t('close'))}">×</button>
    `;
    const inputArea = document.querySelector('.input-area');
    const inputShell = inputArea?.querySelector(':scope > .input-shell');
    if (inputArea) {
      inputArea.insertBefore(banner, inputShell || inputArea.firstChild);
    }
    banner.querySelector('.image-generation-mode-close')?.addEventListener('click', () => setImageMode(false));
    banner.querySelector('.image-generation-mode-config')?.addEventListener('click', () => openImageSettings());
    return banner;
  }

  function updateImageModeUi() {
    const button = document.getElementById('btn-generate-image');
    button?.classList.toggle('active', imageModeActive);
    document.body?.classList.toggle('image-generation-mode-active', imageModeActive);
    const banner = createModeBanner();
    banner.classList.toggle('is-hidden', !imageModeActive);
    const text = banner.querySelector('.image-generation-mode-text');
    const config = banner.querySelector('.image-generation-mode-config');
    if (text) text.textContent = t('imageModeActiveHint');
    if (config) config.textContent = t('imageModeConfigLink');

    const input = document.getElementById('message-input');
    if (input) {
      const hasActiveSession = !!document.body?.classList.contains('has-active-session');
      if (hasActiveSession) {
        input.disabled = false;
        input.style.opacity = '1';
      }
      input.placeholder = imageModeActive ? t('imageModePlaceholder') : t('messagePlaceholder');
    }
  }

  function setImageMode(active) {
    imageModeActive = !!active;
    updateImageModeUi();
    if (imageModeActive) {
      document.getElementById('message-input')?.focus();
      loadModels().catch(() => {});
      loadSettings().catch(() => {});
      root.toast?.showToast?.(t('imageModeEnabled'), 'success');
    } else {
      root.toast?.showToast?.(t('imageModeDisabled'), 'info');
    }
  }

  function toggleImageMode() {
    setImageMode(!imageModeActive);
  }

  function openImageSettings() {
    document.getElementById('btn-nav-settings')?.click();
    const tab = document.querySelector('.settings-tab[data-tab="image"]');
    tab?.click();
  }

  function createAssistantShell(extraClass = '') {
    const host = getActiveMessagesEl();
    if (!host) return null;
    const el = document.createElement('div');
    el.className = `message assistant ${extraClass}`.trim();
    const avatar = document.createElement('div');
    avatar.className = 'avatar assistant-avatar';
    avatar.textContent = 'C';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    const content = document.createElement('div');
    content.className = 'msg-content';
    bubble.appendChild(content);
    el.appendChild(avatar);
    el.appendChild(bubble);
    host.appendChild(el);
    host.scrollTop = host.scrollHeight;
    return { el, content, host };
  }

  function createPendingCard() {
    const shell = createAssistantShell('generated-image-message streaming');
    if (!shell) return null;
    const placeholder = document.createElement('div');
    placeholder.className = 'generated-image-placeholder';
    placeholder.textContent = t('imageGenerating');
    shell.content.appendChild(placeholder);
    return shell.el;
  }

  function renderGeneratedImages(result, targetEl = null) {
    const shell = targetEl ? { el: targetEl, content: targetEl.querySelector('.msg-content') || targetEl.querySelector('.msg-bubble') } : createAssistantShell('generated-image-message');
    if (!shell?.content) return null;
    shell.el.classList.remove('streaming', 'error');
    shell.content.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'generated-image-title';
    title.textContent = t('imageGenerated');
    shell.content.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'generated-image-meta';
    meta.textContent = t('imageCardMeta', {
      provider: result.provider || '',
      model: result.model || '',
      size: result.size || result.aspect_ratio || '',
    });
    shell.content.appendChild(meta);

    for (const image of result.images || []) {
      const url = isSafeGeneratedImageUrl(image.url);
      if (!url) continue;
      const card = document.createElement('div');
      card.className = 'generated-image-card';
      const img = document.createElement('img');
      img.className = 'generated-image-preview';
      img.src = url;
      img.alt = image.name || t('imageGenerated');
      img.loading = 'lazy';
      card.appendChild(img);

      const body = document.createElement('div');
      body.className = 'generated-image-body';
      const name = document.createElement('div');
      name.className = 'generated-image-meta';
      name.textContent = image.name || image.path || '';
      body.appendChild(name);

      const actions = document.createElement('div');
      actions.className = 'generated-image-actions';
      actions.appendChild(createLink(url, t('imageOpenOriginal'), false));
      actions.appendChild(createLink(url, t('imageDownload'), true, image.name || 'generated-image'));
      actions.appendChild(createCopyButton(t('imageCopyUrl'), image.url || url));
      actions.appendChild(createCopyButton(t('imageCopyPath'), image.path || ''));
      body.appendChild(actions);
      card.appendChild(body);
      shell.content.appendChild(card);
    }
    shell.host?.scrollTo?.({ top: shell.host.scrollHeight, behavior: 'smooth' });
    return shell.el;
  }

  function createLink(url, label, download, name = '') {
    const link = document.createElement('a');
    link.className = 'btn-mini';
    link.href = url;
    link.textContent = label;
    if (download) link.download = name;
    else {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    return link;
  }

  function createCopyButton(label, value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-mini';
    button.textContent = label;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard?.writeText(value || '');
        root.toast?.showToast?.(t('copied'), 'success');
      } catch (e) {}
    });
    return button;
  }

  function showPendingError(pendingEl, message) {
    if (!pendingEl) return;
    pendingEl.classList.remove('streaming');
    pendingEl.classList.add('error');
    const content = pendingEl.querySelector('.msg-content') || pendingEl.querySelector('.msg-bubble');
    if (content) content.textContent = t('imageGenerateFailed', { message });
  }

  function isSupportedReferenceImage(file) {
    return !!file?.path && /\.(png|jpe?g|webp)$/i.test(file.path || file.name || '');
  }

  function imageAttachments(attachments = []) {
    return (attachments || [])
      .filter(isSupportedReferenceImage)
      .slice(0, 4)
      .map(file => ({ path: file.path, name: file.name || '', mime_type: file.mime_type || '' }));
  }

  async function buildPayload(prompt, options = {}) {
    await loadModels();
    await loadSettings();
    const providerId = settingsData?.provider || modelsData?.defaults?.provider || '';
    const provider = getProvider(providerId);
    if (!provider?.id) throw new Error(t('imageNoProviders'));
    if (provider.configured === false) throw new Error(t('imageProviderNotConfigured'));
    const sizeValue = getDefaultSizeValue(provider);
    return {
      provider: provider.id,
      model: getDefaultModelId(provider),
      prompt,
      cwd: options.cwd || document.getElementById('cwd-input')?.value.trim() || '',
      session_id: options.sessionId || '',
      size: provider.sizes ? sizeValue : '',
      aspect_ratio: provider.aspect_ratios ? sizeValue : '',
      quality: settingsData?.quality || modelsData?.defaults?.quality || '',
      n: Number(settingsData?.n || 1),
      input_images: imageAttachments(options.attachments),
      extra: {},
    };
  }

  async function generateFromPrompt(prompt, options = {}) {
    if (generating) return { ok: false, error: t('imageGenerating') };
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) return { ok: false, error: t('imagePromptRequired') };

    const referenceImages = imageAttachments(options.attachments);
    const skippedAttachments = (options.attachments || []).length - referenceImages.length;

    generating = true;
    const button = document.getElementById('btn-generate-image');
    button?.classList.add('loading');
    root.messageUi?.addUserMessage?.(`${t('generateImageShort')}: ${cleanPrompt}`, [], { messagesEl: getActiveMessagesEl() });
    const pendingEl = createPendingCard();

    try {
      const payload = await buildPayload(cleanPrompt, { ...options, attachments: referenceImages });
      const data = await root.api.postJson('/api/images/generate', payload);
      if (!data?.ok) throw new Error(data?.error || t('unknownError'));
      data.size = payload.size;
      data.aspect_ratio = payload.aspect_ratio;
      data.n = payload.n;
      if (skippedAttachments > 0) root.toast?.showToast?.(t('imageReferenceOnlyImages'), 'warning');
      renderGeneratedImages(data, pendingEl);
      return { ok: true, data };
    } catch (error) {
      showPendingError(pendingEl, error.message || t('unknownError'));
      return { ok: false, error: error.message || t('unknownError') };
    } finally {
      generating = false;
      button?.classList.remove('loading');
    }
  }

  function populateSelect(select, values, selectedValue) {
    if (!select) return;
    select.innerHTML = '';
    values.forEach(item => {
      const value = typeof item === 'string' ? item : item.id;
      const label = typeof item === 'string' ? item : (item.name || item.id);
      addOption(select, value, label, value === selectedValue);
    });
    if (select.options.length && !select.value) select.selectedIndex = 0;
  }

  function selectedSettingsProvider() {
    return getProvider(document.getElementById('image-settings-provider')?.value || getDefaultProviderId());
  }

  function renderSettingsProviderOptions(env = null) {
    const provider = selectedSettingsProvider();
    populateSelect(document.getElementById('image-settings-model'), provider.models || [], getDefaultModelId(provider));
    populateSelect(document.getElementById('image-settings-size'), provider.sizes || provider.aspect_ratios || [], getDefaultSizeValue(provider));
    const sizeLabel = document.getElementById('image-settings-size-label');
    if (sizeLabel) sizeLabel.textContent = provider.sizes ? t('imageSize') : t('imageAspectRatio');
    populateSelect(document.getElementById('image-settings-quality'), provider.qualities || [], settingsData?.quality || modelsData?.defaults?.quality || '');
    const qualityRow = document.getElementById('image-settings-quality-row');
    if (qualityRow) qualityRow.style.display = (provider.qualities || []).length ? '' : 'none';

    const envFields = document.getElementById('image-settings-env-fields');
    if (!envFields) return;
    envFields.innerHTML = '';
    providerConfigFields(provider.id).forEach(field => {
      const row = document.createElement('label');
      row.className = 'settings-row image-settings-env-row';
      const label = document.createElement('span');
      label.className = 'field-label';
      label.textContent = field.required ? `${field.key} *` : field.key;
      const input = document.createElement('input');
      input.className = 'input';
      input.type = field.type || 'text';
      input.dataset.envKey = field.key;
      input.value = env?.[field.key] || '';
      input.placeholder = field.placeholder || '';
      input.autocomplete = 'off';
      row.appendChild(label);
      row.appendChild(input);
      envFields.appendChild(row);
    });
  }

  async function loadImageSettingsForm() {
    const providerSelect = document.getElementById('image-settings-provider');
    if (!providerSelect) return;
    try {
      await loadModels(true);
      await loadSettings(true);
      const envPayload = await root.api.json('/api/images/env').catch(() => ({ env: {} }));
      providerSelect.innerHTML = '';
      const defaultProvider = getDefaultProviderId();
      (modelsData.providers || []).forEach(provider => addOption(
        providerSelect,
        provider.id,
        `${provider.name || provider.id}${provider.configured ? '' : ' · ' + t('gatewayUnconfigured')}`,
        provider.id === defaultProvider
      ));
      document.getElementById('image-settings-count').value = String(settingsData?.n || 1);
      renderSettingsProviderOptions(envPayload.env || {});
    } catch (error) {
      showImageSettingsStatus(t('artifactsLoadFailed'), true);
    }
  }

  function collectImageSettingsForm() {
    const provider = selectedSettingsProvider();
    const sizeValue = document.getElementById('image-settings-size')?.value || '';
    const env = {};
    document.querySelectorAll('#image-settings-env-fields [data-env-key]').forEach(input => {
      const value = input.value.trim();
      if (value) env[input.dataset.envKey] = value;
    });
    return {
      settings: {
        provider: provider.id || document.getElementById('image-settings-provider')?.value || '',
        model: document.getElementById('image-settings-model')?.value || '',
        size: provider.sizes ? sizeValue : '',
        aspect_ratio: provider.aspect_ratios ? sizeValue : '',
        quality: document.getElementById('image-settings-quality')?.value || '',
        n: Number(document.getElementById('image-settings-count')?.value || 1),
      },
      env,
    };
  }

  function showImageSettingsStatus(message, isError = false) {
    const status = document.getElementById('image-settings-status');
    if (!status) return;
    status.style.display = '';
    status.classList.toggle('error', !!isError);
    status.textContent = message || '';
  }

  async function saveImageSettingsForm() {
    const button = document.getElementById('btn-save-image-settings');
    if (button) button.disabled = true;
    try {
      const { settings, env } = collectImageSettingsForm();
      await root.api.postJson('/api/images/settings', settings);
      await root.api.postJson('/api/images/env', { env });
      modelsData = null;
      settingsData = null;
      await loadImageSettingsForm();
      showImageSettingsStatus(t('imageSettingsSaved'), false);
    } catch (error) {
      showImageSettingsStatus(t('imageSettingsSaveFailed', { message: error.message || t('unknownError') }), true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function initImageSettingsForm() {
    const providerSelect = document.getElementById('image-settings-provider');
    if (!providerSelect || providerSelect.dataset.imageSettingsBound === '1') return;
    providerSelect.dataset.imageSettingsBound = '1';
    providerSelect.addEventListener('change', async () => {
      const envPayload = await root.api.json('/api/images/env').catch(() => ({ env: {} }));
      renderSettingsProviderOptions(envPayload.env || {});
    });
    document.getElementById('btn-save-image-settings')?.addEventListener('click', saveImageSettingsForm);
    loadImageSettingsForm();
  }

  function initImageGeneration() {
    const button = document.getElementById('btn-generate-image');
    if (button && button.dataset.imageGenerationBound !== '1') {
      button.dataset.imageGenerationBound = '1';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleImageMode();
      });
    }
    createModeBanner();
    updateImageModeUi();
    initImageSettingsForm();
  }

  root.imageGeneration = {
    initImageGeneration,
    toggleImageMode,
    setImageMode,
    isImageModeActive: () => imageModeActive,
    generateFromPrompt,
    renderGeneratedImages,
    getMessagesEl: null,
  };
})();
