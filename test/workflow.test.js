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
const { all, one } = await import('../db.js');

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct horse battery staple';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
let base;
let server;

// Stand-in for Claude: the compliance agent rejects drafts without a disclaimer, the writer adds it on rewrite.
ai.ask = async (system, prompt, schema) => {
  if (schema.properties.approved) {
    return prompt.includes('not medical advice')
      ? { approved: true, issues: [] }
      : { approved: false, issues: ['Add a "not medical advice" line.'] };
  }
  return { text: prompt.includes('Rewrite') ? 'Fibre helps. General information, not medical advice. #WomensHealth' : 'Fibre helps! #WomensHealth' };
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

  await t.test('approval starts the three AI agent complexes', async () => {
    const res = await post(reviewer, '/articles/1', { action: 'approve', title: article.title, body: 'Iron matters.\n\nEat leafy greens daily.' });
    assert.equal(res.status, 303);
    assert.equal(status(), 'approved');
    await waitFor(() => !one(`SELECT 1 FROM items WHERE status = 'generating'`));
    const posts = all(`SELECT channel, status, ai_ok, body FROM items WHERE channel != 'website' ORDER BY channel`);
    assert.deepEqual(posts.map((p) => [p.channel, p.status, p.ai_ok]), [['instagram', 'draft', 1], ['linkedin', 'draft', 1], ['x', 'draft', 1]]);
    assert.match(posts[0].body, /not medical advice/);
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
});
