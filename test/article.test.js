import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-article-'));
const { all, one, run } = await import('../db.js');
const { ai } = await import('../ai.js');
const a = await import('../article.js');
const { createEntry } = await import('../knowledge.js');
const { addSource } = await import('../sources.js');
const { article, cite, CLAIMS, PAGES, reply, research, text, UNOPENED } = await import('./fixtures.js');

run(`INSERT INTO users (id, email, name, pw_hash, can_write) VALUES (1, 'writer@example.com', 'Wen', 'x', 1)`);
addSource('https://nih.gov', 'research', 1);
addSource('https://www.nhs.uk', 'research', 1);
const rule = createEntry({ kind: 'compliance_rule', title: 'Disclaimer', text: 'Say it is general information, not medical advice.' }, 1);
run(`INSERT INTO sources (id, url, host, kind) VALUES (50, 'https://regulator.example/claims', 'regulator.example', 'compliance')`);
run(`INSERT INTO snapshots (id, source_id, text, hash, status) VALUES (9, 50, 'APPROVED REGULATOR TEXT', 'h', 'approved')`);

// Scripted Claude: writer turns (streamed) and compliance verdicts, taken in order.
let writerScript = [];
let verdicts = [];
const writerCalls = [];
const reviewCalls = [];
ai.stream = async (params, onBlock) => {
  writerCalls.push(structuredClone(params));
  const res = writerScript.shift()(params);
  res.content.forEach((block) => onBlock?.(block));
  return res;
};
ai.ask = async (params) => {
  reviewCalls.push(structuredClone(params));
  const verdict = verdicts.shift();
  if (verdict instanceof Error) throw verdict;
  return reply([text(JSON.stringify(verdict))]);
};

async function draft(topic = 'iron and energy') {
  const id = a.startDraft(topic, 1);
  for (const deadline = Date.now() + 5000; one('SELECT status FROM drafts WHERE id = ?', id).status === 'running';) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return a.getDraft(id);
}

test('research, code checks, compliance feedback, then a draft with references built only from opened pages', async () => {
  writerCalls.length = reviewCalls.length = 0;
  writerScript = [
    // Version 1: too short, only 4 pages, one citation of an unapproved page and one of a search result never opened.
    () => reply([...research(), ...article({
      refs: [0, 1, 2, 3], words: 2300,
      extra: [text(' '), text(CLAIMS[6], cite(6)), text(' Some sites say more.', [{ type: 'web_search_result_location', url: UNOPENED, title: 'x', encrypted_index: 'e', cited_text: 'snippet' }])],
    })], 'end_turn', { server_tool_use: { web_search_requests: 1, web_fetch_requests: 7 } }),
    () => reply(article()), // version 2 passes the checks; compliance rejects it
    () => reply(article()), // version 3 is approved
  ];
  verdicts = [{ approved: false, issues: ['"Leafy greens, beans and nuts provide iron." should say they are good sources.'] }, { approved: true, issues: [] }];
  const d = await draft();

  assert.equal(d.status, 'ready', d.error ?? d.notes);
  assert.equal(d.rounds, 2);
  assert.match(d.notes, /round 2/);
  assert.equal(d.title, 'Iron and energy: a guide for women');

  // Requests: the article writer streams on Sonnet 5 with the web tools limited to the research hosts and direct calls.
  assert.equal(writerCalls.length, 3);
  const [search, fetch] = writerCalls[0].tools;
  assert.equal(writerCalls[0].model, 'claude-sonnet-5');
  assert.deepEqual([search.type, search.allowed_domains, search.allowed_callers, search.max_uses], ['web_search_20260209', ['nih.gov', 'www.nhs.uk'], ['direct'], 3]);
  assert.deepEqual([fetch.type, fetch.allowed_domains, fetch.allowed_callers, fetch.citations, fetch.max_uses, fetch.max_content_tokens],
    ['web_fetch_20260209', ['nih.gov', 'www.nhs.uk'], ['direct'], { enabled: true }, 6, 4000]);
  assert.match(writerCalls[0].system, /You can run 3 searches and open 6 pages, and you cannot research again later/);
  assert.match(writerCalls[0].messages[0].content, /<topic>iron and energy<\/topic>[\s\S]*https:\/\/nih\.gov\/\nhttps:\/\/www\.nhs\.uk\//);
  assert.match(writerCalls[0].system, /Disclaimer: Say it is general information/);
  assert.deepEqual(writerCalls[1].tools, writerCalls[0].tools, 'identical tools on every request keep the cache');

  // The checks' problems went back to the writer, then the reviewer's issue.
  const feedback1 = writerCalls[1].messages.at(-1).content;
  assert.match(feedback1, /must have 2,400–3,400/);
  assert.match(feedback1, /Only 4 different opened pages are cited/);
  assert.match(feedback1, /2 citations point to search results or pages you didn't open/);
  assert.match(writerCalls[2].messages.at(-1).content, /compliance reviewer found these issues:\n- "Leafy greens/);

  // References: numbered by first citation, only opened pages on approved hosts, with markers in the text.
  assert.deepEqual(d.refs.map((r) => r.url), PAGES.slice(0, 6).map((p) => p.url));
  assert.deepEqual(d.refs[0], { n: 1, url: PAGES[0].url, title: 'Iron deficiency anaemia - NHS', accessed: '2026-09-27' });
  assert.match(d.body, /Low iron is often linked to blood loss or pregnancy \[1\]\./);
  assert.match(d.body, /## References\n\n1\. Iron deficiency anaemia - NHS\. https:\/\/www\.nhs\.uk\/conditions\/iron-deficiency-anaemia\/ \(accessed 2026-09-27\)\n2\./);
  assert.equal(d.body.split('\n').filter((line) => /^\d+\. /.test(line)).length, 6);
  assert.doesNotMatch(d.body, /evil\.example|never-opened|Here is the article/);
  assert.ok(d.checks.every((c) => c.ok), JSON.stringify(d.checks));

  // Evidence: each claim with the exact passage it cites.
  assert.deepEqual(d.evidence[1], { claim: CLAIMS[1], refs: [2], quotes: [{ n: 2, text: PAGES[1].fact }] });

  // The compliance agent got the cited passages, the uncited sentences, the approved regulator text and the rules.
  assert.equal(reviewCalls.length, 2);
  assert.equal(reviewCalls[0].model, 'claude-opus-5-5');
  const input = reviewCalls[0].messages[0].content;
  assert.match(input, /<claim id="2" sources="2">Leafy greens, beans and nuts provide iron\.<\/claim>\n<passage claim="2" source="2">Good sources of iron include/);
  assert.match(input, /<uncited>\n- Filler sentence number 1 keeps this section easy to read\./);
  assert.doesNotMatch(input, /<uncited>[\s\S]*(Short practical point|Description:|Source: NHS)[\s\S]*<\/uncited>/, 'takeaways, picture blocks and table sources state no new facts');
  assert.match(reviewCalls[0].system.map((b) => b.text).join('\n'), /APPROVED REGULATOR TEXT[\s\S]*Disclaimer/);

  // What it used, what it cost, and the live progress log.
  assert.ok(d.inputs.some((i) => i.kind === 'rule' && i.ref === rule.versionId));
  assert.ok(d.inputs.some((i) => i.kind === 'snapshot' && i.ref === 9));
  assert.equal(d.inputs.filter((i) => i.kind === 'web').length, 6);
  assert.equal(one('SELECT COUNT(*) AS n FROM ai_calls WHERE draft_id = ?', d.id).n, 5);
  assert.ok(d.cost > 0);
  assert.equal(d.searches, 1);
  for (const line of ['Searching: iron deficiency women', `Opened ${PAGES[0].url}`, 'Checks: References, Citations, Length not met', 'Compliance review 1: 1 issue', 'Done: ready for you to check']) {
    assert.ok(d.log.includes(line), line);
  }
});

test('a paused research turn is resent unchanged, and rewrites never search or open pages', async () => {
  writerCalls.length = 0;
  const [first, ...rest] = research();
  writerScript = [
    () => reply([first, rest[0]], 'pause_turn'),
    () => reply([...rest.slice(1), ...article({ words: 2000 })], 'end_turn', { server_tool_use: { web_search_requests: 1, web_fetch_requests: 12 } }),
    () => reply(article()),
  ];
  verdicts = [{ approved: true, issues: [] }];
  const d = await draft('iron in pregnancy');
  assert.equal(d.status, 'ready', d.error);
  assert.equal(writerCalls[1].messages.length, writerCalls[0].messages.length + 1, 'no extra user message after a pause');
  assert.equal(writerCalls[1].messages.at(-1).role, 'assistant');
  assert.equal(writerCalls[1].tool_choice, undefined);
  assert.deepEqual(writerCalls[2].tool_choice, { type: 'none' }, 'a rewrite works from the pages already opened');
  assert.deepEqual(writerCalls[2].tools, writerCalls[0].tools, 'the tools stay listed, so the cached prefix is reused');
  assert.match(writerCalls[2].messages.at(-1).content, /without searching or opening more/);
});

test('two compliance rejections leave the draft needing attention, with the open issues', async () => {
  writerScript = [() => reply([...research(), ...article()]), () => reply(article())];
  verdicts = ['One', 'Two'].map((n) => ({ approved: false, issues: [`Issue ${n}`] }));
  const d = await draft('iron and sport');
  assert.equal(d.status, 'needs_attention');
  assert.equal(d.rounds, 2);
  assert.equal(d.notes, 'Needs attention. Unresolved after 2 compliance reviews:\n- Issue Two');
  assert.match(d.body, /## References/);
});

test('a draft starts no new AI call once it has cost $1.50, and hands over its latest version', async () => {
  writerCalls.length = reviewCalls.length = 0;
  // 800,000 input tokens on Sonnet 5 cost $1.60.
  writerScript = [() => reply([...research(), ...article({ words: 2000 })], 'end_turn', { input_tokens: 800_000 })];
  verdicts = [];
  let d = await draft('iron and budgets');
  assert.deepEqual([writerCalls.length, reviewCalls.length], [1, 0], 'no rewrite after the limit');
  assert.equal(d.status, 'needs_attention');
  assert.match(d.notes, /^Needs attention\. Stopped at the \$1\.50 spending limit:\n- The article has [\d,]+ words/);
  assert.match(d.body, /## References/);

  writerCalls.length = 0;
  writerScript = [() => reply([...research(), ...article()], 'end_turn', { input_tokens: 800_000 })];
  d = await draft('iron and limits');
  assert.deepEqual([writerCalls.length, reviewCalls.length], [1, 0], 'no compliance review after the limit');
  assert.equal(d.notes, 'Needs attention. It passed the code checks, but the $1.50 spending limit was reached before its compliance review.');
});

test('an API error or a refusal fails the draft with a readable message', async () => {
  writerScript = [() => {
    throw new Error('connection reset');
  }];
  let d = await draft('iron and sleep');
  assert.deepEqual([d.status, d.error], ['failed', 'connection reset']);
  assert.match(d.log, /Failed: connection reset/);

  writerScript = [() => ({ content: [], stop_reason: 'refusal', stop_details: { category: 'bio' }, usage: {} })];
  d = await draft('iron and sleep');
  assert.deepEqual([d.status, d.error], ['failed', 'The AI declined this request (bio).']);
});

test('topics are validated and one draft runs per person', () => {
  assert.throws(() => a.startDraft(' ab ', 1), { status: 400, message: /3 to 150 characters/ });
  assert.throws(() => a.startDraft('x'.repeat(151), 1), { status: 400 });
  writerScript = [() => new Promise(() => {})]; // never answers
  a.startDraft('a slow topic', 1);
  assert.throws(() => a.startDraft('another topic', 1), { status: 409, message: /already have a draft/ });
  run(`UPDATE drafts SET status = 'failed' WHERE status = 'running'`);
  run(`UPDATE sources SET active = 0 WHERE kind = 'research'`);
  assert.throws(() => a.startDraft('iron', 1), { status: 400, message: /no Research sources/ });
  run(`UPDATE sources SET active = 1 WHERE kind = 'research'`);
});

test('code checks: copied passages, FAQ placement, unanswered FAQs and word counts', () => {
  const pages = a.openedPages([{ role: 'assistant', content: research() }]);
  assert.equal(pages.length, 7);
  const copied = `# T\n\nIntro.\n\n## One\n\nThey say ${PAGES[1].fact.toLowerCase()}`;
  const { problems } = a.checkDraft({ title: 'T', ...a.splitArticle(copied), refs: [], unopened: 0 }, pages);
  assert.ok(problems.some((p) => p.includes('"good sources of iron include dark green leafy vegetables beans nuts and"')), problems.join('\n'));

  const faqs = a.faqs('Intro\n\n### Q: Too early?\nYes.\n\n## A\n\n### Q: One?\nYes.\n### Q: Two?\nYes.\n\n## Frequently asked questions\n\n### Q: End?\n\n## Later section');
  assert.deepEqual([faqs.inBody.length, new Set(faqs.inBody.map((q) => q.section)).size, faqs.atEnd.length, faqs.last], [3, 2, 1, false]);
  assert.deepEqual(faqs.unanswered, ['End?']);

  assert.equal(a.wordCount('Iron [12] helps women’s well-being, e.g. 1.5 mg a day.'), 9);
  assert.deepEqual(a.uncitedSentences('# T\n\n## H\n\nCited claim here [1]. An uncited claim here too. Short one.', [[9, 30]], 4),
    ['An uncited claim here too.']);
});

test('code checks: the house shape, FAQ answers, links, prices and placeholders', () => {
  const body = a.splitArticle(article().map((b) => b.text).join('').replace(/^[\s\S]*?(?=# )/, '')).body;
  const opts = { brief: 'Starter check: ₹1,499' };
  const failed = (text) => a.textChecks(text, opts).checks.filter((c) => !c.ok).map((c) => c.label);
  assert.deepEqual(failed(body), []);

  const [, chapter2] = body.match(/(## Part 2[\s\S]*?)(?=## Part 3)/);
  assert.deepEqual(failed(body.replace(/Image 2:[^\n]*\nDescription:[^\n]*\nAlt text:[^\n]*/, '')), ['Picture blocks']);
  assert.deepEqual(failed(body.replace('Image 3', 'Image 7')), ['Picture blocks'], 'numbered 1 to 3');
  const picture3 = body.match(/Image 3:[^\n]*\nDescription:[^\n]*\nAlt text:[^\n]*/)[0];
  assert.deepEqual(failed(body.replace(`\n\n${picture3}`, '').replace('Source: NHS, 2026', `Source: NHS, 2026\n\n${picture3}`)),
    ['Spacing'], 'a picture block right after a table');
  assert.deepEqual(failed(body.replace('  - Short practical point 2.3.\n', '')), ['Takeaways']);
  assert.deepEqual(failed(body.replace('## Part 5', `${chapter2.replace(/### Q[^\n]*\n[^\n]*|Image 2[^\n]*\n[^\n]*\n[^\n]*/g, '')}## Part 5`)), ['Chapters']);
  assert.deepEqual(failed(body.replace('It explains one practical step you can take.', 'One. Two. Three. Four.')), ['FAQ answers']);
  assert.deepEqual(failed(body.replace('Common question 1?', 'What does part 2 mean for me?')), ['FAQs at the end']);
  assert.deepEqual(failed(body.replace('A short, clear answer.', 'You can book a consultation with Tvarvi. The starter check costs ₹1,499.')), []);
  assert.deepEqual(failed(body.replace('A short, clear answer.', 'See [others](https://rival.example/pcos) for ₹999.')), ['Links', 'Prices']);
  // No links at all, not even to Tvarvi: the website adds its own navigation and booking buttons.
  for (const link of ['[book here](https://www.tvarvi.com/gynaecologist)', '[book](/booking)', 'www.tvarvi.com', 'https://www.tvarvi.com/']) {
    assert.deepEqual(failed(body.replace('A short, clear answer.', `See ${link} today.`)), ['Links'], link);
  }
  assert.deepEqual(failed(body.replace('A short, clear answer.', 'About 1 in 5 women [SOURCE NEEDED: prevalence].')), ['Placeholders']);
  assert.match(a.textChecks(body.replace('Table 1:', 'Tables 1:'), opts).problems.join('\n'), /Write exactly 2 tables[\s\S]*found 1, and 1 malformed/);
});

test('the brief reaches the writer and the compliance agent, and em dashes are replaced without a rewrite', async () => {
  writerCalls.length = reviewCalls.length = 0;
  writerScript = [() => reply([...research(), ...article({ extra: [text('Rest matters — a lot — for energy. ')] })])];
  verdicts = [{ approved: true, issues: [] }];
  const id = a.startDraft('iron and rest', 1, '  Coined concept: the energy ledger.\r\nPrices: none.  ');
  for (const deadline = Date.now() + 5000; one('SELECT status FROM drafts WHERE id = ?', id).status === 'running';) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const d = a.getDraft(id);
  assert.equal(d.status, 'ready', d.error ?? d.notes);
  assert.equal(d.brief, 'Coined concept: the energy ledger.\nPrices: none.');
  assert.equal(writerCalls.length, 1, 'no rewrite for em dashes');
  assert.match(writerCalls[0].messages[0].content, /<topic>iron and rest<\/topic>\n\n<brief>\nCoined concept: the energy ledger\.\nPrices: none\.\n<\/brief>/);
  assert.match(reviewCalls[0].messages[0].content, /<brief>\nCoined concept: the energy ledger\./);
  assert.match(d.body, /Rest matters, a lot, for energy\./);
  assert.doesNotMatch(d.body, /—/);
  assert.throws(() => a.startDraft('iron', 1, 'x'.repeat(2001)), { status: 400, message: /brief is too long/ });
});
