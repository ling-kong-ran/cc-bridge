(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let scrollPending = false;
  let followOutput = true;

  function getContext(options = {}) {
    return {
      messagesEl: options.messagesEl || document.getElementById('messages'),
      btnScrollLatest: options.btnScrollLatest || document.getElementById('btn-scroll-latest'),
      requestAnimationFrame: options.requestAnimationFrame || window.requestAnimationFrame.bind(window),
    };
  }

  function isMessagesNearBottom(threshold = 80, options = {}) {
    const el = getContext(options).messagesEl;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }

  function setLatestButtonVisible(visible, options = {}) {
    const btn = getContext(options).btnScrollLatest;
    if (!btn) return;
    btn.hidden = !visible;
  }

  function initMessageAutoScroll(options = {}) {
    const ctx = getContext(options);
    if (!ctx.messagesEl) return;
    ctx.messagesEl.addEventListener('scroll', () => {
      followOutput = isMessagesNearBottom(80, options);
      setLatestButtonVisible(!followOutput, options);
    }, { passive: true });
    ctx.btnScrollLatest?.addEventListener('click', () => {
      scrollToBottom(true, options);
    });
    setLatestButtonVisible(false, options);
  }

  function scrollToBottom(force = false, options = {}) {
    const ctx = getContext(options);
    if (!ctx.messagesEl) return;
    if (!force && !followOutput) {
      setLatestButtonVisible(true, options);
      return;
    }
    if (scrollPending) return;
    scrollPending = true;
    ctx.requestAnimationFrame(() => {
      ctx.messagesEl.scrollTo({ top: ctx.messagesEl.scrollHeight, behavior: force ? 'smooth' : 'instant' });
      followOutput = true;
      setLatestButtonVisible(false, options);
      scrollPending = false;
    });
  }

  root.messageScroll = {
    isMessagesNearBottom,
    initMessageAutoScroll,
    scrollToBottom,
  };
})();
