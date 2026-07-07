(function () {
  const root = window.CCBridge = window.CCBridge || {};
  let quotedMessages = [];

  function getContext(options = {}) {
    return {
      t: options.t || ((key) => key),
      esc: options.esc || ((str) => String(str || '')),
      setVisible: options.setVisible || ((el, visible, display = '') => { if (el) el.style.display = visible ? display : 'none'; }),
      addSystemMsg: options.addSystemMsg || (() => {}),
      showPage: options.showPage || (() => {}),
      domText: options.domText || ((el) => (el?.querySelector?.('.msg-content') || el)?.textContent?.trim() || ''),
      getMessagesEl: options.getMessagesEl || (() => options.messagesEl || document.getElementById('messages')),
      getInputEl: options.getInputEl || (() => options.inputEl || document.getElementById('message-input')),
      getQuotePreviewBar: options.getQuotePreviewBar || (() => options.quotePreviewBar || document.getElementById('quote-preview-bar')),
    };
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
  }

  async function copyConversationMarkdown(options = {}) {
    const ctx = getContext(options);
    const markdown = buildConversationMarkdown(options);
    if (!markdown) {
      ctx.addSystemMsg(ctx.t('nothingToExport'), true);
      return;
    }
    try {
      await copyText(markdown);
      ctx.addSystemMsg(ctx.t('markdownCopied'));
    } catch (e) {
      ctx.addSystemMsg(ctx.t('copyFailed'), true);
    }
  }

  function buildConversationMarkdown(options = {}) {
    const ctx = getContext(options);
    const messagesEl = ctx.getMessagesEl();
    const lines = [];
    messagesEl?.querySelectorAll('.message, .system-msg').forEach(el => {
      if (el.classList.contains('user')) {
        lines.push(`## User\n\n${ctx.domText(el)}`);
      } else if (el.classList.contains('assistant')) {
        lines.push(`## Assistant\n\n${ctx.domText(el)}`);
      } else if (el.classList.contains('system-msg')) {
        lines.push(`> ${ctx.domText(el).replace(/\n/g, '\n> ')}`);
      }
    });
    return lines.filter(Boolean).join('\n\n');
  }

  function domText(el) {
    return (el?.querySelector?.('.msg-content') || el)?.textContent?.trim() || '';
  }

  function hideMsgContextMenu() {
    const menu = document.getElementById('msg-context-menu');
    if (menu) { menu.style.display = 'none'; menu.style.visibility = 'hidden'; }
  }

  function normalizeQuoteEntry(entry) {
    if (entry && typeof entry === 'object') {
      return {
        type: entry.type || 'text',
        text: String(entry.text || entry.display || '').trim(),
        path: entry.path || '',
        lines: Array.isArray(entry.lines) ? entry.lines.map(n => Number(n)).filter(Boolean) : [],
      };
    }
    return { type: 'text', text: String(entry || '').trim(), path: '', lines: [] };
  }

  function quoteDisplayText(entry) {
    const quote = normalizeQuoteEntry(entry);
    return quote.text;
  }

  function quoteIntoInput(text, meta = null, options = {}) {
    const ctx = getContext(options);
    const normalized = (text || '').trim();
    if (!normalized) return;
    quotedMessages.push(normalizeQuoteEntry({ ...(meta || {}), text: normalized }));
    ctx.showPage('chat');
    requestAnimationFrame(() => {
      renderQuotePreview(options);
      ctx.getQuotePreviewBar()?.scrollIntoView({ block: 'nearest' });
      ctx.getInputEl()?.focus();
    });
  }

  function renderQuotePreview(options = {}) {
    const ctx = getContext(options);
    const quotePreviewBar = ctx.getQuotePreviewBar();
    if (!quotePreviewBar) return;
    if (quotedMessages.length === 0) {
      ctx.setVisible(quotePreviewBar, false);
      quotePreviewBar.innerHTML = '';
      return;
    }
    ctx.setVisible(quotePreviewBar, true, 'flex');
    quotePreviewBar.innerHTML = quotedMessages.map((quote, i) => `
      <div class="quote-preview-item">
        <div class="quote-preview-head">
          <span>${ctx.esc(ctx.t('quotedMessage'))}</span>
          <button class="quote-preview-remove" data-idx="${i}" title="${ctx.esc(ctx.t('removeQuote'))}" type="button">&times;</button>
        </div>
        <div class="quote-preview-text">${ctx.esc(quoteDisplayText(quote))}</div>
      </div>
    `).join('');
    quotePreviewBar.querySelectorAll('.quote-preview-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        quotedMessages.splice(parseInt(btn.dataset.idx), 1);
        renderQuotePreview(options);
      });
    });
  }

  function initMessageContextMenu(options = {}) {
    const ctx = getContext(options);
    const menu = document.getElementById('msg-context-menu');
    menu?.remove();

    const messagesEl = ctx.getMessagesEl();
    messagesEl?.addEventListener('click', (e) => {
      const quoteBtn = e.target.closest('.msg-quote-btn');
      if (!quoteBtn) return;
      const msgEl = quoteBtn.closest('.message');
      const text = ctx.domText(msgEl);
      if (text) quoteIntoInput(text, null, options);
    });
  }

  function quotePayloadForBackend(quotes = quotedMessages) {
    return quotes.map(normalizeQuoteEntry).filter(q => q.text || (q.path && q.lines.length));
  }

  function quoteBackendPayload(quotes = quotedMessages) {
    return quotes.map(normalizeQuoteEntry).map(q => {
      if (q.type === 'file_lines' && q.path && q.lines.length) {
        return { type: 'file_lines', path: q.path, lines: q.lines };
      }
      return { type: 'text', text: q.text };
    }).filter(q => q.text || (q.path && q.lines?.length));
  }

  function getQuotedMessages() {
    return quotedMessages.slice();
  }

  function setQuotedMessages(next) {
    quotedMessages = Array.from(next || []).map(normalizeQuoteEntry);
    return getQuotedMessages();
  }

  function clearQuotedMessages(options = {}) {
    quotedMessages = [];
    renderQuotePreview(options);
  }

  root.messageExtras = {
    copyConversationMarkdown,
    buildConversationMarkdown,
    domText,
    hideMsgContextMenu,
    normalizeQuoteEntry,
    quoteDisplayText,
    quoteIntoInput,
    renderQuotePreview,
    initMessageContextMenu,
    quotePayloadForBackend,
    quoteBackendPayload,
    getQuotedMessages,
    setQuotedMessages,
    clearQuotedMessages,
  };
})();
