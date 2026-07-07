(function () {
  const root = window.CCBridge = window.CCBridge || {};

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
      const servers = await root.api.json(url);
      renderMcpServers(servers);
    } catch (e) {
      renderMcpServers([]);
    }
  }

  function updateAgents(agents) {
    if (typeof root.setAgentsForIntegrations === 'function') {
      root.setAgentsForIntegrations(agents);
    }
  }

  async function loadIntegrations() {
    loadMcpServers();
    try {
      const agents = await root.api.json('/api/agents');
      updateAgents(agents);
    } catch (e) {
      updateAgents([]);
    }
  }

  function initMcpManager() {
    document.getElementById('btn-mcp-add')?.addEventListener('click', showMcpForm);
    document.getElementById('btn-mcp-cancel')?.addEventListener('click', hideMcpForm);
    document.getElementById('btn-mcp-save')?.addEventListener('click', saveMcpServer);
    document.getElementById('mcp-form-type')?.addEventListener('change', updateMcpFormVisibility);
  }

  function showMcpForm() {
    const formSection = document.getElementById('mcp-form-section');
    if (!formSection) return;
    formSection.style.display = '';
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
    const formSection = document.getElementById('mcp-form-section');
    if (formSection) formSection.style.display = 'none';
  }

  function updateMcpFormVisibility() {
    const type = document.getElementById('mcp-form-type')?.value || 'stdio';
    const isUrl = type === 'sse' || type === 'http' || type === 'url';
    const stdioFields = document.getElementById('mcp-stdio-fields');
    const urlFields = document.getElementById('mcp-url-fields');
    if (stdioFields) stdioFields.style.display = isUrl ? 'none' : '';
    if (urlFields) urlFields.style.display = isUrl ? '' : 'none';
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
      const resp = await root.api.request('/api/mcp-servers', {
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

  root.integrations = {
    initMcpManager,
    loadIntegrations,
    loadMcpServers,
  };
})();
