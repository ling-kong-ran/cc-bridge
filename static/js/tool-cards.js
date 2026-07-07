(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function toggleToolCard(card, shiftKey = false, options = {}) {
    if (!card) return;
    const rootEl = options.root || document;
    if (shiftKey) {
      const allCards = rootEl.querySelectorAll('.tool-card');
      const anyCollapsed = Array.from(allCards).some(c => c.classList.contains('collapsed'));
      allCards.forEach(c => c.classList.toggle('collapsed', !anyCollapsed));
    } else {
      card.classList.toggle('collapsed');
    }
  }

  function initToolCardInteractions(options = {}) {
    const rootEl = options.root || document;
    rootEl.addEventListener('click', (e) => {
      const toggle = e.target.closest('.tool-toggle');
      if (!toggle) return;
      e.preventDefault();
      const card = toggle.closest('.tool-card');
      if (!card) return;
      toggleToolCard(card, e.shiftKey, { root: rootEl });
    });
    rootEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const toggle = e.target.closest('.tool-toggle');
      if (!toggle) return;
      e.preventDefault();
      const card = toggle.closest('.tool-card');
      if (!card) return;
      toggleToolCard(card, e.shiftKey, { root: rootEl });
    });
  }

  root.toolCards = {
    initToolCardInteractions,
    toggleToolCard,
  };
})();
