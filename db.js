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

// Schema changes after v1, applied once each in order and tracked by PRAGMA user_version.
const MIGRATIONS = [
  `
  ALTER TABLE items ADD COLUMN ai_draft TEXT;
  ALTER TABLE items ADD COLUMN rounds INTEGER;
  ALTER TABLE items ADD COLUMN generated_at TEXT;
  ALTER TABLE items ADD COLUMN reviewed_at TEXT;

  -- Approved rules and examples. Versions are append-only; knowledge rows are never deleted.
  CREATE TABLE knowledge (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('brand_rule','compliance_rule','example')),
    platform TEXT CHECK (platform IN ('instagram','linkedin','x')),
    active INTEGER NOT NULL DEFAULT 1,
    current_version_id INTEGER,
    source_item_id INTEGER UNIQUE REFERENCES items(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (kind != 'example' OR platform IS NOT NULL)
  );
  CREATE TABLE knowledge_versions (
    id INTEGER PRIMARY KEY,
    knowledge_id INTEGER NOT NULL REFERENCES knowledge(id),
    version INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    likes INTEGER,
    shares INTEGER,
    reach INTEGER,
    note TEXT,
    suggestion_id INTEGER REFERENCES suggestions(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (knowledge_id, version)
  );

  -- Self-improvement log: what the weekly coach noticed and what admins decided.
  CREATE TABLE digests (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running','done','skipped','failed')),
    note TEXT,
    period_start TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE observations (
    id INTEGER PRIMARY KEY,
    digest_id INTEGER NOT NULL REFERENCES digests(id),
    kind TEXT NOT NULL CHECK (kind IN ('recurring_edit','top_post','flagged','snapshot_changed')),
    summary TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    item_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE suggestions (
    id INTEGER PRIMARY KEY,
    digest_id INTEGER NOT NULL REFERENCES digests(id),
    observation_id INTEGER REFERENCES observations(id),
    kind TEXT NOT NULL CHECK (kind IN ('brand_rule','compliance_rule','example','reminder')),
    platform TEXT CHECK (platform IN ('instagram','linkedin','x')),
    item_id INTEGER REFERENCES items(id),
    snapshot_id INTEGER REFERENCES snapshots(id),
    text TEXT NOT NULL,
    norm_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','edited','rejected','dismissed')),
    final_text TEXT,
    knowledge_version_id INTEGER REFERENCES knowledge_versions(id),
    decided_by INTEGER REFERENCES users(id),
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX suggestions_by_norm ON suggestions(norm_text);

  -- Exactly which rule/example versions, snapshots, web pages and past articles each post used.
  CREATE TABLE item_inputs (
    item_id INTEGER NOT NULL REFERENCES items(id),
    kind TEXT NOT NULL CHECK (kind IN ('rule','example','post','snapshot','web','article')),
    ref_id INTEGER,
    label TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX item_inputs_by_item ON item_inputs(item_id);
  CREATE INDEX item_inputs_by_ref ON item_inputs(kind, ref_id);

  -- Engagement; later the Instagram Insights API adds rows with source 'instagram_insights'.
  CREATE TABLE post_metrics (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id),
    likes INTEGER NOT NULL DEFAULT 0,
    shares INTEGER NOT NULL DEFAULT 0,
    reach INTEGER NOT NULL DEFAULT 0,
    saves INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL CHECK (source IN ('manual','instagram_insights')),
    recorded_by INTEGER REFERENCES users(id),
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX post_metrics_by_item ON post_metrics(item_id);

  -- Admin-approved web sources and versioned text snapshots of compliance pages.
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('compliance','trends')),
    active INTEGER NOT NULL DEFAULT 1,
    last_checked_at TEXT,
    last_error TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    text TEXT NOT NULL,
    hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','superseded')),
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by INTEGER REFERENCES users(id),
    decided_at TEXT
  );
  CREATE INDEX snapshots_by_source ON snapshots(source_id);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE ai_calls (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    article_id INTEGER REFERENCES articles(id),
    agent TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    web_searches INTEGER NOT NULL DEFAULT 0,
    web_fetches INTEGER NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE jobs (name TEXT PRIMARY KEY, last_run_at INTEGER NOT NULL);
  `,
];

for (let version = db.prepare('PRAGMA user_version').get().user_version; version < MIGRATIONS.length; version++) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(MIGRATIONS[version]);
    db.exec(`PRAGMA user_version = ${version + 1}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Agent tools query through this connection, so a bug there can never write.
export const readOnlyDb = new DatabaseSync(join(DATA_DIR, 'app.db'), { readOnly: true });

const cache = new Map();
const stmt = (sql) => cache.get(sql) ?? cache.set(sql, db.prepare(sql)).get(sql);

export const one = (sql, ...params) => stmt(sql).get(...params);
export const all = (sql, ...params) => stmt(sql).all(...params);
export const run = (sql, ...params) => stmt(sql).run(...params);

// Re-entrant: a tx() inside another tx() joins the outer transaction.
export function tx(fn) {
  if (db.isTransaction) return fn();
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

export const audit = (userId, action, detail = null) =>
  run('INSERT INTO audit (user_id, action, detail) VALUES (?, ?, ?)', userId, action, detail);

// Work cut off by a crash or redeploy must not stay "in progress" forever.
export function recoverInterrupted() {
  run(`UPDATE items SET status = 'failed', error = 'Interrupted by a restart. Click Regenerate.' WHERE status = 'generating'`);
  run(`UPDATE items SET status = 'publish_failed',
       error = 'Interrupted by a restart. Check the platform before retrying, the post may already be live.'
       WHERE status = 'publishing'`);
  run(`UPDATE digests SET status = 'failed', note = 'Interrupted by a restart.' WHERE status = 'running'`);
}
