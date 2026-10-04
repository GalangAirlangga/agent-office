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

function sendAction(message, body) {
  const net = window.__lite?.net;
  if (!net?.send) {
    appendText(body, 'p', 'Koneksi belum siap.', 'health-reason');
    return false;
  }
  const floor = message.t === 'floor.go' ? message.floor : window.__lite?.store?.floor;
  if (floor && message.t !== 'floor.go') message.floor = floor;
  net.send(message);
  return true;
}

function actionButton(parent, label, onClick, disabled = false) {
  const button = document.createElement('button');
  button.className = 'btn health-action';
  button.type = 'button';
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(button);
  });
  parent.append(button);
  return button;
}

function renderWorker(content, worker) {
  const card = document.createElement('div');
  card.className = 'health-worker';
  const heading = document.createElement('div');
  heading.className = 'health-worker-heading';
  appendText(heading, 'strong', worker.name || worker.id || 'Worker');
  appendText(heading, 'span', worker.status || 'unknown', `pill ${worker.status || ''}`);
  card.append(heading);

  const detail = worker.activity || worker.task?.name || worker.title || worker.prompt;
  if (detail) appendText(card, 'p', detail, 'health-worker-detail');

  const actions = document.createElement('div');
  actions.className = 'health-actions';
  const canPrompt = ['starting', 'idle', 'working'].includes(worker.status) && !worker.lost;
  const canResume = ['exited', 'offline'].includes(worker.status);
  actionButton(actions, 'Resume', () => sendAction({ t: 'worker.resume', workerId: worker.id }, card), !canResume);
  actionButton(actions, 'Prompt', () => {
    const prompt = window.prompt(`Prompt untuk ${worker.name || 'worker'}:`);
    if (prompt?.trim()) sendAction({ t: 'worker.prompt', workerId: worker.id, prompt: prompt.trim() }, card);
  }, !canPrompt);
  actionButton(actions, 'PR', () => sendAction({ t: 'worker.pr', workerId: worker.id }, card), !worker.worktree && !worker.pr);
  actionButton(actions, 'Worktree', () => sendAction({ t: 'worker.worktree', workerId: worker.id }, card), !worker.worktree);
  actionButton(actions, 'Send home', () => {
    const name = worker.name || 'worker ini';
    if (!window.confirm(`Kirim ${name} pulang? Proses berhenti. Worktree tetap dipertahankan.`)) return;
    sendAction({ t: 'worker.kill', workerId: worker.id, cleanup: 'keep' }, card);
  }, ['exited', 'offline'].includes(worker.status));
  card.append(actions);
  content.append(card);
}

function renderFailedTask(content, floor, task) {
  const row = document.createElement('div');
  row.className = 'health-task';
  appendText(row, 'span', task.title || task.prompt || task.id || 'Task gagal');
  const sameFloor = window.__lite?.store?.floor === floor.id;
  actionButton(row, 'Retry', () => {
    if (sameFloor) {
      sendAction({ t: 'queue.retry', taskId: task.id }, row);
      return;
    }
    if (!sendAction({ t: 'floor.go', floor: floor.id }, row)) return;
    window.setTimeout(() => sendAction({ t: 'queue.retry', taskId: task.id }, row), 250);
  });
  if (!sameFloor) row.title = 'Pindah ke project ini lalu retry queue.';
  content.append(row);
}

function renderHealth(body, floors) {
  body.replaceChildren();
  if (!floors.length) {
    appendText(body, 'p', 'Tidak ada project.', 'empty');
    return;
  }

  const list = document.createElement('div');
  list.className = 'health-projects';
  for (const floor of floors) {
    const health = floor.health || {};
    const card = document.createElement('details');
    card.className = `health-project health-${health.status || 'idle'}`;

    const summary = document.createElement('summary');
    appendText(summary, 'strong', floor.name || floor.id || 'Project');
    appendText(summary, 'b', health.status || 'idle');
    card.append(summary);

    const content = document.createElement('div');
    content.className = 'health-project-body';
    const workers = health.workers || {};
    const queue = health.queue || {};
    const prs = health.pullRequests || {};
    appendText(content, 'p', `${workers.working || 0} working · ${workers.needsInput || 0} waiting · ${queue.queued || 0} queued`);
    appendText(content, 'p', `${prs.open || 0} PR open · ${prs.review || 0} perlu review`);
    if (health.lastActivityAt) appendText(content, 'p', `Aktivitas ${formatAge(health.lastActivityAt)}`);
    for (const reason of health.reasons || []) appendText(content, 'p', `⚠ ${reason}`, 'health-reason');

      const projectWorkers = Array.isArray(floor.workers) ? floor.workers : [];
    if (projectWorkers.length) {
      appendText(content, 'h3', 'Workers', 'health-section-title');
      for (const worker of projectWorkers) renderWorker(content, worker);
    }

    const failedTasks = Array.isArray(floor.queue)
      ? floor.queue.filter((task) => task.outcome === 'failed' || task.error)
      : [];
    if (failedTasks.length) {
      appendText(content, 'h3', 'Task gagal', 'health-section-title');
      for (const task of failedTasks) renderFailedTask(content, floor, task);
    }
    card.append(content);
    list.append(card);
  }
  body.append(list);
}

async function showHealth() {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const modal = document.createElement('section');
  modal.className = 'modal health-modal';
  modal.setAttribute('aria-label', 'Project health');
  const header = document.createElement('header');
  appendText(header, 'h2', '🏢 Project health');
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
  body.className = 'body health-body';
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
    appendText(body, 'p', 'Memuat status project…', 'empty');
    try {
      const response = await fetch('/api/hermes/status', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
      renderHealth(body, Array.isArray(data.floors) ? data.floors : []);
    } catch (error) {
      body.replaceChildren();
      appendText(body, 'p', `Gagal membaca status: ${error.message}`, 'empty');
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

function bindHealth() {
  const button = document.getElementById('btn-health');
  if (!button || button.dataset.healthBound) return;
  button.dataset.healthBound = '1';
  button.addEventListener('click', showHealth);
}

bindHealth();
window.addEventListener('DOMContentLoaded', bindHealth, { once: true });
