(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let agentsCache = [];
  let sessionAgents = [];

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || root.formatters?.esc || ((str) => String(str || '')),
      fetch: options.fetch || window.fetch.bind(window),
      getClientId: options.getClientId || (() => options.clientId || ''),
      quoteIntoInput: options.quoteIntoInput || root.messageExtras?.quoteIntoInput || (() => {}),
      updateWorkspaceHeader: options.updateWorkspaceHeader || (() => root.rightPanel?.updateWorkspaceHeader?.('members')),
      setVisible: options.setVisible || root.ui?.setVisible || ((el, visible, display = '') => { if (el) el.style.display = visible ? display : 'none'; }),
      panel: options.groupMemberPanel || document.getElementById('group-member-panel'),
      list: options.groupMemberList || document.getElementById('group-member-list'),
      popover: options.agentAddPopover || document.getElementById('agent-add-popover'),
      messageInput: options.messageInput || document.getElementById('message-input'),
    };
  }

  function setAgents(agents) {
    agentsCache = Array.isArray(agents) ? agents : [];
  }

  async function loadSessionAgents(options = {}) {
    const ctx = getContext(options);
    try {
      const resp = await ctx.fetch(`/api/session/agents?id=${ctx.getClientId()}`);
      const data = await resp.json();
      sessionAgents = data.agents || [];
      renderSessionAgentsPanel(options);
    } catch (e) { console.error('Load session agents failed:', e); }
  }

  async function addSessionAgent(name, options = {}) {
    const ctx = getContext(options);
    if (!name || sessionAgents.includes(name)) return;
    try {
      const resp = await ctx.fetch('/api/session/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ctx.getClientId(), action: 'add', agent: name }),
      });
      if (!resp.ok) { console.error('Add session agent failed:', resp.status); return; }
      const data = await resp.json();
      sessionAgents = data.agents || [];
      renderSessionAgentsPanel(options);
      hideAgentAddPopover(options);
    } catch (e) { console.error('Add session agent failed:', e); }
  }

  async function removeSessionAgent(name, options = {}) {
    const ctx = getContext(options);
    try {
      const resp = await ctx.fetch('/api/session/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ctx.getClientId(), action: 'remove', agent: name }),
      });
      const data = await resp.json();
      sessionAgents = data.agents || [];
      renderSessionAgentsPanel(options);
    } catch (e) { console.error('Remove session agent failed:', e); }
  }

  function renderSessionAgentsPanel(options = {}) {
    const ctx = getContext(options);
    const panel = ctx.panel;
    const list = ctx.list || panel;
    if (!panel || !list) return;

    if (!sessionAgents.length) {
      list.innerHTML = `<div class="group-member-empty">${ctx.esc(ctx.t('noSessionAgents'))}</div>`;
      ctx.updateWorkspaceHeader('members');
      return;
    }

    list.innerHTML = sessionAgents.map(a => `
      <span class="group-member-chip" data-agent="${ctx.esc(a)}">
        <span class="chip-name" title="${ctx.esc(a)}">${ctx.esc(a)}</span>
        <span class="chip-remove" data-action="remove" data-agent="${ctx.esc(a)}">&times;</span>
      </span>
    `).join('');
    ctx.updateWorkspaceHeader('members');

    list.querySelectorAll('.group-member-chip .chip-name').forEach(nameEl => {
      nameEl.addEventListener('click', () => {
        const name = nameEl.parentElement.dataset.agent;
        const input = ctx.messageInput;
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

    list.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSessionAgent(btn.dataset.agent, options);
      });
    });
  }

  function renderAgentAddPopover(options = {}) {
    const ctx = getContext(options);
    const popover = ctx.popover;
    if (!popover) return;
    const all = agentsCache.filter(a => {
      const name = a.name || a;
      return name && !sessionAgents.includes(name);
    });
    if (!all.length) {
      popover.innerHTML = `<div class="agent-add-popover-empty">${ctx.esc(ctx.t('noAgents'))}</div>`;
    } else {
      popover.innerHTML = `
        <div class="agent-add-popover-search">
          <input type="text" id="agent-add-search" placeholder="${ctx.esc(ctx.t('searchAgent'))}">
        </div>
        ${all.map(a => {
          const name = a.name || a;
          return `<div class="agent-add-popover-item" data-agent="${ctx.esc(name)}">${ctx.esc(name)}</div>`;
        }).join('')}
      `;
      const searchInput = document.getElementById('agent-add-search');
      if (searchInput) {
        searchInput.addEventListener('input', () => {
          const q = searchInput.value.toLowerCase();
          popover.querySelectorAll('.agent-add-popover-item').forEach(item => {
            ctx.setVisible(item, item.dataset.agent.toLowerCase().includes(q));
          });
        });
        setTimeout(() => searchInput.focus(), 0);
      }
    }
    ctx.setVisible(popover, true, 'block');
  }

  function hideAgentAddPopover(options = {}) {
    const popover = getContext(options).popover;
    getContext(options).setVisible(popover, false);
  }

  function getSessionAgents() {
    return sessionAgents.slice();
  }

  root.sessionAgents = {
    setAgents,
    loadSessionAgents,
    addSessionAgent,
    removeSessionAgent,
    renderSessionAgentsPanel,
    renderAgentAddPopover,
    hideAgentAddPopover,
    getSessionAgents,
  };
})();
