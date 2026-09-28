import { createHmac, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DISCLAIMER, esc, noEmDashes, slugify, textToHtml } from './text.js';

// Trial mode: channels listed here record a simulated publish instead of calling the platform.
const DRY_RUN = new Set(
  (process.env.DRY_RUN_CHANNELS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);
export const isDryRun = (channel) => DRY_RUN.has('all') || DRY_RUN.has(channel);

const PUBLISHERS = { website: publishWebsite, instagram: publishInstagram, linkedin: publishLinkedIn, x: publishX };

// Returns { url, simulated }. Throws an Error with a message that is safe to show to staff.
export async function publishItem(item, article, baseUrl) {
  if (isDryRun(item.channel)) return { url: null, simulated: true };
  const url = await PUBLISHERS[item.channel](item, article, baseUrl);
  return { url: /^https?:\/\//i.test(url ?? '') ? url : null, simulated: false };
}

function env(...names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Not configured: set ${missing.join(', ')} (or list this channel in DRY_RUN_CHANNELS for a trial).`);
  }
  return names.map((name) => process.env[name]);
}

async function call(label, url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new Error(`${label}: could not reach the service (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`);
  }
  const body = await res.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    data = { raw: body };
  }
  if (!res.ok) {
    const detail = data.error?.message ?? data.message ?? data.detail ?? data.errors?.[0]?.message ?? data.raw?.slice(0, 200);
    throw new Error(`${label} rejected the request (HTTP ${res.status})${detail ? `: ${detail}` : '.'}`.slice(0, 500));
  }
  return { res, data };
}

// Website: signed webhook. The receiver verifies the signature, upserts by `id`, and replies {"url": "..."}.
export const webhookSignature = (secret, timestamp, body) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

// "28 September 2026", in India's time zone.
const longDate = (sqlTime) =>
  new Date(`${sqlTime.replace(' ', 'T')}Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

// Who wrote the article and which doctor signed it off, from the approval record. Never AI-written.
export const byline = (article) => ({
  author: article.author,
  reviewer: article.signature ?? null,
  reviewed: article.signed_at ? longDate(article.signed_at) : null,
});

// The article page's HTML: byline, the article (its pictures in place of the picture blocks), then the disclaimer.
export function websiteHtml(article, figures = []) {
  const by = byline(article);
  const lines = [`Written by: ${by.author}`, ...(by.reviewer ? [`Medically reviewed by: ${by.reviewer}`, `Last reviewed: ${by.reviewed}`] : [])];
  return [
    `<p class="byline">${lines.map(esc).join('<br>')}</p>`,
    textToHtml(noEmDashes(article.body), { pictures: new Map(figures.map((f) => [f.n, f])) }),
    `<p class="disclaimer">${esc(DISCLAIMER)}</p>`,
  ].join('\n');
}

async function publishWebsite(item, article) {
  const [url, secret] = env('WEBSITE_WEBHOOK_URL', 'WEBSITE_WEBHOOK_SECRET');
  const figures = item.figures ?? [];
  const body = JSON.stringify({
    id: article.id,
    title: noEmDashes(article.title),
    slug: slugify(article.title, article.id),
    html: websiteHtml(article, figures),
    byline: byline(article),
    pictures: figures,
    published_at: new Date().toISOString(),
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { data } = await call('Website', url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': `sha256=${webhookSignature(secret, timestamp, body)}`,
    },
    body,
  });
  return data.url;
}

// Instagram Graph API: create a media container from public image URLs (for a carousel, one container per slide, then
// a CAROUSEL container with them as children), wait until processed, publish it. `item.slides`: carousel JPEGs, in order.
async function publishInstagram(item, _article, baseUrl) {
  const [api, igUser, token] = env('IG_API_BASE', 'IG_USER_ID', 'IG_ACCESS_TOKEN');
  const slides = item.slides ?? [];
  if (!slides.length && !item.image) throw new Error('Instagram needs an image. Upload a JPEG first.');
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, 'content-type': 'application/json' };
  const create = async (fields) => (await call('Instagram', `${api}/${igUser}/media`, { method: 'POST', headers: json, body: JSON.stringify(fields) })).data;
  const imageUrl = (name) => new URL(`/media/${name}`, baseUrl).href;
  let container;
  if (slides.length) {
    const children = [];
    for (const name of slides) children.push((await create({ image_url: imageUrl(name), is_carousel_item: true })).id);
    container = await create({ media_type: 'CAROUSEL', children: children.join(','), caption: item.body });
  } else {
    container = await create({ image_url: imageUrl(item.image), caption: item.body });
  }
  for (let attempt = 0; ; attempt++) {
    const { data } = await call('Instagram', `${api}/${container.id}?fields=status_code`, { headers: auth });
    if (data.status_code === 'FINISHED') break;
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED' || attempt >= 10) {
      throw new Error(
        `Instagram could not process the image (${data.status_code ?? 'timed out'}). Use a JPEG with an aspect ratio between 4:5 and 1.91:1.`,
      );
    }
    await sleep(3000);
  }
  const { data: media } = await call('Instagram', `${api}/${igUser}/media_publish`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ creation_id: container.id }),
  });
  // The post is live at this point; a missing permalink only costs us the link.
  const permalink = await call('Instagram', `${api}/${media.id}?fields=permalink`, { headers: auth })
    .then(({ data }) => data.permalink)
    .catch(() => null);
  return permalink;
}

// LinkedIn "little text": reserved characters must be escaped or the post is silently cut at that point.
export function toLittleText(text) {
  const escape = (s) => s.replace(/[\\|{}@[\]()<>#*_~]/g, '\\$&');
  return text
    .split(/(#[\p{L}\p{N}_]+)/u)
    .map((part, i) => (i % 2 ? `{hashtag|\\#|${escape(part.slice(1))}}` : escape(part)))
    .join('');
}

async function publishLinkedIn(item) {
  const [token, author, version] = env('LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_AUTHOR_URN', 'LINKEDIN_VERSION');
  const { res } = await call('LinkedIn', 'https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'linkedin-version': version,
      'x-restli-protocol-version': '2.0.0',
    },
    body: JSON.stringify({
      author,
      commentary: toLittleText(item.body),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  const urn = res.headers.get('x-restli-id');
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}

// X API v2 with OAuth 1.0a user context (keys from the developer portal; they do not expire).
const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function oauth1Header(method, url, params, keys, nonce = randomBytes(16).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000))) {
  const oauth = {
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: keys.token,
    oauth_version: '1.0',
  };
  const signed = Object.entries({ ...params, ...oauth })
    .map(([k, v]) => [pct(k), pct(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [method.toUpperCase(), pct(url), pct(signed)].join('&');
  oauth.oauth_signature = createHmac('sha1', `${pct(keys.consumerSecret)}&${pct(keys.tokenSecret)}`).update(base).digest('base64');
  return `OAuth ${Object.entries(oauth).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ')}`;
}

async function publishX(item) {
  const [consumerKey, consumerSecret, token, tokenSecret] = env('X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET');
  const url = 'https://api.x.com/2/tweets';
  const { data } = await call('X', url, {
    method: 'POST',
    headers: {
      authorization: oauth1Header('POST', url, {}, { consumerKey, consumerSecret, token, tokenSecret }),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text: item.body }),
  });
  return data.data?.id ? `https://x.com/i/web/status/${data.data.id}` : null;
}
