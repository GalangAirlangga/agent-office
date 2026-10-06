import { h, openModal, toast } from './dom';
import { store } from '../state';
import type { Ctx } from '../core/context';

export function openProposals(ctx: Ctx) {
  const list = h('div', {});
  const render = () => {
    const items = store.proposals.proposals.length ? store.proposals.proposals.map((p) => {
      const approve = h('button.btn.primary', { type: 'button' }, 'Approve');
      const reject = h('button.btn.danger', { type: 'button' }, 'Reject');
      approve.addEventListener('click', () => { ctx.net.send({ t: 'proposal.approve', proposalId: p.id }); toast('Proposal approved'); });
      reject.addEventListener('click', () => { ctx.net.send({ t: 'proposal.reject', proposalId: p.id }); toast('Proposal rejected'); });
      return h('article', {}, h('h3', {}, p.title), h('p', {}, `${p.source} · ${p.status}`), h('p', {}, p.input), h('p', {}, p.tasks.map((t) => `${t.role}: ${t.prompt}`).join('\n')), h('footer', {}, approve, reject));
    }) : [h('p', {}, 'No pending proposals.')];
    list.replaceChildren(...items);
  };
  render();
  const off = store.on('proposals', render);
  const modal = openModal(h('div.modal', { role: 'dialog', 'aria-label': 'PM proposals' }, h('header', {}, h('h2', {}, 'PM proposals')), h('div.body', {}, list)), { onClose: () => off() });
}
