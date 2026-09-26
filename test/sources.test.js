import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-sources-'));
const { all, one, run } = await import('../db.js');
const s = await import('../sources.js');
const { htmlToText } = await import('../text.js');

run(`INSERT INTO users (id, email, name, pw_hash) VALUES (1, 'admin@example.com', 'Admin', 'x')`);

// Stand-in for the network: url → response, or a function for redirects.
let pages = {};
s.net.get = async (url) => {
  const page = pages[url.href];
  if (!page) return { status: 404, type: 'text/html', body: '' };
  return typeof page === 'function' ? page() : page;
};
const html = (body) => ({ status: 200, type: 'text/html', body: `<html><head><script>alert(1)</script></head><body>${body}</body></html>` });
const redirectTo = (location) => ({ status: 301, location, type: '', body: '' });

test('source links must be public https URLs', () => {
  for (const bad of ['http://regulator.example/x', 'https://user:pw@regulator.example/', 'https://10.0.0.1/', 'https://[::1]/',
    'https://regulator.example:8443/', 'https://intranet/', 'https://db.internal/x', `https://a.example/${'x'.repeat(500)}`, 'not a url']) {
    assert.throws(() => s.parseSourceUrl(bad), s.SourceError, bad);
  }
  assert.equal(s.parseSourceUrl(' https://Regulator.Example/claims#top ').href, 'https://regulator.example/claims');
});

test('private and reserved addresses are blocked at connect time', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'garbage']) {
    assert.equal(s.isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(s.isPrivateAddress(address), false, address);
  const error = await new Promise((resolve) => s.safeLookup('localhost', {}, resolve));
  assert.match(error.message, /private or reserved/);
});

test('web pages become plain text', () => {
  assert.equal(
    htmlToText('<style>p{}</style><h1>Health &amp; claims</h1><p>No &quot;cure&quot; claims&#33;</p><!-- hidden --><script>x()</script><ul><li>One</li><li>Two</li></ul>'),
    'Health & claims\nNo "cure" claims!\nOne\nTwo',
  );
});

test('fetching follows redirects only within the allowlist', async () => {
  const hosts = new Set(['regulator.example', 'www.regulator.example']);
  pages = {
    'https://regulator.example/a': redirectTo('https://www.regulator.example/a'),
    'https://www.regulator.example/a': html('<p>Guidance</p>'),
    'https://regulator.example/away': redirectTo('https://elsewhere.example/a'),
    'https://regulator.example/insecure': redirectTo('http://regulator.example/a'),
    'https://regulator.example/loop': redirectTo('/loop'),
    'https://regulator.example/doc': { status: 200, type: 'application/pdf', body: '%PDF' },
  };
  assert.equal(await s.fetchPage('https://regulator.example/a', hosts), 'Guidance');
  await assert.rejects(s.fetchPage('https://regulator.example/away', hosts), /elsewhere.example is not an approved source domain/);
  await assert.rejects(s.fetchPage('https://regulator.example/insecure', hosts), /non-https/);
  await assert.rejects(s.fetchPage('https://regulator.example/loop', hosts), /too many times/);
  await assert.rejects(s.fetchPage('https://regulator.example/doc', hosts), /PDF/);
  await assert.rejects(s.fetchPage('https://regulator.example/missing', hosts), /HTTP 404/);
  await assert.rejects(s.fetchPage('https://unlisted.example/a', hosts), /not an approved source domain/);
});

test('a changed page waits for admin approval before the compliance agent can use it', async () => {
  const id = s.addSource('https://regulator.example/claims', 'compliance', 1);
  const source = one('SELECT * FROM sources WHERE id = ?', id);
  const serve = (text) => { pages = { 'https://regulator.example/claims': html(`<p>${text}</p>`) }; };
  const statuses = () => all('SELECT status FROM snapshots ORDER BY id').map((r) => r.status);
  const inUse = () => s.approvedSnapshots().map((snap) => snap.text);

  serve('Version A');
  assert.equal(await s.checkSource(source), 'changed');
  assert.deepEqual(statuses(), ['pending']);
  assert.deepEqual(inUse(), [], 'a pending first version is not used');
  assert.equal(await s.checkSource(source), 'unchanged');
  assert.equal(s.decideSnapshot(1, true, 1), true);
  assert.deepEqual(inUse(), ['Version A']);

  serve('Version B');
  assert.equal(await s.checkSource(source), 'changed');
  assert.deepEqual(inUse(), ['Version A'], 'still the approved version while B is pending');
  serve('Version C');
  assert.equal(await s.checkSource(source), 'changed');
  assert.deepEqual(statuses(), ['approved', 'superseded', 'pending']);
  assert.equal(s.decideSnapshot(2, true, 1), false, 'a superseded version cannot be approved');
  assert.equal(s.decideSnapshot(3, false, 1), true);
  assert.deepEqual(inUse(), ['Version A'], 'a rejected version is never used');
  assert.equal(await s.checkSource(source), 'unchanged', 'a rejected version is not proposed again');

  serve('Version D');
  await s.checkSource(source);
  s.decideSnapshot(4, true, 1);
  assert.deepEqual(inUse(), ['Version D']);

  pages = {};
  assert.equal(await s.checkSource(source), 'error');
  assert.match(one('SELECT last_error FROM sources WHERE id = ?', id).last_error, /HTTP 404/);
  assert.equal(all('SELECT id FROM snapshots').length, 4, 'a failed fetch creates no snapshot');

  s.setSourceActive(id, false, 1);
  assert.deepEqual(inUse(), [], 'a deactivated source is not used');
  s.setSourceActive(id, true, 1);

  const actions = all('SELECT action FROM audit').map((a) => a.action);
  for (const action of ['source_added', 'snapshot_changed', 'snapshot_approved', 'snapshot_rejected', 'source_deactivated']) {
    assert.ok(actions.includes(action), action);
  }
});

test('trend sources set the allowed domains', () => {
  assert.throws(() => s.addSource('https://trends.example/health', 'news', 1), /compliance" or "trends/);
  s.addSource('https://trends.example/health', 'trends', 1);
  assert.throws(() => s.addSource('https://trends.example/health', 'trends', 1), /already a source/);
  assert.deepEqual(s.trendSources().map((t) => t.host), ['trends.example']);
  assert.ok(s.allowedHosts().has('trends.example') && s.allowedHosts().has('regulator.example'));
});
