(function () {
  const root = window.CCBridge = window.CCBridge || {};

  const DEFAULT_STORAGE_KEY = 'ccb_workspace_state_v1';
  const DEFAULT_PREVIEW_MAX_CHARS = 3000;

  function readState(storageKey = DEFAULT_STORAGE_KEY) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeState(state, storageKey = DEFAULT_STORAGE_KEY) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (e) {
      // ignore
    }
  }

  function serializeState({ mode, activeSessionId, sessions, widths }) {
    return {
      mode,
      activeSessionId: activeSessionId && !activeSessionId.startsWith('pending-') ? activeSessionId : '',
      sessions: Array.from(sessions.values())
        .filter(s => s.sessionId && !s.sessionId.startsWith('pending-'))
        .map(s => ({
          sessionId: s.sessionId,
          title: s.title || '',
          cwd: s.cwd || '',
          model: s.model || '',
          cli: s.cli || '',
          remoteTargetId: s.remoteTargetId || '',
          cost: s.cost || 0,
          tokens: s.tokens || null,
          status: s.status === 'running' || s.status === 'tool' ? 'idle' : (s.status || 'idle'),
          phase: '',
          runId: s.status === 'running' || s.status === 'tool' ? (s.runId || '') : '',
        })),
      widths: Array.from(widths.entries()),
    };
  }

  function normalizeStoredMode(mode) {
    return mode === 'grid' ? 'grid' : 'focus';
  }

  function createSessionRecord(sessionId, meta = {}, existing = {}, t = (key) => key) {
    const nextStatus = meta.status || existing.status || 'idle';
    const rawPhase = Object.prototype.hasOwnProperty.call(meta, 'phase') ? meta.phase : existing.phase;
    return {
      sessionId,
      title: meta.title || existing.title || t('newChat'),
      cwd: meta.cwd || existing.cwd || '',
      model: meta.model || existing.model || '',
      cli: meta.cli || existing.cli || '',
      remoteTargetId: meta.remoteTargetId || existing.remoteTargetId || '',
      cost: Number.isFinite(meta.cost) ? meta.cost : (existing.cost || 0),
      tokens: meta.tokens || existing.tokens || null,
      status: nextStatus,
      phase: nextStatus === 'running' || nextStatus === 'tool' ? (rawPhase || '') : '',
      startedAt: meta.startedAt || existing.startedAt || 0,
      updatedAt: Date.now(),
      runId: meta.runId || existing.runId || '',
      released: Boolean(meta.released ?? existing.released),
      previewText: meta.previewText || existing.previewText || '',
    };
  }

  function statusKey(status) {
    return {
      idle: 'workspaceIdle',
      running: 'workspaceRunning',
      tool: 'workspaceTool',
      done: 'workspaceDone',
      error: 'workspaceError',
    }[status || 'idle'] || 'workspaceIdle';
  }

  function previewText(session, maxChars = DEFAULT_PREVIEW_MAX_CHARS) {
    if (!session) return '';
    return (session.previewText || '').slice(-maxChars);
  }

  function appendPreview(session, text, maxChars = DEFAULT_PREVIEW_MAX_CHARS) {
    if (!session || !text) return false;
    session.previewText = `${session.previewText || ''}${text}`.slice(-maxChars);
    return true;
  }

  function setPreview(session, text, maxChars = DEFAULT_PREVIEW_MAX_CHARS) {
    if (!session) return false;
    session.previewText = (text || '').slice(-maxChars);
    return true;
  }

  function applyPaneWidth(pane, sessionId, { mode, widths, sessionCount }) {
    if (!pane || mode !== 'grid') {
      if (pane) {
        pane.style.flex = '';
        pane.style.flexBasis = '';
      }
      return;
    }
    const savedWidth = widths.get(sessionId);
    if (savedWidth) {
      pane.style.flex = `0 0 ${savedWidth}px`;
      pane.style.flexBasis = `${savedWidth}px`;
      return;
    }
    const count = Math.max(1, sessionCount || 1);
    const gapTotal = Math.max(0, count - 1) * 8;
    const width = `calc((100% - ${gapTotal}px) / ${count})`;
    pane.style.flex = `1 1 ${width}`;
    pane.style.flexBasis = width;
  }

  function getTabsContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || root.formatters?.esc || ((value) => String(value ?? '')),
      getTabsEl: options.getTabsEl || (() => null),
      getSessions: options.getSessions || (() => []),
      getActiveSessionId: options.getActiveSessionId || (() => ''),
      getStatusLabel: options.getStatusLabel || (() => ''),
      getTabSessionId: options.getTabSessionId || ((target) => target?.closest?.('.workspace-tab')?.dataset.sessionId || ''),
      startNewSession: options.startNewSession || (() => {}),
      closeWorkspaceSession: options.closeWorkspaceSession || (() => {}),
      renameWorkspaceSession: options.renameWorkspaceSession || (() => {}),
      activateWorkspaceSession: options.activateWorkspaceSession || (() => {}),
    };
  }

  function ensureWorkspaceTabsEvents(options = {}) {
    const ctx = getTabsContext(options);
    const tabsEl = ctx.getTabsEl();
    if (!tabsEl || tabsEl.dataset.eventsBound === '1') return;
    tabsEl.dataset.eventsBound = '1';
    tabsEl.addEventListener('click', (e) => {
      if (e.target.closest('.workspace-new-session')) {
        ctx.startNewSession();
        return;
      }
      const closeBtn = e.target.closest('.workspace-close-btn');
      if (closeBtn) {
        e.preventDefault();
        e.stopPropagation();
        ctx.closeWorkspaceSession(ctx.getTabSessionId(closeBtn));
        return;
      }
      const renameBtn = e.target.closest('.workspace-rename-btn');
      if (renameBtn) {
        e.preventDefault();
        e.stopPropagation();
        ctx.renameWorkspaceSession(ctx.getTabSessionId(renameBtn));
        return;
      }
      const sessionId = ctx.getTabSessionId(e.target);
      if (sessionId) ctx.activateWorkspaceSession(sessionId);
    });
    tabsEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('.workspace-rename-btn, .workspace-close-btn')) return;
      const sessionId = ctx.getTabSessionId(e.target);
      if (!sessionId) return;
      e.preventDefault();
      ctx.renameWorkspaceSession(sessionId);
    });
    tabsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const closeBtn = e.target.closest('.workspace-close-btn');
      if (closeBtn) {
        e.preventDefault();
        e.stopPropagation();
        ctx.closeWorkspaceSession(ctx.getTabSessionId(closeBtn));
        return;
      }
      const renameBtn = e.target.closest('.workspace-rename-btn');
      if (renameBtn) {
        e.preventDefault();
        e.stopPropagation();
        ctx.renameWorkspaceSession(ctx.getTabSessionId(renameBtn));
        return;
      }
      const sessionId = ctx.getTabSessionId(e.target);
      if (!sessionId) return;
      e.preventDefault();
      ctx.activateWorkspaceSession(sessionId);
    });
  }

  function renderWorkspaceTabs(options = {}) {
    const ctx = getTabsContext(options);
    const tabsEl = ctx.getTabsEl();
    if (!tabsEl) return;
    ensureWorkspaceTabsEvents(options);
    const sessions = ctx.getSessions();
    const newButton = `
      <button class="workspace-new-session" type="button" title="${ctx.esc(ctx.t('newSession'))}" aria-label="${ctx.esc(ctx.t('newSession'))}">+</button>
    `;
    if (!sessions.length) {
      tabsEl.innerHTML = `<div class="workspace-tabs-empty">${ctx.esc(ctx.t('workspaceNoTabs'))}</div>${newButton}`;
      return;
    }
    const activeSessionId = ctx.getActiveSessionId();
    tabsEl.innerHTML = sessions.map(s => {
      const active = s.sessionId === activeSessionId;
      return `
      <div class="workspace-tab ${active ? 'active' : ''} status-${ctx.esc(s.status || 'idle')}" role="tab" tabindex="0" aria-selected="${active ? 'true' : 'false'}" data-session-id="${ctx.esc(s.sessionId)}">
        <span class="workspace-tab-title-row">
          <span class="workspace-tab-title">${ctx.esc(s.title || ctx.t('newChat'))}</span>
          <span class="workspace-tab-actions">
            <span class="workspace-rename-btn" role="button" tabindex="0" title="${ctx.esc(ctx.t('rename'))}" aria-label="${ctx.esc(ctx.t('rename'))}">EDIT</span>
            <span class="workspace-close-btn" role="button" tabindex="0" title="${ctx.esc(ctx.t('close'))}" aria-label="${ctx.esc(ctx.t('close'))}">×</span>
          </span>
        </span>
        <span class="workspace-tab-meta">${ctx.esc(ctx.getStatusLabel(s.status))}${(s.status === 'running' || s.status === 'tool') && s.phase ? ` · ${ctx.esc(s.phase)}` : ''}</span>
      </div>
    `;
    }).join('') + newButton;
  }

  function getPanesContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || root.formatters?.esc || ((value) => String(value ?? '')),
      getMode: options.getMode || (() => 'focus'),
      getSessions: options.getSessions || (() => []),
      getActiveSessionId: options.getActiveSessionId || (() => ''),
      getSessionActive: options.getSessionActive || (() => false),
      getLivePane: options.getLivePane || (() => null),
      getPanesEl: options.getPanesEl || (() => null),
      getStatusLabel: options.getStatusLabel || (() => ''),
      getSessionPreview: options.getSessionPreview || (() => ''),
      applyPaneWidth: options.applyPaneWidth || (() => {}),
      ensureLivePaneResizer: options.ensureLivePaneResizer || (() => {}),
      startWorkspaceResize: options.startWorkspaceResize || (() => {}),
      activateWorkspaceSession: options.activateWorkspaceSession || (() => {}),
      releaseInactiveWorkspaceSession: options.releaseInactiveWorkspaceSession || (() => {}),
      attachSessionMessagesToPane: options.attachSessionMessagesToPane || (() => {}),
    };
  }

  function renderWorkspacePanes(options = {}) {
    const ctx = getPanesContext(options);
    const activeSessionId = ctx.getActiveSessionId();
    const sessions = ctx.getSessions();
    const activeSession = sessions.find(session => session.sessionId === activeSessionId);
    const livePane = ctx.getLivePane();
    const panesEl = ctx.getPanesEl();
    if (!livePane || !panesEl) return;

    livePane.dataset.sessionId = activeSessionId || '';
    livePane.classList.toggle('active', true);
    livePane.className = `workspace-pane active status-${activeSession?.status || 'idle'}`;
    const titleEl = livePane.querySelector('.workspace-pane-title');
    const statusEl = livePane.querySelector('.workspace-pane-status');
    if (titleEl) {
      titleEl.innerHTML = `${activeSession?.title ? ctx.esc(activeSession.title) : ctx.esc(ctx.t('chat'))}<span class="workspace-input-target">${ctx.esc(ctx.t('workspaceInputTarget'))}</span>`;
    }
    if (statusEl) statusEl.textContent = ctx.getStatusLabel(activeSession?.status || (ctx.getSessionActive() ? 'idle' : 'idle'));
    ctx.applyPaneWidth(livePane, activeSessionId);

    ctx.ensureLivePaneResizer();
    if (ctx.getMode() !== 'grid') {
      panesEl.querySelectorAll('.workspace-snapshot-pane').forEach(el => el.remove());
      return;
    }

    const inactiveSessionIds = new Set(
      sessions
        .filter(session => session.sessionId !== activeSessionId)
        .map(session => session.sessionId)
    );
    panesEl.querySelectorAll('.workspace-snapshot-pane').forEach(el => {
      if (!inactiveSessionIds.has(el.dataset.sessionId)) el.remove();
    });

    for (const session of sessions) {
      if (session.sessionId === activeSessionId) continue;
      let pane = Array.from(panesEl.querySelectorAll('.workspace-snapshot-pane'))
        .find(el => el.dataset.sessionId === session.sessionId);
      if (!pane) {
        pane = document.createElement('section');
        pane.className = 'workspace-pane workspace-snapshot-pane';
        pane.dataset.sessionId = session.sessionId;
        pane.innerHTML = `
          <div class="workspace-pane-head">
            <div class="workspace-pane-title"></div>
            <div class="workspace-pane-status"></div>
          </div>
          <div class="messages workspace-snapshot-messages"></div>
          <div class="workspace-pane-resizer" title="${ctx.esc(ctx.t('workspaceResize'))}"></div>
        `;
        pane.querySelector('.workspace-pane-head')?.addEventListener('click', () => ctx.activateWorkspaceSession(session.sessionId));
        pane.querySelector('.workspace-pane-resizer')?.addEventListener('pointerdown', (e) => ctx.startWorkspaceResize(e, session.sessionId, pane));
      }
      pane.className = `workspace-pane workspace-snapshot-pane status-${session.status || 'idle'}`;
      const paneTitle = pane.querySelector('.workspace-pane-title');
      const paneStatus = pane.querySelector('.workspace-pane-status');
      const paneMessages = pane.querySelector('.workspace-snapshot-messages');
      if (paneTitle) paneTitle.textContent = session.title || ctx.t('newChat');
      if (paneStatus) paneStatus.textContent = ctx.getStatusLabel(session.status);
      if (paneMessages) paneMessages.remove();
      ctx.attachSessionMessagesToPane(session.sessionId, pane);
      ctx.applyPaneWidth(pane, session.sessionId);
      panesEl.appendChild(pane);
    }
    ctx.ensureLivePaneResizer();
  }

  function getResizeContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      getMode: options.getMode || (() => 'focus'),
      getActiveSessionId: options.getActiveSessionId || (() => ''),
      getLivePane: options.getLivePane || (() => null),
      getWidths: options.getWidths || (() => new Map()),
      getResizeState: options.getResizeState || (() => null),
      setResizeState: options.setResizeState || (() => {}),
      saveWorkspaceState: options.saveWorkspaceState || (() => {}),
      applyWorkspacePaneWidth: options.applyWorkspacePaneWidth || (() => {}),
    };
  }

  function ensureLivePaneResizer(options = {}) {
    const ctx = getResizeContext(options);
    const livePane = ctx.getLivePane();
    if (!livePane) return;
    let resizer = livePane.querySelector('.workspace-pane-resizer');
    if (ctx.getMode() !== 'grid') {
      if (resizer) resizer.remove();
      return;
    }
    if (!resizer) {
      resizer = document.createElement('div');
      resizer.className = 'workspace-pane-resizer';
      livePane.appendChild(resizer);
    }
    resizer.title = ctx.t('workspaceResize');
    resizer.onpointerdown = (e) => startWorkspaceResize(e, ctx.getActiveSessionId(), livePane, options);
  }

  function startWorkspaceResize(event, sessionId, pane, options = {}) {
    const ctx = getResizeContext(options);
    if (!sessionId || !pane) return;
    event.preventDefault();
    ctx.setResizeState({
      sessionId,
      pane,
      startX: event.clientX,
      startWidth: pane.getBoundingClientRect().width,
    });
    document.body.classList.add('resizing-workspace-pane');
    pane.setPointerCapture?.(event.pointerId);
  }

  function handleWorkspaceResizeMove(event, options = {}) {
    const ctx = getResizeContext(options);
    const state = ctx.getResizeState();
    if (!state) return;
    const nextWidth = Math.max(260, Math.min(900, state.startWidth + event.clientX - state.startX));
    ctx.getWidths().set(state.sessionId, nextWidth);
    ctx.applyWorkspacePaneWidth(state.pane, state.sessionId);
  }

  function stopWorkspaceResize(options = {}) {
    const ctx = getResizeContext(options);
    if (!ctx.getResizeState()) return;
    ctx.setResizeState(null);
    document.body.classList.remove('resizing-workspace-pane');
    ctx.saveWorkspaceState();
  }

  function extractMessagePreviewText(message) {
    let text = '';
    for (const block of (message?.content || [])) {
      if (block.type === 'text' && block.text) text += block.text;
      else if (block.type === 'thinking' && block.thinking) text += block.thinking;
      else if (block.type === 'tool_use' && block.name) text += `\n> ${block.name}\n`;
    }
    return text;
  }

  function appendWorkspacePreviewEvent(sessionId, evt, options = {}) {
    if (!evt) return;
    const t = options.t || ((key) => key);
    if (evt.type === 'message_start') {
      options.setWorkspaceSessionPreview?.(sessionId, '');
      return;
    }
    if (evt.type === 'content_block_delta') {
      const text = evt.delta?.text || evt.delta?.thinking || evt.delta?.partial_json || '';
      if (text) options.appendWorkspaceSessionPreview?.(sessionId, text);
      return;
    }
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      options.appendWorkspaceSessionPreview?.(sessionId, `\n> ${evt.content_block.name || t('tool')}\n`);
    }
  }

  function updateBackgroundWorkspacePreview(data = {}, options = {}) {
    const sessionId = data.session_id;
    if (!sessionId || !options.hasWorkspaceSession?.(sessionId)) return;
    if (data.event) {
      appendWorkspacePreviewEvent(sessionId, data.event, options);
      return;
    }
    const text = extractMessagePreviewText(data.message);
    if (text) options.setWorkspaceSessionPreview?.(sessionId, text);
  }

  root.workspace = {
    DEFAULT_STORAGE_KEY,
    DEFAULT_PREVIEW_MAX_CHARS,
    readState,
    writeState,
    serializeState,
    normalizeStoredMode,
    createSessionRecord,
    statusKey,
    previewText,
    appendPreview,
    setPreview,
    applyPaneWidth,
    ensureWorkspaceTabsEvents,
    renderWorkspaceTabs,
    renderWorkspacePanes,
    ensureLivePaneResizer,
    startWorkspaceResize,
    handleWorkspaceResizeMove,
    stopWorkspaceResize,
    extractMessagePreviewText,
    appendWorkspacePreviewEvent,
    updateBackgroundWorkspacePreview,
  };
})();
