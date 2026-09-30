import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-website-'));
process.env.PUBLIC_BASE_URL = 'http://app.test';
process.env.DRY_RUN_CHANNELS = 'instagram,linkedin,x';
process.env.GEMINI_API_KEY = 'test-key';
process.env.WEBSITE_WEBHOOK_SECRET = 'test-secret';

const { handler, addUser } = await import('../server.js');
const { ai } = await import('../ai.js');
const { gemini } = await import('../gemini.js');
const { all, one, UPLOADS } = await import('../db.js');
const { agentOf, jpeg, multipart, picture, PNG, table } = await import('./fixtures.js');

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct horse battery staple';
let base;
let server;
let site;
const hooks = [];

// Scripted agents: posts and reviews pass; the second picture check flags text, so that picture is made again.
const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } });
let checks = 0;
ai.ask = async (params) => {
  const agent = agentOf(params);
  if (agent === 'post writer') {
    return { content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_post', input: { text: 'PCOS care. General information, not medical advice.' } }], stop_reason: 'tool_use', usage: {} };
  }
  if (agent === 'picture check') {
    return json(++checks === 2 ? { ok: false, problems: [{ kind: 'text', note: 'Garbled letters on a sign.' }] } : { ok: true, problems: [] });
  }
  return json({ approved: true, issues: [] });
};
const prompts = [];
gemini.picture = async (prompt, options) => {
  prompts.push({ prompt, options });
  return { bytes: PNG, type: 'image/png', usage: { input: 200, output: 1120 } };
};

before(async () => {
  server = createServer(handler).listen(0, '127.0.0.1');
  site = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      hooks.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://www.tvarvi.com/blog/pcos' }));
    });
  }).listen(0, '127.0.0.1');
  await Promise.all([server, site].map((s) => new Promise((resolve) => s.once('listening', resolve))));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.WEBSITE_WEBHOOK_URL = `http://127.0.0.1:${site.address().port}/hook`;
});
after(() => {
  server.close();
  site.close();
});

const request = (cookie, path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init, headers: { cookie, ...init.headers } });
const post = (cookie, path, fields) => request(cookie, path, { method: 'POST', headers: { origin: ORIGIN }, body: new URLSearchParams(fields) });

async function login(email) {
  const res = await post('', '/login', { email, password: PASSWORD });
  return res.headers.get('set-cookie').split(';')[0];
}

async function until(check) {
  for (const deadline = Date.now() + 5000; !check();) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const BODY = [
  '## Tvarvi Key Takeaways', '', ...['Basics', 'Food', 'Help'].flatMap((h) => [`- ${h}`, '  - One.', '  - Two.', '  - Three.']), '',
  '## What PCOS is', '', 'PCOS — a common condition — affects many women [1]. If you would like to talk to a gynaecologist about your cycle, you can book a consultation with Tvarvi.', '', picture(1), '',
  '## What research says', '', 'Text.', '', picture(2), '',
  '## Daily life', '', 'Text.', '', picture(3), '',
  '## Care options', '', 'Text.', '', table(1), '',
  '## Getting help', '', 'Text.', '', table(2), '',
  '## Frequently asked questions', '', '### Q: Should I see a doctor?', 'Yes, if your cycles are irregular.', '',
  '## References', '', '1. WHO fact sheet. https://www.who.int/pcos (accessed 2026-09-27)',
].join('\n');

test('an approved article gets its 3 Gemini pictures, the doctor’s byline and the disclaimer on the website', async (t) => {
  await addUser({ name: 'Ada Admin', email: 'admin@example.com', is_admin: 1 }, PASSWORD);
  await addUser({ name: 'Wen Writer', email: 'writer@example.com', can_write: 1 }, PASSWORD);
  const reviewerId = await addUser({ name: 'Dr Mehra', email: 'doctor@example.com', can_review: 1, can_publish: 1 }, PASSWORD);
  const [admin, writer, doctor] = await Promise.all(['admin', 'writer', 'doctor'].map((r) => login(`${r}@example.com`)));
  const [signing, type] = await multipart({ sign_name: 'Dr. Mehra', sign_credentials: 'MBBS, PGIMS Rohtak', photo: new Blob([jpeg(600, 600)]) });
  assert.equal((await request(doctor, '/account/signature', { method: 'POST', headers: { origin: ORIGIN, 'content-type': type }, body: signing })).status, 200);

  await t.test('em dashes are gone from the article as soon as it is submitted', async () => {
    assert.equal((await post(writer, '/articles', { title: 'PCOS — what to know', body: BODY })).status, 303);
    const a = one('SELECT title, body FROM articles WHERE id = 1');
    assert.equal(a.title, 'PCOS, what to know');
    assert.match(a.body, /PCOS, a common condition, affects many women \[1\]\./);
    assert.doesNotMatch(`${a.title}${a.body}`, /—/);
  });

  let item;
  await t.test('approval signs the article and Gemini makes one checked picture per picture block', async () => {
    assert.equal((await post(admin, '/articles/1', { action: 'assign', reviewer_id: reviewerId })).status, 303);
    const { body } = one('SELECT body FROM articles WHERE id = 1');
    assert.equal((await post(doctor, '/articles/1', { action: 'approve', title: 'PCOS, what to know', body })).status, 303);
    await until(() => !one(`SELECT 1 FROM items WHERE status = 'generating'`));
    item = one(`SELECT * FROM items WHERE channel = 'website'`);
    assert.equal(item.status, 'draft', item.error);
    const pictures = JSON.parse(item.pictures);
    assert.deepEqual(pictures.map((p) => [p.n, p.title, p.alt, p.ok, p.tries]), [
      [1, 'A calm morning 1', 'A woman choosing vegetables', true, 1],
      [2, 'A calm morning 2', 'A woman choosing vegetables', true, 2],
      [3, 'A calm morning 3', 'A woman choosing vegetables', true, 1],
    ]);
    assert.ok(pictures.every((p) => /^pic-[0-9a-f-]{36}\.png$/.test(p.file) && existsSync(join(UPLOADS, p.file))));
    assert.equal(prompts.length, 4);
    assert.deepEqual(prompts[0].options, { model: 'gemini-3.1-flash-image', aspectRatio: '16:9' });
    assert.match(prompts[0].prompt, /Picture: A woman in her thirties choosing vegetables[\s\S]*Any people are illustrated, never photorealistic/);
    assert.match(prompts[2].prompt, /avoid them: Garbled letters on a sign\./);
    assert.match(item.ai_notes, /^3 of 3 pictures made, and all passed the picture check\./);
    assert.equal(one(`SELECT COUNT(*) AS n FROM ai_calls WHERE agent = 'Website pictures'`).n, 4);
  });

  await t.test('the pictures stay private until the article is published', async () => {
    const [first] = JSON.parse(item.pictures);
    const res = await request(doctor, `/items/${item.id}/pictures/${first.file}`);
    assert.deepEqual([res.status, res.headers.get('content-type'), res.headers.get('cache-control')], [200, 'image/png', 'private, max-age=3600']);
    assert.equal((await request(writer, `/items/${item.id}/pictures/${first.file}`)).status, 200, 'the author can see the article');
    assert.equal((await request('', `/media/${first.file}`)).status, 404);
    assert.equal((await request(doctor, `/items/${item.id}/pictures/pic-00000000-0000-0000-0000-000000000000.png`)).status, 404);
    // The website article's own page: the byline as the website shows it, and each picture with New picture.
    const html = await (await request(doctor, `/items/${item.id}`)).text();
    assert.match(html, /<span class="sig-label">Medically reviewed by<\/span><span class="sig-name">Dr\. Mehra, MBBS, PGIMS Rohtak<\/span>/);
    assert.equal((html.match(/<button class="btn secondary small" name="action" value="picture_\d">/g) ?? []).length, 3);
    assert.match(html, new RegExp(`<img src="/items/${item.id}/pictures/${first.file}" alt="A woman choosing vegetables">`), 'the preview shows the private pictures');
    assert.match(await (await request(doctor, '/articles/1')).text(), new RegExp(`<a class="row" href="/items/${item.id}">[\\s\\S]*?3 pictures`));
  });

  await t.test('only the reviewer asks for a new picture, which replaces just that one', async () => {
    const before = JSON.parse(item.pictures);
    assert.equal((await post(writer, `/items/${item.id}`, { action: 'picture_2' })).status, 403);
    assert.equal((await post(doctor, `/items/${item.id}`, { action: 'picture_9' })).status, 400);
    assert.equal((await post(doctor, `/items/${item.id}`, { action: 'picture_2' })).status, 303);
    await until(() => one('SELECT status FROM items WHERE id = ?', item.id).status !== 'generating');
    item = one('SELECT * FROM items WHERE id = ?', item.id);
    const after = JSON.parse(item.pictures);
    assert.equal(prompts.length, 5);
    assert.equal(after[0].file, before[0].file);
    assert.notEqual(after[1].file, before[1].file);
    await until(() => !existsSync(join(UPLOADS, before[1].file))); // the replaced picture is deleted once the new one is saved
  });

  await t.test('publishing sends the byline, the pictures under public names and the disclaimer to the website', async () => {
    assert.equal((await post(doctor, `/items/${item.id}`, { action: 'ready' })).status, 303);
    const ig = one(`SELECT id FROM items WHERE channel = 'instagram'`).id;
    const form = new FormData();
    form.append('image', new Blob([jpeg()], { type: 'image/jpeg' }), 'photo.jpg');
    const encoded = new Request('http://encode.test', { method: 'POST', body: form });
    await request(doctor, `/items/${ig}/image`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': encoded.headers.get('content-type') }, body: Buffer.from(await encoded.arrayBuffer()) });
    for (const channel of ['instagram', 'linkedin', 'x']) {
      const post_ = one('SELECT id, body FROM items WHERE channel = ?', channel);
      assert.equal((await post(doctor, `/items/${post_.id}`, { action: 'ready', body: post_.body })).status, 303);
    }
    assert.equal((await post(doctor, `/items/${item.id}`, { action: 'publish' })).status, 303);
    assert.equal(one('SELECT status FROM items WHERE id = ?', item.id).status, 'published');

    assert.equal(hooks.length, 1);
    const { headers, body } = hooks[0];
    assert.match(headers['x-webhook-signature'], /^sha256=[0-9a-f]{64}$/);
    const signed = one('SELECT signed_at FROM articles WHERE id = 1').signed_at;
    const day = new Date(`${signed.replace(' ', 'T')}Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const photo = `http://app.test/media/${one('SELECT signature_photo FROM articles WHERE id = 1').signature_photo}`;
    assert.deepEqual(body.byline, { author: 'Wen Writer', reviewer: 'Dr. Mehra, MBBS, PGIMS Rohtak', reviewer_photo: photo, reviewed: day });
    assert.equal(body.title, 'PCOS, what to know');
    assert.ok(body.html.startsWith(`<p class="byline">Written by: Wen Writer<br><img class="reviewer-photo" src="${photo}" alt="" width="96" height="96" style="object-fit:cover"> Medically reviewed by: Dr. Mehra, MBBS, PGIMS Rohtak<br>Last reviewed: ${day}</p>\n<h2>Tvarvi Key Takeaways</h2>`));
    const served = await request('', photo.replace('http://app.test', ''));
    assert.deepEqual([served.status, served.headers.get('content-type')], [200, 'image/jpeg']);
    assert.match(body.html, /you can book a consultation with Tvarvi\.<\/p>/);
    assert.equal((body.html.match(/<a href/g) ?? []).length, 2, 'only the [1] marker and its References entry link out');
    assert.match(body.html, /affects many women <a href="https:\/\/www\.who\.int\/pcos">\[1\]<\/a>\./);
    assert.equal((body.html.match(/<table>/g) ?? []).length, 2);
    assert.doesNotMatch(body.html, /Description:|—/);
    assert.ok(body.html.endsWith('<p class="disclaimer">This article is for general information and awareness. It is not medical advice and does not replace a consultation with a qualified doctor. Please speak to a registered medical practitioner about your symptoms, tests or treatment. If you have very heavy bleeding, severe pain or feel unwell, seek medical care promptly.</p>'));

    assert.equal(body.pictures.length, 3);
    for (const p of body.pictures) {
      const name = p.url.replace('http://app.test/media/', '');
      assert.match(name, /^[0-9a-f-]{36}\.png$/);
      assert.ok(body.html.includes(`<img src="${p.url}" alt="A woman choosing vegetables">`));
      const res = await request('', `/media/${name}`);
      assert.deepEqual([res.status, res.headers.get('content-type')], [200, 'image/png']);
    }
    assert.ok(JSON.parse(one('SELECT pictures FROM items WHERE id = ?', item.id).pictures).every((p) => p.public), 'a retry reuses the public copies');
  });

  await t.test('the history records the signature and the pictures', async () => {
    const events = all('SELECT action, detail FROM events WHERE article_id = 1').map((e) => `${e.action}: ${e.detail}`);
    // The short test article fails the audit's free code checks (length, FAQs): reported, and approving went ahead.
    assert.ok(events.includes("approved: signed by Dr. Mehra, MBBS, PGIMS Rohtak; approved over the AI audit's issues"), events.join('\n'));
    assert.match(one('SELECT audit_notes FROM articles WHERE id = 1').audit_notes, /^- The article has \d+ words that readers read/);
    assert.ok(events.some((e) => e.startsWith('pictures_done: 3 of 3 pictures made')));
    assert.ok(events.includes('new_picture: website picture 2'));
  });
});

test('a signature photo keeps only the picture: PNG text and EXIF chunks go, and anything else is refused', async () => {
  const { cleanPhoto } = await import('../pictures.js');
  const chunk = (type, data = '') => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length);
    bytes.write(type + data, 4, 'latin1');
    return bytes;
  };
  const png = Buffer.concat([PNG.subarray(0, 8), chunk('IHDR', 'x'.repeat(13)), chunk('tEXt', 'GPS 28.6N'), chunk('eXIf', 'Exif'), chunk('IDAT', 'pixels'), chunk('IEND')]);
  const clean = cleanPhoto(png);
  assert.equal(clean.type, 'image/png');
  assert.ok(clean.bytes.includes('pixels') && !clean.bytes.includes('GPS') && !clean.bytes.includes('Exif'));
  for (const bad of [PNG, Buffer.from('GIF89a'), jpeg().subarray(0, 30), Buffer.alloc(0)]) assert.equal(cleanPhoto(bad), null);
});
