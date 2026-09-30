import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-delete-'));
process.env.PUBLIC_BASE_URL = 'http://app.test';

const { handler, addUser } = await import('../server.js');
const { one, run } = await import('../db.js');
const { createEntry, editEntry } = await import('../knowledge.js');

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
const post = (cookie, path, fields) => request(cookie, path, { method: 'POST', headers: { origin: ORIGIN }, body: new URLSearchParams(fields) });
const page = async (cookie, path) => (await request(cookie, path)).text();
async function login(email) {
  const res = await post('', '/login', { email, password: PASSWORD });
  return res.headers.get('set-cookie').split(';')[0];
}

test('admins delete rules and sources nothing has used, after typing "delete"', async (t) => {
  const adminId = await addUser({ name: 'Ada Admin', email: 'admin@example.com', is_admin: 1 }, PASSWORD);
  await addUser({ name: 'Wen Writer', email: 'writer@example.com', can_write: 1 }, PASSWORD);
  const [admin, writer] = await Promise.all([login('admin@example.com'), login('writer@example.com')]);

  // A post that used one rule version and one compliance page version.
  run(`INSERT INTO articles (id, title, body, author_id) VALUES (1, 'T', 'B', ?)`, adminId);
  run(`INSERT INTO items (id, article_id, channel, status) VALUES (1, 1, 'x', 'draft')`);
  const mistake = createEntry({ kind: 'brand_rule', title: 'Claim language', text: 'Saved as the wrong type.' }, adminId);
  editEntry(mistake.id, { title: 'Claim language', text: 'Second version.' }, adminId);
  const used = createEntry({ kind: 'compliance_rule', title: 'Used', text: 'A post used this.' }, adminId);
  run(`INSERT INTO item_inputs (item_id, kind, ref_id, label) VALUES (1, 'rule', ?, 'Compliance rule "Used" v1')`, used.versionId);
  const inDraft = createEntry({ kind: 'compliance_rule', title: 'In a draft', text: 'A draft used this.' }, adminId);
  run(`INSERT INTO drafts (topic, created_by, inputs) VALUES ('t', ?, ?)`, adminId, JSON.stringify([{ kind: 'rule', ref: inDraft.versionId, label: 'x' }]));
  run(`INSERT INTO sources (id, url, host, kind) VALUES (7, 'https://who.int/', 'who.int', 'compliance'), (8, 'https://reg.example/a', 'reg.example', 'compliance')`);
  run(`INSERT INTO snapshots (id, source_id, text, hash, status) VALUES (1, 7, 'WHO page', 'a', 'pending'), (2, 8, 'Guidance', 'b', 'approved')`);
  run(`INSERT INTO item_inputs (item_id, kind, ref_id, label) VALUES (1, 'snapshot', 2, 'https://reg.example/a')`);

  await t.test('only admins see the page, and it warns before the typed confirmation', async () => {
    assert.equal((await request(writer, `/knowledge/${mistake.id}/delete`)).status, 403);
    assert.equal((await post(writer, `/knowledge/${mistake.id}/delete`, { confirm: 'delete' })).status, 403);
    const html = await page(admin, `/knowledge/${mistake.id}/delete`);
    assert.match(html, /Delete this brand rule\?/);
    assert.match(html, /permanently deletes this brand rule and all 2 of its versions\. It can't be undone\./);
    assert.match(html, /<input name="confirm" required pattern="delete"/);
    assert.match(await page(admin, `/knowledge/${mistake.id}`), new RegExp(`href="/knowledge/${mistake.id}/delete">Delete…`));
  });

  await t.test('without exactly "delete" nothing is deleted', async () => {
    for (const confirm of ['', 'Delete it', 'yes']) {
      assert.equal((await post(admin, `/knowledge/${mistake.id}/delete`, { confirm })).status, 400, confirm);
    }
    assert.equal((await request(admin, `/knowledge/${mistake.id}/delete`, { method: 'POST', body: new URLSearchParams({ confirm: 'delete' }) })).status, 403, 'cross-site');
    assert.ok(one('SELECT 1 FROM knowledge WHERE id = ?', mistake.id));
  });

  await t.test('an unused rule goes with all its versions, and the audit log keeps a note', async () => {
    const res = await post(admin, `/knowledge/${mistake.id}/delete`, { confirm: ' delete ' });
    assert.deepEqual([res.status, res.headers.get('location')], [303, '/training']);
    assert.equal(one('SELECT COUNT(*) AS n FROM knowledge WHERE id = ?', mistake.id).n, 0);
    assert.equal(one('SELECT COUNT(*) AS n FROM knowledge_versions WHERE knowledge_id = ?', mistake.id).n, 0);
    assert.match(one(`SELECT detail FROM audit WHERE action = 'knowledge_deleted'`).detail, /^Brand rule #\d+ "Claim language" \(all platforms\), 2 versions: Second version\.$/);
    assert.match(await page(admin, '/training'), /knowledge deleted, Brand rule #\d+ &quot;Claim language&quot;/);
  });

  await t.test('a rule a post or a draft used can only be deactivated', async () => {
    for (const entry of [used, inDraft]) {
      assert.match(await page(admin, `/knowledge/${entry.id}/delete`), /1 post, draft or suggestion used this compliance rule\. It can't be deleted/);
      assert.equal((await post(admin, `/knowledge/${entry.id}/delete`, { confirm: 'delete' })).status, 409);
      assert.ok(one('SELECT 1 FROM knowledge WHERE id = ?', entry.id));
    }
  });

  await t.test('a source goes with its saved versions, unless a post was checked against one', async () => {
    assert.match(await page(admin, '/sources'), /href="\/sources\/7\/delete">Delete…/);
    assert.match(await page(admin, '/sources/7/delete'), /permanently deletes this source and its 1 saved page version/);
    assert.equal((await post(admin, '/sources/7/delete', { confirm: 'nope' })).status, 400);
    const res = await post(admin, '/sources/7/delete', { confirm: 'delete' });
    assert.deepEqual([res.status, res.headers.get('location')], [303, '/sources']);
    assert.equal(one('SELECT COUNT(*) AS n FROM sources WHERE id = 7').n + one('SELECT COUNT(*) AS n FROM snapshots WHERE source_id = 7').n, 0);
    assert.equal(one(`SELECT detail FROM audit WHERE action = 'source_deleted'`).detail, 'compliance: https://who.int/, with 1 saved version');

    assert.match(await page(admin, '/sources/8/delete'), /1 post, draft or suggestion used a saved version of this page/);
    assert.equal((await post(admin, '/sources/8/delete', { confirm: 'delete' })).status, 409);
    assert.equal((await request(admin, '/sources/99/delete')).status, 404);
  });
});
