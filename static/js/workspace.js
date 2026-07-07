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
  };
})();
