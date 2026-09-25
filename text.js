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

// Article text → safe HTML: blank-line paragraphs, "# " / "## " / "### " headings, "- " bullet lists.
export function textToHtml(text) {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const heading = lines.length === 1 && block.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length + 1;
        return `<h${level}>${esc(heading[2])}</h${level}>`;
      }
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${esc(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${lines.map(esc).join('<br>')}</p>`;
    })
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
