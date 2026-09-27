// Scripted article-agent responses shaped like the API's: research blocks, and articles as text blocks with citations.
// No app imports: node --test also loads this file on its own.

// Pages the scripted agent opens: six on approved hosts and one that is not (the app must drop it).
export const PAGES = [
  ['https://www.nhs.uk/conditions/iron-deficiency-anaemia/', 'Iron deficiency anaemia - NHS', 'Iron deficiency anaemia is caused by a lack of iron, often because of blood loss or pregnancy.'],
  ['https://www.nhs.uk/live-well/eat-well/', 'Eat well - NHS', 'Good sources of iron include dark green leafy vegetables, beans, nuts and dried fruit.'],
  ['https://ods.od.nih.gov/factsheets/Iron-Consumer/', 'Iron - Consumer', 'Vitamin C helps the body absorb the iron that is found in plant foods.'],
  ['https://www.nhlbi.nih.gov/health/anemia', 'Anemia | NHLBI', 'Women are more likely to have iron deficiency anemia because of menstruation and pregnancy.'],
  ['https://www.ncbi.nlm.nih.gov/books/NBK448065/', 'Iron Deficiency Anemia', 'Iron deficiency is the most common nutritional deficiency in the world today.'],
  ['https://www.nichd.nih.gov/health/topics/iron', 'Iron | NICHD', 'A health care provider can check iron levels with a simple blood test.'],
  ['https://evil.example/iron', 'Not approved', 'Iron cures tiredness in three days for everyone who tries it.'],
].map(([url, title, fact]) => ({ url, title, fact, text: `${title}.\n${fact}\nThis page also covers related topics in more depth.` }));

export const CLAIMS = [ // paraphrases of the facts, so the "own words" check passes
  'Low iron is often linked to blood loss or pregnancy.',
  'Leafy greens, beans and nuts provide iron.',
  'Vitamin C improves how well plant iron is absorbed.',
  'Periods and pregnancy make low iron more common in women.',
  'Worldwide, low iron is the most frequent shortfall in diets.',
  'A blood test shows whether iron levels are low.',
  'Iron fixes tiredness within days.',
];
export const UNOPENED = 'https://www.nhs.uk/conditions/never-opened/';

export const text = (value, citations) => ({ type: 'text', text: value, ...(citations ? { citations } : {}) });
export const cite = (i) => [{
  type: 'char_location', cited_text: PAGES[i].fact, document_index: i, document_title: PAGES[i].title, start_char_index: 0, end_char_index: 10,
}];
export const reply = (content, stop_reason = 'end_turn', usage = {}) => ({ content, stop_reason, usage: { input_tokens: 1000, output_tokens: 500, ...usage } });

const bodyWords = (blocks) => {
  const all = blocks.map((b) => b.text).join('');
  const body = all.slice(all.indexOf('\n', all.indexOf('# ')) + 1);
  return (body.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? []).length;
};

// An article as the API returns it. `words` is the body length to aim for (filler sentences are 10 words each).
export function article({ refs = [0, 1, 2, 3, 4, 5], words = 2800, bodyFaqs = 3, endFaqs = 2, extra = [] } = {}) {
  const blocks = [text('Here is the article.\n\n# Iron and energy: a guide for women\n\nMany people feel tired when their iron is low. ')];
  refs.forEach((ref, i) => {
    blocks.push(text(`\n\n## Part ${i + 1}\n\n`), text(CLAIMS[ref], cite(ref)));
    if (i < bodyFaqs) blocks.push(text(`\n\n### Q: What does part ${i + 1} mean for me?\nIt explains one practical step you can take.`));
  });
  blocks.push(...extra);
  blocks.push(text(`\n\n## Frequently asked questions\n\n${Array.from({ length: endFaqs }, (_, i) => `### Q: Common question ${i + 1}?\nA short, clear answer.`).join('\n\n')}\n\nThis is general information, not medical advice. Talk to a healthcare professional.`));
  const count = Math.round((words - bodyWords(blocks)) / 10);
  blocks.splice(2, 0, text(`${Array.from({ length: count }, (_, k) => `Filler sentence number ${k + 1} keeps this section easy to read.`).join(' ')} `));
  return blocks;
}

// A search (whose only result is never opened) and a fetch of each page.
export const research = (extraFetch = []) => [
  { type: 'server_tool_use', id: 'srv_s1', name: 'web_search', input: { query: 'iron deficiency women' } },
  { type: 'web_search_tool_result', tool_use_id: 'srv_s1', content: [{ type: 'web_search_result', url: UNOPENED, title: 'Never opened', encrypted_content: 'x' }] },
  ...[...PAGES, ...extraFetch].flatMap((page, i) => [
    { type: 'server_tool_use', id: `srv_f${i}`, name: 'web_fetch', input: { url: page.url } },
    page.error
      ? { type: 'web_fetch_tool_result', tool_use_id: `srv_f${i}`, content: { type: 'web_fetch_tool_result_error', error_code: page.error } }
      : {
          type: 'web_fetch_tool_result', tool_use_id: `srv_f${i}`,
          content: {
            type: 'web_fetch_result', url: page.url, retrieved_at: '2026-09-27T10:00:00Z',
            content: { type: 'document', title: page.title, source: { type: 'text', media_type: 'text/plain', data: page.text } },
          },
        },
  ]),
];
