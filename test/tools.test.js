import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-tools-'));
const { one, readOnlyDb, run } = await import('../db.js');
const { createEntry } = await import('../knowledge.js');
const { MAX_ROWS, runTool } = await import('../tools.js');

// Secrets that must never come back from a tool.
const SECRETS = ['dr.private@example.com', 'Dr Private', 'SALTSECRET', 'HASHSECRET', 'SESSIONHASHSECRET'];
run(`INSERT INTO users (id, email, name, pw_hash) VALUES (1, 'dr.private@example.com', 'Dr Private', 'scrypt$SALTSECRET$HASHSECRET')`);
run(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('SESSIONHASHSECRET', 1, 9999999999999)`);
for (let i = 1; i <= 8; i++) {
  createEntry({ kind: 'example', platform: 'linkedin', text: `Iron tip ${i} for busy women. #Iron`, reach: i * 100, likes: i, shares: i }, 1);
}
createEntry({ kind: 'example', platform: 'linkedin', text: 'Folate facts every parent should know.', reach: 1 }, 1);
for (let i = 1; i <= 7; i++) {
  run(`INSERT INTO articles (id, title, body, author_id, status) VALUES (?, ?, ?, 1, 'published')`, i, `Iron guide ${i}`,
    `Part ${i}. Iron helps your blood carry oxygen and supports energy levels during a busy day.`);
}
run(`INSERT INTO articles (id, title, body, author_id, status) VALUES (99, 'Iron draft', 'An unpublished iron draft.', 1, 'in_review')`);

const call = (name, input, ctx) => {
  const result = runTool(name, input, ctx);
  return { ...result, output: result.isError ? null : JSON.parse(result.content) };
};

test('get_top_posts rejects bad input', () => {
  for (const input of [
    { platform: 'facebook', topic: '' },
    { platform: 'linkedin', topic: 'x'.repeat(101) },
    { platform: 'linkedin', topic: 42 },
    { platform: 'linkedin' },
    { platform: 'linkedin', topic: '', sql: 'DROP TABLE users' },
    null,
    ['linkedin', ''],
  ]) {
    const result = call('get_top_posts', input);
    assert.equal(result.isError, true, JSON.stringify(input));
    assert.match(result.content, /^Invalid input/);
  }
});

test('get_top_posts caps rows, ranks by engagement and returns only whitelisted fields', () => {
  const { output, rows } = call('get_top_posts', { platform: 'linkedin', topic: '' });
  assert.equal(rows.length, MAX_ROWS);
  assert.equal(output.length, MAX_ROWS);
  assert.deepEqual(output.map((p) => p.reach), [800, 700, 600, 500, 400]);
  for (const post of output) assert.deepEqual(Object.keys(post).sort(), ['date', 'likes', 'reach', 'shares', 'source', 'text']);
  assert.deepEqual(call('get_top_posts', { platform: 'linkedin', topic: 'folate' }).output.map((p) => p.text), ['Folate facts every parent should know.']);
  assert.deepEqual(call('get_top_posts', { platform: 'x', topic: '' }).output, []);
});

test('search_past_articles validates input, caps rows and skips unpublished and current articles', () => {
  for (const query of ['ir', '!!!', 'x'.repeat(101), 7]) assert.equal(call('search_past_articles', { query }).isError, true, String(query));
  const { output } = call('search_past_articles', { query: 'iron energy' }, { articleId: 7 });
  assert.equal(output.length, MAX_ROWS);
  assert.ok(output.every((a) => a.title !== 'Iron guide 7' && a.title !== 'Iron draft'));
  for (const article of output) {
    assert.deepEqual(Object.keys(article).sort(), ['date', 'excerpt', 'title']);
    assert.ok(article.excerpt.length <= 400);
  }
});

test('tools never expose users, sessions or password hashes', () => {
  const outputs = [
    call('get_top_posts', { platform: 'linkedin', topic: '' }),
    call('get_top_posts', { platform: 'linkedin', topic: 'private example com' }),
    call('search_past_articles', { query: 'private' }),
    call('search_past_articles', { query: 'iron' }),
  ].map((r) => r.content).join('\n');
  for (const secret of SECRETS) assert.ok(!outputs.includes(secret), `leaked ${secret}`);
  assert.doesNotMatch(outputs, /"(email|pw_hash|token_hash|author_id|created_by|user_id)"/);
});

test('SQL in the input is only ever search text', () => {
  const result = call('get_top_posts', { platform: 'linkedin', topic: "x' OR 1=1; DROP TABLE users; --" });
  assert.equal(result.isError, false);
  assert.equal(one('SELECT COUNT(*) AS n FROM users').n, 1);
});

test('unknown tools return is_error, and the tool connection cannot write', () => {
  for (const name of ['delete_everything', 'constructor', '__proto__', 'toString']) {
    const result = runTool(name, {});
    assert.equal(result.isError, true, name);
    assert.match(result.content, /Unknown tool/);
  }
  assert.throws(() => readOnlyDb.exec('DELETE FROM users'), /readonly/);
});
