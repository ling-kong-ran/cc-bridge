(function () {
  const root = window.CCBridge = window.CCBridge || {};

  let scrollPending = false;
  let followOutput = true;

  function getContext(options = {}) {
    return {
      messagesEl: options.messagesEl || document.getElementById('messages'),
      requestAnimationFrame: options.requestAnimationFrame || window.requestAnimationFrame.bind(window),
    };
  }

  function isMessagesNearBottom(threshold = 80, options = {}) {
    const el = getContext(options).messagesEl;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }

  function initMessageAutoScroll(options = {}) {
    const ctx = getContext(options);
    if (!ctx.messagesEl) return;
    ctx.messagesEl.addEventListener('scroll', () => {
      followOutput = isMessagesNearBottom(80, options);
    }, { passive: true });
  }

  function scrollToBottom(force = false, options = {}) {
    const ctx = getContext(options);
    if (!ctx.messagesEl) return;
    if (!force && !followOutput) return;
    if (scrollPending) return;
    scrollPending = true;
    ctx.requestAnimationFrame(() => {
      ctx.messagesEl.scrollTo({ top: ctx.messagesEl.scrollHeight, behavior: 'instant' });
      followOutput = true;
      scrollPending = false;
    });
  }

  root.messageScroll = {
    isMessagesNearBottom,
    initMessageAutoScroll,
    scrollToBottom,
  };
})();
