'use strict';
/**
 * Tes /banned-word (tahap 4): pengelolaan aturan, pengecualian, uji, cache evaluasi.
 * Database = node:sqlite ASLI; discord.js dan objek Discord = fake. Pesan TIDAK dihapus di tahap ini.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function recorder() {
  const trace = [];
  const ser = (a) => { if (typeof a === 'function') { const c = recorder(); a(c); return { cb: c.toJSON() }; } return typeof a === 'bigint' ? `${a}n` : a; };
  const proxy = new Proxy({}, { get: (_t, k) => (k === 'toJSON' ? () => trace : (...args) => { trace.push([String(k), args.map(ser)]); return proxy; }) });
  return proxy;
}
const P = { Administrator: 1n << 3n, ManageGuild: 1n << 5n, ModerateMembers: 1n << 40n };
const discordStub = { SlashCommandBuilder: class { constructor() { return recorder(); } }, PermissionFlagsBits: P, ChannelType: { GuildText: 0, GuildAnnouncement: 5 }, MessageFlags: { Ephemeral: 64 } };
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'discord.js' ? discordStub : origLoad.call(this, request, ...rest); };

const { buildBannedWordCommandList, createBannedWords } = require('../src/discord/bannedWords');
const { initStorage } = require('../src/storage');
const { openDatabase } = require('../src/storage/db');
const { createRulesRepo } = require('../src/storage/repositories');

const silent = { log() {}, warn() {}, error() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovelia-bw-'));
const perms = (...flags) => { const bits = flags.reduce((a, f) => a | f, 0n); const admin = (bits & P.Administrator) !== 0n; return { has: (f) => (Array.isArray(f) ? f : [f]).every((x) => admin || (bits & x) === x) }; };

function world(opts = {}) {
  const storage = opts.nullStorage ? null : initStorage({ dbPath: path.join(tmpDir(), 'b.sqlite'), log: silent });
  const errors = [];
  const bw = createBannedWords({ storage, log: { ...silent, error: (m) => errors.push(m) }, ...opts.bw });
  const guild = { id: 'G1' };
  const call = async (sub, o = {}, { perm = perms(P.ManageGuild), guildObj = guild, inGuild = true } = {}) => {
    const calls = { reply: [] };
    const i = {
      commandName: 'banned-word', user: { id: 'ADMIN' }, guild: guildObj, memberPermissions: perm, replied: false, deferred: false, calls,
      isChatInputCommand: () => true, inGuild: () => inGuild,
      options: {
        getSubcommand: () => sub,
        getString: (n) => o[n] ?? null, getInteger: (n) => o[n] ?? null, getBoolean: (n) => o[n] ?? null, getRole: (n) => o[n], getChannel: (n) => o[n],
      },
      reply: async (x) => { calls.reply.push(x); i.replied = true; }, editReply: async (x) => { calls.reply.push(x); },
    };
    const handled = await bw.handle(i);
    return { i, handled, said: calls.reply.at(-1)?.content, flags: calls.reply[0]?.flags };
  };
  const add = (extra = {}) => call('add', { name: 'Anti-Scam', phrase: 'check my bio', reason: 'Promosi mencurigakan', mode: 'evasion', ...extra });
  return { storage, bw, call, add, errors };
}
const actions = (storage) => storage.audit.list({ guildId: 'G1', limit: 200 }).map((r) => r.action).reverse();

/* ---------------- definisi ---------------- */
test('command: definisi /banned-word identik dengan golden dan subcommand lengkap', () => {
  const list = buildBannedWordCommandList();
  const goldenPath = path.join(__dirname, 'fixtures', 'banned-word-commands.golden.json');
  const actual = JSON.stringify(list, null, 2) + '\n';
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(goldenPath, actual);
  assert.equal(actual, fs.readFileSync(goldenPath, 'utf8'));
  const subs = list[0].filter((e) => e[0] === 'addSubcommand').map((e) => e[1][0].cb.find((x) => x[0] === 'setName')[1][0]);
  assert.deepEqual(subs, ['add', 'edit', 'remove', 'list', 'test', 'exempt-role', 'exempt-channel']);
});
test('handle: bukan /banned-word diabaikan; DM, tanpa izin, dan database nonaktif ditolak jelas', async () => {
  const w = world();
  assert.equal(await w.bw.handle({ isChatInputCommand: () => true, commandName: 'warn' }), false);
  assert.equal(await w.bw.handle({ isChatInputCommand: () => false }), false);
  assert.match((await w.call('list', {}, { inGuild: false })).said, /hanya bisa dipakai di server/);
  for (const sub of ['add', 'edit', 'remove', 'list', 'test', 'exempt-role', 'exempt-channel']) {
    const r = await w.call(sub, { name: 'x', phrase: 'halo dunia', reason: 'r', id: 1, text: 't', role: { id: 'R' }, channel: { id: 'C', guildId: 'G1' } }, { perm: perms(P.ModerateMembers) });
    assert.match(r.said, /tidak punya izin/, sub);
  }
  assert.equal(w.storage.rules.count('G1'), 0);
  const off = world({ nullStorage: true });
  assert.match((await off.call('list')).said, /nonaktif: database tidak tersedia/);
  assert.deepEqual(off.bw.evaluate('G1', 'apa saja'), []);
});

/* ---------------- add ---------------- */
test('add: default mode exact, tanpa pass, 30 hari; balasan ephemeral; audit TIDAK memuat frasa', async () => {
  const w = world();
  const r = await w.call('add', { name: 'Promo', phrase: 'free nitro', reason: 'Promosi' });
  assert.equal(r.flags, 64);
  assert.match(r.said, /Aturan dibuat:.*#1 \*\*Promo\*\* • exact • aktif • pass: tidak.*free nitro.*\/banned-word test/s);
  const rule = w.storage.rules.get('G1', 1);
  assert.deepEqual([rule.mode, rule.allowPass, rule.passDays, rule.enabled, rule.createdBy], ['exact', false, 30, true, 'ADMIN']);
  const log = w.storage.audit.list({ guildId: 'G1' })[0];
  assert.deepEqual([log.action, log.actorId, log.details.ruleId, log.details.mode], ['banned_word_add', 'ADMIN', 1, 'exact']);
  assert.ok(!JSON.stringify(log).includes('free nitro'), 'frasa tidak ikut ke audit log');
});
test('add: opsi pass, evasion, validasi frasa/mode, nama dan alasan kosong, batas jumlah aturan', async () => {
  const w = world({ bw: { maxRulesPerGuild: 2 } });
  const ok = await w.add({ 'allow-pass': true, 'pass-days': 7 });
  assert.match(ok.said, /evasion • aktif • pass: 7 hari/);
  for (const [extra, re] of [
    [{ phrase: 'ab' }, /minimal 3/], [{ phrase: 'x'.repeat(101) }, /maksimal 100/], [{ mode: 'regex' }, /regex belum didukung/],
    [{ name: '   ' }, /Nama dan alasan/], [{ reason: ' ' }, /Nama dan alasan/],
  ]) { const r = await w.add(extra); assert.match(r.said, re); }
  assert.equal(w.storage.rules.count('G1'), 1, 'penolakan tidak boleh menyimpan apa pun');
  await w.add({ name: 'Kedua', phrase: 'free nitro', mode: 'exact' });
  assert.match((await w.add({ name: 'Ketiga', phrase: 'lain lagi' })).said, /Batas 2 aturan/);
});

/* ---------------- edit / remove / list ---------------- */
test('edit: ubah sebagian field, audit mencatat NAMA field, validasi gabungan, tidak ada perubahan', async () => {
  const w = world(); await w.add();
  assert.match((await w.call('edit', { id: 1 })).said, /Tidak ada yang diubah/);
  assert.match((await w.call('edit', { id: 99, name: 'x' })).said, /#99 tidak ditemukan/);

  const r = await w.call('edit', { id: 1, name: 'Promo Baru', 'pass-days': 14, 'allow-pass': true, enabled: false });
  assert.match(r.said, /\*\*Promo Baru\*\* • evasion • NONAKTIF • pass: 14 hari/);
  const rule = w.storage.rules.get('G1', 1);
  assert.deepEqual([rule.name, rule.enabled, rule.allowPass, rule.passDays, rule.phrase], ['Promo Baru', false, true, 14, 'check my bio']);
  const log = w.storage.audit.list({ guildId: 'G1', action: 'banned_word_edit' })[0];
  assert.deepEqual(log.details.fields.sort(), ['allowPass', 'enabled', 'name', 'passDays']);

  // kombinasi tidak valid: frasa 2 huruf + mode evasion -> ditolak dan tidak mengubah apa pun
  assert.match((await w.call('edit', { id: 1, phrase: 'ab' })).said, /minimal 3/);
  assert.match((await w.call('edit', { id: 1, mode: 'regex' })).said, /regex belum didukung/);
  assert.match((await w.call('edit', { id: 1, name: ' ' })).said, /tidak boleh kosong/);
  assert.equal(w.storage.rules.get('G1', 1).phrase, 'check my bio');
  const ex = world(); await ex.add({ phrase: 'free nitro', mode: 'exact' });
  assert.match((await ex.call('edit', { id: 1, mode: 'exact', phrase: 'a' })).said, /minimal 2/);
});
test('remove + list: aturan hilang, audit tercatat, aturan server lain tidak terlihat/terhapus', async () => {
  const w = world(); await w.add(); await w.add({ name: 'Kedua', phrase: 'free nitro', mode: 'exact' });
  const other = w.storage.rules.add({ guildId: 'G2', name: 'Lain', phrase: 'rahasia lain', mode: 'exact', reason: 'x', createdBy: 'X' });
  const list = await w.call('list');
  assert.match(list.said, /Aturan kata terlarang\*\* \(2\)/); assert.ok(!list.said.includes('rahasia lain'));
  assert.match((await w.call('remove', { id: 99 })).said, /tidak ditemukan/);
  assert.match((await w.call('remove', { id: other.id })).said, /tidak ditemukan/, 'tidak bisa menghapus aturan server lain');
  assert.equal(w.storage.rules.get('G2', other.id).name, 'Lain');
  assert.match((await w.call('remove', { id: 1 })).said, /#1 \(Anti-Scam\) dihapus/);
  assert.equal(w.storage.rules.count('G1'), 1);
  assert.ok(actions(w.storage).includes('banned_word_remove'));
  assert.match((await world().call('list')).said, /Belum ada aturan/);
});

/* ---------------- test ---------------- */
test('test: menampilkan cocok/tidak, memfilter per id, menandai nonaktif, tidak mengubah apa pun', async () => {
  const w = world(); await w.add(); await w.add({ name: 'Promo', phrase: 'free nitro', mode: 'exact' });
  await w.call('edit', { id: 2, enabled: false });
  const before = JSON.stringify(w.storage.db.prepare('SELECT * FROM banned_word_rules').all());
  const hit = await w.call('test', { text: 'ch3ck my b1o dong, free nitro' });
  assert.match(hit.said, /tidak ada pesan yang dihapus/);
  assert.match(hit.said, /#1 Anti-Scam \(evasion\): 🔴 COCOK/); assert.match(hit.said, /#2 Promo \(exact, NONAKTIF\): 🔴 COCOK/);
  assert.match((await w.call('test', { text: 'Halo semuanya', id: 1 })).said, /#1.*🟢 tidak cocok/);
  assert.match((await w.call('test', { text: 'x', id: 99 })).said, /#99 tidak ditemukan/);
  assert.match((await world().call('test', { text: 'x' })).said, /Belum ada aturan/);
  assert.equal(JSON.stringify(w.storage.db.prepare('SELECT * FROM banned_word_rules').all()), before);
});

/* ---------------- pengecualian ---------------- */
test('exempt-role / exempt-channel: tambah, cabut, batas 20, channel server lain ditolak, aturan tak ada', async () => {
  const w = world(); await w.add();
  assert.match((await w.call('exempt-role', { id: 1, role: { id: 'R1' } })).said, /<@&R1> dikecualikan dari aturan #1/);
  assert.match((await w.call('exempt-channel', { id: 1, channel: { id: 'C1', guildId: 'G1' } })).said, /<#C1> dikecualikan/);
  assert.deepEqual([w.storage.rules.get('G1', 1).exemptRoles, w.storage.rules.get('G1', 1).exemptChannels], [['R1'], ['C1']]);
  await w.call('exempt-role', { id: 1, role: { id: 'R1' } }); // idempoten
  assert.deepEqual(w.storage.rules.get('G1', 1).exemptRoles, ['R1']);
  assert.match((await w.call('exempt-role', { id: 1, role: { id: 'R1' }, remove: true })).said, /Pengecualian <@&R1> dicabut/);
  assert.deepEqual(w.storage.rules.get('G1', 1).exemptRoles, []);
  assert.match((await w.call('exempt-channel', { id: 1, channel: { id: 'C9', guildId: 'G2' } })).said, /channel di server ini/);
  assert.match((await w.call('exempt-role', { id: 77, role: { id: 'R1' } })).said, /#77 tidak ditemukan/);
  for (let n = 0; n < 20; n++) await w.call('exempt-role', { id: 1, role: { id: `RR${n}` } });
  assert.match((await w.call('exempt-role', { id: 1, role: { id: 'RX' } })).said, /Maksimal 20/);
  assert.equal(w.storage.rules.get('G1', 1).exemptRoles.length, 20);
  assert.ok(actions(w.storage).includes('banned_word_exempt'));
});

/* ---------------- evaluasi (dipakai tahap 5) ---------------- */
test('evaluate: hanya aturan aktif, pengecualian role/channel dihormati, isolasi server', async () => {
  const w = world();
  await w.add(); await w.add({ name: 'Promo', phrase: 'free nitro', mode: 'exact', 'allow-pass': true, 'pass-days': 10 });
  await w.call('exempt-role', { id: 1, role: { id: 'STAFF' } });
  await w.call('exempt-channel', { id: 2, channel: { id: 'CH_OK', guildId: 'G1' } });
  const text = 'CH3CK my b1o and FREE nitro!';
  assert.deepEqual(w.bw.evaluate('G1', text, { roleIds: [], channelId: 'CH_X' }).map((r) => r.id), [1, 2]);
  assert.deepEqual(w.bw.evaluate('G1', text, { roleIds: ['STAFF'], channelId: 'CH_X' }).map((r) => r.id), [2], 'role STAFF dikecualikan dari aturan 1');
  assert.deepEqual(w.bw.evaluate('G1', text, { roleIds: [], channelId: 'CH_OK' }).map((r) => r.id), [1], 'channel dikecualikan dari aturan 2');
  assert.deepEqual(w.bw.evaluate('G1', text, { roleIds: ['STAFF'], channelId: 'CH_OK' }), []);
  assert.deepEqual(w.bw.evaluate('G2', text), [], 'server lain tidak terpengaruh');
  const promo = w.bw.evaluate('G1', 'free nitro', { channelId: 'CH_X' })[0];
  assert.deepEqual([promo.name, promo.reason, promo.allowPass, promo.passDays], ['Promo', 'Promosi mencurigakan', true, 10]);
  assert.deepEqual(w.bw.evaluate('G1', 'pesan biasa saja'), []);
});
test('evaluate: cache langsung ikut berubah setelah add/edit/disable/remove/exempt (tidak basi)', async () => {
  const w = world();
  assert.deepEqual(w.bw.evaluate('G1', 'free nitro'), []);                   // mengisi cache dengan daftar kosong
  await w.add({ name: 'Promo', phrase: 'free nitro', mode: 'exact' });
  assert.equal(w.bw.evaluate('G1', 'free nitro').length, 1, 'add');
  await w.call('edit', { id: 1, phrase: 'gratis nitro' });
  assert.equal(w.bw.evaluate('G1', 'free nitro').length, 0, 'edit frasa'); assert.equal(w.bw.evaluate('G1', 'gratis nitro').length, 1);
  await w.call('exempt-channel', { id: 1, channel: { id: 'C1', guildId: 'G1' } });
  assert.equal(w.bw.evaluate('G1', 'gratis nitro', { channelId: 'C1' }).length, 0, 'exempt');
  await w.call('exempt-channel', { id: 1, channel: { id: 'C1', guildId: 'G1' }, remove: true });
  assert.equal(w.bw.evaluate('G1', 'gratis nitro', { channelId: 'C1' }).length, 1, 'cabut exempt');
  await w.call('edit', { id: 1, enabled: false });
  assert.equal(w.bw.evaluate('G1', 'gratis nitro').length, 0, 'nonaktif');
  await w.call('edit', { id: 1, enabled: true });
  assert.equal(w.bw.evaluate('G1', 'gratis nitro').length, 1, 'aktif lagi');
  await w.call('remove', { id: 1 });
  assert.equal(w.bw.evaluate('G1', 'gratis nitro').length, 0, 'remove');
});
test('evaluate: aturan rusak di database (mis. mode regex) dilewati dan dilaporkan, aturan lain tetap jalan', async () => {
  const w = world();
  await w.add({ name: 'Baik', phrase: 'free nitro', mode: 'exact' });
  w.storage.db.prepare("INSERT INTO banned_word_rules (guild_id, name, phrase, mode, reason, created_by, created_at, updated_at) VALUES ('G1','Rusak','(a+)+$','regex','x','X',1,1)").run();
  w.bw.invalidate('G1');
  assert.deepEqual(w.bw.evaluate('G1', 'free nitro (aaaa').map((r) => r.name), ['Baik']);
  assert.match(w.errors[0], /Aturan #2 tidak valid, dilewati: Mode regex belum didukung/);
});
test('kegagalan database saat menambah aturan: tidak ada aturan setengah jadi dan pesan error jujur', async () => {
  const w = world();
  w.storage.audit.log = () => { throw new Error('disk penuh'); };
  const r = await w.add();
  assert.match(r.said, /Perubahan TIDAK tersimpan/);
  assert.equal(w.storage.rules.count('G1'), 0, 'transaksi dibatalkan');
  assert.deepEqual(w.bw.evaluate('G1', 'check my bio'), [], 'cache juga tidak boleh memuat aturan yang gagal disimpan');
});

/* ---------------- repo ---------------- */
test('repo rules: add/get/list/update/setExempt/remove, field boolean, isolasi server', () => {
  const db = openDatabase(':memory:'); let t = 1; const r = createRulesRepo(db, { now: () => t++ });
  const a = r.add({ guildId: 'G1', name: 'A', phrase: 'aaa bbb', mode: 'exact', reason: 'x', createdBy: 'M' });
  r.add({ guildId: 'G2', name: 'B', phrase: 'ccc ddd', mode: 'evasion', reason: 'y', createdBy: 'M', allowPass: true, passDays: 5 });
  assert.deepEqual([a.enabled, a.allowPass, a.passDays, a.exemptRoles, a.exemptChannels], [true, false, 30, [], []]);
  assert.equal(r.count('G1'), 1); assert.equal(r.get('G1', 2), undefined, 'aturan G2 tidak terlihat dari G1');
  const u = r.update('G1', a.id, { enabled: false, passDays: 9 });
  assert.deepEqual([u.enabled, u.passDays, u.updatedAt > a.updatedAt], [false, 9, true]);
  assert.deepEqual(r.list({ guildId: 'G1', enabledOnly: true }), []);
  assert.equal(r.update('G1', 999, { name: 'x' }), undefined);
  assert.deepEqual(r.setExempt('G1', a.id, 'role', 'R1', true).exemptRoles, ['R1']);
  assert.deepEqual(r.setExempt('G1', a.id, 'role', 'R1', false).exemptRoles, []);
  assert.equal(r.setExempt('G2', a.id, 'role', 'R1', true), undefined, 'tidak bisa mengubah aturan server lain');
  assert.equal(r.remove('G2', a.id), false); assert.equal(r.remove('G1', a.id), true);
  assert.throws(() => db.prepare("UPDATE banned_word_rules SET mode = 'bebas' WHERE id = 2").run(), /CHECK/);
  db.close();
});
