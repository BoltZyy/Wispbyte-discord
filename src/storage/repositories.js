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

/** Peringatan (warning) anggota. */
function createWarningsRepo(db, { now = Date.now } = {}) {
  const insert = db.prepare(`
    INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)`);
  const byId = db.prepare('SELECT * FROM warnings WHERE guild_id = ? AND id = ?');
  const deactivate = db.prepare(`
    UPDATE warnings SET status = 'removed', removed_by = ?, removed_at = ?, removed_reason = ?
    WHERE guild_id = ? AND id = ? AND status = 'active'`);
  const countActive = db.prepare("SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ? AND status = 'active'");

  const map = (r) => r && ({
    id: r.id, guildId: r.guild_id, userId: r.user_id, moderatorId: r.moderator_id, reason: r.reason,
    createdAt: r.created_at, status: r.status, removedBy: r.removed_by, removedAt: r.removed_at, removedReason: r.removed_reason,
  });

  return {
    add({ guildId, userId, moderatorId, reason } = {}) {
      const text = String(reason ?? '').trim();
      if (!text) throw new TypeError('reason wajib diisi');
      const res = insert.run(needId('guildId', guildId), needId('userId', userId), needId('moderatorId', moderatorId), text, now());
      return map(byId.get(String(guildId), Number(res.lastInsertRowid)));
    },
    get(guildId, id) { return map(byId.get(needId('guildId', guildId), Number(id))); },
    countActive(guildId, userId) { return countActive.get(needId('guildId', guildId), needId('userId', userId)).n; },
    /** Terbaru dulu. Default hanya yang aktif. */
    list({ guildId, userId, includeInactive = false, limit = 25 } = {}) {
      const cap = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || 25));
      const where = includeInactive ? 'guild_id = ? AND user_id = ?' : "guild_id = ? AND user_id = ? AND status = 'active'";
      return db.prepare(`SELECT * FROM warnings WHERE ${where} ORDER BY id DESC LIMIT ${cap}`)
        .all(needId('guildId', guildId), needId('userId', userId)).map(map);
    },
    /** Mencabut peringatan aktif. Hasil: { ok: true, row } | { ok: false, reason: 'not_found' | 'already_inactive' }. */
    remove({ guildId, id, removedBy, reason } = {}) {
      const gid = needId('guildId', guildId);
      const res = deactivate.run(needId('removedBy', removedBy), now(), reason ?? null, gid, Number(id));
      if (res.changes > 0) return { ok: true, row: map(byId.get(gid, Number(id))) };
      return { ok: false, reason: byId.get(gid, Number(id)) ? 'already_inactive' : 'not_found' };
    },
  };
}

/** Catatan hasil verification (tanpa jawaban peserta). */
function createVerificationRepo(db, { now = Date.now } = {}) {
  const insert = db.prepare('INSERT INTO verification_records (guild_id, user_id, started_at) VALUES (?, ?, ?)');
  const setAttempts = db.prepare("UPDATE verification_records SET attempts = ? WHERE id = ? AND status = 'started'");
  const finish = db.prepare("UPDATE verification_records SET status = ?, attempts = ?, finished_at = ? WHERE id = ? AND status = 'started'");
  const closeAll = db.prepare("UPDATE verification_records SET status = 'timeout', finished_at = ? WHERE status = 'started'");
  const byId = db.prepare('SELECT * FROM verification_records WHERE id = ?');
  const latest = db.prepare('SELECT * FROM verification_records WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1');
  const FINAL = new Set(['passed', 'failed_attempts', 'timeout']);
  const map = (r) => r && ({ id: r.id, guildId: r.guild_id, userId: r.user_id, status: r.status, attempts: r.attempts, startedAt: r.started_at, finishedAt: r.finished_at });

  return {
    start({ guildId, userId } = {}) {
      return Number(insert.run(needId('guildId', guildId), needId('userId', userId), now()).lastInsertRowid);
    },
    /** Mencatat jumlah percobaan sementara (status tetap 'started'). */
    setAttempts(id, attempts) { return setAttempts.run(Number(attempts), Number(id)).changes > 0; },
    /** Menutup catatan yang masih 'started'. Mengembalikan false kalau sudah ditutup sebelumnya. */
    finish(id, status, attempts) {
      if (!FINAL.has(status)) throw new TypeError(`status akhir tidak valid: ${status}`);
      return finish.run(status, Number(attempts), now(), Number(id)).changes > 0;
    },
    /** Saat bot start: sesi hanya hidup di memori, jadi semua yang masih 'started' sudah mati. */
    closeAllStarted() { return closeAll.run(now()).changes; },
    get(id) { return map(byId.get(Number(id))); },
    latest(guildId, userId) { return map(latest.get(needId('guildId', guildId), needId('userId', userId))); },
  };
}

/** Aturan kata terlarang per server. */
function createRulesRepo(db, { now = Date.now } = {}) {
  const byId = db.prepare('SELECT * FROM banned_word_rules WHERE guild_id = ? AND id = ?');
  const insert = db.prepare(`
    INSERT INTO banned_word_rules (guild_id, name, phrase, mode, reason, allow_pass, pass_days, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const remove = db.prepare('DELETE FROM banned_word_rules WHERE guild_id = ? AND id = ?');
  const count = db.prepare('SELECT COUNT(*) AS n FROM banned_word_rules WHERE guild_id = ?');
  const EDITABLE = { name: 'name', phrase: 'phrase', mode: 'mode', reason: 'reason', enabled: 'enabled', allowPass: 'allow_pass', passDays: 'pass_days' };

  const map = (r) => r && ({
    id: r.id, guildId: r.guild_id, name: r.name, phrase: r.phrase, mode: r.mode, reason: r.reason,
    enabled: r.enabled === 1, allowPass: r.allow_pass === 1, passDays: r.pass_days,
    exemptRoles: JSON.parse(r.exempt_roles), exemptChannels: JSON.parse(r.exempt_channels),
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const get = (guildId, id) => map(byId.get(needId('guildId', guildId), Number(id)));

  return {
    add({ guildId, name, phrase, mode, reason, allowPass = false, passDays = 30, createdBy } = {}) {
      const t = now();
      const res = insert.run(needId('guildId', guildId), needId('name', name), needId('phrase', phrase), needId('mode', mode), needId('reason', reason),
        allowPass ? 1 : 0, Number(passDays), needId('createdBy', createdBy), t, t);
      return get(guildId, Number(res.lastInsertRowid));
    },
    get,
    count(guildId) { return count.get(needId('guildId', guildId)).n; },
    /** Terlama dulu (urutan id). enabledOnly = hanya yang aktif. */
    list({ guildId, enabledOnly = false } = {}) {
      const sql = `SELECT * FROM banned_word_rules WHERE guild_id = ?${enabledOnly ? ' AND enabled = 1' : ''} ORDER BY id`;
      return db.prepare(sql).all(needId('guildId', guildId)).map(map);
    },
    /** Ubah sebagian field. Mengembalikan baris baru, atau undefined kalau tidak ditemukan. */
    update(guildId, id, changes = {}) {
      const sets = []; const params = [];
      for (const [key, column] of Object.entries(EDITABLE)) {
        if (changes[key] === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(typeof changes[key] === 'boolean' ? (changes[key] ? 1 : 0) : changes[key]);
      }
      if (!sets.length) return get(guildId, id);
      sets.push('updated_at = ?'); params.push(now());
      const res = db.prepare(`UPDATE banned_word_rules SET ${sets.join(', ')} WHERE guild_id = ? AND id = ?`).run(...params, needId('guildId', guildId), Number(id));
      return res.changes > 0 ? get(guildId, id) : undefined;
    },
    /** Tambah/hapus satu ID dari daftar pengecualian. kind: 'role' | 'channel'. */
    setExempt(guildId, id, kind, targetId, on) {
      const rule = get(guildId, id);
      if (!rule) return undefined;
      const column = kind === 'role' ? 'exempt_roles' : 'exempt_channels';
      const list = new Set(kind === 'role' ? rule.exemptRoles : rule.exemptChannels);
      if (on) list.add(String(targetId)); else list.delete(String(targetId));
      db.prepare(`UPDATE banned_word_rules SET ${column} = ?, updated_at = ? WHERE guild_id = ? AND id = ?`).run(JSON.stringify([...list]), now(), String(guildId), Number(id));
      return get(guildId, id);
    },
    remove(guildId, id) { return remove.run(needId('guildId', guildId), Number(id)).changes > 0; },
  };
}

/** Pass moderasi per aturan. Selalu dibaca dari database (tanpa cache). */
function createPassesRepo(db, { now = Date.now } = {}) {
  const byId = db.prepare('SELECT * FROM moderation_passes WHERE guild_id = ? AND id = ?');
  const expireOld = db.prepare("UPDATE moderation_passes SET status = 'expired' WHERE guild_id = ? AND user_id = ? AND rule_id = ? AND status = 'active' AND expires_at <= ?");
  const activeFor = db.prepare("SELECT * FROM moderation_passes WHERE guild_id = ? AND user_id = ? AND rule_id = ? AND status = 'active' AND expires_at > ?");
  const insert = db.prepare('INSERT INTO moderation_passes (guild_id, user_id, rule_id, source, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  const revoke = db.prepare("UPDATE moderation_passes SET status = 'revoked', revoked_by = ?, revoked_at = ?, revoked_reason = ? WHERE guild_id = ? AND id = ? AND status = 'active'");
  const DAY = 24 * 3600 * 1000;
  const map = (r) => r && ({
    id: r.id, guildId: r.guild_id, userId: r.user_id, ruleId: r.rule_id, source: r.source, status: r.status,
    grantedAt: r.granted_at, expiresAt: r.expires_at, revokedBy: r.revoked_by, revokedAt: r.revoked_at, revokedReason: r.revoked_reason,
  });

  return {
    /** Memberi pass. Kalau sudah ada pass aktif yang belum habis, dikembalikan apa adanya (alreadyActive). */
    grant({ guildId, userId, ruleId, passDays, source = 'challenge' } = {}) {
      const g = needId('guildId', guildId); const u = needId('userId', userId); const t = now();
      expireOld.run(g, u, Number(ruleId), t);
      const existing = activeFor.get(g, u, Number(ruleId), t);
      if (existing) return { row: map(existing), alreadyActive: true };
      const res = insert.run(g, u, Number(ruleId), source, t, t + Number(passDays) * DAY);
      return { row: map(byId.get(g, Number(res.lastInsertRowid))), alreadyActive: false };
    },
    hasActive(guildId, userId, ruleId) {
      return Boolean(activeFor.get(needId('guildId', guildId), needId('userId', userId), Number(ruleId), now()));
    },
    get(guildId, id) { return map(byId.get(needId('guildId', guildId), Number(id))); },
    /** Terbaru dulu. Default hanya yang aktif dan belum habis. */
    list({ guildId, userId, activeOnly = true, limit = 25 } = {}) {
      const where = ['guild_id = ?']; const params = [needId('guildId', guildId)];
      if (userId !== undefined) { where.push('user_id = ?'); params.push(String(userId)); }
      if (activeOnly) { where.push("status = 'active' AND expires_at > ?"); params.push(now()); }
      const cap = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || 25));
      return db.prepare(`SELECT * FROM moderation_passes WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${cap}`).all(...params).map(map);
    },
    revoke({ guildId, id, revokedBy, reason } = {}) {
      const g = needId('guildId', guildId);
      const res = revoke.run(needId('revokedBy', revokedBy), now(), reason ?? null, g, Number(id));
      if (res.changes > 0) return { ok: true, row: map(byId.get(g, Number(id))) };
      return { ok: false, reason: byId.get(g, Number(id)) ? 'already_inactive' : 'not_found' };
    },
  };
}

module.exports = { createSettingsRepo, createAuditRepo, createWarningsRepo, createVerificationRepo, createRulesRepo, createPassesRepo };
