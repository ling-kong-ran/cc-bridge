(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function showPage(page, options = {}) {
    const t = options.t || ((key) => key);
    const sessionActive = !!options.sessionActive;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`page-${page}`);
    if (target) target.classList.add('active');

    const pageLabel = document.getElementById('titlebar-page-label');
    const pageKey = page === 'home' ? 'home' : page === 'config' ? 'settings' : page === 'artifacts' ? 'artifacts' : page === 'scheduled' ? 'scheduledTasks' : page === 'feishu-gateway' ? 'messageGateway' : page === 'sessions' ? 'sessions' : page === 'skills' ? 'skills' : page === 'tools' ? 'tools' : page === 'integrations' ? 'integrations' : page === 'memory' ? 'memory' : 'chat';
    if (pageLabel) pageLabel.textContent = t(pageKey);

    const isChatPage = page === 'chat';
    const backBtn = document.getElementById('btn-titlebar-back');
    if (backBtn) {
      const canBackToChat = page !== 'home' && !isChatPage && sessionActive;
      backBtn.style.display = canBackToChat ? '' : 'none';
      backBtn.textContent = t('backToChat');
    }
    const titlebarMeta = document.getElementById('titlebar-meta');
    if (titlebarMeta) titlebarMeta.style.display = isChatPage ? '' : 'none';
    const btnExport = document.getElementById('btn-export-chat');
    if (btnExport) btnExport.style.display = isChatPage ? '' : 'none';
    const btnPanel = document.getElementById('btn-toggle-right-panel');
    if (btnPanel) btnPanel.style.display = isChatPage ? '' : 'none';
    (options.topbarSessionButtons || []).forEach(btn => {
      if (btn) btn.style.display = 'none';
    });

    if (isChatPage) {
      options.renderTopbarMeta?.();
      options.renderTopbarStatusSummary?.();
    } else if (page === 'sessions') {
      options.renderSessionList?.(options.getCachedSessions?.() || []);
    } else if (page === 'artifacts') {
      options.loadArtifacts?.();
    } else if (page === 'skills') {
      options.loadSkills?.();
    } else if (page === 'tools') {
      options.loadTools?.();
    } else if (page === 'integrations') {
      options.loadIntegrations?.();
    } else if (page === 'memory') {
      options.loadMemoryFiles?.();
    } else if (page === 'scheduled') {
      options.loadScheduledTasks?.();
    } else if (page === 'feishu-gateway') {
      options.loadFeishuGateway?.();
    }
    options.hideMentionPopup?.();
  }

  function initNavigation(options = {}) {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.page === 'chat') {
          options.openLatestOrNewChatSession?.();
          return;
        }
        options.showPage?.(btn.dataset.page);
      });
    });

    document.getElementById('btn-nav-settings')?.addEventListener('click', () => options.showPage?.('config'));
    document.getElementById('btn-titlebar-back')?.addEventListener('click', () => options.showPage?.('chat'));
    document.getElementById('session-search')?.addEventListener('input', () => options.renderSessionList?.(options.getCachedSessions?.() || []));
    document.getElementById('sessions-new-session')?.addEventListener('click', () => {
      options.showPage?.('chat');
      options.startNewSession?.();
    });

    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.config-tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = document.querySelector(`.config-tab-panel[data-tab="${tabName}"]`);
        if (panel) panel.classList.add('active');
      });
    });
  }

  function initMobileLayout() {
    const toggles = document.querySelectorAll('.mobile-menu-toggle');
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.getElementById('mobile-sidebar-backdrop');
    const mobileQuery = window.matchMedia('(max-width: 760px)');

    if (!toggles.length || !sidebar || !backdrop) return;

    const setExpanded = (expanded) => {
      toggles.forEach(toggle => toggle.setAttribute('aria-expanded', String(expanded)));
    };

    const chatSidebar = document.getElementById('chat-sidebar');
    const closeMenu = () => {
      sidebar.classList.remove('mobile-open');
      if (chatSidebar) chatSidebar.classList.remove('open');
      backdrop.classList.remove('visible');
      document.body.classList.remove('mobile-overlay');
      setExpanded(false);
    };

    const openMenu = () => {
      sidebar.classList.add('mobile-open');
      backdrop.classList.add('visible');
      setExpanded(true);
    };

    toggles.forEach(toggle => {
      toggle.addEventListener('click', () => {
        if (sidebar.classList.contains('mobile-open')) {
          closeMenu();
        } else {
          openMenu();
        }
      });
    });

    backdrop.addEventListener('click', closeMenu);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    sidebar.addEventListener('click', (e) => {
      if (!mobileQuery.matches) return;
      if (e.target.closest('.nav-btn, .session-item, #btn-new-session, #welcome-new-session')) closeMenu();
    });

    document.getElementById('welcome-new-session')?.addEventListener('click', () => {
      if (mobileQuery.matches) closeMenu();
    });

    const handleQueryChange = (e) => {
      if (!e.matches) closeMenu();
    };

    if (mobileQuery.addEventListener) {
      mobileQuery.addEventListener('change', handleQueryChange);
    } else {
      mobileQuery.addListener(handleQueryChange);
    }
  }

  root.navigation = {
    showPage,
    initNavigation,
    initMobileLayout,
  };
})();
