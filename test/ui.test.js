import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-ui-'));
process.env.PUBLIC_BASE_URL = 'http://app.test';

const { handler, addUser } = await import('../server.js');
const { run } = await import('../db.js');

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct horse battery staple';
let base;
let server;

before(async () => {
  server = createServer(handler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const request = (cookie, path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init, headers: { cookie, ...init.headers } });
const page = async (cookie, path) => (await request(cookie, path)).text();
async function login(email) {
  const res = await request('', '/login', { method: 'POST', headers: { origin: ORIGIN }, body: new URLSearchParams({ email, password: PASSWORD }) });
  return res.headers.get('set-cookie').split(';')[0];
}
const tabs = (html) => [...(html.match(/<nav class="tabbar[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? '').matchAll(/<span>([^<]+)<\/span><\/a>/g)].map((m) => m[1]);

test('the app shell: tabs by role, one self-hosted script only where the AI is working, posts on their own pages', async (t) => {
  const adminId = await addUser({ name: 'Ada Admin', email: 'admin@example.com', is_admin: 1 }, PASSWORD);
  const writerId = await addUser({ name: 'Wen Writer', email: 'writer@example.com', can_write: 1 }, PASSWORD);
  const reviewerId = await addUser({ name: 'Rae Reviewer', email: 'reviewer@example.com', can_review: 1 }, PASSWORD);
  await addUser({ name: 'Pia Plain', email: 'plain@example.com' }, PASSWORD);
  run(`UPDATE users SET sign_name = 'Dr. Rae', sign_credentials = 'MBBS', sign_photo = 'photo.jpg' WHERE id = ?`, reviewerId);
  const [admin, writer, reviewer, plain] = await Promise.all(['admin', 'writer', 'reviewer', 'plain'].map((r) => login(`${r}@example.com`)));
  run(`INSERT INTO articles (id, title, body, author_id, reviewer_id, status) VALUES (1, 'Iron and energy', 'Iron matters.', ?, ?, 'approved')`, writerId, reviewerId);
  run(`INSERT INTO items (id, article_id, channel, status, body) VALUES (1, 1, 'website', 'ready', ''), (2, 1, 'instagram', 'generating', ''),
    (3, 1, 'linkedin', 'draft', 'Iron fuels your day.'), (4, 1, 'x', 'draft', 'Iron matters.')`);

  await t.test('the security policy allows only this app\'s own script, with no string-to-code sinks', async () => {
    const res = await request('', '/login');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'/);
    assert.match(csp, /require-trusted-types-for 'script'; trusted-types 'none'/);
    assert.doesNotMatch(await res.text(), /<script/, 'the login page loads no script');
    const orbs = await request('', '/orbs.js');
    assert.deepEqual([orbs.status, orbs.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
    const js = await orbs.text();
    assert.match(js, /MIT License[\s\S]*Copyright \(c\) 2026 Jakub Antalik/);
    assert.match(js, /querySelectorAll\('canvas\.orb'\)/);
    assert.doesNotMatch(js, /innerHTML|eval\(|new Function|document\.write/);
    const icon = await request('', '/icon.png');
    assert.deepEqual([icon.status, icon.headers.get('content-type')], [200, 'image/png']);
  });

  await t.test('the Home Screen app covers the whole site, so no page opens in the in-app browser', async () => {
    const res = await request('', '/manifest.webmanifest');
    assert.deepEqual([res.status, res.headers.get('content-type')], [200, 'application/manifest+json']);
    const manifest = await res.json();
    assert.deepEqual([manifest.start_url, manifest.scope, manifest.display], ['/', '/', 'standalone']);
    assert.match(res.headers.get('content-security-policy'), /manifest-src 'self'/);
    assert.match(await page('', '/login'), /<link rel="manifest" href="\/manifest\.webmanifest">/);
  });

  await t.test('each role gets its own tabs', async () => {
    assert.deepEqual(tabs(await page(admin, '/')), ['Home', 'Admin', 'Account']);
    assert.deepEqual(tabs(await page(writer, '/')), ['Home', 'Write', 'Account']);
    assert.deepEqual(tabs(await page(reviewer, '/')), ['Home', 'Account']);
    assert.match(await page(writer, '/'), /<a class="tab" href="\/" aria-current="page">/);
    assert.equal((await request(writer, '/admin')).status, 403);
    assert.match(await page(admin, '/admin'), /href="\/training"[\s\S]*?href="\/sources"[\s\S]*?href="\/suggestions"[\s\S]*?href="\/users"/);
    assert.equal((await request(plain, '/write')).status, 403);
    run(`INSERT INTO digests (id, status, period_start) VALUES (1, 'done', '2026-09-21')`);
    run(`INSERT INTO suggestions (digest_id, kind, text, norm_text) VALUES (1, 'reminder', 'Cite sources.', 'cite sources')`);
    assert.match(await page(admin, '/training'), /<a class="tab" href="\/admin" aria-current="page" aria-label="Admin, 1 waiting"><span class="tab-icon">[\s\S]*?<span class="tab-badge">1<\/span>/,
      'the Admin tab counts decisions waiting, on every page');
    run(`UPDATE suggestions SET status = 'dismissed'`);
    assert.doesNotMatch(await page(admin, '/'), /tab-badge/);
  });

  await t.test('the orb script loads only on pages where the AI is working', async () => {
    const article = await page(reviewer, '/articles/1');
    assert.match(article, /<script src="\/orbs\.js" defer><\/script>/);
    assert.match(article, /<canvas class="orb orb-20" data-orb="composing" data-size="20" width="20" height="20" role="img" aria-label="Working"><\/canvas>/);
    assert.match(article, /<meta http-equiv="refresh" content="5">/);
    assert.doesNotMatch(await page(reviewer, '/items/3'), /<script/, 'a post that is not being written loads no script');
    assert.doesNotMatch(await page(admin, '/admin'), /<script/);
  });

  await t.test('the article lists its four posts; each post has its own page for the people who can see the article', async () => {
    const article = await page(writer, '/articles/1');
    for (const id of [1, 2, 3, 4]) assert.match(article, new RegExp(`<a class="row" href="/items/${id}">`));
    const linkedin = await page(reviewer, '/items/3');
    assert.match(linkedin, /<textarea class="post-editor" id="post-body" name="body" rows="10" maxlength="10000">Iron fuels your day\.<\/textarea>/);
    assert.match(linkedin, /<button class="btn" form="post" name="action" value="ready">/);
    assert.match(linkedin, /href="\/items\/4"[\s\S]*?Next: X \(Twitter\)/, 'the next post waiting for the reviewer');
    assert.doesNotMatch(await page(writer, '/items/3'), /<textarea/, 'the author reads it but cannot change it');
    assert.equal((await request(plain, '/items/3')).status, 403);
    assert.equal((await request(reviewer, '/items/99')).status, 404);
    const saved = await request(reviewer, '/items/3', { method: 'POST', headers: { origin: ORIGIN }, body: new URLSearchParams({ action: 'save', body: 'Iron fuels your whole day.' }) });
    assert.deepEqual([saved.status, saved.headers.get('location')], [303, '/items/3'], 'an action on a post returns to that post');
  });

  await t.test('the reviewer reads first and signs in a sheet; the admin assigns in a sheet', async () => {
    run(`UPDATE articles SET status = 'in_review' WHERE id = 1`);
    run('DELETE FROM items WHERE article_id = 1');
    const html = await page(reviewer, '/articles/1');
    assert.match(html, /<input type="radio" name="view" id="view-read" checked><label for="view-read">Read<\/label>/);
    assert.match(html, /<form id="review" method="post" action="\/articles\/1">\s*<button type="submit" disabled hidden aria-hidden="true"><\/button>/,
      'Enter in the title field never submits: the default button is disabled');
    assert.match(html, /<div id="sign-sheet" popover class="sheet" role="dialog" aria-labelledby="sign-sheet-title">/);
    assert.match(html, /<div id="send-sheet" popover class="sheet"[\s\S]*name="second_opinion" value="1" form="review"/);
    run(`UPDATE articles SET status = 'submitted' WHERE id = 1`);
    assert.match(await page(admin, '/articles/1'), /<div id="assign-sheet" popover class="sheet"[\s\S]*<option value="\d+" selected>Rae Reviewer<\/option>/, "the current reviewer is preselected");
    assert.equal(adminId > 0, true);
  });
});
