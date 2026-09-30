import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-carousels-'));
process.env.PUBLIC_BASE_URL = 'http://app.test';
process.env.DRY_RUN_CHANNELS = 'website,instagram,linkedin,x';
process.env.GEMINI_API_KEY = 'test-key';
process.env.GLASS_SLIDES_URL = 'https://glass.example/';

const { handler, addUser } = await import('../server.js');
const { ai } = await import('../ai.js');
const { gemini } = await import('../gemini.js');
const { all, one, run } = await import('../db.js');
const { CAROUSEL_CHECKLIST } = await import('../text.js');
const { agentOf, glassProblems, jpeg, PNG, slideSet, zip } = await import('./fixtures.js');

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct horse battery staple';
let base;
let server;

// Scripted agents: every post and carousel passes; `verdicts` can queue compliance answers.
const reply = (content, stop_reason = 'end_turn') => ({ content, stop_reason, usage: { input_tokens: 1000, output_tokens: 200 } });
const json = (value) => reply([{ type: 'text', text: JSON.stringify(value) }]);
const seen = [];
const verdicts = [];
ai.ask = async (params) => {
  const agent = agentOf(params);
  seen.push(agent);
  if (agent === 'post writer') {
    return reply([{ type: 'tool_use', id: `toolu_${seen.length}`, name: 'submit_post', input: { text: 'Iron helps. General information, not medical advice. #Iron' } }], 'tool_use');
  }
  if (agent === 'compliance') return json(verdicts.shift() ?? { approved: true, issues: [] });
  if (agent === 'audit') return json({ approved: true, issues: [] });
  if (agent === 'carousel writer') return json(slideSet(5));
  if (agent === 'picture check') return json({ ok: true, problems: [] });
  return json({ slides: Array.from({ length: 5 }, () => ({ ok: true, note: '' })) });
};
const briefs = [];
gemini.picture = async (prompt) => {
  briefs.push(/Scene: (.*)/.exec(prompt)[1]);
  return { bytes: PNG, type: 'image/png', usage: { input: 250, output: 1120 } };
};

before(async () => {
  server = createServer(handler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const request = (cookie, path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init, headers: { cookie, ...init.headers } });
const post = (cookie, path, fields, headers = { origin: ORIGIN }) => request(cookie, path, { method: 'POST', headers, body: new URLSearchParams(fields) });
const page = async (cookie, path) => (await request(cookie, path)).text();

async function login(email) {
  const res = await post('', '/login', { email, password: PASSWORD });
  assert.equal(res.status, 303, `login ${email}`);
  return res.headers.get('set-cookie').split(';')[0];
}

async function upload(cookie, path, files) {
  const form = new FormData();
  for (const { name, bytes, type = 'image/jpeg' } of files) form.append('slides', new Blob([bytes], { type }), name);
  const encoded = new Request('http://encode.test', { method: 'POST', body: form });
  return request(cookie, path, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': encoded.headers.get('content-type') },
    body: Buffer.from(await encoded.arrayBuffer()),
  });
}

async function until(check) {
  for (const deadline = Date.now() + 5000; !check();) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const carousel = () => one('SELECT * FROM carousels WHERE id = 1');
const settled = () => until(() => carousel().status !== 'working');
const slides = () => JSON.parse(carousel().slides);
const fields = (change = {}) => ({
  ...Object.fromEntries(slides().flatMap((s, i) => [[`heading_${i}`, s.heading], [`body_${i}`, s.body], [`brief_${i}`, s.brief]])),
  ...change,
});
const ticks = (keys = CAROUSEL_CHECKLIST.map(([key]) => key)) => Object.fromEntries(keys.map((key) => [`check_${key}`, '1']));
const finishedSlides = (n, name = (i) => `Iron-and-energy-carousel-copy-${String(i + 1).padStart(2, '0')}.jpg`) =>
  Array.from({ length: n }, (_, i) => ({ name: name(i), bytes: jpeg(1080, 1350, 100 + i) }));

test('a reviewer turns the Instagram post into a carousel, designs it in Glass Slides and marks it ready', async (t) => {
  await addUser({ name: 'Ada Admin', email: 'admin@example.com', is_admin: 1 }, PASSWORD);
  await addUser({ name: 'Wen Writer', email: 'writer@example.com', can_write: 1 }, PASSWORD);
  const reviewerId = await addUser({ name: 'Rae Reviewer', email: 'reviewer@example.com', can_review: 1 }, PASSWORD);
  await addUser({ name: 'Oli Other', email: 'other@example.com', can_review: 1 }, PASSWORD);
  await addUser({ name: 'Pat Publisher', email: 'publisher@example.com', can_publish: 1 }, PASSWORD);
  run(`UPDATE users SET sign_name = 'Dr. Rae', sign_credentials = 'MBBS', sign_photo = 'photo.jpg' WHERE can_review = 1`);
  const [admin, writer, reviewer, other, publisher] = await Promise.all(['admin', 'writer', 'reviewer', 'other', 'publisher'].map((r) => login(`${r}@example.com`)));

  assert.equal((await post(writer, '/articles', { title: 'Iron and energy', body: 'Iron matters.\n\nEat leafy greens.' })).status, 303);
  assert.equal((await post(admin, '/articles/1', { action: 'assign', reviewer_id: reviewerId })).status, 303);
  assert.equal((await post(reviewer, '/articles/1', { action: 'approve', title: 'Iron and energy', body: 'Iron matters.\n\nEat leafy greens.' })).status, 303);
  await until(() => !one(`SELECT 1 FROM items WHERE status = 'generating'`));
  const item = (channel) => one('SELECT * FROM items WHERE channel = ?', channel);
  const ig = item('instagram').id;

  await t.test('carousels are off by default; only the assigned reviewer turns one on, and only for Instagram', async () => {
    assert.equal(one('SELECT COUNT(*) AS n FROM carousels').n, 0, 'approving the article makes no carousel');
    assert.ok(!seen.includes('carousel writer') && !briefs.length, 'and spends nothing on one');
    // The toggle lives on the Instagram post's own page, as a switch row.
    assert.match(await page(reviewer, `/items/${ig}`),
      new RegExp(`<form method="post" action="/items/${ig}/carousel">\\s*<ul class="list"><li><button class="row toggle" name="carousel" value="on" aria-pressed="false">`));
    assert.doesNotMatch(await page(writer, `/items/${ig}`), /class="row toggle"/, 'only the reviewer sees the toggle');
    assert.equal((await post(writer, `/items/${ig}/carousel`, { carousel: 'on' })).status, 403);
    assert.equal((await post(reviewer, `/items/${item('linkedin').id}/carousel`, { carousel: 'on' })).status, 400);
    assert.equal((await post(reviewer, `/items/${ig}/carousel`, { carousel: 'on' }, {})).status, 403, 'cross-site');
    assert.equal((await post(reviewer, `/items/${ig}/carousel`, {})).status, 400, 'the toggle says on or off');
    assert.equal(one('SELECT COUNT(*) AS n FROM carousels').n, 0);

    const res = await post(reviewer, `/items/${ig}/carousel`, { carousel: 'on' });
    assert.equal(res.headers.get('location'), '/carousels/1');
    await settled();
    assert.equal(carousel().status, 'ready', carousel().error);
    assert.equal(briefs.length, 5);
    assert.match(await page(reviewer, `/items/${ig}`), /<button class="row toggle" name="carousel" value="off" aria-pressed="true">/);
    assert.match(await page(reviewer, '/articles/1'), /Rae Reviewer turned on the Instagram carousel/);

    // Turning it on again makes nothing new.
    const writerCalls = seen.filter((a) => a === 'carousel writer').length;
    assert.equal((await post(reviewer, `/items/${ig}/carousel`, { carousel: 'on' })).headers.get('location'), '/carousels/1');
    assert.equal(seen.filter((a) => a === 'carousel writer').length, writerCalls);
  });

  await t.test('the carousel page shows the slides, their pictures and the ways into Glass Slides', async () => {
    const res = await request(reviewer, '/carousels/1');
    assert.match(res.headers.get('content-security-policy'), /form-action 'self' https:\/\/glass\.example;/);
    const html = await res.text();
    assert.equal((html.match(/<img src="\/carousels\/1\/pictures\/pic-[0-9a-f-]{36}\.png"/g) ?? []).length, 5);
    assert.match(html, /<form method="post" action="\/carousels\/1\/link" target="_blank"><button class="btn wide">Open in Glass Slides<\/button><\/form>/);
    assert.match(html, /href="\/carousels\/1\/deck\.json"/);
    assert.match(html, /name="heading_4" value="Point 4: iron and your day"/);
    assert.match(await page(reviewer, `/items/${ig}`), /<a class="row" href="\/carousels\/1">[\s\S]*?Carousel of 5 slides/);
    assert.match(await page(reviewer, '/articles/1'), new RegExp(`href="/items/${ig}"[\\s\\S]*?Carousel of 5 slides`), 'the article lists it');
    assert.match(await page(writer, '/carousels/1'), /Instagram carousel/, 'the author can look');
    assert.doesNotMatch(await page(writer, '/carousels/1'), /Save and check/, '…but not change it');
    assert.equal((await request(other, '/carousels/1')).status, 403);
  });

  await t.test('pictures are private to the people who can see the article', async () => {
    const path = `/carousels/1/pictures/${slides()[0].picture}`;
    const res = await request(reviewer, path);
    assert.deepEqual([res.status, res.headers.get('content-type'), res.headers.get('cache-control')], [200, 'image/png', 'private, max-age=3600']);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    assert.equal((await request(other, path)).status, 403);
    assert.equal((await request('', path)).headers.get('location'), '/login');
    assert.equal((await request(reviewer, '/carousels/1/pictures/pic-00000000-0000-0000-0000-000000000000.png')).status, 404);
    assert.equal((await request('', `/media/${path.split('/').pop()}`)).status, 404, 'never through the public media route');
  });

  await t.test('the deck file downloads, and loads by Glass Slides rules with the pictures embedded', async () => {
    const res = await request(reviewer, '/carousels/1/deck.json');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="iron-and-energy-1-carousel.json"');
    const deck = await res.json();
    assert.deepEqual(glassProblems(deck), []);
    assert.equal(deck.slides.length, 5);
    assert.ok(deck.slides.every((s) => s.els[0].src === `data:image/png;base64,${PNG.toString('base64')}`));
  });

  let token;
  await t.test('Open in Glass Slides: a 30-minute link only the editor may read, replaced by the next one', async () => {
    const res = await post(reviewer, '/carousels/1/link', {});
    assert.equal(res.status, 303);
    const link = new URL(res.headers.get('location'));
    assert.equal(`${link.origin}${link.pathname}`, 'https://glass.example/');
    assert.equal(link.searchParams.get('s'), 'http://app.test/glass');
    token = link.searchParams.get('t');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Number(carousel().link_expires) - Date.now() > 29 * 60 * 1000);
    assert.notEqual(carousel().link_hash, token, 'only a hash is stored');

    const deck = await request('', `/glass/t/${token}`);
    assert.deepEqual([deck.status, deck.headers.get('access-control-allow-origin'), deck.headers.get('cache-control')], [200, 'https://glass.example', 'no-store']);
    assert.equal((await deck.json()).slides.length, 5);
    const wrong = await request('', `/glass/t/${'A'.repeat(43)}`);
    assert.deepEqual([wrong.status, wrong.headers.get('access-control-allow-origin')], [404, 'https://glass.example']);

    const next = new URL((await post(reviewer, '/carousels/1/link', {})).headers.get('location')).searchParams.get('t');
    assert.equal((await request('', `/glass/t/${token}`)).status, 404, 'the old link stops working');
    run('UPDATE carousels SET link_expires = ? WHERE id = 1', Date.now() - 1);
    assert.equal((await request('', `/glass/t/${next}`)).status, 404, 'an expired link stops working');
  });

  await t.test('edited wording goes back to the compliance agent; a new picture uses the edited brief', async () => {
    const reviews = seen.filter((a) => a === 'compliance').length;
    assert.equal((await post(reviewer, '/carousels/1', { ...fields({ heading_1: 'x'.repeat(61) }), action: 'save' })).status, 400);
    assert.equal((await post(reviewer, '/carousels/1', { ...fields(), action: 'save' })).status, 400, 'nothing changed');
    assert.equal((await post(writer, '/carousels/1', { ...fields({ heading_1: 'Iron and tiredness' }), action: 'save' })).status, 403);

    verdicts.push({ approved: false, issues: ['Slide 2 now says "always", which the article does not.'] });
    assert.equal((await post(reviewer, '/carousels/1', { ...fields({ heading_1: 'Iron always helps' }), action: 'save' })).status, 303);
    await settled();
    assert.equal(carousel().status, 'needs_attention');
    assert.match(await page(reviewer, '/carousels/1'), /Slide 2 now says &quot;always&quot;/);
    assert.equal((await post(reviewer, '/carousels/1', { ...fields({ heading_1: 'Iron and tiredness' }), action: 'save' })).status, 303);
    await settled();
    assert.equal(carousel().status, 'ready');
    assert.equal(slides()[1].heading, 'Iron and tiredness');
    assert.equal(seen.filter((a) => a === 'compliance').length, reviews + 2);

    const old = slides()[2].picture;
    assert.equal((await post(reviewer, '/carousels/1', { ...fields({ brief_2: 'A bowl of lentils in morning light', heading_0: 'Changed' }), action: 'picture_2' })).status, 400);
    assert.equal((await post(reviewer, '/carousels/1', { ...fields({ brief_2: 'A bowl of lentils in morning light' }), action: 'picture_2' })).status, 303);
    await settled();
    assert.equal(briefs.at(-1), 'A bowl of lentils in morning light');
    assert.notEqual(slides()[2].picture, old);
  });

  await t.test('the finished slides upload as the Glass Slides zip, and the final text check reads them', async () => {
    const res = await upload(reviewer, '/carousels/1/slides', [{ name: 'deck.zip', bytes: await zip(finishedSlides(4)), type: 'application/zip' }]);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /This carousel has 5 slides, but the upload has 4/);
    assert.equal((await upload(reviewer, '/carousels/1/slides', finishedSlides(5).map((f) => ({ ...f, bytes: jpeg(1080, 1080) })))).status, 400);
    assert.equal((await upload(writer, '/carousels/1/slides', finishedSlides(5))).status, 403);

    assert.equal((await upload(reviewer, '/carousels/1/slides', [{ name: 'deck.zip', bytes: await zip(finishedSlides(5).reverse()), type: 'application/zip' }])).status, 303);
    await settled();
    const c = carousel();
    assert.equal(c.status, 'ready', c.error);
    const finals = JSON.parse(c.finals);
    assert.equal(finals.length, 5);
    assert.deepEqual(JSON.parse(c.final_check).map((r) => r.ok), [true, true, true, true, true]);
    const media = await request('', `/media/${finals[0]}`);
    assert.equal(media.headers.get('content-type'), 'image/jpeg', 'finished slides are public, for Instagram');
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), jpeg(1080, 1350, 100), 'in slide order');
    assert.match(await page(reviewer, '/carousels/1'), /The final text check found that every slide matches the approved text/);
  });

  await t.test('Mark ready needs every checklist box, and the ticks go into the history', async () => {
    const html = await page(reviewer, `/items/${ig}`);
    assert.equal((html.match(/<input type="checkbox" name="check_/g) ?? []).length, CAROUSEL_CHECKLIST.length);
    assert.equal((html.match(/<img src="\/media\/[0-9a-f-]{36}\.jpg" alt="Finished slide/g) ?? []).length, 5);

    const body = item('instagram').body;
    const missing = await post(reviewer, `/items/${ig}`, { action: 'ready', body, ...ticks(['no_text', 'medical']) });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /Tick every box in the image checklist \(5 not ticked\)/);
    assert.equal((await post(reviewer, `/items/${ig}`, { action: 'ready', body, ...ticks() })).status, 303);
    assert.equal(item('instagram').status, 'ready');
    assert.deepEqual(JSON.parse(carousel().checklist).ticks, CAROUSEL_CHECKLIST.map(([key]) => key));
    assert.equal(one(`SELECT detail FROM events WHERE action = 'carousel_checked'`).detail,
      '7 of 7 boxes ticked for 5 slides; the picture check flagged 0 pictures and the final text check 0 slides');
    assert.match(await page(reviewer, '/articles/1'), /Rae Reviewer ticked the carousel image checklist: 7 of 7 boxes/);

    // A new upload undoes "ready": the reviewer ticks the boxes again for the new slides.
    assert.equal((await upload(reviewer, '/carousels/1/slides', finishedSlides(5))).status, 303);
    await settled();
    assert.deepEqual([item('instagram').status, carousel().checklist], ['draft', null]);
    assert.equal((await post(reviewer, `/items/${ig}`, { action: 'ready', body, ...ticks() })).status, 303);
  });

  await t.test('the publisher publishes the carousel (simulated in trial mode)', async () => {
    for (const channel of ['linkedin', 'x']) {
      assert.equal((await post(reviewer, `/items/${item(channel).id}`, { action: 'ready', body: item(channel).body })).status, 303);
    }
    assert.equal(one('SELECT status FROM articles WHERE id = 1').status, 'awaiting_publisher');
    assert.match(await page(publisher, `/items/${ig}`), /Publish to Instagram \(simulated\)/);
    assert.equal((await post(publisher, `/items/${ig}`, { action: 'publish' })).status, 303);
    assert.deepEqual({ ...one('SELECT status, simulated FROM items WHERE id = ?', ig) }, { status: 'published', simulated: 1 });
    assert.equal((await post(reviewer, '/carousels/1', { action: 'restart' })).status, 409, 'nothing changes once it has moved on');
  });

  await t.test('the Training page counts carousels per carousel, Gemini pictures included', async () => {
    const html = await page(admin, '/training');
    assert.match(html, /<span class="row-title">Carousel agent<\/span>\s*<span class="row-sub"><span>gemini-3\.1-flash-image<\/span><span class="sep"><\/span><span>6 calls<\/span>/);
    assert.match(html, /<span class="row-title">Carousel agent<\/span>\s*<span class="row-sub"><span>claude-sonnet-5<\/span>/);
    assert.match(html, /<span class="row-title">Carousel agent<\/span>\s*<span class="row-sub"><span>claude-opus-5-5<\/span>/);
    assert.match(html, /Carousels: \$0\.\d\d and 1 min each on average \(until first ready\), over 1 carousel\./);
  });
});

test('turning the carousel off removes it and goes back to a single image; turning it on makes it again', async () => {
  const reviewer = await login('reviewer@example.com');
  const admin = await login('admin@example.com');
  const writer = await login('writer@example.com');
  const reviewerId = one(`SELECT id FROM users WHERE email = 'reviewer@example.com'`).id;
  assert.equal((await post(writer, '/articles', { title: 'Sleep and iron', body: 'Sleep matters.' })).status, 303);
  assert.equal((await post(admin, '/articles/2', { action: 'assign', reviewer_id: reviewerId })).status, 303);
  assert.equal((await post(reviewer, '/articles/2', { action: 'approve', title: 'Sleep and iron', body: 'Sleep matters.' })).status, 303);
  await until(() => !one(`SELECT 1 FROM items WHERE status = 'generating'`));
  const ig = one(`SELECT id FROM items WHERE article_id = 2 AND channel = 'instagram'`).id;
  const toggle = (value) => post(reviewer, `/items/${ig}/carousel`, { carousel: value });
  const status = (id) => one('SELECT status FROM carousels WHERE id = ?', id).status;
  const id = Number((await toggle('on')).headers.get('location').split('/').pop());
  await until(() => status(id) !== 'working');
  const pictures = JSON.parse(one('SELECT slides FROM carousels WHERE id = ?', id).slides).map((s) => s.picture);

  // Not while it is being made: the job would keep spending on a carousel nobody sees.
  run(`UPDATE carousels SET status = 'working' WHERE id = ?`, id);
  assert.match(await page(reviewer, `/items/${ig}`), /aria-pressed="true" disabled>/);
  assert.equal((await toggle('off')).status, 409);
  run(`UPDATE carousels SET status = 'ready' WHERE id = ?`, id);

  assert.equal((await toggle('off')).headers.get('location'), `/items/${ig}`, 'back to the Instagram post');
  assert.equal(status(id), 'discarded');
  const html = await page(reviewer, `/items/${ig}`);
  assert.match(html, /Upload JPEG/);
  assert.match(html, /<button class="row toggle" name="carousel" value="on" aria-pressed="false">/);
  assert.equal((await request(reviewer, `/carousels/${id}/pictures/${pictures[0]}`)).status, 404, 'its pictures are gone');
  assert.equal((await toggle('off')).headers.get('location'), `/items/${ig}`, 'turning it off again changes nothing');

  assert.equal((await toggle('on')).headers.get('location'), `/carousels/${id}`, 'made again in the same place');
  await until(() => status(id) !== 'working');
  assert.equal(status(id), 'ready');
  assert.equal((await post(reviewer, `/carousels/${id}`, { action: 'discard' })).headers.get('location'), `/items/${ig}`, 'the carousel page can turn it off too');
  assert.equal(status(id), 'discarded');
  assert.deepEqual(all(`SELECT action FROM events WHERE article_id = 2 AND action LIKE 'carousel%' ORDER BY id`).map((e) => e.action),
    ['carousel', 'carousel_removed', 'carousel', 'carousel_removed']);
  assert.match(await page(reviewer, '/articles/2'), /Rae Reviewer turned off the Instagram carousel/);
});
