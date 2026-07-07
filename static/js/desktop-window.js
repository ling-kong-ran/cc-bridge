(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function initDesktopWindowControls(options = {}) {
    const btnDesktopClose = options.btnDesktopClose || document.getElementById('btn-desktop-close');
    const desktop = options.desktop || window.ccBridgeDesktop;
    if (!btnDesktopClose || !desktop) return;
    btnDesktopClose.style.display = '';
    btnDesktopClose.addEventListener('click', () => {
      desktop.closeWindow();
    });
  }

  root.desktopWindow = {
    initDesktopWindowControls,
  };
})();
