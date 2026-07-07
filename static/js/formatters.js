(function () {
  const root = window.CCBridge = window.CCBridge || {};

  function summarizePrompt(text, maxLen = 90) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
  }

  function formatDuration(ms, t = (key) => key) {
    const seconds = Math.round(Number(ms || 0) / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return t('notifyDurationSeconds', { seconds });
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? t('notifyDurationMinutesSeconds', { minutes, seconds: rest }) : t('notifyDurationMinutes', { minutes });
  }

  function formatCompactDuration(ms) {
    const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }

  function formatUsd(value, t = (key) => key) {
    const cost = Number(value || 0);
    if (!Number.isFinite(cost) || cost <= 0) return '';
    return t('notifyCost', { cost: cost.toFixed(4) });
  }

  function getProjectName(cwd, fallback = '') {
    if (!cwd) return fallback;
    const normalized = cwd.replace(/[\\\/]+$/, '');
    const parts = normalized.split(/[\\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || normalized || fallback;
  }

  function emptyTokenUsage() {
    return { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
  }

  function readTokenField(value, ...keys) {
    for (const key of keys) {
      const n = Number(value[key] || 0);
      if (Number.isFinite(n) && n > 0) return Math.trunc(n);
    }
    return 0;
  }

  function normalizeTokenUsage(value) {
    const usage = emptyTokenUsage();
    if (!value || typeof value !== 'object') return usage;
    usage.input = readTokenField(value, 'input', 'input_tokens');
    usage.output = readTokenField(value, 'output', 'output_tokens');
    usage.cache_creation = readTokenField(value, 'cache_creation', 'cache_creation_input_tokens', 'cache_creation_tokens');
    usage.cache_read = readTokenField(value, 'cache_read', 'cache_read_input_tokens', 'cache_read_tokens');
    return usage;
  }

  function addTokenUsage(a, b) {
    const left = normalizeTokenUsage(a);
    const right = normalizeTokenUsage(b);
    return {
      input: left.input + right.input,
      output: left.output + right.output,
      cache_creation: left.cache_creation + right.cache_creation,
      cache_read: left.cache_read + right.cache_read,
    };
  }

  function tokenUsageTotal(usage) {
    const value = normalizeTokenUsage(usage);
    return value.input + value.output + value.cache_creation + value.cache_read;
  }

  function hasTokenUsage(usage) {
    return tokenUsageTotal(usage) > 0;
  }

  function formatTokenCount(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(Math.trunc(n));
  }

  function formatTokenUsage(usage, t = (key, vars = {}) => vars.count || key) {
    const value = normalizeTokenUsage(usage);
    const main = value.input + value.output;
    const cache = value.cache_creation + value.cache_read;
    const parts = [];
    if (main > 0) parts.push(formatTokenCount(main));
    if (cache > 0) parts.push(t('cachedTokens', { count: formatTokenCount(cache) }));
    return parts.join(' · ') || '0';
  }

  function safeJsonParse(text, fallback = null) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return fallback;
    }
  }

  function formatModelName(model) {
    model = (model || '').trim();
    if (!model) return '';
    const names = {
      'claude-opus-4-6': 'Opus 4.6',
      'claude-sonnet-4-6': 'Sonnet 4.6',
      'claude-haiku-4-6': 'Haiku 4.6',
    };
    return names[model] || model.replace(/^claude-/, '');
  }

  function isDisplayableModel(model) {
    const value = (model || '').trim();
    return Boolean(value && !/^<[^>]+>$/.test(value));
  }

  function getDisplayModelName(model, selectedModel = '') {
    if (isDisplayableModel(model)) return formatModelName(model);
    return isDisplayableModel(selectedModel) ? formatModelName(selectedModel) : '';
  }

  root.formatters = {
    summarizePrompt,
    formatDuration,
    formatCompactDuration,
    formatUsd,
    getProjectName,
    emptyTokenUsage,
    normalizeTokenUsage,
    readTokenField,
    addTokenUsage,
    hasTokenUsage,
    tokenUsageTotal,
    formatTokenUsage,
    formatTokenCount,
    safeJsonParse,
    formatModelName,
    isDisplayableModel,
    getDisplayModelName,
  };
})();
