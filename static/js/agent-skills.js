(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let skillsCache = [];
  let toolsCache = [];
  let currentSkillDir = '';
  let agentModalEditingName = null;

  function init() {
    initSkillsUI();
    initAgentModal();
  }

  function initSkillsUI() {
    document.getElementById('btn-skills-refresh')?.addEventListener('click', () => {
      loadSkills().catch((e) => console.warn('Load skills failed:', e));
    });
    document.getElementById('btn-tools-refresh')?.addEventListener('click', () => {
      loadTools().catch((e) => console.warn('Load tools failed:', e));
    });
    document.getElementById('skill-modal-close')?.addEventListener('click', closeSkillModal);
    document.getElementById('btn-skill-close')?.addEventListener('click', closeSkillModal);
    document.getElementById('skill-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target?.id === 'skill-modal-overlay') closeSkillModal();
    });
    document.getElementById('btn-skill-uninstall')?.addEventListener('click', () => {
      uninstallCurrentSkill().catch((e) => console.warn('Uninstall skill failed:', e));
    });
  }

  async function loadSkills() {
    const el = document.getElementById('skills-list');
    if (!el) return;
    try {
      skillsCache = await root.api.json('/api/skills');
      renderSkills(skillsCache);
    } catch (e) {
      console.error('技能加载失败:', e);
      el.innerHTML = `<p class="empty-state">${esc(t('requestFailed', { message: e.message || e }))}</p>`;
    }
  }

  function renderSkills(skills) {
    const el = document.getElementById('skills-list');
    const countEl = document.getElementById('skills-count');
    if (!el) return;
    const list = Array.isArray(skills) ? skills : [];
    if (countEl) countEl.textContent = t('skillsCount', { count: list.length });
    if (!list.length) {
      el.innerHTML = `<p class="empty-state">${esc(t('noSkills'))}</p>`;
      return;
    }
    el.innerHTML = list.map(s => `
      <button class="skill-card" type="button" data-dir="${esc(s.dir)}" title="${esc(t('skillOpen'))}">
        <span class="skill-card-prefix">/</span>
        <span class="skill-card-title">${esc(s.name)}</span>
        <span class="skill-card-desc">${esc(s.description || t('noDescription'))}</span>
        <span class="skill-card-dir">~/.claude/skills/${esc(s.dir)}</span>
      </button>
    `).join('');
    el.querySelectorAll('.skill-card').forEach(card => {
      card.addEventListener('click', () => openSkillModal(card.dataset.dir));
    });
  }

  async function openSkillModal(dir) {
    if (!dir) return;
    const overlay = document.getElementById('skill-modal-overlay');
    const title = document.getElementById('skill-modal-title');
    const desc = document.getElementById('skill-modal-desc');
    const dirEl = document.getElementById('skill-modal-dir');
    const body = document.getElementById('skill-modal-body');
    if (!overlay || !title || !desc || !dirEl || !body) return;
    currentSkillDir = dir;
    overlay.style.display = 'flex';
    const cached = skillsCache.find(s => s.dir === dir) || {};
    title.textContent = '/' + (cached.name || dir);
    desc.textContent = cached.description || '';
    dirEl.textContent = `~/.claude/skills/${dir}`;
    body.textContent = t('loading');
    try {
      const skill = await root.api.json(`/api/skills/detail?dir=${encodeURIComponent(dir)}`);
      title.textContent = '/' + (skill.name || dir);
      desc.textContent = skill.description || '';
      dirEl.textContent = `~/.claude/skills/${skill.dir || dir}`;
      body.textContent = skill.content || '';
    } catch (e) {
      body.textContent = t('requestFailed', { message: e.message || e });
    }
  }

  function closeSkillModal() {
    currentSkillDir = '';
    const overlay = document.getElementById('skill-modal-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function uninstallCurrentSkill() {
    if (!currentSkillDir) return;
    const skill = skillsCache.find(s => s.dir === currentSkillDir) || { name: currentSkillDir };
    if (!confirm(t('confirmUninstallSkill', { name: skill.name || currentSkillDir }))) return;
    try {
      await root.api.postJson('/api/skills/delete', { dir: currentSkillDir });
      closeSkillModal();
      await loadSkills();
      showToast(t('skillUninstalled'), 'success');
    } catch (e) {
      showToast(t('skillUninstallFailed', { message: e.message || e }), 'error');
    }
  }

  async function loadTools() {
    const el = document.getElementById('tools-list');
    try {
      const data = await root.api.json('/api/tools');
      toolsCache = Array.isArray(data?.tools) ? data.tools : (Array.isArray(data) ? data : []);
      renderTools(toolsCache);
      renderAgentToolPicker(getSelectedAgentTools());
      return toolsCache;
    } catch (e) {
      console.error('工具加载失败:', e);
      if (el) el.innerHTML = `<p class="empty-state">${esc(t('requestFailed', { message: e.message || e }))}</p>`;
      return [];
    }
  }

  function toolStatusText(tool) {
    return tool?.enabled ? t('toolEnabled') : t('toolDisabled');
  }

  function renderTools(tools) {
    const el = document.getElementById('tools-list');
    const countEl = document.getElementById('tools-count');
    if (!el) return;
    const list = Array.isArray(tools) ? tools : [];
    const enabledCount = list.filter(tool => tool.enabled).length;
    if (countEl) countEl.textContent = t('toolsCount', { enabled: enabledCount, count: list.length });
    if (!list.length) {
      el.innerHTML = `<p class="empty-state">${esc(t('noTools'))}</p>`;
      return;
    }
    el.innerHTML = list.map(tool => {
      const name = tool.name || '';
      const sourceKey = tool.source === 'custom' ? 'toolSourceCustom' : 'toolSourceClaude';
      const riskKey = `toolRisk${String(tool.risk || 'medium').replace(/^./, c => c.toUpperCase())}`;
      return `
        <article class="tools-card ${tool.enabled ? 'enabled' : 'disabled'}" data-tool="${esc(name)}">
          <div class="tools-card-main">
            <div class="tools-card-head">
              <div>
                <div class="tools-card-title">${esc(tool.label || name)}</div>
                <div class="tools-card-name">${esc(name)}</div>
              </div>
              <label class="tool-switch" aria-label="${esc(t('toggleTool', { name: tool.label || name }))}">
                <input type="checkbox" data-tool-toggle="${esc(name)}" ${tool.enabled ? 'checked' : ''}>
                <span class="tool-switch-track"><span class="tool-switch-thumb"></span></span>
                <span class="tool-switch-text">${esc(toolStatusText(tool))}</span>
              </label>
            </div>
            <p class="tools-card-desc">${esc(tool.description || t('noDescription'))}</p>
            <div class="tools-card-meta">
              <span>${esc(t(sourceKey))}</span>
              <span>${esc(tool.category || 'general')}</span>
              <span>${esc(t(riskKey) || tool.risk || 'medium')}</span>
            </div>
          </div>
        </article>
      `;
    }).join('');
    el.querySelectorAll('[data-tool-toggle]').forEach(input => {
      input.addEventListener('change', () => toggleTool(input.dataset.toolToggle, input.checked));
    });
  }

  async function toggleTool(name, enabled) {
    try {
      await root.api.postJson('/api/tools/toggle', { name, enabled });
      await loadTools();
      showToast(t(enabled ? 'toolEnabledToast' : 'toolDisabledToast', { name }), 'success');
    } catch (e) {
      showToast(t('toolToggleFailed', { message: e.message || e }), 'error');
      await loadTools();
    }
  }

  function getSelectedAgentTools() {
    const box = document.getElementById('agent-form-tools');
    if (!box) return [];
    return Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value).filter(Boolean);
  }

  function renderAgentToolPicker(selectedTools = []) {
    const box = document.getElementById('agent-form-tools');
    if (!box) return;
    const selected = new Set(Array.isArray(selectedTools) ? selectedTools : []);
    const list = toolsCache.filter(tool => tool.enabled);
    if (!list.length) {
      box.innerHTML = `<p class="empty-state">${esc(t('noTools'))}</p>`;
      return;
    }
    box.innerHTML = list.map(tool => {
      const name = tool.name || '';
      return `
        <label class="agent-tool-option">
          <input type="checkbox" value="${esc(name)}" ${selected.has(name) ? 'checked' : ''}>
          <span>
            <span class="agent-tool-name">${esc(tool.label || name)}</span>
            <span class="agent-tool-desc">${esc(tool.description || name)}</span>
          </span>
        </label>
      `;
    }).join('');
  }

  async function ensureToolsLoaded() {
    if (!toolsCache.length) await loadTools();
  }

  function setAgentToolSelection(tools) {
    const selected = Array.isArray(tools) ? tools : (typeof tools === 'string' ? tools.replace(/,/g, ' ').split(/\s+/).filter(Boolean) : []);
    renderAgentToolPicker(selected);
  }
  function renderAgents(agents) {
    const el = document.getElementById('agents-list');
    if (!el) return;
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
      btn.addEventListener('click', () => {
        openAgentModal(btn.dataset.name).catch((e) => console.warn('Open agent modal failed:', e));
      });
    });
    el.querySelectorAll('.agent-del-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteAgentPrompt(btn.dataset.name));
    });
  }

  async function openAgentModal(name = null) {
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
    if (!overlay || !title || !formName || !formDesc || !formScope || !formModel || !formTools || !formColor || !formMemory || !formPrompt || !status) return;

    overlay.style.display = 'flex';
    status.style.display = 'none';
    status.textContent = '';
    await ensureToolsLoaded();

    if (name) {
      title.textContent = t('editAgent') + ': ' + name;
      formName.disabled = true;
      formScope.disabled = true;
      root.api.json('/api/agents').then(agents => {
        const agent = agents.find(a => a.name === name);
        if (agent) {
          formName.value = agent.name || '';
          formDesc.value = agent.description || '';
          formScope.value = agent.scope || 'user';
          formModel.value = agent.model || '';
          setAgentToolSelection(agent.tools || []);
          formColor.value = agent.color || '';
          formMemory.value = agent.memory || '';
          formPrompt.value = agent.body || '';
        }
      }).catch((e) => {
        console.warn('Load agent for edit failed:', e);
      });
    } else {
      title.textContent = t('newAgent');
      formName.disabled = false;
      formScope.disabled = false;
      formName.value = '';
      formDesc.value = '';
      formScope.value = 'user';
      formModel.value = '';
      setAgentToolSelection([]);
      formColor.value = '';
      formMemory.value = '';
      formPrompt.value = '';
    }
  }

  function closeAgentModal() {
    const overlay = document.getElementById('agent-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    agentModalEditingName = null;
  }

  async function saveAgent() {
    const status = document.getElementById('agent-form-status');
    const data = {
      name: document.getElementById('agent-form-name').value.trim(),
      description: document.getElementById('agent-form-desc').value.trim(),
      scope: document.getElementById('agent-form-scope').value,
      model: document.getElementById('agent-form-model').value,
      tools: getSelectedAgentTools(),
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
      await root.api.postJson(url, data);
      closeAgentModal();
      root.config?.loadConfig?.();
    } catch (e) {
      status.textContent = e.message;
      status.className = 'remote-form-status err';
      status.style.display = '';
    }
  }

  async function deleteAgentPrompt(name) {
    if (!confirm(t('confirmDeleteAgent', { name }))) return;
    try {
      await root.api.postJson('/api/agents/delete', { name });
      root.config?.loadConfig?.();
    } catch (e) {
      console.error('Delete agent failed:', e);
    }
  }

  function initAgentModal() {
    document.getElementById('btn-agent-add')?.addEventListener('click', () => {
      openAgentModal().catch((e) => console.warn('Open agent modal failed:', e));
    });
    document.getElementById('btn-agent-save')?.addEventListener('click', () => {
      saveAgent().catch((e) => console.warn('Save agent failed:', e));
    });
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

  root.agentSkills = {
    init,
    loadSkills,
    loadTools,
    renderAgents,
    openAgentModal,
    closeAgentModal,
    saveAgent,
    deleteAgentPrompt,
  };
})();
