import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { oauth1Header, toLittleText, webhookSignature } from '../publish.js';
import { lineDiff, limitProblems, slugify, textToHtml, xLength } from '../text.js';
import { html, raw } from '../views.js';

test('html escapes interpolations but not nested templates or raw()', () => {
  const inner = html`<b>${'<i>'}</b>`;
  assert.equal(String(html`<p title="${'"x"'}">${'<script>'}${inner}${raw('<br>')}${[1, '&']}</p>`),
    '<p title="&quot;x&quot;">&lt;script&gt;<b>&lt;i&gt;</b><br>1&amp;</p>');
});

test('textToHtml keeps reference numbers and links https URLs without letting them break out', () => {
  assert.equal(
    textToHtml('## References\n\n1. NHS. https://www.nhs.uk/a?x=1&y=2 (accessed 2026-09-27)\n3. See https://x.org/b.'),
    '<h3>References</h3>\n<ol><li value="1">NHS. <a href="https://www.nhs.uk/a?x=1&amp;y=2">https://www.nhs.uk/a?x=1&amp;y=2</a> (accessed 2026-09-27)</li>'
      + '<li value="3">See <a href="https://x.org/b">https://x.org/b</a>.</li></ol>',
  );
  assert.equal(textToHtml('Go https://x.org/"><script>alert(1)</script> or http://plain.example'),
    '<p>Go <a href="https://x.org/">https://x.org/</a>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; or http://plain.example</p>');
});

test('textToHtml renders a heading with its answer right below it (the FAQ format)', () => {
  assert.equal(textToHtml('### Q: Is iron safe?\nYes, in the right amounts.\n#hashtag stays text'),
    '<h4>Q: Is iron safe?</h4>\n<p>Yes, in the right amounts.<br>#hashtag stays text</p>');
});

test('textToHtml builds headings, paragraphs and lists, escaping text', () => {
  assert.equal(
    textToHtml('## Diet basics\n\nEat well\nevery day\n\n- fibre\n- iron <daily>\n\n<script>'),
    '<h3>Diet basics</h3>\n<p>Eat well<br>every day</p>\n<ul><li>fibre</li><li>iron &lt;daily&gt;</li></ul>\n<p>&lt;script&gt;</p>',
  );
});

test('lineDiff marks removed and added lines', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc\nd'), [
    ['same', 'a'], ['del', 'b'], ['add', 'B'], ['same', 'c'], ['add', 'd'],
  ]);
  assert.deepEqual(lineDiff('same', 'same'), [['same', 'same']]);
});

test('lineDiff falls back to a plain replace for huge rewrites', () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
  const rows = lineDiff(before, after);
  assert.equal(rows.length, 6000);
  assert.deepEqual(rows[0], ['del', 'old 0']);
  assert.deepEqual(rows[3000], ['add', 'new 0']);
});

test('X length counts emoji as two characters', () => {
  assert.equal(xLength('abc'), 3);
  assert.equal(xLength('😀'), 2);
  assert.equal(xLength('नमस्ते'), 6);
  assert.deepEqual(limitProblems('x', '😀'.repeat(140)), []);
  assert.match(limitProblems('x', '😀'.repeat(141))[0], /Too long: 282/);
});

test('platform limits', () => {
  assert.deepEqual(limitProblems('linkedin', '  '), ['The post is empty.']);
  assert.equal(limitProblems('linkedin', 'a'.repeat(3000)).length, 0);
  assert.equal(limitProblems('linkedin', 'a'.repeat(3001)).length, 1);
  const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
  assert.deepEqual(limitProblems('instagram', tags), ['Instagram allows at most 30 hashtags.']);
});

test('slugify', () => {
  assert.equal(slugify('Female Health & Diet: 5 Tips!', 7), 'female-health-diet-5-tips-7');
  assert.equal(slugify('Café au lait', 2), 'cafe-au-lait-2');
  assert.equal(slugify('नमस्ते', 3), 'article-3');
});

test('LinkedIn little text escapes reserved characters and keeps hashtags', () => {
  assert.equal(
    toLittleText('Eat well (really) #health #women_health'),
    'Eat well \\(really\\) {hashtag|\\#|health} {hashtag|\\#|women\\_health}',
  );
});

test('OAuth 1.0a signature matches the published Twitter example', () => {
  const header = oauth1Header(
    'POST',
    'https://api.twitter.com/1.1/statuses/update.json',
    { status: 'Hello Ladies + Gentlemen, a signed OAuth request!', include_entities: 'true' },
    {
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    },
    'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    '1318622958',
  );
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

test('webhook signature is HMAC-SHA256 over "timestamp.body"', () => {
  assert.equal(webhookSignature('secret', '1700000000', '{"id":1}'),
    createHmac('sha256', 'secret').update('1700000000.{"id":1}').digest('hex'));
});
