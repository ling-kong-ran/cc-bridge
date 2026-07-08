(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function formatMessage(data, fallbackKey = 'unknownError') {
    return root.i18n?.formatMessage ? root.i18n.formatMessage(data, fallbackKey) : String(data?.error || data?.message || t(fallbackKey) || '');
  }

  let migrateTargetCwd = '';

  function syncWorkspaceSessionsFromRecords(sessions) {
    let changed = false;
    for (const record of (sessions || [])) {
      const sessionId = record.session_id || '';
      const session = sessionId ? workspaceSessions.get(sessionId) : null;
      if (!session) continue;
      if (record.title && session.title !== record.title) {
        session.title = record.title;
        changed = true;
      }
      if (record.cwd && session.cwd !== record.cwd) {
        session.cwd = record.cwd;
        changed = true;
      }
      if (record.model && session.model !== record.model) {
        session.model = record.model;
        changed = true;
      }
      if ((record.cli || '') !== (session.cli || '')) {
        session.cli = record.cli || '';
        changed = true;
      }
      if ((record.remote_target_id || '') !== (session.remoteTargetId || '')) {
        session.remoteTargetId = record.remote_target_id || '';
        changed = true;
      }
      const cost = Number(record.total_cost_usd || 0);
      if (Number.isFinite(cost) && session.cost !== cost) {
        session.cost = cost;
        changed = true;
      }
      const tokens = normalizeTokenUsage(record.total_tokens);
      if (JSON.stringify(session.tokens || null) !== JSON.stringify(tokens)) {
        session.tokens = tokens;
        changed = true;
      }
    }
    if (changed) renderWorkspace();
  }

  async function loadSessions() {
    try {
      const resp = await fetch(`/api/sessions?offset=0&limit=${SESSION_PAGE_SIZE}`);
      const data = await resp.json();
      cachedSessions = data.sessions || [];
      syncWorkspaceSessionsFromRecords(cachedSessions);
      sessionOffset = cachedSessions.length;
      sessionTotal = data.total || 0;
      sessionsLoaded = true;
      renderSessionList(cachedSessions);
      renderWelcomeSessions(cachedSessions);
      renderWelcomeRuntime();
      renderLoadMore();
    } catch (e) {
      console.error('历史会话加载失败:', e);
    }
  }

  async function loadMoreSessions() {
    try {
      const resp = await fetch(`/api/sessions?offset=${sessionOffset}&limit=${SESSION_PAGE_SIZE}`);
      const data = await resp.json();
      const more = data.sessions || [];
      cachedSessions = cachedSessions.concat(more);
      syncWorkspaceSessionsFromRecords(more);
      sessionOffset = cachedSessions.length;
      sessionTotal = data.total || 0;
      renderSessionList(cachedSessions);
      renderLoadMore();
    } catch (e) {
      console.error('加载更多会话失败:', e);
    }
  }

  function renderLoadMore() {
    const el = document.getElementById('session-list');
    if (!el) return;
    let btn = document.getElementById('btn-load-more');
    if (sessionOffset < sessionTotal) {
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'btn-load-more';
        btn.className = 'btn-load-more';
        btn.textContent = t('loadMore');
        btn.addEventListener('click', loadMoreSessions);
      }
      el.appendChild(btn);
    } else if (btn) {
      btn.remove();
    }
  }

  function renderWelcomeSessions(sessions) {
    const el = document.getElementById('welcome-sessions');
    if (!el) return;
    const current = sessions.filter(s => isCurrentCwd(s.cwd)).slice(0, 3);
    const currentIds = new Set(current.map(s => s.session_id));
    const recent = sessions.filter(s => !currentIds.has(s.session_id)).slice(0, Math.max(0, 5 - current.length));
    if (!current.length && !recent.length) {
      el.innerHTML = `<div class="welcome-empty">${esc(t('noHistory'))}</div>`;
      return;
    }

    let html = '';
    if (current.length) {
      html += `<div class="welcome-session-section current">
        <div class="welcome-session-label">${esc(t('currentProject'))}</div>
        ${current.map(s => renderWelcomeSessionItem(s, s.is_active)).join('')}
      </div>`;
    }
    if (recent.length) {
      html += `<div class="welcome-session-section">
        <div class="welcome-session-label">${esc(t('recentSessions') || 'Recent')}</div>
        ${recent.map(s => renderWelcomeSessionItem(s, s.is_active)).join('')}
      </div>`;
    }
    el.innerHTML = html;

    el.querySelectorAll('.welcome-session-item').forEach(item => {
      item.addEventListener('contextmenu', (e) => {
        showCwdContextMenu(e, item.dataset.cwd || '');
      });
      item.addEventListener('click', () => {
        const tokens = safeJsonParse(item.dataset.tokens, null);
        const sid = item.dataset.sid;
        ensureWorkspaceSession(sid, {
          title: item.querySelector('.welcome-session-item-title')?.textContent?.trim() || t('newChat'),
          cwd: item.dataset.cwd || '',
          model: item.dataset.model || '',
          cli: item.dataset.cli || '',
          cost: Number(item.dataset.cost || 0),
          tokens,
          remoteTargetId: item.dataset.remoteTarget || '',
          status: item.classList.contains('active') ? 'running' : 'idle',
        });
        showPage('chat');
        resumeSession(sid, item.dataset.cwd, item.dataset.model, Number(item.dataset.cost || 0), item.dataset.remoteTarget || '', tokens, item.dataset.cli || '');
      });
    });
  }

  function renderWelcomeSessionItem(s, isActive) {
    const title = s.title || t('newChat');
    const time = formatTime(s.updated_at);
    const savedCost = Number(s.total_cost_usd || 0);
    const modelLabel = getDisplayModelName(s.model || '', false);
    const costStr = savedCost > 0 ? ` · $${savedCost.toFixed(4)}` : '';
    return `<div class="welcome-session-item${isActive ? ' active' : ''}" data-sid="${esc(s.session_id)}" data-cwd="${esc(s.cwd)}" data-model="${esc(s.model)}" data-cli="${esc(s.cli || '')}" data-cost="${esc(savedCost)}" data-tokens="${esc(JSON.stringify(s.total_tokens || {}))}" data-remote-target="${esc(s.remote_target_id || '')}">
      <div class="welcome-session-item-title">${esc(title)}</div>
      <div class="welcome-session-item-meta">${esc(modelLabel || '')}${modelLabel ? ' · ' : ''}${esc(time)}${esc(costStr)}</div>
      ${isActive ? '<span class="welcome-session-dot" title="正在回复中..."></span>' : ''}
    </div>`;
  }

  function renderSessionList(sessions) {
    const el = document.getElementById('session-list');
    if (!el) return;
    const allSessions = sessions || [];
    const filtered = filterSessions(allSessions).sort(compareSessionsByPinAndTime);
    if (sessionsCountEl) {
      sessionsCountEl.textContent = filtered.length === allSessions.length
        ? t('sessionsCount', { count: filtered.length })
        : t('sessionsCountFiltered', { shown: filtered.length, total: allSessions.length });
    }
    if (!filtered.length) {
      el.innerHTML = `<div class="session-empty">${esc(t(allSessions.length ? 'noMatches' : 'noHistory'))}</div>`;
      renderTopbarSessionActions();
      return;
    }

    el.innerHTML = filtered.map(s => renderSessionItem(s)).join('');

    el.querySelectorAll('.session-item').forEach(item => {
      item.addEventListener('contextmenu', (e) => {
        showCwdContextMenu(e, item.dataset.cwd || '');
      });
      item.addEventListener('click', () => {
        const tokens = safeJsonParse(item.dataset.tokens, null);
        const sid = item.dataset.sid;
        ensureWorkspaceSession(sid, {
          title: item.querySelector('.session-item-title')?.textContent?.trim() || t('newChat'),
          cwd: item.dataset.cwd || '',
          model: item.dataset.model || '',
          cli: item.dataset.cli || '',
          cost: Number(item.dataset.cost || 0),
          tokens,
          remoteTargetId: item.dataset.remoteTarget || '',
          status: item.classList.contains('active') ? 'running' : 'idle',
        });
        showPage('chat');
        resumeSession(sid, item.dataset.cwd, item.dataset.model, Number(item.dataset.cost || 0), item.dataset.remoteTarget || '', tokens, item.dataset.cli || '');
      });
    });
    el.querySelectorAll('.session-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const item = btn.closest('.session-item');
        if (!item) return;
        const session = cachedSessions.find(s => s.session_id === item.dataset.sid);
        if (!session) return;
        const action = btn.dataset.action;
        if (action === 'pin') await toggleSessionPin(session.session_id);
        if (action === 'cwd') await changeSessionCwd(session);
        if (action === 'rename') await promptRenameSession(session);
        if (action === 'delete') await deleteSessionRecord(session, 'sessions');
      });
    });
    renderTopbarSessionActions();
  }

  function showCwdContextMenu(e, cwd) {
    const menu = document.getElementById('cwd-context-menu');
    const nextCwd = (cwd || '').trim();
    if (!menu || !nextCwd) return;
    e.preventDefault();
    hideMsgContextMenu();
    contextMenuCwd = nextCwd;
    menu.style.display = 'block';
    const rect = menu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = Math.max(4, x) + 'px';
    menu.style.top = Math.max(4, y) + 'px';
    menu.style.visibility = 'visible';
  }

  function hideCwdContextMenu() {
    const menu = document.getElementById('cwd-context-menu');
    if (menu) { menu.style.display = 'none'; menu.style.visibility = 'hidden'; }
  }

  function initCwdContextMenu() {
    const menu = document.getElementById('cwd-context-menu');
    if (!menu) return;

    menu.querySelector('[data-action="new-session-from-cwd"]')?.addEventListener('click', () => {
      const cwd = contextMenuCwd;
      hideCwdContextMenu();
      startNewSessionFromCwd(cwd);
    });

    menu.querySelector('[data-action="migrate-session-to-cwd"]')?.addEventListener('click', () => {
      const cwd = contextMenuCwd;
      hideCwdContextMenu();
      showMigrateSessionPopover(cwd);
    });

    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) hideCwdContextMenu();
    });
    document.addEventListener('scroll', hideCwdContextMenu, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideCwdContextMenu();
    });
  }

  async function showMigrateSessionPopover(targetCwd) {
    const overlay = document.getElementById('session-migrate-overlay');
    const list = document.getElementById('session-migrate-list');
    const footer = document.getElementById('session-migrate-footer');
    if (!overlay || !list) return;

    migrateTargetCwd = targetCwd;
    const normalizedTarget = targetCwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    let sessionsForMigration = cachedSessions;
    if (!sessionsForMigration.length) {
      const data = await (await fetch(`/api/sessions?offset=0&limit=${SESSION_PAGE_SIZE}`)).json();
      sessionsForMigration = data.sessions || [];
    }
    const otherSessions = sessionsForMigration.filter(s => {
      const sCwd = (s.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      return sCwd && sCwd !== normalizedTarget && s.session_id;
    });

    if (!otherSessions.length) {
      list.innerHTML = `<div class="session-migrate-empty">
        <p>${esc(t('migrateSessionEmpty'))}</p>
        <button id="session-migrate-empty-close" class="btn-save" type="button" style="margin-top:10px; font-size:12px;" data-i18n="close">Close</button>
      </div>`;
      if (footer) footer.style.display = 'none';
      document.getElementById('session-migrate-empty-close')?.addEventListener('click', hideMigrateSessionPopover);
    } else {
      list.innerHTML = otherSessions.map(s => `
        <label class="session-migrate-item" data-sid="${esc(s.session_id)}">
          <input type="checkbox" class="session-migrate-check">
          <span class="session-migrate-item-title">${esc(s.title || s.session_id)}</span>
          <span class="session-migrate-item-cwd" title="${esc(s.cwd || '')}">${shortenPath(s.cwd)}</span>
        </label>
      `).join('');
      if (footer) footer.style.display = 'flex';
      const checkAll = document.getElementById('session-migrate-check-all');
      if (checkAll) checkAll.checked = false;
    }

    overlay.style.display = 'flex';
  }

  function hideMigrateSessionPopover() {
    const overlay = document.getElementById('session-migrate-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function initMigrateSessionPopover() {
    const overlay = document.getElementById('session-migrate-overlay');
    if (!overlay) return;
    document.getElementById('session-migrate-close')?.addEventListener('click', hideMigrateSessionPopover);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hideMigrateSessionPopover();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display !== 'none') hideMigrateSessionPopover();
    });

    document.getElementById('session-migrate-check-all')?.addEventListener('change', function () {
      const list = document.getElementById('session-migrate-list');
      if (!list) return;
      list.querySelectorAll('.session-migrate-check').forEach(cb => { cb.checked = this.checked; });
    });

    document.getElementById('session-migrate-confirm')?.addEventListener('click', async function () {
      const list = document.getElementById('session-migrate-list');
      const footer = document.getElementById('session-migrate-footer');
      if (!list || !footer) return;
      const checked = list.querySelectorAll('.session-migrate-check:checked');
      if (!checked.length) return;

      const btn = this;
      btn.disabled = true;
      btn.textContent = t('migrating') || 'Migrating...';
      footer.style.pointerEvents = 'none';
      footer.style.opacity = '0.6';

      let okCount = 0;
      const total = checked.length;
      for (let i = 0; i < checked.length; i++) {
        const sid = checked[i].closest('.session-migrate-item')?.dataset.sid;
        if (!sid) continue;
        btn.textContent = `${t('migrating') || 'Migrating'} (${i + 1}/${total})`;
        const result = await updateSessionCwd(sid, migrateTargetCwd);
        if (result.ok) okCount++;
      }

      if (okCount > 0) {
        hideMigrateSessionPopover();
        loadSessions();
        addSystemMsg(t('migrateSessionMoved', { count: okCount }));
      }
      btn.disabled = false;
      footer.style.pointerEvents = '';
      footer.style.opacity = '';
    });
  }

  async function renameSession(sessionId, title) {
    try {
      const resp = await fetch('/api/sessions/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, title }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(formatMessage(data, 'renameFailed'));
      const session = workspaceSessions.get(sessionId);
      if (session) {
        session.title = title;
        saveWorkspaceState();
        renderWorkspace();
      }
      await loadSessions();
    } catch (e) {
      addSystemMsg(e.message || t('renameFailed'), true);
    }
  }

  function filterSessions(sessions) {
    const keywords = (sessionSearchInput?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!keywords.length) return sessions;
    return sessions.filter(s => {
      const haystack = [s.title, s.cwd, s.model, s.updated_at, s.remote_target_id, s.scheduled_task_name].map(value => String(value || '').toLowerCase());
      return keywords.every(keyword => haystack.some(value => value.includes(keyword)));
    });
  }

  function renderSessionItem(s) {
    const isActive = s.session_id === currentSessionId;
    const title = s.title || t('newChat');
    const time = formatTime(s.updated_at);
    const savedCost = Number(s.total_cost_usd || 0);
    const savedTokens = normalizeTokenUsage(s.total_tokens);
    const tokenTotal = tokenUsageTotal(savedTokens);
    const modelLabel = getDisplayModelName(s.model || '', false);
    const scheduledTaskName = s.scheduled_task_name || '';
    const isScheduled = Boolean(s.scheduled_task_id || scheduledTaskName);
    const scheduledBadge = isScheduled ? `<span class="session-item-badge scheduled" title="${esc(scheduledTaskName || t('scheduledSession'))}">${esc(t('scheduledSession'))}</span>` : '';
    const pinnedBadge = s.pinned ? `<span class="session-item-badge pinned" title="${esc(t('pinnedSessions'))}">PIN</span>` : '';
    const metaParts = [
      `<span class="session-item-meta-primary">${esc(time)}</span>`,
      modelLabel ? `<span>${esc(modelLabel)}</span>` : '',
      isScheduled && scheduledTaskName ? `<span>${esc(t('scheduledTaskName', { name: scheduledTaskName }))}</span>` : '',
      savedCost > 0 ? `<span>$${savedCost.toFixed(4)}</span>` : '',
      tokenTotal > 0 ? `<span>${formatTokenCount(tokenTotal)} tok</span>` : '',
    ].filter(Boolean).join('');
    return `<div class="session-item${isActive ? ' active' : ''}" data-sid="${esc(s.session_id)}" data-cwd="${esc(s.cwd)}" data-model="${esc(s.model)}" data-cli="${esc(s.cli || '')}" data-cost="${esc(savedCost)}" data-tokens="${esc(JSON.stringify(savedTokens))}" data-remote-target="${esc(s.remote_target_id || '')}">
      <div class="session-item-main">
        <div class="session-item-title-row">
          <div class="session-item-title" title="${esc(title)}">${esc(title)}</div>
          ${pinnedBadge}
          ${scheduledBadge}
        </div>
        <div class="session-item-meta">${metaParts}</div>
      </div>
      <div class="session-item-actions" aria-label="Session actions">
        <button class="session-action session-action-pin${s.pinned ? ' pinned' : ''}" type="button" data-action="pin" title="${esc(t(s.pinned ? 'unpinSession' : 'pinSession'))}">${esc(s.pinned ? 'UNPIN' : 'PIN')}</button>
        <button class="session-action" type="button" data-action="cwd" title="${esc(s.cwd || t('changeCwd'))}">DIR</button>
        <button class="session-action" type="button" data-action="rename" title="${esc(t('rename'))}">EDIT</button>
        <button class="session-action danger" type="button" data-action="delete" title="${esc(t('delete'))}">×</button>
      </div>
    </div>`;
  }

  function normalizeCwdKey(cwd) {
    const value = (cwd || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return value ? value.toLowerCase() : '__no_cwd__';
  }

  function isCurrentCwd(cwd) {
    const current = cwdInput.value.trim();
    if (!current || !cwd) return false;
    return normalizeCwdKey(current) === normalizeCwdKey(cwd);
  }

  function getCurrentSessionRecord() {
    return cachedSessions.find(s => s.session_id === currentSessionId) || null;
  }

  function renderTopbarSessionActions() {
    const session = getCurrentSessionRecord();
    const disabled = !currentSessionId || !session;
    [btnSessionPin, btnSessionCwd, btnSessionRename, btnSessionDelete].forEach(btn => {
      if (!btn) return;
      btn.disabled = disabled;
    });
    if (btnSessionPin) {
      btnSessionPin.classList.toggle('pinned', !!session?.pinned);
      btnSessionPin.textContent = session?.pinned ? 'UNPIN' : 'PIN';
      btnSessionPin.title = t(session?.pinned ? 'unpinSession' : 'pinSession');
    }
    if (btnSessionCwd) btnSessionCwd.title = session?.cwd || t('changeCwd');
  }

  function compareSessionsByPinAndTime(a, b) {
    const pinnedDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinnedDiff) return pinnedDiff;
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  }

  async function openLatestOrNewChatSession() {
    if (sessionActive || currentSessionId) {
      showPage('chat');
      return;
    }
    if (!clientId) {
      showPage('chat');
      addSystemMsg(t('notConnected'), true);
      return;
    }
    if (activeWorkspaceSessionId && workspaceSessions.has(activeWorkspaceSessionId)) {
      const session = workspaceSessions.get(activeWorkspaceSessionId);
      showPage('chat');
      resumeSession(
        session.sessionId,
        session.cwd || '',
        session.model || '',
        Number(session.cost || 0),
        session.remoteTargetId || '',
        session.tokens || null,
        session.cli || '',
      );
      return;
    }
    if (!sessionsLoaded) {
      await loadSessions();
    }
    const latest = (cachedSessions || [])
      .slice()
      .sort(compareSessionsByPinAndTime)[0];
    showPage('chat');
    if (latest?.session_id) {
      resumeSession(
        latest.session_id,
        latest.cwd || '',
        latest.model || '',
        Number(latest.total_cost_usd || 0),
        latest.remote_target_id || '',
        latest.total_tokens || null,
        latest.cli || '',
      );
      return;
    }
    createNewSession('');
  }

  async function toggleSessionPin(sessionId) {
    if (!sessionId) return;
    try {
      const resp = await fetch('/api/sessions/toggle-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (resp.ok) await loadSessions();
    } catch (err) {
      console.error('[pin] error', err);
    }
  }

  async function changeSessionCwd(session) {
    if (!session) return;
    const oldCwd = session.cwd || '';
    const newCwd = await promptCwdForSession(oldCwd);
    if (!newCwd || !newCwd.trim() || newCwd.trim() === oldCwd) return;
    const result = await updateSessionCwd(session.session_id, newCwd.trim());
    if (result.ok) {
      addSystemMsg(t('cwdChanged', { path: newCwd.trim() }));
      if (session.session_id === currentSessionId) {
        cwdInput.value = newCwd.trim();
        updateRuntimeSummary();
        refreshRightPaneFiles();
      }
      await loadSessions();
    } else {
      addSystemMsg(t('cwdNotChanged', { message: formatMessage(result) }), true);
    }
  }

  async function promptRenameSession(session) {
    if (!session) return;
    const currentTitle = session.title || t('newChat');
    const nextTitle = window.prompt(t('renameSessionPrompt'), currentTitle);
    if (!nextTitle || nextTitle.trim() === currentTitle) return;
    await renameSession(session.session_id, nextTitle.trim());
  }

  async function deleteSessionRecord(session, nextPage = 'sessions') {
    if (!session) return;
    const title = session.title || t('newChat');
    if (!window.confirm(t('confirmDeleteSession', { title }))) return;
    await fetch('/api/sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.session_id, cwd: session.cwd || '' }),
    });
    if (session.session_id === currentSessionId) currentSessionId = null;
    await loadSessions();
    renderTopbarMeta();
    showPage(nextPage);
  }

  function initTopbarSessionActions() {
    btnSessionPin?.addEventListener('click', async () => {
      const session = getCurrentSessionRecord();
      if (session) await toggleSessionPin(session.session_id);
    });

    btnSessionCwd?.addEventListener('click', async () => {
      await changeSessionCwd(getCurrentSessionRecord());
    });

    btnSessionRename?.addEventListener('click', async () => {
      await promptRenameSession(getCurrentSessionRecord());
    });

    btnSessionDelete?.addEventListener('click', async () => {
      await deleteSessionRecord(getCurrentSessionRecord(), 'sessions');
    });
  }

  root.sessions = {
    loadSessions,
    loadMoreSessions,
    renderSessionList,
    renderWelcomeSessions,
    renderWelcomeSessionItem,
    renderLoadMore,
    syncWorkspaceSessionsFromRecords,
    getCurrentSessionRecord,
    renderTopbarSessionActions,
    compareSessionsByPinAndTime,
    openLatestOrNewChatSession,
    toggleSessionPin,
    changeSessionCwd,
    promptRenameSession,
    deleteSessionRecord,
    initTopbarSessionActions,
    showCwdContextMenu,
    hideCwdContextMenu,
    initCwdContextMenu,
    showMigrateSessionPopover,
    hideMigrateSessionPopover,
    initMigrateSessionPopover,
    renameSession,
    filterSessions,
    renderSessionItem,
    normalizeCwdKey,
    isCurrentCwd,
  };
})();
