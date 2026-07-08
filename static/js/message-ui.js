(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || ((str) => String(str || '')),
      formatMessage: options.formatMessage || root.i18n?.formatMessage || ((item) => String(item?.message || item?.error || item || '')),
      quoteDisplayText: options.quoteDisplayText || ((entry) => String(entry?.text || entry || '')),
      scrollToBottom: options.scrollToBottom || (() => {}),
      messagesEl: options.messagesEl || document.getElementById('chat-messages'),
    };
  }

  function createAssistantBubble(streaming = true, options = {}) {
    const ctx = getContext(options);
    const el = document.createElement('div');
    el.className = streaming ? 'message assistant streaming' : 'message assistant';
    el.innerHTML = `
      <div class="avatar assistant-avatar">C</div>
      <div class="msg-bubble">
        <div class="stream-status"><span class="stream-dot"></span><span>${ctx.esc(ctx.t('streamingReply'))}</span></div>
        <div class="msg-content"></div>
        <div class="msg-meta"></div>
        <button class="msg-quote-btn" type="button" title="${ctx.esc(ctx.t('quoteMessage'))}" aria-label="${ctx.esc(ctx.t('quoteMessage'))}">${ctx.esc(ctx.t('quoteMessage'))}</button>
      </div>
    `;
    ctx.messagesEl?.appendChild(el);
    return el;
  }

  function finishAssistantStreaming(el) {
    if (el) el.classList.remove('streaming');
  }

  function removePendingAssistantBubble(el, keepBubble) {
    finishAssistantStreaming(el);
    if (!keepBubble && el && !el.querySelector('.msg-content')?.textContent.trim()) {
      el.remove();
    }
  }

  function addUserMessage(text, quotes = [], options = {}) {
    const ctx = getContext(options);
    const el = document.createElement('div');
    el.className = 'message user';
    const quoteHtml = quotes.length ? `
      <div class="msg-quoted-list">
        ${quotes.map(q => `<div class="msg-quoted-item">${ctx.esc(ctx.quoteDisplayText(q))}</div>`).join('')}
      </div>
    ` : '';
    el.innerHTML = `
      <div class="avatar user-avatar">U</div>
      <div class="msg-bubble">
        <div class="msg-content">${quoteHtml}${ctx.esc(text)}</div>
        <button class="msg-quote-btn" type="button" title="${ctx.esc(ctx.t('quoteMessage'))}" aria-label="${ctx.esc(ctx.t('quoteMessage'))}">${ctx.esc(ctx.t('quoteMessage'))}</button>
      </div>
    `;
    ctx.messagesEl?.appendChild(el);
    ctx.scrollToBottom();
    return el;
  }

  function addSystemMsg(text, isError, options = {}) {
    const ctx = getContext(options);
    const el = document.createElement('div');
    el.className = `system-msg${isError ? ' error' : ''}`;
    el.textContent = text;
    ctx.messagesEl?.appendChild(el);
    ctx.scrollToBottom();
    return el;
  }

  function renderContextTrace(trace = {}, options = {}) {
    const ctx = getContext(options);
    const injected = Array.isArray(trace.injected) ? trace.injected : [];
    if (!injected.length) return null;
    const el = document.createElement('div');
    el.className = 'context-trace';
    const usedTokens = Number(trace.used_tokens || 0);
    const skipped = Array.isArray(trace.skipped) ? trace.skipped : [];
    const compressedCount = injected.filter(item => item.compressed).length;
    const summaryParts = [ctx.t('contextTraceSummary', { count: injected.length, tokens: usedTokens })];
    if (compressedCount) summaryParts.push(ctx.t('contextTraceCompressedSummary', { count: compressedCount }));
    el.innerHTML = `
      <details open>
        <summary>${ctx.esc(summaryParts.join(' · '))}</summary>
        <div class="context-trace-body">
          ${injected.map(item => {
            const meta = [item.source || '', item.path || ''].filter(Boolean).join(' · ');
            const badges = [
              item.compressed ? ctx.t('contextTraceCompressed') : '',
              item.tokens ? ctx.t('contextTraceTokens', { tokens: item.tokens }) : '',
            ].filter(Boolean).join(' · ');
            return `
              <div class="context-trace-item">
                <div class="context-trace-title">${ctx.esc(item.title || item.path || item.id || ctx.t('contextTraceFallbackTitle'))} <span>${ctx.esc(String(item.score ?? ''))}</span></div>
                <div class="context-trace-path">${ctx.esc(meta)}</div>
                ${badges ? `<div class="context-trace-meta">${ctx.esc(badges)}</div>` : ''}
                <div class="context-trace-reason">${ctx.esc(item.reason || '')}</div>
              </div>
            `;
          }).join('')}
          ${skipped.length ? `<div class="context-trace-skipped">${ctx.esc(ctx.t('contextTraceSkipped', { count: skipped.length, items: skipped.slice(0, 3).map(item => item.title || item.path || item.reason).join('、') }))}</div>` : ''}
          ${Array.isArray(trace.errors) && trace.errors.length ? `<div class="context-trace-skipped">${ctx.esc(trace.errors.slice(0, 3).map(item => ctx.formatMessage(item)).join('、'))}</div>` : ''}
        </div>
      </details>
    `;
    ctx.messagesEl?.appendChild(el);
    ctx.scrollToBottom();
    return el;
  }

  root.messageUi = {
    createAssistantBubble,
    finishAssistantStreaming,
    removePendingAssistantBubble,
    addUserMessage,
    addSystemMsg,
    renderContextTrace,
  };
})();
