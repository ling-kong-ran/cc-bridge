(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let scheduledTasks = [];

  function formatMessage(data, fallbackKey = 'unknownError') {
    return root.i18n?.formatMessage ? root.i18n.formatMessage(data, fallbackKey) : String(data?.error || data?.message || t(fallbackKey) || '');
  }

  function init() {
    document.getElementById('btn-scheduled-refresh')?.addEventListener('click', () => {
      loadTasks().catch((e) => console.warn('Load scheduled tasks failed:', e));
    });
    document.getElementById('btn-scheduled-save')?.addEventListener('click', () => {
      saveTask().catch((e) => {
        console.warn('Save scheduled task failed:', e);
        showToast(t('scheduledSaveFailed'), 'error');
      });
    });
    document.getElementById('btn-scheduled-reset')?.addEventListener('click', resetForm);
    document.getElementById('scheduled-type')?.addEventListener('change', updateScheduleFields);
    document.getElementById('scheduled-task-list')?.addEventListener('click', handleTaskAction);
    updateScheduleFields();
  }

  function populateSelects() {
    const model = document.getElementById('scheduled-model');
    if (model && modelSelect) {
      const prev = model.value || modelSelect.value;
      model.innerHTML = Array.from(modelSelect.options).map(opt => `<option value="${esc(opt.value)}">${esc(opt.textContent)}</option>`).join('');
      if (prev && Array.from(model.options).some(opt => opt.value === prev)) model.value = prev;
    }
    const cli = document.getElementById('scheduled-cli');
    const cliSource = document.getElementById('cli-select');
    if (cli && cliSource) {
      const prev = cli.value || cliSource.value;
      cli.innerHTML = Array.from(cliSource.options).map(opt => `<option value="${esc(opt.value)}">${esc(opt.textContent)}</option>`).join('');
      if (prev && Array.from(cli.options).some(opt => opt.value === prev)) cli.value = prev;
    }
    const remote = document.getElementById('scheduled-remote');
    if (remote) {
      const prev = remote.value;
      const targets = root.remote?.getTargets?.() || [];
      remote.innerHTML = `<option value="">${esc(t('remoteTargetNone'))}</option>` + targets.map(tg => `<option value="${esc(tg.id)}">${esc(tg.name || tg.host)}</option>`).join('');
      if (targets.some(tg => tg.id === prev)) remote.value = prev;
    }
  }

  function updateScheduleFields() {
    const type = document.getElementById('scheduled-type')?.value || 'interval';
    const interval = document.getElementById('scheduled-interval-field');
    const daily = document.getElementById('scheduled-daily-field');
    const once = document.getElementById('scheduled-once-field');
    setVisible(interval, type === 'interval');
    setVisible(daily, type === 'daily');
    setVisible(once, type === 'once');
  }

  async function loadTasks() {
    const list = document.getElementById('scheduled-task-list');
    if (!list) return;
    populateSelects();
    try {
      const data = await root.api.json('/api/scheduled-tasks');
      scheduledTasks = Array.isArray(data.tasks) ? data.tasks : [];
      renderTasks();
    } catch (e) {
      list.innerHTML = `<p class="empty-state">${esc(t('scheduledLoadFailed'))}</p>`;
    }
  }

  function handleTaskAction(e) {
    const actionEl = e.target.closest('[data-act]');
    const item = actionEl?.closest('.scheduled-task-item');
    if (!actionEl || !item) return;
    const task = scheduledTasks.find(t => t.id === item.dataset.id);
    if (!task) return;
    if (actionEl.dataset.act === 'run') runTask(task).catch((err) => console.warn('Run scheduled task failed:', err));
    if (actionEl.dataset.act === 'toggle') toggleTask(task).catch((err) => console.warn('Toggle scheduled task failed:', err));
    if (actionEl.dataset.act === 'edit') fillForm(task);
    if (actionEl.dataset.act === 'delete') deleteTask(task).catch((err) => console.warn('Delete scheduled task failed:', err));
  }

  function renderTasks() {
    const list = document.getElementById('scheduled-task-list');
    if (!list) return;
    if (!scheduledTasks.length) {
      list.innerHTML = `<p class="empty-state">${esc(t('scheduledNoTasks'))}</p>`;
      return;
    }
    list.innerHTML = scheduledTasks.map(task => `
      <article class="scheduled-task-item ${task.enabled ? '' : 'disabled'}" data-id="${esc(task.id)}">
        <div class="scheduled-task-main">
          <div class="scheduled-task-title-row">
            <strong>${esc(task.name || t('scheduledTask'))}</strong>
            <span class="scheduled-status status-${esc(task.last_status || 'idle')}">${esc(task.last_status || (task.enabled ? t('enabled') : t('disabled')))}</span>
          </div>
          <div class="scheduled-task-meta">${esc(formatSchedule(task.schedule))} · ${esc(t('nextRun'))}: ${esc(formatTaskTime(task.next_run_at))}</div>
          <div class="scheduled-task-meta">${esc(shortenPath(task.cwd || '', 4))}</div>
          ${task.last_error ? `<div class="scheduled-task-error">${esc(task.last_error)}</div>` : ''}
        </div>
        <div class="scheduled-task-actions">
          <button class="btn-mini" data-act="run">${esc(t('runNow'))}</button>
          <button class="btn-mini" data-act="toggle">${esc(task.enabled ? t('disable') : t('enable'))}</button>
          <button class="btn-mini" data-act="edit">${esc(t('edit'))}</button>
          <button class="btn-mini danger" data-act="delete">${esc(t('delete'))}</button>
        </div>
      </article>
    `).join('');
  }

  function formatSchedule(schedule) {
    const s = schedule || {};
    if (s.type === 'daily') return `${t('scheduleDaily')} ${s.time || '09:00'}`;
    if (s.type === 'once') return `${t('scheduleOnce')} ${formatTaskTime(s.run_at)}`;
    return `${t('scheduleInterval')} ${s.minutes || 60}m`;
  }

  function formatTaskTime(ts) {
    const value = Number(ts || 0);
    if (!value) return '-';
    try { return new Date(value * 1000).toLocaleString(); } catch (e) { return '-'; }
  }

  function toDateTimeLocal(ts) {
    const date = ts ? new Date(Number(ts) * 1000) : new Date(Date.now() + 3600000);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function readForm() {
    const type = document.getElementById('scheduled-type')?.value || 'interval';
    const schedule = { type };
    if (type === 'daily') schedule.time = document.getElementById('scheduled-time')?.value || '09:00';
    else if (type === 'once') {
      const raw = document.getElementById('scheduled-run-at')?.value || '';
      schedule.run_at = raw ? Math.floor(new Date(raw).getTime() / 1000) : Math.floor(Date.now() / 1000) + 3600;
    } else {
      schedule.minutes = Math.max(1, Number(document.getElementById('scheduled-minutes')?.value || 60));
    }
    return {
      id: document.getElementById('scheduled-task-id')?.value || '',
      name: document.getElementById('scheduled-name')?.value || '',
      prompt: document.getElementById('scheduled-prompt')?.value || '',
      cwd: document.getElementById('scheduled-cwd')?.value || cwdInput?.value || '',
      model: document.getElementById('scheduled-model')?.value || modelSelect?.value || '',
      cli: document.getElementById('scheduled-cli')?.value || document.getElementById('cli-select')?.value || '',
      remote_target_id: document.getElementById('scheduled-remote')?.value || '',
      allow_remote_mutate: document.getElementById('scheduled-allow-remote-mutate')?.checked || false,
      reuse_session: document.getElementById('scheduled-reuse-session')?.checked || false,
      enabled: document.getElementById('scheduled-enabled')?.checked !== false,
      schedule,
    };
  }

  function fillForm(task) {
    populateSelects();
    document.getElementById('scheduled-form-title').textContent = t('scheduledEditTask');
    document.getElementById('scheduled-task-id').value = task.id || '';
    document.getElementById('scheduled-name').value = task.name || '';
    document.getElementById('scheduled-prompt').value = task.prompt || '';
    document.getElementById('scheduled-cwd').value = task.cwd || cwdInput?.value || '';
    if (task.model) document.getElementById('scheduled-model').value = task.model;
    if (task.cli) document.getElementById('scheduled-cli').value = task.cli;
    document.getElementById('scheduled-remote').value = task.remote_target_id || '';
    document.getElementById('scheduled-allow-remote-mutate').checked = !!task.allow_remote_mutate;
    document.getElementById('scheduled-reuse-session').checked = !!task.reuse_session;
    document.getElementById('scheduled-enabled').checked = task.enabled !== false;
    const schedule = task.schedule || { type: 'interval', minutes: 60 };
    document.getElementById('scheduled-type').value = schedule.type || 'interval';
    document.getElementById('scheduled-minutes').value = schedule.minutes || 60;
    document.getElementById('scheduled-time').value = schedule.time || '09:00';
    document.getElementById('scheduled-run-at').value = toDateTimeLocal(schedule.run_at);
    updateScheduleFields();
  }

  function resetForm() {
    document.getElementById('scheduled-form-title').textContent = t('scheduledNewTask');
    document.getElementById('scheduled-task-id').value = '';
    document.getElementById('scheduled-name').value = '';
    document.getElementById('scheduled-prompt').value = '';
    document.getElementById('scheduled-cwd').value = cwdInput?.value || '';
    document.getElementById('scheduled-type').value = 'interval';
    document.getElementById('scheduled-minutes').value = 60;
    document.getElementById('scheduled-time').value = '09:00';
    document.getElementById('scheduled-run-at').value = toDateTimeLocal();
    document.getElementById('scheduled-allow-remote-mutate').checked = false;
    document.getElementById('scheduled-reuse-session').checked = false;
    document.getElementById('scheduled-enabled').checked = true;
    populateSelects();
    updateScheduleFields();
  }

  async function saveTask() {
    const payload = readForm();
    if (!payload.prompt.trim()) {
      showToast(t('scheduledPromptRequired'), 'warning');
      return;
    }
    const resp = await root.api.request('/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showToast(formatMessage(data, 'scheduledSaveFailed'), 'error');
      return;
    }
    showToast(t('scheduledTaskSaved'), 'success');
    resetForm();
    await loadTasks();
  }

  async function deleteTask(task) {
    if (!task || !confirm(t('scheduledConfirmDelete', { name: task.name || t('scheduledTask') }))) return;
    await root.api.postJson('/api/scheduled-tasks/delete', { id: task.id });
    showToast(t('scheduledTaskDeleted'), 'success');
    await loadTasks();
  }

  async function toggleTask(task) {
    if (!task) return;
    await root.api.postJson('/api/scheduled-tasks/toggle', { id: task.id, enabled: !task.enabled });
    await loadTasks();
  }

  async function runTask(task) {
    if (!task) return;
    await root.api.postJson('/api/scheduled-tasks/run-now', { id: task.id });
    showToast(t('scheduledTaskStarted'), 'info');
    await loadTasks();
  }

  root.scheduledTasks = {
    init,
    loadTasks,
    populateSelects,
  };
})();
