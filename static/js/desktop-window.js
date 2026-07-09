(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function initDesktopWindowControls(options = {}) {
    const btnDesktopMinimize = options.btnDesktopMinimize || document.getElementById('btn-desktop-minimize');
    const btnDesktopClose = options.btnDesktopClose || document.getElementById('btn-desktop-close');
    const desktop = options.desktop || window.ccBridgeDesktop;
    if (!desktop) return;
    if (btnDesktopMinimize && desktop.minimizeWindow) {
      btnDesktopMinimize.style.display = '';
      btnDesktopMinimize.addEventListener('click', () => {
        desktop.minimizeWindow();
      });
    }
    if (btnDesktopClose && desktop.closeWindow) {
      btnDesktopClose.style.display = '';
      btnDesktopClose.addEventListener('click', () => {
        desktop.closeWindow();
      });
    }
  }

  root.desktopWindow = {
    initDesktopWindowControls,
  };
})();
