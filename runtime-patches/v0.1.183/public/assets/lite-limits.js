function formatReset(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ''
    : `reset ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function appendText(parent, tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function renderEmpty(body, text) {
  body.replaceChildren();
  appendText(body, 'p', text, 'empty');
}

function renderLimits(body, data) {
  const limits = data?.limits || {};
  const windows = Array.isArray(limits.details) && limits.details.length
    ? limits.details
    : Array.isArray(limits.windows)
      ? limits.windows
      : [];
  const providers = new Map();
  const usage = [];

  for (const window of windows) {
    if (window?.kind === 'usage-summary') {
      usage.push(window);
      continue;
    }
    const provider = String(window?.provider || 'Claude');
    const list = providers.get(provider) || [];
    list.push(window);
    providers.set(provider, list);
  }

  body.replaceChildren();

  if (!providers.size && !usage.length) {
    renderEmpty(body, 'Tidak ada limit aktif.');
    return;
  }

  if (providers.size) {
    appendText(body, 'h3', 'Quota', 'limits-section-title');
  }

  for (const [provider, items] of providers) {
    const details = document.createElement('details');
    details.className = 'limit-provider';

    const summary = document.createElement('summary');
    const quotaItems = items.filter((item) => item?.kind !== 'usage-summary');
    const availableItems = quotaItems.filter((item) => {
      const used = Number(item?.usedPct ?? item?.pct);
      return item?.quotaAvailable !== false && Number.isFinite(used);
    });
    const peakUsed = Math.max(
      ...availableItems.map((item) => Number(item.usedPct ?? item.pct)),
      0
    );
    const summaryText = availableItems.length
      ? `Sisa ${Math.round(Math.max(0, 100 - peakUsed))}%`
      : 'Quota tidak tersedia';
    const reset = quotaItems
      .map((item) => Number(item?.resetsAt))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];

    appendText(summary, 'strong', provider);
    appendText(
      summary,
      'b',
      `${summaryText} · ${availableItems.length}/${quotaItems.length}`
    );
    if (reset) appendText(summary, 'small', formatReset(reset));
    details.append(summary);

    const list = document.createElement('ul');
    list.className = 'limit-details';
    for (const item of quotaItems) {
      const row = document.createElement('li');
      const used = Number(item?.usedPct ?? item?.pct);
      const hasQuota = item?.quotaAvailable !== false && Number.isFinite(used);
      const remaining = Number(
        item?.remainingPct ?? (hasQuota ? 100 - used : NaN)
      );
      const name = item?.label || 'Window';
      const connection = item?.connection ? `${item.connection}: ` : '';
      const resetText = formatReset(item?.resetsAt);
      const source = item?.source ? ` · ${item.source}` : '';

      row.textContent = hasQuota
        ? `${connection}${name}: sisa ${Math.round(Math.max(0, remaining))}%, ` +
          `terpakai ${Math.round(Math.max(0, used))}%` +
          (resetText ? `, ${resetText}` : '')
        : `${connection}${name}: quota tidak tersedia${source}`;
      list.append(row);
    }
    details.append(list);
    body.append(details);
  }

  if (usage.length) {
    appendText(body, 'h3', 'Pemakaian hari ini', 'limits-section-title');
    const usageList = document.createElement('ul');
    usageList.className = 'limit-details';
    for (const item of usage) {
      const row = document.createElement('li');
      const tokens = Number(item?.tokens);
      const tokenText = Number.isFinite(tokens)
        ? `${tokens.toLocaleString()} token`
        : item?.label || 'Token tidak tersedia';
      row.textContent = `${item?.provider || '9Router'}: ${tokenText} (bukan quota)`;
      usageList.append(row);
    }
    body.append(usageList);
  }
}

async function loadLimits(body, refresh) {
  refresh.disabled = true;
  renderEmpty(body, 'Memuat limits…');
  try {
    const response = await fetch('/api/hermes/limits', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    renderLimits(body, data);
  } catch (error) {
    renderEmpty(body, `Gagal membaca limits: ${error.message}`);
  } finally {
    refresh.disabled = false;
  }
}

function showLimits() {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';

  const modal = document.createElement('section');
  modal.className = 'modal limits-modal';
  modal.setAttribute('aria-label', 'Limits');

  const header = document.createElement('header');
  appendText(header, 'h2', '📊 Limits');

  const refresh = document.createElement('button');
  refresh.className = 'btn';
  refresh.type = 'button';
  refresh.textContent = 'Refresh';
  header.append(refresh);

  const closeButton = document.createElement('button');
  closeButton.className = 'btn close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '✕';
  header.append(closeButton);

  const body = document.createElement('div');
  body.className = 'body limits-body';
  body.setAttribute('aria-live', 'polite');

  modal.append(header, body);
  backdrop.append(modal);

  let closed = false;
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };

  closeButton.addEventListener('click', close);
  refresh.addEventListener('click', () => loadLimits(body, refresh));
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  closeButton.focus();
  loadLimits(body, refresh);
}

function bindLimitsButton() {
  const button = document.getElementById('btn-limits');
  if (!button || button.dataset.limitsBound) return;
  button.dataset.limitsBound = '1';
  button.addEventListener('click', showLimits);
}

bindLimitsButton();
window.addEventListener('DOMContentLoaded', bindLimitsButton, { once: true });
