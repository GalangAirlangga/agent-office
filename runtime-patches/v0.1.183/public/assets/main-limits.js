const panel = document.getElementById('limits');

function resetText(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ''
    : `reset ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function render(panel, windows) {
  const groups = new Map();
  for (const item of windows) {
    if (item?.kind === 'usage-summary') continue;
    const provider = String(item?.provider || 'Claude');
    const items = groups.get(provider) || [];
    items.push(item);
    groups.set(provider, items);
  }

  panel.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = 'Limits';
  panel.append(heading);

  if (!groups.size) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Quota tidak tersedia';
    panel.append(empty);
    return;
  }

  for (const [provider, items] of groups) {
    const available = items
      .map((item) => ({ item, used: Number(item?.usedPct ?? item?.pct) }))
      .filter(({ item, used }) => item?.quotaAvailable !== false && Number.isFinite(used));
    const used = Math.max(...available.map(({ used }) => used), 0);
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.className = 'what';
    name.textContent = provider;
    const value = document.createElement('b');
    value.textContent = available.length
      ? `Sisa ${Math.round(Math.max(0, 100 - used))}%`
      : 'Quota tidak tersedia';
    row.append(name, value);

    const reset = items
      .map((item) => Number(item?.resetsAt))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (reset) {
      const resetNode = document.createElement('small');
      resetNode.className = 'reset';
      resetNode.textContent = resetText(reset);
      row.append(resetNode);
    }
    panel.append(row);
  }
}

async function load() {
  try {
    const response = await fetch('/api/hermes/limits', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    const limits = data.limits || {};
    const windows = Array.isArray(limits.details) && limits.details.length
      ? limits.details
      : Array.isArray(limits.windows)
        ? limits.windows
        : [];
    render(panel, windows);
  } catch {
    render(panel, []);
  }
}

if (panel) {
  let loading = false;

  async function reload() {
    if (loading) return;
    loading = true;
    try {
      await load();
    } finally {
      loading = false;
    }
  }

  reload();
  window.setInterval(reload, 120000);
}
