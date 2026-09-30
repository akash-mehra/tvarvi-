// Admin-approved web sources. Compliance pages are fetched by this server (never by the AI), stored as
// versioned text snapshots, and used by the compliance agent only after an admin approves each version.
// Trend and research sources only define which domains the AI's web search/fetch may touch.
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { all, audit, one, run, tx } from './db.js';
import { BASE } from './http.js';
import { clip, htmlToText } from './text.js';

export class SourceError extends Error {}

export const KINDS = ['compliance', 'trends', 'research'];
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const MAX_STORED_CHARS = 200_000;
const CHARS_PER_SOURCE = 12_000;
const CHARS_TOTAL = 40_000;

export function parseSourceUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new SourceError('Enter a full link that starts with https://');
  }
  if (url.protocol !== 'https:') throw new SourceError('Only https:// links are allowed.');
  if (url.username || url.password) throw new SourceError('Links must not contain a username or password.');
  if (url.port) throw new SourceError('Links must use the standard https port.');
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new SourceError('Use the site\'s domain name, not an IP address.');
  if (!url.hostname.includes('.') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) {
    throw new SourceError('Use a public domain name.');
  }
  url.hash = '';
  if (url.href.length > 500) throw new SourceError('The link is too long (500 characters at most).');
  return url;
}

// Private, loopback, link-local, carrier-grade NAT, documentation, multicast and reserved ranges.
// BlockList checks IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) against the IPv4 rules itself.
const BLOCKED = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(address, prefix, 'ipv6');

export function isPrivateAddress(address) {
  const family = isIP(address);
  return !family || BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// Checked when the socket connects, so a DNS answer cannot change between the check and the connection.
export function safeLookup(hostname, options, callback) {
  const opts = options && typeof options === 'object' ? options : { family: options };
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      return callback(new SourceError(`Blocked: ${hostname} resolves to a private or reserved address.`));
    }
    if (opts.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: { 'user-agent': `Tvarvi-compliance-check/1.0 (+${BASE.origin})`, accept: 'text/html, text/plain;q=0.9' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, location: res.headers.location ?? null, type, body: '' });
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) req.destroy(new SourceError('The page is larger than 2 MB.'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, location: null, type, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    const deadline = setTimeout(() => req.destroy(new SourceError('The page took too long to respond.')), TIMEOUT_MS);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new SourceError('The page took too long to respond.')));
    req.on('error', reject);
  });
}

// `net.get` is a property so tests can stand in for the network.
export const net = { get: httpsGet };

export async function fetchPage(rawUrl, allowedHosts) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new SourceError(`Blocked: the page redirects to a non-https or credentialed address (${clip(url.href, 80)}).`);
    }
    if (!allowedHosts.has(url.hostname)) {
      throw new SourceError(`Blocked: ${url.hostname} is not an approved source domain. If the page moved there, add the new link instead.`);
    }
    const res = await net.get(url);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new SourceError(`The page returned HTTP ${res.status} without saying where it moved.`);
      url = new URL(res.location, url);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new SourceError(`The page returned HTTP ${res.status}.`);
    if (res.type === 'application/pdf') throw new SourceError('This link is a PDF, which is not supported yet. Add the HTML version of the page.');
    if (res.type === 'text/plain') return res.body;
    if (res.type === 'text/html' || res.type === 'application/xhtml+xml') return htmlToText(res.body);
    throw new SourceError(`Unsupported content type "${clip(res.type || 'unknown', 60)}".`);
  }
  throw new SourceError('The page redirects too many times.');
}

// A host and its www twin are one site, so a page may move between them.
export const allowedHosts = () => new Set(all('SELECT DISTINCT host FROM sources WHERE active = 1')
  .flatMap(({ host }) => [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`]));

// Returns 'changed' (new pending snapshot), 'unchanged' or 'error' (stored on the source for the admin).
export async function checkSource(source) {
  try {
    const text = (await fetchPage(source.url, allowedHosts())).trim().slice(0, MAX_STORED_CHARS);
    if (!text) throw new SourceError('The page had no readable text.');
    const hash = createHash('sha256').update(text).digest('hex');
    return tx(() => {
      run('UPDATE sources SET last_checked_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?', source.id);
      const latest = one(`SELECT hash FROM snapshots WHERE source_id = ? AND status != 'superseded' ORDER BY id DESC LIMIT 1`, source.id);
      if (latest?.hash === hash) return 'unchanged';
      run(`UPDATE snapshots SET status = 'superseded' WHERE source_id = ? AND status = 'pending'`, source.id);
      const approved = one(`SELECT hash FROM snapshots WHERE source_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1`, source.id);
      if (approved?.hash === hash) return 'unchanged'; // the page went back to the approved version
      const { lastInsertRowid } = run('INSERT INTO snapshots (source_id, text, hash) VALUES (?, ?, ?)', source.id, text, hash);
      audit(null, 'snapshot_changed', `${source.url}: snapshot #${lastInsertRowid} is waiting for approval`);
      return 'changed';
    });
  } catch (err) {
    const message = err instanceof SourceError ? err.message : `Could not fetch the page (${clip(String(err.message), 150)}).`;
    run('UPDATE sources SET last_checked_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?', message, source.id);
    return 'error';
  }
}

export async function checkAllSources() {
  const results = [];
  for (const source of all(`SELECT * FROM sources WHERE kind = 'compliance' AND active = 1 ORDER BY id`)) {
    results.push(await checkSource(source));
  }
  return results;
}

export function addSource(rawUrl, kind, userId) {
  if (!KINDS.includes(kind)) throw new SourceError('Choose compliance, trends or research.');
  const url = parseSourceUrl(rawUrl);
  if (one('SELECT 1 FROM sources WHERE url = ?', url.href)) throw new SourceError('That link is already a source.');
  const { lastInsertRowid } = run('INSERT INTO sources (url, host, kind, created_by) VALUES (?, ?, ?, ?)', url.href, url.hostname, kind, userId);
  audit(userId, 'source_added', `${kind}: ${url.href}`);
  return lastInsertRowid;
}

export function setSourceActive(id, active, userId) {
  const source = one('SELECT url FROM sources WHERE id = ?', id);
  if (!source) return false;
  const { changes } = run('UPDATE sources SET active = ? WHERE id = ? AND active != ?', active ? 1 : 0, id, active ? 1 : 0);
  if (changes) audit(userId, active ? 'source_activated' : 'source_deactivated', source.url);
  return changes > 0;
}

// The admin approval gate: only approved snapshots ever reach the compliance agent.
export function decideSnapshot(id, approve, userId) {
  return tx(() => {
    const snapshot = one(
      `SELECT s.id, src.url FROM snapshots s JOIN sources src ON src.id = s.source_id WHERE s.id = ? AND s.status = 'pending'`, id);
    if (!snapshot) return false;
    run('UPDATE snapshots SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?', approve ? 'approved' : 'rejected', userId, id);
    audit(userId, approve ? 'snapshot_approved' : 'snapshot_rejected', `#${id} ${snapshot.url}`);
    return true;
  });
}

// Latest approved version of each active compliance source, trimmed to fit the prompt budget.
export function approvedSnapshots() {
  let budget = CHARS_TOTAL;
  return all(
    `SELECT s.id, s.text, s.fetched_at, src.url FROM sources src
     JOIN snapshots s ON s.id = (SELECT MAX(id) FROM snapshots WHERE source_id = src.id AND status = 'approved')
     WHERE src.kind = 'compliance' AND src.active = 1 ORDER BY src.id`,
  ).map((snapshot) => {
    const text = snapshot.text.slice(0, Math.max(0, Math.min(CHARS_PER_SOURCE, budget)));
    budget -= text.length;
    return { ...snapshot, text, truncated: text.length < snapshot.text.length };
  }).filter((snapshot) => snapshot.text);
}

export const trendSources = () => all(`SELECT url, host FROM sources WHERE kind = 'trends' AND active = 1 ORDER BY id LIMIT 20`);
export const researchSources = () => all(`SELECT url, host FROM sources WHERE kind = 'research' AND active = 1 ORDER BY id LIMIT 30`);

// The web tools' domain rule: an https URL on one of the hosts or on a subdomain of one.
export function onApprovedHost(rawUrl, hosts) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export const listSources = () =>
  all(`SELECT src.*,
         (SELECT fetched_at FROM snapshots WHERE source_id = src.id AND status = 'approved' ORDER BY id DESC LIMIT 1) AS approved_at,
         (SELECT COUNT(*) FROM snapshots WHERE source_id = src.id AND status = 'pending') AS pending
       FROM sources src ORDER BY src.active DESC, src.kind, src.id`);

export const pendingSnapshots = () =>
  all(`SELECT s.id, s.text, s.fetched_at, src.url, src.id AS source_id,
         (SELECT text FROM snapshots WHERE source_id = src.id AND status = 'approved' ORDER BY id DESC LIMIT 1) AS approved_text
       FROM snapshots s JOIN sources src ON src.id = s.source_id
       WHERE s.status = 'pending' ORDER BY s.id`);
