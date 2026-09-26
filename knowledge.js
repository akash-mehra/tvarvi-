// Approved rules and examples with full version history. Versions are append-only:
// an edit or a rollback adds a new version, nothing is overwritten or deleted.
import { all, audit, one, run, tx } from './db.js';
import { clip, KNOWLEDGE_KINDS as KINDS, normText } from './text.js';

export { KINDS };

const CURRENT = `SELECT k.id, k.kind, k.platform, k.active, k.source_item_id,
    v.id AS version_id, v.version, v.title, v.text, v.likes, v.shares, v.reach, v.created_at AS updated_at
  FROM knowledge k JOIN knowledge_versions v ON v.id = k.current_version_id`;

export const getEntry = (id) => one(`${CURRENT} WHERE k.id = ?`, id);
export const listEntries = () => all(`${CURRENT} ORDER BY k.kind, k.platform, k.active DESC, k.id`);

// What agents may read: the current version of each active rule that applies to this channel.
export const activeRules = (channel) =>
  all(`${CURRENT} WHERE k.active = 1 AND k.kind != 'example' AND (k.platform IS NULL OR k.platform = ?) ORDER BY k.kind, k.id`, channel);

function addVersion(knowledgeId, fields, userId, note, suggestionId = null) {
  const { next } = one('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM knowledge_versions WHERE knowledge_id = ?', knowledgeId);
  const { lastInsertRowid } = run(
    `INSERT INTO knowledge_versions (knowledge_id, version, title, text, likes, shares, reach, note, suggestion_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    knowledgeId, next, fields.title ?? '', fields.text, fields.likes ?? null, fields.shares ?? null, fields.reach ?? null,
    note, suggestionId, userId,
  );
  run('UPDATE knowledge SET current_version_id = ? WHERE id = ?', lastInsertRowid, knowledgeId);
  return { versionId: lastInsertRowid, version: next };
}

export function createEntry({ kind, platform = null, sourceItemId = null, suggestionId = null, note = null, ...fields }, userId) {
  return tx(() => {
    const { lastInsertRowid: id } = run(
      'INSERT INTO knowledge (kind, platform, source_item_id, created_by) VALUES (?, ?, ?, ?)',
      kind, platform, sourceItemId, userId,
    );
    const { versionId } = addVersion(id, fields, userId, note, suggestionId);
    audit(userId, 'knowledge_created',
      `${KINDS[kind]} #${id} v1${suggestionId ? ` from suggestion #${suggestionId}` : ''}: ${clip(fields.text, 120)}`);
    return { id, versionId };
  });
}

export function editEntry(id, fields, userId, note = null) {
  return tx(() => {
    const entry = getEntry(id);
    const { version } = addVersion(id, fields, userId, note);
    audit(userId, 'knowledge_edited', `${KINDS[entry.kind]} #${id} v${entry.version} → v${version}${note ? `: ${note}` : ''}`);
    return version;
  });
}

// Rolling back copies an old version into a new one, so the history stays linear and complete.
export function rollbackEntry(id, versionId, userId) {
  return tx(() => {
    const old = one('SELECT * FROM knowledge_versions WHERE id = ? AND knowledge_id = ?', versionId, id);
    if (!old) return null;
    const { version } = addVersion(id, old, userId, `Rolled back to v${old.version}`);
    audit(userId, 'knowledge_rolled_back', `#${id} v${version} is a copy of v${old.version}`);
    return version;
  });
}

export function setActive(id, active, userId) {
  const { changes } = run('UPDATE knowledge SET active = ? WHERE id = ? AND active != ?', active ? 1 : 0, id, active ? 1 : 0);
  if (changes) audit(userId, active ? 'knowledge_activated' : 'knowledge_deactivated', `#${id}`);
  return changes > 0;
}

export const entryHistory = (id) =>
  all(
    `SELECT v.*, u.name AS author,
       (SELECT COUNT(DISTINCT ii.item_id) FROM item_inputs ii WHERE ii.kind IN ('rule', 'example') AND ii.ref_id = v.id) AS used_by
     FROM knowledge_versions v LEFT JOIN users u ON u.id = v.created_by
     WHERE v.knowledge_id = ? ORDER BY v.version DESC`,
    id,
  );

export const postsUsingVersion = (versionId) =>
  all(
    `SELECT DISTINCT i.id AS item_id, i.channel, a.id AS article_id, a.title FROM item_inputs ii
     JOIN items i ON i.id = ii.item_id JOIN articles a ON a.id = i.article_id
     WHERE ii.kind IN ('rule', 'example') AND ii.ref_id = ? ORDER BY i.id DESC LIMIT 20`,
    versionId,
  );

export const latestMetrics = (itemId) => one('SELECT * FROM post_metrics WHERE item_id = ? ORDER BY id DESC LIMIT 1', itemId);

// Every version ever approved, active or not: the coach must never re-propose these.
export const knownKnowledgeNorms = () => all('SELECT text FROM knowledge_versions').map((row) => normText(row.text));
