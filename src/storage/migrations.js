'use strict';

/**
 * Migrasi skema SQLite. Versi disimpan di PRAGMA user_version.
 * ATURAN: jangan pernah mengubah migrasi yang sudah dirilis — tambahkan migrasi
 * baru dengan nomor berikutnya. Waktu disimpan sebagai epoch milidetik.
 * ID Discord disimpan sebagai TEXT (snowflake melebihi batas aman angka JS).
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'guild_settings + moderation_logs',
    sql: `
      CREATE TABLE guild_settings (
        guild_id   TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        value      TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, key)
      ) STRICT;

      -- Satu tabel log = audit trail seluruh fitur moderasi.
      -- JANGAN menyimpan jawaban rahasia verification di kolom details.
      CREATE TABLE moderation_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT    NOT NULL,
        action     TEXT    NOT NULL,
        actor_id   TEXT,
        target_id  TEXT,
        reason     TEXT,
        status     TEXT    NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed', 'partial')),
        details    TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX idx_modlogs_guild_time ON moderation_logs (guild_id, created_at DESC);
      CREATE INDEX idx_modlogs_target     ON moderation_logs (guild_id, target_id, created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'warnings',
    sql: `
      -- status 'expired' disiapkan sekarang agar tidak perlu membangun ulang tabel
      -- (SQLite tidak bisa mengubah CHECK); logika kedaluwarsa belum diimplementasikan.
      CREATE TABLE warnings (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id       TEXT    NOT NULL,
        user_id        TEXT    NOT NULL,
        moderator_id   TEXT    NOT NULL,
        reason         TEXT    NOT NULL,
        created_at     INTEGER NOT NULL,
        status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'expired')),
        removed_by     TEXT,
        removed_at     INTEGER,
        removed_reason TEXT
      ) STRICT;
      CREATE INDEX idx_warnings_user ON warnings (guild_id, user_id, status, created_at DESC);
    `,
  },
];

module.exports = { MIGRATIONS };
