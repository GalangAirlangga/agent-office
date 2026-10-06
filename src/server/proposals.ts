import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RoleSpec } from './roles.js';

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'failed' | 'done';
export type ProposalSource = 'user' | 'github-issue';

export interface ProposalTask {
  id: string;
  prompt: string;
  role: string;
  target?: string;
  status: 'pending' | 'assigned' | 'done' | 'failed';
  error?: string;
}

export interface Proposal {
  id: string;
  source: ProposalSource;
  sourceKey: string;
  issue?: number;
  title: string;
  input: string;
  tasks: ProposalTask[];
  status: ProposalStatus;
  createdBy: string;
  approvedBy?: string;
  owner?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProposalInput {
  source: ProposalSource;
  sourceKey: string;
  issue?: number;
  title: string;
  input: string;
  tasks: Array<{ prompt: string; role: string; target?: string }>;
  createdBy: string;
  owner?: string;
}

const MAX_INPUT = 20_000;
const MAX_TASKS = 16;
const MAX_TASK_PROMPT = 20_000;

/** Persistent, approval-gated task proposals. It owns state transitions, not execution side effects. */
export class ProposalStore {
  private proposals = new Map<string, Proposal>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'proposals.json');
    this.restore();
  }

  list(): Proposal[] {
    return [...this.proposals.values()].map((p) => ({ ...p, tasks: p.tasks.map((t) => ({ ...t })) }));
  }

  create(input: ProposalInput, roles?: Map<string, RoleSpec>): Proposal | string {
    const err = validateInput(input, roles ?? new Map());
    if (err) return err;
    const existing = this.list().find((p) => p.sourceKey === input.sourceKey);
    if (existing) return existing;
    const now = Date.now();
    const proposal: Proposal = {
      id: randomBytes(12).toString('hex'),
      source: input.source,
      sourceKey: input.sourceKey,
      ...(input.issue === undefined ? {} : { issue: input.issue }),
      title: input.title.trim(),
      input: input.input.trim(),
      tasks: input.tasks.map((task, i) => ({ id: `${i + 1}`, prompt: task.prompt.trim(), role: task.role.trim(), ...(task.target ? { target: task.target.trim() } : {}), status: 'pending' })),
      status: 'pending',
      createdBy: input.createdBy,
      ...(input.owner ? { owner: input.owner } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.set(proposal.id, proposal);
    this.persist();
    return proposal;
  }

  approve(id: string, by: string, canApprove: boolean): string | undefined {
    const proposal = this.proposals.get(id);
    if (!proposal) return 'No such proposal';
    if (!canApprove) return 'You cannot approve this proposal';
    if (proposal.status !== 'pending') return proposal.status === 'approved' ? undefined : `Proposal is ${proposal.status}`;
    proposal.status = 'approved';
    proposal.approvedBy = by;
    proposal.updatedAt = Date.now();
    this.persist();
  }

  reject(id: string, by: string, canApprove: boolean, reason?: string): string | undefined {
    const proposal = this.proposals.get(id);
    if (!proposal) return 'No such proposal';
    if (!canApprove) return 'You cannot reject this proposal';
    if (proposal.status !== 'pending') return `Proposal is ${proposal.status}`;
    proposal.status = 'rejected';
    proposal.approvedBy = by;
    proposal.error = reason?.trim().slice(0, 500) || undefined;
    proposal.updatedAt = Date.now();
    this.persist();
  }

  fail(id: string, error: string): string | undefined {
    const proposal = this.proposals.get(id);
    if (!proposal) return 'No such proposal';
    if (!['approved', 'pending'].includes(proposal.status)) return `Proposal is ${proposal.status}`;
    proposal.status = 'failed';
    proposal.error = error.slice(0, 500);
    proposal.updatedAt = Date.now();
    this.persist();
  }

  assignTask(id: string, taskId: string, workerId: string): string | undefined {
    const proposal = this.proposals.get(id);
    const task = proposal?.tasks.find((item) => item.id === taskId);
    if (!proposal || !task) return 'No such proposal task';
    if (task.status !== 'pending') return task.target === workerId ? undefined : `Proposal task is ${task.status}`;
    task.target = workerId;
    task.status = 'assigned';
    proposal.updatedAt = Date.now();
    this.persist();
  }

  markTask(id: string, taskId: string, status: 'pending' | 'assigned' | 'done' | 'failed', error?: string): string | undefined {
    const proposal = this.proposals.get(id);
    const task = proposal?.tasks.find((item) => item.id === taskId);
    if (!proposal || !task) return 'No such proposal task';
    task.status = status;
    if (status === 'pending') task.target = undefined;
    task.error = error?.slice(0, 500);
    if (status === 'failed') {
      proposal.status = 'failed';
      proposal.error = task.error;
    } else if (proposal.tasks.every((item) => item.status === 'done')) proposal.status = 'done';
    proposal.updatedAt = Date.now();
    this.persist();
  }

  workerTask(id: string, workerId: string, status: 'done' | 'failed', error?: string): string | undefined {
    const proposal = this.proposals.get(id);
    const task = proposal?.tasks.find((item) => item.target === workerId && item.status === 'assigned');
    if (!proposal || !task) return 'No such assigned proposal task';
    return this.markTask(id, task.id, status, error);
  }

  complete(id: string): string | undefined {
    const proposal = this.proposals.get(id);
    if (!proposal) return 'No such proposal';
    if (proposal.status !== 'approved') return `Proposal is ${proposal.status}`;
    proposal.status = 'done';
    proposal.updatedAt = Date.now();
    this.persist();
  }

  /** Proposals created for issue number, used by the polling trigger for idempotency. */
  hasActiveIssue(issue: number): boolean {
    for (const proposal of this.proposals.values()) if (proposal.issue === issue && !['rejected', 'failed', 'done'].includes(proposal.status)) return true;
    return false;
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify({ proposals: this.list() }, null, 2), { mode: 0o600 });
    } catch {
      // Disk failures must not stop the office; next mutation retries persistence.
    }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { proposals?: Proposal[] };
      for (const proposal of saved.proposals ?? []) {
        if (proposal?.id && proposal.sourceKey && Array.isArray(proposal.tasks)) this.proposals.set(proposal.id, proposal);
      }
    } catch {
      // Corrupt state starts empty, like the worker and queue stores.
    }
  }
}

function validateInput(input: ProposalInput, roles: Map<string, RoleSpec>): string | undefined {
  if (!['user', 'github-issue'].includes(input.source)) return 'Unknown proposal source';
  if (!input.sourceKey.trim() || input.sourceKey.length > 200) return 'Invalid proposal source key';
  if (!input.title.trim() || input.title.length > 200) return 'Title is required and must be at most 200 characters';
  if (!input.input.trim() || input.input.length > MAX_INPUT) return `Task is required and must be at most ${MAX_INPUT} characters`;
  if (!input.createdBy.trim()) return 'Creator is required';
  if (!input.tasks.length || input.tasks.length > MAX_TASKS) return `Tasks must contain 1-${MAX_TASKS} items`;
  for (const task of input.tasks) {
    if (!task.prompt.trim() || task.prompt.length > MAX_TASK_PROMPT) return `Each task must be at most ${MAX_TASK_PROMPT} characters`;
    if (!roles.has(task.role.trim())) return `Unknown worker role: ${task.role}`;
    if (task.target !== undefined && (!task.target.trim() || task.target.length > 200)) return 'Invalid worker target';
  }
  return undefined;
}
