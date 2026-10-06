import type { ProposalClientMsg } from '../../../shared/protocol.js';
import type { HandlerMap, ViewPieces } from './types.js';
import { here } from './common.js';

export const proposalsView: ViewPieces['proposals'] = (_ctx, floor) => ({
  proposals: floor?.proposals.list() ?? [],
  roles: floor?.roles.choices() ?? [],
});

export const proposalHandlers = {
  'proposal.create'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const role = typeof msg.role === 'string' && msg.role.trim() ? msg.role.trim() : 'dev';
    const input = msg.input.replace(/\r\n?/g, '\n').trim();
    const created = floor.proposals.create({
      source: msg.issue === undefined ? 'user' : 'github-issue',
      sourceKey: msg.issue === undefined ? `user:${c.accountId ?? c.id}:${input}` : `issue:${msg.issue}`,
      ...(msg.issue === undefined ? {} : { issue: msg.issue }),
      title: msg.title,
      input,
      tasks: [{ prompt: input, role }],
      createdBy: c.accountId ?? c.peer.name,
    }, floor.roles.all());
    if (typeof created === 'string') return ctx.warn(c, created);
    ctx.toFloor(floor, { t: 'proposals', state: { proposals: floor.proposals.list() }, roles: floor.roles.choices() });
  },
  'proposal.approve'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const err = floor.proposals.approve(msg.proposalId, c.accountId ?? c.peer.name, c.admin);
    if (err) return ctx.warn(c, err);
    const proposal = floor.proposals.list().find((p) => p.id === msg.proposalId);
    if (proposal?.status === 'approved') {
      for (const task of proposal.tasks) {
        const queueErr = floor.queue.add(task.prompt, proposal.createdBy, proposal.title, proposal.issue, undefined, undefined, undefined, proposal.createdBy, task.role, proposal.id);
        if (queueErr) {
          floor.proposals.fail(msg.proposalId, queueErr);
          return ctx.warn(c, queueErr);
        }
      }
      floor.proposals.complete(msg.proposalId);
    }
    ctx.toFloor(floor, { t: 'proposals', state: { proposals: floor.proposals.list() }, roles: floor.roles.choices() });
  },
  'proposal.reject'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const err = floor.proposals.reject(msg.proposalId, c.accountId ?? c.peer.name, c.admin, msg.reason);
    if (err) return ctx.warn(c, err);
    ctx.toFloor(floor, { t: 'proposals', state: { proposals: floor.proposals.list() }, roles: floor.roles.choices() });
  },
} satisfies HandlerMap<ProposalClientMsg>;
