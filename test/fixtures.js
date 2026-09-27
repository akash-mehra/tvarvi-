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

// ---------- carousels ----------

// The carousel writer's JSON: `n` slides, the last with the disclaimer.
export const slideSet = (n = 6) => ({
  slides: Array.from({ length: n }, (_, i) => ({
    heading: i === 0 ? 'Iron and energy: what to know' : `Point ${i}: iron and your day`,
    body: i === n - 1 ? 'General information, not medical advice. Full article: link in bio.' : `Short approved text for slide ${i + 1}.`,
    picture: `A calm still life of leafy greens and beans for slide ${i + 1}`,
  })),
});

// The start of a PNG (all the app looks at) and a JPEG whose frame header says width × height.
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000003a000000480080200000000', 'hex');
export function jpeg(width = 1080, height = 1350, filler = 64) {
  const app0 = Buffer.from('ffe000104a46494600010100000100010000', 'hex');
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(filler, 0x11), Buffer.from([0xff, 0xd9])]);
}

// A .zip like Glass Slides' "Export all" (stored), or deflated like one re-zipped by an operating system.
export async function zip(files, { deflate = false } = {}) {
  const { crc32, deflateRawSync } = await import('node:zlib');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const nameBytes = Buffer.from(name);
    const data = deflate ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(bytes), 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// Which agent a scripted Claude call is for, from its tools or output schema.
export function agentOf(params) {
  const schema = params.output_config?.format?.schema;
  if (!schema) return params.tools?.some((t) => t.name === 'submit_post') ? 'post writer' : 'other';
  if (schema.properties.problems) return 'picture check';
  if (schema.properties.approved) return 'compliance';
  return schema.properties.slides.items.properties.heading ? 'carousel writer' : 'final check';
}

// What Glass Slides' normaliseDoc keeps (index.html, "loading & validation"): a deck that passes loads layer for layer.
export function glassProblems(deck, fonts = ['Inter']) {
  const problems = [];
  const inRange = (v, lo, hi, what) => (typeof v === 'number' && v >= lo && v <= hi) || problems.push(`${what} out of range: ${v}`);
  inRange(deck.w, 64, 8000, 'w');
  inRange(deck.h, 64, 8000, 'h');
  if (!Array.isArray(deck.slides) || !deck.slides.length || deck.slides.length > 200) problems.push('slides');
  deck.fonts.forEach((f) => fonts.includes(f) || problems.push(`font ${f}`));
  deck.slides.forEach((s, i) => {
    if (!/^#[0-9a-f]{6}$/i.test(s.base)) problems.push(`slide ${i} base`);
    if (s.els.length > 500) problems.push(`slide ${i} layers`);
    s.els.forEach((e) => {
      const where = `slide ${i} ${e.name}`;
      if (!['glass', 'text', 'image', 'shape'].includes(e.type)) problems.push(`${where} type`);
      inRange(e.x, -20000, 20000, `${where} x`);
      inRange(e.y, -20000, 20000, `${where} y`);
      inRange(e.w, 4, 20000, `${where} w`);
      inRange(e.h, 4, 20000, `${where} h`);
      if (e.type === 'image' && !/^data:image\//i.test(e.src)) problems.push(`${where}: images must be data: URIs`);
      if (e.type === 'glass' && !['rect', 'circle', 'pill'].includes(e.shape)) problems.push(`${where} shape`);
      if (e.type === 'text') {
        inRange(e.size, 4, 1200, `${where} size`);
        if (![100, 200, 300, 400, 500, 600, 700, 800, 900].includes(e.weight)) problems.push(`${where} weight`);
        if (!/^#[0-9a-f]{6}$/i.test(e.color)) problems.push(`${where} color`);
        if (e.text.length > 20000 || /[;{}<>]/.test(e.font)) problems.push(`${where} text or font`);
      }
    });
  });
  return problems;
}
