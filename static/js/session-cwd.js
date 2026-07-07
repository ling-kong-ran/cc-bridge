(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      openPicker: options.openPicker || (() => {}),
      cwdInput: options.cwdInput || document.getElementById('cwd'),
    };
  }

  function isCwdError(errorMsg) {
    if (!errorMsg) return false;
    return /\u5de5\u4f5c\u76ee\u5f55\u4e0d\u53ef\u7528|director|not exist|find the (file|path)/i.test(errorMsg);
  }

  function promptCwdForSession(oldCwd, options = {}) {
    const ctx = getContext(options);
    return new Promise((resolve) => {
      ctx.openPicker(oldCwd || ctx.cwdInput?.value?.trim() || '/', (selectedPath) => {
        resolve(selectedPath || null);
      });
    });
  }

  async function updateSessionCwd(sessionId, newCwd) {
    try {
      const resp = await fetch('/api/sessions/update-cwd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, cwd: newCwd }),
      });
      return await resp.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  root.sessionCwd = {
    isCwdError,
    promptCwdForSession,
    updateSessionCwd,
  };
})();
