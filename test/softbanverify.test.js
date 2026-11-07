'use strict';
/**
 * Tes softban-verifikasi (tahap 6) + integrasi dengan verification.js.
 * Database = node:sqlite ASLI. Objek Discord = fake yang meniru perilaku asli:
 *  - guild.members.me == null (anggota bot lewat fetchMe), fetch anggota yang sudah keluar -> kode 10007;
 *  - mutasi role benar-benar mengubah roles.cache, sehingga pemeriksaan batas akses setelahnya realistis;
 *  - izin channel dihitung dari role anggota (channel.permissionsFor(member)).
 * Invarian utama yang dijaga: role Verified TIDAK kembali tanpa keputusan staf yang tercatat.
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
function dataBuilder() {
  const data = { components: [] };
  const proxy = new Proxy({}, {
    get(_t, k) {
      if (k === 'data') return data;
      if (k === 'addComponents') return (...c) => { data.components.push(...c.flat()); return proxy; };
      const m = /^set(.)(.*)$/.exec(String(k));
      return m ? (v) => { data[m[1].toLowerCase() + m[2]] = v; return proxy; } : undefined;
    },
  });
  return proxy;
}
const P = { Administrator: 1n << 3n, ManageGuild: 1n << 5n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n, ManageRoles: 1n << 28n, ModerateMembers: 1n << 40n };
const mk = (Cls) => class { constructor() { return Cls(); } };
const discordStub = {
  SlashCommandBuilder: mk(recorder), ActionRowBuilder: mk(dataBuilder), ButtonBuilder: mk(dataBuilder), ModalBuilder: mk(dataBuilder), TextInputBuilder: mk(dataBuilder),
  PermissionFlagsBits: P, ChannelType: { GuildText: 0, GuildCategory: 4 }, MessageFlags: { Ephemeral: 64 },
  TextInputStyle: { Short: 1, Paragraph: 2 }, ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'discord.js' ? discordStub : origLoad.call(this, request, ...rest); };

const { buildSoftbanVerifyCommandList, createSoftbanVerify } = require('../src/discord/softbanVerify');
const { createVerification } = require('../src/discord/verification');
const { makeAnswerRecord } = require('../src/core/answer');
const { initStorage } = require('../src/storage');
const { openDatabase } = require('../src/storage/db');
const { createSoftbanRepo } = require('../src/storage/repositories');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovelia-sb-'));
const perms = (...flags) => { const bits = flags.reduce((a, f) => a | f, 0n); const admin = (bits & P.Administrator) !== 0n; return { has: (f) => (Array.isArray(f) ? f : [f]).every((x) => admin || (bits & x) === x) }; };
const ANSWER = 'Kucing Biru';

/* ---------------- dunia uji ---------------- */
async function world({ configure = true } = {}) {
  const storage = initStorage({ dbPath: path.join(tmpDir(), 's.sqlite'), log: { log() {}, error() {} } });
  const clock = { t: 5_000_000 }; const now = () => clock.t;
  const logs = { errors: [], warns: [] };
  const log = { log() {}, warn: (m) => logs.warns.push(m), error: (m) => logs.errors.push(m) };
  const softbanVerify = createSoftbanVerify({ storage, now, log });
  const verification = createVerification({ storage, softbanVerify, now, log });

  const members = new Map(); const gone = new Set();
  const member = (id, { roles = [], position = 1, perm = perms() } = {}) => {
    const m = { id, permissions: perm, ops: [], failAdd: false, failRemove: false };
    m.roles = {
      cache: new Map(roles.map((r) => [r, { id: r }])),
      highest: { position, comparePositionTo(o) { return this.position - o.position; } },
      add: async (roleId, reason) => { if (m.failAdd) throw new Error('Missing Permissions'); m.roles.cache.set(roleId, { id: roleId }); m.ops.push(['add', roleId, reason]); },
      remove: async (roleId, reason) => { if (m.failRemove) throw new Error('Missing Permissions'); m.roles.cache.delete(roleId); m.ops.push(['remove', roleId, reason]); },
    };
    members.set(id, m); return m;
  };
  const sent = { CH_V: [], CH_LOG: [] };
  const mkChannel = (id, { type = 0, thread = false, visible = () => true } = {}) => ({
    id, type, isThread: () => thread, isTextBased: () => true, send: async (m) => { (sent[id] ??= []).push(m); },
    permissionsFor: (m) => (m && visible([...m.roles.cache.keys()]) ? perms(P.ViewChannel) : perms()),
  });
  const channels = new Map([
    ['CH_V', mkChannel('CH_V')], ['CH_LOG', mkChannel('CH_LOG', { visible: (r) => r.includes('STAFF') })],
    ['CH_RULES', mkChannel('CH_RULES')], ['CH_GEN', mkChannel('CH_GEN', { visible: (r) => r.includes('VERIFIED') })],
    ['CH_MEMBERS', mkChannel('CH_MEMBERS', { visible: (r) => r.includes('MEMBER') })],
    ['CAT', mkChannel('CAT', { type: 4 })], ['THREAD', mkChannel('THREAD', { thread: true })],
  ]);
  const botMember = { id: 'BOT', permissions: perms(P.ManageRoles), roles: { highest: { position: 10 } } };
  const guild = {
    id: 'G1', ownerId: 'OWN', roles: { cache: new Map([['VERIFIED', { id: 'VERIFIED', managed: false, position: 5 }]]) },
    members: { me: null, fetchMe: async () => botMember,
      fetch: async (arg) => { const id = typeof arg === 'object' ? arg.user : arg; if (!members.has(id) || gone.has(id)) { const e = new Error('Unknown Member'); e.code = 10007; throw e; } return members.get(id); } },
    channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
  };
  if (configure) {
    const s = storage.settings;
    s.set('G1', 'verify.roleId', 'VERIFIED'); s.set('G1', 'verify.question', 'Hewan apa?'); s.set('G1', 'verify.answer', await makeAnswerRecord(ANSWER));
    s.set('G1', 'verify.channelId', 'CH_V'); s.set('G1', 'modlog.channelId', 'CH_LOG'); s.set('G1', 'verify.publicChannelIds', ['CH_RULES']);
  }
  member('MOD', { position: 8, perm: perms(P.ModerateMembers) });

  const base = (userId, extra = {}) => {
    const calls = { reply: [], edit: [], update: [], modal: [] };
    const i = { user: { id: userId }, guild, member: members.get(userId), calls, replied: false, deferred: false, inGuild: () => true,
      isButton: () => false, isModalSubmit: () => false, isChatInputCommand: () => false,
      reply: async (o) => { calls.reply.push(o); i.replied = true; }, editReply: async (o) => { calls.edit.push(o); }, update: async (o) => { calls.update.push(o); },
      showModal: async (m) => { calls.modal.push(m); }, ...extra };
    return i;
  };
  const sbCommand = (userId, sub, opts = {}, perm = perms(P.ModerateMembers)) => base(userId, {
    commandName: 'softban-verify', isChatInputCommand: () => true, memberPermissions: perm,
    options: { getSubcommand: () => sub, getUser: (n) => opts[n] ?? null, getString: (n) => opts[n] ?? null, getInteger: (n) => opts[n] },
  });
  const sbButton = (userId, customId, perm = perms(P.ModerateMembers)) => base(userId, { customId, isButton: () => true, memberPermissions: perm, message: { content: 'aviso' } });
  const vButton = (userId, customId) => base(userId, { customId, isButton: () => true });
  const vModal = (userId, customId, text) => base(userId, { customId, isModalSubmit: () => true, fields: { getTextInputValue: () => text } });
  const said = (i) => (i.calls.update.at(-1) ?? i.calls.edit.at(-1) ?? i.calls.reply.at(-1)).content;

  const run = async (i) => { const a = await softbanVerify.handle(i); return a || verification.handle(i); };
  const softban = async (target, { by = 'MOD', reason = 'perilaku mencurigakan', perm } = {}) => { const i = sbCommand(by, 'start', { user: { id: target, bot: false }, reason }, perm); await run(i); return i; };
  const sbAction = async (sub, caseId, { by = 'MOD', reason, perm } = {}) => { const i = sbCommand(by, sub, { case: caseId, reason }, perm); await run(i); return i; };
  const startVerify = async (userId) => { const i = vButton(userId, 'verify:start'); await run(i); return i; };
  const sidOf = (i) => (i.calls.reply.at(-1) ?? i.calls.edit.at(-1)).components[0].data.components[0].data.customId.split(':')[2];
  const answerVerify = async (userId, sid, text = ANSWER) => { const i = vModal(userId, `verify:submit:${sid}`, text); await run(i); return i; };
  const reverify = async (userId, text = ANSWER) => { const s = await startVerify(userId); const a = await answerVerify(userId, sidOf(s), text); return { start: s, answer: a }; };
  const rowOf = (id) => storage.softbans.get('G1', id);
  const actions = () => storage.audit.list({ guildId: 'G1', limit: 200 }).map((r) => r.action).reverse();
  const adds = (id) => members.get(id).ops.filter((o) => o[0] === 'add');

  return { storage, clock, guild, members, member, softbanVerify, verification, run, softban, sbAction, sbButton, sbCommand, startVerify, answerVerify, reverify, sidOf, said, rowOf, actions, adds, sent, gone, logs, channels, botMember };
}
const verifiedUser = (w, id = 'U1', roles = ['VERIFIED']) => w.member(id, { roles, position: 1 });

/* ---------------- definisi ---------------- */
test('command: definisi /softban-verify identik dengan golden', () => {
  const list = buildSoftbanVerifyCommandList();
  const goldenPath = path.join(__dirname, 'fixtures', 'softban-verify-commands.golden.json');
  const actual = JSON.stringify(list, null, 2) + '\n';
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(goldenPath, actual);
  assert.equal(actual, fs.readFileSync(goldenPath, 'utf8'));
});

/* ---------------- start ---------------- */
test('start: sukses -> role dicabut, kasus tercatat, audit lengkap, pengumuman di channel verifikasi (tanpa DM), modlog, tanpa peringatan', async () => {
  const w = await world(); verifiedUser(w);
  const i = await w.softban('U1');
  assert.match(w.said(i), /Softban-verifikasi dimulai \(kasus #1\).*kehilangan role Verified dan tetap berada di server/s);
  assert.ok(!/⚠️/.test(w.said(i)), 'tanpa kebocoran akses -> tanpa peringatan');
  assert.equal(i.calls.reply[0].flags, 64);
  assert.equal(w.members.get('U1').roles.cache.has('VERIFIED'), false);
  assert.deepEqual(w.members.get('U1').ops.map((o) => o[0]), ['remove']);
  const row = w.rowOf(1);
  assert.deepEqual([row.status, row.userId, row.moderatorId, row.reason], ['awaiting_verification', 'U1', 'MOD', 'perilaku mencurigakan']);
  assert.deepEqual(w.actions(), ['softban_verify_start', 'softban_verify_role_removed', 'softban_verify_restriction_check']);
  assert.equal(w.storage.audit.list({ guildId: 'G1', action: 'softban_verify_restriction_check' })[0].status, 'ok');
  assert.match(w.sent.CH_V[0].content, /<@U1> akses Anda dibatasi.*Mulai verifikasi/s); assert.deepEqual(w.sent.CH_V[0].allowedMentions, { users: ['U1'] });
  assert.match(w.sent.CH_LOG[0].content, /Softban-verifikasi #1.*<@U1> oleh <@MOD>.*perilaku mencurigakan/s);
});
test('start: akses yang masih bocor dilaporkan (role lain / channel publik); channel verifikasi, daftar publik, kategori, dan thread tidak dihitung', async () => {
  const w = await world(); verifiedUser(w, 'U1', ['VERIFIED', 'MEMBER']);
  w.storage.settings.set('G1', 'verify.publicChannelIds', []); // tanpa daftar publik: #rules yang terlihat semua orang ikut dihitung bocor
  const i = await w.softban('U1');
  assert.match(w.said(i), /Akses belum terbatas.*<#CH_RULES>.*<#CH_MEMBERS>/s); // urutan mengikuti urutan channel di server
  assert.ok(!/CH_GEN|CH_V\b|CAT|THREAD/.test(w.said(i).split('Akses belum terbatas')[1]), 'channel verifikasi, kategori, thread, dan channel khusus Verified tidak dilaporkan');
  const chk = w.storage.audit.list({ guildId: 'G1', action: 'softban_verify_restriction_check' })[0];
  assert.deepEqual([chk.status, chk.details.leakCount, chk.details.leakedChannelIds.sort()], ['partial', 2, ['CH_MEMBERS', 'CH_RULES']]);
  assert.match(w.sent.CH_LOG[0].content, /Batas akses belum sepenuhnya terjamin/);
  assert.equal(w.rowOf(1).status, 'awaiting_verification', 'kasus tetap berjalan; moderator diberi tahu untuk memperbaiki izin');

  const w2 = await world(); verifiedUser(w2, 'U1', ['VERIFIED', 'MEMBER']); // default dunia uji: CH_RULES sudah ditandai publik
  const j = await w2.softban('U1');
  assert.match(w2.said(j), /<#CH_MEMBERS>/); assert.ok(!/CH_RULES/.test(w2.said(j)), 'channel publik yang diizinkan tidak dihitung bocor');
});
test('start: pemeriksaan akses gagal -> dilaporkan jujur ("partial"), kasus tetap ada', async () => {
  const w = await world(); verifiedUser(w);
  const realFetch = w.guild.members.fetch;
  w.guild.members.fetch = async (arg) => { if (typeof arg === 'object') throw new Error('Rate limited'); return realFetch(arg); };
  const i = await w.softban('U1');
  assert.match(w.said(i), /Pemeriksaan batas akses gagal: Rate limited/);
  const chk = w.storage.audit.list({ guildId: 'G1', action: 'softban_verify_restriction_check' })[0];
  assert.deepEqual([chk.status, chk.details.checkFailed], ['partial', true]);
  assert.equal(w.members.get('U1').roles.cache.has('VERIFIED'), false);
});
test('start: penolakan — tanpa izin, diri sendiri, bot, belum dikonfigurasi, bukan anggota, bukan Verified, hierarki, pemilik, bot tak bisa kelola role', async () => {
  const w = await world(); verifiedUser(w);
  w.member('HIGH', { roles: ['VERIFIED'], position: 8 }); w.member('OWNER', { roles: ['VERIFIED'], position: 1 }); w.member('PLAIN', { roles: [] });
  const check = (i, re) => { assert.match(w.said(i), re); assert.equal(w.rowOf(1), undefined, 'penolakan tidak boleh membuat kasus'); };
  check(await w.softban('U1', { perm: perms(P.SendMessages) }), /tidak punya izin/);
  check(await w.softban('MOD'), /diri sendiri/);
  const botTarget = w.sbCommand('MOD', 'start', { user: { id: 'BOT2', bot: true } }); await w.run(botTarget); check(botTarget, /pada bot/);
  check(await w.softban('NOBODY'), /tidak ada di server/);
  check(await w.softban('PLAIN'), /tidak punya role Verified/);
  check(await w.softban('HIGH'), /sama dengan atau lebih tinggi/);
  w.guild.ownerId = 'OWNER'; check(await w.softban('OWNER'), /Pemilik server/); w.guild.ownerId = 'OWN';
  w.botMember.permissions = perms(); check(await w.softban('U1'), /Manage Roles.*LEBIH TINGGI/s);
  w.botMember.permissions = perms(P.ManageRoles); w.botMember.roles.highest.position = 5; check(await w.softban('U1'), /Manage Roles.*LEBIH TINGGI/s);
  assert.equal(w.members.get('U1').roles.cache.has('VERIFIED'), true, 'tidak ada role yang dicabut pada penolakan');
  const w2 = await world({ configure: false }); verifiedUser(w2);
  assert.match(w2.said(await w2.softban('U1')), /Verifikasi belum dikonfigurasi/);
});
test('start: kasus ganda ditolak; role gagal dicabut -> kasus dibatalkan + audit gagal + boleh dicoba lagi', async () => {
  const w = await world(); const u = verifiedUser(w);
  u.failRemove = true;
  const bad = await w.softban('U1');
  assert.match(w.said(bad), /Gagal mencabut role Verified: Missing Permissions.*kasus #1 dibatalkan/s);
  assert.equal(w.rowOf(1).status, 'cancelled'); assert.equal(u.roles.cache.has('VERIFIED'), true);
  const failed = w.storage.audit.list({ guildId: 'G1', action: 'softban_verify_role_removed' })[0];
  assert.deepEqual([failed.status, failed.reason], ['failed', 'Missing Permissions']);
  assert.equal(w.sent.CH_V.length, 0, 'tidak ada pengumuman kalau pencabutan gagal');

  u.failRemove = false;
  assert.match(w.said(await w.softban('U1')), /kasus #2/);
  assert.match(w.said(await w.softban('U1')), /sudah punya kasus #2 \(menunggu verifikasi ulang\)/);
});
test('start: database gagal sebelum pencabutan -> role TIDAK dicabut; audit gagal SETELAH pencabutan tidak menggagalkan tindakan', async () => {
  const w = await world(); const u = verifiedUser(w);
  const real = w.storage.audit.log; w.storage.audit.log = () => { throw new Error('disk penuh'); };
  const bad = await w.softban('U1');
  assert.match(w.said(bad), /Terjadi kesalahan/);
  assert.equal(u.roles.cache.has('VERIFIED'), true, 'role tidak boleh dicabut tanpa kasus tersimpan'); assert.equal(w.rowOf(1), undefined);

  w.storage.audit.log = (e) => { if (e.action === 'softban_verify_role_removed' || e.action === 'softban_verify_restriction_check') throw new Error('disk penuh'); return real(e); };
  const ok = await w.softban('U1');
  assert.match(w.said(ok), /Softban-verifikasi dimulai/); assert.equal(u.roles.cache.has('VERIFIED'), false);
  assert.ok(w.logs.errors.some((m) => /Gagal mencatat audit \(softban_verify_role_removed\)/.test(m)));
});

/* ---------------- verifikasi ulang -> menunggu persetujuan ---------------- */
test('INVARIAN: anggota softban yang lolos verifikasi ulang TIDAK mendapat role; kasus menunggu persetujuan; staf diberi tombol', async () => {
  const w = await world(); verifiedUser(w); await w.softban('U1');
  const { answer } = await w.reverify('U1');
  assert.match(w.said(answer), /Verifikasi ulang Anda tercatat; staf akan meninjau/);
  assert.equal(w.adds('U1').length, 0, 'role tidak boleh diberikan');
  assert.equal(w.members.get('U1').roles.cache.has('VERIFIED'), false);
  const row = w.rowOf(1); assert.equal(row.status, 'pending_approval'); assert.ok(row.verifiedAt > 0);
  const order = w.actions(); assert.ok(order.indexOf('softban_verify_pending') >= 0 && order.indexOf('softban_verify_pending') < order.indexOf('verification_pass'), 'pending dicatat sebelum verification_pass');
  const notice = w.sent.CH_LOG.at(-1);
  assert.match(notice.content, /Verifikasi ulang lolos.*kasus #1.*<@U1>.*BELUM dipulihkan/s);
  assert.deepEqual(notice.components[0].data.components.map((b) => b.data.customId), ['sbv:approve:1', 'sbv:reject:1']);
  assert.deepEqual(notice.allowedMentions, { parse: [] }, 'tidak mem-ping siapa pun');
  const again = await w.startVerify('U1');
  assert.match(w.said(again), /sudah lolos dan sedang menunggu persetujuan staf/);
  assert.equal(w.adds('U1').length, 0);
});
test('INVARIAN: kasus ditolak memblokir semua jalur (mulai baru dan sesi yang sudah berjalan); anggota biasa tidak terpengaruh', async () => {
  const w = await world(); verifiedUser(w); await w.softban('U1');
  const s = await w.startVerify('U1'); const sid = w.sidOf(s);          // sesi berjalan SEBELUM ditolak
  await w.sbAction('reject', 1, { reason: 'akun dicurigai' });
  assert.equal(w.rowOf(1).status, 'rejected');
  const late = await w.answerVerify('U1', sid);
  assert.match(w.said(late), /tidak dapat dipulihkan otomatis/); assert.equal(w.adds('U1').length, 0);
  assert.match(w.said(await w.startVerify('U1')), /tidak dapat dipulihkan otomatis/);
  assert.equal(w.rowOf(1).status, 'rejected', 'verifikasi tidak mengubah kasus yang ditolak');

  const normal = w.member('NEWBIE', { roles: [] });                       // regresi: anggota tanpa kasus tetap normal
  const r = await w.reverify('NEWBIE');
  assert.match(w.said(r.answer), /Verifikasi berhasil/); assert.equal(w.adds('NEWBIE').length, 1); assert.ok(normal.roles.cache.has('VERIFIED'));
});
test('INVARIAN: database gagal saat memeriksa kasus saat lolos verifikasi -> role TIDAK diberikan (gagal-tertutup)', async () => {
  const w = await world(); verifiedUser(w); await w.softban('U1');
  const s = await w.startVerify('U1'); const sid = w.sidOf(s);
  const real = w.storage.softbans.getBlocking; w.storage.softbans.getBlocking = () => { throw new Error('disk error'); };
  const i = await w.answerVerify('U1', sid);
  assert.match(w.said(i), /TIDAK dianggap berhasil/); assert.equal(w.adds('U1').length, 0);
  assert.equal(w.rowOf(1).status, 'awaiting_verification');
  w.storage.softbans.getBlocking = real;
  assert.match(w.said(await w.answerVerify('U1', sid)), /tercatat; staf akan meninjau/);
});

/* ---------------- approve / reject / cancel ---------------- */
async function pendingCase(w, id = 'U1') { verifiedUser(w, id); await w.softban(id); await w.reverify(id); }

test('approve: hanya setelah lolos verifikasi ulang; keputusan tersimpan DULU lalu role dipulihkan; tidak bisa dua kali; tercatat lengkap', async () => {
  const w = await world(); verifiedUser(w); await w.softban('U1');
  const early = await w.sbAction('approve', 1);
  assert.match(w.said(early), /belum lolos verifikasi ulang/); assert.equal(w.adds('U1').length, 0);
  await w.reverify('U1');

  const denied = await w.sbAction('approve', 1, { perm: perms(P.SendMessages) }); assert.match(w.said(denied), /tidak punya izin/);
  assert.equal(w.adds('U1').length, 0); assert.equal(w.rowOf(1).status, 'pending_approval');
  const missing = await w.sbAction('approve', 99); assert.match(w.said(missing), /tidak ditemukan/);

  const ok = await w.sbAction('approve', 1);
  assert.match(w.said(ok), /Kasus #1 disetujui. Role Verified dipulihkan untuk <@U1>/);
  const row = w.rowOf(1); assert.deepEqual([row.status, row.decidedBy], ['approved', 'MOD']); assert.ok(row.roleRestoredAt > 0);
  assert.deepEqual(w.adds('U1').map((o) => o[1]), ['VERIFIED']); assert.match(w.adds('U1')[0][2], /approve oleh MOD/);
  assert.ok(w.actions().includes('softban_verify_approve') && w.actions().includes('softban_verify_role_restored'));
  assert.match(w.sent.CH_LOG.at(-1).content, /Kasus #1.*disetujui oleh <@MOD>.*role Verified dipulihkan/s);
  assert.match(w.said(await w.sbAction('approve', 1)), /sudah disetujui/); assert.equal(w.adds('U1').length, 1);
  assert.match(w.said(await w.startVerify('U1')), /sudah terverifikasi/);
});
test('approve: tidak bisa menyetujui kasus milik sendiri', async () => {
  const w = await world(); await pendingCase(w);
  const self = await w.sbAction('approve', 1, { by: 'U1', perm: perms(P.ModerateMembers) });
  assert.match(w.said(self), /tidak bisa memutuskan kasus milik sendiri/); assert.equal(w.adds('U1').length, 0); assert.equal(w.rowOf(1).status, 'pending_approval');
});
test('approve: role gagal dipulihkan -> keputusan tetap tersimpan, pesan jujur, percobaan ulang berhasil tanpa dobel', async () => {
  const w = await world(); await pendingCase(w); const u = w.members.get('U1');
  u.failAdd = true;
  const bad = await w.sbAction('approve', 1);
  assert.match(w.said(bad), /disetujui, tetapi role gagal dipulihkan: Missing Permissions.*mencoba ulang/s);
  const row = w.rowOf(1); assert.deepEqual([row.status, row.roleRestoredAt], ['approved', null]);
  assert.equal(w.storage.audit.list({ guildId: 'G1', action: 'softban_verify_role_restore_failed' })[0].status, 'failed');
  assert.match(w.sent.CH_LOG.at(-1).content, /role GAGAL dipulihkan/);
  const status = w.sbCommand('MOD', 'status', { user: { id: 'U1' } }); await w.run(status);
  assert.match(w.said(status), /disetujui.*role BELUM dipulihkan/);

  u.failAdd = false;
  const retry = await w.sbAction('approve', 1);
  assert.match(w.said(retry), /dipulihkan untuk <@U1> \(percobaan ulang kasus #1\)/); assert.equal(w.adds('U1').length, 1);
  assert.ok(w.rowOf(1).roleRestoredAt > 0);
  assert.match(w.said(await w.sbAction('approve', 1)), /sudah disetujui/); assert.equal(w.adds('U1').length, 1);
});
test('approve: anggota sudah keluar dari server -> keputusan tersimpan, role gagal dengan pesan jelas', async () => {
  const w = await world(); await pendingCase(w); w.gone.add('U1');
  const i = await w.sbAction('approve', 1);
  assert.match(w.said(i), /disetujui, tetapi role gagal dipulihkan: anggota sudah tidak ada di server/);
  assert.equal(w.rowOf(1).status, 'approved');
});
test('approve: database gagal -> role TIDAK dipulihkan (keputusan tidak tersimpan = tidak ada akses)', async () => {
  const w = await world(); await pendingCase(w);
  const real = w.storage.audit.log; w.storage.audit.log = () => { throw new Error('disk penuh'); };
  const i = await w.sbAction('approve', 1);
  assert.match(w.said(i), /Terjadi kesalahan/); assert.equal(w.adds('U1').length, 0); assert.equal(w.rowOf(1).status, 'pending_approval', 'transaksi dibatalkan');
  w.storage.audit.log = real;
  assert.match(w.said(await w.sbAction('approve', 1)), /disetujui/); assert.equal(w.adds('U1').length, 1);
});
test('tombol staf: setujui/tolak oleh yang berizin memperbarui pesan; tanpa izin ditolak tanpa mengubah apa pun; tombol kedua kali ditolak', async () => {
  const w = await world(); await pendingCase(w);
  const nope = w.sbButton('RANDOM', 'sbv:approve:1', perms()); await w.run(nope);
  assert.match(w.said(nope), /tidak punya izin/); assert.equal(w.adds('U1').length, 0); assert.equal(w.rowOf(1).status, 'pending_approval'); assert.equal(nope.calls.update.length, 0);
  const odd = w.sbButton('MOD', 'sbv:aneh:1'); assert.equal(await w.softbanVerify.handle(odd), true); assert.match(w.said(odd), /tidak dikenali/);

  const yes = w.sbButton('MOD', 'sbv:approve:1'); await w.run(yes);
  assert.deepEqual(yes.calls.update[0].components, []); assert.match(yes.calls.update[0].content, /aviso.*Kasus #1 disetujui/s);
  assert.equal(w.adds('U1').length, 1);
  const again = w.sbButton('MOD', 'sbv:approve:1'); await w.run(again);
  assert.match(w.said(again), /sudah disetujui/); assert.equal(again.calls.update.length, 0); assert.equal(w.adds('U1').length, 1);

  const w2 = await world(); await pendingCase(w2);
  const no = w2.sbButton('MOD', 'sbv:reject:1'); await w2.run(no);
  assert.match(no.calls.update[0].content, /ditolak.*tetap dibatasi/s); assert.equal(w2.rowOf(1).status, 'rejected'); assert.equal(w2.adds('U1').length, 0);
});
test('reject: dari menunggu-verifikasi maupun menunggu-persetujuan; tidak dari yang sudah diputuskan; anggota tetap dibatasi', async () => {
  const w = await world(); verifiedUser(w); await w.softban('U1');
  const r1 = await w.sbAction('reject', 1, { reason: 'tidak kooperatif' });
  assert.match(w.said(r1), /ditolak.*tetap dibatasi/s);
  const log = w.storage.audit.list({ guildId: 'G1', action: 'softban_verify_reject' })[0]; assert.deepEqual([log.actorId, log.targetId, log.reason], ['MOD', 'U1', 'tidak kooperatif']);
  assert.match(w.sent.CH_LOG.at(-1).content, /ditolak oleh <@MOD>.*tidak kooperatif/s);
  assert.match(w.said(await w.sbAction('reject', 1)), /sudah ditolak/);
  assert.match(w.said(await w.sbAction('approve', 1)), /sudah ditolak/); assert.equal(w.adds('U1').length, 0);
  assert.match(w.said(await w.softban('U1')), /sudah punya kasus #1 \(ditolak\)/);
});
test('cancel: staf memulihkan akses langsung (dari menunggu/ditolak), tercatat; percobaan ulang bila role gagal; tidak dari yang sudah selesai', async () => {
  const w = await world(); verifiedUser(w); await w.softban('U1');
  w.members.get('U1').failAdd = true;
  const bad = await w.sbAction('cancel', 1, { reason: 'salah orang' });
  assert.match(w.said(bad), /dibatalkan, tetapi role gagal dipulihkan/); assert.equal(w.rowOf(1).status, 'cancelled');
  w.members.get('U1').failAdd = false;
  const retry = await w.sbAction('cancel', 1); assert.match(w.said(retry), /percobaan ulang kasus #1/);
  assert.deepEqual(w.adds('U1').map((o) => o[1]), ['VERIFIED']);
  assert.match(w.said(await w.sbAction('cancel', 1)), /sudah dibatalkan/);
  assert.ok(w.actions().includes('softban_verify_cancel'));
  assert.match(w.said(await w.softban('U1')), /kasus #2/, 'setelah selesai, anggota bisa dikenai softban-verifikasi lagi');

  const r = await world(); verifiedUser(r); await r.softban('U1'); await r.sbAction('reject', 1);
  const c = await r.sbAction('cancel', 1); assert.match(r.said(c), /dibatalkan. Role Verified dipulihkan/); assert.equal(r.adds('U1').length, 1);
});
test('INVARIAN: semua jalur selain keputusan staf yang sah tidak pernah memberi role (urutan percobaan)', async () => {
  const w = await world(); verifiedUser(w); await w.softban('U1');
  await w.sbAction('approve', 1);                                          // sebelum lolos verifikasi
  await w.sbAction('approve', 1, { by: 'U1' });                            // menyetujui diri sendiri (tanpa lolos)
  const first = await w.reverify('U1'); const oldSid = w.sidOf(first.start);
  await w.sbAction('approve', 1, { by: 'U1' });                            // menyetujui diri sendiri (lolos)
  await w.sbAction('approve', 1, { perm: perms() });                       // tanpa izin
  const noPerm = w.sbButton('U1', 'sbv:approve:1', perms()); await w.run(noPerm);
  for (let n = 0; n < 3; n++) { await w.startVerify('U1'); await w.answerVerify('U1', oldSid); } // verifikasi berulang / sid lama
  assert.equal(w.adds('U1').length, 0); assert.equal(w.rowOf(1).status, 'pending_approval');
  await w.sbAction('approve', 1);
  assert.equal(w.adds('U1').length, 1, 'tepat satu pemulihan, setelah keputusan staf yang sah');
});

/* ---------------- status & /verification public ---------------- */
test('status: daftar kasus yang menunggu; per anggota; kosong; tanpa izin', async () => {
  const w = await world(); verifiedUser(w); verifiedUser(w, 'U2'); await w.softban('U1'); await w.softban('U2'); await w.reverify('U2');
  const all = w.sbCommand('MOD', 'status'); await w.run(all);
  assert.match(w.said(all), /#2 • <@U2> • MENUNGGU PERSETUJUAN.*#1 • <@U1> • menunggu verifikasi ulang.*perilaku mencurigakan/s);
  const one = w.sbCommand('MOD', 'status', { user: { id: 'U1' } }); await w.run(one); assert.match(w.said(one), /#1/); assert.ok(!/#2/.test(w.said(one)));
  const none = w.sbCommand('MOD', 'status', { user: { id: 'NOBODY' } }); await w.run(none); assert.match(w.said(none), /tidak punya kasus/);
  const denied = w.sbCommand('MOD', 'status', {}, perms()); await w.run(denied); assert.match(w.said(denied), /tidak punya izin/);
  const empty = await world(); const e = empty.sbCommand('MOD', 'status'); await empty.run(e); assert.match(empty.said(e), /Tidak ada kasus yang menunggu/);
});
test('/verification public: menandai channel publik (disimpan + audit), mencabut, batas 20, server lain ditolak, status menampilkan', async () => {
  const w = await world();
  const cmd = (opts, perm = perms(P.ManageGuild)) => {
    const calls = { reply: [], edit: [], update: [], modal: [] };
    const i = { user: { id: 'ADMIN' }, guild: w.guild, commandName: 'verification', memberPermissions: perm, calls, replied: false, deferred: false, inGuild: () => true,
      isButton: () => false, isModalSubmit: () => false, isChatInputCommand: () => true,
      options: { getSubcommand: () => opts.sub, getChannel: () => opts.channel, getBoolean: () => opts.remove ?? null, getRole: () => null },
      reply: async (o) => { calls.reply.push(o); i.replied = true; } };
    return i;
  };
  const run = async (opts, perm) => { const i = cmd(opts, perm); await w.run(i); return i; };
  w.storage.settings.set('G1', 'verify.publicChannelIds', []);
  assert.match(w.said(await run({ sub: 'public', channel: { id: 'CH_RULES', guildId: 'G1' } }, perms())), /tidak punya izin/);
  assert.match(w.said(await run({ sub: 'public', channel: { id: 'CH_RULES', guildId: 'G1' } })), /<#CH_RULES> ditandai sebagai channel publik/);
  assert.deepEqual(w.storage.settings.get('G1', 'verify.publicChannelIds'), ['CH_RULES']);
  assert.ok(w.actions().includes('config_change'));
  assert.match(w.said(await run({ sub: 'public', channel: { id: 'X', guildId: 'G2' } })), /channel di server ini/);
  assert.match(w.said(await run({ sub: 'status' })), /Channel publik: <#CH_RULES>/);
  assert.match(w.said(await run({ sub: 'public', channel: { id: 'CH_RULES', guildId: 'G1' }, remove: true })), /dihapus dari daftar channel publik/);
  assert.deepEqual(w.storage.settings.get('G1', 'verify.publicChannelIds'), []);
  for (let n = 0; n < 20; n++) await run({ sub: 'public', channel: { id: `C${n}`, guildId: 'G1' } });
  assert.match(w.said(await run({ sub: 'public', channel: { id: 'LAGI', guildId: 'G1' } })), /Maksimal 20/);
});
test('routing: interaksi lain diabaikan; di luar server; database nonaktif', async () => {
  const w = await world();
  assert.equal(await w.softbanVerify.handle({ isChatInputCommand: () => false, isButton: () => false }), false);
  assert.equal(await w.softbanVerify.handle(w.sbButton('MOD', 'bw:start:1:U1')), false);
  const dm = w.sbCommand('MOD', 'status'); dm.inGuild = () => false; await w.run(dm); assert.match(w.said(dm), /hanya bisa dipakai di server/);
  const off = createSoftbanVerify({ storage: null, log: { warn() {}, error() {} } });
  const i = w.sbCommand('MOD', 'status'); await off.handle(i); assert.match(w.said(i), /nonaktif: database tidak tersedia/);
  const b = w.sbButton('MOD', 'sbv:approve:1'); await off.handle(b); assert.match(w.said(b), /nonaktif/);
});

/* ---------------- repo ---------------- */
test('repo softbans: satu kasus memblokir per anggota, markPending atomik, transisi hanya dari status yang diizinkan, isolasi server', () => {
  const db = openDatabase(':memory:'); let t = 100; const r = createSoftbanRepo(db, { now: () => t++ });
  const a = r.open({ guildId: 'G1', userId: 'U1', moderatorId: 'M', reason: 'x' });
  assert.deepEqual([a.ok, a.row.status, a.row.createdAt], [true, 'awaiting_verification', 100]);
  const dup = r.open({ guildId: 'G1', userId: 'U1', moderatorId: 'M2' }); assert.deepEqual([dup.ok, dup.existing.id], [false, a.row.id]);
  assert.equal(r.open({ guildId: 'G2', userId: 'U1', moderatorId: 'M' }).ok, true, 'server lain terpisah');
  assert.equal(r.getBlocking('G1', 'U1').id, a.row.id); assert.equal(r.getBlocking('G1', 'ZZ'), undefined);
  assert.equal(r.markPending('G1', 'ZZ'), undefined);
  assert.equal(r.markPending('G1', 'U1').status, 'pending_approval'); assert.equal(r.markPending('G1', 'U1'), undefined, 'hanya dari awaiting_verification');
  assert.equal(r.transition({ guildId: 'G1', id: a.row.id, from: ['awaiting_verification'], to: 'rejected', by: 'S' }).reason, 'wrong_status');
  assert.deepEqual(r.transition({ guildId: 'G2', id: a.row.id, from: ['pending_approval'], to: 'approved', by: 'S' }), { ok: false, reason: 'not_found' });
  const ok = r.transition({ guildId: 'G1', id: a.row.id, from: ['pending_approval'], to: 'approved', by: 'S', note: 'ok' });
  assert.deepEqual([ok.ok, ok.row.status, ok.row.decidedBy, ok.row.decisionNote], [true, 'approved', 'S', 'ok']);
  assert.equal(r.getBlocking('G1', 'U1'), undefined, 'approved tidak memblokir');
  assert.equal(r.open({ guildId: 'G1', userId: 'U1', moderatorId: 'M' }).ok, true, 'boleh membuka kasus baru setelah selesai');
  assert.equal(r.markRoleRestored('G1', a.row.id), true); assert.equal(r.markRoleRestored('G1', a.row.id), false);
  assert.throws(() => db.prepare("INSERT INTO verify_softbans (guild_id,user_id,moderator_id,status,created_at) VALUES ('G1','U1','M','bebas',1)").run(), /CHECK/);
  assert.equal(r.list({ guildId: 'G1' }).length, 1); assert.equal(r.list({ guildId: 'G1', statuses: ['approved'] }).length, 1);
  db.close();
});
