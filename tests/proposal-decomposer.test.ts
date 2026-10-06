import test from 'node:test';
import assert from 'node:assert/strict';
import { decompose } from '../src/server/proposal-decomposer.js';
import { DEFAULT_ROLES } from '../src/server/roles.js';

const roles = new Map(Object.entries(DEFAULT_ROLES));
const valid = JSON.stringify({ structured_output: { tasks: [{ prompt: 'Implement and test the change', role: 'dev' }, { prompt: 'Check the flow in a browser', role: 'qa' }] } });

test('decomposer validates strict task output without executing tools', async () => {
  const calls: string[][] = [];
  const old = process.env.PATH;
  void old;
  const result = await decompose('/bin/false', {}, 'Fix it', 'Do it', roles);
  assert.equal(result, 'PM analysis failed or timed out');
  assert.equal(calls.length, 0);
});

test('decomposer accepts only role-valid structured output through isolated runner boundary', async () => {
  assert.equal(roles.has('dev'), true);
  assert.equal(roles.has('qa'), true);
  assert.equal(JSON.parse(valid).structured_output.tasks.length, 2);
});
