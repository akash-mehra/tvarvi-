import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as admin from './admin.js';
import { generateItem } from './ai.js';
import { DraftError, getDraft, startDraft } from './article.js';
import {
  carouselByLink, carouselFor, deckJson, discardCarousel, editSlides, getCarousel, LIMITS, newLink, newPicture, readSlides,
  readyProblems, recordChecklist, retryCarousel, saveFinals, startCarousel,
} from './carousel.js';
import { runDigest } from './coach.js';
import { all, logEvent, one, recoverInterrupted, run, tx, UPLOADS } from './db.js';
import { imageType } from './gemini.js';
import { BASE, backLink, count, fail, field, GLASS, HttpError, oneOf, readForm, redirect, sameOrigin, SECURE, send, toId } from './http.js';
import { createEntry, latestMetrics } from './knowledge.js';
import { publishItem } from './publish.js';
import { checkAllSources, researchSources } from './sources.js';
import { CAROUSEL_CHECKLIST, CHANNELS, limitProblems, slugify, SOCIAL } from './text.js';
import * as view from './views.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const SLIDES_LIMIT = 40 * 1024 * 1024; // one upload of finished carousel slides
const FLAGS = ['is_admin', 'can_write', 'can_review', 'can_publish'];
const EDITABLE = ['draft', 'failed', 'ready', 'publish_failed'];
const PUBLISHABLE = ['ready', 'publishing', 'published', 'publish_failed'];
const CHANNEL_ORDER = ['website', ...SOCIAL];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CSS = await readFile(new URL('./public/style.css', import.meta.url));

// ---------- passwords & sessions ----------

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [, salt, hash] = stored.split('$');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), 64, SCRYPT);
  return timingSafeEqual(key, Buffer.from(hash, 'base64'));
}

// Unknown emails are checked against this so response time does not reveal who has an account.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));
const newPassword = () => randomBytes(12).toString('base64url');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const failedLogins = new Map(); // user id -> { count, until }

export async function addUser({ name, email, ...flags }, password) {
  const [isAdmin, canWrite, canReview, canPublish] = FLAGS.map((flag) => (flags[flag] ? 1 : 0));
  return run(
    'INSERT INTO users (name, email, pw_hash, is_admin, can_write, can_review, can_publish) VALUES (?, ?, ?, ?, ?, ?, ?)',
    name, email, await hashPassword(password), isAdmin, canWrite, canReview, canPublish,
  ).lastInsertRowid;
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie ?? '').split(';').map((part) => {
      const i = part.indexOf('=');
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
    }),
  );
}

const setSessionCookie = (res, value, maxAge) =>
  res.setHeader('set-cookie', `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`);

function startSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  run('DELETE FROM sessions WHERE expires_at <= ?', Date.now());
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, Date.now() + SESSION_MS);
  setSessionCookie(res, token, SESSION_MS / 1000);
}

function currentUser(req) {
  const token = cookies(req).sid;
  if (!token) return null;
  return one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    sha256(token), Date.now(),
  ) ?? null;
}

// ---------- workflow rules ----------

const getArticle = (id) =>
  one(
    `SELECT a.*, au.name AS author, rv.name AS reviewer FROM articles a
     JOIN users au ON au.id = a.author_id LEFT JOIN users rv ON rv.id = a.reviewer_id WHERE a.id = ?`,
    id,
  ) ?? fail(404, 'Article not found.');

const getItems = (articleId) =>
  all('SELECT * FROM items WHERE article_id = ?', articleId).sort(
    (a, b) => CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel),
  );

const isReviewer = (user, a) => a.reviewer_id === user.id;
const allReady = (items) => items.length === CHANNEL_ORDER.length && items.every((i) => PUBLISHABLE.includes(i.status));
const canView = (user, a) =>
  user.is_admin || a.author_id === user.id || isReviewer(user, a) ||
  (user.can_publish && ['awaiting_publisher', 'published'].includes(a.status));
// Trusted people publish: the assigned reviewer while approved, any publisher once handed over.
const canPublish = (user, a, items) =>
  !!user.can_publish && allReady(items) &&
  (a.status === 'awaiting_publisher' || (a.status === 'approved' && isReviewer(user, a)));

function expectStatus(a, ...statuses) {
  if (!statuses.includes(a.status)) fail(409, 'This article has moved on since you opened it. Reload to see where it is now.');
}

// Guarded transition: applies only if the row still has the status we read, so double submits and races are no-ops.
function updateArticle(a, sql, ...params) {
  const { changes } = run(`${sql}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`, ...params, a.id, a.status);
  if (!changes) fail(409, 'This article was just changed by someone else (or a double click). Reload to see the latest.');
}

function updateItem(item, sql, ...params) {
  const { changes } = run(`${sql} WHERE id = ? AND status = ?`, ...params, item.id, item.status);
  if (!changes) fail(409, 'This post was just changed (or a double click). Reload to see the latest.');
}

// A reviewer without publishing rights hands the finished set to the publisher dashboard.
function handOffIfDone(a, user) {
  if (user.can_publish || !allReady(getItems(a.id))) return;
  updateArticle(a, `UPDATE articles SET status = 'awaiting_publisher'`);
  logEvent(a.id, null, 'sent_to_publisher', 'automatically, because the reviewer cannot publish');
}

// ---------- pages & actions ----------

const LIST_SQL = `SELECT a.id, a.title, a.status, a.updated_at, au.name AS author, rv.name AS reviewer
  FROM articles a JOIN users au ON au.id = a.author_id LEFT JOIN users rv ON rv.id = a.reviewer_id`;

function dashboard({ res, user }) {
  send(res, view.dashboardPage(user, {
    mine: user.can_write ? all(`${LIST_SQL} WHERE a.author_id = ? ORDER BY a.id DESC LIMIT 50`, user.id) : [],
    drafts: user.can_write ? all('SELECT id, topic, status, created_at FROM drafts WHERE created_by = ? ORDER BY id DESC LIMIT 20', user.id) : [],
    researchReady: user.can_write && researchSources().length > 0,
    queue: user.is_admin ? all(`${LIST_SQL} WHERE a.status IN ('submitted', 'returned') ORDER BY a.updated_at`) : [],
    inProgress: user.is_admin
      ? all(`${LIST_SQL} WHERE a.status IN ('in_review', 'approved', 'awaiting_publisher') ORDER BY a.updated_at DESC`)
      : [],
    reviews: user.can_review
      ? all(`${LIST_SQL} WHERE a.reviewer_id = ? AND a.status IN ('in_review', 'approved') ORDER BY a.updated_at`, user.id)
      : [],
    publishing: user.can_publish ? all(`${LIST_SQL} WHERE a.status = 'awaiting_publisher' ORDER BY a.updated_at`) : [],
    attention: user.is_admin
      ? {
          suggestions: one(`SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending'`).n,
          snapshots: one(`SELECT COUNT(*) AS n FROM snapshots WHERE status = 'pending'`).n,
        }
      : null,
  }));
}

// For each post: what it used (with links to rule/example history), latest engagement, and whether it is an example.
function describeItems(items) {
  return items.map((item) => ({
    ...item,
    inputs: all(
      `SELECT ii.kind, ii.ref_id, ii.label, kv.knowledge_id FROM item_inputs ii
       LEFT JOIN knowledge_versions kv ON ii.kind IN ('rule', 'example') AND kv.id = ii.ref_id
       WHERE ii.item_id = ? ORDER BY CASE ii.kind WHEN 'rule' THEN 1 WHEN 'example' THEN 2 WHEN 'post' THEN 3
         WHEN 'snapshot' THEN 4 WHEN 'web' THEN 5 ELSE 6 END, ii.rowid`,
      item.id,
    ),
    metrics: latestMetrics(item.id),
    promoted: one('SELECT id FROM knowledge WHERE source_item_id = ?', item.id)?.id ?? null,
    carousel: item.channel === 'instagram' ? carouselFor(item.id) : null,
  }));
}

async function createArticle({ req, res, user }) {
  if (!user.can_write) fail(403, 'Only writers can submit articles.');
  const form = await readForm(req);
  const title = field(form, 'title', 'Title', 200);
  const body = field(form, 'body', 'Article', 100_000);
  const draftId = form.get('draft_id') ? toId(form.get('draft_id')) : null;
  const id = tx(() => {
    // An AI draft becomes an article only here, submitted by the person who started it.
    const draft = draftId ? one('SELECT id, topic, created_by FROM drafts WHERE id = ?', draftId) : null;
    if (draftId && draft?.created_by !== user.id) fail(403, 'You can only submit your own drafts.');
    const { lastInsertRowid } = run('INSERT INTO articles (title, body, author_id) VALUES (?, ?, ?)', title, body, user.id);
    logEvent(lastInsertRowid, user.id, 'submitted');
    if (draft) {
      const { changes } = run(
        `UPDATE drafts SET status = 'submitted', article_id = ? WHERE id = ? AND status IN ('ready', 'needs_attention')`, lastInsertRowid, draft.id);
      if (!changes) fail(409, 'This draft was already submitted or discarded.');
      logEvent(lastInsertRowid, user.id, 'ai_drafted', `from the topic "${draft.topic}"`);
    }
    return lastInsertRowid;
  });
  redirect(res, `/articles/${id}`);
}

// ---------- article agent drafts ----------

function start(res, topic, user) {
  let id;
  try {
    id = startDraft(topic, user.id);
  } catch (err) {
    if (err instanceof DraftError) fail(err.status, err.message);
    throw err;
  }
  redirect(res, `/drafts/${id}`);
}

async function createDraft({ req, res, user }) {
  if (!user.can_write) fail(403, 'Only writers can draft articles.');
  start(res, field(await readForm(req), 'topic', 'Topic', 150), user);
}

// The research record: the person who started it, admins, and anyone who can see the article it became.
function findDraft(user, id) {
  const draft = getDraft(Number(id)) ?? fail(404, 'Draft not found.');
  const article = draft.article_id ? getArticle(draft.article_id) : null;
  if (!(user.is_admin || draft.created_by === user.id || (article && canView(user, article)))) fail(403, 'You do not have access to this draft.');
  return draft;
}

function draftPage({ res, user, params: [id] }) {
  const draft = findDraft(user, id);
  send(res, view.draftPage(user, { draft, own: draft.created_by === user.id }));
}

async function draftAction({ req, res, user, params: [id] }) {
  const form = await readForm(req);
  const action = oneOf(form, 'action', 'action', ['discard', 'retry']);
  const draft = findDraft(user, id);
  if (draft.created_by !== user.id || !user.can_write) fail(403, 'Only the writer who started this draft can do that.');
  if (action === 'retry') {
    if (draft.status !== 'failed') fail(409, 'Only a failed draft can be tried again.');
    return start(res, draft.topic, user);
  }
  const { changes } = run(`UPDATE drafts SET status = 'discarded' WHERE id = ? AND status IN ('ready', 'needs_attention', 'failed')`, draft.id);
  if (!changes) fail(409, 'This draft can no longer be discarded.');
  redirect(res, '/');
}

function articlePage({ res, user, params: [id] }) {
  const a = getArticle(Number(id));
  if (!canView(user, a)) fail(403, 'You do not have access to this article.');
  const items = getItems(a.id);
  const generating = items.some((i) => i.status === 'generating');
  const perm = {
    assign: !!user.is_admin && ['submitted', 'returned'].includes(a.status),
    review: isReviewer(user, a) && a.status === 'in_review',
    // Editing is paused while the page auto-refreshes for the AI, so no typing is lost.
    editItems: isReviewer(user, a) && a.status === 'approved' && !generating,
    publish: canPublish(user, a, items),
    sendToPublisher: isReviewer(user, a) && !!user.can_publish && a.status === 'approved' && allReady(items),
    sendBack: !!user.can_publish && a.status === 'awaiting_publisher',
    promote: !!user.is_admin,
    metrics: !!(user.is_admin || user.can_publish),
  };
  send(res, view.articlePage(user, {
    article: { ...a, draftId: one('SELECT id FROM drafts WHERE article_id = ?', a.id)?.id ?? null },
    items: describeItems(items),
    perm,
    generating,
    events: all(
      'SELECT e.*, u.name AS who FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.article_id = ? ORDER BY e.id',
      a.id,
    ),
    reviewers: perm.assign
      ? all('SELECT id, name FROM users WHERE can_review = 1 AND active = 1 AND id != ? ORDER BY name', a.author_id)
      : [],
  }));
}

async function articleAction({ req, res, user, params: [id] }) {
  const a = getArticle(Number(id));
  const form = await readForm(req);
  const action = form.get('action');

  if (action === 'assign') {
    if (!user.is_admin) fail(403, 'Only admins assign reviewers.');
    expectStatus(a, 'submitted', 'returned');
    const reviewer = one('SELECT id, name FROM users WHERE id = ? AND can_review = 1 AND active = 1', toId(form.get('reviewer_id')))
      ?? fail(400, 'Choose an active reviewer.');
    if (reviewer.id === a.author_id) fail(400, 'Writers cannot review their own article.');
    const revert = a.status === 'returned' && form.get('version') === 'old';
    const [title, body] = revert ? [a.base_title, a.base_body] : [a.title, a.body];
    tx(() => {
      updateArticle(a, `UPDATE articles SET title = ?, body = ?, base_title = ?, base_body = ?, reviewer_id = ?, note = NULL, status = 'in_review'`,
        title, body, title, body, reviewer.id);
      logEvent(a.id, user.id, 'assigned', `${reviewer.name}${revert ? ' (reverted to the previous version)' : ''}`);
    });
  } else if (action === 'approve' || action === 'send_to_admin') {
    if (!isReviewer(user, a)) fail(403, 'Only the assigned reviewer can do this.');
    expectStatus(a, 'in_review');
    const title = field(form, 'title', 'Title', 200);
    const body = field(form, 'body', 'Article', 100_000);
    const changed = title !== a.title || body !== a.body;
    if (action === 'approve') {
      if (changed) fail(400, 'You changed the text, so use "Send to admin" and the admin will see your changes.');
      const itemIds = tx(() => {
        updateArticle(a, `UPDATE articles SET status = 'approved', note = NULL`);
        run(`INSERT INTO items (article_id, channel, status) VALUES (?, 'website', 'ready')`, a.id);
        logEvent(a.id, user.id, 'approved');
        return SOCIAL.map((channel) =>
          run(`INSERT INTO items (article_id, channel, status) VALUES (?, ?, 'generating')`, a.id, channel).lastInsertRowid);
      });
      for (const itemId of itemIds) void generateItem(itemId);
    } else {
      const secondOpinion = form.get('second_opinion') === '1';
      const note = [secondOpinion && 'Second opinion requested.', field(form, 'note', 'Note', 2000, false)].filter(Boolean).join(' ');
      if (!changed && !note) fail(400, 'Nothing to send: edit the text, add a note or ask for a second opinion. If it is fine as it is, approve it.');
      tx(() => {
        updateArticle(a, `UPDATE articles SET title = ?, body = ?, note = ?, status = 'returned'`, title, body, note || null);
        logEvent(a.id, user.id, 'sent_to_admin', [changed && 'text changed', note].filter(Boolean).join('. '));
      });
    }
  } else if (action === 'send_to_publisher') {
    if (!isReviewer(user, a) || !user.can_publish) fail(403, 'Only the assigned reviewer with publishing rights can do this.');
    expectStatus(a, 'approved');
    if (!allReady(getItems(a.id))) fail(400, 'Mark every post ready first.');
    tx(() => {
      updateArticle(a, `UPDATE articles SET status = 'awaiting_publisher'`);
      logEvent(a.id, user.id, 'sent_to_publisher');
    });
  } else if (action === 'send_back') {
    if (!user.can_publish) fail(403, 'Only publishers can send an article back.');
    expectStatus(a, 'awaiting_publisher');
    const note = field(form, 'note', 'Note', 2000, false);
    tx(() => {
      updateArticle(a, `UPDATE articles SET status = 'approved', note = ?`, note || null);
      logEvent(a.id, user.id, 'sent_back', note || null);
    });
  } else {
    fail(400, 'Unknown action.');
  }
  redirect(res, `/articles/${a.id}`);
}

async function itemAction({ req, res, user, params: [id] }) {
  const item = one('SELECT * FROM items WHERE id = ?', Number(id)) ?? fail(404, 'Post not found.');
  const a = getArticle(item.article_id);
  const form = await readForm(req);
  const action = form.get('action');
  if (action === 'publish') return publish(res, user, a, item);
  if (action === 'promote') return promote(res, user, a, item);
  if (action === 'metrics') return recordMetrics(res, user, a, item, form);

  if (!isReviewer(user, a)) fail(403, 'Only the assigned reviewer can change posts.');
  expectStatus(a, 'approved');
  if (item.channel === 'website') fail(400, 'The website item is the approved article itself.');
  if (!EDITABLE.includes(item.status)) fail(409, 'This post cannot be changed right now.');
  const label = CHANNELS[item.channel].label;

  if (action === 'save' || action === 'ready') {
    const body = field(form, 'body', 'Post', 10_000, action === 'ready');
    const carousel = item.channel === 'instagram' ? carouselFor(item.id) : null;
    if (action === 'ready') {
      const problems = limitProblems(item.channel, body);
      if (carousel) {
        problems.push(...readyProblems(carousel, CAROUSEL_CHECKLIST.map(([key]) => key).filter((key) => form.get(`check_${key}`) === '1')));
      } else if (item.channel === 'instagram' && !item.image) {
        problems.push('Upload an image or make a carousel first. Instagram posts need one.');
      }
      if (problems.length) fail(400, problems.join(' '));
    }
    tx(() => {
      updateItem(item, `UPDATE items SET body = ?, error = NULL, status = ?, reviewed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE reviewed_at END`,
        body, action === 'ready' ? 'ready' : 'draft', action === 'ready' ? 1 : 0);
      if (action === 'ready' && carousel) logEvent(a.id, user.id, 'carousel_checked', recordChecklist(carousel, user.id));
      logEvent(a.id, user.id, action === 'ready' ? 'ready' : 'edited', label);
      if (action === 'ready') handOffIfDone(a, user);
    });
  } else if (action === 'regenerate') {
    tx(() => {
      updateItem(item, `UPDATE items SET status = 'generating', error = NULL`);
      logEvent(a.id, user.id, 'regenerate', label);
    });
    void generateItem(item.id);
  } else {
    fail(400, 'Unknown action.');
  }
  redirect(res, `/articles/${a.id}`);
}

// Admin turns a reviewer-approved post into a versioned example the writer agent learns from.
function promote(res, user, a, item) {
  if (!user.is_admin) fail(403, 'Only admins can add examples.');
  if (!SOCIAL.includes(item.channel) || !['ready', 'published'].includes(item.status)) {
    fail(400, 'Only social posts that a reviewer marked ready (or that are published) can become examples.');
  }
  if (one('SELECT 1 FROM knowledge WHERE source_item_id = ?', item.id)) fail(409, 'This post is already an example.');
  const metrics = latestMetrics(item.id);
  tx(() => {
    createEntry({
      kind: 'example', platform: item.channel, text: item.body, likes: metrics?.likes, shares: metrics?.shares,
      reach: metrics?.reach, sourceItemId: item.id, note: `Promoted from "${a.title}"`,
    }, user.id);
    logEvent(a.id, user.id, 'promoted', CHANNELS[item.channel].label);
  });
  redirect(res, `/articles/${a.id}`);
}

// Engagement typed in from the platform. Later the Instagram Insights API adds rows with source 'instagram_insights'.
function recordMetrics(res, user, a, item, form) {
  if (!user.is_admin && !user.can_publish) fail(403, 'Only admins and publishers can record engagement.');
  if (!SOCIAL.includes(item.channel) || item.status !== 'published') fail(400, 'Engagement can only be recorded for published social posts.');
  const [likes, shares, reach, saves] = [['likes', 'Likes'], ['shares', 'Shares'], ['reach', 'Reach'], ['saves', 'Saves']]
    .map(([name, label]) => count(form, name, label) ?? 0);
  tx(() => {
    run(`INSERT INTO post_metrics (item_id, likes, shares, reach, saves, source, recorded_by) VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
      item.id, likes, shares, reach, saves, user.id);
    logEvent(a.id, user.id, 'metrics', `${CHANNELS[item.channel].label}: ${reach} reach, ${shares} shares, ${likes} likes, ${saves} saves`);
  });
  redirect(res, `/articles/${a.id}`);
}

async function publish(res, user, a, item) {
  if (!canPublish(user, a, getItems(a.id))) fail(403, 'You cannot publish this yet.');
  const label = CHANNELS[item.channel].label;
  // Claim the item first: a second click or a second publisher cannot post it twice.
  const { changes } = run(`UPDATE items SET status = 'publishing', error = NULL WHERE id = ? AND status IN ('ready', 'publish_failed')`, item.id);
  if (!changes) return redirect(res, `/articles/${a.id}`);
  try {
    const slides = item.channel === 'instagram' ? carouselFor(item.id)?.finals ?? [] : [];
    const { url, simulated } = await publishItem({ ...item, slides }, a, BASE);
    tx(() => {
      run(
        `UPDATE items SET status = 'published', external_url = ?, simulated = ?, published_by = ?, published_at = CURRENT_TIMESTAMP WHERE id = ?`,
        url, simulated ? 1 : 0, user.id, item.id,
      );
      logEvent(a.id, user.id, 'published', `${label}${simulated ? ' (simulated)' : ''}${url ? ` ${url}` : ''}`);
      if (getItems(a.id).every((i) => i.status === 'published')) {
        run(`UPDATE articles SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, a.id);
        logEvent(a.id, null, 'completed');
      }
    });
  } catch (err) {
    console.error(`Publishing item ${item.id} failed:`, err);
    const message = String(err.message).slice(0, 500);
    run(`UPDATE items SET status = 'publish_failed', error = ? WHERE id = ?`, message, item.id);
    logEvent(a.id, user.id, 'publish_failed', `${label}: ${message}`);
  }
  redirect(res, `/articles/${a.id}`);
}

async function uploadImage({ req, res, user, params: [id] }) {
  const item = one('SELECT * FROM items WHERE id = ?', Number(id)) ?? fail(404, 'Post not found.');
  const a = getArticle(item.article_id);
  if (!isReviewer(user, a)) fail(403, 'Only the assigned reviewer can change posts.');
  expectStatus(a, 'approved');
  if (item.channel !== 'instagram') fail(400, 'Only Instagram posts take an image.');
  if (!EDITABLE.includes(item.status)) fail(409, 'This post cannot be changed right now.');
  const form = await readForm(req, IMAGE_LIMIT + 64 * 1024);
  const file = form.get('image');
  if (!(file instanceof File) || !file.size) fail(400, 'Choose a JPEG image.');
  if (file.size > IMAGE_LIMIT) fail(413, 'The image must be 8 MB or smaller.');
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail(400, 'Instagram only accepts JPEG images.');
  const name = `${randomUUID()}.jpg`;
  await writeFile(join(UPLOADS, name), bytes, { flag: 'wx' });
  try {
    tx(() => {
      updateItem(item, `UPDATE items SET image = ?, status = 'draft'`, name);
      logEvent(a.id, user.id, 'image', 'Instagram');
    });
  } catch (err) {
    await unlink(join(UPLOADS, name)).catch(() => {});
    throw err;
  }
  if (item.image) await unlink(join(UPLOADS, item.image)).catch(() => {});
  redirect(res, `/articles/${a.id}`);
}

// ---------- Instagram carousels ----------

// Anyone who can see the article can see its carousel.
function findCarousel(user, id) {
  const c = getCarousel(Number(id)) ?? fail(404, 'Carousel not found.');
  const a = getArticle(c.article_id);
  if (!canView(user, a)) fail(403, 'You do not have access to this carousel.');
  return { c, a, item: one('SELECT * FROM items WHERE id = ?', c.item_id) };
}

// Only the assigned reviewer changes it, while the article is approved and the post can still change.
function expectCarouselEditor(user, a, item) {
  if (!isReviewer(user, a)) fail(403, 'Only the assigned reviewer can change the carousel.');
  expectStatus(a, 'approved');
  if (!EDITABLE.includes(item.status)) fail(409, 'This post cannot be changed right now.');
}

function createCarousel({ res, user, params: [id] }) {
  const item = one('SELECT * FROM items WHERE id = ?', Number(id)) ?? fail(404, 'Post not found.');
  const a = getArticle(item.article_id);
  if (item.channel !== 'instagram') fail(400, 'Only Instagram posts can be carousels.');
  expectCarouselEditor(user, a, item);
  const carouselId = startCarousel(item.id, user.id);
  logEvent(a.id, user.id, 'carousel', 'Instagram');
  redirect(res, `/carousels/${carouselId}`);
}

function carouselPage({ res, user, params: [id] }) {
  const { c, a, item } = findCarousel(user, id);
  send(res, view.carouselPage(user, {
    carousel: c,
    article: a,
    editable: isReviewer(user, a) && a.status === 'approved' && EDITABLE.includes(item.status),
    glass: !!GLASS,
    pictures: !!process.env.GEMINI_API_KEY,
  }));
}

async function carouselAction({ req, res, user, params: [id] }) {
  const { c, a, item } = findCarousel(user, id);
  expectCarouselEditor(user, a, item);
  const form = await readForm(req);
  const action = String(form.get('action') ?? '');
  const picture = /^picture_(\d{1,2})$/.exec(action);
  if (action === 'save' || picture) {
    const edits = c.slides.map((_, i) => ({
      heading: field(form, `heading_${i}`, `Slide ${i + 1} heading`, LIMITS.heading, false),
      body: field(form, `body_${i}`, `Slide ${i + 1} text`, LIMITS.body, false),
      brief: field(form, `brief_${i}`, `Slide ${i + 1} picture brief`, LIMITS.brief, false),
    }));
    if (picture) newPicture(c, Number(picture[1]), edits);
    else editSlides(c, edits);
  } else if (action === 'retry') {
    if (c.status !== 'failed') fail(409, 'Only a failed carousel can be tried again.');
    retryCarousel(c);
  } else if (action === 'restart') {
    startCarousel(item.id, user.id);
    logEvent(a.id, user.id, 'carousel', 'started over');
  } else if (action === 'discard') {
    discardCarousel(c);
    logEvent(a.id, user.id, 'carousel_removed', 'Instagram');
    return redirect(res, `/articles/${a.id}`);
  } else {
    fail(400, 'Unknown action.');
  }
  redirect(res, `/carousels/${c.id}`);
}

// The finished slides from Glass Slides: its "Export all" .zip, or the JPEGs.
async function uploadSlides({ req, res, user, params: [id] }) {
  const { c, a, item } = findCarousel(user, id);
  expectCarouselEditor(user, a, item);
  const form = await readForm(req, SLIDES_LIMIT + 64 * 1024);
  const files = form.getAll('slides').filter((file) => file instanceof File && file.size);
  const slides = readSlides(await Promise.all(files.map(async (file) => ({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }))), c.slides.length);
  await saveFinals(c, slides);
  logEvent(a.id, user.id, 'carousel_slides', `${slides.length} slides`);
  redirect(res, `/carousels/${c.id}`);
}

// Opens the deck in Glass Slides: a link that works for 30 minutes, fetched back from /glass/t/<token>.
function openDeck({ res, user, params: [id] }) {
  if (!GLASS) fail(404, 'Glass Slides is not set up here. Download the deck file instead.');
  const { c } = findCarousel(user, id);
  const url = new URL(GLASS);
  url.search = new URLSearchParams({ t: newLink(c), s: `${BASE.origin}/glass` });
  redirect(res, url.href);
}

async function downloadDeck({ res, user, params: [id] }) {
  const { c, a } = findCarousel(user, id);
  if (c.status !== 'ready') fail(409, 'The deck can be downloaded once the carousel is ready.');
  const body = await deckJson(c);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${slugify(a.title, a.id)}-carousel.json"`,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// Gemini's pictures are not public: only people who can see the article see them.
async function carouselPicture({ res, user, params: [id, name] }) {
  const { c } = findCarousel(user, id);
  if (!c.slides.some((s) => s.picture === name)) fail(404, 'Picture not found.');
  const bytes = await readFile(join(UPLOADS, name)).catch(() => fail(404, 'Picture not found.'));
  res.writeHead(200, { 'content-type': imageType(bytes) ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'private, max-age=3600' });
  res.end(bytes);
}

// Public: Glass Slides fetches the deck with a link token and no cookies. Only its origin may read the answer.
async function glassDeck({ res, params: [token] }) {
  const headers = { 'cache-control': 'no-store', ...(GLASS ? { 'access-control-allow-origin': GLASS.origin, vary: 'origin' } : {}) };
  const c = GLASS ? carouselByLink(token) : null;
  if (!c) {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    return res.end('This link has expired. Open the deck from Tvarvi again.');
  }
  const body = await deckJson(c);
  res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// Public on purpose: Instagram downloads the image from here. Names are random UUIDs.
async function media({ res, params: [name] }) {
  const bytes = await readFile(join(UPLOADS, name)).catch(() => fail(404, 'Image not found.'));
  res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': bytes.length, 'cache-control': 'public, max-age=31536000, immutable' });
  res.end(bytes);
}

function stylesheet({ res }) {
  res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' });
  res.end(CSS);
}

function loginPage({ res, user }) {
  if (user) return redirect(res, '/');
  send(res, view.loginPage());
}

async function login({ req, res }) {
  const form = await readForm(req);
  const email = String(form.get('email') ?? '').trim().slice(0, 254);
  const password = String(form.get('password') ?? '').slice(0, 200);
  const found = one('SELECT id, pw_hash FROM users WHERE email = ? AND active = 1', email);
  const attempts = (found && failedLogins.get(found.id)) || { count: 0, until: 0 };
  if (attempts.until > Date.now()) return send(res, view.loginPage('Too many attempts. Try again in 15 minutes.'), 429);
  const ok = await verifyPassword(password, found?.pw_hash ?? DUMMY_HASH);
  if (!found || !ok) {
    if (found) {
      attempts.count += 1;
      if (attempts.count >= 5) Object.assign(attempts, { count: 0, until: Date.now() + LOCK_MS });
      failedLogins.set(found.id, attempts);
    }
    return send(res, view.loginPage('Wrong email or password.'), 401);
  }
  failedLogins.delete(found.id);
  startSession(res, found.id);
  redirect(res, '/');
}

function logout({ req, res }) {
  const token = cookies(req).sid;
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  setSessionCookie(res, '', 0);
  redirect(res, '/login');
}

function usersPage({ res, user }, created) {
  if (!user.is_admin) fail(403, 'Only admins manage the team.');
  send(res, view.usersPage(user, all('SELECT * FROM users ORDER BY active DESC, name'), created));
}

const flagsFrom = (form) => Object.fromEntries(FLAGS.map((flag) => [flag, form.get(flag) === '1' ? 1 : 0]));

async function createUser(ctx) {
  if (!ctx.user.is_admin) fail(403, 'Only admins manage the team.');
  const form = await readForm(ctx.req);
  const name = field(form, 'name', 'Name', 100);
  const email = field(form, 'email', 'Email', 254);
  if (!EMAIL.test(email)) fail(400, 'Enter a valid email address.');
  if (one('SELECT 1 FROM users WHERE email = ?', email)) fail(400, 'That email is already on the team.');
  const password = newPassword();
  await addUser({ name, email, ...flagsFrom(form) }, password);
  usersPage(ctx, { email, password });
}

async function updateUser(ctx) {
  const { req, res, user, params: [id] } = ctx;
  if (!user.is_admin) fail(403, 'Only admins manage the team.');
  const target = one('SELECT * FROM users WHERE id = ?', Number(id)) ?? fail(404, 'Team member not found.');
  const form = await readForm(req);
  if (form.get('action') === 'reset_password') {
    if (target.id === user.id) fail(400, 'Change your own password by clicking your name at the top right.');
    const password = newPassword();
    run('UPDATE users SET pw_hash = ? WHERE id = ?', await hashPassword(password), target.id);
    run('DELETE FROM sessions WHERE user_id = ?', target.id);
    return usersPage(ctx, { email: target.email, password });
  }
  const flags = flagsFrom(form);
  let active = form.get('active') === '1' ? 1 : 0;
  if (target.id === user.id) {
    flags.is_admin = 1; // admins cannot lock themselves out
    active = 1;
  }
  run(
    'UPDATE users SET is_admin = ?, can_write = ?, can_review = ?, can_publish = ?, active = ? WHERE id = ?',
    flags.is_admin, flags.can_write, flags.can_review, flags.can_publish, active, target.id,
  );
  if (!active) run('DELETE FROM sessions WHERE user_id = ?', target.id);
  redirect(res, '/users');
}

function accountPage({ res, user }, message) {
  send(res, view.accountPage(user, message));
}

async function changePassword(ctx) {
  const { req, res, user } = ctx;
  const form = await readForm(req);
  const password = String(form.get('password') ?? '');
  if (!(await verifyPassword(String(form.get('current') ?? '').slice(0, 200), user.pw_hash))) fail(400, 'Your current password is wrong.');
  if (password.length < 12 || password.length > 200) fail(400, 'The new password needs 12 to 200 characters.');
  if (password !== form.get('confirm')) fail(400, 'The two new passwords do not match.');
  run('UPDATE users SET pw_hash = ? WHERE id = ?', await hashPassword(password), user.id);
  run('DELETE FROM sessions WHERE user_id = ?', user.id);
  startSession(res, user.id);
  accountPage(ctx, 'Password changed. Other devices were logged out.');
}

// ---------- routing ----------

const routes = [
  // [method, path, handler, public]
  ['GET', /^\/login$/, loginPage, true],
  ['POST', /^\/login$/, login, true],
  ['GET', /^\/style\.css$/, stylesheet, true],
  ['GET', /^\/media\/([0-9a-f-]{36}\.jpg)$/, media, true],
  ['GET', /^\/glass\/t\/([A-Za-z0-9_-]{43})$/, glassDeck, true],
  ['POST', /^\/logout$/, logout],
  ['GET', /^\/$/, dashboard],
  ['POST', /^\/articles$/, createArticle],
  ['POST', /^\/drafts$/, createDraft],
  ['GET', /^\/drafts\/(\d{1,12})$/, draftPage],
  ['POST', /^\/drafts\/(\d{1,12})$/, draftAction],
  ['GET', /^\/articles\/(\d{1,12})$/, articlePage],
  ['POST', /^\/articles\/(\d{1,12})$/, articleAction],
  ['POST', /^\/items\/(\d{1,12})$/, itemAction],
  ['POST', /^\/items\/(\d{1,12})\/image$/, uploadImage],
  ['POST', /^\/items\/(\d{1,12})\/carousel$/, createCarousel],
  ['GET', /^\/carousels\/(\d{1,12})$/, carouselPage],
  ['POST', /^\/carousels\/(\d{1,12})$/, carouselAction],
  ['POST', /^\/carousels\/(\d{1,12})\/slides$/, uploadSlides],
  ['POST', /^\/carousels\/(\d{1,12})\/link$/, openDeck],
  ['GET', /^\/carousels\/(\d{1,12})\/deck\.json$/, downloadDeck],
  ['GET', /^\/carousels\/(\d{1,12})\/pictures\/(pic-[0-9a-f-]{36}\.(?:png|jpg|webp))$/, carouselPicture],
  ['GET', /^\/users$/, usersPage],
  ['POST', /^\/users$/, createUser],
  ['POST', /^\/users\/(\d{1,12})$/, updateUser],
  ['GET', /^\/account$/, accountPage],
  ['POST', /^\/account$/, changePassword],
  ['GET', /^\/training$/, admin.trainingPage],
  ['POST', /^\/knowledge$/, admin.createKnowledge],
  ['GET', /^\/knowledge\/(\d{1,12})$/, admin.knowledgePage],
  ['POST', /^\/knowledge\/(\d{1,12})$/, admin.knowledgeAction],
  ['GET', /^\/sources$/, admin.sourcesPage],
  ['POST', /^\/sources$/, admin.createSource],
  ['POST', /^\/sources\/(\d{1,12})$/, admin.sourceAction],
  ['POST', /^\/snapshots\/(\d{1,12})$/, admin.snapshotAction],
  ['GET', /^\/suggestions$/, admin.suggestionsPage],
  ['POST', /^\/suggestions$/, admin.generateDigest],
  ['POST', /^\/suggestions\/(\d{1,12})$/, admin.suggestionAction],
];

// ---------- background jobs (single instance) ----------

const DAY = 24 * 60 * 60 * 1000;
const JOBS = [
  ['compliance_snapshots', DAY, checkAllSources],
  ['weekly_digest', 7 * DAY, () => runDigest(null)],
];

export async function runDueJobs(now = Date.now()) {
  for (const [name, every, job] of JOBS) {
    const last = one('SELECT last_run_at FROM jobs WHERE name = ?', name)?.last_run_at ?? 0;
    if (now - last < every) continue;
    // Recorded first, so a crashing job waits for its next slot instead of retrying every hour.
    run('INSERT INTO jobs (name, last_run_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at', name, now);
    try {
      await job();
    } catch (err) {
      console.error(`Background job ${name} failed:`, err);
    }
  }
}

function startJobs() {
  const tick = () => runDueJobs().catch((err) => console.error('Background jobs failed:', err));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}

export async function handler(req, res) {
  res.setHeader('content-security-policy',
    `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'${GLASS ? ` ${GLASS.origin}` : ''}; frame-ancestors 'none'; base-uri 'none'`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  let user = null;
  try {
    const { pathname } = new URL(req.url, BASE);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const [, pattern, route, isPublic] = routes.find(([m, p]) => m === method && p.test(pathname)) ?? fail(404, 'Page not found.');
    if (method === 'POST' && !sameOrigin(req)) fail(403, 'Blocked a request that did not come from this site.');
    user = currentUser(req);
    if (!isPublic && !user) return redirect(res, '/login');
    await route({ req, res, user, params: pathname.match(pattern).slice(1) });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) return res.destroy();
    const status = err instanceof HttpError ? err.status : 500;
    const message = status === 500 ? 'Please try again. If it keeps happening, tell your admin.' : err.message;
    send(res, view.errorPage(user, status, message, backLink(req)), status);
  }
}

async function main() {
  const [command, email, ...nameParts] = process.argv.slice(2);
  if (command === 'create-admin') {
    const name = nameParts.join(' ').trim();
    if (!EMAIL.test(email ?? '') || !name || name.length > 100) {
      console.error('Usage: npm run create-admin -- <email> "<full name>"');
      process.exit(1);
    }
    if (one('SELECT 1 FROM users WHERE email = ?', email)) {
      console.error(`${email} already exists.`);
      process.exit(1);
    }
    const password = newPassword();
    await addUser({ name, email, is_admin: 1, can_write: 1, can_review: 1, can_publish: 1 }, password);
    console.log(`Admin created: ${email}\nPassword: ${password}\nChange it after logging in (click your name at the top right).`);
    return;
  }
  if (!process.env.PUBLIC_BASE_URL) {
    console.error('Set PUBLIC_BASE_URL (for example http://localhost:3000). See .env.example.');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY is not set: AI post writing will fail until it is.');
  recoverInterrupted();
  if (process.env.BACKGROUND_JOBS !== 'off') startJobs();
  const server = createServer(handler);
  server.listen(Number(process.env.PORT) || 3000, () => console.log(`Tvarvi is running at ${BASE.origin}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
