import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ROLES } from '../src/server/roles.js';
import { ProposalStore } from '../src/server/proposals.js';

const roles = new Map(Object.entries(DEFAULT_ROLES));

function issueInput(updatedAt: string, extra: Partial<{ state: string; labels: { name: string }[] }> = {}) {
  const title = 'Split work';
  const body = 'Implement X';
  return {
    source: 'github-issue' as const,
    sourceKey: `issue:12:${updatedAt}`,
    issue: 12,
    title,
    input: body,
    tasks: [{ prompt: `Work on GitHub issue #12: ${title}\n\n${body}`, role: 'dev' }],
    createdBy: 'GitHub',
    ...extra,
  };
}

test('PM issue source key deduplicates repeated refreshes and terminal decisions', () => {
  const store = new ProposalStore(mkdtempSync(path.join(os.tmpdir(), 'issue-proposals-')));
  const first = store.create(issueInput('2026-10-06T01:00:00Z'), roles);
  assert.equal(typeof first, 'object');
  assert.equal((store.create(issueInput('2026-10-06T01:00:00Z'), roles) as any).id, (first as any).id);
  store.reject((first as any).id, 'admin', true);
  assert.equal((store.create(issueInput('2026-10-06T01:00:00Z'), roles) as any).id, (first as any).id);
  const changed = store.create(issueInput('2026-10-06T02:00:00Z'), roles);
  assert.equal(typeof changed, 'object');
  assert.notEqual((changed as any).id, (first as any).id);
});

test('PM issue input keeps closed and unlabeled issues out of proposal creation contract', () => {
  const store = new ProposalStore('/tmp/issue-proposals-negative');
  const closed = issueInput('1', { state: 'CLOSED' });
  const unlabeled = issueInput('2', { labels: [] });
  assert.equal(closed.state, 'CLOSED');
  assert.deepEqual(unlabeled.labels, []);
  assert.equal(store.list().length, 0);
});
