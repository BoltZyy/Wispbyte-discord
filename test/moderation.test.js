'use strict';
/**
 * Tes moderasi (tahap 2): /warn, /warnings, /warning-remove, /modconfig, /backup,
 * backup terjadwal, izin dan hierarki. Database = node:sqlite ASLI (file sementara);
 * discord.js dan objek Discord (interaction, guild, channel) = STUB/fake.
 * Tidak mencakup: perilaku sungguhan di Discord (izin channel, hierarki role nyata).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------------- stub discord.js ---------------- */
function recorder() {
  const trace = [];
  const ser = (a) => {
    if (typeof a === 'function') { const child = recorder(); a(child); return { cb: child.toJSON() }; }
    if (typeof a === 'bigint') return `${a}n`;
    return a;
  };
  const proxy = new Proxy({}, { get: (_t, k) => (k === 'toJSON' ? () => trace : (...args) => { trace.push([String(k), args.map(ser)]); return proxy; }) });
  return proxy;
}
const P = { Administrator: 1n << 3n, ManageGuild: 1n << 5n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n, AttachFiles: 1n << 15n, ModerateMembers: 1n << 40n };
const discordStub = {
  SlashCommandBuilder: class { constructor() { return recorder(); } },
  PermissionFlagsBits: P, ChannelType: { GuildText: 0 }, MessageFlags: { Ephemeral: 64 },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'discord.js' ? discordStub : origLoad.call(this, request, ...rest); };

const { createModeration, buildModerationCommandList } = require('../src/discord/moderation');
const { checkTargetHierarchy } = require('../src/discord/permissions');
const { initStorage } = require('../src/storage');
const { openDatabase } = require('../src/storage/db');
const { createWarningsRepo } = require('../src/storage/repositories');

/* ---------------- fake Discord ---------------- */
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovelia-mod-'));
const silent = { log() {}, warn() {}, error() {} };
const perms = (...flags) => {
  const bits = flags.reduce((a, f) => a | f, 0n);
  const admin = (bits & P.Administrator) !== 0n;
  return { has: (f) => (Array.isArray(f) ? f : [f]).every((x) => admin || (bits & x) === x) };
};
const member = (id, position) => ({ id, roles: { highest: { position, comparePositionTo(o) { return this.position - o.position; } } } });

function fakeChannel(id, { text = true, guildId = 'G1', botPerms = perms(P.ViewChannel, P.SendMessages, P.AttachFiles), onSend } = {}) {
  // permissionsFor(null) mengembalikan null seperti discord.js asli -> kode yang lupa mengambil anggota bot akan gagal di tes
  const ch = { id, guildId, sent: [], isTextBased: () => text, permissionsFor: (m) => (m ? botPerms : null),
    async send(m) { ch.sent.push(m); if (onSend) await onSend(m); } };
  return ch;
}
function fakeGuild({ ownerId = 'GUILDOWNER', members = [], channels = [] } = {}) {
  const mm = new Map(members.map((m) => [m.id, m])); const cc = new Map(channels.map((c) => [c.id, c]));
  return { id: 'G1', ownerId,
    // Di bot asli cache anggota dimatikan (GuildMemberManager: 0) -> members.me == null; anggota bot harus diambil lewat fetchMe().
    members: { me: null, fetchMe: async () => ({ id: 'BOT' }), fetch: async (id) => { if (!mm.has(id)) throw new Error('Unknown Member'); return mm.get(id); } },
    channels: { fetch: async (id) => cc.get(id) ?? null } };
}
function fakeInteraction({ command, sub = null, userId = 'MOD1', guild, member: mem, perm, opts = {} }) {
  const calls = { reply: [], edit: [], defer: [] };
  const i = {
    commandName: command, user: { id: userId }, guild, member: mem, memberPermissions: perm, replied: false, deferred: false, calls,
    isChatInputCommand: () => true, inGuild: () => true,
    options: { getSubcommand: () => sub, getUser: (n) => opts[n], getString: (n) => opts[n] ?? null, getInteger: (n) => opts[n], getBoolean: (n) => opts[n] ?? null, getChannel: (n) => opts[n] },
    reply: async (o) => { calls.reply.push(o); i.replied = true; },
    deferReply: async (o) => { calls.defer.push(o); i.deferred = true; },
    editReply: async (o) => { calls.edit.push(o); },
  };
  return i;
}
const said = (i) => (i.calls.edit.at(-1) ?? i.calls.reply.at(-1)).content;

/** Dunia uji standar: server G1, moderator (role 10), target rendah (1), target tinggi (10), channel modlog. */
function world({ withModlog = true, modOpts = {}, clock } = {}) {
  const storage = initStorage({ dbPath: path.join(tmpDir(), 'db.sqlite'), log: silent });
  const modlog = fakeChannel('CH_LOG');
  const backupCh = fakeChannel('CH_BK');
  const modMember = member('MOD1', 10);
  const guild = fakeGuild({ members: [modMember, member('U_LOW', 1), member('U_HIGH', 10), member('GUILDOWNER', 99)], channels: [modlog, backupCh] });
  if (withModlog) storage.settings.set('G1', 'modlog.channelId', 'CH_LOG');
  const moderation = createModeration({ storage, ownerId: 'BOTOWNER', log: silent, now: clock, ...modOpts });
  const warnAs = (userId, targetId, reason = 'spam', perm = perms(P.ModerateMembers), mem = modMember) =>
    fakeInteraction({ command: 'warn', userId, guild, member: mem, perm, opts: { user: { id: targetId, bot: false }, reason } });
  return { storage, modlog, backupCh, guild, modMember, moderation, warnAs };
}
const count = (storage, table) => storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

/* ---------------- definisi command ---------------- */
test('command: definisi 5 command moderasi identik dengan golden dan memakai izin default yang benar', () => {
  const list = buildModerationCommandList();
  const names = list.map((c) => c.find((e) => e[0] === 'setName')[1][0]);
  assert.deepEqual(names, ['warn', 'warnings', 'warning-remove', 'modconfig', 'backup']);
  const goldenPath = path.join(__dirname, 'fixtures', 'moderation-commands.golden.json');
  const actual = JSON.stringify(list, null, 2) + '\n';
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(goldenPath, actual);
  assert.equal(actual, fs.readFileSync(goldenPath, 'utf8'), 'definisi command moderasi berubah dari golden');
});
test('handle: command non-moderasi diabaikan (false); DM ditolak; database nonaktif memberi pesan jelas', async () => {
  const { moderation, guild } = world();
  const other = fakeInteraction({ command: 'model', guild });
  assert.equal(await moderation.handle(other), false);
  assert.equal(await moderation.handle({ isChatInputCommand: () => false }), false);

  const dm = fakeInteraction({ command: 'warn', guild }); dm.inGuild = () => false;
  assert.equal(await moderation.handle(dm), true);
  assert.match(said(dm), /hanya bisa dipakai di server/);

  const off = createModeration({ storage: null, ownerId: 'X', log: silent });
  const i = fakeInteraction({ command: 'warn', guild, perm: perms(P.Administrator) });
  assert.equal(await off.handle(i), true);
  assert.match(said(i), /Fitur moderasi nonaktif/);
  assert.equal(off.startScheduler({ guilds: { cache: new Map() } }), null);
});

/* ---------------- /warn ---------------- */
test('warn: sukses -> warning + audit tersimpan, balasan ephemeral, catatan ke modlog tanpa mention', async () => {
  const w = world();
  const i = w.warnAs('MOD1', 'U_LOW', ' spam link ');
  assert.equal(await w.moderation.handle(i), true);
  assert.match(said(i), /Peringatan #1 dicatat untuk <@U_LOW> \(total aktif: 1\)/);
  assert.equal(i.calls.reply[0].flags, 64);
  const [row] = w.storage.warnings.list({ guildId: 'G1', userId: 'U_LOW' });
  assert.equal(row.reason, 'spam link'); assert.equal(row.moderatorId, 'MOD1');
  const [log] = w.storage.audit.list({ guildId: 'G1' });
  assert.deepEqual([log.action, log.actorId, log.targetId, log.status, log.details.warningId], ['warn', 'MOD1', 'U_LOW', 'ok', 1]);
  assert.equal(w.modlog.sent.length, 1);
  assert.match(w.modlog.sent[0].content, /Warning #1.*<@U_LOW>.*<@MOD1>.*total aktif: 1.*spam link/s);
  assert.deepEqual(w.modlog.sent[0].allowedMentions, { parse: [] });

  const i2 = w.warnAs('MOD1', 'U_LOW', 'lagi'); await w.moderation.handle(i2);
  assert.match(said(i2), /Peringatan #2.*total aktif: 2/);
});
test('warn: tanpa izin ModerateMembers ditolak dan TIDAK ada yang tersimpan', async () => {
  const w = world();
  const i = w.warnAs('MOD1', 'U_LOW', 'x', perms(P.SendMessages));
  await w.moderation.handle(i);
  assert.match(said(i), /tidak punya izin/);
  assert.equal(count(w.storage, 'warnings') + count(w.storage, 'moderation_logs'), 0);
  assert.equal(w.modlog.sent.length, 0);
});
test('warn: diri sendiri, bot, alasan kosong, target lebih tinggi/sama, dan pemilik server ditolak', async () => {
  const w = world();
  const cases = [
    [w.warnAs('MOD1', 'MOD1'), /diri sendiri/],
    [fakeInteraction({ command: 'warn', guild: w.guild, member: w.modMember, perm: perms(P.ModerateMembers), opts: { user: { id: 'BOT2', bot: true }, reason: 'x' } }), /pada bot/],
    [w.warnAs('MOD1', 'U_LOW', '   '), /Alasan tidak boleh kosong/],
    [w.warnAs('MOD1', 'U_HIGH'), /sama dengan atau lebih tinggi/],
    [w.warnAs('MOD1', 'GUILDOWNER'), /Pemilik server tidak bisa/],
  ];
  for (const [i, re] of cases) { await w.moderation.handle(i); assert.match(said(i), re); }
  assert.equal(count(w.storage, 'warnings'), 0);
});
test('warn: pemilik server boleh menindak role lebih tinggi; target yang sudah keluar server tetap bisa dicatat', async () => {
  const w = world();
  const owner = member('GUILDOWNER', 99);
  const i = w.warnAs('GUILDOWNER', 'U_HIGH', 'tes', perms(P.ModerateMembers), owner);
  await w.moderation.handle(i);
  assert.match(said(i), /Peringatan #1/);
  const gone = w.warnAs('MOD1', 'U_GONE', 'pergi');
  await w.moderation.handle(gone);
  assert.match(said(gone), /Peringatan #2.*tidak ada di server/s);
});
test('warn: modlog belum diatur / gagal kirim -> tindakan tetap tersimpan, balasan jujur', async () => {
  const none = world({ withModlog: false });
  const a = none.warnAs('MOD1', 'U_LOW'); await none.moderation.handle(a);
  assert.match(said(a), /Peringatan #1/); assert.ok(!/modlog gagal/.test(said(a)));

  const broken = world();
  broken.modlog.send = async () => { throw new Error('Missing Access'); };
  const b = broken.warnAs('MOD1', 'U_LOW'); await broken.moderation.handle(b);
  assert.match(said(b), /Peringatan #1/); assert.match(said(b), /modlog gagal dikirim \(tindakan tetap tersimpan\)/);
  assert.equal(count(broken.storage, 'warnings'), 1);
});
test('warn: kegagalan audit log membatalkan warning (atomik) dan pengguna TIDAK diberi tahu sukses', async () => {
  const w = world();
  w.storage.audit.log = () => { throw new Error('disk penuh'); };
  const i = w.warnAs('MOD1', 'U_LOW'); await w.moderation.handle(i);
  assert.match(said(i), /TIDAK tercatat sebagai berhasil/);
  assert.equal(count(w.storage, 'warnings'), 0, 'warning harus di-rollback');
  assert.equal(w.modlog.sent.length, 0);
});

/* ---------------- /warnings & /warning-remove ---------------- */
test('warnings: daftar aktif saja secara default, "all" menyertakan yang dicabut, kosong, tanpa izin', async () => {
  const w = world();
  for (const r of ['satu', 'dua']) await w.moderation.handle(w.warnAs('MOD1', 'U_LOW', r));
  await w.moderation.handle(fakeInteraction({ command: 'warning-remove', guild: w.guild, member: w.modMember, perm: perms(P.ModerateMembers), opts: { id: 1 } }));
  const list = (opts, perm = perms(P.ModerateMembers)) => fakeInteraction({ command: 'warnings', guild: w.guild, member: w.modMember, perm, opts: { user: { id: 'U_LOW' }, ...opts } });

  const active = list({}); await w.moderation.handle(active);
  assert.match(said(active), /total aktif: 1/); assert.match(said(active), /#2 .*dua/); assert.ok(!/#1 /.test(said(active)));
  const all = list({ all: true }); await w.moderation.handle(all);
  assert.match(said(all), /#1 \(dicabut\).*satu/); assert.match(said(all), /#2 .*dua/);
  const empty = fakeInteraction({ command: 'warnings', guild: w.guild, member: w.modMember, perm: perms(P.ModerateMembers), opts: { user: { id: 'NOBODY' } } });
  await w.moderation.handle(empty); assert.match(said(empty), /tidak punya peringatan aktif/);
  const denied = list({}, perms()); await w.moderation.handle(denied); assert.match(said(denied), /tidak punya izin/);
});
test('warning-remove: sukses + audit + modlog; tidak ditemukan; sudah dicabut; lintas server tidak bocor; tanpa izin', async () => {
  const w = world();
  await w.moderation.handle(w.warnAs('MOD1', 'U_LOW', 'salah'));
  const rm = (id, perm = perms(P.ModerateMembers), reason) => fakeInteraction({ command: 'warning-remove', guild: w.guild, member: w.modMember, perm, opts: { id, reason } });

  const denied = rm(1, perms()); await w.moderation.handle(denied);
  assert.match(said(denied), /tidak punya izin/); assert.equal(w.storage.warnings.countActive('G1', 'U_LOW'), 1);

  const ok = rm(1, perms(P.ModerateMembers), 'salah orang'); await w.moderation.handle(ok);
  assert.match(said(ok), /Peringatan #1 dicabut/);
  assert.equal(w.storage.warnings.countActive('G1', 'U_LOW'), 0);
  const entry = w.storage.audit.list({ guildId: 'G1', action: 'warning_remove' })[0];
  assert.deepEqual([entry.actorId, entry.targetId, entry.reason, entry.details.warningId], ['MOD1', 'U_LOW', 'salah orang', 1]);
  assert.match(w.modlog.sent.at(-1).content, /Warning #1.*dicabut oleh <@MOD1>/s);

  const again = rm(1); await w.moderation.handle(again); assert.match(said(again), /sudah dicabut sebelumnya/);
  const missing = rm(999); await w.moderation.handle(missing); assert.match(said(missing), /tidak ditemukan/);

  // peringatan milik server lain tidak bisa dicabut dari server ini
  const other = createWarningsRepo(w.storage.db).add({ guildId: 'G2', userId: 'X', moderatorId: 'M', reason: 'server lain' });
  const cross = rm(other.id); await w.moderation.handle(cross);
  assert.match(said(cross), /tidak ditemukan/); assert.equal(w.storage.warnings.get('G2', other.id).status, 'active');
});

/* ---------------- /modconfig ---------------- */
test('modconfig: izin ManageGuild diperiksa; channel valid disimpan + audit; channel tidak valid ditolak', async () => {
  const w = world({ withModlog: false });
  const cfg = (sub, channel, perm = perms(P.ManageGuild)) => fakeInteraction({ command: 'modconfig', sub, guild: w.guild, member: w.modMember, perm, opts: { channel } });

  const denied = cfg('modlog-channel', w.modlog, perms(P.ModerateMembers)); await w.moderation.handle(denied);
  assert.match(said(denied), /tidak punya izin/); assert.equal(w.storage.settings.get('G1', 'modlog.channelId'), undefined);

  const ok = cfg('modlog-channel', w.modlog); await w.moderation.handle(ok);
  assert.match(said(ok), /Channel modlog diatur ke <#CH_LOG>/);
  assert.equal(w.storage.settings.get('G1', 'modlog.channelId'), 'CH_LOG');
  assert.deepEqual(w.storage.audit.list({ guildId: 'G1', action: 'config_change' })[0].details, { key: 'modlog.channelId', channelId: 'CH_LOG' });

  for (const [ch, re] of [
    [fakeChannel('VOICE', { text: false }), /channel teks di server ini/],
    [fakeChannel('LAIN', { guildId: 'G2' }), /channel teks di server ini/],
    [fakeChannel('NOPERM', { botPerms: perms(P.ViewChannel) }), /belum punya izin yang cukup/],
  ]) { const i = cfg('modlog-channel', ch); await w.moderation.handle(i); assert.match(said(i), re); }
  assert.equal(w.storage.settings.get('G1', 'modlog.channelId'), 'CH_LOG', 'channel tidak valid tidak boleh mengubah konfigurasi');

  const noAttach = fakeChannel('NOATT', { botPerms: perms(P.ViewChannel, P.SendMessages) });
  const bad = cfg('backup-channel', noAttach); await w.moderation.handle(bad); assert.match(said(bad), /Lampirkan File/);
  const good = cfg('backup-channel', w.backupCh); await w.moderation.handle(good);
  assert.match(said(good), /Channel backup diatur ke <#CH_BK>.*PRIVAT/s);

  const show = cfg('show'); await w.moderation.handle(show);
  assert.match(said(show), /modlog: <#CH_LOG>.*backup: <#CH_BK>.*\(belum pernah\)/s);
});

test('modconfig: gagal mengambil anggota bot (fetchMe error) -> pesan error umum, konfigurasi TIDAK berubah', async () => {
  const w = world({ withModlog: false });
  w.guild.members.fetchMe = async () => { throw new Error('Unknown Member'); };
  const i = fakeInteraction({ command: 'modconfig', sub: 'modlog-channel', guild: w.guild, member: w.modMember, perm: perms(P.ManageGuild), opts: { channel: w.modlog } });
  assert.equal(await w.moderation.handle(i), true);
  assert.match(said(i), /Terjadi kesalahan.*TIDAK tercatat/s);
  assert.equal(w.storage.settings.get('G1', 'modlog.channelId'), undefined);
});

/* ---------------- backup ---------------- */
test('backup: hanya owner bot / pemilik server; wajib ada channel; sukses mengirim lampiran gzip yang bisa dipulihkan', async () => {
  const w = world(); const copyTo = path.join(tmpDir(), 'dikirim.sqlite.gz'); let existedDuringSend = false;
  w.backupCh.send = async (m) => { existedDuringSend = fs.existsSync(m.files[0].attachment); fs.copyFileSync(m.files[0].attachment, copyTo); w.backupCh.sent.push(m); };
  await w.moderation.handle(w.warnAs('MOD1', 'U_LOW', 'ikut di backup'));
  const run = (userId) => fakeInteraction({ command: 'backup', userId, guild: w.guild, member: w.modMember, perm: perms(P.ManageGuild) });

  const stranger = run('MOD1'); await w.moderation.handle(stranger);
  assert.match(said(stranger), /Hanya owner bot atau pemilik server/);
  const noChannel = run('BOTOWNER'); await w.moderation.handle(noChannel);
  assert.match(said(noChannel), /Channel backup belum diatur/);

  w.storage.settings.set('G1', 'backup.channelId', 'CH_BK');
  const ok = run('BOTOWNER'); await w.moderation.handle(ok);
  assert.equal(ok.calls.defer[0].flags, 64);
  assert.match(said(ok), /Backup terkirim ke <#CH_BK>/);
  assert.ok(existedDuringSend, 'berkas harus ada saat dikirim');
  const sent = w.backupCh.sent[0];
  assert.match(sent.files[0].name, /^ovelia-\d{8}-\d{6}\.sqlite\.gz$/);
  assert.ok(!fs.existsSync(sent.files[0].attachment), 'berkas sementara harus dihapus setelah dikirim');
  assert.ok(w.storage.settings.get('G1', 'backup.lastAt') > 0);
  assert.equal(w.storage.audit.list({ guildId: 'G1', action: 'backup' })[0].status, 'ok');

  const restored = path.join(tmpDir(), 'pulih.sqlite'); fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(copyTo)));
  const db = openDatabase(restored);
  assert.equal(createWarningsRepo(db).list({ guildId: 'G1', userId: 'U_LOW' })[0].reason, 'ikut di backup');
  db.close();

  const guildOwnerRun = run('GUILDOWNER'); await w.moderation.handle(guildOwnerRun);
  assert.match(said(guildOwnerRun), /Backup terkirim/);
});
test('backup: terlalu besar atau pengiriman gagal -> tidak ada sukses palsu, audit "failed", lastAt tidak berubah, berkas sementara terhapus', async () => {
  const big = world({ modOpts: { backupMaxBytes: 10 } });
  big.storage.settings.set('G1', 'backup.channelId', 'CH_BK');
  const r1 = await big.moderation.runBackup({ guild: big.guild, trigger: 'manual', actorId: 'BOTOWNER' });
  assert.equal(r1.ok, false); assert.match(r1.error, /melebihi batas/);
  assert.equal(big.backupCh.sent.length, 0);
  assert.equal(big.storage.audit.list({ guildId: 'G1', action: 'backup' })[0].status, 'failed');
  assert.equal(big.storage.settings.get('G1', 'backup.lastAt'), undefined);
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(big.storage.db.path), 'backups')), [], 'tidak boleh ada sisa berkas');

  const down = world(); down.storage.settings.set('G1', 'backup.channelId', 'CH_BK');
  down.backupCh.send = async () => { throw new Error('Missing Permissions'); };
  const r2 = await down.moderation.runBackup({ guild: down.guild, trigger: 'manual' });
  assert.equal(r2.ok, false); assert.match(r2.error, /Missing Permissions/);
  assert.equal(down.storage.settings.get('G1', 'backup.lastAt'), undefined);
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(down.storage.db.path), 'backups')), []);
});
test('backup: dua permintaan bersamaan dijalankan berurutan (tidak bertabrakan)', async () => {
  const w = world(); w.storage.settings.set('G1', 'backup.channelId', 'CH_BK');
  let active = 0; let maxActive = 0;
  w.backupCh.send = async (m) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; w.backupCh.sent.push(m); };
  const results = await Promise.all([1, 2, 3].map(() => w.moderation.runBackup({ guild: w.guild, trigger: 'manual' })));
  assert.ok(results.every((r) => r.ok)); assert.equal(maxActive, 1); assert.equal(w.backupCh.sent.length, 3);
});

test('backup: pengiriman macet -> gagal karena batas waktu, berkas sementara dihapus, antrean TIDAK terblokir', { timeout: 8000 }, async () => {
  const w = world({ modOpts: { backupTimeoutMs: 50 } }); w.storage.settings.set('G1', 'backup.channelId', 'CH_BK');
  const bdir = path.join(path.dirname(w.storage.db.path), 'backups');
  w.backupCh.send = () => new Promise(() => {}); // tidak pernah selesai
  const r1 = await w.moderation.runBackup({ guild: w.guild, trigger: 'manual', actorId: 'BOTOWNER' });
  assert.equal(r1.ok, false); assert.match(r1.error, /melewati batas waktu/);
  const entry = w.storage.audit.list({ guildId: 'G1', action: 'backup' })[0];
  assert.equal(entry.status, 'failed'); assert.match(entry.reason, /batas waktu/);
  assert.equal(w.storage.settings.get('G1', 'backup.lastAt'), undefined);
  assert.deepEqual(fs.readdirSync(bdir), [], 'berkas sementara harus dihapus saat batas waktu terlewati');

  w.backupCh.send = async (m) => { w.backupCh.sent.push(m); };
  const r2 = await w.moderation.runBackup({ guild: w.guild, trigger: 'manual' });
  assert.equal(r2.ok, true, 'backup berikutnya tidak boleh ikut macet');
});
test('backup: pembuatan berkas yang tidak pernah selesai -> gagal, antrean lanjut', { timeout: 8000 }, async () => {
  let calls = 0;
  const { createCompressedBackup } = require('../src/storage/backup');
  const createBackup = (db, o) => (++calls === 1 ? new Promise(() => {}) : createCompressedBackup(db, o));
  const w = world({ modOpts: { backupTimeoutMs: 50, createBackup } }); w.storage.settings.set('G1', 'backup.channelId', 'CH_BK');
  const r1 = await w.moderation.runBackup({ guild: w.guild, trigger: 'terjadwal' });
  assert.equal(r1.ok, false); assert.match(r1.error, /melewati batas waktu 0 detik|melewati batas waktu \d+ detik/);
  const r2 = await w.moderation.runBackup({ guild: w.guild, trigger: 'terjadwal' });
  assert.equal(r2.ok, true); assert.equal(w.backupCh.sent.length, 1);
});
test('backup: hasil yang TERLAMBAT (setelah batas waktu) tidak dikirim, berkasnya dihapus, hanya satu catatan "failed"', { timeout: 8000 }, async () => {
  const { createCompressedBackup } = require('../src/storage/backup');
  const createBackup = async (db, o) => { await new Promise((r) => setTimeout(r, 120)); return createCompressedBackup(db, o); };
  const w = world({ modOpts: { backupTimeoutMs: 30, createBackup } }); w.storage.settings.set('G1', 'backup.channelId', 'CH_BK');
  const r = await w.moderation.runBackup({ guild: w.guild, trigger: 'manual' });
  assert.equal(r.ok, false);
  await new Promise((res) => setTimeout(res, 500)); // beri waktu proses lambat itu selesai
  assert.equal(w.backupCh.sent.length, 0, 'hasil terlambat tidak boleh dikirim');
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(w.storage.db.path), 'backups')), []);
  const entries = w.storage.audit.list({ guildId: 'G1', action: 'backup' });
  assert.deepEqual(entries.map((e) => e.status), ['failed']);
  assert.equal(w.storage.settings.get('G1', 'backup.lastAt'), undefined);
});

/* ---------------- backup terjadwal ---------------- */
test('terjadwal: hanya server ber-channel yang sudah jatuh tempo; gagal tidak diulang beruntun; nonaktif bila interval 0', async () => {
  let clock = 1_000_000;
  const w = world({ clock: () => clock, modOpts: { backupIntervalMs: 1000, backupRetryMs: 500 } });
  const client = { guilds: { cache: new Map([['G1', w.guild]]) } };

  assert.deepEqual(await w.moderation.checkScheduledBackups(client), [], 'tanpa channel backup: tidak ada yang dikirim');
  w.storage.settings.set('G1', 'backup.channelId', 'CH_BK');
  assert.deepEqual(await w.moderation.checkScheduledBackups(client), [{ guildId: 'G1', ok: true }]);
  assert.equal(w.backupCh.sent.length, 1);
  assert.match(w.backupCh.sent[0].content, /terjadwal/);

  clock += 100; assert.deepEqual(await w.moderation.checkScheduledBackups(client), [], 'belum jatuh tempo');
  clock += 1000; assert.equal((await w.moderation.checkScheduledBackups(client))[0].ok, true);
  assert.equal(w.backupCh.sent.length, 2);

  const lastOk = w.storage.settings.get('G1', 'backup.lastAt');
  clock += 1001; w.backupCh.send = async () => { throw new Error('Missing Access'); };
  assert.equal((await w.moderation.checkScheduledBackups(client))[0].ok, false);
  assert.equal(w.storage.settings.get('G1', 'backup.lastAt'), lastOk, 'gagal tidak boleh memajukan lastAt');
  clock += 100; assert.deepEqual(await w.moderation.checkScheduledBackups(client), [], 'masih dalam masa tunggu setelah gagal');
  clock += 500; w.backupCh.send = async (m) => { w.backupCh.sent.push(m); };
  assert.equal((await w.moderation.checkScheduledBackups(client))[0].ok, true, 'setelah masa tunggu dicoba lagi');

  const off = createModeration({ storage: w.storage, ownerId: 'X', log: silent, backupIntervalMs: 0 });
  assert.deepEqual(await off.checkScheduledBackups(client), []);
  assert.equal(off.startScheduler(client), null);
  const sched = w.moderation.startScheduler(client, { firstDelayMs: 60_000, tickMs: 60_000 });
  assert.equal(typeof sched.stop, 'function'); sched.stop();
});

/* ---------------- hierarki ---------------- */
test('hierarki: target bukan anggota lolos; pemilik server tak bisa ditindak; pemilik bisa menindak; role harus lebih tinggi', () => {
  const guild = { ownerId: 'OWN' };
  const hi = member('A', 10); const lo = member('B', 5); const same = member('C', 10);
  assert.equal(checkTargetHierarchy({ guild, moderatorMember: hi, targetMember: null }).ok, true);
  assert.deepEqual(checkTargetHierarchy({ guild, moderatorMember: hi, targetMember: member('OWN', 1) }), { ok: false, reason: 'target_is_owner' });
  assert.equal(checkTargetHierarchy({ guild, moderatorMember: member('OWN', 1), targetMember: hi }).ok, true);
  assert.equal(checkTargetHierarchy({ guild, moderatorMember: hi, targetMember: lo }).ok, true);
  assert.deepEqual(checkTargetHierarchy({ guild, moderatorMember: hi, targetMember: same }), { ok: false, reason: 'target_higher_or_equal' });
  assert.equal(checkTargetHierarchy({ guild, moderatorMember: lo, targetMember: hi }).ok, false);
});

/* ---------------- repo warnings ---------------- */
test('repo warnings: validasi, urutan, filter aktif, remove atomik, isolasi server', () => {
  const db = openDatabase(':memory:'); let t = 1;
  const r = createWarningsRepo(db, { now: () => t++ });
  assert.throws(() => r.add({ guildId: 'G1', userId: 'U', moderatorId: 'M', reason: '  ' }), /reason wajib/);
  const a = r.add({ guildId: 'G1', userId: 'U', moderatorId: 'M', reason: 'a' });
  const b = r.add({ guildId: 'G1', userId: 'U', moderatorId: 'M', reason: 'b' });
  assert.deepEqual(r.list({ guildId: 'G1', userId: 'U' }).map((x) => x.id), [b.id, a.id]);
  assert.equal(r.remove({ guildId: 'G1', id: a.id, removedBy: 'M2', reason: 'oops' }).ok, true);
  assert.deepEqual(r.remove({ guildId: 'G1', id: a.id, removedBy: 'M2' }), { ok: false, reason: 'already_inactive' });
  assert.deepEqual(r.remove({ guildId: 'G2', id: b.id, removedBy: 'M2' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(r.list({ guildId: 'G1', userId: 'U' }).map((x) => x.id), [b.id]);
  assert.equal(r.list({ guildId: 'G1', userId: 'U', includeInactive: true }).length, 2);
  assert.equal(r.get('G1', a.id).removedReason, 'oops');
  assert.equal(r.countActive('G1', 'U'), 1);
  db.close();
});
