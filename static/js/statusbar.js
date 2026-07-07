(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function renderTopbarStatusSummary(options = {}) {
    const topbarStatusSummary = options.topbarStatusSummary || document.getElementById('topbar-status-summary');
    if (!topbarStatusSummary) return;
    const sidebarCollapsed = !!options.sidebarCollapsed;
    topbarStatusSummary.style.display = sidebarCollapsed ? '' : 'none';
    if (!sidebarCollapsed) return;

    const t = options.t || ((key) => key);
    const topbarConnection = options.topbarConnection || document.getElementById('topbar-connection');
    const topbarCost = options.topbarCost || document.getElementById('topbar-cost');
    const topbarCostValue = options.topbarCostValue || document.getElementById('topbar-cost-value');
    const topbarTokens = options.topbarTokens || document.getElementById('topbar-tokens');
    const topbarTokenValue = options.topbarTokenValue || document.getElementById('topbar-token-value');

    if (topbarConnection) topbarConnection.textContent = options.connectionOnline ? t('connected') : t('connecting');
    if (topbarCost && topbarCostValue) {
      topbarCost.style.display = '';
      topbarCostValue.textContent = options.costText || Number(options.totalCost || 0).toFixed(4);
    }
    if (topbarTokens && topbarTokenValue) {
      topbarTokens.style.display = '';
      topbarTokenValue.textContent = options.tokenText || '0';
    }
  }

  function setSidebarCollapsed(collapsed, options = {}) {
    const nextCollapsed = Boolean(collapsed && options.sessionActive);
    document.body.classList.toggle('sidebar-collapsed', nextCollapsed);
    renderTopbarStatusSummary({ ...options, sidebarCollapsed: nextCollapsed });
    return nextCollapsed;
  }

  root.statusbar = {
    renderTopbarStatusSummary,
    setSidebarCollapsed,
  };
})();
