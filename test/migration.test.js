import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvarvi-migration-'));

test('migration 3 rebuilds sources for research sites, keeping every row, id and snapshot link', async () => {
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
    INSERT INTO sources (id, url, host, kind, last_error) VALUES (3, 'https://reg.example/a', 'reg.example', 'compliance', 'timeout'),
      (7, 'https://trends.example/', 'trends.example', 'trends', NULL);
    INSERT INTO snapshots (id, source_id, text, hash, status) VALUES (1, 3, 'Guidance', 'h', 'approved');
    INSERT INTO ai_calls (agent) VALUES ('coach');
    PRAGMA user_version = 2;
  `);
  old.close();

  const { db, all, one, run } = await import('../db.js');
  assert.equal(one('PRAGMA user_version').user_version, 3);
  assert.equal(one('PRAGMA foreign_keys').foreign_keys, 1, 'foreign keys are back on');
  assert.deepEqual(all('SELECT id, kind, host, last_error FROM sources ORDER BY id').map((r) => ({ ...r })), [
    { id: 3, kind: 'compliance', host: 'reg.example', last_error: 'timeout' },
    { id: 7, kind: 'trends', host: 'trends.example', last_error: null },
  ]);
  assert.equal(one('SELECT src.url FROM snapshots s JOIN sources src ON src.id = s.source_id').url, 'https://reg.example/a');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  run(`INSERT INTO sources (url, host, kind) VALUES ('https://nih.gov/', 'nih.gov', 'research')`);
  assert.throws(() => run(`INSERT INTO snapshots (source_id, text, hash) VALUES (999, 'x', 'y')`), /FOREIGN KEY/);
  assert.deepEqual({ ...one('SELECT agent, model, draft_id FROM ai_calls') }, { agent: 'coach', model: 'claude-opus-5', draft_id: null });
  assert.equal(one(`SELECT COUNT(*) AS n FROM drafts`).n, 0);
});
