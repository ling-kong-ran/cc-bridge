(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function setVisible(el, visible, display = '') {
    if (!el) return;
    el.style.display = visible ? display : 'none';
  }

  function isVisible(el) {
    return !!el && el.style.display !== 'none';
  }

  function isDisplay(el, display) {
    return !!el && el.style.display === display;
  }

  function updateStopButton(options = {}) {
    const btnStop = options.btnStop || document.getElementById('btn-stop');
    if (!btnStop) return;
    btnStop.classList.toggle('visible', !!options.isResponding);
    btnStop.disabled = !!options.isViewer;
  }

  root.ui = {
    setVisible,
    isVisible,
    isDisplay,
    updateStopButton,
  };
})();
