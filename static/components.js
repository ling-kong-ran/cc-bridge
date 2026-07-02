/**
 * cc-bridge UI Components
 * 可复用的 UI 组件工厂，减少 index.html 和 app.js 中的重复代码。
 * 零依赖，纯函数式风格。
 */

// ─── Modal ──────────────────────────────────────────────────────────────
/**
 * 创建或获取一个 modal overlay。
 * @param {string} id - DOM id
 * @returns {{ overlay: HTMLElement, title: HTMLElement, body: HTMLElement, open: ()=>void, close: ()=>void }}
 */
function createModal(id) {
  let overlay = document.getElementById(id);
  if (overlay) {
    return {
      overlay,
      title: overlay.querySelector('.modal-title'),
      body: overlay.querySelector('.modal-body'),
      open() { overlay.style.display = 'flex'; },
      close() { overlay.style.display = 'none'; },
    };
  }
  overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'modal-overlay';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <span class="modal-title"></span>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
  overlay.querySelector('.modal-close').addEventListener('click', () => {
    overlay.style.display = 'none';
  });
  return {
    overlay,
    title: overlay.querySelector('.modal-title'),
    body: overlay.querySelector('.modal-body'),
    open() { overlay.style.display = 'flex'; },
    close() { overlay.style.display = 'none'; },
  };
}

// ─── Toast ──────────────────────────────────────────────────────────────
let _toastTimer = null;
let _toastEl = null;

/**
 * 显示一个 3 秒自动消失的提示。
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function showToast(message, type) {
  type = type || 'info';
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.id = 'cc-toast';
    _toastEl.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 24px;border-radius:8px;font-family:var(--font-mono);font-size:12px;z-index:9999;pointer-events:none;transition:all 0.3s ease;opacity:0;';
    document.body.appendChild(_toastEl);
  }
  clearTimeout(_toastTimer);
  const colors = { success: 'var(--green)', error: 'var(--red)', info: 'var(--text-muted)' };
  _toastEl.style.background = 'var(--bg-card)';
  _toastEl.style.border = '1px solid ' + (colors[type] || colors.info);
  _toastEl.style.color = 'var(--text-bright)';
  _toastEl.textContent = message;
  _toastEl.style.opacity = '1';
  _toastTimer = setTimeout(() => { _toastEl.style.opacity = '0'; }, 3000);
}

// ─── Confirm Dialog ─────────────────────────────────────────────────────
/**
 * 显示一个确认对话框，返回 Promise<boolean>。
 * @param {string} title
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function showConfirm(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '9998';
    overlay.innerHTML = `
      <div class="modal-content" style="max-width:400px">
        <div class="modal-header"><span class="modal-title">${esc(title)}</span></div>
        <div class="modal-body"><p style="margin:0">${esc(message)}</p></div>
        <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:12px 16px">
          <button class="btn-mini btn-cancel" data-i18n="cancel">Cancel</button>
          <button class="btn-mini btn-confirm" style="background:var(--green);color:#fff">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });
    overlay.querySelector('.btn-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('.btn-confirm').addEventListener('click', () => cleanup(true));
  });
}

// ─── Empty State ────────────────────────────────────────────────────────
/**
 * 渲染空状态占位。
 * @param {string} icon - emoji
 * @param {string} title
 * @param {string} hint - optional second line
 * @param {{ label: string, onClick: ()=>void }} action - optional
 * @returns {string} HTML
 */
function renderEmptyState(icon, title, hint, action) {
  const btn = action ? `<button class="btn-mini btn-empty-action">${esc(action.label)}</button>` : '';
  return `<div class="memory-empty-enhanced">
    <div class="empty-icon">${icon || '📂'}</div>
    <div class="empty-title">${esc(title)}</div>
    ${hint ? `<div class="empty-hint">${esc(hint)}</div>` : ''}
    ${btn ? `<div class="memory-empty-actions">${btn}</div>` : ''}
  </div>`;
}

// ─── File Picker (封装) ─────────────────────────────────────────────────
/**
 * 打开文件选择器并返回选中的文件列表。
 * @param {{ mode?: 'files'|'dirs', title?: string }} opts
 * @returns {Promise<Array<{path:string,name:string,source:string}>>}
 */
function pickFiles(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    openFilePicker((items) => {
      resolve(items.filter(item => {
        if (opts.mode === 'dirs') return item.isDir;
        return !item.isDir;
      }));
    });
  });
}

// ─── Search Input (debounced) ──────────────────────────────────────────
/**
 * 为输入框绑定防抖搜索。
 * @param {HTMLInputElement} input
 * @param {(q:string)=>void} callback
 * @param {number} delay - ms
 */
function bindSearch(input, callback, delay) {
  delay = delay || 300;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(input.value.trim()), delay);
  });
}
