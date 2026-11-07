'use strict';
/**
 * Menjalankan scripts/smoke-real-deps.js dengan stub berbentuk JSON discord.js di folder sementara.
 * Menangkap asersi smoke yang usang (mis. subcommand baru yang belum masuk daftar yang diharapkan)
 * saat `npm test` — kasus nyata yang sebelumnya baru ketahuan di Termux/CI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function copyProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovelia-smoke-'));
  for (const f of ['index.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  return dir;
}
const runSmoke = (dir) => spawnSync(process.execPath, ['-r', './scripts/smoke-stub-preload.js', 'scripts/smoke-real-deps.js'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });

test('smoke: skrip smoke lolos dengan stub berbentuk JSON discord.js', () => {
  const r = runSmoke(copyProject());
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^OK — 4 provider, 11 \+ 5 \+ 1 \+ 1 \+ 1 \+ 1 slash command/m);
});
test('smoke: daftar subcommand yang usang TERDETEKSI (jaring pengaman benar-benar bekerja)', () => {
  const dir = copyProject();
  const file = path.join(dir, 'scripts', 'smoke-real-deps.js');
  const src = fs.readFileSync(file, 'utf8');
  const stale = src.replace("['setup', 'question', 'panel', 'public', 'status']", "['setup', 'question', 'panel', 'status']");
  assert.notEqual(stale, src, 'pola yang diganti harus ada');
  fs.writeFileSync(file, stale);
  const r = runSmoke(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /AssertionError/);
});
