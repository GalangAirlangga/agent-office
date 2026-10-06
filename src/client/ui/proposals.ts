import { h, openModal, toast } from './dom';
import { store } from '../state';
import type { Ctx } from '../core/context';

export function openProposals(ctx: Ctx) {
  const list = h('div', {});
  const form = h('form', { style: 'display:grid;gap:8px;margin-bottom:16px' });
  const title = h('input', { type: 'text', required: true, maxlength: 200, placeholder: 'Proposal title', 'aria-label': 'Proposal title' }) as HTMLInputElement;
  const input = h('textarea', { required: true, maxlength: 20000, rows: 4, placeholder: 'What should PM split and assign?', 'aria-label': 'Proposal task' }) as HTMLTextAreaElement;
  const role = h('select', { class: 'proposal-role', 'aria-label': 'Proposal role' }, ...(store.project?.roleChoices ?? []).map((r) => h('option', { value: r.id }, `${r.id}${r.skills.length ? ` · ${r.skills.map((s) => `/${s}`).join(', ')}` : ''}`))) as HTMLSelectElement;
  const submit = h('button.btn.primary', { type: 'submit' }, 'Create proposal');
  form.append(title, input, role, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!title.value.trim() || !input.value.trim()) return;
    ctx.net.send({ t: 'proposal.create', title: title.value.trim(), input: input.value.trim(), role: role.value || undefined });
    toast('Proposal submitted for approval');
    form.reset();
  });
  const render = () => {
    const items = store.proposals.proposals.length ? store.proposals.proposals.map((p) => {
      const action = p.status === 'pending' && store.me.admin ? h('footer', {}, (() => {
        const approve = h('button.btn.primary', { type: 'button' }, 'Approve');
        const reject = h('button.btn.danger', { type: 'button' }, 'Reject');
        approve.addEventListener('click', () => ctx.net.send({ t: 'proposal.approve', proposalId: p.id }));
        reject.addEventListener('click', () => ctx.net.send({ t: 'proposal.reject', proposalId: p.id }));
        return h('span', {}, approve, reject);
      })()) : null;
      return h('article', {}, h('h3', {}, p.title), h('p', {}, `${p.source} · ${p.status}`), h('p', {}, p.input), h('p', {}, p.tasks.map((t) => `${t.role}: ${t.prompt}`).join('\n')), action);
    }) : [h('p', {}, 'No pending proposals.')];
    list.replaceChildren(...items);
  };
  render();
  const off = store.on('proposals', render);
  const modal = openModal(h('div.modal', { role: 'dialog', 'aria-label': 'PM proposals' }, h('header', {}, h('h2', {}, 'PM proposals')), h('div.body', {}, form, list)), { onClose: () => off() });
}
