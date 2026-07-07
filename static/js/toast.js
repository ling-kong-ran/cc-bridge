(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getToastContainer(options = {}) {
    return options.toastContainer || document.getElementById('toast-container');
  }

  function showToast(msg, type = 'info', duration = 3000, options = {}) {
    const toastContainer = getToastContainer(options);
    if (!toastContainer) return null;
    const icon = { success: '✓', error: '✗', warning: '!', info: 'i' }[type] || 'i';
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${msg}</span><button class="toast-close">&times;</button>`;
    toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
    toast.addEventListener('mouseenter', () => { if (toast._timer) clearTimeout(toast._timer); });
    toast.addEventListener('mouseleave', () => { toast._timer = setTimeout(() => dismissToast(toast), 2000); });
    toastContainer.appendChild(toast);
    toast._timer = setTimeout(() => dismissToast(toast), duration);
    const activeToasts = Array.from(toastContainer.children).filter(item => !item._dismissing);
    activeToasts.slice(0, Math.max(0, activeToasts.length - 5)).forEach(dismissToast);
    return toast;
  }

  function dismissToast(toast) {
    if (!toast || toast._dismissing) return;
    toast._dismissing = true;
    if (toast._timer) {
      clearTimeout(toast._timer);
      toast._timer = null;
    }
    toast.classList.add('dismissing');
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 200);
  }

  root.toast = {
    showToast,
    dismissToast,
  };
})();
