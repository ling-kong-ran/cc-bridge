(function () {
  const root = window.CCBridge = window.CCBridge || {};

  const INITIAL_LIMIT = 5;
  const LAZY_LIMIT = 5;
  const LOAD_MORE_THRESHOLD = 40; // px from top

  // 每个 session 的分页状态，key = sessionId
  const _state = {};

  function getContext(options = {}) {
    return {
      fetch: options.fetch || window.fetch.bind(window),
      console: options.console || window.console,
      messagesEl: options.messagesEl || document.getElementById('messages'),
      getCwd: options.getCwd || (() => ''),
      getAssistantState: options.getAssistantState || (() => ({})),
      setAssistantState: options.setAssistantState || (() => {}),
      resetAssistantStreamState: options.resetAssistantStreamState || (() => {}),
      renderHistory: options.renderHistory || (() => {}),
      prependHistory: options.prependHistory || (() => {}),
      toolResults: options.toolResults || null,
      toolStartTimes: options.toolStartTimes || null,
      captureActiveWorkspaceSnapshot: options.captureActiveWorkspaceSnapshot || (() => {}),
      addSystemMsg: options.addSystemMsg || (() => {}),
    };
  }

  async function fetchSessionHistory(sessionId, cwd, ctx, limit, offset) {
    const resp = await ctx.fetch('/api/sessions/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: cwd || ctx.getCwd() || '',
        limit,
        offset,
      }),
    });
    return resp.json();
  }

  function renderStaticHistory(history, options = {}) {
    const ctx = getContext(options);
    const previous = ctx.getAssistantState();
    ctx.resetAssistantStreamState();
    ctx.renderHistory(history);
    ctx.setAssistantState(previous);
  }

  function _detachScrollListener(el) {
    if (el && el._lazyLoadHandler) {
      el.removeEventListener('scroll', el._lazyLoadHandler);
      el._lazyLoadHandler = null;
    }
  }

  function _initScrollListener(sessionId, cwd, options) {
    const ctx = getContext(options);
    const el = ctx.messagesEl;
    if (!el) return;

    // 移除旧监听器（切换 session 时避免把上一段的懒加载串到新会话）
    _detachScrollListener(el);

    const loadMoreIfNeeded = async function () {
      const s = _state[sessionId];
      if (!s || !s.hasMore || s.loading) return;
      if (el.scrollTop > LOAD_MORE_THRESHOLD) return;

      s.loading = true;
      try {
        const result = await fetchSessionHistory(sessionId, cwd, ctx, LAZY_LIMIT, s.offset);
        const msgs = result.messages || [];
        if (msgs.length === 0) {
          s.hasMore = false;
          return;
        }
        const prevScrollHeight = el.scrollHeight;
        s.offset += msgs.length;
        s.hasMore = result.has_more;
        ctx.prependHistory(msgs, options);

        // 如果首屏仍不满，或插入前后仍贴近顶部，继续补一页。
        // requestAnimationFrame 等 DOM 高度更新后再判断，避免用户必须手动多滚一次。
        const raf = window.requestAnimationFrame || ((fn) => window.setTimeout(fn, 0));
        raf(() => {
          const notScrollable = el.scrollHeight <= el.clientHeight + 4;
          const stillNearTop = el.scrollTop <= LOAD_MORE_THRESHOLD;
          const heightChanged = el.scrollHeight !== prevScrollHeight;
          if (heightChanged && s.hasMore && (notScrollable || stillNearTop)) {
            loadMoreIfNeeded();
          }
        });
      } catch (e) {
        ctx.console.error('懒加载历史消息失败:', e);
      } finally {
        s.loading = false;
      }
    };

    el._lazyLoadHandler = loadMoreIfNeeded;
    el.addEventListener('scroll', el._lazyLoadHandler, { passive: true });

    // 初次渲染后主动检查一次：首屏 5 条不够撑满时，不依赖用户滚动事件。
    const raf = window.requestAnimationFrame || ((fn) => window.setTimeout(fn, 0));
    raf(() => loadMoreIfNeeded());
  }

  async function loadSessionHistory(sessionId, cwd, options = {}) {
    const ctx = getContext(options);
    // 切换会话前先摘掉上一段的懒加载监听，避免旧 handler 把别的会话历史灌进来
    _detachScrollListener(ctx.messagesEl);
    try {
      const result = await fetchSessionHistory(sessionId, cwd, ctx, INITIAL_LIMIT, 0);
      const msgs = result.messages || result; // 兼容旧格式（纯数组）
      const total = result.total ?? msgs.length;
      const hasMore = result.has_more ?? false;

      // 记录分页状态，offset = 已经从末尾取出的条数
      _state[sessionId] = {
        offset: msgs.length,
        hasMore,
        loading: false,
        total,
        cwd,
      };

      if (msgs.length > 0) {
        renderStaticHistory(msgs, options);
      }

      if (hasMore) {
        _initScrollListener(sessionId, cwd, options);
      }
    } catch (e) {
      ctx.console.error('History load failed:', e);
    }
  }

  async function reloadSessionHistory(sessionId, cwd, options = {}) {
    const ctx = getContext(options);
    _detachScrollListener(ctx.messagesEl);
    try {
      const result = await fetchSessionHistory(sessionId, cwd, ctx, INITIAL_LIMIT, 0);
      const msgs = result.messages || result;
      const hasMore = result.has_more ?? false;
      if (!Array.isArray(msgs) || msgs.length === 0) return;

      const systemMessages = Array.from(ctx.messagesEl.querySelectorAll('.system-msg')).map(el => ({
        text: el.textContent || '',
        isError: el.classList.contains('error'),
      }));
      ctx.messagesEl.innerHTML = '';
      ctx.resetAssistantStreamState();
      ctx.toolResults?.clear?.();
      ctx.toolStartTimes?.clear?.();
      renderStaticHistory(msgs, options);
      ctx.captureActiveWorkspaceSnapshot();
      for (const msg of systemMessages) {
        if (msg.text) ctx.addSystemMsg(msg.text, msg.isError);
      }

      _state[sessionId] = {
        offset: msgs.length,
        hasMore,
        loading: false,
        total: result.total ?? msgs.length,
        cwd,
      };

      if (hasMore) {
        _initScrollListener(sessionId, cwd, options);
      }
    } catch (e) {
      ctx.console.error('History reload failed:', e);
    }
  }

  root.historyLoader = {
    renderStaticHistory,
    loadSessionHistory,
    reloadSessionHistory,
  };
})();
