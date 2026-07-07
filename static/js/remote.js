(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let remoteTargets = [];
  let remotePasswordSupported = true;

  function init() {
    remoteTargetSelect?.addEventListener('change', updateMutateRow);
    document.getElementById('btn-remote-add')?.addEventListener('click', () => showForm());
    document.getElementById('btn-remote-cancel')?.addEventListener('click', hideForm);
    document.getElementById('btn-remote-save')?.addEventListener('click', saveTarget);
    document.getElementById('btn-remote-test')?.addEventListener('click', () => testConnection(readForm()));
    document.getElementById('remote-form-auth')?.addEventListener('change', updateAuthVisibility);
    loadTargets();
  }

  async function loadTargets() {
    try {
      const resp = await root.api.request('/api/remote-targets');
      const data = await resp.json();
      // 兼容旧的数组返回；新版本返回 { targets, password_supported }
      if (Array.isArray(data)) {
        remoteTargets = data;
      } else {
        remoteTargets = Array.isArray(data.targets) ? data.targets : [];
        remotePasswordSupported = data.password_supported !== false;
      }
    } catch (e) {
      remoteTargets = [];
    }
    renderTargetList();
    populateSelect();
  }

  function getTargets() {
    return remoteTargets.slice();
  }

  function updateAuthVisibility() {
    const method = document.getElementById('remote-form-auth')?.value || 'key';
    const keyBox = document.getElementById('remote-auth-key');
    const passBox = document.getElementById('remote-auth-password');
    if (keyBox) keyBox.style.display = method === 'password' ? 'none' : '';
    if (passBox) passBox.style.display = method === 'password' ? '' : 'none';
    const passHint = document.getElementById('remote-pass-hint');
    if (passHint) {
      const editing = !!document.getElementById('remote-form-id').value;
      const tg = remoteTargets.find(x => x.id === document.getElementById('remote-form-id').value);
      if (!remotePasswordSupported) {
        // SSH 缺失时，根据方法显示相应提示
        if (method === 'password') {
          passHint.innerHTML = `${t('remoteSshMissing')}<br><small style="color: #666; margin-top: 0.3em; display: block;">${t('remoteSshMissingWin')}</small>`;
        } else {
          // 密钥认证不受影响
          passHint.innerHTML = `<small style="color: #999;">${t('remoteKeyAuthUnaffected')}</small>`;
        }
      } else if (editing && tg?.has_password) passHint.textContent = t('remotePasswordSaved');
      else passHint.textContent = t('remotePasswordHint');
      passHint.classList.toggle('warn', !remotePasswordSupported && method === 'password');
    }
  }

  function populateSelect() {
    if (!remoteTargetSelect) return;
    const prev = remoteTargetSelect.value;
    remoteTargetSelect.innerHTML = `<option value="">${esc(t('remoteTargetNone'))}</option>` +
      remoteTargets.map(tg => `<option value="${esc(tg.id)}">${esc(tg.name || tg.host)}</option>`).join('');
    if (remoteTargets.some(tg => tg.id === prev)) remoteTargetSelect.value = prev;
    updateMutateRow();
  }

  function updateMutateRow() {
    if (!remoteMutateRow) return;
    const active = !!(remoteTargetSelect && remoteTargetSelect.value);
    remoteMutateRow.style.display = active ? '' : 'none';
    if (!active && remoteAllowMutate) remoteAllowMutate.checked = false;
    updateRuntimeSummary();
    renderWelcomeRuntime();
  }

  function renderTargetList() {
    const list = document.getElementById('remote-target-list');
    if (!list) return;
    if (!remoteTargets.length) {
      list.innerHTML = `<p class="empty-state">${esc(t('remoteNoTargets'))}</p>`;
      return;
    }
    list.innerHTML = remoteTargets.map(tg => `
      <div class="remote-target-item" data-id="${esc(tg.id)}">
        <div class="remote-target-info">
          <span class="remote-target-name">${esc(tg.name || tg.host)}</span>
          <span class="remote-target-addr">${esc(tg.user)}@${esc(tg.host)}:${esc(String(tg.port || 22))} · <span class="remote-key-badge">${esc(tg.auth_method === 'password' ? t('remoteAuthPassword') : t('remoteAuthKey'))}</span></span>
        </div>
        <div class="remote-target-actions">
          <button class="remote-mini-btn" data-act="test">${esc(t('remoteTest'))}</button>
          <button class="remote-mini-btn" data-act="edit">${esc(t('edit'))}</button>
          <button class="remote-mini-btn danger" data-act="delete">${esc(t('delete'))}</button>
        </div>
        <div class="remote-target-status" style="display:none"></div>
      </div>
    `).join('');
    list.querySelectorAll('.remote-target-item').forEach(item => {
      const id = item.dataset.id;
      const tg = remoteTargets.find(x => x.id === id);
      item.querySelector('[data-act="edit"]').addEventListener('click', () => showForm(tg));
      item.querySelector('[data-act="delete"]').addEventListener('click', () => deleteTarget(tg));
      item.querySelector('[data-act="test"]').addEventListener('click', () => testConnection(tg, item.querySelector('.remote-target-status')));
    });
  }

  function showForm(target) {
    const section = document.getElementById('remote-form-section');
    if (!section) return;
    document.getElementById('remote-form-id').value = target?.id || '';
    document.getElementById('remote-form-name').value = target?.name || '';
    document.getElementById('remote-form-host').value = target?.host || '';
    document.getElementById('remote-form-user').value = target?.user || '';
    document.getElementById('remote-form-port').value = target?.port || 22;
    document.getElementById('remote-form-key').value = target?.key_path || '';
    document.getElementById('remote-form-key-text').value = '';
    document.getElementById('remote-form-password').value = '';
    document.getElementById('remote-form-auth').value = target?.auth_method || 'key';
    document.getElementById('remote-form-desc').value = target?.description || '';
    // 私钥内容从不回传；编辑已配置密钥的目标时提示留空即保持不变
    const hint = document.getElementById('remote-key-hint');
    if (hint) hint.textContent = target?.has_key ? t('remoteKeySaved') : t('remoteKeyHint');
    updateAuthVisibility();
    const title = document.getElementById('remote-form-title');
    if (title) title.textContent = target ? t('remoteEditTarget') : t('remoteNewTarget');
    setFormStatus('', '');
    section.style.display = '';
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideForm() {
    const section = document.getElementById('remote-form-section');
    if (section) section.style.display = 'none';
  }

  function readForm() {
    return {
      id: document.getElementById('remote-form-id').value || '',
      name: document.getElementById('remote-form-name').value.trim(),
      host: document.getElementById('remote-form-host').value.trim(),
      user: document.getElementById('remote-form-user').value.trim(),
      port: Number(document.getElementById('remote-form-port').value || 22),
      auth_method: document.getElementById('remote-form-auth').value || 'key',
      key_path: document.getElementById('remote-form-key').value.trim(),
      key_text: document.getElementById('remote-form-key-text').value,
      password: document.getElementById('remote-form-password').value,
      description: document.getElementById('remote-form-desc').value.trim(),
    };
  }

  function setFormStatus(text, kind) {
    const status = document.getElementById('remote-form-status');
    if (!status) return;
    status.style.display = text ? '' : 'none';
    status.textContent = text;
    status.className = `remote-form-status${kind ? ' ' + kind : ''}`;
  }

  async function saveTarget() {
    const target = readForm();
    if (!target.host || !target.user) {
      setFormStatus(t('remoteNeedHostUser'), 'err');
      return;
    }
    try {
      const resp = await root.api.request('/api/remote-targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setFormStatus(err.error || t('remoteSaveFailed'), 'err');
        return;
      }
      await loadTargets();
      hideForm();
    } catch (e) {
      setFormStatus(t('remoteSaveFailed'), 'err');
    }
  }

  async function deleteTarget(target) {
    if (!target) return;
    if (!window.confirm(t('remoteConfirmDelete', { name: target.name || target.host }))) return;
    try {
      await root.api.postJson('/api/remote-targets/delete', { id: target.id });
    } catch (e) { /* ignore */ }
    await loadTargets();
  }

  async function testConnection(target, statusEl) {
    if (!target || !target.host || !target.user) {
      if (statusEl) { statusEl.style.display = ''; statusEl.textContent = t('remoteNeedHostUser'); statusEl.className = 'remote-target-status err'; }
      else setFormStatus(t('remoteNeedHostUser'), 'err');
      return;
    }
    const setStatus = (text, kind) => {
      if (statusEl) { statusEl.style.display = ''; statusEl.textContent = text; statusEl.className = `remote-target-status${kind ? ' ' + kind : ''}`; }
      else setFormStatus(text, kind);
    };
    setStatus(t('remoteTesting'), '');
    try {
      const resp = await root.api.request('/api/remote-targets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      const result = await resp.json();
      if (result.ok) {
        setStatus(t('remoteTestOk'), 'ok');
      } else {
        const reasons = {
          ssh_not_found: t('remoteSshMissing'),
          timeout: t('remoteTestTimeout'),
          missing_host_or_user: t('remoteNeedHostUser'),
          missing_password: t('remoteNeedPassword'),
          auth_failed: t('remoteAuthFailed'),
          target_not_found: t('remoteSaveFailed'),
        };
        const base = reasons[result.error] || t('remoteTestFail');
        setStatus(result.detail ? `${base} — ${result.detail}` : base, 'err');
      }
    } catch (e) {
      setStatus(t('remoteTestFail'), 'err');
    }
  }

  function getTargetName() {
    const opt = remoteTargetSelect?.selectedOptions?.[0];
    return opt ? opt.textContent.trim() : '';
  }

  root.remote = {
    init,
    loadTargets,
    getTargets,
    getTargetName,
    populateSelect,
    updateMutateRow,
  };
})();
