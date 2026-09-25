import { isDryRun } from './publish.js';
import { CHANNELS, esc, lineDiff, postLength, textToHtml } from './text.js';

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
};
const FLAG_LABELS = { can_write: 'Writer', can_review: 'Reviewer', can_publish: 'Can publish', is_admin: 'Admin' };

const badge = (status) => html`<span class="badge ${status}">${STATUS[status] ?? status}</span>`;

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
    ${user.is_admin ? html`<a href="/users">Team</a>` : ''}
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
  return layout('Dashboard', user, html`
<h1>Dashboard</h1>
${user.is_admin ? html`<section>${articleTable('Needs a reviewer', lists.queue)}${articleTable('In progress', lists.inProgress)}</section>` : ''}
${user.can_review ? html`<section>${articleTable('Assigned to me', lists.reviews)}</section>` : ''}
${user.can_publish ? html`<section>${articleTable('Waiting for a publisher', lists.publishing)}</section>` : ''}
${user.can_write
    ? html`<section>
  ${articleTable('My articles', lists.mine)}
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

function diffView(a) {
  const rows = [
    ...(a.base_title !== a.title ? [['del', `Title: ${a.base_title}`], ['add', `Title: ${a.title}`]] : []),
    ...lineDiff(a.base_body, a.body),
  ];
  return html`<div class="diff">${rows.map(([type, line]) =>
    type === 'add' ? html`<ins>${line}</ins>` : type === 'del' ? html`<del>${line}</del>` : html`<div>${line}</div>`)}</div>`;
}

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

function itemCard(item, perm) {
  const { label, max } = CHANNELS[item.channel];
  const editable = perm.editItems && item.channel !== 'website' && EDITABLE.includes(item.status);
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
</section>`;
}

export function articlePage(user, { article: a, items, events, reviewers, perm, generating }) {
  const simulated = items.filter((i) => isDryRun(i.channel)).map((i) => CHANNELS[i.channel].label);
  return layout(a.title, user, html`
<p><a href="/">← Dashboard</a></p>
<h1>${a.title}</h1>
<p class="meta">${badge(a.status)} Written by ${a.author}${a.reviewer ? html`, reviewer ${a.reviewer}` : ''}</p>
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
<div class="items">${items.map((item) => itemCard(item, perm))}</div>`
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
