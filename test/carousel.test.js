import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-carousel-'));
process.env.GEMINI_API_KEY = 'test-key';
delete process.env.DRY_RUN_CHANNELS; // the publishing test posts for real, to a stubbed fetch

const { ai } = await import('../ai.js');
const { all, one, run, UPLOADS } = await import('../db.js');
const { gemini, PictureError } = await import('../gemini.js');
const carousel = await import('../carousel.js');
const { publishItem } = await import('../publish.js');
const { CAROUSEL_CHECKLIST } = await import('../text.js');
const { agentOf, glassProblems, jpeg, PNG, slideSet, zip } = await import('./fixtures.js');

const reply = (json) => ({ content: [{ type: 'text', text: JSON.stringify(json) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } });
const approve = () => reply({ approved: true, issues: [] });
const clean = () => reply({ ok: true, problems: [] });

// Scripted Claude and Gemini: each test sets `script`; Gemini draws a PNG unless `drawing` says otherwise.
let script;
ai.ask = async (params) => script(agentOf(params), params);
const prompts = [];
let drawing;
gemini.picture = async (prompt, options) => {
  prompts.push({ prompt, ...options });
  return drawing(prompts.length);
};
beforeEach(() => {
  prompts.length = 0;
  drawing = () => ({ bytes: PNG, type: 'image/png', usage: { input: 250, output: 1120 } });
});

run(`INSERT INTO users (id, email, name, pw_hash, can_review) VALUES (1, 'rae@example.com', 'Rae Reviewer', 'x', 1)`);
run(`INSERT INTO sources (id, url, host, kind) VALUES (1, 'https://regulator.example/', 'regulator.example', 'compliance')`);
run(`INSERT INTO snapshots (source_id, text, hash, status) VALUES (1, 'APPROVED GUIDANCE TEXT', 'h', 'approved')`);

// An approved article with its Instagram post; returns the post's id.
function newItem() {
  const articleId = run(`INSERT INTO articles (title, body, author_id, reviewer_id, status) VALUES ('Iron and energy', 'Iron matters. Eat leafy greens.', 1, 1, 'approved')`).lastInsertRowid;
  return Number(run(`INSERT INTO items (article_id, channel, status, body) VALUES (?, 'instagram', 'draft', 'Caption #Iron')`, articleId).lastInsertRowid);
}

async function settled(id) {
  for (const deadline = Date.now() + 5000; one('SELECT status FROM carousels WHERE id = ?', id).status === 'working';) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return carousel.getCarousel(id);
}

const slideOf = (params) => Number(/<slide number="(\d+)">/.exec(params.messages[0].content.at(-1).text)[1]);
const calls = (id) => Object.fromEntries(all('SELECT agent, COUNT(*) AS n FROM ai_calls WHERE carousel_id = ? GROUP BY agent', id).map((r) => [r.agent, r.n]));

test('slide text is checked in code and by the compliance agent; each picture is made, checked and retried', async () => {
  const versions = [slideSet(4), slideSet(6), slideSet(6)];
  const verdicts = [{ approved: false, issues: ['Slide 3 overstates the article.'] }, { approved: true, issues: [] }];
  const requests = { writer: [], compliance: [] };
  const checks = {};
  script = (agent, params) => {
    // The conversation grows after each call, so the message each call ended with is kept as it was then.
    if (agent === 'carousel writer') return requests.writer.push({ ...params, last: params.messages.at(-1).content }) && reply(versions.shift());
    if (agent === 'compliance') return requests.compliance.push(params) && reply(verdicts.shift());
    assert.equal(agent, 'picture check');
    const n = slideOf(params);
    const k = (checks[n] = (checks[n] ?? 0) + 1);
    if (n === 2 && k === 1) return reply({ ok: false, problems: [{ kind: 'text', note: 'Garbled letters on the jar label.' }] });
    if (n === 4) {
      const face = { kind: 'person', note: 'A clear face.' };
      return reply({ ok: false, problems: k === 2 ? [face] : [face, { kind: 'text', note: 'A sign with words.' }] });
    }
    return clean();
  };

  const id = carousel.startCarousel(newItem(), 1);
  const c = await settled(id);
  assert.equal(c.status, 'ready', c.error);

  // The writer: Sonnet 5 with structured output; too few slides and the compliance issue go back to it.
  assert.equal(requests.writer.length, 3);
  assert.equal(requests.writer[0].model, 'claude-sonnet-5');
  assert.ok(requests.writer[0].output_config.format.schema.properties.slides);
  assert.match(requests.writer[1].last, /Write 5 to 10 slides \(there are 4\)/);
  assert.match(requests.writer[2].last, /Slide 3 overstates the article/);
  // The compliance agent: Opus 5.5, with the approved regulator snapshot and every slide.
  assert.equal(requests.compliance.length, 2);
  assert.equal(requests.compliance[0].model, 'claude-opus-5-5');
  assert.match(requests.compliance[0].system.map((b) => b.text).join('\n'), /APPROVED GUIDANCE TEXT/);
  assert.match(requests.compliance[0].messages[0].content, /<slide number="6">/);
  assert.deepEqual([c.compliance_ok, c.notes], [1, 'Passed the code checks and the AI medical-compliance review (round 2).']);

  // Pictures: one per slide at 4:5, plus one retry for slide 2 and two for slide 4, each prompt forbidding text.
  assert.equal(prompts.length, 9);
  assert.ok(prompts.every((p) => p.aspectRatio === '4:5' && p.model === 'gemini-3.1-flash-image' && /no text of any kind/.test(p.prompt)));
  assert.ok(prompts.some((p) => /slide 2 of 6[\s\S]*avoid them: Garbled letters on the jar label\./.test(p.prompt)), 'a retry passes on the check notes');
  assert.deepEqual(c.slides.map((s) => [s.check.ok, s.check.tries]), [[true, 1], [true, 2], [true, 1], [false, 2], [true, 1], [true, 1]]);
  assert.deepEqual(c.slides[3].check.notes, ['Identifiable person: A clear face.'], 'keeps the picture with the fewest problems');
  for (const s of c.slides) assert.deepEqual(readFileSync(join(UPLOADS, s.picture)), PNG);
  assert.deepEqual(calls(id), { 'Carousel compliance': 2, 'Carousel picture check': 9, 'Carousel pictures': 9, 'Carousel writer': 3 });
  assert.match(c.log, /Checks: 1 problem to fix[\s\S]*Compliance review 1: 1 issue[\s\S]*Slide 2, picture 1 flagged: Text in the picture[\s\S]*Done: ready/);
  // 3 writer calls ($0.004 each), 2 reviews ($0.008), 9 checks ($0.004) and 9 Flash Image pictures ($0.0673).
  assert.equal(c.cost.toFixed(2), '0.67');

  // The final text check reads every finished slide next to its approved text; it advises, the reviewer decides.
  let finalRequest;
  script = (agent, params) => {
    assert.equal(agent, 'final check');
    finalRequest = params;
    return reply({ slides: c.slides.map((_, i) => (i === 2 ? { ok: false, note: 'Says "fixes" where the approved text says "helps".' } : { ok: true, note: '' })) });
  };
  await carousel.saveFinals(c, c.slides.map(() => jpeg()));
  const done = await settled(id);
  assert.equal(done.status, 'ready', done.error);
  assert.equal(finalRequest.model, 'claude-sonnet-5');
  assert.equal(finalRequest.messages[0].content.filter((b) => b.type === 'image').length, 6);
  assert.match(finalRequest.messages[0].content[0].text, /<approved_slide number="1">\n<heading>Iron and energy: what to know<\/heading>/);
  assert.deepEqual(done.final_check.map((r) => r.ok), [true, true, false, true, true, true]);
  assert.match(done.log, /Final text check: 1 slide to look at/);
  assert.ok(done.finals.every((name) => existsSync(join(UPLOADS, name))));

  assert.deepEqual(carousel.readyProblems(done, []), ['Tick every box in the image checklist (7 not ticked).']);
  assert.deepEqual(carousel.readyProblems(done, CAROUSEL_CHECKLIST.map(([key]) => key)), []);
  assert.equal(carousel.recordChecklist(done, 1),
    '7 of 7 boxes ticked for 6 slides; the picture check flagged 1 picture and the final text check 1 slide');
});

test('three compliance rejections leave the slides for the reviewer, with no pictures', async () => {
  script = (agent) => (agent === 'carousel writer' ? reply(slideSet(6)) : reply({ approved: false, issues: ['Slide 2 gives dosage advice.'] }));
  const c = await settled(carousel.startCarousel(newItem(), 1));
  assert.equal(c.status, 'needs_attention');
  assert.equal(c.compliance_ok, 0);
  assert.match(c.notes, /Unresolved after 3 compliance reviews:\n- Slide 2 gives dosage advice\./);
  assert.equal(c.slides.length, 6);
  assert.equal(prompts.length, 0);
  assert.deepEqual(carousel.readyProblems(c, CAROUSEL_CHECKLIST.map(([key]) => key)), ['Finish the carousel first: its slide text has to pass the compliance check.']);
});

test('without GEMINI_API_KEY the deck gets colour backgrounds and nothing is spent on pictures', async () => {
  delete process.env.GEMINI_API_KEY;
  try {
    script = (agent) => (agent === 'carousel writer' ? reply(slideSet(5)) : approve());
    const c = await settled(carousel.startCarousel(newItem(), 1));
    assert.equal(c.status, 'ready', c.error);
    assert.equal(prompts.length, 0);
    assert.ok(c.slides.every((s) => s.picture === null && s.check === null));
    assert.match(c.log, /Pictures are off because GEMINI_API_KEY is not set/);
    const deck = JSON.parse(await carousel.deckJson(c));
    assert.ok(deck.slides.every((s) => s.blobs.length === 2 && !s.els.some((e) => e.type === 'image')));
    assert.throws(() => carousel.newPicture(c, 0, c.slides), /Pictures are off/);
  } finally {
    process.env.GEMINI_API_KEY = 'test-key';
  }
});

test('Gemini refusals are retried; an error retrying cannot fix fails the job, and Try again keeps the approved text', async () => {
  script = (agent) => (agent === 'carousel writer' ? reply(slideSet(5)) : agent === 'compliance' ? approve() : clean());
  drawing = (n) => {
    if (n === 1) throw new PictureError('Gemini refused the prompt (SAFETY).', true);
    throw new PictureError('Gemini rejected the request (HTTP 400): API key not valid.', false);
  };
  const id = carousel.startCarousel(newItem(), 1);
  let c = await settled(id);
  assert.equal(c.status, 'failed');
  assert.equal(c.error, 'Gemini rejected the request (HTTP 400): API key not valid.');
  assert.match(c.log, /picture 1: Gemini refused the prompt \(SAFETY\)/);

  drawing = () => ({ bytes: PNG, type: 'image/png', usage: {} });
  carousel.retryCarousel(c);
  c = await settled(id);
  assert.equal(c.status, 'ready', c.error);
  assert.ok(c.slides.every((s) => s.picture && s.check.ok));
  assert.equal(calls(id)['Carousel writer'], 1, 'the approved text is not written again');
  assert.equal(one(`SELECT output_tokens FROM ai_calls WHERE carousel_id = ? AND agent = 'Carousel pictures' LIMIT 1`, id).output_tokens, 1120,
    'a picture without reported usage is counted at 1,120 tokens');

  // A new picture for one slide: from its edited brief, replacing the old file. Unsaved wording blocks it.
  const old = c.slides[1].picture;
  const edits = c.slides.map((s) => ({ ...s }));
  edits[1].brief = 'A bowl of lentils in morning light';
  assert.throws(() => carousel.newPicture(c, 1, edits.map((s, i) => (i === 0 ? { ...s, heading: 'Changed' } : s))), /click "Save and check" first/);
  carousel.newPicture(c, 1, edits);
  c = await settled(id);
  assert.equal(prompts.at(-1).prompt.includes('Scene: A bowl of lentils in morning light'), true);
  assert.notEqual(c.slides[1].picture, old);
  assert.equal(existsSync(join(UPLOADS, old)), false);
});

test('slide checks catch counts, lengths, links and a missing disclaimer', () => {
  const slides = carousel.toSlides(slideSet(6));
  assert.deepEqual(carousel.slideProblems(slides), []);
  assert.deepEqual(carousel.slideProblems(slides.slice(0, 4)), ['Write 5 to 10 slides (there are 4).', 'The last slide must say "General information, not medical advice."']);
  const bad = slides.map((s, i) => ({
    ...s,
    heading: i === 1 ? 'x'.repeat(61) : s.heading,
    body: i === 2 ? 'Read more at https://example.com' : i === 3 ? '#IronFacts' : i === 4 ? 'y'.repeat(181) : s.body,
  }));
  assert.deepEqual(carousel.slideProblems(bad), [
    'Slide 2: the heading has 61 characters; the most is 60.',
    'Slide 3: no links or hashtags on slides (the caption has them).',
    'Slide 4: no links or hashtags on slides (the caption has them).',
    'Slide 5: the text has 181 characters; the most is 180.',
  ]);
  assert.equal(carousel.toSlides({ slides: [{ heading: ' A\n  heading ', body: 'x', picture: 'p' }] })[0].heading, 'A heading');
});

test('the deck passes the rules Glass Slides loads by, with separate layers per slide', () => {
  const slides = carousel.toSlides(slideSet(10));
  slides[1].heading = 'A much longer heading that has to wrap over three lines here';
  const deck = carousel.buildDeck('Iron and energy', slides, slides.map((_, i) => (i % 2 ? `data:image/png;base64,${PNG.toString('base64')}` : null)));
  assert.deepEqual(glassProblems(deck), []);
  assert.deepEqual([deck.w, deck.h, deck.name, deck.fonts], [1080, 1350, 'Iron and energy (carousel)', ['Inter']]);
  assert.deepEqual(deck.slides[1].els.map((e) => e.name), ['Picture', 'Panel', 'Heading', 'Text', 'Counter background', 'Counter']);
  assert.deepEqual(deck.slides[0].els.map((e) => e.name), ['Panel', 'Heading', 'Text', 'Counter background', 'Counter'], 'no picture: colour blobs instead');
  assert.equal(deck.slides[0].blobs.length, 2);
  assert.equal(deck.slides[2].els.find((e) => e.name === 'Counter').text, '3/10');
  const heading = (i) => deck.slides[i].els.find((e) => e.name === 'Heading');
  assert.ok(heading(1).h > heading(2).h, 'a longer heading gets a taller box');
  assert.equal(heading(0).size, 72, 'the cover heading is bigger');
  for (const s of deck.slides) {
    const panel = s.els.find((e) => e.name === 'Panel');
    assert.ok(panel.y + panel.h <= 1350 - 60 && s.els.every((e) => e.y >= 0), 'everything stays on the slide');
  }
  assert.equal(glassProblems(carousel.buildDeck('T', slides, slides.map(() => 'https://tvarvi.example/p.png'))).length, 10, 'linked images would be dropped');
});

test('finished slides come from the Glass Slides zip, a re-zipped copy or the JPEGs, checked for shape and size', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `Iron-carousel-copy-${String(i + 1).padStart(2, '0')}.jpg`);
  const files = names.map((name, i) => ({ name, bytes: jpeg(1080, 1350, 10 + i) }));
  const shuffled = [...files].reverse();
  const bare = jpeg(1080, 1350, 0).length;
  const inOrder = (slides) => slides.map((bytes) => bytes.length - bare);

  assert.deepEqual(carousel.jpegSize(jpeg(1080, 1350)), { width: 1080, height: 1350 });
  assert.equal(carousel.jpegSize(PNG), null);
  const stored = await zip(shuffled);
  assert.deepEqual(inOrder(carousel.readSlides([{ name: 'deck.zip', bytes: stored }], 10)), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const deflated = await zip([{ name: '__MACOSX/._x.jpg', bytes: Buffer.from('junk') }, ...shuffled.map((f) => ({ ...f, name: `slides/${f.name}` }))], { deflate: true });
  assert.equal(carousel.readSlides([{ name: 'deck.zip', bytes: deflated }], 10).length, 10);
  assert.deepEqual(inOrder(carousel.readSlides(shuffled, 10)), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

  const refused = (upload, expected, message) => assert.throws(() => carousel.readSlides(upload, expected), (err) => err.status === 400 && message.test(err.message));
  refused(files.slice(0, 9), 10, /This carousel has 10 slides, but the upload has 9/);
  refused([{ name: 'a.jpg', bytes: jpeg(1080, 1080) }], 1, /a\.jpg is 1080×1080\. Slides must be 4:5 at 1080×1350/);
  refused([{ name: 'a.jpg', bytes: jpeg(2160, 2700) }], 1, /a\.jpg is 2160×2700/);
  refused([{ name: 'a.png', bytes: PNG }], 1, /a\.png is not a JPEG/);
  refused([{ name: 'a.jpg', bytes: jpeg(1080, 1350, 5 * 1024 * 1024) }], 1, /over 5 MB/);
  refused([{ name: 'a.jpg', bytes: jpeg(1080, 1350) }, { name: 'b.jpg', bytes: jpeg(1440, 1800) }], 2, /same size/);
  const broken = Buffer.from(stored);
  broken[30 + shuffled[0].name.length + 10] ^= 0xff; // inside the first slide's bytes: its CRC no longer matches
  refused([{ name: 'deck.zip', bytes: broken }], 10, /damaged/);
  refused([{ name: 'deck.zip', bytes: stored.subarray(0, stored.length - 30) }], 10, /damaged/);
});

test('Gemini is called over REST with the key in a header, and its answer is checked', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  let answer;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  try {
    const fresh = await import(`../gemini.js?${Date.now()}`); // a fresh copy: the one above is stubbed
    const draw = () => fresh.gemini.picture('A calm still life', { model: 'gemini-3.1-flash-image', aspectRatio: '4:5' });
    const other = jpeg().toString('base64');
    answer = {
      body: {
        candidates: [{ content: { parts: [{ thought: true, inlineData: { data: other } }, { text: 'Here it is' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 1120 },
      },
    };
    const made = await draw();
    assert.deepEqual([made.bytes, made.type, made.usage], [PNG, 'image/png', { input: 250, output: 1120 }]);
    assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent');
    assert.equal(requests[0].init.headers['x-goog-api-key'], 'test-key');
    assert.deepEqual(JSON.parse(requests[0].init.body).generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:5', imageSize: '1K' } });

    const failure = async (body, status, message, retry) => {
      answer = { body, status };
      await assert.rejects(draw(), (err) => err instanceof fresh.PictureError && err.retry === retry && message.test(err.message));
    };
    await failure({ promptFeedback: { blockReason: 'SAFETY' } }, 200, /Gemini refused the prompt \(SAFETY\)/, true);
    await failure({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }, 200, /Gemini made no picture \(IMAGE_SAFETY\)/, true);
    await failure({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('<html>').toString('base64') } }] } }] }, 200, /not a PNG, JPEG or WebP/, true);
    await failure({ error: { message: 'API key not valid.' } }, 400, /HTTP 400\): API key not valid\./, false);
    await failure({ error: { message: 'Resource exhausted.' } }, 429, /HTTP 429/, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a carousel is published as one Instagram post: a container per slide, then a CAROUSEL container', async () => {
  Object.assign(process.env, { IG_API_BASE: 'https://graph.example/v24.0', IG_USER_ID: '17841', IG_ACCESS_TOKEN: 'token' });
  const realFetch = globalThis.fetch;
  const requests = [];
  let child = 0;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method ?? 'GET', url, body, auth: init.headers?.authorization });
    const json = url.endsWith('/17841/media')
      ? { id: body.media_type === 'CAROUSEL' ? 'parent' : `child${++child}` }
      : url.includes('/parent?fields=status_code') ? { status_code: 'FINISHED' }
        : url.endsWith('/media_publish') ? { id: 'media1' }
          : { permalink: 'https://www.instagram.com/p/abc/' };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  try {
    const result = await publishItem({ channel: 'instagram', body: 'Caption #Iron', slides: ['a.jpg', 'b.jpg', 'c.jpg'] }, { id: 1 }, new URL('https://app.example'));
    assert.deepEqual(result, { url: 'https://www.instagram.com/p/abc/', simulated: false });
    assert.deepEqual(requests.map((r) => [r.method, r.url.replace('https://graph.example/v24.0', ''), r.body]), [
      ['POST', '/17841/media', { image_url: 'https://app.example/media/a.jpg', is_carousel_item: true }],
      ['POST', '/17841/media', { image_url: 'https://app.example/media/b.jpg', is_carousel_item: true }],
      ['POST', '/17841/media', { image_url: 'https://app.example/media/c.jpg', is_carousel_item: true }],
      ['POST', '/17841/media', { media_type: 'CAROUSEL', children: 'child1,child2,child3', caption: 'Caption #Iron' }],
      ['GET', '/parent?fields=status_code', null],
      ['POST', '/17841/media_publish', { creation_id: 'parent' }],
      ['GET', '/media1?fields=permalink', null],
    ]);
    assert.ok(requests.every((r) => r.auth === 'Bearer token'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
