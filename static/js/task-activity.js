(function () {
  const root = window.CCBridge = window.CCBridge || {};

  const DEFAULT_SUBAGENT_COLORS = ['#c792ea', '#82aaff', '#c3e88d', '#ffcb6b', '#f78c6c', '#89ddff'];

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || ((str) => String(str || '')),
      renderMd: options.renderMd || ((text) => String(text || '')),
      scrollToBottom: options.scrollToBottom || (() => {}),
      notifyComplete: options.notifyComplete || (() => {}),
      getDisplayModelName: options.getDisplayModelName || ((model) => model || ''),
      getModelValue: options.getModelValue || (() => options.modelValue || ''),
      getCurrentAssistantEl: options.getCurrentAssistantEl || (() => options.currentAssistantEl || null),
      getIsResponding: options.getIsResponding || (() => Boolean(options.isResponding)),
      scheduleRender: options.scheduleRender || (() => {}),
      runningTasks: options.runningTasks || new Map(),
      finishedTaskIds: options.finishedTaskIds || new Set(),
      subagentBubbles: options.subagentBubbles || new Map(),
      colors: options.colors || DEFAULT_SUBAGENT_COLORS,
      agentStatusBar: options.agentStatusBar || document.getElementById('agent-status-bar'),
      messagesEl: options.messagesEl || document.getElementById('chat-messages'),
    };
  }

  function registerTaskBlocks(content, options = {}) {
    const ctx = getContext(options);
    let changed = false;
    for (const block of content || []) {
      if (block.type !== 'tool_use' || block.name !== 'Task' || !block.id) continue;
      if (ctx.finishedTaskIds.has(block.id)) continue;
      let input = block.input;
      if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch (e) { input = {}; }
      }
      if (!input || typeof input !== 'object') input = {};
      const existing = ctx.runningTasks.get(block.id) || {};
      ctx.runningTasks.set(block.id, {
        type: input.subagent_type || existing.type || '',
        desc: input.description || existing.desc || '',
        last: existing.last || '',
      });
      changed = true;
    }
    if (changed) renderAgentStatus(options);
  }

  function updateTaskActivity(parentToolUseId, message, options = {}) {
    const ctx = getContext(options);
    if (!parentToolUseId || ctx.finishedTaskIds.has(parentToolUseId)) return;
    const entry = ctx.runningTasks.get(parentToolUseId) || { type: '', desc: '', last: '' };
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
    ctx.runningTasks.set(parentToolUseId, entry);
    renderAgentStatus(options);
  }

  function finishTasks(ids, options = {}) {
    const ctx = getContext(options);
    let changed = false;
    let completedTask = null;
    for (const id of ids || []) {
      const taskInfo = ctx.runningTasks.get(id);
      if (taskInfo && !completedTask) completedTask = taskInfo;
      ctx.finishedTaskIds.add(id);
      if (ctx.runningTasks.delete(id)) changed = true;
    }
    if (changed) {
      ctx.notifyComplete('subagent', {
        agent: completedTask?.type || ctx.t('subagent'),
        task: completedTask?.last || completedTask?.desc || '',
        model: ctx.getDisplayModelName(ctx.getModelValue()),
      });
      renderAgentStatus(options);
      if (ctx.getCurrentAssistantEl()) ctx.scheduleRender();
    }
  }

  function clearRunningTasks(options = {}, clearOptions = {}) {
    const ctx = getContext(options);
    if (ctx.runningTasks.size) {
      ctx.runningTasks.clear();
      renderAgentStatus(options);
    }
    if (!clearOptions.keepFinished) ctx.finishedTaskIds.clear();
  }

  function renderAgentStatus(options = {}) {
    const ctx = getContext(options);
    const bar = ctx.agentStatusBar;
    if (!bar) return;
    if (ctx.runningTasks.size === 0) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    bar.style.display = '';
    let html = `<span class="agent-status-title">${ctx.esc(ctx.t('agentsRunning', { count: ctx.runningTasks.size }))}</span>`;
    for (const [id, info] of ctx.runningTasks) {
      const label = info.type || ctx.t('subagent');
      const detail = info.last || info.desc || '';
      html += `<span class="agent-chip" title="${ctx.esc(info.desc || '')}">` +
        `<span class="agent-spinner"></span>${ctx.esc(label)}` +
        `${detail ? `<span class="agent-chip-detail">${ctx.esc(detail.substring(0, 40))}</span>` : ''}` +
        `</span>`;
    }
    bar.innerHTML = html;
  }

  function getSubagentColor(id, options = {}) {
    const colors = getContext(options).colors;
    let hash = 0;
    for (let i = 0; i < String(id || '').length; i++) hash = ((hash << 5) - hash) + String(id).charCodeAt(i);
    return colors[Math.abs(hash) % colors.length];
  }

  function renderSubagentBubble(parentToolUseId, message, options = {}) {
    const ctx = getContext(options);
    const currentAssistantEl = ctx.getCurrentAssistantEl();
    if (!currentAssistantEl && !ctx.getIsResponding()) return;
    const taskInfo = ctx.runningTasks.get(parentToolUseId);
    const agentName = taskInfo?.type || ctx.t('subagent');
    const desc = taskInfo?.desc || '';
    const color = getSubagentColor(parentToolUseId, options);

    let el = ctx.subagentBubbles.get(parentToolUseId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'subagent-bubble';
      el.style.borderLeftColor = color;
      const container = currentAssistantEl || document.querySelector('#chat-messages .assistant:last-child');
      if (container) {
        container.after(el);
      } else {
        ctx.messagesEl?.appendChild(el);
      }
      ctx.subagentBubbles.set(parentToolUseId, el);
    }

    const content = message?.content;
    if (!Array.isArray(content)) return;

    const textParts = [];
    const toolParts = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolParts.push(block.name || 'tool');
      }
    }

    const text = textParts.join('\n\n');
    const toolInfo = toolParts.length ? `<span class="subagent-tools">${toolParts.map(t => ctx.esc(t)).join(', ')}</span>` : '';

    el.innerHTML = `
    <div class="subagent-head">
      <span class="subagent-dot" style="background:${color}"></span>
      <span class="subagent-name">${ctx.esc(agentName)}</span>
      ${desc ? `<span class="subagent-desc">${ctx.esc(desc)}</span>` : ''}
      ${toolInfo}
    </div>
    <div class="subagent-body">${text ? ctx.renderMd(text) : ''}</div>
  `;

    ctx.scrollToBottom();
  }

  function clearSubagentBubbles(options = {}) {
    const ctx = getContext(options);
    ctx.subagentBubbles.forEach(el => el.remove());
    ctx.subagentBubbles.clear();
  }

  root.taskActivity = {
    registerTaskBlocks,
    updateTaskActivity,
    finishTasks,
    clearRunningTasks,
    renderAgentStatus,
    getSubagentColor,
    renderSubagentBubble,
    clearSubagentBubbles,
  };
})();
