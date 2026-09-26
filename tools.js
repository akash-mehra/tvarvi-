// Read-only tools the writer agent may call. The model never writes SQL: each tool is a fixed,
// parameterized query on a read-only connection, returns at most 5 rows and only whitelisted fields.
import { readOnlyDb } from './db.js';
import { clip } from './text.js';

export const PLATFORMS = ['instagram', 'linkedin', 'x'];
export const MAX_ROWS = 5;

export const TOOL_DEFS = [
  {
    name: 'get_top_posts',
    description:
      "Returns our best-performing approved example posts and published posts for one platform, optionally about a topic, with likes, shares and reach. Call this before drafting to match what works for our audience.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: PLATFORMS, description: 'The platform to look up.' },
        topic: { type: 'string', description: 'A few topic keywords, or "" for any topic.' },
      },
      required: ['platform', 'topic'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_past_articles',
    description:
      'Searches our published articles by keywords and returns titles with short excerpts. Call this when the article covers a topic we may have written about before, so the post stays consistent with what we have said.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords, 3 to 100 characters.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

class ToolInputError extends Error {}

const statements = new Map();
const query = (sql, ...params) =>
  (statements.get(sql) ?? statements.set(sql, readOnlyDb.prepare(sql)).get(sql)).all(...params);

// Search terms are letters and digits only (so no LIKE wildcards), at most 5 of them.
const searchTerms = (text) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 5);
const likeAny = (columns, count) =>
  count ? `AND (${Array.from({ length: count }, () => `(${columns.map((c) => `${c} LIKE ?`).join(' OR ')})`).join(' OR ')})` : '';

// Examples (current version of active ones) and published posts that have engagement numbers,
// ranked by reach + 10 × shares + 3 × likes. Also used to pick the examples placed in the writer's prompt.
export function topPosts(platform, terms = [], limit = MAX_ROWS) {
  return query(
    `SELECT * FROM (
       SELECT 'example' AS source, v.id AS ref_id, v.text AS text, COALESCE(v.likes, 0) AS likes,
         COALESCE(v.shares, 0) AS shares, COALESCE(v.reach, 0) AS reach, substr(v.created_at, 1, 10) AS date
       FROM knowledge k JOIN knowledge_versions v ON v.id = k.current_version_id
       WHERE k.kind = 'example' AND k.active = 1 AND k.platform = ?
       UNION ALL
       SELECT 'published', i.id, i.body, m.likes, m.shares, m.reach, substr(i.published_at, 1, 10)
       FROM items i JOIN post_metrics m ON m.id = (SELECT MAX(id) FROM post_metrics WHERE item_id = i.id)
       WHERE i.channel = ? AND i.status = 'published' AND NOT EXISTS (SELECT 1 FROM knowledge WHERE source_item_id = i.id)
     ) WHERE 1 = 1 ${likeAny(['text'], terms.length)}
     ORDER BY reach + 10 * shares + 3 * likes DESC, date DESC LIMIT ?`,
    platform, platform, ...terms.map((t) => `%${t}%`), limit,
  );
}

function getTopPosts({ platform, topic }) {
  if (!PLATFORMS.includes(platform)) throw new ToolInputError('platform must be "instagram", "linkedin" or "x".');
  if (typeof topic !== 'string' || topic.length > 100) throw new ToolInputError('topic must be text of at most 100 characters ("" for any).');
  const rows = topPosts(platform, searchTerms(topic));
  return {
    rows,
    output: rows.map(({ source, text, likes, shares, reach, date }) => ({ source, text: clip(text, 1200), likes, shares, reach, date })),
  };
}

function excerpt(body, terms) {
  const lower = body.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const start = hits.length ? Math.max(0, Math.min(...hits) - 150) : 0;
  return clip(body.slice(start, start + 500).replace(/\s+/g, ' ').trim(), 400);
}

function searchPastArticles({ query: text }, ctx) {
  if (typeof text !== 'string' || text.trim().length < 3 || text.length > 100) throw new ToolInputError('query must be 3 to 100 characters.');
  const terms = searchTerms(text);
  if (!terms.length) throw new ToolInputError('query needs at least one word of 3 or more letters.');
  const rows = query(
    `SELECT id, title, body, substr(updated_at, 1, 10) AS date FROM articles
     WHERE status = 'published' AND id != ? ${likeAny(['title', 'body'], terms.length)}
     ORDER BY id DESC LIMIT ?`,
    ctx.articleId ?? 0, ...terms.flatMap((t) => [`%${t}%`, `%${t}%`]), MAX_ROWS,
  );
  return { rows, output: rows.map((row) => ({ title: row.title, excerpt: excerpt(row.body, terms), date: row.date })) };
}

const HANDLERS = { get_top_posts: getTopPosts, search_past_articles: searchPastArticles };
const FIELDS = { get_top_posts: ['platform', 'topic'], search_past_articles: ['query'] };

// Never throws. Bad input, unknown tools and failures come back as is_error results the model can react to.
export function runTool(name, input, ctx = {}) {
  if (!Object.hasOwn(HANDLERS, name)) {
    return { isError: true, content: `Unknown tool "${clip(String(name), 40)}". Available: ${Object.keys(HANDLERS).join(', ')}.`, rows: [] };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !FIELDS[name].includes(key))) {
    return { isError: true, content: `Invalid input: expected only ${FIELDS[name].join(', ')}.`, rows: [] };
  }
  try {
    const { rows, output } = HANDLERS[name](input, ctx);
    return { isError: false, content: JSON.stringify(output), rows };
  } catch (err) {
    if (err instanceof ToolInputError) return { isError: true, content: `Invalid input: ${err.message}`, rows: [] };
    console.error(`Tool ${name} failed:`, err);
    return { isError: true, content: 'The tool failed. Continue without it.', rows: [] };
  }
}
