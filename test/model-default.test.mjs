import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelSelectionDefaultOf } from '../lib/model-default.js';

const route = (model, reasoningEffort) => ({ provider: 'p', model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });

test('model default: pending > lastUsed > header > deployment > options', () => {
  const selection = { pending: route('pending', 'high'), lastUsed: route('last') };
  const services = { sessionProjections: { stateOf: (_session, key) => { assert.equal(key, 'modelSelection'); return selection; } }, agentDefaultModel: { currentSelection: () => route('deployment') } };
  const ctx = { get: (key) => services[key] };
  const session = { requestHeader: () => ({ config: route('header') }) };
  const input = { session, options: route('options') };
  assert.deepEqual(modelSelectionDefaultOf(ctx, input), route('pending', 'high'));
  selection.pending = null;
  assert.deepEqual(modelSelectionDefaultOf(ctx, input), route('last'));
  delete services.sessionProjections;
  assert.deepEqual(modelSelectionDefaultOf(ctx, input), route('header'));
  session.requestHeader = () => ({});
  assert.deepEqual(modelSelectionDefaultOf(ctx, input), route('deployment'));
  delete services.agentDefaultModel;
  assert.deepEqual(modelSelectionDefaultOf(ctx, input), route('options'));
  assert.equal(modelSelectionDefaultOf(ctx), null);
  assert.deepEqual(modelSelectionDefaultOf(undefined, { options: route('options') }), route('options'));
});

test('model default: adapter effort defaults are not pinned; explicit effort is retained', () => {
  const header = { config: route('header', 'high'), adapterDefaults: { reasoningEffort: true } };
  const session = { requestHeader: () => header };
  assert.deepEqual(modelSelectionDefaultOf(undefined, { session }), route('header'));
  header.adapterDefaults.reasoningEffort = false;
  assert.deepEqual(modelSelectionDefaultOf(undefined, { session }), route('header', 'high'));
});

test('model default: invalid routes skip sources; optional invalid effort is discarded', () => {
  const ctx = { get: (key) => key === 'sessionProjections' ? { stateOf: () => ({ lastUsed: { provider: 'bad provider', model: 'bad' } }) } : { currentSelection: () => route('deployment') } };
  assert.deepEqual(modelSelectionDefaultOf(ctx, { session: { requestHeader: () => ({ config: { provider: 'p' } }) } }), route('deployment'));
  for (const effort of [undefined, 'bad effort', 1]) assert.deepEqual(modelSelectionDefaultOf(undefined, { options: route('valid', effort) }), route('valid'));
  assert.equal(modelSelectionDefaultOf(undefined, { options: { provider: 'p', model: '' } }), null);
});

test('model default: unavailable/throwing services and malformed inputs never throw', () => {
  const ctx = { get: () => { throw new Error('unavailable'); } };
  const session = { requestHeader: () => { throw new Error('unavailable'); } };
  assert.deepEqual(modelSelectionDefaultOf(ctx, { session, options: route('fallback') }), route('fallback'));
  assert.equal(modelSelectionDefaultOf(ctx, { session }), null);
  const partial = { get: (key) => key === 'sessionProjections' ? { stateOf() { throw new Error('projection failed'); } } : { currentSelection: () => route('deployment') } };
  assert.deepEqual(modelSelectionDefaultOf(partial, { session: { requestHeader: () => ({ config: route('header') }) } }), route('header'));
  assert.deepEqual(modelSelectionDefaultOf(partial, { session }), route('deployment'));
  assert.equal(modelSelectionDefaultOf(), null);
  assert.equal(modelSelectionDefaultOf({ get: 1 }, { session: { requestHeader: 1 } }), null);
  assert.equal(modelSelectionDefaultOf(undefined, { options: { get provider() { throw new Error('bad'); } } }), null);
});
