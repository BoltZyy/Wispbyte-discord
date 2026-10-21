'use strict';

const fs = require('fs');
const path = require('path');
const { MIGRATIONS } = require('./migrations');

/**
 * Lapisan tipis di atas node:sqlite (bawaan Node >= 22.13; backup() >= 22.16).
 * Dibuat sebagai adaptor supaya driver bisa diganti tanpa menyentuh repository.
 * node:sqlite di-require secara malas, jadi bot tetap bisa start (tanpa fitur
 * database) di Node yang tidak punya modul ini.
 */

function applyMigrations(db, migrations) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  if (current > latest) {
    throw new Error(`database versi ${current} lebih baru daripada kode (maks ${latest}) — jangan buka dengan versi bot yang lebih lama`);
  }
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${Number(m.version)}`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* sudah tidak dalam transaksi */ }
      throw new Error(`migrasi ${m.version} (${m.name}) gagal: ${err.message}`);
    }
  }
  return Math.max(current, latest);
}

function openDatabase(dbPath, { migrations = MIGRATIONS } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const raw = new DatabaseSync(dbPath);
  let inTransaction = false;

  try {
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('PRAGMA busy_timeout = 5000');
    const journalMode = raw.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
    raw.exec('PRAGMA synchronous = NORMAL');
    const schemaVersion = applyMigrations(raw, migrations);

    return {
      raw,
      path: dbPath,
      journalMode,
      schemaVersion,
      prepare: (sql) => raw.prepare(sql),
      exec: (sql) => raw.exec(sql),

      /**
       * Jalankan fn dalam satu transaksi: commit kalau selesai, rollback kalau
       * melempar error (error diteruskan). Transaksi bersarang bergabung ke
       * transaksi luar.
       */
      transaction(fn) {
        if (inTransaction) return fn();
        raw.exec('BEGIN IMMEDIATE');
        inTransaction = true;
        try {
          const result = fn();
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          try { raw.exec('ROLLBACK'); } catch { /* abaikan */ }
          throw err;
        } finally {
          inTransaction = false;
        }
      },

      /** Salinan konsisten database (aman saat bot sedang menulis). */
      async backupTo(destPath) {
        const { backup } = require('node:sqlite');
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const tmp = `${destPath}.tmp`;
        try { fs.unlinkSync(tmp); } catch { /* tidak ada */ }
        await backup(raw, tmp);
        fs.renameSync(tmp, destPath);
        return destPath;
      },

      close() { raw.close(); },
    };
  } catch (err) {
    try { raw.close(); } catch { /* abaikan */ }
    throw err;
  }
}

module.exports = { openDatabase };
