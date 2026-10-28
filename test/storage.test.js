'use strict';
/**
 * Tes lapisan penyimpanan (tahap 1). Memakai node:sqlite ASLI (bawaan Node) dengan
 * file di folder sementara — bukan stub — jadi persistensi, transaksi, rollback,
 * migrasi, WAL, dan backup benar-benar diuji.
 * Tidak mencakup: perilaku di filesystem Wispbyte (harus diuji di sana).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/storage/db');
const { MIGRATIONS } = require('../src/storage/migrations');
const { createSettingsRepo, createAuditRepo } = require('../src/storage/repositories');
const { initStorage } = require('../src/storage');
const { TtlStore } = require('../src/core/ttlStore');
const { createCompressedBackup } = require('../src/storage/backup');

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovelia-db-'));
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const silentLog = () => { const out = { logs: [], errors: [] }; out.log = (m) => out.logs.push(m); out.error = (m) => out.errors.push(m); return out; };

/* ---------------- migrasi & pembukaan database ---------------- */
test('db: database baru dimigrasi ke versi terbaru, tabel ada, journal WAL', () => {
  const db = openDatabase(path.join(tmpDir(), 'a.sqlite'));
  assert.equal(db.schemaVersion, MIGRATIONS[MIGRATIONS.length - 1].version);
  assert.deepEqual(tables(db), ['banned_word_rules', 'guild_settings', 'moderation_logs', 'moderation_passes', 'verification_records', 'warnings']);
  assert.equal(db.journalMode, 'wal');
  db.close();
});
test('db: membuka ulang database yang sudah dimigrasi tidak mengulang migrasi', () => {
  const p = path.join(tmpDir(), 'b.sqlite');
  openDatabase(p).close();
  const again = openDatabase(p);
  assert.equal(again.schemaVersion, MIGRATIONS[MIGRATIONS.length - 1].version);
  again.close();
});
test('db: database dari versi kode yang lebih baru ditolak', () => {
  const p = path.join(tmpDir(), 'c.sqlite');
  const db = openDatabase(p); db.exec('PRAGMA user_version = 99'); db.close();
  assert.throws(() => openDatabase(p), /lebih baru daripada kode/);
});
test('db: migrasi yang gagal di-rollback seluruhnya (tidak ada tabel setengah jadi)', () => {
  const p = path.join(tmpDir(), 'd.sqlite');
  const good = { version: 1, name: 'ok', sql: 'CREATE TABLE a (x TEXT) STRICT;' };
  const bad = { version: 2, name: 'rusak', sql: 'CREATE TABLE b (x TEXT) STRICT; INSERT INTO tidak_ada VALUES (1);' };
  assert.throws(() => openDatabase(p, { migrations: [good, bad] }), /migrasi 2 \(rusak\) gagal/);
  const db = openDatabase(p, { migrations: [good] });
  assert.equal(db.schemaVersion, 1);
  assert.deepEqual(tables(db), ['a']);
  db.close();
});

/* ---------------- persistensi ---------------- */
test('persistensi: data tetap ada setelah database ditutup dan dibuka ulang', () => {
  const p = path.join(tmpDir(), 'e.sqlite');
  let db = openDatabase(p);
  createSettingsRepo(db).set('G1', 'verify.timeoutSec', 120);
  const id = createAuditRepo(db).log({ guildId: 'G1', action: 'warn', actorId: 'M1', targetId: 'U1', reason: 'spam' });
  db.close();

  db = openDatabase(p);
  assert.equal(createSettingsRepo(db).get('G1', 'verify.timeoutSec'), 120);
  const [row] = createAuditRepo(db).list({ guildId: 'G1' });
  assert.equal(row.id, id);
  assert.equal(row.reason, 'spam');
  db.close();
});
test('persistensi: dua koneksi ke file yang sama saling melihat data (WAL)', () => {
  const p = path.join(tmpDir(), 'f.sqlite');
  const a = openDatabase(p); const b = openDatabase(p);
  createSettingsRepo(a).set('G1', 'k', { x: 1 });
  assert.deepEqual(createSettingsRepo(b).get('G1', 'k'), { x: 1 });
  a.close(); b.close();
});

/* ---------------- settings ---------------- */
test('settings: set/get/update/delete, fallback, isolasi antar server, getAll', () => {
  const db = openDatabase(':memory:'); const s = createSettingsRepo(db, { now: () => 1000 });
  assert.equal(s.get('G1', 'a', 'default'), 'default');
  s.set('G1', 'a', 1); s.set('G1', 'b', { list: [1, 2] }); s.set('G2', 'a', 'lain');
  assert.equal(s.get('G1', 'a'), 1);
  s.set('G1', 'a', 2);
  assert.equal(s.get('G1', 'a'), 2);
  assert.deepEqual(s.getAll('G1'), { a: 2, b: { list: [1, 2] } });
  assert.equal(s.get('G2', 'a'), 'lain');
  assert.equal(s.delete('G1', 'a'), true);
  assert.equal(s.delete('G1', 'a'), false);
  assert.equal(s.get('G1', 'a'), undefined);
  assert.throws(() => s.set('G1', 'x', undefined), /undefined/);
  assert.throws(() => s.get('', 'x'), /guildId wajib/);
  db.close();
});

/* ---------------- audit log ---------------- */
test('audit: log + list terbaru dulu, filter, paginasi, JSON details, jam yang disuntik', () => {
  let clock = 5000;
  const db = openDatabase(':memory:'); const a = createAuditRepo(db, { now: () => clock++ });
  const id1 = a.log({ guildId: 'G1', action: 'warn', actorId: 'M1', targetId: 'U1', reason: 'r1', details: { rule: 7 } });
  const id2 = a.log({ guildId: 'G1', action: 'ban', actorId: 'M2', targetId: 'U2', status: 'partial' });
  const id3 = a.log({ guildId: 'G1', action: 'warn', actorId: 'M1', targetId: 'U2' });
  a.log({ guildId: 'G2', action: 'warn', targetId: 'U1' });
  assert.ok(id1 < id2 && id2 < id3);
  assert.deepEqual(a.list({ guildId: 'G1' }).map((r) => r.id), [id3, id2, id1]);
  assert.deepEqual(a.list({ guildId: 'G1', targetId: 'U2' }).map((r) => r.id), [id3, id2]);
  assert.deepEqual(a.list({ guildId: 'G1', actorId: 'M1', action: 'warn' }).map((r) => r.id), [id3, id1]);
  assert.deepEqual(a.list({ guildId: 'G1', beforeId: id3, limit: 1 }).map((r) => r.id), [id2]);
  const first = a.list({ guildId: 'G1' }).at(-1);
  assert.deepEqual(first.details, { rule: 7 });
  assert.equal(first.createdAt, 5000);
  assert.equal(a.list({ guildId: 'G1' })[1].status, 'partial');
  assert.equal(a.list({ guildId: 'G2' }).length, 1);
  db.close();
});
test('audit: validasi masukan dan ID Discord disimpan sebagai teks tanpa kehilangan presisi', () => {
  const db = openDatabase(':memory:'); const a = createAuditRepo(db);
  assert.throws(() => a.log({ guildId: 'G1', action: 'x', status: 'sukses' }), /status tidak valid/);
  assert.throws(() => a.log({ action: 'x' }), /guildId wajib/);
  assert.throws(() => a.log({ guildId: 'G1' }), /action wajib/);
  const big = '1091901409668124805';
  a.log({ guildId: big, action: 'warn', targetId: big });
  assert.equal(a.list({ guildId: big })[0].targetId, big);
  db.close();
});

/* ---------------- transaksi & kegagalan ---------------- */
test('transaksi: commit saat sukses, rollback + error diteruskan saat gagal, DB tetap bisa dipakai', () => {
  const db = openDatabase(':memory:'); const s = createSettingsRepo(db); const a = createAuditRepo(db);
  db.transaction(() => { s.set('G1', 'k', 1); a.log({ guildId: 'G1', action: 'ok' }); });
  assert.equal(s.get('G1', 'k'), 1);

  assert.throws(() => db.transaction(() => { s.set('G1', 'k', 2); a.log({ guildId: 'G1', action: 'tx' }); throw new Error('boom'); }), /boom/);
  assert.equal(s.get('G1', 'k'), 1, 'perubahan harus dibatalkan');
  assert.equal(a.list({ guildId: 'G1' }).length, 1, 'log dalam transaksi gagal harus dibatalkan');

  db.transaction(() => { db.transaction(() => s.set('G1', 'n', 'bersarang')); });
  assert.equal(s.get('G1', 'n'), 'bersarang');
  s.set('G1', 'k', 3);
  assert.equal(s.get('G1', 'k'), 3);
  db.close();
});
test('kegagalan: penulisan ke database yang sudah ditutup MELEMPAR error (tidak sukses palsu)', () => {
  const db = openDatabase(':memory:'); const s = createSettingsRepo(db); const a = createAuditRepo(db);
  db.close();
  assert.throws(() => s.set('G1', 'k', 1));
  assert.throws(() => a.log({ guildId: 'G1', action: 'x' }));
});
test('initStorage: sukses mencatat status; gagal mengembalikan null dan TIDAK melempar', () => {
  const dir = tmpDir(); const ok = silentLog();
  const st = initStorage({ dbPath: path.join(dir, 'x', 'ok.sqlite'), log: ok });
  assert.ok(st && st.db && st.settings && st.audit);
  assert.match(ok.logs[0], new RegExp(`\\[DB\\] SQLite siap: .*ok\\.sqlite \\(schema v${LATEST}, journal=wal, start ke-1\\)`));
  st.audit.log({ guildId: 'G1', action: 'a' });
  st.close();

  // Penghitung start persisten: pembukaan berikutnya pada file yang sama = start ke-2, ke-3.
  const again = silentLog();
  const st2 = initStorage({ dbPath: path.join(dir, 'x', 'ok.sqlite'), log: again });
  assert.match(again.logs[0], /start ke-2\)/);
  assert.equal(st2.audit.list({ guildId: 'G1' }).length, 1, 'data lama tetap ada');
  st2.close();
  const third = silentLog(); initStorage({ dbPath: path.join(dir, 'x', 'ok.sqlite'), log: third }).close();
  assert.match(third.logs[0], /start ke-3\)/);

  const asFile = path.join(dir, 'bukan-folder'); fs.writeFileSync(asFile, 'x');
  const bad = silentLog();
  assert.equal(initStorage({ dbPath: path.join(asFile, 'db.sqlite'), log: bad }), null);
  assert.match(bad.errors[0], /\[DB\] Gagal membuka database .*fitur AI tetap berjalan/);

  const mem = silentLog();
  const m = initStorage({ dbPath: ':memory:', log: mem }); assert.ok(m); m.close();
});

/* ---------------- backup ---------------- */
test('backup: salinan konsisten yang bisa dibuka dan berisi data, tanpa file .tmp tersisa', async () => {
  const dir = tmpDir(); const db = openDatabase(path.join(dir, 'src.sqlite'));
  createSettingsRepo(db).set('G1', 'k', 'nilai');
  for (let i = 0; i < 50; i++) createAuditRepo(db).log({ guildId: 'G1', action: `a${i}` });
  const dest = path.join(dir, 'backups', 'salinan.sqlite');
  assert.equal(await db.backupTo(dest), dest);
  assert.ok(!fs.existsSync(`${dest}.tmp`));

  const copy = openDatabase(dest);
  assert.equal(createSettingsRepo(copy).get('G1', 'k'), 'nilai');
  assert.equal(createAuditRepo(copy).list({ guildId: 'G1', limit: 200 }).length, 50);
  copy.close();
  createSettingsRepo(db).set('G1', 'k', 'berubah'); // sumber tetap bisa ditulis setelah backup
  assert.equal(createSettingsRepo(db).get('G1', 'k'), 'berubah');
  db.close();
});

/* ---------------- TtlStore ---------------- */
test('TtlStore: kedaluwarsa, ttlRemaining, overwrite me-reset TTL, delete, ttl tidak valid ditolak', () => {
  let t = 1000; const s = new TtlStore({ now: () => t });
  s.set('sesi', { q: 1 }, 120000);
  assert.deepEqual(s.get('sesi'), { q: 1 });
  assert.equal(s.ttlRemaining('sesi'), 120000);
  t += 119999; assert.equal(s.has('sesi'), true);
  t += 1;      assert.equal(s.get('sesi'), undefined, 'tepat pada batas waktu sudah kedaluwarsa');
  assert.equal(s.ttlRemaining('sesi'), 0);

  s.set('k', 1, 1000); t += 900; s.set('k', 2, 1000); t += 900;
  assert.equal(s.get('k'), 2, 'overwrite harus memperpanjang umur');
  assert.equal(s.delete('k'), true); assert.equal(s.get('k'), undefined);
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.throws(() => s.set('x', 1, bad), RangeError);
});
test('TtlStore: size/sweep membuang yang kedaluwarsa; maxEntries membuang yang tertua', () => {
  let t = 0; const s = new TtlStore({ now: () => t, maxEntries: 3 });
  s.set('a', 1, 10); s.set('b', 2, 100); t = 50;
  assert.equal(s.size, 1);
  s.set('c', 3, 100); s.set('d', 4, 100); s.set('e', 5, 100);
  assert.equal(s.size, 3);
  assert.equal(s.get('b'), undefined, 'entri tertua dibuang saat penuh');
  assert.equal(s.get('e'), 5);
});
test('TtlStore: sweeper berkala tidak menahan proses tetap hidup (unref) dan bisa dihentikan', () => {
  const s = new TtlStore().startSweeper(1000);
  assert.equal(s._timer.hasRef(), false);
  assert.equal(s.startSweeper(1000), s, 'idempoten');
  s.stop(); assert.equal(s._timer, null);
});

test('createCompressedBackup: nama berkas benar, isi gzip bisa dipulihkan, sisa berkas lama dibersihkan, berkas lain aman', async () => {
  const dir = tmpDir(); const db = openDatabase(path.join(dir, 'x.sqlite'));
  createSettingsRepo(db).set('G1', 'k', 'isi');
  const bdir = path.join(dir, 'backups'); fs.mkdirSync(bdir);
  const old = path.join(bdir, 'ovelia-20200101-000000.sqlite.gz'); const oldTmp = path.join(bdir, 'ovelia-20200101-000000.sqlite.tmp');
  const other = path.join(bdir, 'catatan.txt'); const fresh = path.join(bdir, 'ovelia-20991231-235959.sqlite.gz');
  for (const f of [old, oldTmp, other, fresh]) fs.writeFileSync(f, 'x');
  const past = new Date(Date.now() - 2 * 3600 * 1000);
  for (const f of [old, oldTmp, other]) fs.utimesSync(f, past, past);

  const b = await createCompressedBackup(db);
  assert.match(b.name, /^ovelia-\d{8}-\d{6}\.sqlite\.gz$/);
  assert.ok(b.bytes > 0 && fs.existsSync(b.path));
  assert.ok(!fs.existsSync(old) && !fs.existsSync(oldTmp), 'sisa berkas lama harus dibersihkan');
  assert.ok(fs.existsSync(other) && fs.existsSync(fresh), 'berkas lain / yang masih baru tidak boleh dihapus');

  const restored = path.join(dir, 'pulih.sqlite'); fs.writeFileSync(restored, require('node:zlib').gunzipSync(fs.readFileSync(b.path)));
  const copy = openDatabase(restored); assert.equal(createSettingsRepo(copy).get('G1', 'k'), 'isi'); copy.close(); db.close();
  await assert.rejects(() => createCompressedBackup(openDatabase(':memory:')), /tidak didukung untuk database di memori/);
});
