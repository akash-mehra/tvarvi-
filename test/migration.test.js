import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-migration-'));

test('migrations 3 to 6 rebuild sources and knowledge, keeping every row and id, add carousels, signatures and pictures, and fix pasted rules', async () => {
  // The tables migration 3 changes, as v2 left them.
  const old = new DatabaseSync(join(process.env.DATA_DIR, 'app.db'));
  old.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('compliance','trends')), active INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT, last_error TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), text TEXT NOT NULL, hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_by INTEGER, decided_at TEXT
    );
    CREATE TABLE ai_calls (id INTEGER PRIMARY KEY, agent TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'claude-opus-5');
    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('brand_rule','compliance_rule','example')),
      platform TEXT CHECK (platform IN ('instagram','linkedin','x')), active INTEGER NOT NULL DEFAULT 1, current_version_id INTEGER,
      source_item_id INTEGER UNIQUE, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (kind != 'example' OR platform IS NOT NULL)
    );
    CREATE TABLE knowledge_versions (id INTEGER PRIMARY KEY, knowledge_id INTEGER NOT NULL REFERENCES knowledge(id), version INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL);
    CREATE TABLE audit (id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    -- Rules pasted from the rules file under the wrong type or platform (fixed by migration 6), and one that is right.
    INSERT INTO knowledge (id, kind, platform, active, current_version_id) VALUES (4, 'compliance_rule', NULL, 1, 1), (9, 'example', 'x', 1, 2),
      (10, 'brand_rule', NULL, 0, 3), (11, 'compliance_rule', NULL, 1, 4), (12, 'compliance_rule', 'instagram', 1, 5), (13, 'compliance_rule', NULL, 1, 6);
    INSERT INTO knowledge_versions (id, knowledge_id, version, title, text) VALUES (1, 4, 1, '', 'No cure claims.'), (2, 9, 1, '', 'A post.'),
      (3, 10, 1, 'Claim language', 'Never say cure.'), (4, 11, 1, ' Pictures and tables ', 'Calm illustrations.'),
      (5, 12, 1, 'Voice and style', 'Plain Indian English.'), (6, 13, 1, 'Sensitivity', 'No shaming.');
    INSERT INTO sources (id, url, host, kind, last_error) VALUES (3, 'https://reg.example/a', 'reg.example', 'compliance', 'timeout'),
      (7, 'https://trends.example/', 'trends.example', 'trends', NULL), (8, 'https://who.int/', 'who.int', 'compliance', NULL),
      (9, 'https://indiankanoon.org/doc/358950/', 'indiankanoon.org', 'trends', NULL);
    INSERT INTO snapshots (id, source_id, text, hash, status) VALUES (1, 3, 'Guidance', 'h', 'approved'), (2, 8, 'WHO home page', 'w', 'pending');
    INSERT INTO ai_calls (agent) VALUES ('coach');
    PRAGMA user_version = 2;
  `);
  old.close();

  const { db, all, one, run } = await import('../db.js');
  assert.equal(one('PRAGMA user_version').user_version, 6);
  assert.equal(one('PRAGMA foreign_keys').foreign_keys, 1, 'foreign keys are back on');
  assert.deepEqual(all('SELECT id, kind, host, last_error FROM sources WHERE id IN (3, 7) ORDER BY id').map((r) => ({ ...r })), [
    { id: 3, kind: 'compliance', host: 'reg.example', last_error: 'timeout' },
    { id: 7, kind: 'trends', host: 'trends.example', last_error: null },
  ]);
  assert.equal(one('SELECT src.url FROM snapshots s JOIN sources src ON src.id = s.source_id').url, 'https://reg.example/a');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  run(`INSERT INTO sources (url, host, kind) VALUES ('https://nih.gov/', 'nih.gov', 'research')`);
  assert.throws(() => run(`INSERT INTO snapshots (source_id, text, hash) VALUES (999, 'x', 'y')`), /FOREIGN KEY/);
  assert.deepEqual({ ...one('SELECT agent, model, draft_id, carousel_id FROM ai_calls') }, { agent: 'coach', model: 'claude-opus-5', draft_id: null, carousel_id: null });
  assert.equal(one(`SELECT COUNT(*) AS n FROM drafts`).n, 0);
  assert.equal(one(`SELECT COUNT(*) AS n FROM carousels`).n, 0);

  // Migration 5: the same rules, which may now be for the website article alone; examples stay social posts.
  assert.deepEqual(all('SELECT k.id, k.kind, k.platform, v.text FROM knowledge k JOIN knowledge_versions v ON v.id = k.current_version_id WHERE k.id < 10 ORDER BY k.id')
    .map((r) => ({ ...r })), [{ id: 4, kind: 'compliance_rule', platform: null, text: 'No cure claims.' }, { id: 9, kind: 'example', platform: 'x', text: 'A post.' }]);

  // Migration 6: rules and sources with the rules file's exact titles and links move to where the file puts them,
  // active or not, and each move is in the audit log. Everything else is untouched.
  assert.deepEqual(all('SELECT id, kind, platform, active FROM knowledge WHERE id >= 10 ORDER BY id').map((r) => ({ ...r })), [
    { id: 10, kind: 'compliance_rule', platform: null, active: 0 },
    { id: 11, kind: 'compliance_rule', platform: 'website', active: 1 },
    { id: 12, kind: 'brand_rule', platform: 'website', active: 1 },
    { id: 13, kind: 'compliance_rule', platform: null, active: 1 },
  ]);
  assert.deepEqual(all('SELECT id, kind FROM sources WHERE id < 10 ORDER BY id').map((r) => ({ ...r })),
    [{ id: 3, kind: 'compliance' }, { id: 7, kind: 'trends' }, { id: 8, kind: 'research' }, { id: 9, kind: 'compliance' }]);
  assert.deepEqual(all('SELECT id, status FROM snapshots ORDER BY id').map((r) => ({ ...r })), [{ id: 1, status: 'approved' }, { id: 2, status: 'superseded' }]);
  assert.deepEqual(all(`SELECT user_id, detail FROM audit WHERE action = 'setup_fixed' ORDER BY id`).map((r) => r.detail), [
    'Rule #10 "Claim language": brand rule, all platforms → compliance rule, all platforms',
    'Rule #11 " Pictures and tables ": compliance rule, all platforms → compliance rule, website',
    'Rule #12 "Voice and style": compliance rule, instagram → brand rule, website',
    'Source #8 https://who.int/: compliance → research',
    'Source #9 https://indiankanoon.org/doc/358950/: trends → compliance',
  ]);
  assert.equal(one(`SELECT COUNT(*) AS n FROM sqlite_temp_master`).n, 0, 'no temporary tables left behind');
  run(`INSERT INTO knowledge (kind, platform) VALUES ('brand_rule', 'website')`);
  assert.throws(() => run(`INSERT INTO knowledge (kind, platform) VALUES ('example', 'website')`), /CHECK/);
  assert.deepEqual(Object.keys(one('SELECT sign_name, sign_credentials FROM users UNION ALL SELECT NULL, NULL LIMIT 1')), ['sign_name', 'sign_credentials']);
  assert.equal(one(`SELECT COUNT(*) AS n FROM pragma_table_info('items') WHERE name = 'pictures'`).n, 1);
  assert.equal(one(`SELECT COUNT(*) AS n FROM pragma_table_info('articles') WHERE name IN ('signature', 'signed_at', 'audit_hash', 'audit_status', 'audit_notes')`).n, 5);
  assert.equal(one(`SELECT COUNT(*) AS n FROM pragma_table_info('drafts') WHERE name = 'brief'`).n, 1);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
