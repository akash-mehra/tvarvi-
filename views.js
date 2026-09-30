import { isDryRun } from './publish.js';
import { CAROUSEL_CHECKLIST, CHANNELS, clip, compactDiff, esc, KNOWLEDGE_KINDS, lineDiff, pictureBlocks, postLength, SOCIAL, textToHtml } from './text.js';

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
  carousel: 'turned on the Instagram carousel',
  carousel_restart: 'started the carousel over',
  carousel_slides: 'uploaded the finished carousel slides',
  carousel_checked: 'ticked the carousel image checklist',
  carousel_removed: 'turned off the Instagram carousel',
  pictures_done: 'Gemini finished the website pictures',
  new_picture: 'asked Gemini for a new picture',
};
const CAROUSEL_STATUS = {
  working: ['Working…', 'generating'],
  ready: ['Ready', 'ready'],
  needs_attention: ['Needs attention', 'orange'],
  failed: ['Failed', 'failed'],
  discarded: ['Removed', 'gray'],
};
const CAROUSEL_JOB = {
  write: 'The AI is writing the slides, then Gemini makes the pictures and the AI checks each one. This takes a few minutes',
  check: 'The compliance agent is checking the edited text',
  picture: 'Gemini is making a new picture and the AI is checking it',
  final: 'The final text check is reading the finished slides',
};
const DRAFT_STATUS = {
  running: ['Researching and writing…', 'generating'],
  ready: ['Ready to check', 'ready'],
  needs_attention: ['Needs attention', 'orange'],
  failed: ['Failed', 'failed'],
  submitted: ['Submitted', 'published'],
  discarded: ['Discarded', 'gray'],
};
const SOURCE_KINDS = { compliance: 'Compliance', trends: 'Trends', research: 'Research' };
const SOURCE_GROUPS = { compliance: 'Compliance pages', research: 'Research sites', trends: 'Trend sources' };
const FLAG_LABELS = { can_write: 'Writer', can_review: 'Reviewer', can_publish: 'Can publish', is_admin: 'Admin' };
const FLAG_HELP = {
  can_write: 'Submits articles',
  can_review: 'Checks and signs articles and posts',
  can_publish: 'Trusted to post publicly',
  is_admin: 'Assigns reviewers, manages the team',
};
const INPUT_KINDS = { rule: 'Rule', example: 'Example', post: 'Top post', snapshot: 'Compliance page', web: 'Web page', article: 'Past article' };
const CHANNEL_LOOK = { website: ['globe', ''], instagram: ['camera', 'indigo'], linkedin: ['briefcase', 'teal'], x: ['bubble', 'gray'] };
const platformName = (platform) => (platform ? CHANNELS[platform].label : 'All platforms');
const isHttp = (url) => /^https?:\/\//i.test(url ?? '');
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const sentence = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

// ---------- icons: one drawn set, 24px grid, 1.8 stroke ----------

const ICONS = {
  home: '<path d="M3.5 10.2 12 3.5l8.5 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4.2v-5.8H9.2v5.8H5A1.5 1.5 0 0 1 3.5 19z"/>',
  write: '<path d="M4 20h4.5L19.3 9.2a2.2 2.2 0 0 0-3.1-3.1L5.4 16.9z"/><path d="M14.5 7.8l3.1 3.1"/>',
  admin: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  person: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.2c1.3-3.6 4.2-5.4 7.5-5.4s6.2 1.8 7.5 5.4"/>',
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevron: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  sparkle: '<path d="M11 4c.6 4 2.4 5.8 6.4 6.4-4 .6-5.8 2.4-6.4 6.4-.6-4-2.4-5.8-6.4-6.4 4-.6 5.8-2.4 6.4-6.4z"/><path d="M18 15.3c.3 1.8 1 2.5 2.8 2.8-1.8.3-2.5 1-2.8 2.8-.3-1.8-1-2.5-2.8-2.8 1.8-.3 2.5-1 2.8-2.8z"/>',
  seal: '<path d="M12 2.8l2.2 1.6 2.7-.1.8 2.6 2.2 1.6-.8 2.6.8 2.6-2.2 1.6-.8 2.6-2.7-.1L12 21.4l-2.2-1.6-2.7.1-.8-2.6-2.2-1.6.8-2.6-.8-2.6 2.2-1.6.8-2.6 2.7.1z"/><path d="m8.8 12.2 2.2 2.2 4.2-4.4"/>',
  send: '<path d="M20.5 3.5 10.2 13.8"/><path d="M20.5 3.5 14.2 20.5l-4-6.7-6.7-4z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5z"/>',
  camera: '<rect x="3.5" y="6.5" width="17" height="13" rx="3.5"/><path d="M9 6.5l1.2-2h3.6l1.2 2"/><circle cx="12" cy="13" r="3.4"/>',
  briefcase: '<rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 12.5h17"/>',
  bubble: '<path d="M5 18.8V7a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 19 7v7a2.5 2.5 0 0 1-2.5 2.5H8.3z"/>',
  book: '<path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h5.5v15.5H6a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M19.5 5.5A1.5 1.5 0 0 0 18 4h-5.5v15.5H18a1.5 1.5 0 0 0 1.5-1.5z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1-1"/>',
  bulb: '<path d="M9.2 17.5h5.6M10.2 20.5h3.6"/><path d="M12 3.5a5.5 5.5 0 0 0-3.2 10c.7.5 1.2 1.3 1.2 2.2v1.8h4v-1.8c0-.9.5-1.7 1.2-2.2A5.5 5.5 0 0 0 12 3.5z"/>',
  people: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.9-3.1 3.2-4.7 6-4.7s5.1 1.6 6 4.7"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 6.1M17.5 14.9c1.6.6 2.8 2 3.5 4.6"/>',
  warn: '<path d="M10.3 4.6a2 2 0 0 1 3.4 0l7.3 12.6a2 2 0 0 1-1.7 3H4.7a2 2 0 0 1-1.7-3z"/><path d="M12 9.5v4.2"/><path d="M12 16.8h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  photo: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 15-4.5-4.5L7 19"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4.5 15v2.5A2 2 0 0 0 6.5 19.5h11a2 2 0 0 0 2-2V15"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M6.5 6.5l.9 12a1.8 1.8 0 0 0 1.8 1.5h5.6a1.8 1.8 0 0 0 1.8-1.5l.9-12"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4"/>',
  doc: '<path d="M7 3.5h7l4.5 4.5v11A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5v5h5M8.5 12.5h7M8.5 16h5"/>',
  layers: '<rect x="4.5" y="7.5" width="12" height="12" rx="2.5"/><path d="M8 4.5h9a2.5 2.5 0 0 1 2.5 2.5v9"/>',
  mark: '<path d="M6.5 6.5h11M12 6.5v12"/>',
  logout: '<path d="M14 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h7"/><path d="M10.5 12h9M16.5 8.5 20 12l-3.5 3.5"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.8h3.8M12 8v4.2l2.8 1.8"/>',
};
const icon = (name, { cls = 'icon', label, width = 1.8 } = {}) =>
  raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${label
    ? ` role="img" aria-label="${esc(label)}"`
    : ' aria-hidden="true" focusable="false"'}>${ICONS[name]}</svg>`);
const chev = () => icon('chevron', { cls: 'row-chevron', width: 2.4 });

// The thinking orbs (public/orbs.js animates them; without the script they stay hidden).
const ORB_CLASS = { 20: 'orb-20', 64: 'orb-64', 128: 'orb-hero' };
const orb = (state, size, label) =>
  html`<canvas class="orb ${ORB_CLASS[size]}" data-orb="${state}" data-size="${size === 20 ? 20 : 64}" width="${size}" height="${size}" role="img" aria-label="${label}"></canvas>`;

// ---------- time ----------

const toDate = (sqlTime) => new Date(`${String(sqlTime).replace(' ', 'T')}Z`);
function ago(sqlTime) {
  const d = toDate(sqlTime);
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172_800) return 'Yesterday';
  const year = d.getUTCFullYear() === new Date().getUTCFullYear() ? {} : { year: 'numeric' };
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...year, timeZone: 'Asia/Kolkata' });
}
const when = (sqlTime) => (sqlTime ? html`<time datetime="${toDate(sqlTime).toISOString()}" title="${sqlTime} UTC">${ago(sqlTime)}</time>` : '');
const stamp = (sqlTime) => {
  if (!sqlTime) return '';
  const d = toDate(sqlTime);
  const text = d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  return html`<time datetime="${d.toISOString()}" title="${sqlTime} UTC">${text}</time>`;
};
const readMinutes = (text) => Math.max(1, Math.round(((text ?? '').match(/\S+/g) ?? []).length / 220));

// ---------- building blocks ----------

const badge = (status) => html`<span class="badge ${status}">${status === 'generating' || status === 'publishing' ? orb('composing', 20, 'Working') : ''}${STATUS[status] ?? status}</span>`;
// Status pill for rules, sources, snapshots, suggestions and digests; `tone` picks the colour.
const pill = (text, tone = '') => html`<span class="badge ${tone}">${text}</span>`;
const TONE = { active: 'green', approved: 'green', accepted: 'green', edited: 'green', done: 'green', pending: 'orange', running: 'indigo', skipped: 'orange', rejected: 'red', failed: 'red', inactive: 'gray', dismissed: 'gray', superseded: 'gray' };
const statusPill = (status) => pill(status[0].toUpperCase() + status.slice(1), TONE[status] ?? '');

const initials = (name) => (name ?? '').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const avatar = (person, size = 'sm', alt = '') => (person.sign_photo
  ? html`<img class="avatar ${size}" src="/media/${person.sign_photo}" alt="${alt}">`
  : html`<span class="avatar ${size}" aria-hidden="true">${initials(person.sign_name || person.name)}</span>`);
const accountLink = (user) => html`<a class="avatar-link" href="/account" aria-label="Account">${avatar(user, 'sm')}</a>`;

const largeHeader = (title, { lede, trailing } = {}) => html`<header class="nav-large">
  <h1>${title}</h1>${trailing ?? ''}
  ${lede ? html`<p class="lede">${lede}</p>` : ''}
</header>`;
const topbar = ({ back, title = '', trailing = '' }) => html`<header class="topbar">
  ${back ? html`<a class="icon-btn glass back" href="${back.href}">${icon('back', { width: 2.2 })}<span>${back.label}</span></a>` : html`<span></span>`}
  <span class="topbar-title" aria-hidden="true">${title}</span>
  <div class="topbar-trail">${trailing}</div>
</header>`;
const sheetButton = (id, label, iconName) => html`<button type="button" class="icon-btn glass" popovertarget="${id}" aria-label="${label}">${icon(iconName, { width: 2 })}</button>`;
const sheet = (id, title, body, { lede } = {}) => html`<div id="${id}" popover class="sheet" role="dialog" aria-labelledby="${id}-title">
  <div class="grabber" aria-hidden="true"></div>
  <h2 class="sheet-title" id="${id}-title">${title}</h2>
  ${lede ? html`<p class="sheet-lede">${lede}</p>` : ''}
  ${body}
</div>`;
const closeButton = (id, label = 'Cancel') => html`<button type="button" class="btn plain wide" popovertarget="${id}" popovertargetaction="hide">${label}</button>`;
const group = (header, content, footer) => html`<section class="group">
  ${header ? html`<h2 class="group-header">${header}</h2>` : ''}${content}${footer ? html`<p class="group-footer">${footer}</p>` : ''}
</section>`;
const callout = (tone, iconName, content) => html`<div class="callout ${tone}"${tone === 'error' ? raw(' role="alert"') : ''}>${iconName ? icon(iconName) : ''}<div>${content}</div></div>`;
const field = (label, control, hint) => html`<li><label class="field"><span class="field-label">${label}</span>${control}${hint ? html`<span class="hint">${hint}</span>` : ''}</label></li>`;
const disclosure = (title, body, { open = false, id, lead } = {}) => html`<details class="disclosure"${id ? raw(` id="${id}"`) : ''}${open ? raw(' open') : ''}>
  <summary>${lead ?? ''}<span>${title}</span>${chev()}</summary>
  <div class="disclosure-body">${body}</div>
</details>`;

// rows from lineDiff/compactDiff → green added, red removed lines.
const renderDiff = (rows) =>
  html`<div class="diff">${rows.map(([type, line]) =>
    type === 'add' ? html`<ins>${line}</ins>` : type === 'del' ? html`<del>${line}</del>` : type === 'gap' ? html`<div class="gap">…</div>` : html`<div>${line}</div>`)}</div>`;

// ---------- the app shell ----------

const tabItems = (user) => [
  ['home', '/', 'Home', 'home'],
  user.can_write && ['write', '/write', 'Write', 'write'],
  user.is_admin && ['admin', '/admin', 'Admin', 'admin'],
  ['account', '/account', 'Account', 'person'],
].filter(Boolean);

function layout(title, user, body, { refresh, tab, toolbar, sheets, pageClass = 'page', bodyClass = '' } = {}) {
  const tabs = user && !toolbar && tab !== false ? tabItems(user) : [];
  const orbs = String(body).includes('<canvas class="orb') || String(toolbar ?? '').includes('<canvas class="orb');
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Tvarvi">
<meta name="format-detection" content="telephone=no">
${refresh ? html`<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${title} · Tvarvi</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/icon.png">
<link rel="apple-touch-icon" href="/icon.png">
${orbs ? html`<script src="/orbs.js" defer></script>` : ''}
</head>
<body class="${[bodyClass, tabs.length ? 'with-tabs' : ''].filter(Boolean).join(' ')}">
<a class="skip" href="#main">Skip to content</a>
<main id="main" class="${pageClass}">
${body}
</main>
${sheets ?? ''}
${toolbar ? html`<div class="toolbar">${toolbar}</div>` : ''}
${tabs.length
    ? html`<nav class="tabbar glass tabs-${tabs.length}" aria-label="Main">${tabs.map(([key, href, label, iconName]) =>
      html`<a class="tab" href="${href}"${key === tab ? raw(' aria-current="page"') : ''}${key === 'admin' && user.pending ? html` aria-label="Admin, ${user.pending} waiting"` : ''}><span class="tab-icon">${icon(iconName)}${key === 'admin' && user.pending ? html`<span class="tab-badge">${user.pending}</span>` : ''}</span><span>${label}</span></a>`)}</nav>`
    : ''}
${toolbar || tabs.length ? html`<div class="bottom-blur" aria-hidden="true"></div>` : ''}
</body>
</html>`.toString();
}

export const loginPage = (error) =>
  layout('Log in', null, html`
<div class="stack">
  <div class="app-mark" aria-hidden="true">${icon('mark', { width: 2.6 })}</div>
  <div><h1>Tvarvi</h1><p class="lede">Review, sign and publish Tvarvi's health articles.</p></div>
  ${error ? callout('error', 'warn', error) : ''}
  <form method="post" action="/login" class="btn-stack">
    <ul class="list form-list">
      ${field('Email', html`<input type="email" name="email" required maxlength="254" autocomplete="username" autocapitalize="none" spellcheck="false">`)}
      ${field('Password', html`<input type="password" name="password" required maxlength="200" autocomplete="current-password">`)}
    </ul>
    <button class="btn wide">Log in</button>
  </form>
</div>`, { pageClass: 'center-page' });

export function errorPage(user, status, message, back) {
  const title = { 403: 'Not allowed', 404: 'Not found', 409: 'Already changed' }[status] ?? (status >= 500 ? 'Something went wrong' : 'Please check');
  return layout(title, user, html`
<div class="stack">
  <div class="error-mark">${icon('warn')}</div>
  <h1>${title}</h1>
  <p class="lede" role="alert">${message}</p>
  <a class="btn wide" href="${back}">Go back</a>
</div>`, { pageClass: 'center-page', tab: false });
}

// ---------- home ----------

function articleRow(a, { who = 'author' } = {}) {
  const person = who === 'reviewer' ? (a.reviewer ? `Reviewer ${a.reviewer}` : 'No reviewer yet') : a.author;
  return html`<li><a class="row" href="/articles/${a.id}">
  <span class="row-body">
    <span class="row-title clamp">${a.title}</span>
    <span class="row-sub">${badge(a.status)}<span>${person}</span><span class="sep"></span>${when(a.updated_at)}</span>
  </span>${chev()}
</a></li>`;
}
const articleList = (rows, options) => html`<ul class="list">${rows.map((a) => articleRow(a, options))}</ul>`;

export function dashboardPage(user, lists) {
  const { suggestions = 0, snapshots = 0 } = lists.attention ?? {};
  const toSign = lists.reviews.filter((a) => a.status === 'in_review').length;
  const toCheck = lists.reviews.length - toSign;
  const summary = [
    toSign && `${plural(toSign, 'article')} to sign`,
    toCheck && `${plural(toCheck, 'set')} of posts to check`,
    lists.queue.length && `${plural(lists.queue.length, 'article')} waiting for a reviewer`,
    lists.publishing.length && `${plural(lists.publishing.length, 'article')} waiting to be published`,
  ].filter(Boolean);
  const lede = summary.length ? `${sentence(summary)}.` : "You're all caught up.";
  const lede1 = lede[0].toUpperCase() + lede.slice(1);
  return layout('Home', user, html`
${largeHeader('Home', { lede: lede1, trailing: accountLink(user) })}
${suggestions || snapshots
    ? group('Needs your decision', html`<ul class="list">
    ${suggestions ? html`<li><a class="row" href="/suggestions"><span class="row-icon orange">${icon('bulb')}</span><span class="row-body"><span class="row-title">Suggestions for the AI agents</span></span><span class="count">${suggestions}</span>${chev()}</a></li>` : ''}
    ${snapshots ? html`<li><a class="row" href="/sources"><span class="row-icon teal">${icon('link')}</span><span class="row-body"><span class="row-title">Changed compliance pages</span></span><span class="count">${snapshots}</span>${chev()}</a></li>` : ''}
  </ul>`)
    : ''}
${user.can_review
    ? group('Assigned to you', lists.reviews.length ? articleList(lists.reviews) : '',
      lists.reviews.length ? '' : 'Nothing to review right now. Articles appear here when an admin assigns them to you.')
    : ''}
${user.is_admin
    ? group('Needs a reviewer', lists.queue.length ? articleList(lists.queue) : '', lists.queue.length ? '' : 'No articles are waiting for a reviewer.')
    : ''}
${user.can_publish && (lists.publishing.length || !user.can_review)
    ? group('Waiting for a publisher', lists.publishing.length ? articleList(lists.publishing, { who: 'reviewer' }) : '',
      lists.publishing.length ? '' : 'Nothing is waiting to be published.')
    : ''}
${user.is_admin && lists.inProgress.length ? group('In progress', articleList(lists.inProgress, { who: 'reviewer' })) : ''}
${user.can_write
    ? group('Your articles', lists.mine.length
      ? articleList(lists.mine, { who: 'reviewer' })
      : html`<ul class="list"><li><a class="row action" href="/write"><span class="row-icon">${icon('write')}</span><span class="row-body"><span class="row-title">Write your first article</span></span>${chev()}</a></li></ul>`)
    : ''}`, { tab: 'home' });
}

// ---------- write ----------

const draftPill = (status) => {
  const [text, tone] = DRAFT_STATUS[status] ?? [status, ''];
  return html`<span class="badge ${tone}">${status === 'running' ? orb('searching', 20, 'Researching') : ''}${text}</span>`;
};

export function writePage(user, { drafts, researchReady }) {
  return layout('Write', user, html`
${largeHeader('Write', { lede: 'Have the article agent research and draft it, or write it yourself.', trailing: accountLink(user) })}
<div class="segmented page-switch" role="radiogroup" aria-label="How to write">
  <input type="radio" name="how" id="how-ai" checked><label for="how-ai">With AI</label>
  <input type="radio" name="how" id="how-self"><label for="how-self">Myself</label>
</div>
<div class="when-ai">
  ${researchReady
    ? html`<form method="post" action="/drafts" class="btn-stack">
    ${group('Research and draft', html`<ul class="list form-list">
      ${field('Topic or keyword', html`<input name="topic" required minlength="3" maxlength="150" placeholder="PCOD problem and irregular periods">`)}
      ${field('Brief (optional)', html`<textarea name="brief" rows="4" maxlength="2000" placeholder="The coined concept, the reader's worry, prices, which Tvarvi services to mention, tags, anything else the writer must follow"></textarea>`)}
    </ul>`, 'The article agent researches only the approved Research sites and writes 2,400–3,400 words: Tvarvi Key Takeaways, 5 chapters, 3 picture blocks, 2 tables, FAQs and 5–8 references, in about 5–10 minutes. You check the draft before you submit it.')}
    <button class="btn wide">${icon('sparkle')}<span>Research and draft</span></button>
  </form>`
    : callout('info', 'info', html`<p><strong>No research sites yet.</strong></p><p>An admin needs to add Research sites on the Sources page first.</p>`)}
  ${drafts.length
    ? group('Your AI drafts', html`<ul class="list">${drafts.map((d) => html`<li><a class="row" href="/drafts/${d.id}">
      <span class="row-body"><span class="row-title clamp">${d.topic}</span><span class="row-sub">${draftPill(d.status)}<span class="sep"></span>${when(d.created_at)}</span></span>${chev()}
    </a></li>`)}</ul>`)
    : ''}
</div>
<div class="when-self">
  <form method="post" action="/articles" class="btn-stack">
    ${group('Write an article', html`<ul class="list form-list">
      ${field('Title', html`<input name="title" required maxlength="200">`)}
      ${field('Article', html`<textarea name="body" rows="18" required maxlength="100000"></textarea>`)}
    </ul>`, 'Leave a blank line between paragraphs. Start a line with "## " for a heading or "- " for a bullet point.')}
    <button class="btn wide">${icon('send')}<span>Submit to admin</span></button>
  </form>
</div>`, { tab: 'write' });
}

// ---------- admin hub ----------

export function adminPage(user, { rules, examples, sources, snapshots, suggestions, members }) {
  const row = (href, iconName, tone, title, sub, count) => html`<li><a class="row" href="${href}">
  <span class="row-icon ${tone}">${icon(iconName)}</span>
  <span class="row-body"><span class="row-title">${title}</span><span class="row-sub">${sub}</span></span>
  ${count ? html`<span class="count">${count}</span>` : ''}${chev()}
</a></li>`;
  return layout('Admin', user, html`
${largeHeader('Admin', { lede: 'Train the AI agents, approve sources and decide suggestions.', trailing: accountLink(user) })}
${group('', html`<ul class="list">
  ${row('/training', 'book', 'indigo', 'Training', `${plural(rules, 'rule')} and ${plural(examples, 'example')}`)}
  ${row('/sources', 'link', 'teal', 'Sources', snapshots ? `${plural(snapshots, 'changed page')} to approve` : plural(sources, 'source'), snapshots)}
  ${row('/suggestions', 'bulb', 'orange', 'Suggestions', suggestions ? `${plural(suggestions, 'suggestion')} to decide` : 'Nothing to decide', suggestions)}
</ul>`)}
${group('', html`<ul class="list">${row('/users', 'people', 'gray', 'Team', plural(members, 'member'))}</ul>`, 'Only admins see this tab.')}`, { tab: 'admin' });
}

// ---------- articles ----------

function assignSheet(a, reviewers) {
  const changed = a.status === 'returned' && (a.base_title !== a.title || a.base_body !== a.body);
  return sheet('assign-sheet', 'Assign a reviewer', html`<form method="post" action="/articles/${a.id}" class="btn-stack">
  <input type="hidden" name="action" value="assign">
  <ul class="list form-list">
    <li class="select"><label class="field"><span class="field-label">Reviewer</span>
      <select name="reviewer_id" required>
        <option value="">Choose…</option>
        ${reviewers.map((r) => html`<option value="${r.id}"${r.id === a.reviewer_id ? raw(' selected') : ''}>${r.name}</option>`)}
      </select></label></li>
  </ul>
  ${changed
    ? html`<fieldset class="group"><legend>Which version should the reviewer work on?</legend><ul class="list">
    <li><label class="choice"><input type="radio" name="version" value="new" checked><span>Keep the reviewer's changes</span></label></li>
    <li><label class="choice"><input type="radio" name="version" value="old"><span>Revert to the previous version</span></label></li>
  </ul></fieldset>`
    : ''}
  <button class="btn wide">Assign</button>
  ${closeButton('assign-sheet')}
</form>`);
}

// The advisory AI audit of the text under review. It never blocks approval; the approval records what it said.
function auditBlock(a) {
  if (a.audit_status === 'running') {
    return html`<div class="callout ai">${orb('breathing', 20, 'The AI audit is running')}<div><p><strong>The AI audit is checking this text.</strong></p><p>Reload in a minute or two. It is advice only and never blocks your decision.</p></div></div>`;
  }
  if (a.audit_status === 'ready') return callout('ok', 'check', html`<p><strong>AI audit: no issues found.</strong></p>`);
  if (a.audit_status === 'failed') return callout('warn', 'warn', html`<p><strong>The AI audit could not run.</strong></p><p>You can still approve.</p>`);
  if (a.audit_status === 'issues') {
    const notes = (a.audit_notes?.match(/^\s*-\s/gm) ?? []).length || 1;
    return disclosure(html`AI audit (advisory): ${plural(notes, 'note')}`, html`<p class="pre">${a.audit_notes ?? ''}</p>
      <p class="lede">Advice only. You decide, and your approval records what the audit said.</p>`, { lead: icon('sparkle', { cls: 'icon ai-icon' }) });
  }
  return '';
}

const diffView = (a) =>
  renderDiff([
    ...(a.base_title !== a.title ? [['del', `Title: ${a.base_title}`], ['add', `Title: ${a.title}`]] : []),
    ...lineDiff(a.base_body, a.body),
  ]);

function signSheet(a, user) {
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return sheet('sign-sheet', 'Sign and approve', html`
  <div class="signature">
    ${avatar(user, 'lg', 'Your photo')}
    <div class="sig-text"><span class="sig-label">Medically reviewed by</span><span class="sig-name">${user.sign_name ?? ''}</span><span class="sig-cred">${user.sign_credentials ?? ''}</span></div>
    <span class="sig-date">${today}</span>
  </div>
  <p class="sheet-lede">The website shows this signature and your photo with the article. Approving also starts the Instagram, LinkedIn and X posts. Approve only the text as it is; if you changed it, send it to the admin.</p>
  <div class="btn-stack">
    <button class="btn wide" form="review" name="action" value="approve">${icon('seal')}<span>Sign and approve</span></button>
    <button type="button" class="btn secondary wide" popovertarget="send-sheet">Send to the admin instead</button>
    ${closeButton('sign-sheet')}
  </div>`);
}

const sendSheet = () => sheet('send-sheet', 'Send to the admin', html`
  <ul class="list form-list">
    ${field('Note for the admin (optional)', html`<textarea name="note" rows="3" maxlength="2000" form="review" placeholder="What should change, or why a second opinion"></textarea>`)}
    <li><label class="choice switch-row"><input type="checkbox" class="switch" name="second_opinion" value="1" form="review"><span>Ask for a second opinion<span class="sub">Another reviewer reads it too</span></span></label></li>
  </ul>
  <p class="sheet-lede">The admin sees your changes, added lines in green and removed lines in red, and reassigns the article.</p>
  <div class="btn-stack">
    <button class="btn wide" form="review" name="action" value="send_to_admin">${icon('send')}<span>Send to admin</span></button>
    ${closeButton('send-sheet')}
  </div>`);

function itemRow(item) {
  const [iconName, tone] = CHANNEL_LOOK[item.channel];
  const flagged = item.pictures?.filter((p) => !p.ok).length ?? 0;
  const detail = item.channel === 'website'
    ? item.pictures?.length ? (flagged ? `${plural(flagged, 'picture')} flagged` : plural(item.pictures.length, 'picture')) : 'The approved article'
    : item.carousel ? `Carousel${item.carousel.slides.length ? ` of ${item.carousel.slides.length} slides` : ''}` : clip(item.body ?? '', 70);
  return html`<li><a class="row" href="/items/${item.id}">
  <span class="row-icon ${tone}">${icon(iconName)}</span>
  <span class="row-body"><span class="row-title">${CHANNELS[item.channel].label}</span>
    <span class="row-sub">${badge(item.status)}${item.simulated ? pill('Simulated', 'orange') : ''}${detail ? html`<span>${detail}</span>` : ''}</span></span>${chev()}
</a></li>`;
}

export function articlePage(user, { article: a, items, events, reviewers, perm, generating }) {
  const simulated = items.filter((i) => isDryRun(i.channel)).map((i) => CHANNELS[i.channel].label);
  const review = perm.review;
  const changed = a.status === 'returned' && (a.base_title !== a.title || a.base_body !== a.body);
  const head = html`<header class="article-head">
  <h1>${a.title}</h1>
  <div class="meta">${badge(a.status)}<span>By ${a.author}</span>${a.reviewer ? html`<span class="sep"></span><span>Reviewer ${a.reviewer}</span>` : ''}</div>
  <div class="meta"><span>${readMinutes(a.body)} min read</span><span class="sep"></span><span>Updated ${when(a.updated_at)}</span>${a.draftId ? html`<span class="sep"></span><a href="/drafts/${a.draftId}">Research record</a>` : ''}</div>
</header>`;
  const text = html`<div class="prose">${raw(textToHtml(a.body))}</div>`;
  const posts = items.length
    ? group(generating ? html`${orb('composing', 20, 'The AI agents are writing')}<span>Posts: the AI agents are writing. This page refreshes by itself.</span>` : 'Posts',
      html`<ul class="list">${items.map(itemRow)}</ul>`,
      [simulated.length ? `Trial mode: publishing to ${simulated.join(', ')} is simulated. Nothing is posted there.` : '',
        perm.sendToPublisher ? 'Every post is ready. Publish each one from its page, or send the set to a publisher for a final look.' : ''].filter(Boolean).join(' '))
    : '';
  const history = disclosure(`History (${events.length})`, html`<ol class="timeline">${events.map((e) => html`
  <li>${stamp(e.at)}${e.who ?? 'System'} ${EVENT[e.action] ?? e.action}${e.detail ? html`: ${e.detail}` : ''}</li>`)}
</ol>`, { id: 'history', lead: icon('history', { cls: 'icon muted-icon' }) });

  let toolbar = null;
  let sheets = '';
  if (review) {
    toolbar = html`<div class="segmented" role="radiogroup" aria-label="View">
    <input type="radio" name="view" id="view-read" checked><label for="view-read">Read</label>
    <input type="radio" name="view" id="view-edit"><label for="view-edit">Edit</label>
  </div>
  <button type="button" class="btn when-read" popovertarget="sign-sheet">${icon('seal')}<span>Approve</span></button>
  <button type="button" class="btn when-edit" popovertarget="send-sheet">${icon('send')}<span>Send</span></button>`;
    sheets = html`${signSheet(a, user)}${sendSheet()}`;
  } else if (perm.assign) {
    toolbar = html`<button type="button" class="btn" popovertarget="assign-sheet">${icon('person')}<span>${a.reviewer_id ? 'Assign a reviewer again' : 'Assign a reviewer'}</span></button>`;
    sheets = assignSheet(a, reviewers);
  } else if (perm.sendToPublisher) {
    toolbar = html`<form method="post" action="/articles/${a.id}"><button class="btn" name="action" value="send_to_publisher">${icon('send')}<span>Send to a publisher</span></button></form>`;
  } else if (perm.sendBack) {
    toolbar = html`<button type="button" class="btn secondary" popovertarget="sendback-sheet">Send back to the reviewer</button>`;
    sheets = sheet('sendback-sheet', 'Send back to the reviewer', html`<form method="post" action="/articles/${a.id}" class="btn-stack">
  <ul class="list form-list">${field('What should the reviewer fix?', html`<textarea name="note" rows="3" maxlength="2000"></textarea>`)}</ul>
  <button class="btn wide" name="action" value="send_back">Send back</button>
  ${closeButton('sendback-sheet')}
</form>`);
  }

  return layout(a.title, user, html`
${topbar({ back: { href: '/', label: 'Home' }, title: a.title })}
${a.note ? callout('info', 'info', html`<p><strong>Note:</strong> ${a.note}</p>`) : ''}
${a.status === 'returned'
    ? changed
      ? disclosure("Reviewer's changes", html`${diffView(a)}<p class="lede">Green lines were added, red lines were removed.</p>`, { open: true, lead: icon('doc', { cls: 'icon muted-icon' }) })
      : callout('info', 'info', html`<p>The reviewer did not change the text.</p>`)
    : ''}
${['in_review', 'returned'].includes(a.status) ? auditBlock(a) : ''}
${review
    ? html`<form id="review" method="post" action="/articles/${a.id}">
  <button type="submit" disabled hidden aria-hidden="true"></button>
  <div class="view-read">${head}${text}</div>
  <div class="editor view-edit">
    <label class="visually-hidden" for="edit-title">Title</label>
    <input class="title-input" id="edit-title" name="title" value="${a.title}" required maxlength="200">
    <label class="visually-hidden" for="edit-body">Article</label>
    <textarea class="body-input" id="edit-body" name="body" required maxlength="100000">${a.body}</textarea>
    <p class="hint">Leave a blank line between paragraphs. Start a line with "## " for a heading or "- " for a bullet point. Changed text goes to the admin, who sees what you changed.</p>
  </div>
</form>`
    : html`${head}${posts}${items.length ? html`<h2 class="section-title">Approved article</h2>` : ''}${text}`}
${history}`, {
    refresh: generating ? 5 : null, tab: 'home', toolbar, sheets, bodyClass: 'reading',
  });
}

// ---------- the posts: one page each ----------

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
  return html`<form method="post" action="/items/${item.id}" class="btn-stack">
  <input type="hidden" name="action" value="metrics">
  ${group('Engagement', html`<ul class="list form-list">${[['likes', 'Likes'], ['shares', 'Shares'], ['reach', 'Reach'], ['saves', 'Saves']].map(([name, text]) =>
    html`<li><label class="field-inline"><span>${text}</span><input type="number" name="${name}" min="0" max="1000000000000" step="1" inputmode="numeric" value="${m?.[name] ?? ''}" placeholder="0"></label></li>`)}</ul>`,
  m ? html`Last updated ${stamp(m.recorded_at)}.` : 'Type the numbers from the platform. The coach uses them to find what works.')}
  <button class="btn secondary wide">Save engagement</button>
</form>`;
}

const carouselPill = (status) => {
  const [text, tone] = CAROUSEL_STATUS[status] ?? [status, ''];
  return html`<span class="badge ${tone}">${status === 'working' ? orb('weaving', 20, 'Working') : ''}${text}</span>`;
};

function singleImage(item, editable) {
  return html`${item.image
    ? html`<img class="preview-image" src="/media/${item.image}" alt="Image for the Instagram post">`
    : callout('warn', 'photo', html`<p>Instagram posts need an image before they can be marked ready.</p>`)}
  ${editable
    ? html`<form method="post" action="/items/${item.id}/image" enctype="multipart/form-data" class="btn-stack">
    ${group('', html`<ul class="list form-list">${field(item.image ? 'Replace the image' : 'Image', html`<input type="file" name="image" accept="image/jpeg" required>`, 'JPEG, up to 8 MB, with an aspect ratio between 4:5 and 1.91:1.')}</ul>`)}
    <button class="btn secondary wide">${icon('upload')}<span>Upload JPEG</span></button>
  </form>`
    : ''}`;
}

// Off by default: a carousel is only made when the reviewer turns this on, and turning it off removes it.
function carouselToggle(item, c) {
  const busy = c?.status === 'working';
  return html`<form method="post" action="/items/${item.id}/carousel">
  <ul class="list"><li><button class="row toggle" name="carousel" value="${c ? 'off' : 'on'}" aria-pressed="${c ? 'true' : 'false'}"${busy ? raw(' disabled') : ''}>
    <span class="row-icon indigo">${icon('layers')}</span>
    <span class="row-body"><span class="row-title">Carousel</span><span class="row-sub">${busy
      ? 'The carousel is being made. You can turn it off once it finishes.'
      : c
        ? 'On: this post is a carousel. Turning it off removes the carousel and its slides.'
        : 'Off: a single image. Turn it on to have the AI write 5–10 slides and Gemini make the pictures (about $0.90).'}</span></span>
    <span class="switch-visual" aria-hidden="true"></span>
  </button></li></ul>
</form>`;
}

// The Instagram post as a carousel: its status, the finished slides and what the final text check found.
function carouselSummary(c) {
  const flagged = c.slides.filter((s) => s.check && !s.check.ok).length;
  const finalFlagged = c.final_check.filter((r) => !r.ok).length;
  return html`<ul class="list"><li><a class="row" href="/carousels/${c.id}">
    <span class="row-body"><span class="row-title">Carousel${c.slides.length ? ` of ${c.slides.length} slides` : ''}</span>
    <span class="row-sub">${carouselPill(c.status)}${flagged ? html`<span>${plural(flagged, 'picture')} flagged by the picture check</span>` : ''}</span></span>${chev()}
  </a></li></ul>
  ${c.finals.length
    ? html`<div class="strip">${c.finals.map((name, i) => html`<img src="/media/${name}" alt="Finished slide ${i + 1}">`)}</div>
  ${c.status === 'ready' && c.final_check.length
      ? finalFlagged
        ? callout('warn', 'warn', html`<p>The final text check flagged ${plural(finalFlagged, 'slide')}. See the carousel page.</p>`)
        : callout('ok', 'check', html`<p>The final text check found that every slide matches the approved text.</p>`)
      : ''}`
    : html`<p class="lede">No finished slides yet: design them in Glass Slides and upload them on the carousel page.</p>`}`;
}

const checklistFields = () => html`<fieldset class="group">
  <legend>Image checklist: tick every box before Mark ready</legend>
  <ul class="list">${CAROUSEL_CHECKLIST.map(([key, text]) => html`<li><label class="choice"><input type="checkbox" name="check_${key}" value="1"><span>${text}</span></label></li>`)}</ul>
</fieldset>`;

// The website article: the approved text itself, its byline, and the pictures Gemini made for its picture blocks.
function websiteParts(item, perm, a) {
  const editable = perm.editItems && EDITABLE.includes(item.status);
  return html`${a.signature
    ? group('Byline', html`<div class="signature">
    ${avatar({ sign_photo: a.signature_photo, sign_name: a.signature }, 'md', 'The reviewer\'s photo')}
    <div class="sig-text"><span class="sig-label">Medically reviewed by</span><span class="sig-name">${a.signature}</span><span class="sig-cred">Written by ${a.author}</span></div>
    <span class="sig-date">Signed ${stamp(a.signed_at)}</span>
  </div>`, 'Publishing adds this byline and the standard disclaimer to the approved article.')
    : ''}
  ${item.pictures.length
    ? group('Pictures', html`<div class="pictures">${item.pictures.map((p) => html`<figure class="picture">
      ${p.file ? html`<img src="/items/${item.id}/pictures/${p.file}" alt="${p.alt}">` : html`<div class="blank">No picture</div>`}
      <figcaption><strong>Picture ${p.n}: ${p.title}</strong>
        <span>${p.ok ? pill('Picture check passed', 'green') : pill('Flagged', 'red')}</span>
        ${p.notes?.length ? html`<ul>${p.notes.map((note) => html`<li>${note}</li>`)}</ul>` : ''}
        ${editable ? html`<form method="post" action="/items/${item.id}"><button class="btn secondary small" name="action" value="picture_${p.n}">${icon('refresh')}<span>New picture</span></button></form>` : ''}
      </figcaption>
    </figure>`)}</div>`)
    : ''}
  ${html`<div class="prose">${raw(textToHtml(a.body, { pictures: new Map(item.pictures.filter((p) => p.file).map((p) => [p.n, { ...p, url: `/items/${item.id}/pictures/${p.file}` }])) }))}</div>`}`;
}

export function itemPage(user, { article: a, item, perm, next }) {
  const { label, max } = CHANNELS[item.channel];
  const social = SOCIAL.includes(item.channel);
  const editable = perm.editItems && EDITABLE.includes(item.status);
  const canPublish = perm.publish && ['ready', 'publish_failed'].includes(item.status);
  const carousel = item.carousel;
  const moreActions = [];
  let primary = '';
  let secondary = '';
  if (canPublish) {
    primary = html`<form method="post" action="/items/${item.id}"><button class="btn" name="action" value="publish">${icon('send')}<span>${item.status === 'publish_failed' ? 'Retry publishing' : 'Publish'} to ${label}${isDryRun(item.channel) ? ' (simulated)' : ''}</span></button></form>`;
  }
  if (editable && social) {
    const ready = html`<button class="btn" form="post" name="action" value="ready">${icon('check', { width: 2.2 })}<span>Mark ready</span></button>`;
    const save = html`<button class="btn secondary" form="post" name="action" value="save">Save</button>`;
    if (!primary) {
      primary = item.status === 'ready' ? save : ready;
      if (item.status !== 'ready') secondary = save;
    } else {
      moreActions.push(html`<button class="btn secondary" form="post" name="action" value="save">Save changes</button>`);
    }
    moreActions.push(html`<button class="btn secondary" form="post" name="action" value="regenerate">${icon('sparkle')}<span>Rewrite with AI</span></button>`);
  }
  if (editable && item.channel === 'website') {
    if (!primary && item.status !== 'ready') {
      primary = html`<form method="post" action="/items/${item.id}"><button class="btn" name="action" value="ready">${icon('check', { width: 2.2 })}<span>Mark ready${item.pictures.length ? ': pictures are fine' : ''}</span></button></form>`;
    }
    if (perm.pictures && (item.status === 'failed' || (!item.pictures.length && pictureBlocks(a.body).length))) {
      moreActions.push(html`<form method="post" action="/items/${item.id}"><button class="btn secondary wide" name="action" value="regenerate">${icon('photo')}<span>Make the pictures${item.pictures.length ? ' again' : ''}</span></button></form>`);
    }
  }
  if (perm.promote && social && ['ready', 'published'].includes(item.status) && !item.promoted) {
    moreActions.push(html`<form method="post" action="/items/${item.id}"><button class="btn secondary wide" name="action" value="promote">Promote to example</button></form>`);
  }
  const more = moreActions.length
    ? sheet('item-more', label, html`<div class="actions-list">${moreActions}${closeButton('item-more')}</div>`)
    : '';
  const toolbar = primary || secondary || more
    ? html`${more ? html`<button type="button" class="icon-btn glass" popovertarget="item-more" aria-label="More actions">${icon('more')}</button>` : ''}${secondary}${primary}`
    : null;
  const generatingNote = item.status === 'generating'
    ? html`<div class="callout ai">${orb(item.channel === 'website' ? 'shaping' : 'composing', 20, 'Working')}<div><p><strong>${item.channel === 'website' ? 'Gemini is making the pictures and the AI is checking each one.' : 'The AI agents are writing this post.'}</strong></p><p>This page refreshes by itself.</p></div></div>`
    : '';

  return layout(`${label}: ${a.title}`, user, html`
${topbar({ back: { href: `/articles/${a.id}`, label: 'Article' }, title: label })}
<header class="article-head">
  <h1>${label}</h1>
  <div class="meta">${badge(item.status)}${item.simulated ? pill('Simulated', 'orange') : ''}<a href="/articles/${a.id}">${a.title}</a></div>
</header>
${generatingNote}
${item.error ? callout('error', 'warn', html`<p class="pre">${item.error}</p>`) : ''}
${item.ai_notes ? callout(item.ai_ok ? 'ai' : 'warn', 'sparkle', html`<p class="pre">${item.ai_notes}</p>`) : ''}
${item.channel === 'website' ? websiteParts(item, perm, a) : ''}
${item.channel === 'instagram'
    ? html`${editable ? carouselToggle(item, carousel) : ''}${carousel ? carouselSummary(carousel) : singleImage(item, editable)}`
    : ''}
${social
    ? editable
      ? html`<form id="post" method="post" action="/items/${item.id}" class="btn-stack">
  ${group('Post', html`<div class="card"><label class="visually-hidden" for="post-body">${label} post text</label><textarea class="post-editor" id="post-body" name="body" rows="10" maxlength="10000">${item.body}</textarea></div>`,
    `${postLength(item.channel, item.body)} / ${max} characters${item.channel === 'x' ? ' (emoji and non-Latin characters count as 2)' : ''}.`)}
  ${carousel?.finals.length && carousel.status === 'ready' ? checklistFields() : ''}
</form>`
      : item.body ? group('Post', html`<div class="card"><p class="post-text">${item.body}</p></div>`) : ''
    : ''}
${item.external_url ? html`<ul class="list"><li><a class="row action" href="${item.external_url}" target="_blank" rel="noopener noreferrer">${icon('external')}<span class="row-body"><span class="row-title">View the live post</span></span></a></li></ul>` : ''}
${next ? html`<ul class="list"><li><a class="row" href="/items/${next.id}"><span class="row-body"><span class="row-title">Next: ${CHANNELS[next.channel].label}</span><span class="row-sub">${badge(next.status)}</span></span>${chev()}</a></li></ul>` : ''}
${item.promoted ? callout('ok', 'check', html`<p>This post is an approved example (<a href="/knowledge/${item.promoted}">view</a>).</p>`) : ''}
${perm.metrics && social && item.status === 'published' ? metricsForm(item) : ''}
${item.ai_draft && item.ai_draft !== item.body
    ? disclosure("The AI's original draft (changed by the reviewer)", renderDiff(lineDiff(item.ai_draft, item.body)), { lead: icon('sparkle', { cls: 'icon ai-icon' }) })
    : ''}
${item.inputs?.length
    ? disclosure(`Sources used (${item.inputs.length})`, html`<ul class="inputs">${item.inputs.map((input) => html`<li>${inputLine(input, user)}</li>`)}</ul>`, { lead: icon('book', { cls: 'icon muted-icon' }) })
    : ''}`, {
    refresh: item.status === 'generating' || item.status === 'publishing' ? 5 : null, tab: 'home', toolbar, sheets: more,
    bodyClass: item.channel === 'website' ? 'reading' : '',
  });
}

// ---------- team and account ----------

function memberSheet(u, user) {
  return sheet(`member-${u.id}`, u.name, html`<form method="post" action="/users/${u.id}" class="btn-stack">
  <p class="sheet-lede">${u.email}${u.can_review ? html`<br>${u.sign_name ? `Signs as ${u.sign_name}, ${u.sign_credentials}` : 'No signing details yet'}` : ''}</p>
  <ul class="list">
    ${Object.entries(FLAG_LABELS).map(([flag, text]) => html`<li><label class="choice switch-row"><input type="checkbox" class="switch" name="${flag}" value="1"${u[flag] ? raw(' checked') : ''}${u.id === user.id && flag === 'is_admin' ? raw(' disabled') : ''}><span>${text}<span class="sub">${FLAG_HELP[flag]}</span></span></label></li>`)}
  </ul>
  <ul class="list"><li><label class="choice switch-row"><input type="checkbox" class="switch" name="active" value="1"${u.active ? raw(' checked') : ''}${u.id === user.id ? raw(' disabled') : ''}><span>Active<span class="sub">Inactive members can't log in</span></span></label></li></ul>
  <button class="btn wide" name="action" value="update">Save</button>
  ${u.id === user.id ? '' : html`<button class="btn secondary wide" name="action" value="reset_password">Reset password</button>`}
  ${closeButton(`member-${u.id}`)}
</form>`);
}

const roleText = (u) => Object.entries(FLAG_LABELS).filter(([flag]) => u[flag]).map(([, text]) => text).join(', ') || 'No roles';

export function usersPage(user, users, created) {
  const addSheet = sheet('add-member', 'Add a team member', html`<form method="post" action="/users" class="btn-stack">
  <ul class="list form-list">
    ${field('Name', html`<input name="name" required maxlength="100" autocomplete="off">`)}
    ${field('Email', html`<input type="email" name="email" required maxlength="254" autocomplete="off" autocapitalize="none" spellcheck="false">`)}
  </ul>
  <fieldset class="group"><legend>Roles</legend><ul class="list">
    ${Object.entries(FLAG_LABELS).map(([flag, text]) => html`<li><label class="choice switch-row"><input type="checkbox" class="switch" name="${flag}" value="1"><span>${text}<span class="sub">${FLAG_HELP[flag]}</span></span></label></li>`)}
  </ul></fieldset>
  <button class="btn wide">Add member</button>
  ${closeButton('add-member')}
</form>`, { lede: 'They get a password you share with them privately.' });
  return layout('Team', user, html`
${topbar({ back: { href: '/admin', label: 'Admin' }, title: 'Team', trailing: sheetButton('add-member', 'Add a team member', 'plus') })}
${largeHeader('Team', { lede: `${plural(users.filter((u) => u.active).length, 'active member')}. Tap a member to change their roles.` })}
${created
    ? callout('ok', 'check', html`<p>Password for <strong>${created.email}</strong>: <code>${created.password}</code></p><p>Share it privately. It won't be shown again. They can change it on their Account page.</p>`)
    : ''}
${group('', html`<ul class="list">${users.map((u) => html`<li class="indent"><button type="button" class="row${u.active ? '' : ' inactive'}" popovertarget="member-${u.id}">
  ${avatar(u, 'xs')}
  <span class="row-body"><span class="row-title">${u.name}${u.active ? '' : ' (inactive)'}</span>
    <span class="row-sub"><span>${roleText(u)}</span>${u.can_review ? html`<span class="sep"></span><span>${u.sign_name ? `Signs as ${u.sign_name}, ${u.sign_credentials}` : 'No signing details yet'}</span>` : ''}</span></span>${chev()}
</button></li>`)}</ul>`)}`, {
    tab: 'admin', sheets: html`${addSheet}${users.map((u) => memberSheet(u, user))}`,
  });
}

export const accountPage = (user, message) =>
  layout('Account', user, html`
${largeHeader('Account')}
<div class="profile">
  ${avatar(user, 'lg', user.sign_photo ? 'Your photo, as the website shows it' : '')}
  <h1>${user.sign_name || user.name}</h1>
  <p>${user.sign_credentials ? html`${user.sign_credentials}<br>` : ''}${user.email}</p>
</div>
${message ? callout('ok', 'check', html`<p>${message}</p>`) : ''}
${user.can_review
    ? html`${user.sign_name && user.sign_photo ? '' : callout('warn', 'warn', html`<p><strong>You review articles, and the articles you approve carry your signature and photo.</strong></p><p>Add your signing details and photo to continue.</p>`)}
<form method="post" action="/account/signature" enctype="multipart/form-data" class="btn-stack">
  ${group('Signing details', html`<ul class="list form-list">
    ${field('Name as it appears on articles', html`<input name="sign_name" required minlength="2" maxlength="100" value="${user.sign_name ?? ''}" placeholder="Dr. Mehra">`)}
    ${field('Qualifications', html`<input name="sign_credentials" required minlength="2" maxlength="150" value="${user.sign_credentials ?? ''}" placeholder="MBBS, PGIMS Rohtak">`)}
    ${field(user.sign_photo ? 'New photo' : 'Photo', html`<input type="file" name="photo" accept="image/jpeg,image/png"${user.sign_photo ? '' : raw(' required')}>`, 'JPEG or PNG, at most 2 MB. Its location and camera details are removed.')}
  </ul>`, `Articles you approve show your photo with "Medically reviewed by: ${user.sign_name || 'Dr. Mehra'}, ${user.sign_credentials || 'MBBS, PGIMS Rohtak'}" and the date. Articles already approved keep the details they were signed with.`)}
  <button class="btn wide">Save signing details</button>
</form>`
    : ''}
<form method="post" action="/account" class="btn-stack">
  ${group('Change password', html`<ul class="list form-list">
    ${field('Current password', html`<input type="password" name="current" required maxlength="200" autocomplete="current-password">`)}
    ${field('New password', html`<input type="password" name="password" required minlength="12" maxlength="200" autocomplete="new-password">`, 'At least 12 characters.')}
    ${field('Repeat the new password', html`<input type="password" name="confirm" required minlength="12" maxlength="200" autocomplete="new-password">`)}
  </ul>`, 'Changing it logs you out on your other devices.')}
  <button class="btn secondary wide">Change password</button>
</form>
<form method="post" action="/logout"><button class="btn destructive secondary wide">${icon('logout')}<span>Log out</span></button></form>`, { tab: 'account' });

// ---------- admin: agent training ----------

const money = (usd) => (usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`);
const n = (value) => Number(value ?? 0).toLocaleString('en-US');

const entryFields = (kind, values = {}) => html`
  ${field('Title (optional)', html`<input name="title" maxlength="100" value="${values.title ?? ''}">`)}
  ${field('Text', html`<textarea name="text" rows="${kind === 'example' ? 8 : 5}" required maxlength="5000">${values.text ?? ''}</textarea>`)}
  ${kind === 'example'
    ? [['likes', 'Likes'], ['shares', 'Shares'], ['reach', 'Reach']].map(([name, text]) =>
      html`<li><label class="field-inline"><span>${text}</span><input type="number" name="${name}" min="0" max="1000000000000" step="1" inputmode="numeric" value="${values[name] ?? ''}" placeholder="0"></label></li>`)
    : ''}`;

function entryList(entries) {
  return entries.length
    ? html`<ul class="list">${entries.map((e) => html`<li><a class="row${e.active ? '' : ' inactive'}" href="/knowledge/${e.id}">
  <span class="row-body">
    <span class="row-title clamp">${e.title || clip(e.text, 90)}</span>
    <span class="row-sub">${statusPill(e.active ? 'active' : 'inactive')}<span>${platformName(e.platform)}</span><span class="sep"></span><span>v${e.version}</span>${e.kind === 'example' ? html`<span class="sep"></span><span>${n(e.reach)} reach, ${n(e.shares)} shares, ${n(e.likes)} likes</span>` : ''}</span>
    ${e.title ? html`<span class="row-sub clamp-2">${clip(e.text, 160)}</span>` : ''}
  </span>${chev()}
</a></li>`)}</ul>`
    : html`<ul class="list"><li class="empty">None yet.</li></ul>`;
}

export function trainingPage(user, { entries, usage, auditLog }) {
  const of = (kind) => entries.filter((e) => e.kind === kind);
  const addSheet = sheet('add-knowledge', 'Add a rule or example', html`<form method="post" action="/knowledge" class="btn-stack">
  <ul class="list form-list">
    <li class="select"><label class="field"><span class="field-label">Type</span><select name="kind">${Object.entries(KNOWLEDGE_KINDS).map(([kind, text]) => html`<option value="${kind}">${text}</option>`)}</select></label></li>
    <li class="select"><label class="field"><span class="field-label">Platform</span><select name="platform"><option value="all">All platforms (rules only)</option><option value="website">Website article (rules only: the article agent and the audit)</option>${SOCIAL.map((p) => html`<option value="${p}">${CHANNELS[p].label}</option>`)}</select></label></li>
    ${entryFields('example')}
  </ul>
  <p class="sheet-lede">Likes, shares and reach are only used for examples. The brand voice guide can be one brand rule titled "Voice guide".</p>
  <button class="btn wide">Add</button>
  ${closeButton('add-knowledge')}
</form>`);
  return layout('Agent training', user, html`
${topbar({ back: { href: '/admin', label: 'Admin' }, title: 'Training', trailing: sheetButton('add-knowledge', 'Add a rule or example', 'plus') })}
${largeHeader('Agent training', { lede: 'The writer and compliance agents read the current version of every active rule, and the best examples, on every run. Editing creates a new version; each post records exactly which versions it used.' })}
${group('Brand rules', entryList(of('brand_rule')))}
${group('Compliance rules', entryList(of('compliance_rule')))}
${group('Example posts', entryList(of('example')))}
${group('AI usage, last 7 days', usage.rows.length
    ? html`<ul class="list">${usage.rows.map((r) => html`<li class="row">
  <span class="row-body"><span class="row-title">${r.name}</span>
    <span class="row-sub"><span>${r.model}</span><span class="sep"></span><span>${plural(r.calls, 'call')}</span><span class="sep"></span><span>${(r.ms / 1000).toFixed(1)} s each</span></span>
    <span class="row-sub"><span>${n(r.input + r.cache_write)} tokens in</span><span class="sep"></span><span>${n(r.cache_read)} cached</span><span class="sep"></span><span>${n(r.output)} out</span>${r.searches ? html`<span class="sep"></span><span>${plural(r.searches, 'web search', 'web searches')}</span>` : ''}</span></span>
  <span class="row-value">${r.cost == null ? 'No price' : money(r.cost)}</span>
</li>`)}</ul>`
    : html`<ul class="list"><li class="empty">No AI calls in the last 7 days.</li></ul>`,
  usage.rows.length ? `${usage.perArticle == null ? '' : `Average cost per article: ${money(usage.perArticle)} over ${usage.articles} article${usage.articles === 1 ? '' : 's'}. `}${usage.seconds == null ? '' : `Average time from approval until all three posts were ready: ${Math.round(usage.seconds)} s. `}${usage.perDraft == null ? '' : `Article agent: ${money(usage.perDraft)} and ${Math.max(1, Math.round(usage.draftMinutes))} min per draft on average, over ${usage.drafts} draft${usage.drafts === 1 ? '' : 's'}. `}${usage.perCarousel == null ? '' : `Carousels: ${money(usage.perCarousel)} and ${Math.max(1, Math.round(usage.carouselMinutes))} min each on average (until first ready), over ${usage.carousels} carousel${usage.carousels === 1 ? '' : 's'}. `}Estimated at each model's list price.${usage.unpriced ? ' Calls served by a model with no listed price are left out of the total.' : ''}` : '')}
<p class="group-footer standalone">Models now: writers ${usage.models.writer}, article writer ${usage.models.article}, carousel writer ${usage.models.carousel}, trend scouts ${usage.models.scout}, compliance ${usage.models.compliance}, picture check ${usage.models.imageCheck}, coach ${usage.models.coach}, carousel and website pictures ${usage.models.picture}. Change them with the MODEL_WRITER, MODEL_ARTICLE_WRITER, MODEL_CAROUSEL_WRITER, MODEL_TREND_SCOUT, MODEL_COMPLIANCE, MODEL_IMAGE_CHECK, MODEL_COACH and GEMINI_IMAGE_MODEL settings.</p>
${disclosure(`Audit log (${auditLog.length})`, auditLog.length
    ? html`<ol class="timeline">${auditLog.map((a) => html`<li>${stamp(a.at)}${a.who ?? 'System'}: ${a.action.replaceAll('_', ' ')}${a.detail ? html`, ${a.detail}` : ''}</li>`)}</ol>`
    : html`<p class="lede">Nothing yet.</p>`, { lead: icon('history', { cls: 'icon muted-icon' }) })}`, {
    tab: 'admin', sheets: addSheet, pageClass: 'page wide',
  });
}

export function knowledgePage(user, entry, history) {
  const kind = KNOWLEDGE_KINDS[entry.kind];
  return layout(kind, user, html`
${topbar({ back: { href: '/training', label: 'Training' }, title: kind })}
<header class="article-head">
  <h1>${kind}${entry.title ? `: ${entry.title}` : ''}</h1>
  <div class="meta">${statusPill(entry.active ? 'active' : 'inactive')}<span>${platformName(entry.platform)}</span><span class="sep"></span><span>Version ${entry.version}</span></div>
</header>
<form method="post" action="/knowledge/${entry.id}">
  <ul class="list">
    <li>${entry.active
    ? html`<button class="row action" name="action" value="deactivate"><span class="row-body"><span class="row-title">Deactivate</span><span class="row-sub">The agents stop using it straight away</span></span></button>`
    : html`<button class="row action" name="action" value="activate"><span class="row-body"><span class="row-title">Reactivate</span><span class="row-sub">The agents use it again from their next run</span></span></button>`}</li>
    <li><a class="row destructive" href="/knowledge/${entry.id}/delete">Delete…</a></li>
  </ul>
</form>
<form method="post" action="/knowledge/${entry.id}" class="btn-stack">
  <input type="hidden" name="action" value="edit">
  ${group(`Edit (creates v${entry.version + 1})`, html`<ul class="list form-list">
    ${entryFields(entry.kind, entry)}
    ${field('What changed (optional)', html`<input name="note" maxlength="200">`)}
  </ul>`)}
  <button class="btn wide">Save as v${entry.version + 1}</button>
</form>
${group('History', html`<ul class="list">${history.map((v) => html`<li><div class="row version">
  <span class="row-body">
    <span class="row-title">v${v.version} ${v.id === entry.version_id ? statusPill('active') : ''}</span>
    <span class="row-sub"><span>${stamp(v.created_at)} by ${v.author ?? 'System'}${v.note ? `, ${v.note}` : ''}${v.suggestion_id ? `, from suggestion #${v.suggestion_id}` : ''}</span></span>
    <span class="pre version-text">${v.title ? `${v.title}: ` : ''}${v.text}</span>
    ${v.posts.length
      ? html`<details class="inline-details"><summary>Used by ${v.used_by} post${v.used_by === 1 ? '' : 's'}</summary><ul>${v.posts.map((p) => html`<li><a href="/articles/${p.article_id}">${p.title}</a> (${CHANNELS[p.channel].label})</li>`)}</ul></details>`
      : html`<span class="row-sub">Not used by any post yet.</span>`}
    ${v.id === entry.version_id
      ? ''
      : html`<form method="post" action="/knowledge/${entry.id}"><input type="hidden" name="version_id" value="${v.id}"><button class="btn secondary small" name="action" value="rollback">Roll back to v${v.version}</button></form>`}
  </span>
</div></li>`)}</ul>`)}`, { tab: 'admin' });
}

// ---------- article agent drafts ----------

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

export function draftPage(user, { draft: d, own }) {
  const running = d.status === 'running';
  const editable = own && ['ready', 'needs_attention'].includes(d.status);
  const lastLines = (d.log ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3);
  const checks = d.checks.length
    ? group('Checks', html`<ul class="list checks">${d.checks.map((c) => html`<li class="${c.ok ? 'pass' : 'fail'}">${icon(c.ok ? 'check' : 'cross', { width: 2.2 })}<span><span class="visually-hidden">${c.ok ? 'Passed: ' : 'Failed: '}</span>${c.label}: ${c.detail}</span></li>`)}</ul>`)
    : '';
  const evidence = d.evidence.length
    ? disclosure(`Claims and the passages they cite (${d.evidence.length})`, html`<div class="evidence">${d.evidence.map((e) => html`<article>
  <p><strong>${e.claim}</strong></p>
  ${e.quotes.map((q) => {
      const ref = d.refs.find((r) => r.n === q.n);
      return html`<p class="quote"><a href="${ref?.url ?? '#'}" target="_blank" rel="noopener noreferrer">[${q.n}] ${hostOf(ref?.url)}</a> ${q.text}</p>`;
    })}
</article>`)}</div>`, { open: editable, lead: icon('book', { cls: 'icon muted-icon' }) })
    : '';
  const inputs = d.inputs.length
    ? disclosure(`What the agent used (${d.inputs.length})`, html`<ul class="inputs">${d.inputs.map((i) => html`<li>${inputLine({ kind: i.kind, ref_id: i.ref, label: i.label }, user)}</li>`)}</ul>`, { lead: icon('link', { cls: 'icon muted-icon' }) })
    : '';
  const log = disclosure('Progress log', html`<p class="pre log">${d.log}</p>`, { open: running, lead: icon('clock', { cls: 'icon muted-icon' }) });
  const toolbar = editable
    ? html`<div class="segmented" role="radiogroup" aria-label="View">
    <input type="radio" name="view" id="view-read" checked><label for="view-read">Read</label>
    <input type="radio" name="view" id="view-edit"><label for="view-edit">Edit</label>
  </div>
  <button class="btn" form="draft-form">${icon('send')}<span>Submit</span></button>
  <button type="button" class="icon-btn glass" popovertarget="draft-more" aria-label="More actions">${icon('more')}</button>`
    : null;
  const more = editable
    ? sheet('draft-more', 'This draft', html`<form method="post" action="/drafts/${d.id}" class="actions-list">
  <button class="btn destructive secondary wide" name="action" value="discard">${icon('trash')}<span>Discard this draft</span></button>
  ${closeButton('draft-more')}
</form>`)
    : '';
  return layout(`AI draft: ${d.topic}`, user, html`
${topbar({ back: { href: own ? '/write' : '/', label: own ? 'Write' : 'Home' }, title: 'AI draft' })}
${running
    ? html`<section class="wait">
  ${orb('searching', 128, 'The article agent is researching and writing')}
  <h2>Researching and writing</h2>
  <p>${d.topic}</p>
  <p>About 5–10 minutes. You can close this page; the draft waits for you.</p>
</section>
${lastLines.length ? group('Latest', html`<ul class="list">${lastLines.map((line) => html`<li class="empty log-line">${line}</li>`)}</ul>`) : ''}`
    : html`<header class="article-head">
  <h1>${d.title || d.topic}</h1>
  <div class="meta">${draftPill(d.status)}<span>Started by ${d.author}</span><span class="sep"></span>${stamp(d.created_at)}</div>
  ${d.finished_at ? html`<div class="meta"><span>Took ${Math.max(1, Math.round(d.seconds / 60))} min</span>${d.cost == null ? '' : html`<span class="sep"></span><span>AI cost ${money(d.cost)}</span>`}<span class="sep"></span><span>${d.searches} searches, ${d.fetches} pages opened</span></div>` : ''}
</header>`}
${d.brief ? disclosure('Brief', html`<p class="pre">${d.brief}</p>`, { lead: icon('doc', { cls: 'icon muted-icon' }) }) : ''}
${d.error ? callout('error', 'warn', html`<p class="pre">${d.error}</p>${d.status === 'failed' && own ? html`<form method="post" action="/drafts/${d.id}"><button class="btn small" name="action" value="retry">Try again</button></form>` : ''}`) : ''}
${!d.error && d.status === 'failed' && own ? html`<form method="post" action="/drafts/${d.id}"><button class="btn wide" name="action" value="retry">Try again</button></form>` : ''}
${d.status === 'submitted' && d.article_id ? callout('ok', 'check', html`<p>Submitted as <a href="/articles/${d.article_id}">this article</a>.</p>`) : ''}
${d.notes ? callout(d.status === 'ready' ? 'ok' : 'warn', d.status === 'ready' ? 'check' : 'warn', html`<p class="pre">${d.notes}</p>`) : ''}
${checks}
${editable
    ? html`<div class="view-read"><div class="prose">${raw(textToHtml(d.body))}</div></div>
<form id="draft-form" method="post" action="/articles" class="editor view-edit">
  <input type="hidden" name="draft_id" value="${d.id}">
  <label class="visually-hidden" for="draft-title">Title</label>
  <input class="title-input" id="draft-title" name="title" value="${d.title}" required maxlength="200">
  <label class="visually-hidden" for="draft-body">Article</label>
  <textarea class="body-input" id="draft-body" name="body" required maxlength="100000">${d.body}</textarea>
  <p class="hint">Check each claim against the passage it cites, edit what you need, then submit. The article then goes to the admin like any other.</p>
</form>`
    : !running && d.body ? html`<div class="prose">${raw(textToHtml(d.body))}</div>` : ''}
${evidence}
${inputs}
${log}`, { refresh: running ? 10 : null, tab: own ? 'write' : 'home', toolbar, sheets: more, bodyClass: running ? '' : 'reading' });
}

// ---------- Instagram carousels ----------

function slideCard(c, s, i, { edit, pictures }) {
  const num = i + 1;
  return html`<div class="slide">
  ${s.picture
    ? html`<img src="/carousels/${c.id}/pictures/${s.picture}" alt="Picture for slide ${num}">`
    : html`<div class="blank">${pictures ? 'No picture yet' : 'Colour background'}</div>`}
  <div class="slide-body">
    <p class="slide-title"><strong>Slide ${num}</strong> ${s.check ? (s.check.ok ? pill('Picture check passed', 'green') : pill('Picture flagged', 'red')) : ''}${s.check?.tries > 1
      ? html` <span class="lede">after ${s.check.tries} tries</span>`
      : ''}</p>
    ${s.check && !s.check.ok ? html`<ul>${s.check.notes.map((note) => html`<li>${note}</li>`)}</ul>` : ''}
    ${edit
      ? html`<label class="field"><span class="field-label">Heading</span><input name="heading_${i}" value="${s.heading}" maxlength="60" required></label>
    <label class="field"><span class="field-label">Text</span><textarea name="body_${i}" rows="3" maxlength="180">${s.body}</textarea></label>
    <label class="field"><span class="field-label">Picture brief</span><textarea name="brief_${i}" rows="2" maxlength="300">${s.brief}</textarea></label>
    ${pictures && c.status === 'ready' ? html`<div class="btn-row"><button class="btn secondary small" name="action" value="picture_${i}">${icon('refresh')}<span>New picture</span></button></div>` : ''}`
      : html`<p class="post-text"><strong>${s.heading}</strong>${s.body ? html`<br>${s.body}` : ''}</p>
    <p class="lede">Picture brief: ${s.brief}</p>`}
  </div>
</div>`;
}

export function carouselPage(user, { carousel: c, article: a, editable, glass, pictures }) {
  const working = c.status === 'working';
  const ready = c.status === 'ready';
  const edit = editable && ['ready', 'needs_attention'].includes(c.status);
  const finalFlagged = c.final_check.filter((r) => !r.ok).length;
  const toolbar = edit && c.slides.length
    ? html`<button class="btn" form="slides-form" name="action" value="save">${icon('check', { width: 2.2 })}<span>Save and check</span></button>`
    : null;
  return layout(`Carousel: ${a.title}`, user, html`
${topbar({ back: { href: `/items/${c.item_id}`, label: 'Instagram' }, title: 'Carousel' })}
<header class="article-head">
  <h1>Instagram carousel</h1>
  <div class="meta">${carouselPill(c.status)}${c.slides.length ? html`<span>${c.slides.length} slides</span>` : ''}</div>
  <div class="meta"><span>Started by ${c.author}</span><span class="sep"></span>${stamp(c.started_at)}${c.finished_at
    ? html`<span class="sep"></span><span>First ready after ${Math.max(1, Math.round(c.seconds / 60))} min</span>`
    : ''}${c.cost == null ? '' : html`<span class="sep"></span><span>AI cost ${money(c.cost)}</span>`}</div>
  <div class="meta"><a href="/articles/${a.id}">${a.title}</a></div>
</header>
${working ? html`<section class="wait">${orb('weaving', 128, 'The carousel is being made')}<h2>Making the carousel</h2><p>${CAROUSEL_JOB[c.job]}. This page refreshes by itself.</p></section>` : ''}
${c.error ? callout('error', 'warn', html`<p class="pre">${c.error}</p>`) : ''}
${c.status === 'failed' && editable ? html`<form method="post" action="/carousels/${c.id}"><button class="btn wide" name="action" value="retry">Try again</button></form>` : ''}
${c.notes ? callout(c.compliance_ok ? 'ok' : 'warn', c.compliance_ok ? 'check' : 'warn', html`<p class="pre">${c.notes}</p>`) : ''}
${pictures ? '' : callout('info', 'info', html`<p>Pictures are off because GEMINI_API_KEY is not set: the deck uses colour backgrounds, and nothing is spent on pictures.</p>`)}
<section class="group">
  <h2 class="group-header big">1. Slides</h2>
  ${!c.slides.length
    ? html`<ul class="list"><li class="empty">${working ? 'The slides appear here once they are written.' : 'No slides.'}</li></ul>`
    : edit
      ? html`<form id="slides-form" method="post" action="/carousels/${c.id}">
  <div class="slides">${c.slides.map((s, i) => slideCard(c, s, i, { edit, pictures }))}</div>
</form>
<p class="group-footer">Changed wording goes back to the compliance agent when you save. New picture uses the slide's picture brief.</p>`
      : html`<div class="slides">${c.slides.map((s, i) => slideCard(c, s, i, { edit: false, pictures }))}</div>`}
</section>
<section class="group">
  <h2 class="group-header big">2. Design the slides in Glass Slides</h2>
  ${ready
    ? html`<div class="btn-stack">
  ${glass ? html`<form method="post" action="/carousels/${c.id}/link" target="_blank"><button class="btn wide">Open in Glass Slides</button></form>` : ''}
  <a class="btn${glass ? ' secondary' : ''} wide" href="/carousels/${c.id}/deck.json">Download the deck file</a>
</div>
<p class="group-footer">Each slide has the picture, a frosted panel with the heading and text, and a slide counter, as separate layers you can move and restyle. When the slides look right, choose Export, then Export all, with the format JPEG at 1× (1080×1350). ${glass
      ? 'The Open link works for 30 minutes.'
      : 'In Glass Slides, open the deck file with File, then Open.'}</p>`
    : html`<p class="group-footer">Available once the slide text has passed the compliance check${pictures ? ' and the pictures are made' : ''}.</p>`}
</section>
<section class="group">
  <h2 class="group-header big">3. Upload the finished slides</h2>
  ${ready && editable
    ? html`<form method="post" action="/carousels/${c.id}/slides" enctype="multipart/form-data" class="btn-stack">
  <ul class="list form-list">${field('Finished slides', html`<input type="file" name="slides" accept=".zip,image/jpeg" multiple required>`, `The .zip that Export all saves, or the ${c.slides.length} JPEGs: 4:5 (1080×1350), up to 5 MB each.`)}</ul>
  <button class="btn secondary wide">${icon('upload')}<span>Upload</span></button>
</form>`
    : ''}
  ${c.finals.length
    ? html`<div class="finals">${c.finals.map((name, i) => {
      const result = c.final_check[i];
      return html`<figure><img src="/media/${name}" alt="Finished slide ${i + 1}"><figcaption>${result
        ? result.ok ? html`<span class="pass">Wording matches</span>` : html`<span class="fail">${result.note}</span>`
        : working ? 'Checking…' : ''}</figcaption></figure>`;
    })}</div>
${ready && c.final_check.length
      ? finalFlagged
        ? callout('warn', 'warn', html`<p>The final text check flagged ${plural(finalFlagged, 'slide')}: compare ${finalFlagged === 1 ? 'it' : 'them'} with the approved text above before you tick the checklist.</p>`)
        : callout('ok', 'check', html`<p>The final text check found that every slide matches the approved text.</p>`)
      : ''}`
    : html`<p class="group-footer">No finished slides yet.</p>`}
</section>
<section class="group">
  <h2 class="group-header big">4. Tick the checklist and mark the post ready</h2>
  <ul class="list"><li><a class="row" href="/items/${c.item_id}"><span class="row-body"><span class="row-title">Open the Instagram post</span><span class="row-sub">It shows the finished slides and the image checklist. Nothing is published until someone taps Publish.</span></span>${chev()}</a></li></ul>
</section>
${editable && !working
    ? disclosure('Start over, or turn the carousel off', html`<form method="post" action="/carousels/${c.id}" class="actions-list">
  <button class="btn secondary wide" name="action" value="restart">${icon('refresh')}<span>Start over with new slides</span></button>
  <button class="btn destructive secondary wide" name="action" value="discard">Turn the carousel off (back to a single image)</button>
</form>`, { lead: icon('refresh', { cls: 'icon muted-icon' }) })
    : ''}
${disclosure('Progress log', html`<p class="pre log">${c.log}</p>`, { open: working, lead: icon('clock', { cls: 'icon muted-icon' }) })}`, {
    refresh: working ? 10 : null, tab: 'home', toolbar,
  });
}

// ---------- admin: web sources ----------

function sourceSheet(s) {
  return sheet(`source-${s.id}`, hostOf(s.url) || 'Source', html`<p class="sheet-lede">${s.url}</p>
  <form method="post" action="/sources/${s.id}" class="actions-list">
    <a class="btn secondary wide" href="${s.url}" target="_blank" rel="noopener noreferrer">${icon('external')}<span>Open the page</span></a>
    ${s.kind === 'compliance' && s.active ? html`<button class="btn secondary wide" name="action" value="check">${icon('refresh')}<span>Check now</span></button>` : ''}
    <button class="btn secondary wide" name="action" value="${s.active ? 'deactivate' : 'activate'}">${s.active ? 'Deactivate' : 'Activate'}</button>
    <a class="btn destructive secondary wide" href="/sources/${s.id}/delete">Delete…</a>
    ${closeButton(`source-${s.id}`)}
  </form>`);
}

function sourceRow(s) {
  let path = s.url;
  try {
    const url = new URL(s.url);
    path = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {}
  return html`<li><button type="button" class="row${s.active ? '' : ' inactive'}" popovertarget="source-${s.id}">
  <span class="row-body">
    <span class="row-title clamp">${clip(path, 90)}</span>
    <span class="row-sub">${statusPill(s.active ? 'active' : 'inactive')}${s.pending ? statusPill('pending') : ''}${s.kind === 'compliance'
      ? html`<span>${s.approved_at ? html`Approved version ${stamp(s.approved_at)}` : 'No approved version yet'}</span>`
      : ''}${s.last_checked_at ? html`<span class="sep"></span><span>Checked ${when(s.last_checked_at)}</span>` : ''}</span>
    ${s.last_error ? html`<span class="row-sub error-text">${s.last_error}</span>` : ''}
  </span>${icon('more', { cls: 'row-chevron more-dots' })}
</button></li>`;
}

export function sourcesPage(user, { sources, pending }) {
  const addSheet = sheet('add-source', 'Add a source', html`<form method="post" action="/sources" class="btn-stack">
  <ul class="list form-list">${field('Link', html`<input type="url" name="url" required maxlength="500" placeholder="https://" autocapitalize="none" spellcheck="false">`)}</ul>
  <fieldset class="group"><legend>Type</legend><ul class="list">
    <li><label class="choice"><input type="radio" name="kind" value="compliance" checked><span>Compliance page<span class="sub">Checked daily; you approve each version</span></span></label></li>
    <li><label class="choice"><input type="radio" name="kind" value="trends"><span>Trends source<span class="sub">A domain the AI may search for trending keywords</span></span></label></li>
    <li><label class="choice"><input type="radio" name="kind" value="research"><span>Research site<span class="sub">A medical site the article agent may search and cite</span></span></label></li>
  </ul></fieldset>
  <button class="btn wide">Add source</button>
  ${closeButton('add-source')}
</form>`, { lede: 'Only https links. Each domain you add becomes part of the allowlist.' });
  const byKind = ['compliance', 'research', 'trends'].map((kind) => [kind, sources.filter((s) => s.kind === kind)]).filter(([, list]) => list.length);
  return layout('Sources', user, html`
${topbar({ back: { href: '/admin', label: 'Admin' }, title: 'Sources', trailing: sheetButton('add-source', 'Add a source', 'plus') })}
${largeHeader('Sources')}
${disclosure('How sources work', html`<p><strong>Compliance</strong> pages (regulator guidance, platform health-content policies) are checked daily. A changed page waits here until you approve it; until then the compliance agent keeps using the last approved version.</p>
<p><strong>Trends</strong> links set the only domains the AI may search or open for trending keywords.</p>
<p><strong>Research</strong> sites are the only medical sites the article agent may search and cite: a site covers its subdomains, so https://nih.gov allows every *.nih.gov site, while https://www.nhs.uk allows only www.nhs.uk.</p>`, { lead: icon('info', { cls: 'icon muted-icon' }) })}
${pending.length
    ? html`<section class="group"><h2 class="group-header big">Waiting for approval (${pending.length})</h2><div class="btn-stack">${pending.map((s) => html`
<div class="card">
  <p class="row-title">${s.url}</p>
  <p class="lede">Fetched ${stamp(s.fetched_at)}</p>
  ${s.approved_text == null
      ? html`<p class="lede">First version of this page. Read it before approving:</p><p class="snapshot">${clip(s.text, 5000)}</p>`
      : html`<p class="lede">Changes since the approved version (green added, red removed):</p>${renderDiff(compactDiff(lineDiff(s.approved_text, s.text)))}`}
  <form method="post" action="/snapshots/${s.id}" class="btn-row">
    <button class="btn" name="action" value="approve">Approve this version</button>
    <button class="btn secondary" name="action" value="reject">Reject</button>
  </form>
</div>`)}</div></section>`
    : ''}
${byKind.length
    ? byKind.map(([kind, list]) => group(SOURCE_GROUPS[kind], html`<ul class="list">${list.map(sourceRow)}</ul>`))
    : html`<ul class="list"><li class="empty">No sources yet. Tap + to add one.</li></ul>`}`, {
    tab: 'admin', sheets: html`${addSheet}${sources.map(sourceSheet)}`,
  });
}

// ---------- admin: deleting, after typing "delete" ----------

function deletePage(user, { title, what, facts, used, usedText, action, back }) {
  return layout(title, user, html`
${topbar({ back: { href: back, label: 'Back' }, title: 'Delete' })}
<header class="article-head"><h1>${title}</h1></header>
<ul class="list">${facts.map((fact) => html`<li class="empty fact">${fact}</li>`)}</ul>
${used
    ? callout('warn', 'warn', html`<p>${usedText} It can't be deleted, so it stays in their record.</p><p>Deactivate it instead: the agents stop using it straight away.</p>`)
    : html`<div class="callout error">${icon('trash')}<div><p><strong>This permanently deletes ${what}. It can't be undone.</strong></p><p>The agents stop using it straight away, and the audit log keeps a note of what was deleted.</p></div></div>
<form method="post" action="${action}" class="btn-stack">
  <ul class="list form-list"><li><label class="field"><span class="field-label">Type <strong>delete</strong> to confirm</span><input name="confirm" required pattern="delete" autocomplete="off" autocapitalize="none" spellcheck="false"></label></li></ul>
  <button class="btn destructive wide">Delete permanently</button>
</form>`}`, { tab: 'admin' });
}

export const deleteKnowledgePage = (user, { entry, versions, used }) =>
  deletePage(user, {
    title: `Delete this ${KNOWLEDGE_KINDS[entry.kind].toLowerCase()}?`,
    what: `this ${KNOWLEDGE_KINDS[entry.kind].toLowerCase()} and ${versions === 1 ? 'its version' : `all ${versions} of its versions`}`,
    facts: [`${KNOWLEDGE_KINDS[entry.kind]}${entry.title ? `: ${entry.title}` : ''}`, `${platformName(entry.platform)} · ${entry.active ? 'active' : 'inactive'} · v${entry.version}`, clip(entry.text, 300)],
    used,
    usedText: `${used} post${used === 1 ? '' : 's'}, draft${used === 1 ? '' : 's'} or suggestion${used === 1 ? '' : 's'} used this ${KNOWLEDGE_KINDS[entry.kind].toLowerCase()}.`,
    action: `/knowledge/${entry.id}/delete`,
    back: `/knowledge/${entry.id}`,
  });

export const deleteSourcePage = (user, { source, snapshots, used }) =>
  deletePage(user, {
    title: 'Delete this source?',
    what: `this source${snapshots ? ` and its ${snapshots} saved page version${snapshots === 1 ? '' : 's'}` : ''}`,
    facts: [source.url, `${SOURCE_KINDS[source.kind] ?? source.kind} · ${source.active ? 'active' : 'inactive'}`],
    used,
    usedText: `${used} post${used === 1 ? '' : 's'}, draft${used === 1 ? '' : 's'} or suggestion${used === 1 ? '' : 's'} used a saved version of this page.`,
    action: `/sources/${source.id}/delete`,
    back: '/sources',
  });

// ---------- admin: weekly suggestions ----------

function suggestionCard(s, posts) {
  const evidence = JSON.parse(s.evidence ?? '[]');
  const linked = JSON.parse(s.item_ids ?? '[]').map((id) => posts.get(id)).filter(Boolean);
  const kindText = s.kind === 'reminder' ? 'Reminder' : `New ${KNOWLEDGE_KINDS[s.kind].toLowerCase()}`;
  return html`<div class="card suggestion">
  <div class="meta"><span class="badge indigo">${kindText}</span>${s.kind === 'reminder' ? '' : html`<span>${platformName(s.platform)}</span>`}<span class="sep"></span><span>#${s.id}</span></div>
  ${s.summary ? html`<p>${s.summary}</p>` : ''}
  ${evidence.map((quote) => html`<blockquote class="evidence-quote">${quote}</blockquote>`)}
  ${linked.length ? html`<p class="lede">Based on: ${linked.map((p, i) => html`${i ? ', ' : ''}<a href="/items/${p.id}">${CHANNELS[p.channel].label} post #${p.id}</a>`)}</p>` : ''}
  <p class="post-text proposed">${s.text}</p>
  ${s.kind === 'reminder'
    ? html`<form method="post" action="/suggestions/${s.id}" class="btn-row"><a class="btn secondary small" href="/sources">Open Sources</a>
      <button class="btn secondary small" name="action" value="dismiss">Dismiss</button></form>`
    : html`<form method="post" action="/suggestions/${s.id}" class="btn-row">
      <button class="btn small" name="action" value="accept">Accept</button>
      <button class="btn secondary small" name="action" value="reject">Reject</button>
    </form>
    <details class="inline-details"><summary>Edit before accepting</summary>
      <form method="post" action="/suggestions/${s.id}" class="btn-stack">
        <ul class="list form-list">${field('Edited text', html`<textarea name="text" rows="5" required maxlength="5000">${s.text}</textarea>`)}</ul>
        <button class="btn small" name="action" value="edit">Accept with my edits</button>
      </form>
    </details>`}
</div>`;
}

export function suggestionsPage(user, { pending, decided, posts, digests, running }) {
  return layout('Suggestions', user, html`
${topbar({ back: { href: '/admin', label: 'Admin' }, title: 'Suggestions' })}
${largeHeader('Suggestions', { lede: 'Once a week the coach reviews how reviewers changed the AI\'s drafts, which posts performed best and which struggled with compliance, then proposes rules and examples. Only what you accept or edit becomes a new version.' })}
${running
    ? html`<div class="callout ai">${orb('connecting', 20, 'The coach is working')}<div><p><strong>The coach is working on a digest.</strong></p><p>This page refreshes by itself.</p></div></div>`
    : html`<form method="post" action="/suggestions"><button class="btn secondary wide">${icon('sparkle')}<span>Generate now</span></button></form>`}
<section class="group">
  <h2 class="group-header big">Waiting for a decision (${pending.length})</h2>
  ${pending.length ? html`<div class="btn-stack">${pending.map((s) => suggestionCard(s, posts))}</div>` : html`<ul class="list"><li class="empty">Nothing to decide.</li></ul>`}
</section>
${disclosure(`Weekly digests (${digests.length})`, digests.length
    ? html`<ol class="timeline">${digests.map((d) => html`<li>${stamp(d.created_at)}${statusPill(d.status)} ${d.note ?? ''}</li>`)}</ol>`
    : html`<p class="lede">No digest yet. The first one runs automatically within a day of starting the app.</p>`, { lead: icon('history', { cls: 'icon muted-icon' }) })}
${group('Decided', decided.length
    ? html`<ul class="list">${decided.map((s) => html`<li><div class="row">
  <span class="row-body">
    <span class="row-sub">${statusPill(s.status)}<span>${s.kind === 'reminder' ? 'Reminder' : KNOWLEDGE_KINDS[s.kind]}</span><span class="sep"></span>${stamp(s.decided_at)}<span class="sep"></span><span>${s.decided_by_name ?? '-'}</span></span>
    <span class="row-title clamp">${clip(s.final_text ?? s.text, 160)}</span>
  </span>
  ${s.knowledge_id ? html`<a class="btn plain small" href="/knowledge/${s.knowledge_id}">View</a>` : ''}
</div></li>`)}</ul>`
    : html`<ul class="list"><li class="empty">Nothing decided yet.</li></ul>`)}`, { refresh: running ? 5 : null, tab: 'admin' });
}
