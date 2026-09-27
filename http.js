// Request/response helpers shared by server.js and admin.js.
import { Readable } from 'node:stream';

export const BASE = new URL(process.env.PUBLIC_BASE_URL || 'http://localhost:3000');
export const SECURE = BASE.protocol === 'https:';

// The Glass Slides editor (optional). Its origin may read a carousel deck through a link token, and the
// "Open in Glass Slides" button redirects there.
export const GLASS = (() => {
  if (!process.env.GLASS_SLIDES_URL) return null;
  const url = new URL(process.env.GLASS_SLIDES_URL);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('GLASS_SLIDES_URL must be an https:// address.');
  return url;
})();
const FORM_LIMIT = 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (status, message) => {
  throw new HttpError(status, message);
};

// Browsers always send Origin (or at least Sec-Fetch-Site) on form posts; anything else is cross-site.
export const sameOrigin = (req) =>
  req.headers.origin ? req.headers.origin === BASE.origin : req.headers['sec-fetch-site'] === 'same-origin';

export async function readForm(req, limit = FORM_LIMIT) {
  const length = Number(req.headers['content-length']);
  if (!req.headers['content-length'] || !Number.isSafeInteger(length)) fail(411, 'The request had no length.');
  if (length > limit) fail(413, 'That is too large to upload.');
  try {
    return await new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      body: Readable.toWeb(req),
      duplex: 'half',
    }).formData();
  } catch {
    fail(400, 'The form could not be read.');
  }
}

export function field(form, name, label, max, required = true) {
  const value = String(form.get(name) ?? '').replace(/\r\n?/g, '\n').trim();
  if (required && !value) fail(400, `${label} is required.`);
  if (value.length > max) fail(400, `${label} is too long (at most ${max} characters).`);
  return value;
}

// Optional whole number between 0 and 10^12; empty means "not given".
export function count(form, name, label) {
  const value = String(form.get(name) ?? '').trim();
  if (!value) return null;
  if (!/^\d{1,13}$/.test(value) || Number(value) > 1e12) fail(400, `${label} must be a whole number between 0 and 1,000,000,000,000.`);
  return Number(value);
}

export function oneOf(form, name, label, allowed) {
  const value = String(form.get(name) ?? '');
  if (!allowed.includes(value)) fail(400, `Choose a valid ${label}.`);
  return value;
}

export const toId = (value) => (/^\d{1,12}$/.test(String(value)) ? Number(value) : fail(400, 'Invalid selection.'));

export function send(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

export function backLink(req) {
  try {
    const url = new URL(req.headers.referer);
    if (url.origin === BASE.origin) return url.pathname + url.search;
  } catch {}
  return '/';
}
