import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-drafts-'));
process.env.PUBLIC_BASE_URL = 'http://app.test';

const { handler, addUser } = await import('../server.js');
const { ai } = await import('../ai.js');
const { one, run } = await import('../db.js');
const { article, reply, research } = await import('./fixtures.js');

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct horse battery staple';
let base;
let server;

// Scripted Claude: each draft researches, writes one good version and is approved, unless `script` says otherwise.
let script = () => reply([...research(), ...article()]);
ai.stream = async (params, onBlock) => {
  const res = await script(params);
  res.content.forEach((block) => onBlock?.(block));
  return res;
};
ai.ask = async () => reply([{ type: 'text', text: JSON.stringify({ approved: true, issues: [] }) }]);

before(async () => {
  server = createServer(handler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const request = (cookie, path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init, headers: { cookie, ...init.headers } });
const post = (cookie, path, fields) => request(cookie, path, { method: 'POST', headers: { origin: ORIGIN }, body: new URLSearchParams(fields) });
const page = async (cookie, path) => (await request(cookie, path)).text();

async function login(email) {
  const res = await post('', '/login', { email, password: PASSWORD });
  assert.equal(res.status, 303, `login ${email}`);
  return res.headers.get('set-cookie').split(';')[0];
}

async function finished(id) {
  for (const deadline = Date.now() + 5000; one('SELECT status FROM drafts WHERE id = ?', id).status === 'running';) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return one('SELECT * FROM drafts WHERE id = ?', id);
}

test('a writer drafts an article with the agent, checks it and submits it into the normal workflow', async (t) => {
  await addUser({ name: 'Ada Admin', email: 'admin@example.com', is_admin: 1 }, PASSWORD);
  await addUser({ name: 'Wen Writer', email: 'writer@example.com', can_write: 1 }, PASSWORD);
  await addUser({ name: 'Otto Other', email: 'other@example.com', can_write: 1 }, PASSWORD);
  const reviewerId = await addUser({ name: 'Rae Reviewer', email: 'reviewer@example.com', can_review: 1 }, PASSWORD);
  await addUser({ name: 'Pia Plain', email: 'plain@example.com' }, PASSWORD);
  run(`UPDATE users SET sign_name = 'Dr. Rae', sign_credentials = 'MBBS', sign_photo = 'photo.jpg' WHERE can_review = 1`);
  const [admin, writer, other, reviewer, plain] = await Promise.all(['admin', 'writer', 'other', 'reviewer', 'plain'].map((r) => login(`${r}@example.com`)));

  await t.test('drafting needs Research sites, which only admins add', async () => {
    assert.match(await page(writer, '/write'), /An admin needs to add Research sites/);
    assert.equal((await post(writer, '/drafts', { topic: 'iron and energy' })).status, 400);
    assert.equal((await post(writer, '/sources', { url: 'https://nih.gov', kind: 'research' })).status, 403);
    for (const url of ['https://nih.gov', 'https://www.nhs.uk']) {
      assert.equal((await post(admin, '/sources', { url, kind: 'research' })).status, 303);
    }
    const sources = await page(admin, '/sources');
    assert.match(sources, /value="research"><span>Research site/);
    assert.match(sources, /<h2 class="group-header">Research sites<\/h2>[\s\S]*?nih\.gov/);
    assert.match(await page(writer, '/write'), /Research and draft/);
    assert.equal((await request(plain, '/write')).status, 403, 'the Write tab is for writers');
  });

  await t.test('only writers can start a draft, with a valid topic', async () => {
    assert.equal((await post(plain, '/drafts', { topic: 'iron and energy' })).status, 403);
    assert.equal((await post(writer, '/drafts', { topic: 'ab' })).status, 400);
    assert.equal((await post(writer, '/drafts', { topic: 'x'.repeat(151) })).status, 400);
    assert.equal((await request(writer, '/drafts', { method: 'POST', body: new URLSearchParams({ topic: 'iron' }) })).status, 403, 'cross-site');
  });

  let id;
  await t.test('the agent runs in the background and the writer checks the draft', async () => {
    const res = await post(writer, '/drafts', { topic: 'iron and energy' });
    assert.equal(res.status, 303);
    id = Number(res.headers.get('location').split('/').pop());
    const draft = await finished(id);
    assert.equal(draft.status, 'ready', draft.error);
    const html = await page(writer, `/drafts/${id}`);
    assert.match(html, /<input type="hidden" name="draft_id" value="\d+">/);
    assert.match(html, /name="title" value="Iron and energy: a guide for women"/);
    assert.match(html, /## References\n\n1\. Iron deficiency anaemia - NHS\./);
    assert.match(html, /Claims and the passages they cite \(6\)/);
    assert.match(html, /<li class="pass">[^]*?Passed: <\/span>References: 6 opened pages cited/);
    assert.match(html, /Opened https:\/\/www\.nhs\.uk\/conditions\/iron-deficiency-anaemia\//);
    assert.match(await page(writer, '/write'), new RegExp(`<a class="row" href="/drafts/${id}">[\\s\\S]*?iron and energy`));
  });

  await t.test('the research record is private until it becomes an article', async () => {
    assert.equal((await request(other, `/drafts/${id}`)).status, 403);
    assert.equal((await request(reviewer, `/drafts/${id}`)).status, 403);
    assert.equal((await request(admin, `/drafts/${id}`)).status, 200);
    assert.equal((await post(other, '/articles', { title: 'Mine now', body: 'Text', draft_id: id })).status, 403);
    assert.equal((await post(other, `/drafts/${id}`, { action: 'discard' })).status, 403);
  });

  let articleId;
  await t.test('submitting creates a normal submitted article, once', async () => {
    const draft = one('SELECT title, body FROM drafts WHERE id = ?', id);
    const res = await post(writer, '/articles', { title: draft.title, body: `${draft.body}\n\nEdited by the writer.`, draft_id: id });
    assert.equal(res.status, 303);
    articleId = Number(res.headers.get('location').split('/').pop());
    assert.deepEqual({ ...one('SELECT status, author_id FROM articles WHERE id = ?', articleId) }, { status: 'submitted', author_id: one(`SELECT id FROM users WHERE email = 'writer@example.com'`).id });
    assert.deepEqual({ ...one('SELECT status, article_id FROM drafts WHERE id = ?', id) }, { status: 'submitted', article_id: articleId });
    assert.equal((await post(writer, '/articles', { title: draft.title, body: draft.body, draft_id: id })).status, 409);
    assert.equal(one('SELECT COUNT(*) AS n FROM articles').n, 1, 'the refused resubmit created nothing');

    const html = await page(writer, `/articles/${articleId}`);
    assert.match(html, /drafted it with the article agent: from the topic &quot;iron and energy&quot;/);
    assert.match(html, new RegExp(`<a href="/drafts/${id}">Research record</a>`));
    // The website HTML gets numbered, clickable references.
    assert.match(html, /<ol><li value="1">Iron deficiency anaemia - NHS\. <a href="https:\/\/www\.nhs\.uk\/conditions\/iron-deficiency-anaemia\/">/);
  });

  await t.test('the assigned reviewer can open the research record', async () => {
    assert.equal((await post(admin, `/articles/${articleId}`, { action: 'assign', reviewer_id: reviewerId })).status, 303);
    assert.equal((await request(reviewer, `/drafts/${id}`)).status, 200);
  });

  await t.test('a draft can be discarded, and a failed one tried again', async () => {
    const second = Number((await post(writer, '/drafts', { topic: 'iron and sport' })).headers.get('location').split('/').pop());
    await finished(second);
    assert.equal((await post(writer, `/drafts/${second}`, { action: 'discard' })).status, 303);
    assert.equal(one('SELECT status FROM drafts WHERE id = ?', second).status, 'discarded');
    assert.equal((await post(writer, '/articles', { title: 'T', body: 'B', draft_id: second })).status, 409);
    assert.equal((await post(writer, `/drafts/${second}`, { action: 'retry' })).status, 409);

    script = () => {
      throw new Error('connection reset');
    };
    const failed = Number((await post(writer, '/drafts', { topic: 'iron and sleep' })).headers.get('location').split('/').pop());
    assert.equal((await finished(failed)).status, 'failed');
    assert.match(await page(writer, `/drafts/${failed}`), /connection reset[\s\S]*value="retry">Try again/);
    script = () => reply([...research(), ...article()]);
    const retry = await post(writer, `/drafts/${failed}`, { action: 'retry' });
    assert.equal(retry.status, 303);
    assert.equal((await finished(Number(retry.headers.get('location').split('/').pop()))).status, 'ready');
  });

  await t.test('a ready draft submitted unchanged is not audited again when assigned', async () => {
    const ready = one(`SELECT id, title, body FROM drafts WHERE status = 'ready' ORDER BY id DESC LIMIT 1`);
    const res = await post(writer, '/articles', { title: ready.title, body: ready.body, draft_id: ready.id });
    const id = Number(res.headers.get('location').split('/').pop());
    const audits = () => one(`SELECT COUNT(*) AS n FROM ai_calls WHERE agent = 'Final audit'`).n;
    const before = audits();
    assert.equal((await post(admin, `/articles/${id}`, { action: 'assign', reviewer_id: reviewerId })).status, 303);
    assert.deepEqual({ ...one('SELECT audit_status, audit_notes FROM articles WHERE id = ?', id) },
      { audit_status: 'ready', audit_notes: 'The AI draft passed the code checks and the compliance review, and was submitted unchanged.' });
    assert.equal(audits(), before);
  });

  await t.test('rules for the website article reach the article agent only', async () => {
    assert.equal((await post(admin, '/knowledge', { kind: 'brand_rule', platform: 'website', text: 'Exactly five chapters.' })).status, 303);
    assert.equal((await post(admin, '/knowledge', { kind: 'example', platform: 'website', text: 'An example.' })).status, 400);
    const { activeRules } = await import('../knowledge.js');
    assert.ok(activeRules('website').some((r) => r.text === 'Exactly five chapters.'));
    assert.ok(!activeRules('instagram').some((r) => r.text === 'Exactly five chapters.'));
    assert.match(await page(admin, '/training'), /Exactly five chapters\.[\s\S]*?Website article/);
  });

  await t.test('one draft at a time per writer', async () => {
    script = () => new Promise(() => {}); // never finishes
    assert.equal((await post(writer, '/drafts', { topic: 'iron and travel' })).status, 303);
    assert.equal((await post(writer, '/drafts', { topic: 'iron and diet' })).status, 409);
    run(`UPDATE drafts SET status = 'failed' WHERE status = 'running'`);
  });

  await t.test('the Training page reports the article agent per draft', async () => {
    const html = await page(admin, '/training');
    assert.match(html, /<span class="row-title">Article agent<\/span>\s*<span class="row-sub"><span>claude-opus-5-5<\/span>/);
    assert.match(html, /<span class="row-title">Article agent<\/span>\s*<span class="row-sub"><span>claude-sonnet-5<\/span>/);
    assert.match(html, /Article agent: \$\d+\.\d\d and \d+ min per draft on average, over \d+ drafts/);
    // Per article: only the final audit (one Opus 5.5 call, 1,000 in and 500 out: $0.014); the drafts' calls don't count.
    assert.match(html, /<span class="row-title">Final audit<\/span>\s*<span class="row-sub"><span>claude-opus-5-5<\/span><span class="sep"><\/span><span>1 call<\/span>/);
    assert.match(html, /Average cost per article: \$0\.01 over 1 article/);
  });

});
