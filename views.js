import { isDryRun } from './publish.js';
import { CHANNELS, clip, compactDiff, esc, KNOWLEDGE_KINDS, lineDiff, postLength, SOCIAL, textToHtml } from './text.js';

// Every interpolated value is escaped unless it is itself html`` output or wrapped in raw().
class Safe {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}
export const raw = (value) => new Safe(value);
const render = (v) => (v == null || v === false ? '' : v instanceof Safe ? v.value : Array.isArray(v) ? v.map(render).join('') : esc(v));
export const html = (strings, ...values) => new Safe(strings.reduce((out, s, i) => out + render(values[i - 1]) + s));

const STATUS = {
  submitted: 'Waiting for admin',
  in_review: 'In review',
  returned: 'Back with admin',
  approved: 'Preparing posts',
  awaiting_publisher: 'Waiting for publisher',
  published: 'Published',
  generating: 'AI is writing…',
  draft: 'Draft',
  failed: 'AI failed',
  ready: 'Ready',
  publishing: 'Publishing…',
  publish_failed: 'Publish failed',
};
const EVENT = {
  submitted: 'submitted the article',
  assigned: 'assigned a reviewer',
  sent_to_admin: 'sent it back to the admin',
  approved: 'approved the article',
  ai_done: 'AI finished a post',
  ai_failed: 'AI could not write a post',
  edited: 'edited a post',
  ready: 'marked a post ready',
  regenerate: 'asked the AI to rewrite a post',
  image: 'uploaded an Instagram image',
  sent_to_publisher: 'sent it to the publisher',
  sent_back: 'sent it back to the reviewer',
  published: 'published',
  publish_failed: 'publishing failed',
  completed: 'everything is published',
  tool_call: 'AI tool call',
  promoted: 'promoted a post to an example',
  metrics: 'recorded engagement',
  ai_drafted: 'drafted it with the article agent',
};
const DRAFT_STATUS = {
  running: ['Researching and writing…', 'generating'],
  ready: ['Ready to check', 'ready'],
  needs_attention: ['Needs attention', 'simulated'],
  failed: ['Failed', 'failed'],
  submitted: ['Submitted', 'published'],
  discarded: ['Discarded', ''],
};
const SOURCE_KINDS = { compliance: 'Compliance', trends: 'Trends', research: 'Research' };
const FLAG_LABELS = { can_write: 'Writer', can_review: 'Reviewer', can_publish: 'Can publish', is_admin: 'Admin' };
const INPUT_KINDS = { rule: 'Rule', example: 'Example', post: 'Top post', snapshot: 'Compliance page', web: 'Web page', article: 'Past article' };
const platformName = (platform) => (platform ? CHANNELS[platform].label : 'All platforms');
const isHttp = (url) => /^https?:\/\//i.test(url ?? '');

const badge = (status) => html`<span class="badge ${status}">${STATUS[status] ?? status}</span>`;
// Status pill for rules, sources, snapshots, suggestions and digests; `tone` picks the colour.
const pill = (text, tone = '') => html`<span class="badge ${tone}">${text}</span>`;
const TONE = { active: 'ready', approved: 'ready', accepted: 'ready', edited: 'ready', done: 'ready', pending: 'generating', running: 'generating', skipped: 'simulated', rejected: 'failed', failed: 'failed', inactive: '', dismissed: '', superseded: '' };
const statusPill = (status) => pill(status[0].toUpperCase() + status.slice(1), TONE[status] ?? '');

// rows from lineDiff/compactDiff → green added, red removed lines.
const renderDiff = (rows) =>
  html`<div class="diff">${rows.map(([type, line]) =>
    type === 'add' ? html`<ins>${line}</ins>` : type === 'del' ? html`<del>${line}</del>` : type === 'gap' ? html`<div class="gap">…</div>` : html`<div>${line}</div>`)}</div>`;

function layout(title, user, body, { refresh } = {}) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? html`<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${title} · Tvarvi</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/">Tvarvi</a>
  ${user
    ? html`<nav>
    ${user.is_admin ? html`<a href="/training">Training</a> <a href="/sources">Sources</a> <a href="/suggestions">Suggestions</a> <a href="/users">Team</a>` : ''}
    <a href="/account">${user.name}</a>
    <form method="post" action="/logout"><button class="link">Log out</button></form>
  </nav>`
    : ''}
</header>
<main>
${body}
</main>
</body>
</html>`.toString();
}

export const loginPage = (error) =>
  layout('Log in', null, html`
<h1>Log in</h1>
${error ? html`<p class="error">${error}</p>` : ''}
<form method="post" action="/login" class="stack narrow">
  <label>Email <input type="email" name="email" required maxlength="254" autocomplete="username"></label>
  <label>Password <input type="password" name="password" required maxlength="200" autocomplete="current-password"></label>
  <button>Log in</button>
</form>`);

export function errorPage(user, status, message, back) {
  const title = { 403: 'Not allowed', 404: 'Not found', 409: 'Already changed' }[status] ?? (status >= 500 ? 'Something went wrong' : 'Please check');
  return layout(title, user, html`
<h1>${title}</h1>
<p class="error">${message}</p>
<p><a href="${back}">Go back</a></p>`);
}

function articleTable(title, rows) {
  return html`<h2>${title}</h2>
${rows.length
    ? html`<table>
  <thead><tr><th>Title</th><th>Status</th><th>Author</th><th>Reviewer</th><th>Updated (UTC)</th></tr></thead>
  <tbody>${rows.map((a) => html`
    <tr><td><a href="/articles/${a.id}">${a.title}</a></td><td>${badge(a.status)}</td><td>${a.author}</td><td>${a.reviewer ?? '-'}</td><td>${a.updated_at}</td></tr>`)}
  </tbody>
</table>`
    : html`<p class="muted">Nothing here.</p>`}`;
}

export function dashboardPage(user, lists) {
  const { suggestions = 0, snapshots = 0 } = lists.attention ?? {};
  return layout('Dashboard', user, html`
<h1>Dashboard</h1>
${suggestions ? html`<p class="note"><a href="/suggestions">${suggestions} suggestion${suggestions === 1 ? '' : 's'} to improve the AI agents</a> ${suggestions === 1 ? 'is' : 'are'} waiting for a decision.</p>` : ''}
${snapshots ? html`<p class="note"><a href="/sources">${snapshots} changed compliance page${snapshots === 1 ? '' : 's'}</a> ${snapshots === 1 ? 'needs' : 'need'} approval before the compliance agent uses ${snapshots === 1 ? 'it' : 'them'}.</p>` : ''}
${user.is_admin ? html`<section>${articleTable('Needs a reviewer', lists.queue)}${articleTable('In progress', lists.inProgress)}</section>` : ''}
${user.can_review ? html`<section>${articleTable('Assigned to me', lists.reviews)}</section>` : ''}
${user.can_publish ? html`<section>${articleTable('Waiting for a publisher', lists.publishing)}</section>` : ''}
${user.can_write
    ? html`<section>
  ${articleTable('My articles', lists.mine)}
  <h2>Draft an article with AI</h2>
  ${lists.researchReady
      ? html`<form method="post" action="/drafts" class="inline">
    <label>Topic or keyword <input name="topic" required minlength="3" maxlength="150" placeholder="for example: iron deficiency in women"></label>
    <button>Research and draft</button>
  </form>
  <p class="muted">The article agent researches only the approved Research sites and writes about 2,800 words with 5–7 references and FAQs, in about 5–10 minutes. You check the draft before you submit it.</p>`
      : html`<p class="muted">An admin needs to add Research sites on the Sources page first.</p>`}
  ${lists.drafts.length
      ? html`<table>
    <thead><tr><th>AI draft</th><th>Status</th><th>Started (UTC)</th></tr></thead>
    <tbody>${lists.drafts.map((d) => html`<tr><td><a href="/drafts/${d.id}">${d.topic}</a></td><td>${draftPill(d.status)}</td><td>${d.created_at}</td></tr>`)}</tbody>
  </table>`
      : ''}
  <h2>Write an article</h2>
  <form method="post" action="/articles" class="stack">
    <label>Title <input name="title" required maxlength="200"></label>
    <label>Article
      <textarea name="body" rows="16" required maxlength="100000"></textarea>
    </label>
    <p class="muted">Leave a blank line between paragraphs. Start a line with "## " for a heading or "- " for a bullet point.</p>
    <button>Submit to admin</button>
  </form>
</section>`
    : ''}`);
}

const diffView = (a) =>
  renderDiff([
    ...(a.base_title !== a.title ? [['del', `Title: ${a.base_title}`], ['add', `Title: ${a.title}`]] : []),
    ...lineDiff(a.base_body, a.body),
  ]);

function assignPanel(a, reviewers) {
  const changed = a.status === 'returned' && (a.base_title !== a.title || a.base_body !== a.body);
  return html`<section class="panel">
${a.status === 'returned'
    ? html`<h2>Reviewer's changes</h2>
${changed ? html`<p class="muted">Green lines were added, red lines were removed.</p>${diffView(a)}` : html`<p class="muted">The text was not changed.</p>`}`
    : ''}
<h2>Assign a reviewer</h2>
<form method="post" action="/articles/${a.id}" class="stack">
  <input type="hidden" name="action" value="assign">
  <label>Reviewer
    <select name="reviewer_id" required>
      <option value="">Choose…</option>
      ${reviewers.map((r) => html`<option value="${r.id}"${r.id === a.reviewer_id ? raw(' selected') : ''}>${r.name}</option>`)}
    </select>
  </label>
  ${changed
    ? html`<fieldset>
    <legend>Which version should the reviewer work on?</legend>
    <label class="check"><input type="radio" name="version" value="new" checked> Keep the reviewer's changes</label>
    <label class="check"><input type="radio" name="version" value="old"> Revert to the previous version</label>
  </fieldset>`
    : ''}
  <button>Assign</button>
</form>
</section>`;
}

// "Send to admin" comes first so pressing Enter in the title field never approves by accident.
const reviewForm = (a) => html`<form method="post" action="/articles/${a.id}" class="stack panel">
  <label>Title <input name="title" value="${a.title}" required maxlength="200"></label>
  <label>Article <textarea name="body" rows="22" required maxlength="100000">${a.body}</textarea></label>
  <label>Note to the admin (optional) <textarea name="note" rows="2" maxlength="2000"></textarea></label>
  <label class="check"><input type="checkbox" name="second_opinion" value="1"> Ask for a second opinion from another reviewer</label>
  <div class="actions">
    <button name="action" value="send_to_admin" class="secondary">Send to admin (changes or second opinion)</button>
    <button name="action" value="approve">Approve with no changes: ready to publish</button>
  </div>
</form>`;

const EDITABLE = ['draft', 'failed', 'ready', 'publish_failed'];

// What the AI used for this post: rule and example versions, compliance page versions, web pages, past articles.
function inputLine(input, user) {
  const kind = html`<span class="kind">${INPUT_KINDS[input.kind]}</span>`;
  if ((input.kind === 'rule' || input.kind === 'example') && input.knowledge_id && user.is_admin) {
    return html`${kind} <a href="/knowledge/${input.knowledge_id}">${input.label}</a>`;
  }
  if (input.kind === 'web' && isHttp(input.label)) return html`${kind} <a href="${input.label}" target="_blank" rel="noopener noreferrer">${input.label}</a>`;
  if (input.kind === 'article' && input.ref_id) return html`${kind} <a href="/articles/${input.ref_id}">${input.label}</a>`;
  return html`${kind} ${input.label}`;
}

function metricsForm(item) {
  const m = item.metrics;
  return html`<form method="post" action="/items/${item.id}" class="metrics">
    <input type="hidden" name="action" value="metrics">
    ${[['likes', 'Likes'], ['shares', 'Shares'], ['reach', 'Reach'], ['saves', 'Saves']].map(([name, text]) =>
      html`<label>${text} <input type="number" name="${name}" min="0" max="1000000000000" step="1" value="${m?.[name] ?? ''}"></label>`)}
    <button class="secondary">Save engagement</button>
    ${m ? html`<span class="muted">Last updated ${m.recorded_at} UTC</span>` : ''}
  </form>`;
}

function itemCard(item, perm, user) {
  const { label, max } = CHANNELS[item.channel];
  const editable = perm.editItems && item.channel !== 'website' && EDITABLE.includes(item.status);
  const social = SOCIAL.includes(item.channel);
  return html`<section class="card">
  <header><h3>${label}</h3> ${badge(item.status)}${item.simulated ? html` <span class="badge simulated">Simulated</span>` : ''}</header>
  ${item.error ? html`<p class="error">${item.error}</p>` : ''}
  ${item.ai_notes ? html`<p class="${item.ai_ok ? 'ok' : 'warn'} pre">${item.ai_notes}</p>` : ''}
  ${item.channel === 'website' ? html`<p class="muted">The approved article shown above.</p>` : ''}
  ${item.channel === 'instagram'
    ? html`${item.image
        ? html`<img class="preview" src="/media/${item.image}" alt="Image for the Instagram post">`
        : html`<p class="warn">Instagram posts need an image before they can be marked ready.</p>`}
  ${editable
        ? html`<form method="post" action="/items/${item.id}/image" enctype="multipart/form-data" class="inline">
    <input type="file" name="image" accept="image/jpeg" required>
    <button class="secondary">Upload JPEG</button>
    <span class="muted">Up to 8 MB. Aspect ratio between 4:5 and 1.91:1.</span>
  </form>`
        : ''}`
    : ''}
  ${editable
    ? html`<form method="post" action="/items/${item.id}" class="stack">
    <textarea name="body" rows="9" maxlength="10000" aria-label="${label} post text">${item.body}</textarea>
    <p class="muted">${postLength(item.channel, item.body)} / ${max} characters${item.channel === 'x' ? ' (emoji and non-Latin characters count as 2)' : ''}</p>
    <div class="actions">
      <button name="action" value="save" class="secondary">Save</button>
      <button name="action" value="ready">Mark ready</button>
      <button name="action" value="regenerate" class="secondary">Rewrite with AI</button>
    </div>
  </form>`
    : item.channel !== 'website' && item.body ? html`<p class="post">${item.body}</p>` : ''}
  ${item.external_url ? html`<p><a href="${item.external_url}" target="_blank" rel="noopener noreferrer">View the live post</a></p>` : ''}
  ${perm.publish && ['ready', 'publish_failed'].includes(item.status)
    ? html`<form method="post" action="/items/${item.id}">
    <button name="action" value="publish">${item.status === 'publish_failed' ? 'Retry publishing' : 'Publish'} to ${label}${isDryRun(item.channel) ? ' (simulated)' : ''}</button>
  </form>`
    : ''}
  ${item.ai_draft && item.ai_draft !== item.body
    ? html`<details><summary>The AI's original draft (changed by the reviewer)</summary>${renderDiff(lineDiff(item.ai_draft, item.body))}</details>`
    : ''}
  ${item.inputs?.length
    ? html`<details><summary>Sources used (${item.inputs.length})</summary>
    <ul class="inputs">${item.inputs.map((input) => html`<li>${inputLine(input, user)}</li>`)}</ul></details>`
    : ''}
  ${perm.metrics && social && item.status === 'published' ? metricsForm(item) : ''}
  ${perm.promote && social && ['ready', 'published'].includes(item.status)
    ? item.promoted
      ? html`<p class="muted">This post is an approved example (<a href="/knowledge/${item.promoted}">view</a>).</p>`
      : html`<form method="post" action="/items/${item.id}"><button name="action" value="promote" class="secondary">Promote to example</button></form>`
    : ''}
</section>`;
}

export function articlePage(user, { article: a, items, events, reviewers, perm, generating }) {
  const simulated = items.filter((i) => isDryRun(i.channel)).map((i) => CHANNELS[i.channel].label);
  return layout(a.title, user, html`
<p><a href="/">← Dashboard</a></p>
<h1>${a.title}</h1>
<p class="meta">${badge(a.status)} Written by ${a.author}${a.reviewer ? html`, reviewer ${a.reviewer}` : ''}${a.draftId ? html` · <a href="/drafts/${a.draftId}">Research record</a>` : ''}</p>
${a.note ? html`<p class="note"><strong>Note:</strong> ${a.note}</p>` : ''}
${perm.assign ? assignPanel(a, reviewers) : ''}
${perm.review ? reviewForm(a) : html`<article class="content">${raw(textToHtml(a.body))}</article>`}
${items.length
    ? html`<h2>Publishing</h2>
${generating ? html`<p class="note">The AI agents are writing the social posts. This page refreshes by itself.</p>` : ''}
${simulated.length ? html`<p class="note">Trial mode: publishing to ${simulated.join(', ')} is simulated. Nothing is posted there.</p>` : ''}
<div class="actions">
  ${perm.sendToPublisher
      ? html`<form method="post" action="/articles/${a.id}"><button name="action" value="send_to_publisher" class="secondary">Send to a publisher for a final look</button></form>`
      : ''}
  ${perm.sendBack
      ? html`<form method="post" action="/articles/${a.id}" class="inline">
    <input name="note" maxlength="2000" placeholder="What should the reviewer fix?" aria-label="Note for the reviewer">
    <button name="action" value="send_back" class="secondary">Send back to the reviewer</button>
  </form>`
      : ''}
</div>
<div class="items">${items.map((item) => itemCard(item, perm, user))}</div>`
    : ''}
<h2>History</h2>
<ol class="timeline">${events.map((e) => html`
  <li><time>${e.at} UTC</time> ${e.who ?? 'System'} ${EVENT[e.action] ?? e.action}${e.detail ? html`: ${e.detail}` : ''}</li>`)}
</ol>`, { refresh: generating ? 5 : null });
}

export function usersPage(user, users, created) {
  return layout('Team', user, html`
<h1>Team</h1>
${created
    ? html`<p class="ok">Password for <strong>${created.email}</strong>: <code>${created.password}</code><br>
Share it privately. It won't be shown again. They can change it by clicking their name at the top right.</p>`
    : ''}
${users.map((u) => html`
<form method="post" action="/users/${u.id}" class="member${u.active ? '' : ' inactive'}">
  <div><strong>${u.name}</strong><br><span class="muted">${u.email}</span></div>
  <div class="flags">
    ${Object.entries(FLAG_LABELS).map(([flag, label]) => html`<label class="check"><input type="checkbox" name="${flag}" value="1"${u[flag] ? raw(' checked') : ''}${u.id === user.id && flag === 'is_admin' ? raw(' disabled') : ''}> ${label}</label>`)}
    <label class="check"><input type="checkbox" name="active" value="1"${u.active ? raw(' checked') : ''}${u.id === user.id ? raw(' disabled') : ''}> Active</label>
  </div>
  <div class="actions">
    <button name="action" value="update" class="secondary">Save</button>
    ${u.id === user.id ? '' : html`<button name="action" value="reset_password" class="secondary">Reset password</button>`}
  </div>
</form>`)}
<h2>Add a team member</h2>
<form method="post" action="/users" class="stack narrow">
  <label>Name <input name="name" required maxlength="100"></label>
  <label>Email <input type="email" name="email" required maxlength="254"></label>
  <fieldset>
    <legend>Roles</legend>
    <label class="check"><input type="checkbox" name="can_write" value="1"> Writer: submits articles</label>
    <label class="check"><input type="checkbox" name="can_review" value="1"> Reviewer: checks articles and posts</label>
    <label class="check"><input type="checkbox" name="can_publish" value="1"> Can publish: trusted to post publicly</label>
    <label class="check"><input type="checkbox" name="is_admin" value="1"> Admin: assigns reviewers, manages the team</label>
  </fieldset>
  <button>Add member</button>
</form>`);
}

export const accountPage = (user, message) =>
  layout('Account', user, html`
<h1>${user.name}</h1>
<p class="muted">${user.email}</p>
${message ? html`<p class="ok">${message}</p>` : ''}
<h2>Change password</h2>
<form method="post" action="/account" class="stack narrow">
  <label>Current password <input type="password" name="current" required maxlength="200" autocomplete="current-password"></label>
  <label>New password (at least 12 characters) <input type="password" name="password" required minlength="12" maxlength="200" autocomplete="new-password"></label>
  <label>Repeat the new password <input type="password" name="confirm" required minlength="12" maxlength="200" autocomplete="new-password"></label>
  <button>Change password</button>
</form>`);

// ---------- admin: agent training ----------

const money = (usd) => (usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`);
const n = (value) => Number(value ?? 0).toLocaleString('en-US');

const entryFields = (kind, values = {}) => html`
  <label>Title (optional) <input name="title" maxlength="100" value="${values.title ?? ''}"></label>
  <label>Text <textarea name="text" rows="${kind === 'example' ? 8 : 4}" required maxlength="5000">${values.text ?? ''}</textarea></label>
  ${kind === 'example'
    ? html`<div class="metrics">${[['likes', 'Likes'], ['shares', 'Shares'], ['reach', 'Reach']].map(([name, text]) =>
      html`<label>${text} <input type="number" name="${name}" min="0" max="1000000000000" step="1" value="${values[name] ?? ''}"></label>`)}</div>`
    : ''}`;

function entryList(entries) {
  return entries.length
    ? html`<div class="entries">${entries.map((e) => html`
  <div class="entry${e.active ? '' : ' inactive'}">
    <div><a href="/knowledge/${e.id}"><strong>${e.title || clip(e.text, 60)}</strong></a>
      ${statusPill(e.active ? 'active' : 'inactive')} <span class="muted">v${e.version} · ${platformName(e.platform)}${e.kind === 'example' ? ` · ${n(e.reach)} reach, ${n(e.shares)} shares, ${n(e.likes)} likes` : ''}</span></div>
    <p class="pre">${clip(e.text, 300)}</p>
  </div>`)}</div>`
    : html`<p class="muted">None yet.</p>`;
}

export function trainingPage(user, { entries, usage, auditLog }) {
  const of = (kind) => entries.filter((e) => e.kind === kind);
  return layout('Agent training', user, html`
<h1>Agent training</h1>
<p class="muted">The writer and compliance agents read the current version of every active rule, and the best examples, on every run. Editing creates a new version; nothing is deleted. Each post records exactly which versions it used.</p>
<h2>Brand rules</h2>${entryList(of('brand_rule'))}
<h2>Compliance rules</h2>${entryList(of('compliance_rule'))}
<h2>Example posts</h2>${entryList(of('example'))}
<h2>Add a rule or example</h2>
<form method="post" action="/knowledge" class="stack panel">
  <label>Type <select name="kind">${Object.entries(KNOWLEDGE_KINDS).map(([kind, text]) => html`<option value="${kind}">${text}</option>`)}</select></label>
  <label>Platform <select name="platform"><option value="all">All platforms (rules only)</option>${SOCIAL.map((p) => html`<option value="${p}">${CHANNELS[p].label}</option>`)}</select></label>
  ${entryFields('example')}
  <p class="muted">Likes, shares and reach are only used for examples. The brand voice guide can be one brand rule titled "Voice guide".</p>
  <button>Add</button>
</form>
<h2>AI usage, last 7 days</h2>
${usage.rows.length
    ? html`<table>
  <thead><tr><th>Agent</th><th>Model</th><th>Calls</th><th>Input tokens</th><th>Cached reads</th><th>Output tokens</th><th>Web searches</th><th>Avg. seconds</th><th>Est. cost</th></tr></thead>
  <tbody>${usage.rows.map((r) => html`<tr><td>${r.name}</td><td>${r.model}</td><td>${n(r.calls)}</td><td>${n(r.input + r.cache_write)}</td><td>${n(r.cache_read)}</td><td>${n(r.output)}</td><td>${n(r.searches)}</td><td>${(r.ms / 1000).toFixed(1)}</td><td>${r.cost == null ? 'No price' : money(r.cost)}</td></tr>`)}</tbody>
</table>
<p class="muted">${usage.perArticle == null ? '' : `Average cost per article: ${money(usage.perArticle)} over ${usage.articles} article${usage.articles === 1 ? '' : 's'}. `}${usage.seconds == null ? '' : `Average time from approval until all three posts were ready: ${Math.round(usage.seconds)} s. `}${usage.perDraft == null ? '' : `Article agent: ${money(usage.perDraft)} and ${Math.max(1, Math.round(usage.draftMinutes))} min per draft on average, over ${usage.drafts} draft${usage.drafts === 1 ? '' : 's'}. `}Estimated at each model's list price.${usage.unpriced ? ' Calls served by a model with no listed price are left out of the total.' : ''}</p>`
    : html`<p class="muted">No AI calls in the last 7 days.</p>`}
<p class="muted">Models now: writers ${usage.models.writer}, article writer ${usage.models.article}, trend scouts ${usage.models.scout}, compliance ${usage.models.compliance}, coach ${usage.models.coach}. Change them with the MODEL_WRITER, MODEL_ARTICLE_WRITER, MODEL_TREND_SCOUT, MODEL_COMPLIANCE and MODEL_COACH settings.</p>
<h2>Audit log</h2>
${auditLog.length
    ? html`<ol class="timeline">${auditLog.map((a) => html`<li><time>${a.at} UTC</time> ${a.who ?? 'System'}: ${a.action.replaceAll('_', ' ')}${a.detail ? html`, ${a.detail}` : ''}</li>`)}</ol>`
    : html`<p class="muted">Nothing yet.</p>`}`);
}

export function knowledgePage(user, entry, history) {
  return layout(KNOWLEDGE_KINDS[entry.kind], user, html`
<p><a href="/training">← Agent training</a></p>
<h1>${KNOWLEDGE_KINDS[entry.kind]}${entry.title ? `: ${entry.title}` : ''}</h1>
<p class="meta">${statusPill(entry.active ? 'active' : 'inactive')} ${platformName(entry.platform)} · current version v${entry.version}</p>
<form method="post" action="/knowledge/${entry.id}" class="inline">
  ${entry.active
    ? html`<button name="action" value="deactivate" class="secondary">Deactivate (agents stop using it)</button>`
    : html`<button name="action" value="activate" class="secondary">Reactivate</button>`}
</form>
<h2>Edit (creates v${entry.version + 1})</h2>
<form method="post" action="/knowledge/${entry.id}" class="stack panel">
  <input type="hidden" name="action" value="edit">
  ${entryFields(entry.kind, entry)}
  <label>What changed (optional) <input name="note" maxlength="200"></label>
  <button>Save as v${entry.version + 1}</button>
</form>
<h2>History</h2>
<div class="entries">${history.map((v) => html`
  <div class="entry">
    <div><strong>v${v.version}</strong>${v.id === entry.version_id ? html` ${statusPill('active')}` : ''}
      <span class="muted">${v.created_at} UTC by ${v.author ?? 'System'}${v.note ? `, ${v.note}` : ''}${v.suggestion_id ? `, from suggestion #${v.suggestion_id}` : ''}</span></div>
    <p class="pre">${v.title ? `${v.title}: ` : ''}${v.text}</p>
    ${v.posts.length
      ? html`<details><summary>Used by ${v.used_by} post${v.used_by === 1 ? '' : 's'}</summary><ul>${v.posts.map((p) => html`<li><a href="/articles/${p.article_id}">${p.title}</a> (${CHANNELS[p.channel].label})</li>`)}</ul></details>`
      : html`<p class="muted">Not used by any post yet.</p>`}
    ${v.id === entry.version_id
      ? ''
      : html`<form method="post" action="/knowledge/${entry.id}"><input type="hidden" name="version_id" value="${v.id}"><button name="action" value="rollback" class="secondary">Roll back to v${v.version}</button></form>`}
  </div>`)}</div>`);
}

// ---------- article agent drafts ----------

const draftPill = (status) => pill(...(DRAFT_STATUS[status] ?? [status, '']));
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// The prefilled new-article form: submitting it starts the normal workflow.
const draftForm = (d) => html`<form method="post" action="/articles" class="stack panel">
  <input type="hidden" name="draft_id" value="${d.id}">
  <label>Title <input name="title" value="${d.title}" required maxlength="200"></label>
  <label>Article <textarea name="body" rows="30" required maxlength="100000">${d.body}</textarea></label>
  <p class="muted">Check each claim against the passage it cites (below), edit what you need, then submit. The article then goes to the admin like any other.</p>
  <div class="actions"><button>Submit to admin</button></div>
</form>
<form method="post" action="/drafts/${d.id}"><button name="action" value="discard" class="secondary">Discard this draft</button></form>`;

export function draftPage(user, { draft: d, own }) {
  const running = d.status === 'running';
  const editable = own && ['ready', 'needs_attention'].includes(d.status);
  return layout(`AI draft: ${d.topic}`, user, html`
<p><a href="/">← Dashboard</a></p>
<h1>AI draft: ${d.topic}</h1>
<p class="meta">${draftPill(d.status)} Started by ${d.author} at ${d.created_at} UTC${d.finished_at
    ? `, took ${Math.max(1, Math.round(d.seconds / 60))} min${d.cost == null ? '' : ` · AI cost ${money(d.cost)}`} · ${d.searches} searches, ${d.fetches} pages opened`
    : ''}</p>
${running ? html`<p class="note">The article agent is researching and writing. This takes about 5–10 minutes; the page refreshes by itself.</p>` : ''}
${d.error ? html`<p class="error">${d.error}</p>` : ''}
${d.status === 'failed' && own ? html`<form method="post" action="/drafts/${d.id}"><button name="action" value="retry">Try again</button></form>` : ''}
${d.status === 'submitted' && d.article_id ? html`<p class="ok">Submitted as <a href="/articles/${d.article_id}">this article</a>.</p>` : ''}
${d.notes ? html`<p class="${d.status === 'ready' ? 'ok' : 'warn'} pre">${d.notes}</p>` : ''}
${d.checks.length
    ? html`<ul class="checks">${d.checks.map((c) => html`<li class="${c.ok ? 'pass' : 'fail'}">${c.ok ? '✓' : '✗'} ${c.label}: ${c.detail}</li>`)}</ul>`
    : ''}
${editable ? draftForm(d) : d.body ? html`<h2>${d.title}</h2><article class="content">${raw(textToHtml(d.body))}</article>` : ''}
${d.evidence.length
    ? html`<details${editable ? raw(' open') : ''}><summary>Claims and the passages they cite (${d.evidence.length})</summary>
<table class="evidence">
  <thead><tr><th>Claim in the draft</th><th>Passage in the source</th></tr></thead>
  <tbody>${d.evidence.map((e) => html`<tr><td>${e.claim}</td><td>${e.quotes.map((q) => {
      const ref = d.refs.find((r) => r.n === q.n);
      return html`<p><a href="${ref?.url ?? '#'}" target="_blank" rel="noopener noreferrer">[${q.n}] ${hostOf(ref?.url)}</a> ${q.text}</p>`;
    })}</td></tr>`)}</tbody>
</table></details>`
    : ''}
${d.inputs.length
    ? html`<details><summary>What the agent used (${d.inputs.length})</summary>
<ul class="inputs">${d.inputs.map((i) => html`<li>${inputLine({ kind: i.kind, ref_id: i.ref, label: i.label }, user)}</li>`)}</ul></details>`
    : ''}
<details${running ? raw(' open') : ''}><summary>Progress log</summary><p class="pre log">${d.log}</p></details>`, { refresh: running ? 10 : null });
}

// ---------- admin: web sources ----------

export function sourcesPage(user, { sources, pending }) {
  return layout('Sources', user, html`
<h1>Sources</h1>
<p class="muted"><strong>Compliance</strong> pages (regulator guidance, platform health-content policies) are checked daily. A changed page waits here until you approve it; until then the compliance agent keeps using the last approved version. <strong>Trends</strong> links set the only domains the AI may search or open for trending keywords. <strong>Research</strong> sites are the only medical sites the article agent may search and cite: a site covers its subdomains, so https://nih.gov allows every *.nih.gov site, while https://www.nhs.uk allows only www.nhs.uk. Only https links; each domain you add becomes part of the allowlist.</p>
<form method="post" action="/sources" class="stack panel narrow">
  <label>Link <input type="url" name="url" required maxlength="500" placeholder="https://"></label>
  <fieldset><legend>Type</legend>
    <label class="check"><input type="radio" name="kind" value="compliance" checked> Compliance page</label>
    <label class="check"><input type="radio" name="kind" value="trends"> Trends source</label>
    <label class="check"><input type="radio" name="kind" value="research"> Research site</label>
  </fieldset>
  <button>Add source</button>
</form>
${pending.length
    ? html`<h2>Waiting for approval (${pending.length})</h2>${pending.map((s) => html`
<section class="panel">
  <p><strong>${s.url}</strong> <span class="muted">fetched ${s.fetched_at} UTC</span></p>
  ${s.approved_text == null
      ? html`<p class="muted">First version of this page. Read it before approving:</p><details open><summary>Page text</summary><p class="pre snapshot">${clip(s.text, 5000)}</p></details>`
      : html`<p class="muted">Changes since the approved version (green added, red removed):</p>${renderDiff(compactDiff(lineDiff(s.approved_text, s.text)))}`}
  <form method="post" action="/snapshots/${s.id}" class="inline">
    <button name="action" value="approve">Approve this version</button>
    <button name="action" value="reject" class="secondary">Reject</button>
  </form>
</section>`)}`
    : ''}
<h2>All sources</h2>
${sources.length
    ? html`<table>
  <thead><tr><th>Link</th><th>Type</th><th>Status</th><th>Approved version</th><th>Last check</th><th></th></tr></thead>
  <tbody>${sources.map((s) => html`<tr>
    <td><a href="${s.url}" target="_blank" rel="noopener noreferrer">${clip(s.url, 70)}</a>${s.last_error ? html`<p class="error">${s.last_error}</p>` : ''}</td>
    <td>${SOURCE_KINDS[s.kind] ?? s.kind}</td>
    <td>${statusPill(s.active ? 'active' : 'inactive')}${s.pending ? html` ${statusPill('pending')}` : ''}</td>
    <td>${s.kind === 'compliance' ? (s.approved_at ? `${s.approved_at} UTC` : 'None yet') : '-'}</td>
    <td>${s.last_checked_at ? `${s.last_checked_at} UTC` : '-'}</td>
    <td><form method="post" action="/sources/${s.id}" class="inline">
      ${s.kind === 'compliance' && s.active ? html`<button name="action" value="check" class="secondary">Check now</button>` : ''}
      <button name="action" value="${s.active ? 'deactivate' : 'activate'}" class="secondary">${s.active ? 'Deactivate' : 'Activate'}</button>
    </form></td>
  </tr>`)}</tbody>
</table>`
    : html`<p class="muted">No sources yet.</p>`}`);
}

// ---------- admin: weekly suggestions ----------

function suggestionCard(s, posts) {
  const evidence = JSON.parse(s.evidence ?? '[]');
  const linked = JSON.parse(s.item_ids ?? '[]').map((id) => posts.get(id)).filter(Boolean);
  const kindText = s.kind === 'reminder' ? 'Reminder' : `New ${KNOWLEDGE_KINDS[s.kind].toLowerCase()}`;
  return html`<section class="panel">
  <p><strong>${kindText}</strong> <span class="muted">${s.kind === 'reminder' ? '' : platformName(s.platform)} · #${s.id}</span></p>
  ${s.summary ? html`<p>${s.summary}</p>` : ''}
  ${evidence.length ? html`${evidence.map((quote) => html`<blockquote>${quote}</blockquote>`)}` : ''}
  ${linked.length ? html`<p class="muted">Based on: ${linked.map((p, i) => html`${i ? ', ' : ''}<a href="/articles/${p.article_id}">${CHANNELS[p.channel].label} post #${p.id}</a>`)}</p>` : ''}
  <p class="post">${s.text}</p>
  ${s.kind === 'reminder'
    ? html`<form method="post" action="/suggestions/${s.id}" class="inline"><a href="/sources">Open Sources</a>
      <button name="action" value="dismiss" class="secondary">Dismiss</button></form>`
    : html`<form method="post" action="/suggestions/${s.id}" class="inline">
      <button name="action" value="accept">Accept</button>
      <button name="action" value="reject" class="secondary">Reject</button>
    </form>
    <details><summary>Edit before accepting</summary>
      <form method="post" action="/suggestions/${s.id}" class="stack">
        <textarea name="text" rows="4" required maxlength="5000" aria-label="Edited text">${s.text}</textarea>
        <button name="action" value="edit">Accept with my edits</button>
      </form>
    </details>`}
</section>`;
}

export function suggestionsPage(user, { pending, decided, posts, digests, running }) {
  return layout('Suggestions', user, html`
<h1>Suggestions</h1>
<p class="muted">Once a week the coach reviews how reviewers changed the AI's drafts, which posts performed best and which ones struggled with compliance, then proposes rules and examples. It cannot change anything itself: only what you accept or edit becomes a new version, and rejected ideas are kept so they are not proposed again.</p>
${running
    ? html`<p class="note">The coach is working on a digest. This page refreshes by itself.</p>`
    : html`<form method="post" action="/suggestions"><button class="secondary">Generate now</button></form>`}
<h2>Waiting for a decision (${pending.length})</h2>
${pending.length ? pending.map((s) => suggestionCard(s, posts)) : html`<p class="muted">Nothing to decide.</p>`}
<h2>Weekly digests</h2>
${digests.length
    ? html`<ol class="timeline">${digests.map((d) => html`<li><time>${d.created_at} UTC</time> ${statusPill(d.status)} ${d.note ?? ''}</li>`)}</ol>`
    : html`<p class="muted">No digest yet. The first one runs automatically within a day of starting the app.</p>`}
<h2>Decided</h2>
${decided.length
    ? html`<table>
  <thead><tr><th>Decided (UTC)</th><th>Type</th><th>Decision</th><th>Text</th><th>By</th></tr></thead>
  <tbody>${decided.map((s) => html`<tr>
    <td>${s.decided_at}</td>
    <td>${s.kind === 'reminder' ? 'Reminder' : KNOWLEDGE_KINDS[s.kind]}</td>
    <td>${statusPill(s.status)}</td>
    <td>${clip(s.final_text ?? s.text, 160)}${s.knowledge_id ? html` <a href="/knowledge/${s.knowledge_id}">view</a>` : ''}</td>
    <td>${s.decided_by_name ?? '-'}</td>
  </tr>`)}</tbody>
</table>`
    : html`<p class="muted">Nothing decided yet.</p>`}`, { refresh: running ? 5 : null });
}
