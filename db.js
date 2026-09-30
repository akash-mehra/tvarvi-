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
  // The model that served each call; every call before this used Claude Opus 5.
  `ALTER TABLE ai_calls ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-opus-5';`,
  `
  -- Research sources. SQLite can't change a CHECK constraint, so the table is rebuilt with the same rows and ids.
  CREATE TABLE sources_new (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('compliance','trends','research')),
    active INTEGER NOT NULL DEFAULT 1,
    last_checked_at TEXT,
    last_error TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO sources_new (id, url, host, kind, active, last_checked_at, last_error, created_by, created_at)
    SELECT id, url, host, kind, active, last_checked_at, last_error, created_by, created_at FROM sources;
  DROP TABLE sources;
  ALTER TABLE sources_new RENAME TO sources;

  -- Article agent drafts: researched and written by AI, checked and submitted by a person.
  CREATE TABLE drafts (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running','ready','needs_attention','failed','submitted','discarded')),
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    refs TEXT NOT NULL DEFAULT '[]',
    evidence TEXT NOT NULL DEFAULT '[]',
    inputs TEXT NOT NULL DEFAULT '[]',
    checks TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    rounds INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    log TEXT NOT NULL DEFAULT '',
    article_id INTEGER REFERENCES articles(id),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
  );
  CREATE INDEX drafts_by_user ON drafts(created_by);
  CREATE INDEX drafts_by_article ON drafts(article_id);
  ALTER TABLE ai_calls ADD COLUMN draft_id INTEGER REFERENCES drafts(id);
  `,
  `
  -- Instagram carousels: slide text by AI (compliance-checked), pictures by Gemini (checked by AI), slides designed
  -- in Glass Slides and uploaded, then ticked off by the reviewer. One per Instagram post; "start over" reuses the row.
  CREATE TABLE carousels (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL UNIQUE REFERENCES items(id),
    status TEXT NOT NULL DEFAULT 'working'
      CHECK (status IN ('working','ready','needs_attention','failed','discarded')),
    job TEXT NOT NULL DEFAULT 'write' CHECK (job IN ('write','check','picture','final')),
    slides TEXT NOT NULL DEFAULT '[]',
    finals TEXT NOT NULL DEFAULT '[]',
    final_check TEXT NOT NULL DEFAULT '[]',
    checklist TEXT,
    notes TEXT,
    compliance_ok INTEGER,
    link_hash TEXT,
    link_expires INTEGER,
    error TEXT,
    log TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
  );
  ALTER TABLE ai_calls ADD COLUMN carousel_id INTEGER REFERENCES carousels(id);
  `,
  `
  -- Doctor sign-off: each reviewer's signing details, and the signature copied onto an article when they approve it.
  ALTER TABLE users ADD COLUMN sign_name TEXT;
  ALTER TABLE users ADD COLUMN sign_credentials TEXT;
  ALTER TABLE articles ADD COLUMN signature TEXT;
  ALTER TABLE articles ADD COLUMN signed_at TEXT;
  -- The advisory AI audit of the exact text a reviewer sees (it never blocks approval).
  ALTER TABLE articles ADD COLUMN audit_hash TEXT;
  ALTER TABLE articles ADD COLUMN audit_status TEXT CHECK (audit_status IN ('running','ready','issues','failed'));
  ALTER TABLE articles ADD COLUMN audit_notes TEXT;
  -- The writer's brief for the article agent, and the website article's pictures (JSON), made by Gemini after approval.
  ALTER TABLE drafts ADD COLUMN brief TEXT NOT NULL DEFAULT '';
  ALTER TABLE items ADD COLUMN pictures TEXT NOT NULL DEFAULT '[]';

  -- Rules for the website article alone. SQLite can't change a CHECK constraint, so the table is rebuilt as is.
  CREATE TABLE knowledge_new (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('brand_rule','compliance_rule','example')),
    platform TEXT CHECK (platform IN ('website','instagram','linkedin','x')),
    active INTEGER NOT NULL DEFAULT 1,
    current_version_id INTEGER,
    source_item_id INTEGER UNIQUE REFERENCES items(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (kind != 'example' OR platform IN ('instagram','linkedin','x'))
  );
  INSERT INTO knowledge_new (id, kind, platform, active, current_version_id, source_item_id, created_by, created_at)
    SELECT id, kind, platform, active, current_version_id, source_item_id, created_by, created_at FROM knowledge;
  DROP TABLE knowledge;
  ALTER TABLE knowledge_new RENAME TO knowledge;
  `,
  `
  -- One-off fix of Training rules and Sources pasted from the September 2026 rules file under the wrong type, platform
  -- or kind. Only entries whose title or link is exactly the file's are moved to where the file puts them; whether
  -- they are active is left alone, and each change is written to the audit log.
  CREATE TEMP TABLE setup_rules (title TEXT PRIMARY KEY, kind TEXT NOT NULL, platform TEXT);
  INSERT INTO setup_rules VALUES
    ('evidence and numbers', 'compliance_rule', NULL), ('claim language', 'compliance_rule', NULL),
    ('medicines, supplements, ayurveda, yoga and diet', 'compliance_rule', NULL), ('indian law', 'compliance_rule', NULL),
    ('sensitivity', 'compliance_rule', NULL), ('positioning', 'compliance_rule', NULL),
    ('title, keyword and names', 'compliance_rule', 'website'), ('takeaways, coined concept, chapters and faqs', 'compliance_rule', 'website'),
    ('pictures and tables', 'compliance_rule', 'website'), ('calls to action', 'compliance_rule', 'website'),
    ('tvarvi pages and calls to action', 'compliance_rule', 'website'), ('voice and style', 'brand_rule', 'website');
  CREATE TEMP TABLE setup_fixes AS
    SELECT k.id, v.title, k.kind AS old_kind, k.platform AS old_platform, s.kind, s.platform
    FROM knowledge k JOIN knowledge_versions v ON v.id = k.current_version_id JOIN setup_rules s ON s.title = lower(trim(v.title))
    WHERE k.kind != 'example' AND (k.kind != s.kind OR k.platform IS NOT s.platform);
  INSERT INTO audit (action, detail)
    SELECT 'setup_fixed', 'Rule #' || id || ' "' || title || '": ' || replace(old_kind, '_', ' ') || ', ' || COALESCE(old_platform, 'all platforms')
      || ' → ' || replace(kind, '_', ' ') || ', ' || COALESCE(platform, 'all platforms') FROM setup_fixes;
  UPDATE knowledge SET kind = (SELECT kind FROM setup_fixes f WHERE f.id = knowledge.id),
    platform = (SELECT platform FROM setup_fixes f WHERE f.id = knowledge.id)
    WHERE id IN (SELECT id FROM setup_fixes);

  CREATE TEMP TABLE setup_sources (url TEXT PRIMARY KEY, kind TEXT NOT NULL);
  INSERT INTO setup_sources VALUES
    ('https://who.int/', 'research'), ('https://icmr.gov.in/', 'research'), ('https://mohfw.gov.in/', 'research'),
    ('https://nhm.gov.in/', 'research'), ('https://fssai.gov.in/', 'research'), ('https://monash.edu/', 'research'),
    ('https://fogsi.org/', 'research'), ('https://aiims.edu/', 'research'), ('https://pgimer.edu.in/', 'research'),
    ('https://pubmed.ncbi.nlm.nih.gov/', 'research'), ('https://pmc.ncbi.nlm.nih.gov/', 'research'),
    ('https://cochranelibrary.com/', 'research'), ('https://thelancet.com/', 'research'), ('https://endocrine.org/', 'research'),
    ('https://eshre.eu/', 'research'), ('https://asrm.org/', 'research'), ('https://acog.org/', 'research'),
    ('https://nice.org.uk/', 'research'), ('https://nhs.uk/', 'research'),
    ('https://indiankanoon.org/doc/358950/', 'compliance'), ('https://www.pib.gov.in/PressReleasePage.aspx?PRID=1832906', 'compliance'),
    ('https://www.newsonair.gov.in/centre-releases-additional-guidelines-for-health-and-wellness-celebrities-and-influencers', 'compliance');
  INSERT INTO audit (action, detail)
    SELECT 'setup_fixed', 'Source #' || src.id || ' ' || src.url || ': ' || src.kind || ' → ' || s.kind
    FROM sources src JOIN setup_sources s ON s.url = src.url WHERE src.kind != s.kind;
  -- A page that is no longer a compliance page has nothing waiting for approval.
  UPDATE snapshots SET status = 'superseded' WHERE status = 'pending' AND source_id IN
    (SELECT src.id FROM sources src JOIN setup_sources s ON s.url = src.url WHERE src.kind = 'compliance' AND s.kind != 'compliance');
  UPDATE sources SET kind = (SELECT kind FROM setup_sources s WHERE s.url = sources.url)
    WHERE url IN (SELECT url FROM setup_sources s WHERE s.kind != sources.kind);
  DROP TABLE setup_rules;
  DROP TABLE setup_fixes;
  DROP TABLE setup_sources;
  `,
];

// Foreign keys are off while migrating (SQLite's documented way to rebuild a table) and checked before each commit.
db.exec('PRAGMA foreign_keys = OFF');
for (let version = db.prepare('PRAGMA user_version').get().user_version; version < MIGRATIONS.length; version++) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(MIGRATIONS[version]);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`Migration ${version + 1} would break a foreign key.`);
    db.exec(`PRAGMA user_version = ${version + 1}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
db.exec('PRAGMA foreign_keys = ON');

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
  run(`UPDATE drafts SET status = 'failed', error = 'Interrupted by a restart. Click Try again.', finished_at = CURRENT_TIMESTAMP
       WHERE status = 'running'`);
  run(`UPDATE carousels SET status = 'failed', error = 'Interrupted by a restart. Click Try again.' WHERE status = 'working'`);
  run(`UPDATE articles SET audit_status = 'failed', audit_notes = 'Interrupted by a restart.' WHERE audit_status = 'running'`);
}
