(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let skillsCache = [];
  let currentSkillDir = '';
  let agentModalEditingName = null;

  function init() {
    initSkillsUI();
    initAgentModal();
  }

  function initSkillsUI() {
    document.getElementById('btn-skills-refresh')?.addEventListener('click', loadSkills);
    document.getElementById('skill-modal-close')?.addEventListener('click', closeSkillModal);
    document.getElementById('btn-skill-close')?.addEventListener('click', closeSkillModal);
    document.getElementById('skill-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target?.id === 'skill-modal-overlay') closeSkillModal();
    });
    document.getElementById('btn-skill-uninstall')?.addEventListener('click', uninstallCurrentSkill);
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
      btn.addEventListener('click', () => openAgentModal(btn.dataset.name));
    });
    el.querySelectorAll('.agent-del-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteAgentPrompt(btn.dataset.name));
    });
  }

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
    if (!overlay || !title || !formName || !formDesc || !formScope || !formModel || !formTools || !formColor || !formMemory || !formPrompt || !status) return;

    overlay.style.display = 'flex';
    status.style.display = 'none';
    status.textContent = '';

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

  root.agentSkills = {
    init,
    loadSkills,
    renderAgents,
    openAgentModal,
    closeAgentModal,
    saveAgent,
    deleteAgentPrompt,
  };
})();
