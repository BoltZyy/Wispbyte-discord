'use strict';

const path = require('path');
const { ROOT_DIR } = require('./files');
const { openDatabase } = require('./db');
const { createSettingsRepo, createAuditRepo, createWarningsRepo, createVerificationRepo, createRulesRepo } = require('./repositories');

/**
 * Membuka database SQLite dan membuat repository. TIDAK PERNAH melempar error:
 * kalau gagal (Node terlalu lama, disk bermasalah, dll.) mengembalikan null dan
 * mencatat error — fitur AI Ovelia tetap berjalan, hanya fitur yang butuh
 * database yang nonaktif.
 *
 * Lokasi: env DB_PATH (relatif terhadap root proyek) atau data/ovelia.sqlite.
 * Folder data/ dan file *.sqlite TIDAK boleh masuk Git (lihat .gitignore).
 */
function initStorage({ dbPath = process.env.DB_PATH || path.join('data', 'ovelia.sqlite'), log = console } = {}) {
  const resolved = dbPath === ':memory:' ? dbPath : path.resolve(ROOT_DIR, dbPath);
  let db;
  try {
    db = openDatabase(resolved);
    const settings = createSettingsRepo(db);
    // Penghitung start tersimpan di database: angka yang terus naik di log membuktikan
    // file database benar-benar persisten di hosting (restart maupun deploy ulang).
    const boots = settings.get('_system', 'boot_count', 0) + 1;
    settings.set('_system', 'boot_count', boots);
    log.log(`[DB] SQLite siap: ${resolved} (schema v${db.schemaVersion}, journal=${db.journalMode}, start ke-${boots})`);
    return { db, settings, audit: createAuditRepo(db), warnings: createWarningsRepo(db), verification: createVerificationRepo(db), rules: createRulesRepo(db), close: () => db.close() };
  } catch (err) {
    try { db?.close(); } catch { /* abaikan */ }
    log.error(`[DB] Gagal membuka database (${resolved}): ${err.message} — fitur yang butuh database dinonaktifkan; fitur AI tetap berjalan.`);
    return null;
  }
}

module.exports = { initStorage };
