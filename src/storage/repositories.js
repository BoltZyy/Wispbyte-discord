'use strict';

/**
 * Repository di atas adaptor database. Semua fungsi MELEMPAR error kalau
 * penulisan gagal — pemanggil tidak boleh menganggap data tersimpan kalau
 * terjadi error.
 */

const LOG_STATUSES = new Set(['ok', 'failed', 'partial']);
const MAX_LIST_LIMIT = 200;

function needId(name, value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (!s) throw new TypeError(`${name} wajib diisi`);
  return s;
}
const optId = (value) => (value === undefined || value === null || value === '' ? null : String(value));

/** Pengaturan per server (nilai JSON). */
function createSettingsRepo(db, { now = Date.now } = {}) {
  const upsert = db.prepare(`
    INSERT INTO guild_settings (guild_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const select = db.prepare('SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?');
  const selectAll = db.prepare('SELECT key, value FROM guild_settings WHERE guild_id = ?');
  const remove = db.prepare('DELETE FROM guild_settings WHERE guild_id = ? AND key = ?');

  return {
    get(guildId, key, fallback) {
      const row = select.get(needId('guildId', guildId), needId('key', key));
      return row ? JSON.parse(row.value) : fallback;
    },
    set(guildId, key, value) {
      if (value === undefined) throw new TypeError('value tidak boleh undefined (gunakan delete)');
      upsert.run(needId('guildId', guildId), needId('key', key), JSON.stringify(value), now());
      return value;
    },
    delete(guildId, key) {
      return remove.run(needId('guildId', guildId), needId('key', key)).changes > 0;
    },
    getAll(guildId) {
      const out = {};
      for (const row of selectAll.all(needId('guildId', guildId))) out[row.key] = JSON.parse(row.value);
      return out;
    },
  };
}

/** Audit trail / moderation log. */
function createAuditRepo(db, { now = Date.now } = {}) {
  const insert = db.prepare(`
    INSERT INTO moderation_logs (guild_id, action, actor_id, target_id, reason, status, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  return {
    log({ guildId, action, actorId, targetId, reason, status = 'ok', details } = {}) {
      if (!LOG_STATUSES.has(status)) throw new TypeError(`status tidak valid: ${status}`);
      const result = insert.run(
        needId('guildId', guildId), needId('action', action),
        optId(actorId), optId(targetId), reason ?? null, status,
        details === undefined || details === null ? null : JSON.stringify(details), now(),
      );
      return Number(result.lastInsertRowid);
    },

    /** Terbaru dulu. Filter opsional: targetId, actorId, action. */
    list({ guildId, targetId, actorId, action, limit = 50, beforeId } = {}) {
      const where = ['guild_id = ?']; const params = [needId('guildId', guildId)];
      if (targetId !== undefined) { where.push('target_id = ?'); params.push(String(targetId)); }
      if (actorId !== undefined)  { where.push('actor_id = ?');  params.push(String(actorId)); }
      if (action !== undefined)   { where.push('action = ?');    params.push(String(action)); }
      if (beforeId !== undefined) { where.push('id < ?');        params.push(Number(beforeId)); }
      const cap = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || 50));
      const rows = db.prepare(`SELECT * FROM moderation_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${cap}`).all(...params);
      return rows.map((r) => ({
        id: r.id, guildId: r.guild_id, action: r.action, actorId: r.actor_id, targetId: r.target_id,
        reason: r.reason, status: r.status, details: r.details === null ? null : JSON.parse(r.details), createdAt: r.created_at,
      }));
    },
  };
}

module.exports = { createSettingsRepo, createAuditRepo };
