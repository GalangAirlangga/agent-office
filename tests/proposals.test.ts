import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProposalStore } from '../src/server/proposals.js';
import { DEFAULT_ROLES } from '../src/server/roles.js';

test('proposal store deduplicates issues and gates transitions', () => {
  const store = new ProposalStore(mkdtempSync(path.join(os.tmpdir(), 'agent-office-proposals-')));
  const roles = new Map(Object.entries(DEFAULT_ROLES));
  const input = { source: 'github-issue' as const, sourceKey: 'issue:12', issue: 12, title: 'Fix it', input: 'Fix issue', tasks: [{ prompt: 'Fix issue', role: 'dev' }], createdBy: 'Ada' };
  const proposal = store.create(input, roles);
  assert.equal(typeof proposal, 'object');
  assert.equal((store.create(input, roles) as any).id, (proposal as any).id);
  assert.equal(store.approve((proposal as any).id, 'Ada', false), 'You cannot approve this proposal');
  assert.equal(store.approve((proposal as any).id, 'Ada', true), undefined);
  assert.equal(store.approve((proposal as any).id, 'Ada', true), undefined);
  assert.equal(store.complete((proposal as any).id), undefined);
  assert.equal((store.list()[0]).status, 'done');
});

test('proposal store rejects unknown roles and restores state', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-office-proposals-'));
  const store = new ProposalStore(dir);
  const roles = new Map(Object.entries(DEFAULT_ROLES));
  const bad = store.create({ source: 'user', sourceKey: 'user:1', title: 'Bad', input: 'Bad', tasks: [{ prompt: 'Bad', role: 'missing' }], createdBy: 'Ada' }, roles);
  assert.equal(bad, 'Unknown worker role: missing');
  const good = store.create({ source: 'user', sourceKey: 'user:2', title: 'Good', input: 'Good', tasks: [{ prompt: 'Good', role: 'qa' }], createdBy: 'Ada' }, roles);
  assert.equal(typeof good, 'object');
  assert.match(readFileSync(path.join(dir, 'proposals.json'), 'utf8'), /user:2/);
  assert.equal(new ProposalStore(dir).list()[0].tasks[0].role, 'qa');
});
