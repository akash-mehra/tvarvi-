// Pure text helpers shared by pages, AI and publishers.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const CHANNELS = {
  website: { label: 'Website article' },
  instagram: { label: 'Instagram', max: 2200 },
  linkedin: { label: 'LinkedIn', max: 3000 },
  x: { label: 'X (Twitter)', max: 280 },
};
export const SOCIAL = ['instagram', 'linkedin', 'x'];
export const KNOWLEDGE_KINDS = { brand_rule: 'Brand rule', compliance_rule: 'Compliance rule', example: 'Example' };

// What the reviewer confirms, box by box, before a carousel can be marked ready.
export const CAROUSEL_CHECKLIST = [
  ['no_text', 'No text, letters or garbled writing in any picture'],
  ['medical', 'No misleading medical pictures'],
  ['people', 'No identifiable people'],
  ['brands', 'No logos or brands'],
  ['safe', 'Nothing graphic or unsafe for Instagram'],
  ['match', 'Every picture matches its slide'],
  ['wording', 'The words on the finished slides match the approved slide text'],
];

// X counts emoji and most non-Latin characters as 2. This errs on the long side, never the short.
export function xLength(text) {
  let length = 0;
  for (const ch of text) length += ch.codePointAt(0) <= 0x10ff ? 1 : 2;
  return length;
}

export const postLength = (channel, text) => (channel === 'x' ? xLength(text) : [...text].length);

export function limitProblems(channel, text) {
  const problems = [];
  if (!text.trim()) problems.push('The post is empty.');
  const { max } = CHANNELS[channel];
  const length = postLength(channel, text);
  if (max && length > max) problems.push(`Too long: ${length} characters (limit ${max}).`);
  if (channel === 'instagram' && (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) {
    problems.push('Instagram allows at most 30 hashtags.');
  }
  return problems;
}

// The standard disclaimer, added after the References of every website article.
export const DISCLAIMER = 'This article is for general information and awareness. It is not medical advice and does not replace a '
  + 'consultation with a qualified doctor. Please speak to a registered medical practitioner about your symptoms, tests or treatment. '
  + 'If you have very heavy bleeding, severe pain or feel unwell, seek medical care promptly.';

// House style: no em dashes or double hyphens in articles. Each becomes a comma (dropped at the start or end of a line
// and before punctuation); en dashes in ranges such as "10–13%" stay, and so do table rule lines ("| --- |").
export const noEmDashes = (text) =>
  String(text).split('\n').map((line) => (/^\s*\|[\s|:-]*\|\s*$/.test(line)
    ? line
    : line
      .replace(/[ \t]*(?:—|(?<!-)--(?!-))[ \t]*/g, '\u0000') // marks each dash with the spaces around it
      .replace(/^(\s*(?:[-*]\s+|#{1,4}\s+)?)\u0000+/, '$1')
      .replace(/\u0000+(?=[.,;:!?)]|$)/g, '')
      .replace(/,?\u0000+/g, ', '))).join('\n');

// Blank-line blocks of article text, with each heading as a block of its own even when text follows right below it.
export const splitBlocks = (text) =>
  String(text)
    .replace(/^[ \t]*(#{1,4}[ \t]+\S.*)$/gm, '\n$1\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.split('\n'));

// A picture block, exactly three lines: "Image 1: <title>", "Description: <picture prompt>", "Alt text: <alt text>".
export function parsePicture(lines) {
  const [title, description, alt] = [/^Image (\d{1,2}):\s*(\S.*)$/, /^Description:\s*(\S.*)$/, /^Alt text:\s*(\S.*)$/]
    .map((pattern, i) => lines[i]?.trim().match(pattern));
  if (lines.length !== 3 || !title || !description || !alt) return null;
  return { n: Number(title[1]), title: title[2].trim(), description: description[1].trim(), alt: alt[1].trim() };
}

// A table block: an optional "Table 1: <title>" line, a header row, a rule row, data rows, an optional "Source:" line.
const ROW = /^\s*\|.*\|\s*$/;
const RULE_ROW = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
export function parseTable(lines) {
  let i = 0;
  const title = /^Table \d{1,2}:\s*\S/.test(lines[0]) ? lines[i++].trim() : null;
  const rows = [];
  while (i < lines.length && ROW.test(lines[i])) rows.push(lines[i++]);
  const source = /^Source:\s*\S/.test(lines[i] ?? '') ? lines[i++].trim() : null;
  if (i !== lines.length || rows.length < 3 || !RULE_ROW.test(rows[1])) return null;
  return { title, head: cells(rows[0]), rows: rows.slice(2).map(cells), source };
}

// Every picture block in an article, in order.
export const pictureBlocks = (text) => splitBlocks(text).map(parsePicture).filter(Boolean);

// The References list's URLs by number ("1. Title. https://… (accessed …)"), for the [n] markers in the text.
function referenceUrls(text) {
  const urls = new Map();
  const start = text.search(/^##\s+References\s*$/m);
  if (start < 0) return urls;
  for (const line of text.slice(start).split('\n')) {
    const found = line.match(/^\s*(\d{1,4})\.\s.*?(https:\/\/\S+)/);
    if (found && !urls.has(found[1])) urls.set(found[1], found[2].replace(/[.,;:)]+$/, ''));
  }
  return urls;
}

// Escaped text → the same text with [text](https://…) links, bare https:// URLs as links and [n] markers linked to their
// reference. It runs after esc(), so a URL can't break out of the attribute: it stops at whitespace and at escaped quotes
// or angle brackets; trailing punctuation stays outside.
const INLINE = /\[([^\]\n]{1,200})\]\((https:\/\/(?:[^\s&)]|&amp;)+)\)|https:\/\/(?:[^\s&]|&amp;)+|\[(\d{1,4})\]/g;
const inline = (escaped, refs) =>
  escaped.replace(INLINE, (match, label, href, n) => {
    if (href) return `<a href="${href}">${label}</a>`;
    if (n) return refs.has(n) ? `<a href="${esc(refs.get(n))}">[${n}]</a>` : match;
    const trail = match.match(/[.,;:!?)]+$/)?.[0] ?? '';
    const url = match.slice(0, match.length - trail.length);
    return `<a href="${url}">${url}</a>${trail}`;
  });

function list(lines, refs) {
  const items = [];
  for (const line of lines) {
    const [, indent, content] = line.match(/^(\s*)[-*]\s+(.*)$/);
    const item = inline(esc(content), refs);
    if (indent.replace(/\t/g, '  ').length >= 2 && items.length) items.at(-1).children.push(item);
    else items.push({ item, children: [] });
  }
  return `<ul>${items.map(({ item, children }) =>
    `<li>${item}${children.length ? `<ul>${children.map((child) => `<li>${child}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`;
}

// Article text → safe HTML: blank-line paragraphs, headings ("## " is h2, "### " h3), bullet lists with one level of
// nesting, numbered lists (references keep their numbers), tables, picture blocks and links. `pictures` (n → { url })
// is given when publishing: a picture block becomes its picture, or nothing if it has none. Without it (in the app)
// the block shows its picture prompt.
export function textToHtml(text, { pictures } = {}) {
  const refs = referenceUrls(text);
  return splitBlocks(text)
    .map((lines) => {
      const heading = lines.length === 1 && lines[0].match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        const level = Math.max(2, heading[1].length);
        return `<h${level}>${esc(heading[2])}</h${level}>`;
      }
      const picture = parsePicture(lines);
      if (picture) {
        if (!pictures) {
          return `<figure class="brief"><figcaption>Picture ${picture.n}: ${esc(picture.title)}</figcaption><p>${esc(picture.description)}</p>`
            + `<p class="muted">Alt text: ${esc(picture.alt)}</p></figure>`;
        }
        const made = pictures.get(picture.n);
        return made ? `<figure><img src="${esc(made.url)}" alt="${esc(picture.alt)}"><figcaption>${esc(picture.title)}</figcaption></figure>` : '';
      }
      const table = parseTable(lines);
      if (table) {
        const row = (tag, values) => `<tr>${values.map((value) => `<${tag}>${inline(esc(value), refs)}</${tag}>`).join('')}</tr>`;
        return `<table>${table.title ? `<caption>${esc(table.title)}</caption>` : ''}<thead>${row('th', table.head)}</thead>`
          + `<tbody>${table.rows.map((values) => row('td', values)).join('')}</tbody></table>`
          + `${table.source ? `\n<p class="source">${inline(esc(table.source), refs)}</p>` : ''}`;
      }
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return list(lines, refs);
      if (lines.every((line) => /^\s*\d{1,4}\.\s+/.test(line))) {
        return `<ol>${lines.map((line) => {
          const [, n, rest] = line.match(/^\s*(\d{1,4})\.\s+(.*)$/);
          return `<li value="${Number(n)}">${inline(esc(rest), refs)}</li>`;
        }).join('')}</ol>`;
      }
      return `<p>${lines.map((line) => inline(esc(line), refs)).join('<br>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

// Line diff for the admin's old/new view: [['same'|'del'|'add', line], ...].
export function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  const same = (lines) => lines.map((line) => ['same', line]);

  // LCS table is x.length × y.length; beyond ~4M cells show a plain replace instead of exhausting memory.
  let middle;
  if (x.length * y.length > 4_000_000) {
    middle = [...x.map((line) => ['del', line]), ...y.map((line) => ['add', line])];
  } else {
    const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        middle.push(['same', x[i]]);
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        middle.push(['del', x[i++]]);
      } else {
        middle.push(['add', y[j++]]);
      }
    }
    while (i < x.length) middle.push(['del', x[i++]]);
    while (j < y.length) middle.push(['add', y[j++]]);
  }
  return [...same(a.slice(0, start)), ...middle, ...same(a.slice(a.length - end))];
}

// Only changed lines plus a little context, capped, for diffs of long web pages.
export function compactDiff(rows, context = 1, max = 300) {
  const keep = new Set();
  rows.forEach(([type], i) => {
    if (type !== 'same') for (let j = i - context; j <= i + context; j++) keep.add(j);
  });
  const out = [];
  let skipped = false;
  rows.forEach((row, i) => {
    if (keep.has(i)) {
      if (skipped) out.push(['gap', '…']);
      out.push(row);
      skipped = false;
    } else {
      skipped = true;
    }
  });
  return out.slice(0, max);
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const BLOCK_TAGS = /<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|main|blockquote|pre|dd|dt)\b[^>]*>/gi;

// Web page HTML → plain text for compliance snapshots. The result is data only and is never rendered as HTML.
export function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, code) => {
      if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : ' ';
    })
    .replace(/[ \t\f\v\r ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n+/g, '\n') // one line per block, so snapshot diffs are line-by-line
    .trim();
}

// Comparable form of a rule or suggestion: lowercase words only.
export const normText = (text) =>
  String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Near-duplicate check on normalized text: same words (Jaccard ≥ 0.8) or one contains the other.
export function isNearDuplicate(a, b) {
  if (!a || !b) return false;
  if (a === b || (a.length > 20 && b.length > 20 && (a.includes(b) || b.includes(a)))) return true;
  const x = new Set(a.split(' '));
  const y = new Set(b.split(' '));
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return shared / (x.size + y.size - shared) >= 0.8;
}

export const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function slugify(title, id) {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
  return `${base || 'article'}-${id}`;
}
