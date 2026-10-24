'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

/**
 * Membuat salinan database yang konsisten (API backup SQLite) lalu mengompresnya
 * dengan gzip. File sementara dibuat di <folder database>/backups; PEMANGGIL wajib
 * menghapus hasilnya setelah dipakai. Memulihkan: hentikan bot, lalu
 *   gunzip -c ovelia-XXXX.sqlite.gz > data/ovelia.sqlite
 */
const STALE_AFTER_MS = 60 * 60 * 1000;
const OWN_FILE = /^ovelia-\d{8}-\d{6}\.sqlite(\.gz|\.tmp)?$/;

/** Hapus sisa berkas backup lama (proses macet / bot crash). Hanya berkas bernama ovelia-*.sqlite[.gz|.tmp]. */
function pruneStaleFiles(dir, nowMs) {
  for (const name of fs.readdirSync(dir)) {
    if (!OWN_FILE.test(name)) continue;
    const file = path.join(dir, name);
    try { if (nowMs - fs.statSync(file).mtimeMs > STALE_AFTER_MS) fs.rmSync(file, { force: true }); } catch { /* abaikan */ }
  }
}

async function createCompressedBackup(db, { now = Date.now } = {}) {
  if (!db.path || db.path === ':memory:') throw new Error('backup tidak didukung untuk database di memori');
  const dir = path.join(path.dirname(db.path), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  pruneStaleFiles(dir, now());

  const stamp = new Date(now()).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  const rawPath = path.join(dir, `ovelia-${stamp}.sqlite`);
  const gzPath = `${rawPath}.gz`;
  try {
    await db.backupTo(rawPath);
    await pipeline(fs.createReadStream(rawPath), zlib.createGzip(), fs.createWriteStream(gzPath));
    return { path: gzPath, name: path.basename(gzPath), bytes: fs.statSync(gzPath).size };
  } catch (err) {
    fs.rmSync(gzPath, { force: true });
    throw err;
  } finally {
    fs.rmSync(rawPath, { force: true });
  }
}

module.exports = { createCompressedBackup };
