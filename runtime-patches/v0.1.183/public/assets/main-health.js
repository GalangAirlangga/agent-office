// Health ringkas per project di sidebar 3D.
// Memakai WebSocket store yang sudah ada di window.__3d.store
// dan fetch /api/hermes/status sebagai fallback bila store belum siap.

const PANEL_ID = 'health-3d';
const STATUS_ICON = { healthy: '✅', attention: '⚠️', blocked: '🔴', idle: '💤' };
const STATUS_LABEL = { healthy: 'sehat', attention: 'perhatian', blocked: 'macet', idle: 'idle' };

function formatAge(timestamp) {
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age < 0) return '';
  const minutes = Math.floor(age / 60000);
  if (minutes < 1) return 'baru saja';
  if (minutes < 60) return `${minutes}m lalu`;
  return `${Math.floor(minutes / 60)}j lalu`;
}

function renderHealth(panel, floors) {
  panel.replaceChildren();

  const h3 = document.createElement('h3');
  h3.textContent = 'Project health';
  panel.append(h3);

  if (!floors.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Tidak ada project';
    panel.append(empty);
    return;
  }

  for (const floor of floors) {
    const health = floor.health || {};
    const workers = health.workers || {};
    const queue = health.queue || {};
    const prs = health.pullRequests || {};

    const section = document.createElement('div');
    section.className = 'health3-floor';

    // Baris pertama: nama + status icon
    const titleRow = document.createElement('div');
    titleRow.className = 'row';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'what';
    nameSpan.textContent = floor.name || floor.id || 'Project';
    const statusSpan = document.createElement('b');
    const st = health.status || 'idle';
    statusSpan.textContent = `${STATUS_ICON[st] || '⬜'} ${STATUS_LABEL[st] || st}`;
    if (st === 'blocked') statusSpan.style.color = 'var(--bad)';
    if (st === 'attention') statusSpan.style.color = 'var(--warn)';
    titleRow.append(nameSpan, statusSpan);
    section.append(titleRow);

    // Baris ringkas: working · waiting · queued
    const statsRow = document.createElement('div');
    statsRow.className = 'health3-stats';
    const parts = [];
    if (workers.working) parts.push(`${workers.working} kerja`);
    if (workers.needsInput) parts.push(`${workers.needsInput} tunggu`);
    if (queue.queued) parts.push(`${queue.queued} antri`);
    if (prs.review) parts.push(`${prs.review} PR review`);
    if (!parts.length && st === 'idle') parts.push('Tidak ada aktivitas');
    statsRow.textContent = parts.join(' · ');
    section.append(statsRow);

    // Alasan blocker terbaru (max 1 baris)
    const reasons = health.reasons || [];
    if (reasons.length) {
      const reasonEl = document.createElement('div');
      reasonEl.className = 'health3-reason';
      reasonEl.textContent = `⚠ ${reasons[0]}`;
      section.append(reasonEl);
    }

    // Aktivitas terakhir
    if (health.lastActivityAt) {
      const ageEl = document.createElement('div');
      ageEl.className = 'health3-age';
      ageEl.textContent = `Aktivitas ${formatAge(health.lastActivityAt)}`;
      section.append(ageEl);
    }

    panel.append(section);
  }
}

async function loadHealth(panel) {
  try {
    const response = await fetch('/api/hermes/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    renderHealth(panel, Array.isArray(data.floors) ? data.floors : []);
  } catch {
    // Senyap jika gagal — panel limits masih visible
  }
}

function init() {
  // Panel sudah ada di HTML; jika belum, inject setelah #limits
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    const limitsPanel = document.getElementById('limits');
    if (!limitsPanel) return;
    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.className = 'panel limits'; // reuse style yang sama
    panel.title = 'Project health — klik refresh di 2D untuk detail';
    limitsPanel.after(panel);
  }

  let loading = false;
  async function reload() {
    if (loading) return;
    loading = true;
    try {
      await loadHealth(panel);
    } finally {
      loading = false;
    }
  }

  reload();
  // Refresh tiap 60 detik (lebih sering dari limits karena health berubah lebih sering)
  window.setInterval(reload, 60000);

  // Dengarkan event WebSocket jika store tersedia
  function tryHookStore() {
    const store = window.__3d?.store ?? window.__lite?.store;
    if (!store?.on) return;
    store.on('workers', reload);
    store.on('queue', reload);
    store.on('floors', reload);
  }
  tryHookStore();
  window.addEventListener('load', tryHookStore);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
