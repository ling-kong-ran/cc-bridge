(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let modelsData = null;
  let settingsData = null;
  let generating = false;

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

  function createPanel() {
    let panel = document.getElementById('image-generation-panel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'image-generation-panel';
    panel.className = 'image-generation-panel is-hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.innerHTML = `
      <div class="image-generation-head">
        <div>
          <h2 class="image-generation-title">${esc(t('imageGenerationTitle'))}</h2>
          <div class="image-generation-subtitle">${esc(t('imageGenerationSubtitle'))}</div>
        </div>
        <button type="button" class="btn-icon-mini image-generation-close" data-i18n-title="close" aria-label="${esc(t('close'))}">×</button>
      </div>
      <div class="image-generation-grid">
        <label class="image-generation-field">
          <span class="image-generation-label">${esc(t('imageProvider'))}</span>
          <select id="image-generation-provider" class="select"></select>
        </label>
        <label class="image-generation-field">
          <span class="image-generation-label">${esc(t('imageModel'))}</span>
          <select id="image-generation-model" class="select"></select>
        </label>
        <label class="image-generation-field" id="image-generation-size-field">
          <span class="image-generation-label" id="image-generation-size-text">${esc(t('imageSize'))}</span>
          <select id="image-generation-size" class="select"></select>
        </label>
        <label class="image-generation-field" id="image-generation-quality-field">
          <span class="image-generation-label">${esc(t('imageQuality'))}</span>
          <select id="image-generation-quality" class="select"></select>
        </label>
        <label class="image-generation-field">
          <span class="image-generation-label">${esc(t('imageCount'))}</span>
          <select id="image-generation-count" class="select">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
          </select>
        </label>
        <label class="image-generation-field full">
          <span class="image-generation-label">${esc(t('imagePrompt'))}</span>
          <textarea id="image-generation-prompt" class="input image-generation-prompt" rows="4" placeholder="${esc(t('imagePromptPlaceholder'))}"></textarea>
        </label>
      </div>
      <div class="image-generation-config is-hidden" id="image-generation-config">
        <div class="image-generation-config-title">${esc(t('imageApiConfigTitle'))}</div>
        <div class="image-generation-config-desc" id="image-generation-config-desc"></div>
        <div class="image-generation-config-fields" id="image-generation-config-fields"></div>
        <div class="image-generation-config-actions">
          <button type="button" class="btn image-generation-config-close">${esc(t('close'))}</button>
          <button type="button" class="btn btn-primary image-generation-config-save">${esc(t('imageApiConfigSave'))}</button>
        </div>
      </div>
      <div class="image-generation-actions">
        <span class="image-generation-hint">${esc(t('imagePanelHint'))}</span>
        <span class="image-generation-error" style="display:none"></span>
        <button type="button" class="btn image-generation-config-toggle">${esc(t('imageApiConfigButton'))}</button>
        <button type="button" class="btn image-generation-cancel">${esc(t('cancel'))}</button>
        <button type="button" class="btn btn-primary image-generation-submit">${esc(t('imageGenerateSubmit'))}</button>
      </div>
    `;
    document.querySelector('.input-area')?.appendChild(panel);
    panel.querySelector('.image-generation-close')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeImagePanel();
    });
    panel.querySelector('.image-generation-cancel')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeImagePanel();
    });
    panel.querySelector('.image-generation-submit')?.addEventListener('click', generateImage);
    panel.querySelector('.image-generation-config-toggle')?.addEventListener('click', toggleApiConfig);
    panel.querySelector('.image-generation-config-close')?.addEventListener('click', hideApiConfig);
    panel.querySelector('.image-generation-config-save')?.addEventListener('click', saveApiConfig);
    panel.querySelector('#image-generation-provider')?.addEventListener('change', () => renderProviderOptions(panel));
    return panel;
  }

  function addOption(select, value, label, selected = false) {
    const opt = document.createElement('option');
    opt.value = String(value || '');
    opt.textContent = String(label || value || '');
    opt.selected = !!selected;
    select.appendChild(opt);
  }

  async function loadModels() {
    if (modelsData) return modelsData;
    modelsData = await root.api.json('/api/images/models');
    return modelsData;
  }

  async function loadSettings() {
    if (settingsData) return settingsData;
    try {
      settingsData = await root.api.json('/api/images/settings');
    } catch (e) {
      settingsData = {};
    }
    return settingsData;
  }

  function getDefaultProviderId() {
    return settingsData?.provider || modelsData?.defaults?.provider || '';
  }

  function getDefaultModelId(provider) {
    return settingsData?.model || modelsData?.defaults?.model || provider?.models?.find?.(model => model.default)?.id || provider?.models?.[0]?.id || '';
  }

  function getDefaultSizeValue(provider) {
    return provider?.sizes ? (settingsData?.size || modelsData?.defaults?.size || '1024x1024') : (settingsData?.aspect_ratio || modelsData?.defaults?.aspect_ratio || '1:1');
  }

  function renderProviderOptions(panel) {
    const providerId = panel.querySelector('#image-generation-provider')?.value || getDefaultProviderId();
    const provider = (modelsData?.providers || []).find(item => item.id === providerId) || {};
    const modelSelect = panel.querySelector('#image-generation-model');
    const sizeSelect = panel.querySelector('#image-generation-size');
    const qualitySelect = panel.querySelector('#image-generation-quality');
    const countSelect = panel.querySelector('#image-generation-count');
    const sizeText = panel.querySelector('#image-generation-size-text');
    const qualityField = panel.querySelector('#image-generation-quality-field');

    const defaultModel = getDefaultModelId(provider);
    modelSelect.innerHTML = '';
    (provider.models || []).forEach(model => addOption(modelSelect, model.id, model.name || model.id, model.id === defaultModel));
    if (modelSelect.options.length && !modelSelect.value) modelSelect.selectedIndex = 0;

    const sizes = provider.sizes || provider.aspect_ratios || [];
    const defaultSize = getDefaultSizeValue(provider);
    sizeSelect.innerHTML = '';
    sizes.forEach(value => addOption(sizeSelect, value, value, value === defaultSize));
    if (sizeSelect.options.length && !sizeSelect.value) sizeSelect.selectedIndex = 0;
    if (sizeText) sizeText.textContent = provider.sizes ? t('imageSize') : t('imageAspectRatio');

    const qualities = provider.qualities || [];
    const defaultQuality = settingsData?.quality || modelsData?.defaults?.quality || '';
    qualitySelect.innerHTML = '';
    qualities.forEach(value => addOption(qualitySelect, value, value, value === defaultQuality));
    if (qualitySelect.options.length && !qualitySelect.value) qualitySelect.selectedIndex = 0;
    if (qualityField) qualityField.style.display = qualities.length ? '' : 'none';
    if (countSelect && settingsData?.n) countSelect.value = String(settingsData.n);

    const errorEl = panel.querySelector('.image-generation-error');
    if (errorEl) {
      errorEl.style.display = provider.configured === false ? '' : 'none';
      errorEl.textContent = provider.configured === false ? t('imageProviderNotConfigured') : '';
    }
  }

  function isImagePanelOpen() {
    const panel = document.getElementById('image-generation-panel');
    return !!panel && !panel.classList.contains('is-hidden') && !panel.hidden;
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

  function renderApiConfig(panel, env = {}) {
    const providerId = panel.querySelector('#image-generation-provider')?.value || getDefaultProviderId() || 'openai';
    const provider = (modelsData?.providers || []).find(item => item.id === providerId) || {};
    const desc = panel.querySelector('#image-generation-config-desc');
    const fieldsEl = panel.querySelector('#image-generation-config-fields');
    if (desc) desc.textContent = t('imageApiConfigDesc', { provider: provider.name || providerId });
    if (!fieldsEl) return;
    fieldsEl.innerHTML = '';
    providerConfigFields(providerId).forEach(field => {
      const row = document.createElement('label');
      row.className = 'image-generation-config-field';
      const label = document.createElement('span');
      label.className = 'image-generation-label';
      label.textContent = field.required ? `${field.key} *` : field.key;
      const input = document.createElement('input');
      input.className = 'input image-generation-config-input';
      input.type = field.type || 'text';
      input.dataset.envKey = field.key;
      input.value = env[field.key] || '';
      input.placeholder = field.placeholder || '';
      input.autocomplete = 'off';
      row.appendChild(label);
      row.appendChild(input);
      fieldsEl.appendChild(row);
    });
  }

  async function showApiConfig() {
    const panel = createPanel();
    const box = panel.querySelector('#image-generation-config');
    if (!box) return;
    try {
      const data = await root.api.json('/api/images/env');
      renderApiConfig(panel, data?.env || {});
    } catch (e) {
      renderApiConfig(panel, {});
    }
    box.classList.remove('is-hidden');
  }

  function hideApiConfig() {
    document.getElementById('image-generation-config')?.classList.add('is-hidden');
  }

  function toggleApiConfig(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const box = document.getElementById('image-generation-config');
    if (box && !box.classList.contains('is-hidden')) hideApiConfig();
    else showApiConfig();
  }

  async function saveApiConfig(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const panel = createPanel();
    const button = panel.querySelector('.image-generation-config-save');
    const errorEl = panel.querySelector('.image-generation-error');
    if (button) button.disabled = true;
    try {
      const env = {};
      panel.querySelectorAll('.image-generation-config-input').forEach(input => {
        const key = input.dataset.envKey;
        if (!key) return;
        const value = input.value.trim();
        if (value) env[key] = value;
      });
      await root.api.postJson('/api/images/env', { env });
      modelsData = null;
      await loadModels();
      renderProviderOptions(panel);
      hideApiConfig();
      if (errorEl) {
        errorEl.style.display = '';
        errorEl.textContent = t('imageApiConfigSaved');
      }
    } catch (error) {
      if (errorEl) {
        errorEl.style.display = '';
        errorEl.textContent = t('imageApiConfigSaveFailed', { message: error.message || t('unknownError') });
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function openImagePanel() {
    const panel = createPanel();
    panel.hidden = false;
    panel.classList.remove('is-hidden');
    document.getElementById('btn-generate-image')?.classList.add('active');
    const promptEl = panel.querySelector('#image-generation-prompt');
    if (promptEl && !promptEl.value.trim()) promptEl.value = document.getElementById('message-input')?.value || '';

    try {
      await loadModels();
      await loadSettings();
      const providerSelect = panel.querySelector('#image-generation-provider');
      const defaultProvider = getDefaultProviderId();
      providerSelect.innerHTML = '';
      (modelsData.providers || []).forEach(provider => addOption(
        providerSelect,
        provider.id,
        `${provider.name || provider.id}${provider.configured ? '' : ' · ' + t('gatewayUnconfigured')}`,
        provider.id === defaultProvider
      ));
      renderProviderOptions(panel);
      promptEl?.focus();
    } catch (error) {
      const errorEl = panel.querySelector('.image-generation-error');
      if (errorEl) {
        errorEl.style.display = '';
        errorEl.textContent = error.message || t('artifactsLoadFailed');
      }
    }
  }

  function closeImagePanel() {
    const panel = document.getElementById('image-generation-panel');
    if (panel) {
      panel.classList.add('is-hidden');
      panel.hidden = true;
    }
    document.getElementById('btn-generate-image')?.classList.remove('active');
  }

  function toggleImagePanel() {
    if (isImagePanelOpen()) {
      closeImagePanel();
      return;
    }
    openImagePanel();
  }

  function handleDocumentClick(event) {
    const panel = document.getElementById('image-generation-panel');
    const button = document.getElementById('btn-generate-image');
    if (!isImagePanelOpen() || !panel || !button) return;
    if (panel.contains(event.target) || button.contains(event.target)) return;
    closeImagePanel();
  }

  function handleDocumentKeydown(event) {
    if (event.key === 'Escape' && isImagePanelOpen()) closeImagePanel();
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

  async function generateImage() {
    if (generating) return;
    const panel = createPanel();
    const prompt = panel.querySelector('#image-generation-prompt')?.value.trim() || '';
    if (!prompt) {
      const errorEl = panel.querySelector('.image-generation-error');
      if (errorEl) {
        errorEl.style.display = '';
        errorEl.textContent = t('imagePromptRequired');
      }
      panel.querySelector('#image-generation-prompt')?.focus();
      return;
    }

    const provider = panel.querySelector('#image-generation-provider')?.value || '';
    const providerInfo = (modelsData?.providers || []).find(item => item.id === provider) || {};
    const sizeValue = panel.querySelector('#image-generation-size')?.value || '';
    const payload = {
      provider,
      model: panel.querySelector('#image-generation-model')?.value || '',
      prompt,
      cwd: document.getElementById('cwd-input')?.value.trim() || '',
      size: providerInfo.sizes ? sizeValue : '',
      aspect_ratio: providerInfo.aspect_ratios ? sizeValue : '',
      quality: panel.querySelector('#image-generation-quality')?.value || '',
      n: Number(panel.querySelector('#image-generation-count')?.value || 1),
      extra: {},
    };

    generating = true;
    const submit = panel.querySelector('.image-generation-submit');
    const button = document.getElementById('btn-generate-image');
    if (submit) submit.disabled = true;
    button?.classList.add('loading');

    root.messageUi?.addUserMessage?.(`${t('generateImageShort')}: ${prompt}`, [], { messagesEl: getActiveMessagesEl() });
    const pendingEl = createPendingCard();
    closeImagePanel();

    try {
      const data = await root.api.postJson('/api/images/generate', payload);
      if (!data?.ok) throw new Error(data?.error || t('unknownError'));
      data.size = payload.size;
      data.aspect_ratio = payload.aspect_ratio;
      data.n = payload.n;
      settingsData = {
        provider: payload.provider,
        model: payload.model,
        size: payload.size,
        aspect_ratio: payload.aspect_ratio,
        quality: payload.quality,
        n: payload.n,
      };
      root.api.postJson('/api/images/settings', settingsData).catch(() => {});
      renderGeneratedImages(data, pendingEl);
      const input = document.getElementById('message-input');
      if (input && input.value.trim() === prompt) input.value = '';
    } catch (error) {
      showPendingError(pendingEl, error.message || t('unknownError'));
    } finally {
      generating = false;
      if (submit) submit.disabled = false;
      button?.classList.remove('loading');
    }
  }

  function initImageGeneration() {
    const button = document.getElementById('btn-generate-image');
    if (!button || button.dataset.imageGenerationBound === '1') return;
    button.dataset.imageGenerationBound = '1';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleImagePanel();
    });
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleDocumentKeydown);
  }

  root.imageGeneration = {
    initImageGeneration,
    openImagePanel,
    closeImagePanel,
    generateImage,
    renderGeneratedImages,
    getMessagesEl: null,
  };
})();
