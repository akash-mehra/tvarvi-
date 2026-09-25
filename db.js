import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || './data';
export const UPLOADS = join(DATA_DIR, 'uploads');
mkdirSync(UPLOADS, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  can_write INTEGER NOT NULL DEFAULT 0,
  can_review INTEGER NOT NULL DEFAULT 0,
  can_publish INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  base_title TEXT,
  base_body TEXT,
  note TEXT,
  author_id INTEGER NOT NULL REFERENCES users(id),
  reviewer_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','in_review','returned','approved','awaiting_publisher','published')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  channel TEXT NOT NULL CHECK (channel IN ('website','instagram','linkedin','x')),
  body TEXT NOT NULL DEFAULT '',
  image TEXT,
  ai_notes TEXT,
  ai_ok INTEGER,
  status TEXT NOT NULL
    CHECK (status IN ('generating','draft','failed','ready','publishing','published','publish_failed')),
  error TEXT,
  external_url TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  published_by INTEGER REFERENCES users(id),
  published_at TEXT,
  UNIQUE (article_id, channel)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS events_by_article ON events(article_id);
`);

const cache = new Map();
const stmt = (sql) => cache.get(sql) ?? cache.set(sql, db.prepare(sql)).get(sql);

export const one = (sql, ...params) => stmt(sql).get(...params);
export const all = (sql, ...params) => stmt(sql).all(...params);
export const run = (sql, ...params) => stmt(sql).run(...params);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const logEvent = (articleId, userId, action, detail = null) =>
  run('INSERT INTO events (article_id, user_id, action, detail) VALUES (?, ?, ?, ?)', articleId, userId, action, detail);

// Work cut off by a crash or redeploy must not stay "in progress" forever.
export function recoverInterrupted() {
  run(`UPDATE items SET status = 'failed', error = 'Interrupted by a restart. Click Regenerate.' WHERE status = 'generating'`);
  run(`UPDATE items SET status = 'publish_failed',
       error = 'Interrupted by a restart. Check the platform before retrying, the post may already be live.'
       WHERE status = 'publishing'`);
}
