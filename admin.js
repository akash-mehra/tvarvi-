// Admin pages: agent training (versioned rules and examples), web sources, weekly suggestions.
import { callCost, MODEL } from './ai.js';
import { articlesForItems, CoachError, decideSuggestion, isDigestRunning, listDigests, listSuggestions, observationsForDigest, runDigest } from './coach.js';
import { all, one } from './db.js';
import { count, fail, field, oneOf, readForm, redirect, send, toId } from './http.js';
import {
  createEntry, editEntry, entryHistory, getEntry, KINDS, listEntries, postsUsingVersion, rollbackEntry, setActive,
} from './knowledge.js';
import {
  addSource, checkSource, decideSnapshot, KINDS as SOURCE_KINDS, listSources, pendingSnapshots, setSourceActive, SourceError,
} from './sources.js';
import { PLATFORMS } from './tools.js';
import * as view from './views.js';

const requireAdmin = (user) => user.is_admin || fail(403, 'Only admins can do this.');

// One row per agent type and model, each priced at that model's list price.
function usageSummary() {
  const rows = all(
    `SELECT CASE WHEN agent LIKE 'Carousel %' THEN 'Carousel agent' WHEN agent LIKE 'Article %' THEN 'Article agent'
                 WHEN agent LIKE '% writer' THEN 'Writer' WHEN agent LIKE '% compliance' THEN 'Compliance'
                 WHEN agent LIKE '% trend scout' THEN 'Trend scout' ELSE 'Coach' END AS name, model,
       COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read) AS cache_read,
       SUM(cache_write) AS cache_write, SUM(web_searches) AS searches, SUM(web_fetches) AS fetches, ROUND(AVG(ms)) AS ms
     FROM ai_calls WHERE at >= datetime('now', '-7 days') GROUP BY name, model ORDER BY name, model`,
  ).map((row) => ({ ...row, cost: callCost(row) }));
  const articles = one(`SELECT COUNT(DISTINCT article_id) AS n FROM ai_calls WHERE article_id IS NOT NULL AND carousel_id IS NULL AND at >= datetime('now', '-7 days')`).n;
  const articleCost = rows.filter((r) => !['Coach', 'Article agent', 'Carousel agent'].includes(r.name)).reduce((sum, r) => sum + (r.cost ?? 0), 0);
  // Carousels: all their calls (edits and new pictures included), and minutes until each was first ready.
  const carouselCost = rows.filter((r) => r.name === 'Carousel agent').reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const carouselsDone = one(
    `SELECT COUNT(*) AS n, AVG((julianday(finished_at) - julianday(started_at)) * 1440) AS minutes FROM carousels
     WHERE finished_at >= datetime('now', '-7 days') AND id IN (SELECT carousel_id FROM ai_calls WHERE carousel_id IS NOT NULL)`,
  );
  // Article agent: cost and minutes per finished draft.
  const draftCost = rows.filter((r) => r.name === 'Article agent').reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const draftsDone = one(
    `SELECT COUNT(*) AS n, AVG((julianday(finished_at) - julianday(created_at)) * 1440) AS minutes FROM drafts
     WHERE finished_at >= datetime('now', '-7 days') AND id IN (SELECT draft_id FROM ai_calls WHERE draft_id IS NOT NULL)`,
  );
  // Wall-clock time from "approved" until the third (last) post finished, per article.
  const { seconds } = one(
    `SELECT AVG((julianday(done) - julianday(approved)) * 86400) AS seconds FROM (
       SELECT a.approved,
         (SELECT at FROM events WHERE article_id = a.article_id AND action IN ('ai_done', 'ai_failed') AND at >= a.approved
          ORDER BY id LIMIT 1 OFFSET 2) AS done
       FROM (SELECT article_id, MIN(at) AS approved FROM events
             WHERE action = 'approved' AND at >= datetime('now', '-7 days') GROUP BY article_id) a
     ) WHERE done IS NOT NULL`,
  );
  return {
    rows, articles, perArticle: articles ? articleCost / articles : null, seconds,
    drafts: draftsDone.n, perDraft: draftsDone.n ? draftCost / draftsDone.n : null, draftMinutes: draftsDone.minutes,
    carousels: carouselsDone.n, perCarousel: carouselsDone.n ? carouselCost / carouselsDone.n : null, carouselMinutes: carouselsDone.minutes,
    unpriced: rows.some((r) => r.cost == null), models: MODEL,
  };
}

// ---------- agent training ----------

export function trainingPage({ res, user }) {
  requireAdmin(user);
  send(res, view.trainingPage(user, {
    entries: listEntries(),
    usage: usageSummary(),
    auditLog: all('SELECT a.*, u.name AS who FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 50'),
  }));
}

function entryFields(form, kind) {
  return {
    title: field(form, 'title', 'Title', 100, false),
    text: field(form, 'text', 'Text', 5000),
    ...(kind === 'example'
      ? { likes: count(form, 'likes', 'Likes'), shares: count(form, 'shares', 'Shares'), reach: count(form, 'reach', 'Reach') }
      : {}),
  };
}

export async function createKnowledge({ req, res, user }) {
  requireAdmin(user);
  const form = await readForm(req);
  const kind = oneOf(form, 'kind', 'type', Object.keys(KINDS));
  const platform = oneOf(form, 'platform', 'platform', ['all', ...PLATFORMS]);
  if (kind === 'example' && platform === 'all') fail(400, 'Choose the platform this example is for.');
  const { id } = createEntry({ kind, platform: platform === 'all' ? null : platform, ...entryFields(form, kind) }, user.id);
  redirect(res, `/knowledge/${id}`);
}

export function knowledgePage({ res, user, params: [id] }) {
  requireAdmin(user);
  const entry = getEntry(Number(id)) ?? fail(404, 'Entry not found.');
  const history = entryHistory(entry.id).map((v) => ({ ...v, posts: v.used_by ? postsUsingVersion(v.id) : [] }));
  send(res, view.knowledgePage(user, entry, history));
}

export async function knowledgeAction({ req, res, user, params: [id] }) {
  requireAdmin(user);
  const entry = getEntry(Number(id)) ?? fail(404, 'Entry not found.');
  const form = await readForm(req);
  const action = form.get('action');
  if (action === 'edit') {
    const fields = entryFields(form, entry.kind);
    const unchanged = fields.title === entry.title && fields.text === entry.text &&
      (entry.kind !== 'example' || (fields.likes === entry.likes && fields.shares === entry.shares && fields.reach === entry.reach));
    if (unchanged) fail(400, 'Nothing changed, so no new version was created.');
    editEntry(entry.id, fields, user.id, field(form, 'note', 'Note', 200, false) || null);
  } else if (action === 'rollback') {
    const versionId = toId(form.get('version_id'));
    if (versionId === entry.version_id) fail(400, 'That is already the current version.');
    rollbackEntry(entry.id, versionId, user.id) ?? fail(400, 'That version does not belong to this entry.');
  } else if (action === 'deactivate' || action === 'activate') {
    setActive(entry.id, action === 'activate', user.id);
  } else {
    fail(400, 'Unknown action.');
  }
  redirect(res, `/knowledge/${entry.id}`);
}

// ---------- web sources ----------

export function sourcesPage({ res, user }) {
  requireAdmin(user);
  send(res, view.sourcesPage(user, { sources: listSources(), pending: pendingSnapshots() }));
}

export async function createSource({ req, res, user }) {
  requireAdmin(user);
  const form = await readForm(req);
  const kind = oneOf(form, 'kind', 'source type', SOURCE_KINDS);
  let id;
  try {
    id = addSource(field(form, 'url', 'Link', 500), kind, user.id);
  } catch (err) {
    if (err instanceof SourceError) fail(400, err.message);
    throw err;
  }
  // Take the first snapshot right away so the admin can approve it.
  if (kind === 'compliance') await checkSource(one('SELECT * FROM sources WHERE id = ?', id));
  redirect(res, '/sources');
}

export async function sourceAction({ req, res, user, params: [id] }) {
  requireAdmin(user);
  const source = one('SELECT * FROM sources WHERE id = ?', Number(id)) ?? fail(404, 'Source not found.');
  const form = await readForm(req);
  const action = form.get('action');
  if (action === 'check') {
    if (source.kind !== 'compliance' || !source.active) fail(400, 'Only active compliance pages are checked.');
    await checkSource(source);
  } else if (action === 'deactivate' || action === 'activate') {
    setSourceActive(source.id, action === 'activate', user.id);
  } else {
    fail(400, 'Unknown action.');
  }
  redirect(res, '/sources');
}

export async function snapshotAction({ req, res, user, params: [id] }) {
  requireAdmin(user);
  const form = await readForm(req);
  const action = oneOf(form, 'action', 'action', ['approve', 'reject']);
  if (!decideSnapshot(Number(id), action === 'approve', user.id)) fail(409, 'This version was already decided or replaced by a newer one.');
  redirect(res, '/sources');
}

// ---------- weekly suggestions ----------

export function suggestionsPage({ res, user }) {
  requireAdmin(user);
  const pending = listSuggestions(true);
  const decided = listSuggestions(false);
  const itemIds = [...new Set(pending.flatMap((s) => JSON.parse(s.item_ids ?? '[]')))];
  const posts = new Map(articlesForItems(itemIds).map((p) => [p.id, p]));
  const digests = listDigests().map((d) => ({ ...d, observations: d.status === 'done' ? observationsForDigest(d.id).length : 0 }));
  send(res, view.suggestionsPage(user, { pending, decided, posts, digests, running: isDigestRunning() }));
}

export async function generateDigest({ req, res, user }) {
  requireAdmin(user);
  await readForm(req);
  if (isDigestRunning()) fail(409, 'A digest is already being generated. It will appear on this page shortly.');
  void runDigest(user.id);
  redirect(res, '/suggestions');
}

export async function suggestionAction({ req, res, user, params: [id] }) {
  requireAdmin(user);
  const form = await readForm(req);
  const action = oneOf(form, 'action', 'action', ['accept', 'edit', 'reject', 'dismiss']);
  const text = action === 'edit' ? field(form, 'text', 'Edited text', 5000) : null;
  try {
    decideSuggestion(Number(id), action, user.id, text);
  } catch (err) {
    if (err instanceof CoachError) fail(err.status, err.message);
    throw err;
  }
  redirect(res, '/suggestions');
}
