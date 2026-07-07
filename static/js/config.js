(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let envProfilesCache = {};

  async function loadConfig() {
    try {
      const env = await root.api.json('/api/env');
      renderEnvEditor(env);
      renderEnvPasteSection();
      loadEnvProfiles();
    } catch (e) {
      console.error('配置加载失败:', e);
    }
  }

  function renderEnvEditor(env) {
    const container = document.getElementById('env-fields');
    container.innerHTML = Object.entries(env).map(([k, v]) => `
      <div class="env-row">
        <input class="env-key" value="${esc(k)}">
        <input class="env-val" value="${esc(v)}">
        <button class="env-row-del" title="${esc(t('delete'))}">×</button>
      </div>
    `).join('') + `<div class="env-row env-row-add"><button class="env-add-btn">+</button></div>`;

    container.querySelectorAll('.env-row-del').forEach(btn => {
      btn.onclick = () => btn.closest('.env-row').remove();
    });
    container.querySelector('.env-add-btn').onclick = () => {
      const addRow = container.querySelector('.env-row-add');
      const row = document.createElement('div');
      row.className = 'env-row';
      row.innerHTML = `<input class="env-key" placeholder="KEY"><input class="env-val" placeholder="value"><button class="env-row-del" title="${esc(t('delete'))}">×</button>`;
      row.querySelector('.env-row-del').onclick = () => row.remove();
      container.insertBefore(row, addRow);
      row.querySelector('.env-key').focus();
    };

    document.getElementById('btn-save-env').onclick = async () => {
      const newEnv = {};
      container.querySelectorAll('.env-row:not(.env-row-add)').forEach(row => {
        const key = row.querySelector('.env-key').value.trim();
        const val = row.querySelector('.env-val').value;
        if (key) newEnv[key] = val;
      });
      await root.api.request('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEnv),
      });
      addSystemMsg(t('envSaved'));
    };
  }

  function collectEditorEnv() {
    const newEnv = {};
    document.querySelectorAll('#env-fields .env-row:not(.env-row-add)').forEach(row => {
      const key = row.querySelector('.env-key').value.trim();
      const val = row.querySelector('.env-val').value;
      if (key) newEnv[key] = val;
    });
    return newEnv;
  }

  async function loadEnvProfiles() {
    try {
      const data = await root.api.json('/api/env-profiles');
      envProfilesCache = data.profiles || {};
    } catch (e) { envProfilesCache = {}; }
    renderEnvProfilesBar(envProfilesCache);
  }

  function renderEnvProfilesBar(profiles) {
    const bar = document.getElementById('env-profiles-bar');
    if (!bar) return;
    const names = Object.keys(profiles);
    const options = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    bar.innerHTML = `
      <select id="profile-select">
        <option value="">${esc(t('profileSelect'))}</option>
        ${options}
      </select>
      <button class="profile-btn" id="profile-load-btn">${esc(t('profileLoad'))}</button>
      <button class="profile-btn" id="profile-save-btn">${esc(t('profileSaveAs'))}</button>
      <button class="profile-btn" id="profile-del-btn">${esc(t('profileDelete'))}</button>
    `;
    bar.querySelector('#profile-load-btn').onclick = loadSelectedProfile;
    bar.querySelector('#profile-save-btn').onclick = saveAsEnvProfile;
    bar.querySelector('#profile-del-btn').onclick = deleteSelectedProfile;
  }

  function loadSelectedProfile() {
    const sel = document.getElementById('profile-select');
    const name = sel ? sel.value : '';
    if (!name || !envProfilesCache[name]) return;
    renderEnvEditor(envProfilesCache[name].env || {});
    renderEnvPasteSection();
    addSystemMsg(t('profileLoaded', { name }));
  }

  async function saveAsEnvProfile() {
    showEnvProfileSavePicker();
  }

  function showEnvProfileSavePicker() {
    let overlay = document.getElementById('env-profile-save-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'env-profile-save-overlay';
      overlay.className = 'profile-save-overlay';
      document.body.appendChild(overlay);
    }

    const names = Object.keys(envProfilesCache || {}).sort((a, b) => a.localeCompare(b));
    overlay.innerHTML = `
      <div class="profile-save-modal" role="dialog" aria-modal="true">
        <div class="profile-save-head">
          <div>
            <div class="profile-save-title">${esc(t('profileSaveTitle'))}</div>
            <div class="profile-save-hint">${esc(t('profileSaveHint'))}</div>
          </div>
          <button type="button" class="profile-save-close" title="${esc(t('close'))}">&times;</button>
        </div>
        <div class="profile-save-new">
          <input id="profile-save-name" class="profile-save-input" type="text" placeholder="${esc(t('profileNamePlaceholder'))}">
          <button type="button" id="profile-save-new-btn" class="profile-save-primary">${esc(t('profileSaveNew'))}</button>
        </div>
        <div class="profile-save-section-title">${esc(t('profileOverwriteExisting'))}</div>
        <div class="profile-save-list">
          ${names.length ? names.map(name => `
            <button type="button" class="profile-save-item" data-name="${esc(name)}">
              <span>${esc(name)}</span>
              <span>${esc(t('profileOverwrite'))}</span>
            </button>
          `).join('') : `<div class="profile-save-empty">${esc(t('profileNoExisting'))}</div>`}
        </div>
      </div>
    `;

    const close = () => hideEnvProfileSavePicker();
    overlay.querySelector('.profile-save-close')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }, { once: true });
    overlay.querySelector('#profile-save-new-btn')?.addEventListener('click', () => {
      const input = overlay.querySelector('#profile-save-name');
      saveEnvProfileFromEditor(input?.value || '');
    });
    overlay.querySelector('#profile-save-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveEnvProfileFromEditor(e.currentTarget.value || '');
      if (e.key === 'Escape') close();
    });
    overlay.querySelectorAll('.profile-save-item').forEach(btn => {
      btn.addEventListener('click', () => saveEnvProfileFromEditor(btn.dataset.name || '', true));
    });

    overlay.style.display = 'flex';
    overlay.querySelector('#profile-save-name')?.focus();
  }

  function hideEnvProfileSavePicker() {
    const overlay = document.getElementById('env-profile-save-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function saveEnvProfileFromEditor(name, overwriting = false) {
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      addSystemMsg(t('profileNameEmpty'));
      return;
    }
    if (overwriting && !confirm(t('profileConfirmOverwrite', { name: trimmedName }))) return;

    const env = collectEditorEnv();
    await root.api.request('/api/env-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmedName, env }),
    });
    addSystemMsg(t('profileSaved', { name: trimmedName }));
    hideEnvProfileSavePicker();
    await loadEnvProfiles();
    const nextSel = document.getElementById('profile-select');
    if (nextSel) nextSel.value = trimmedName;
  }

  async function deleteSelectedProfile() {
    const sel = document.getElementById('profile-select');
    const name = sel ? sel.value : '';
    if (!name) return;
    if (!confirm(t('profileConfirmDelete', { name }))) return;
    await root.api.request('/api/env-profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    addSystemMsg(t('profileDeleted', { name }));
    await loadEnvProfiles();
  }

  function renderEnvPasteSection() {
    const container = document.getElementById('env-paste-section');
    if (!container) return;
    container.innerHTML = `
      <div class="env-paste-section">
        <div class="env-paste-toggle">${esc(t('pasteJson'))}</div>
        <div class="env-paste-body">
          <textarea class="env-paste-textarea" placeholder='{"KEY": "value", ...}'></textarea>
          <button class="env-paste-apply">${esc(t('pasteJsonApply'))}</button>
        </div>
      </div>
    `;
    const toggle = container.querySelector('.env-paste-toggle');
    const body = container.querySelector('.env-paste-body');
    toggle.onclick = () => {
      toggle.classList.toggle('open');
      body.classList.toggle('open');
    };
    container.querySelector('.env-paste-apply').onclick = applyPastedJson;
  }

  function applyPastedJson() {
    const ta = document.querySelector('.env-paste-textarea');
    if (!ta) return;
    const raw = ta.value.trim();
    if (!raw) return;
    try {
      const obj = JSON.parse(raw);
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('not object');
      const env = {};
      for (const [k, v] of Object.entries(obj)) env[k] = String(v);
      renderEnvEditor(env);
      renderEnvPasteSection();
      ta.value = '';
      addSystemMsg(t('pasteJsonApplied'));
    } catch (e) {
      addSystemMsg(t('pasteJsonError'));
    }
  }

  root.config = {
    loadConfig,
  };
})();
