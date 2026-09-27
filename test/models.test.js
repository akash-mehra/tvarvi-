import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-models-'));
const { agentModels, ai, callClaude, callCost, requestParams } = await import('../ai.js');
const { one } = await import('../db.js');

test('writers and trend scouts default to Sonnet 5; compliance and coach to Opus 5', () => {
  assert.deepEqual(agentModels({}), {
    writer: 'claude-sonnet-5', scout: 'claude-sonnet-5', compliance: 'claude-opus-5', coach: 'claude-opus-5',
  });
  assert.equal(agentModels({ MODEL_WRITER: ' claude-opus-5 ', MODEL_COACH: '' }).writer, 'claude-opus-5');
  assert.equal(agentModels({ MODEL_COACH: '' }).coach, 'claude-opus-5');
});

test('an unsupported model is refused with the list of supported ones', () => {
  assert.throws(() => agentModels({ MODEL_COMPLIANCE: 'gpt-4o' }), /MODEL_COMPLIANCE="gpt-4o" is not a supported model\. Use one of: .*claude-sonnet-5/);
  assert.throws(() => agentModels({ MODEL_WRITER: 'constructor' }), /not a supported model/);
});

test('server-side refusal fallback is only requested for models that support it', () => {
  const opus = requestParams({ model: 'claude-opus-5', system: 's' });
  assert.deepEqual([opus.betas, opus.fallbacks, opus.max_tokens], [['server-side-fallback-2026-07-01'], 'default', 16000]);
  const sonnet = requestParams({ model: 'claude-sonnet-5', system: 's' });
  assert.equal('fallbacks' in sonnet || 'betas' in sonnet, false);
});

test('cost uses each model\'s own list prices', () => {
  const usage = { input: 1e6, output: 1e6, cache_read: 1e6, cache_write: 1e6, searches: 100 };
  assert.equal(callCost({ ...usage, model: 'claude-opus-5' }), 5 + 25 + 0.5 + 6.25 + 1);
  assert.equal(callCost({ ...usage, model: 'claude-sonnet-5' }), 2 + 10 + 0.2 + 2.5 + 1);
  assert.equal(callCost({ ...usage, model: 'claude-unknown' }), null);
});

test('each call records the model that served it', async () => {
  const replies = [{ model: 'claude-opus-4-8' }, {}]; // a fallback-served reply, then one without a model field
  ai.ask = async () => ({ ...replies.shift(), content: [], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });
  await callClaude('Instagram compliance', null, { model: 'claude-opus-5' });
  await callClaude('Instagram writer', null, { model: 'claude-sonnet-5' });
  assert.deepEqual([one('SELECT model FROM ai_calls WHERE id = 1').model, one('SELECT model FROM ai_calls WHERE id = 2').model],
    ['claude-opus-4-8', 'claude-sonnet-5']);
});
