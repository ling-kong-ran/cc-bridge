(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    const setVisible = options.setVisible || root.ui?.setVisible || ((el, visible, display = '') => {
      if (!el) return;
      el.style.display = visible ? display : 'none';
    });
    const isVisible = options.isVisible || root.ui?.isVisible || ((el) => !!el && el.style.display !== 'none');
    return { setVisible, isVisible };
  }

  function initShortcutsHelp(options = {}) {
    const btnShortcuts = options.btnShortcuts || document.getElementById('btn-shortcuts');
    const shortcutsClose = options.shortcutsClose || document.getElementById('shortcuts-close');
    const shortcutsOverlay = options.shortcutsOverlay || document.getElementById('shortcuts-overlay');
    btnShortcuts?.addEventListener('click', () => openShortcutsHelp(options));
    shortcutsClose?.addEventListener('click', () => closeShortcutsHelp(options));
    shortcutsOverlay?.addEventListener('click', (e) => {
      if (e.target === shortcutsOverlay) closeShortcutsHelp(options);
    });
  }

  function openShortcutsHelp(options = {}) {
    const { setVisible } = getContext(options);
    const shortcutsOverlay = options.shortcutsOverlay || document.getElementById('shortcuts-overlay');
    setVisible(shortcutsOverlay, true, 'flex');
  }

  function closeShortcutsHelp(options = {}) {
    const { setVisible } = getContext(options);
    const shortcutsOverlay = options.shortcutsOverlay || document.getElementById('shortcuts-overlay');
    setVisible(shortcutsOverlay, false);
  }

  function handleGlobalShortcuts(e, options = {}) {
    const { isVisible } = getContext(options);
    const shortcutsOverlay = options.shortcutsOverlay || document.getElementById('shortcuts-overlay');
    if (e.key === 'Escape' && isVisible(shortcutsOverlay)) {
      e.preventDefault();
      options.closeShortcutsHelp?.();
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === '/') {
      e.preventDefault();
      options.openShortcutsHelp?.();
    } else if (key === 'k') {
      e.preventDefault();
      const sessionSearchInput = options.sessionSearchInput || document.getElementById('session-search');
      sessionSearchInput?.focus();
      sessionSearchInput?.select();
    } else if (key === 'n') {
      e.preventDefault();
      options.startNewSession?.();
    } else if (key === 'enter') {
      e.preventDefault();
      options.sendMessage?.();
    } else if (key === '.') {
      e.preventDefault();
      options.interruptCurrentRun?.();
    } else if (key === 'e') {
      e.preventDefault();
      options.copyConversationMarkdown?.();
    }
  }

  root.shortcuts = {
    initShortcutsHelp,
    openShortcutsHelp,
    closeShortcutsHelp,
    handleGlobalShortcuts,
  };
})();
