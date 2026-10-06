import type { ProposalClientMsg } from '../../../shared/protocol.js';
import type { HandlerMap, ViewPieces } from './types.js';
import { here } from './common.js';

export function proposalTaskResult(floor: import('../../floor.js').Floor, proposalId: string, proposalTaskId: string, outcome: 'done' | 'failed', error?: string) {
  floor.proposals.markTask(proposalId, proposalTaskId, outcome, error);
}

export const proposalsView: ViewPieces['proposals'] = (_ctx, floor) => ({
  proposals: floor?.proposals.list() ?? [],
  roles: floor?.roles.choices() ?? [],
});

export const proposalHandlers = {
  'proposal.create'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    if (typeof msg.title !== 'string' || typeof msg.input !== 'string') return ctx.warn(c, 'Proposal title and input are required');
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
    const err = floor.proposals.approve(msg.proposalId, c.accountId ?? c.peer.name, ctx.meOf(c.accountId).admin);
    if (err) return ctx.warn(c, err);
    const proposal = floor.proposals.list().find((p) => p.id === msg.proposalId);
    if (proposal?.status === 'approved') {
      for (const task of proposal.tasks) {
        if (task.status === 'assigned' || task.status === 'done') continue;
        const queueErr = floor.queue.add(task.prompt, proposal.createdBy, proposal.title, task.id === '1' ? proposal.issue : undefined, undefined, undefined, undefined, undefined, task.role, proposal.id, task.id);
        if (queueErr && !queueErr.includes('already queued')) {
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
    const err = floor.proposals.reject(msg.proposalId, c.accountId ?? c.peer.name, ctx.meOf(c.accountId).admin, typeof msg.reason === 'string' ? msg.reason : undefined);
    if (err) return ctx.warn(c, err);
    ctx.toFloor(floor, { t: 'proposals', state: { proposals: floor.proposals.list() }, roles: floor.roles.choices() });
  },
} satisfies HandlerMap<ProposalClientMsg>;
