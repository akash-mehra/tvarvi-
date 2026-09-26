import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-knowledge-'));
const { all, run } = await import('../db.js');
const k = await import('../knowledge.js');
const { complianceSystem, writerSystem } = await import('../ai.js');

run(`INSERT INTO users (id, email, name, pw_hash) VALUES (1, 'admin@example.com', 'Admin', 'x')`);
const promptText = (channel) =>
  `${writerSystem(channel, k.activeRules(channel), [])}\n${complianceSystem(k.activeRules(channel).filter((r) => r.kind === 'compliance_rule'), []).map((b) => b.text).join('\n')}`;

const { id } = k.createEntry({ kind: 'compliance_rule', title: 'Disclaimer', text: 'Add "not medical advice" to health tips.' }, 1);

test('an edit adds a new version and keeps the old one', () => {
  assert.equal(k.editEntry(id, { title: 'Disclaimer', text: 'Always add "General information, not medical advice."' }, 1, 'exact wording'), 2);
  const history = k.entryHistory(id);
  assert.deepEqual(history.map((v) => [v.version, v.note]), [[2, 'exact wording'], [1, null]]);
  assert.equal(history[1].text, 'Add "not medical advice" to health tips.');
  assert.equal(k.getEntry(id).version, 2);
});

test('rollback creates a new version with the old text', () => {
  const v1 = k.entryHistory(id).find((v) => v.version === 1);
  assert.equal(k.rollbackEntry(id, v1.id, 1), 3);
  const current = k.getEntry(id);
  assert.equal(current.version, 3);
  assert.equal(current.text, v1.text);
  assert.equal(k.entryHistory(id).length, 3);
  assert.equal(k.entryHistory(id)[0].note, 'Rolled back to v1');
  assert.equal(k.rollbackEntry(id, 999999, 1), null);
});

test('agents read only the current version of active rules', () => {
  assert.ok(promptText('instagram').includes('Add "not medical advice" to health tips.'));
  assert.ok(!promptText('instagram').includes('Always add "General information'));
  k.setActive(id, false, 1);
  assert.equal(k.activeRules('instagram').length, 0);
  assert.ok(!promptText('instagram').includes('not medical advice" to health tips'));
  k.setActive(id, true, 1);
  assert.equal(k.activeRules('instagram').length, 1);
});

test('platform rules reach only their platform, and examples are never rules', () => {
  k.createEntry({ kind: 'brand_rule', platform: 'x', text: 'At most two hashtags on X.' }, 1);
  k.createEntry({ kind: 'example', platform: 'x', text: 'Example post' }, 1);
  assert.ok(k.activeRules('x').some((r) => r.text === 'At most two hashtags on X.'));
  assert.ok(!k.activeRules('linkedin').some((r) => r.text === 'At most two hashtags on X.'));
  assert.ok(!k.activeRules('x').some((r) => r.kind === 'example'));
});

test('every change is audited', () => {
  const actions = all('SELECT action FROM audit ORDER BY id').map((a) => a.action);
  for (const action of ['knowledge_created', 'knowledge_edited', 'knowledge_rolled_back', 'knowledge_deactivated', 'knowledge_activated']) {
    assert.ok(actions.includes(action), action);
  }
});
