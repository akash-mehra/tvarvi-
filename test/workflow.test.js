import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-test-'));
process.env.PUBLIC_BASE_URL = 'http://app.test';
process.env.DRY_RUN_CHANNELS = 'website,instagram,linkedin,x';

const { handler, addUser } = await import('../server.js');
const { ai } = await import('../ai.js');
const { all, one, run } = await import('../db.js');
const { createEntry } = await import('../knowledge.js');

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct horse battery staple';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
let base;
let server;

// Stand-in for Claude, scripted per turn:
// writer turn 1 looks up top posts; turn 2 submits a draft without a disclaimer (compliance rejects it);
// turn 3 resubmits with the disclaimer (compliance approves it).
let nextId = 0;
const complianceSystems = [];
const reply = (content, stopReason) => ({ content, stop_reason: stopReason, usage: { input_tokens: 1000, output_tokens: 200 } });
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_${++nextId}`, name, input });
const requested = { writer: new Set(), compliance: new Set() };
const audits = [];
ai.ask = async (params) => {
  requested[params.output_config ? 'compliance' : 'writer'].add(params.model);
  // The advisory audit of the text a reviewer sees: it flags one issue, which must not stop the approval.
  if (params.system?.[0]?.text?.includes('A doctor is about to approve')) {
    audits.push(params.messages[0].content);
    return reply([{ type: 'text', text: JSON.stringify({ approved: false, issues: ['Cite the source for "Iron matters."'] }) }], 'end_turn');
  }
  if (params.output_config) {
    complianceSystems.push(params.system.map((block) => block.text).join('\n'));
    const approved = params.messages[0].content.includes('not medical advice');
    return reply([{ type: 'text', text: JSON.stringify(approved ? { approved, issues: [] } : { approved, issues: ['Add a "not medical advice" line.'] }) }], 'end_turn');
  }
  const last = params.messages.at(-1);
  if (typeof last.content === 'string') {
    const platform = params.system.includes('LinkedIn post') ? 'linkedin' : params.system.includes('X (Twitter) post') ? 'x' : 'instagram';
    return reply([toolUse('get_top_posts', { platform, topic: 'iron' })], 'tool_use');
  }
  const rejected = last.content.some((block) => /rejected this draft/.test(block.content));
  return reply([toolUse('submit_post', {
    text: rejected ? 'Fibre helps. General information, not medical advice. #WomensHealth' : 'Fibre helps! #WomensHealth',
  })], 'tool_use');
};

before(async () => {
  server = createServer(handler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const request = (cookie, path, init = {}) =>
  fetch(`${base}${path}`, { redirect: 'manual', ...init, headers: { cookie, ...init.headers } });
const post = (cookie, path, fields, headers = { origin: ORIGIN }) =>
  request(cookie, path, { method: 'POST', headers, body: new URLSearchParams(fields) });

async function login(email) {
  const res = await post('', '/login', { email, password: PASSWORD });
  assert.equal(res.status, 303, `login ${email}`);
  return res.headers.get('set-cookie').split(';')[0];
}

async function upload(cookie, path, bytes) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
  const encoded = new Request('http://encode.test', { method: 'POST', body: form });
  return request(cookie, path, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': encoded.headers.get('content-type') },
    body: Buffer.from(await encoded.arrayBuffer()),
  });
}

async function waitFor(check) {
  for (const deadline = Date.now() + 5000; !check(); ) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('article goes from writer to published, following the diagram', async (t) => {
  await addUser({ name: 'Ada Admin', email: 'admin@example.com', is_admin: 1 }, PASSWORD);
  await addUser({ name: 'Wen Writer', email: 'writer@example.com', can_write: 1 }, PASSWORD);
  const reviewerId = await addUser({ name: 'Rae Reviewer', email: 'reviewer@example.com', can_review: 1 }, PASSWORD);
  await addUser({ name: 'Pat Publisher', email: 'publisher@example.com', can_publish: 1 }, PASSWORD);
  const [admin, writer, reviewer, publisher] = await Promise.all(
    ['admin', 'writer', 'reviewer', 'publisher'].map((role) => login(`${role}@example.com`)),
  );
  const article = { title: 'Female health and diet', body: 'Iron matters.\n\nEat leafy greens.' };
  const status = () => one('SELECT status FROM articles WHERE id = 1').status;

  await t.test('rejects posts from other sites and wrong passwords', async () => {
    assert.equal((await post(writer, '/articles', article, {})).status, 403);
    assert.equal((await post(writer, '/articles', article, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('', '/login', { email: 'admin@example.com', password: 'wrong' })).status, 401);
  });

  await t.test('writer submits; only the admin may assign', async () => {
    const res = await post(writer, '/articles', article);
    assert.equal(res.headers.get('location'), '/articles/1');
    assert.equal((await post(writer, '/articles/1', { action: 'assign', reviewer_id: reviewerId })).status, 403);
    assert.equal((await post(admin, '/articles/1', { action: 'assign', reviewer_id: reviewerId })).status, 303);
    assert.equal(status(), 'in_review');
  });

  await t.test('a reviewer adds signing details before doing anything else', async () => {
    const res = await request(reviewer, '/');
    assert.deepEqual([res.status, res.headers.get('location')], [303, '/account']);
    assert.equal((await post(reviewer, '/articles/1', { action: 'approve', title: article.title, body: article.body })).headers.get('location'), '/account');
    assert.match(await (await request(reviewer, '/account')).text(), /Add your signing details to continue/);
    assert.equal((await post(reviewer, '/account/signature', { sign_name: 'Dr. Rae', sign_credentials: '' })).status, 400);
    assert.equal((await post(writer, '/account/signature', { sign_name: 'Wen', sign_credentials: 'MBBS' })).status, 403, 'only reviewers sign');
    const saved = await post(reviewer, '/account/signature', { sign_name: 'Dr. Rae  Reviewer', sign_credentials: 'MBBS — PGIMS Rohtak' });
    assert.equal(saved.status, 200);
    assert.deepEqual({ ...one(`SELECT sign_name, sign_credentials FROM users WHERE id = ?`, reviewerId) },
      { sign_name: 'Dr. Rae Reviewer', sign_credentials: 'MBBS, PGIMS Rohtak' });
    assert.equal((await request(reviewer, '/')).status, 200);
    assert.match(await (await request(admin, '/users')).text(), /Signs as Dr\. Rae Reviewer, MBBS, PGIMS Rohtak/);
    // The advisory audit ran on the assigned text; the reviewer sees it above the review form.
    await waitFor(() => one('SELECT audit_status FROM articles WHERE id = 1').audit_status !== 'running');
    const page = await (await request(reviewer, '/articles/1')).text();
    assert.match(page, /AI audit \(advisory\)[\s\S]*Cite the source for &quot;Iron matters\.&quot;/);
    assert.match(page, /Approving signs the article as <strong>Dr\. Rae Reviewer, MBBS, PGIMS Rohtak<\/strong>/);
  });

  await t.test('reviewer edits: old and new versions go to the admin as a diff', async () => {
    const res = await post(reviewer, '/articles/1', { action: 'send_to_admin', title: article.title, body: 'Iron matters.\n\nEat leafy greens daily.' });
    assert.equal(res.status, 303);
    assert.equal(status(), 'returned');
    const page = await (await request(admin, '/articles/1')).text();
    assert.match(page, /<del>Eat leafy greens\.<\/del>/);
    assert.match(page, /<ins>Eat leafy greens daily\.<\/ins>/);
    assert.equal((await post(admin, '/articles/1', { action: 'assign', reviewer_id: reviewerId, version: 'new' })).status, 303);
  });

  await t.test('approving with edited text is refused', async () => {
    const res = await post(reviewer, '/articles/1', { action: 'approve', title: article.title, body: 'Something else' });
    assert.equal(res.status, 400);
  });

  // Approved knowledge and web sources the agents must use: one brand rule, one Instagram example,
  // and a compliance page whose newer version is still pending (so it must not be used yet).
  const adminId = one(`SELECT id FROM users WHERE email = 'admin@example.com'`).id;
  const rule = createEntry({ kind: 'brand_rule', title: 'Voice guide', text: 'Warm, plain words.' }, adminId);
  const example = createEntry({ kind: 'example', platform: 'instagram', text: 'Iron fuels your day. #Iron', reach: 900 }, adminId);
  run(`INSERT INTO sources (id, url, host, kind) VALUES (1, 'https://regulator.example/health-claims', 'regulator.example', 'compliance')`);
  run(`INSERT INTO snapshots (id, source_id, text, hash, status) VALUES (1, 1, 'APPROVED GUIDANCE TEXT', 'a', 'approved'), (2, 1, 'PENDING GUIDANCE TEXT', 'b', 'pending')`);

  await t.test('approval starts the three tool-using AI agent complexes', async () => {
    const res = await post(reviewer, '/articles/1', { action: 'approve', title: article.title, body: 'Iron matters.\n\nEat leafy greens daily.' });
    assert.equal(res.status, 303);
    assert.equal(status(), 'approved');
    // Signed by the reviewer; the audit's issue was reported, not a condition. One audit per version of the text.
    assert.equal(one('SELECT signature FROM articles WHERE id = 1').signature, 'Dr. Rae Reviewer, MBBS, PGIMS Rohtak');
    assert.match(one(`SELECT detail FROM events WHERE action = 'approved'`).detail,
      /^signed by Dr\. Rae Reviewer, MBBS, PGIMS Rohtak; approved over the AI audit's issues$/);
    assert.equal(audits.length, 2);
    assert.match(audits[1], /Eat leafy greens daily\./);
    await waitFor(() => !one(`SELECT 1 FROM items WHERE status = 'generating'`));
    const posts = all(`SELECT id, channel, status, ai_ok, rounds, ai_draft, body FROM items WHERE channel != 'website' ORDER BY channel`);
    assert.deepEqual(posts.map((p) => [p.channel, p.status, p.ai_ok, p.rounds]),
      [['instagram', 'draft', 1, 2], ['linkedin', 'draft', 1, 2], ['x', 'draft', 1, 2]]);
    assert.match(posts[0].body, /not medical advice/);
    assert.equal(posts[0].ai_draft, posts[0].body);

    // Every tool call is in the article's history.
    const toolCalls = all(`SELECT detail FROM events WHERE action = 'tool_call'`).map((e) => e.detail);
    assert.equal(toolCalls.length, 3);
    assert.match(toolCalls.find((d) => d.startsWith('Instagram writer')), /get_top_posts\(platform="instagram", topic="iron"\) → 1 row/);

    // The post records exactly which rule/example versions and which approved snapshot it used.
    const inputs = all('SELECT kind, ref_id FROM item_inputs WHERE item_id = ? ORDER BY kind', posts[0].id).map((i) => `${i.kind}:${i.ref_id}`);
    assert.deepEqual(inputs.sort(), [`example:${example.versionId}`, `rule:${rule.versionId}`, 'snapshot:1'].sort());
    assert.ok(complianceSystems.every((s) => s.includes('APPROVED GUIDANCE TEXT') && !s.includes('PENDING GUIDANCE TEXT')));

    // Writers run on Sonnet 5 and the compliance agent on Opus 5.5 by default, and each call records its model.
    assert.deepEqual([[...requested.writer], [...requested.compliance]], [['claude-sonnet-5'], ['claude-opus-5-5']]);
    assert.deepEqual(all(`SELECT agent LIKE '% writer' AS writer, model, COUNT(*) AS n FROM ai_calls WHERE agent != 'Final audit' GROUP BY 1, 2 ORDER BY 1`).map((r) => ({ ...r })),
      [{ writer: 0, model: 'claude-opus-5-5', n: 6 }, { writer: 1, model: 'claude-sonnet-5', n: 9 }]);
  });

  await t.test('the Training page prices each call at its own model', async () => {
    const page = await (await request(admin, '/training')).text();
    assert.match(page, /<td>Compliance<\/td><td>claude-opus-5-5<\/td><td>6<\/td>/);
    assert.match(page, /<td>Writer<\/td><td>claude-sonnet-5<\/td><td>9<\/td>/);
    assert.match(page, /<td>Final audit<\/td><td>claude-opus-5-5<\/td><td>2<\/td>/);
    // 9 Sonnet 5 calls at $0.004 + 6 Opus 5.5 reviews and 2 Opus 5.5 audits at $0.008 (1,000 input and 200 output
    // tokens each) = $0.10.
    assert.match(page, /Average cost per article: \$0\.10 over 1 article/);
    assert.match(page, /Models now: writers claude-sonnet-5, article writer claude-sonnet-5, carousel writer claude-sonnet-5, trend scouts claude-sonnet-5, compliance claude-opus-5-5, picture check claude-sonnet-5, coach claude-opus-5-5, carousel and website pictures gemini-3\.1-flash-image/);
  });

  const item = (channel) => one('SELECT * FROM items WHERE channel = ?', channel);

  await t.test('Instagram needs a JPEG before it can be marked ready', async () => {
    const ig = item('instagram');
    assert.equal((await post(reviewer, `/items/${ig.id}`, { action: 'ready', body: ig.body })).status, 400);
    assert.equal((await upload(reviewer, `/items/${ig.id}/image`, Buffer.from('not a jpeg'))).status, 400);
    assert.equal((await upload(reviewer, `/items/${ig.id}/image`, JPEG)).status, 303);
    const media = await request('', `/media/${item('instagram').image}`);
    assert.equal(media.headers.get('content-type'), 'image/jpeg');
  });

  await t.test('reviewer without publishing rights hands off to the publisher', async () => {
    for (const channel of ['instagram', 'linkedin', 'x']) {
      const { id, body } = item(channel);
      assert.equal((await post(reviewer, `/items/${id}`, { action: 'ready', body })).status, 303);
    }
    assert.equal(status(), 'awaiting_publisher');
    assert.equal((await post(reviewer, `/items/${item('x').id}`, { action: 'publish' })).status, 403);
  });

  await t.test('publisher publishes each item once', async () => {
    for (const channel of ['website', 'instagram', 'linkedin', 'x']) {
      assert.equal((await post(publisher, `/items/${item(channel).id}`, { action: 'publish' })).status, 303);
    }
    await post(publisher, `/items/${item('x').id}`, { action: 'publish' }); // double click
    assert.equal(status(), 'published');
    assert.deepEqual(all('SELECT DISTINCT status, simulated FROM items').map((row) => ({ ...row })), [{ status: 'published', simulated: 1 }]);
    assert.equal(one(`SELECT COUNT(*) AS n FROM events WHERE action = 'published'`).n, 4);
    assert.equal(one(`SELECT COUNT(*) AS n FROM events WHERE action = 'completed'`).n, 1);
  });

  await t.test('engagement is recorded and a post can be promoted to a versioned example', async () => {
    const x = item('x');
    assert.equal((await post(writer, `/items/${x.id}`, { action: 'metrics', likes: '5' })).status, 403);
    assert.equal((await post(publisher, `/items/${x.id}`, { action: 'metrics', likes: '-1' })).status, 400);
    assert.equal((await post(publisher, `/items/${x.id}`, { action: 'metrics', likes: '12', shares: '3', reach: '800', saves: '' })).status, 303);
    assert.deepEqual({ ...one('SELECT likes, shares, reach, saves, source FROM post_metrics WHERE item_id = ?', x.id) },
      { likes: 12, shares: 3, reach: 800, saves: 0, source: 'manual' });

    assert.equal((await post(publisher, `/items/${x.id}`, { action: 'promote' })).status, 403);
    assert.equal((await post(admin, `/items/${x.id}`, { action: 'promote' })).status, 303);
    assert.equal((await post(admin, `/items/${x.id}`, { action: 'promote' })).status, 409);
    const promoted = one(`SELECT k.platform, v.text, v.likes, v.reach, v.version FROM knowledge k
      JOIN knowledge_versions v ON v.id = k.current_version_id WHERE k.source_item_id = ?`, x.id);
    assert.deepEqual({ ...promoted }, { platform: 'x', text: x.body, likes: 12, reach: 800, version: 1 });
    const page = await (await request(admin, '/articles/1')).text();
    assert.match(page, /Sources used/);
    assert.match(page, /Brand rule &quot;Voice guide&quot; v1/);
  });
});
