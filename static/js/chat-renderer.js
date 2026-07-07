(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function defaultEsc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseToolInput(block = {}) {
    try {
      return typeof block.input === 'string' ? JSON.parse(block.input) : (block.input || {});
    } catch (e) {
      return {};
    }
  }

  function getContext(options = {}) {
    const esc = options.esc || defaultEsc;
    const t = options.t || ((key) => key);
    const renderMd = options.renderMd || ((text) => esc(text));
    const runningTasks = options.runningTasks || new Map();
    const toolResults = options.toolResults || new Map();
    const toolStartTimes = options.toolStartTimes || new Map();
    return { esc, t, renderMd, runningTasks, toolResults, toolStartTimes };
  }

  function formatToolSummary(block) {
    const input = parseToolInput(block);
    const name = block.name || '';
    switch (name) {
      case 'Read':
        return { icon: '📄', label: 'Read', summary: (input.file_path || '').split('/').pop() + (input.offset ? ` L${input.offset}-${input.offset + (input.limit || 0)}` : '') };
      case 'Write':
        return { icon: '✏', label: 'Write', summary: (input.file_path || '').split('/').pop() };
      case 'Edit': {
        const oldStr = (input.old_string || '').substring(0, 40);
        return { icon: '✏', label: 'Edit', summary: (input.file_path || '').split('/').pop() + (oldStr ? ` · "${oldStr}..."` : '') };
      }
      case 'Bash':
        return { icon: '>$', label: 'Bash', summary: (input.command || '').substring(0, 80) };
      case 'Grep':
        return { icon: '🔍', label: 'Grep', summary: `"${(input.pattern || '').substring(0, 40)}"` + (input.path ? ` in ${input.path}` : '') };
      case 'Glob':
        return { icon: '📁', label: 'Glob', summary: (input.pattern || '') };
      case 'Task':
        return { icon: '🤖', label: 'Task', summary: (input.description || input.subagent_type || '').substring(0, 60) };
      case 'TodoWrite':
        return { icon: '☑', label: 'TodoWrite', summary: (input.todos || []).length + ' items' };
      default: {
        const keys = Object.keys(input);
        const firstKV = keys.length > 0 ? `${keys[0]}: ${String(input[keys[0]]).substring(0, 50)}` : '';
        return { icon: '⚙', label: name || 'Tool', summary: firstKV };
      }
    }
  }

  function formatToolBody(block, options = {}) {
    const { esc } = getContext(options);
    const input = parseToolInput(block);
    const name = block.name || '';
    const rows = [];

    function row(label, value) {
      if (value === undefined || value === null || value === '') return;
      rows.push(`<div class="tb-row"><span class="tb-label">${esc(label)}</span><span class="tb-value">${esc(String(value))}</span></div>`);
    }
    function codeBlock(value) {
      if (!value) return;
      rows.push(`<pre class="tb-code">${esc(String(value))}</pre>`);
    }

    switch (name) {
      case 'Read':
        row('File', input.file_path);
        if (input.offset != null) {
          const end = input.limit ? input.offset + input.limit : input.offset;
          row('Lines', `${input.offset} — ${end}${input.limit ? ` (${input.limit} lines)` : ''}`);
        } else if (input.limit) {
          row('Lines', `${input.limit} lines`);
        }
        break;
      case 'Write':
        row('File', input.file_path);
        codeBlock(input.content);
        break;
      case 'Edit':
        row('File', input.file_path);
        if (input.old_string) {
          rows.push(`<div class="tb-label">Replace</div>`);
          codeBlock(input.old_string);
        }
        if (input.new_string) {
          rows.push(`<div class="tb-label">With</div>`);
          codeBlock(input.new_string);
        }
        break;
      case 'Bash':
        row('Description', input.description);
        codeBlock(input.command);
        break;
      case 'Grep':
        row('Pattern', input.pattern);
        row('Path', input.path);
        row('Glob', input.glob);
        if (input.type) row('Type', input.type);
        if (input.output_mode) row('Output', input.output_mode);
        break;
      case 'Glob':
        row('Pattern', input.pattern);
        row('Path', input.path);
        break;
      case 'Task':
        row('Subagent', input.subagent_type);
        row('Description', input.description);
        if (input.prompt) {
          rows.push(`<div class="tb-label">Prompt</div>`);
          codeBlock(input.prompt);
        }
        break;
      case 'TodoWrite': {
        const todos = input.todos || input.newTodos || [];
        if (todos.length > 0) {
          rows.push(`<div class="tb-label">Todos (${todos.length})</div>`);
          for (const t of todos) {
            const isDone = t.status === 'completed' || t.completed === true;
            const status = isDone ? '✓' : '○';
            const cls = isDone ? 'tb-todo-done' : 'tb-todo-pending';
            rows.push(`<div class="tb-row ${cls}"><span class="tb-todo-mark">${status}</span><span class="tb-value">${esc(String(t.content || t.name || t.task || ''))}</span></div>`);
          }
        }
        break;
      }
      case 'Agent':
      case 'Skill':
      case 'ToolSearch':
      default: {
        const keys = Object.keys(input);
        if (keys.length > 0) {
          for (const k of keys) {
            const v = input[k];
            if (typeof v === 'string' && v.length > 200) {
              row(k, v.substring(0, 200) + '…');
            } else if (typeof v === 'object') {
              row(k, JSON.stringify(v));
            } else {
              row(k, v);
            }
          }
        } else {
          rows.push(`<div class="tb-row tb-empty">(no input)</div>`);
        }
      }
    }

    return rows.length > 0 ? rows.join('') : `<div class="tb-row tb-empty">(no input)</div>`;
  }

  function renderToolCard(block, opts = {}, options = {}) {
    const { esc, t, toolResults, toolStartTimes } = getContext(options);
    const info = formatToolSummary(block);
    const bodyHtml = formatToolBody(block, options);
    const isHistory = !!opts.history;
    const isRunning = !isHistory && (opts.isRunning || false);
    if (!isHistory && block.id && !toolStartTimes.has(block.id) && !toolResults.has(block.id)) {
      toolStartTimes.set(block.id, Date.now());
    }
    const runningBadge = isRunning
      ? `<span class="tool-running-badge"><span class="agent-spinner"></span>${esc(t('running'))}</span>`
      : '';
    const hasResult = block.id && toolResults.has(block.id);
    const result = hasResult ? toolResults.get(block.id) : null;
    const resultBadge = hasResult
      ? `<span class="tool-status ${result.is_error ? 'tool-error' : 'tool-ok'}">${result.is_error ? '✗' : '✓'}</span>`
      : '';
    const resultHtml = hasResult
      ? `<div class="tool-result${result.is_error ? ' tool-result-error' : ''}">${esc(result.content)}</div>`
      : '';
    const cls = ['tool-card'];
    if (isRunning) cls.push('tool-card-running');
    cls.push('collapsed');

    return `<div class="${cls.join(' ')}" data-tool-id="${esc(block.id || '')}">
    <div class="tool-header tool-toggle" role="button" tabindex="0">
      <span class="tool-arrow">&#9654;</span>
      <span class="tool-icon">${info.icon}</span>
      <span class="tool-label">${esc(info.label)}</span>
      <span class="tool-summary">${esc(info.summary)}</span>
      ${runningBadge}${resultBadge}
    </div>
    <div class="tool-body">${bodyHtml}</div>
    ${resultHtml}
  </div>`;
  }

  function updateToolResult(toolId, content, isError, options = {}) {
    const { toolStartTimes } = getContext(options);
    const escId = String(toolId || '').replace(/"/g, '\\"');
    const card = document.querySelector(`.tool-card[data-tool-id="${escId}"]`);
    if (!card) return;
    card.classList.remove('tool-card-running');
    const startTime = toolStartTimes.get(toolId);
    let durationStr = '';
    if (startTime) {
      const elapsed = (Date.now() - startTime) / 1000;
      durationStr = elapsed >= 1 ? `${elapsed.toFixed(1)}s` : `${Math.round(elapsed * 1000)}ms`;
      toolStartTimes.delete(toolId);
    }
    const header = card.querySelector('.tool-header');
    if (header) {
      const runningBadge = header.querySelector('.tool-running-badge');
      if (runningBadge) runningBadge.remove();
      const existing = header.querySelector('.tool-status');
      if (!existing) {
        const badge = document.createElement('span');
        badge.className = `tool-status ${isError ? 'tool-error' : 'tool-ok'}`;
        badge.textContent = isError ? '✗' : '✓';
        header.appendChild(badge);
      }
      const dur = header.querySelector('.tool-duration');
      if (!dur && durationStr) {
        const durSpan = document.createElement('span');
        durSpan.className = 'tool-duration';
        durSpan.textContent = durationStr;
        header.appendChild(durSpan);
      }
    }
    const existingResult = card.querySelector('.tool-result');
    if (!existingResult) {
      const resultDiv = document.createElement('div');
      resultDiv.className = `tool-result${isError ? ' tool-result-error' : ''}`;
      resultDiv.textContent = content;
      card.appendChild(resultDiv);
    }
  }

  function renderStreamingText(text, options = {}) {
    const { esc } = getContext(options);
    return esc(text).replace(/\n/g, '<br>');
  }

  function renderBlock(block, options = {}) {
    const { esc, t, renderMd, runningTasks } = getContext(options);
    if (block.type === 'thinking' && block.thinking) {
      const preview = block.thinking.replace(/\n/g, ' ').substring(0, 100);
      return `<div class="thinking-block">
      <div class="thinking-header" onclick="this.parentElement.classList.toggle('open')">
        <span class="thinking-arrow">&#9654;</span>
        <span class="thinking-label">${esc(t('thinking'))}</span>
        <span class="thinking-preview">${esc(preview)}</span>
      </div>
      <div class="thinking-content">${esc(block.thinking)}</div>
    </div>`;
    } else if (block.type === 'text' && block.text) {
      return `<div class="text-block">${renderMd(block.text)}</div>`;
    } else if (block.type === 'tool_use') {
      const isRunningTask = block.name === 'Task' && block.id && runningTasks.has(block.id);
      return renderToolCard(block, { isRunning: isRunningTask }, options);
    }
    return '';
  }

  function renderCurrentState(state = {}, options = {}) {
    const { currentAssistantEl, currentContent = [], streamBlocks = {}, isResponding = false, final = false } = state;
    if (!currentAssistantEl) return;
    const el = currentAssistantEl.querySelector('.msg-content');
    if (!el) return;
    let html = '';

    for (const block of currentContent) {
      if (!final && isResponding && block.type === 'text' && block.text) {
        html += `<div class="text-block">${renderStreamingText(block.text, options)}</div>`;
      } else {
        html += renderBlock(block, options);
      }
    }

    for (const idx of Object.keys(streamBlocks).sort((a, b) => a - b)) {
      const block = streamBlocks[idx];
      if (block.type === 'thinking' && block.thinking) {
        html += renderBlock({ type: 'thinking', thinking: block.thinking }, options);
      } else if (block.type === 'text' && block.text) {
        html += `<div class="text-block">${renderStreamingText(block.text, options)}<span class="typing-cursor"></span></div>`;
      } else if (block.type === 'tool_use') {
        html += renderToolCard(block, {}, options);
      }
    }

    if (isResponding && !Object.values(streamBlocks).some(b => b.type === 'text') && currentContent.length === 0 && Object.keys(streamBlocks).length === 0) {
      html += '<span class="stream-placeholder">正在接收回复<span class="typing-cursor"></span></span>';
    }

    el.innerHTML = html;
  }

  root.chatRenderer = {
    formatToolSummary,
    formatToolBody,
    renderToolCard,
    updateToolResult,
    renderStreamingText,
    renderBlock,
    renderCurrentState,
  };
})();
