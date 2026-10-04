function appendText(parent, tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function formatAge(timestamp) {
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age < 0) return 'baru saja';
  const minutes = Math.floor(age / 60000);
  if (minutes < 1) return 'baru saja';
  if (minutes < 60) return `${minutes} menit lalu`;
  return `${Math.floor(minutes / 60)} jam lalu`;
}

const ICONS = {
  'worker.hired': '✨',
  'worker.exited': '🚪',
  'worker.status': '🔔',
  'task.queued': '📋',
  'task.done': '✅',
  'task.failed': '❌',
  'pr.merged': '🎉',
};

const LABELS = {
  'worker.hired': 'Worker dihire',
  'worker.exited': 'Worker keluar',
  'worker.status': 'Status worker',
  'task.queued': 'Task masuk antrian',
  'task.done': 'Task selesai',
  'task.failed': 'Task gagal',
  'pr.merged': 'PR merged',
};

function renderActivity(body, data) {
  body.replaceChildren();
  if (!data?.result?.length) {
    appendText(body, 'p', 'Tidak ada aktivitas.', 'empty');
    return;
  }

  for (const floor of data.result) {
    const acts = floor.activity || [];
    if (!acts.length) continue;

    const floorCard = document.createElement('details');
    floorCard.className = 'activity-floor';
    floorCard.open = true;

    const summary = document.createElement('summary');
    appendText(summary, 'strong', floor.name);
    floorCard.append(summary);

    const list = document.createElement('ul');
    list.className = 'activity-list';
    for (const act of acts.slice().reverse()) {
      const row = document.createElement('li');
      row.className = 'activity-row';
      const icon = ICONS[act.type] || '📌';
      const label = LABELS[act.type] || act.type;
      const detail = act.detail || {};
      const meta = [];
      if (detail.name) meta.push(detail.name);
      if (detail.title) meta.push(detail.title);
      if (detail.status) meta.push(detail.status);
      if (detail.number) meta.push(`#${detail.number}`);
      const text = `${icon} ${label}${meta.length ? ': ' + meta.join(', ') : ''} — ${formatAge(act.at)}`;
      row.textContent = text;
      list.append(row);
    }
    floorCard.append(list);
    body.append(floorCard);
  }
}

async function showActivity() {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const modal = document.createElement('section');
  modal.className = 'modal';
  modal.setAttribute('aria-label', 'Activity timeline');
  const header = document.createElement('header');
  appendText(header, 'h2', '📜 Activity timeline');
  const refresh = document.createElement('button');
  refresh.className = 'btn';
  refresh.type = 'button';
  refresh.textContent = 'Refresh';
  const closeButton = document.createElement('button');
  closeButton.className = 'btn close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '✕';
  header.append(refresh, closeButton);
  const body = document.createElement('div');
  body.className = 'body';
  body.setAttribute('aria-live', 'polite');
  modal.append(header, body);
  backdrop.append(modal);
  document.body.append(backdrop);

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
  const load = async () => {
    refresh.disabled = true;
    body.replaceChildren();
    appendText(body, 'p', 'Memuat aktivitas…', 'empty');
    try {
      const response = await fetch('/api/hermes/activity', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
      renderActivity(body, data);
    } catch (error) {
      body.replaceChildren();
      appendText(body, 'p', `Gagal membaca aktivitas: ${error.message}`, 'empty');
    } finally {
      refresh.disabled = false;
    }
  };
  closeButton.addEventListener('click', close);
  refresh.addEventListener('click', load);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  closeButton.focus();
  await load();
}

function bindActivityButton() {
  const button = document.getElementById('btn-activity');
  if (!button || button.dataset.activityBound) return;
  button.dataset.activityBound = '1';
  button.addEventListener('click', showActivity);
}

bindActivityButton();
window.addEventListener('DOMContentLoaded', bindActivityButton, { once: true });