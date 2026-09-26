import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-coach-'));
const { all, one, run } = await import('../db.js');
const { ai } = await import('../ai.js');
const coach = await import('../coach.js');
const k = await import('../knowledge.js');
const { normText } = await import('../text.js');

run(`INSERT INTO users (id, email, name, pw_hash) VALUES (1, 'admin@example.com', 'Admin', 'x')`);

// Stand-in for Claude: returns whatever `script` holds as the coach's JSON answer.
let calls = 0;
let script = { observations: [] };
ai.ask = async () => {
  calls++;
  return { content: [{ type: 'text', text: JSON.stringify(script) }], stop_reason: 'end_turn', usage: { input_tokens: 5000, output_tokens: 800 } };
};

const digest = (id) => one('SELECT * FROM digests WHERE id = ?', id);
const knowledgeCounts = () => ({ ...one('SELECT (SELECT COUNT(*) FROM knowledge) AS entries, (SELECT COUNT(*) FROM knowledge_versions) AS versions') });
const pending = () => all(`SELECT * FROM suggestions WHERE status = 'pending' AND kind != 'reminder' ORDER BY id`);

test('a thin week is skipped with a reason, and changed compliance pages still get one reminder', async () => {
  run(`INSERT INTO sources (id, url, host, kind) VALUES (1, 'https://regulator.example/claims', 'regulator.example', 'compliance')`);
  run(`INSERT INTO snapshots (id, source_id, text, hash) VALUES (1, 1, 'New guidance', 'h1')`);
  const id = await coach.runDigest(1);
  assert.equal(digest(id).status, 'skipped');
  assert.match(digest(id).note, /too little data this week \(0 edited, 0 top-performing, 0 flagged posts; at least 3 needed\)/);
  assert.match(digest(id).note, /1 reminder/);
  assert.equal(calls, 0, 'no AI call for a skipped week');
  await coach.runDigest(1);
  const reminders = all(`SELECT * FROM suggestions WHERE kind = 'reminder'`);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].snapshot_id, 1);
});

// A week of real activity: two reviewer edits, one top post with engagement, one flagged post,
// an existing rule and an earlier rejected suggestion.
let edit1, edit2, top, flagged, oldDigest;
function seedWeek() {
  for (let i = 1; i <= 4; i++) run(`INSERT INTO articles (id, title, body, author_id, status) VALUES (?, ?, 'Body', 1, 'published')`, i, `Article ${i}`);
  edit1 = run(`INSERT INTO items (article_id, channel, ai_draft, body, status, ai_ok, rounds, generated_at, reviewed_at)
    VALUES (1, 'instagram', 'Cure your tiredness fast with iron! #Iron', 'Iron may ease tiredness. General information, not medical advice. #Iron',
    'ready', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).lastInsertRowid;
  edit2 = run(`INSERT INTO items (article_id, channel, ai_draft, body, status, ai_ok, rounds, generated_at, reviewed_at)
    VALUES (2, 'linkedin', 'This miracle food fixes anaemia.', 'Leafy greens contain iron. General information, not medical advice.',
    'ready', 1, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).lastInsertRowid;
  top = run(`INSERT INTO items (article_id, channel, ai_draft, body, status, published_at)
    VALUES (3, 'x', 'Low energy? Iron matters. General info, not medical advice. #WomensHealth',
    'Low energy? Iron matters. General info, not medical advice. #WomensHealth', 'published', CURRENT_TIMESTAMP)`).lastInsertRowid;
  run(`INSERT INTO post_metrics (item_id, likes, shares, reach, source) VALUES (?, 300, 40, 5000, 'manual')`, top);
  flagged = run(`INSERT INTO items (article_id, channel, ai_draft, body, status, ai_ok, rounds, ai_notes, generated_at)
    VALUES (4, 'instagram', 'Take 65 mg daily for energy.', 'Take 65 mg daily for energy.', 'draft', 0, 3,
    'Needs attention. Unresolved after 3 compliance reviews:\n- Remove the dosage advice "take 65 mg daily".', CURRENT_TIMESTAMP)`).lastInsertRowid;
  k.createEntry({ kind: 'compliance_rule', text: 'Never promise a cure.' }, 1);
  oldDigest = run(`INSERT INTO digests (status, period_start) VALUES ('done', '2026-01-01 00:00:00')`).lastInsertRowid;
  run(`INSERT INTO suggestions (digest_id, kind, text, norm_text, status) VALUES (?, 'compliance_rule', 'Avoid the word "miracle" in posts.', ?, 'rejected')`,
    oldDigest, normText('Avoid the word "miracle" in posts.'));
}

const rule = (text, platform = 'all') => ({ kind: 'brand_rule', platform, text });

test('the coach only proposes: evidence is verified, duplicates dropped, rules unchanged', async () => {
  seedWeek();
  script = {
    observations: [
      { kind: 'recurring_edit', summary: 'Reviewers remove cure promises.', evidence: ['Cure your tiredness fast'], item_ids: [edit1],
        suggestions: [{ kind: 'compliance_rule', platform: 'all', text: 'Say "may help" instead of promising that something cures or fixes a condition.' }] },
      { kind: 'recurring_edit', summary: 'Invented quote.', evidence: ['This sentence was never written anywhere'], item_ids: [edit1], suggestions: [rule('Fabricated rule')] },
      { kind: 'recurring_edit', summary: 'Unknown post.', evidence: ['Cure your tiredness fast'], item_ids: [9999], suggestions: [rule('Rule about an unknown post')] },
      { kind: 'recurring_edit', summary: 'Quote too short.', evidence: ['Iron'], item_ids: [edit1], suggestions: [rule('Rule from a tiny quote')] },
      { kind: 'recurring_edit', summary: 'Miracle words removed.', evidence: ['This miracle food fixes anaemia.'], item_ids: [edit2],
        suggestions: [
          { kind: 'compliance_rule', platform: 'all', text: 'Never promise a cure' },
          { kind: 'compliance_rule', platform: 'linkedin', text: 'Avoid the word miracle in posts' },
        ] },
      { kind: 'top_post', summary: 'A short X post with a disclaimer did well.', evidence: ['Low energy? Iron matters.'], item_ids: [top],
        suggestions: [{ kind: 'example', platform: 'all', text: 'Strong hook' }] },
      { kind: 'flagged', summary: 'Dosage advice keeps failing compliance.', evidence: ['take 65 mg daily'], item_ids: [flagged],
        suggestions: [rule('x'.repeat(501), 'instagram')] },
    ],
  };
  const before = knowledgeCounts();
  const id = await coach.runDigest(1);
  assert.equal(calls, 1);
  assert.equal(digest(id).status, 'done');
  assert.equal(digest(id).note,
    '4 observations, 2 new suggestions; dropped 3 without verifiable evidence, 2 duplicates of existing or earlier ideas, 1 invalid.');
  assert.deepEqual(knowledgeCounts(), before, 'the coach changed no rules or examples');

  const [ruleSuggestion, exampleSuggestion] = pending();
  assert.equal(ruleSuggestion.kind, 'compliance_rule');
  assert.equal(ruleSuggestion.platform, null);
  assert.equal(exampleSuggestion.kind, 'example');
  assert.equal(exampleSuggestion.item_id, top);
  assert.equal(exampleSuggestion.platform, 'x');
  assert.equal(exampleSuggestion.text, one('SELECT body FROM items WHERE id = ?', top).body, 'example text is the real post, not model text');
  const observation = one('SELECT * FROM observations WHERE id = ?', ruleSuggestion.observation_id);
  assert.deepEqual(JSON.parse(observation.evidence), ['Cure your tiredness fast']);
  assert.deepEqual(JSON.parse(observation.item_ids), [edit1]);
});

test('at most 8 new suggestions per digest', async () => {
  const texts = ['Open Instagram captions with a question.', 'Keep LinkedIn paragraphs under three lines.', 'Use at most two hashtags on X.',
    'Name the article topic in the first sentence.', 'Avoid exclamation marks next to health claims.', 'Suggest consulting a doctor before supplements.',
    'Prefer plain words over medical jargon.', 'End LinkedIn posts with a discussion question.', 'No emoji beside medical statements.',
    'Spell out abbreviations like RDA on first use.', 'Keep X posts under 200 characters.', 'Write numbers as digits.'];
  script = { observations: [{ kind: 'recurring_edit', summary: 'Many small edits.', evidence: ['Leafy greens contain iron.'], item_ids: [edit2],
    suggestions: texts.map((text) => rule(text)) }] };
  const id = await coach.runDigest(1);
  assert.match(digest(id).note, /8 new suggestions; dropped 4 over the weekly cap of 8/);
  assert.equal(pending().length, 10);
});

test('admin decisions: accept, edit, reject and dismiss are recorded and audited', async () => {
  const [ruleSuggestion, exampleSuggestion, toReject] = pending();

  assert.equal(coach.decideSuggestion(ruleSuggestion.id, 'accept', 1), 'accepted');
  const accepted = one('SELECT * FROM suggestions WHERE id = ?', ruleSuggestion.id);
  assert.equal(accepted.decided_by, 1);
  assert.ok(accepted.decided_at);
  assert.equal(accepted.final_text, ruleSuggestion.text);
  const version = one('SELECT * FROM knowledge_versions WHERE id = ?', accepted.knowledge_version_id);
  assert.deepEqual([version.version, version.suggestion_id, version.text], [1, ruleSuggestion.id, ruleSuggestion.text]);
  assert.ok(k.activeRules('instagram').some((r) => r.text === ruleSuggestion.text), 'accepted rule now reaches the agents');

  assert.equal(coach.decideSuggestion(exampleSuggestion.id, 'edit', 1, 'Edited example text'), 'edited');
  const edited = one('SELECT * FROM suggestions WHERE id = ?', exampleSuggestion.id);
  assert.equal(edited.final_text, 'Edited example text');
  assert.equal(edited.text, exampleSuggestion.text, 'the original proposal is kept');
  const example = one(`SELECT k.source_item_id, k.platform, v.text, v.likes, v.reach FROM knowledge k
    JOIN knowledge_versions v ON v.id = k.current_version_id WHERE v.suggestion_id = ?`, exampleSuggestion.id);
  assert.deepEqual({ ...example }, { source_item_id: top, platform: 'x', text: 'Edited example text', likes: 300, reach: 5000 });

  assert.equal(coach.decideSuggestion(toReject.id, 'reject', 1), 'rejected');
  assert.throws(() => coach.decideSuggestion(toReject.id, 'accept', 1), (err) => err.status === 409);

  const reminder = one(`SELECT id FROM suggestions WHERE kind = 'reminder'`);
  assert.throws(() => coach.decideSuggestion(reminder.id, 'accept', 1), (err) => err.status === 400);
  assert.equal(coach.decideSuggestion(reminder.id, 'dismiss', 1), 'dismissed');
  assert.throws(() => coach.decideSuggestion(pending()[0].id, 'approve', 1), (err) => err.status === 400);

  const actions = all(`SELECT action FROM audit WHERE action LIKE 'suggestion_%'`).map((a) => a.action);
  assert.deepEqual(actions, ['suggestion_accepted', 'suggestion_edited', 'suggestion_rejected', 'suggestion_dismissed']);
});

test('background jobs run once per interval', async () => {
  process.env.PUBLIC_BASE_URL = 'http://app.test';
  const { runDueJobs } = await import('../server.js');
  run('UPDATE sources SET active = 0'); // no network in tests
  const digests = () => one('SELECT COUNT(*) AS n FROM digests').n;
  const start = digests();
  const now = Date.now();
  await runDueJobs(now);
  assert.equal(digests(), start + 1);
  await runDueJobs(now + 60 * 60 * 1000);
  assert.equal(digests(), start + 1, 'not again within the week');
  await runDueJobs(now + 8 * 24 * 60 * 60 * 1000);
  assert.equal(digests(), start + 2);
  assert.deepEqual(all('SELECT name FROM jobs ORDER BY name').map((j) => j.name), ['compliance_snapshots', 'weekly_digest']);
});

test('a rejected idea, and one already accepted, is never proposed again', async () => {
  const rejected = one(`SELECT text FROM suggestions WHERE status = 'rejected' AND digest_id != ?`, oldDigest).text;
  const accepted = one(`SELECT text FROM suggestions WHERE status = 'accepted'`).text;
  script = { observations: [{ kind: 'recurring_edit', summary: 'Same ideas again.', evidence: ['Cure your tiredness fast'], item_ids: [edit1],
    suggestions: [rule(rejected), rule(`${rejected.toUpperCase()}!`), { kind: 'compliance_rule', platform: 'all', text: accepted }] }] };
  const before = pending().length;
  const id = await coach.runDigest(1);
  assert.match(digest(id).note, /0 new suggestions; dropped 3 duplicates/);
  assert.equal(pending().length, before);
});
