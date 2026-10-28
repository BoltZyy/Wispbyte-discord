'use strict';
/**
 * Tes filter kata terlarang (tahap 5): penghapusan pesan, pemberitahuan, challenge, pass, /modpass.
 * Database = node:sqlite ASLI. Objek Discord = fake yang MENIRU perilaku asli yang pernah menggigit kita:
 *  - message.member selalu null (cache anggota dimatikan), data anggota hanya lewat guild.members.fetch();
 *  - guild.members.me == null; fetch anggota yang sudah keluar melempar kode 10007;
 *  - message.delete() bisa gagal (50013) atau pesan sudah hilang (10008).
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
const P = { Administrator: 1n << 3n, ManageGuild: 1n << 5n, ManageMessages: 1n << 13n };
const mk = (Cls) => class { constructor() { return Cls(); } };
const discordStub = {
  SlashCommandBuilder: mk(recorder), ActionRowBuilder: mk(dataBuilder), ButtonBuilder: mk(dataBuilder),
  PermissionFlagsBits: P, ButtonStyle: { Primary: 1, Secondary: 2 }, ChannelType: { GuildText: 0 }, MessageFlags: { Ephemeral: 64 },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'discord.js' ? discordStub : origLoad.call(this, request, ...rest); };

const { buildModpassCommandList, createWordFilter } = require('../src/discord/wordFilter');
const { createBannedWords } = require('../src/discord/bannedWords');
const { generateChallenge } = require('../src/core/challenge');
const { initStorage } = require('../src/storage');
const { openDatabase } = require('../src/storage/db');
const { createPassesRepo, createRulesRepo } = require('../src/storage/repositories');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovelia-wf-'));
const perms = (...flags) => { const bits = flags.reduce((a, f) => a | f, 0n); const admin = (bits & P.Administrator) !== 0n; return { has: (f) => (Array.isArray(f) ? f : [f]).every((x) => admin || (bits & x) === x) }; };
// mulberry32: sebaran bagus walau seed kecil (LCG sederhana menghasilkan nilai pertama yang nyaris sama untuk seed kecil)
const lcg = (seed = 7) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const flush = () => new Promise((r) => setImmediate(r));
const DAY = 24 * 3600 * 1000;

/* ---------------- dunia uji ---------------- */
function world({ filter = {}, nullStorage = false } = {}) {
  const storage = nullStorage ? null : initStorage({ dbPath: path.join(tmpDir(), 'w.sqlite'), log: { log() {}, error() {} } });
  const clock = { t: 10_000_000 }; const now = () => clock.t;
  if (storage) storage.passes = createPassesRepo(storage.db, { now }); // pass memakai jam yang disuntik (kedaluwarsa bisa diuji)
  const logs = { errors: [], warns: [] };
  const log = { log() {}, warn: (m) => logs.warns.push(m), error: (m) => logs.errors.push(m) };
  const bw = createBannedWords({ storage, log });
  const scheduled = [];
  const schedule = (fn, ms) => { scheduled.push({ fn, ms }); return {}; };
  const wf = createWordFilter({ storage, bannedWords: bw, now, rng: lcg(), schedule, log, ...filter });

  const members = new Map(); const fetchCalls = [];
  const modlogSent = []; const modlog = { id: 'CH_LOG', isTextBased: () => true, send: async (m) => { modlogSent.push(m); } };
  const guild = {
    id: 'G1', ownerId: 'OWN',
    members: { me: null, fetchMe: async () => ({ id: 'BOT' }),
      fetch: async (id) => { fetchCalls.push(id); if (filter.fetchError) throw filter.fetchError; const m = members.get(id); if (!m) { const e = new Error('Unknown Member'); e.code = 10007; throw e; } return m; } },
    channels: { fetch: async (id) => (id === 'CH_LOG' ? modlog : null) },
  };
  if (storage) storage.settings.set('G1', 'modlog.channelId', 'CH_LOG');
  const memberOf = (id, { roles = [], perm = perms() } = {}) => { const m = { id, roles: { cache: new Map(roles.map((r) => [r, { id: r }])) }, permissions: perm }; members.set(id, m); return m; };

  const rule = (extra = {}) => {
    const r = storage.rules.add({ guildId: 'G1', name: 'Anti-Scam', phrase: 'check my bio', mode: 'evasion', reason: 'Promosi mencurigakan', createdBy: 'ADMIN', ...extra });
    bw.invalidate('G1'); return r;
  };
  const sentInChannel = []; let noticeFail = false;
  const channel = (id = 'CH1', parentId = null) => ({ id, parentId, send: async (p) => { if (noticeFail) throw new Error('Missing Access'); sentInChannel.push(p); return { delete: async () => {} }; } });
  const deletes = [];
  const message = ({ id = `M${deletes.length + sentInChannel.length + Math.random()}`, content = 'ch3ck my b1o', userId = 'U1', channelId = 'CH1', parentId = null, deleteError = null, extra = {} } = {}) => ({
    id, content, author: { id: userId, bot: false }, guild, channelId, channel: channel(channelId, parentId), member: null, webhookId: null, system: false,
    delete: async () => { deletes.push(id); if (deleteError) throw deleteError; },
    ...extra,
  });
  // satu channel bersama agar notifikasi terkumpul di satu tempat
  const sharedChannel = channel('CH1'); const msg = (o = {}) => { const m = message(o); m.channel = o.parentId ? channel(m.channelId, o.parentId) : sharedChannel; m.channel.send = sharedChannel.send; return m; };
  sharedChannel.send = async (p) => { if (noticeFail) throw new Error('Missing Access'); sentInChannel.push(p); return { delete: async () => {} }; };

  const button = (userId, customId) => {
    const calls = { reply: [], update: [] };
    const i = { user: { id: userId }, guild, customId, calls, replied: false, deferred: false, inGuild: () => true, isButton: () => true, isChatInputCommand: () => false,
      reply: async (o) => { calls.reply.push(o); i.replied = true; }, update: async (o) => { calls.update.push(o); }, editReply: async (o) => { calls.reply.push(o); } };
    return i;
  };
  const command = (sub, opts = {}, perm = perms(P.ManageGuild)) => {
    const calls = { reply: [], update: [] };
    const i = { user: { id: 'ADMIN' }, guild, commandName: 'modpass', memberPermissions: perm, calls, replied: false, deferred: false, inGuild: () => true,
      isChatInputCommand: () => true, isButton: () => false,
      options: { getSubcommand: () => sub, getUser: (n) => opts[n] ?? null, getInteger: (n) => opts[n], getString: (n) => opts[n] ?? null },
      reply: async (o) => { calls.reply.push(o); i.replied = true; } };
    return i;
  };
  const said = (i) => (i.calls.update.at(-1) ?? i.calls.reply.at(-1)).content;
  const view = (i) => i.calls.update.at(-1) ?? i.calls.reply.at(-1);
  const buttonsOf = (v) => (v.components?.[0]?.data.components ?? []).map((b) => b.data);
  const dump = () => JSON.stringify(storage.db.prepare('SELECT * FROM moderation_logs').all());

  /** Memecahkan soal HANYA dari teks yang terlihat peserta. */
  const solve = (v) => {
    const prompt = v.content.split('\n').find((l) => /^(Berapa|Pilih angka|Tekan tombol)/.test(l)); const labels = buttonsOf(v).map((b) => b.label);
    let m;
    if ((m = /^Berapa (\d+) \+ (\d+)\?/.exec(prompt))) return labels.indexOf(String(+m[1] + +m[2]));
    if ((m = /^Berapa (\d+) - (\d+)\?/.exec(prompt))) return labels.indexOf(String(+m[1] - +m[2]));
    if (/TERBESAR/.test(prompt)) return labels.indexOf(String(Math.max(...labels.map(Number))));
    if ((m = /bertuliskan: (\w+)/.exec(prompt))) return labels.indexOf(m[1]);
    throw new Error(`soal tak dikenal: ${prompt}`);
  };
  const wrongIndex = (v) => { const ok = solve(v); return buttonsOf(v).findIndex((_, idx) => idx !== ok); };
  const startChallenge = async (userId, ruleId, asUser = userId) => { const i = button(asUser, `bw:start:${ruleId}:${userId}`); await wf.handle(i); return i; };
  const answer = async (userId, ruleId, v, idx) => { const sid = buttonsOf(v)[0].customId.split(':')[3]; const i = button(userId, `bw:ans:${ruleId}:${sid}:${idx}`); await wf.handle(i); return i; };

  return { storage, bw, wf, clock, now, logs, scheduled, guild, members, memberOf, fetchCalls, modlogSent, sentInChannel, deletes, rule, msg, button, command, said, view, buttonsOf, dump, solve, wrongIndex, startChallenge, answer, setNoticeFail: (v) => { noticeFail = v; } };
}

/* ---------------- challenge ---------------- */
test('challenge: selalu 4 pilihan unik, bisa dipecahkan dari teks, deterministik, semua jenis soal muncul', () => {
  const kinds = new Set();
  for (let seed = 1; seed <= 300; seed++) {
    const c = generateChallenge(lcg(seed));
    assert.equal(c.options.length, 4); assert.equal(new Set(c.options).size, 4);
    assert.ok(c.correctIndex >= 0 && c.correctIndex < 4);
    assert.deepEqual(generateChallenge(lcg(seed)), c, 'rng sama -> soal sama');
    kinds.add(c.prompt.split(' ')[0]);
    // jawaban benar harus konsisten dengan teks soal
    const label = c.options[c.correctIndex]; let m;
    if ((m = /^Berapa (\d+) \+ (\d+)\?/.exec(c.prompt))) assert.equal(label, String(+m[1] + +m[2]));
    else if ((m = /^Berapa (\d+) - (\d+)\?/.exec(c.prompt))) assert.equal(label, String(+m[1] - +m[2]));
    else if (/TERBESAR/.test(c.prompt)) assert.equal(label, String(Math.max(...c.options.map(Number))));
    else assert.match(c.prompt, new RegExp(`bertuliskan: ${label}$`));
  }
  assert.deepEqual([...kinds].sort(), ['Berapa', 'Pilih', 'Tekan']);
});

/* ---------------- penyaringan pesan ---------------- */
test('screen: pesan biasa -> false tanpa REST (tidak mengambil data anggota)', async () => {
  const w = world(); w.rule();
  assert.equal(await w.wf.screen(w.msg({ content: 'halo semuanya, apa kabar?' })), false);
  assert.equal(w.fetchCalls.length, 0); assert.equal(w.deletes.length, 0);
});
test('screen: pesan melanggar -> dihapus, audit tanpa isi pesan, pemberitahuan publik dengan tombol challenge', async () => {
  const w = world(); const r = w.rule({ allowPass: true });
  const m = w.msg({ id: 'MSG1', content: 'Ch3ck my b1o plz' });
  assert.equal(await w.wf.screen(m), true);
  assert.deepEqual(w.deletes, ['MSG1']); assert.deepEqual(w.fetchCalls, ['U1'], 'REST tepat sekali');
  const log = w.storage.audit.list({ guildId: 'G1' })[0];
  assert.deepEqual([log.action, log.targetId, log.status, log.details.ruleIds, log.details.deleted], ['banned_word_hit', 'U1', 'ok', [r.id], true]);
  assert.ok(!w.dump().toLowerCase().includes('b1o'), 'isi pesan tidak boleh masuk database');
  const notice = w.sentInChannel[0];
  assert.match(notice.content, /<@U1> dihapus: Promosi mencurigakan.*tombol di bawah/s);
  assert.deepEqual(notice.allowedMentions, { users: ['U1'] });
  const btn = notice.components[0].data.components[0].data;
  assert.deepEqual([btn.customId, btn.label], [`bw:start:${r.id}:U1`, 'Verifikasi saya']);
  assert.ok(w.scheduled.some((s) => s.ms === 10 * 60_000), 'notifikasi dijadwalkan untuk dibersihkan');
});
test('screen: aturan tanpa allow-pass -> pemberitahuan tanpa tombol', async () => {
  const w = world(); w.rule({ allowPass: false });
  await w.wf.screen(w.msg());
  assert.equal(w.sentInChannel[0].components, undefined); assert.ok(!/tombol/.test(w.sentInChannel[0].content));
});
test('screen: staf (ManageMessages/Administrator/pemilik server) dan pengecualian role/channel/thread tidak dihapus', async () => {
  const w = world(); const r = w.rule();
  w.memberOf('MOD', { perm: perms(P.ManageMessages) }); w.memberOf('ADM', { perm: perms(P.Administrator) }); w.memberOf('OWN');
  for (const u of ['MOD', 'ADM', 'OWN']) assert.equal(await w.wf.screen(w.msg({ userId: u })), false, u);
  assert.equal(w.deletes.length, 0);

  w.storage.rules.setExempt('G1', r.id, 'role', 'ROLE_OK', true); w.storage.rules.setExempt('G1', r.id, 'channel', 'CH_OK', true); w.bw.invalidate('G1');
  w.memberOf('U_ROLE', { roles: ['ROLE_OK'] }); w.memberOf('U_PLAIN');
  assert.equal(await w.wf.screen(w.msg({ userId: 'U_ROLE' })), false, 'role dikecualikan');
  assert.equal(await w.wf.screen(w.msg({ userId: 'U_PLAIN', channelId: 'CH_OK' })), false, 'channel dikecualikan');
  assert.equal(await w.wf.screen(w.msg({ userId: 'U_PLAIN', channelId: 'THREAD1', parentId: 'CH_OK' })), false, 'thread di bawah channel yang dikecualikan');
  assert.equal(w.deletes.length, 0);
  assert.equal(await w.wf.screen(w.msg({ userId: 'U_PLAIN' })), true, 'pengguna biasa tetap kena');
});
test('screen: bot, webhook, pesan sistem, DM, kosong, dan non-teks diabaikan', async () => {
  const w = world(); w.rule();
  const bad = [
    w.msg({ extra: { author: { id: 'B', bot: true } } }), w.msg({ extra: { webhookId: 'WH' } }), w.msg({ extra: { system: true } }),
    w.msg({ extra: { guild: null } }), w.msg({ content: '' }), w.msg({ extra: { content: undefined } }),
  ];
  for (const m of bad) assert.equal(await w.wf.screen(m), false);
  assert.equal(await w.wf.screen(null), false);
  assert.equal(w.deletes.length, 0); assert.equal(w.fetchCalls.length, 0);
  const off = world({ nullStorage: true });
  assert.equal(await off.wf.screen(off.msg()), false, 'database nonaktif -> tidak memfilter (gagal-aman)');
});
test('screen: anggota sudah keluar (10007) tetap diproses; kegagalan REST lain -> gagal-aman (tidak dihapus)', async () => {
  const w = world(); w.rule();
  assert.equal(await w.wf.screen(w.msg({ userId: 'GONE' })), true);
  assert.equal(w.deletes.length, 1);

  const boom = Object.assign(new Error('Internal Server Error'), { code: 500 });
  const f = world({ filter: { fetchError: boom } }); f.rule();
  assert.equal(await f.wf.screen(f.msg()), false);
  assert.equal(f.deletes.length, 0); assert.match(f.logs.errors[0], /gagal-aman/);
});
test('screen: gagal menghapus (50013) -> audit "failed", tanpa pemberitahuan, staf diberi tahu SEKALI per jendela waktu', async () => {
  const w = world(); w.rule();
  const err = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  assert.equal(await w.wf.screen(w.msg({ id: 'A', deleteError: err })), true);
  const log = w.storage.audit.list({ guildId: 'G1' })[0];
  assert.deepEqual([log.status, log.details.deleted], ['failed', false]); assert.match(log.details.error, /Missing Permissions/);
  assert.equal(w.sentInChannel.length, 0, 'tidak ada pemberitahuan publik kalau pesan masih terlihat');
  assert.equal(w.modlogSent.length, 1); assert.match(w.modlogSent[0].content, /gagal menghapus.*<#CH1>.*<@U1>.*50013/s);
  await w.wf.screen(w.msg({ id: 'B', deleteError: err }));
  assert.equal(w.modlogSent.length, 1, 'peringatan staf tidak berulang dalam jendela waktu');
  w.clock.t += 10 * 60_000 + 1;
  await w.wf.screen(w.msg({ id: 'C', deleteError: err }));
  assert.equal(w.modlogSent.length, 2);
});
test('screen: pesan sudah hilang (10008) dianggap terhapus', async () => {
  const w = world(); w.rule();
  assert.equal(await w.wf.screen(w.msg({ deleteError: Object.assign(new Error('Unknown Message'), { code: 10008 }) })), true);
  assert.equal(w.storage.audit.list({ guildId: 'G1' })[0].status, 'ok'); assert.equal(w.sentInChannel.length, 1);
});
test('screen: idempoten (dua pemanggil, satu pesan), edit ber-isi baru diperiksa ulang, edit tanpa isi/parsial dilewati', async () => {
  const w = world(); w.rule();
  const m = w.msg({ id: 'SAMA' });
  const [a, b] = await Promise.all([w.wf.screen(m), w.wf.screen(m)]);
  assert.deepEqual([a, b], [true, true]); assert.deepEqual(w.deletes, ['SAMA']); assert.equal(w.sentInChannel.length, 1);
  assert.equal(await w.wf.screen(m), true); assert.equal(w.deletes.length, 1, 'panggilan ketiga memakai hasil yang sama');

  const clean = w.msg({ id: 'EDIT', content: 'halo apa kabar' });
  assert.equal(await w.wf.screen(clean), false);
  const edited = { ...clean, content: 'check my bio!', editedTimestamp: 123 };
  assert.equal(await w.wf.screenEdit({ partial: true }, edited), true, 'edit menjadi melanggar tertangkap');
  assert.deepEqual(w.deletes, ['SAMA', 'EDIT']);
  assert.equal(w.storage.audit.list({ guildId: 'G1' })[0].details.edited, true);
  assert.equal(await w.wf.screenEdit({}, { ...clean, content: undefined }), false, 'edit tanpa isi (mis. embed otomatis)');
  assert.equal(await w.wf.screenEdit({}, { ...clean, author: null }), false);
  assert.equal(await w.wf.screenEdit({}, null), false);
});
test('screen: register() memasang listener messageUpdate yang menyaring edit', async () => {
  const w = world(); w.rule();
  const handlers = {}; w.wf.register({ on: (e, f) => { handlers[e] = f; } });
  assert.equal(typeof handlers.messageUpdate, 'function');
  handlers.messageUpdate({ partial: true }, w.msg({ id: 'E1', content: 'check my bio' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(w.deletes, ['E1']);
});
test('notifikasi: satu per pengguna per jendela (anti-amplifikasi), pesan tetap dihapus; kegagalan kirim tidak melempar', async () => {
  const w = world(); w.rule();
  await w.wf.screen(w.msg({ id: 'M1' })); await w.wf.screen(w.msg({ id: 'M2' })); await w.wf.screen(w.msg({ id: 'M3' }));
  assert.equal(w.deletes.length, 3); assert.equal(w.sentInChannel.length, 1);
  await w.wf.screen(w.msg({ id: 'M4', userId: 'U2' })); assert.equal(w.sentInChannel.length, 2, 'pengguna lain punya jendelanya sendiri');
  w.clock.t += 30_001; await w.wf.screen(w.msg({ id: 'M5' })); assert.equal(w.sentInChannel.length, 3);

  const f = world(); f.rule(); f.setNoticeFail(true);
  assert.equal(await f.wf.screen(f.msg()), true); assert.equal(f.deletes.length, 1);
  assert.match(f.logs.warns.join('\n'), /Gagal mengirim pemberitahuan/);
});

/* ---------------- pass ---------------- */
test('pass: pass aktif melewatkan aturan; kedaluwarsa, dicabut (seketika), atau allow-pass dimatikan -> kembali dihapus', async () => {
  const w = world(); const r = w.rule({ allowPass: true, passDays: 5 });
  w.storage.passes.grant({ guildId: 'G1', userId: 'U1', ruleId: r.id, passDays: 5 });
  assert.equal(await w.wf.screen(w.msg({ id: 'P1' })), false); assert.equal(w.deletes.length, 0);

  w.clock.t += 5 * DAY + 1;
  assert.equal(await w.wf.screen(w.msg({ id: 'P2' })), true, 'pass kedaluwarsa');

  const g = w.storage.passes.grant({ guildId: 'G1', userId: 'U2', ruleId: r.id, passDays: 5 });
  assert.equal(await w.wf.screen(w.msg({ id: 'P3', userId: 'U2' })), false);
  w.storage.passes.revoke({ guildId: 'G1', id: g.row.id, revokedBy: 'ADMIN' });
  assert.equal(await w.wf.screen(w.msg({ id: 'P4', userId: 'U2' })), true, 'pencabutan berlaku seketika (tanpa cache)');

  const h = w.storage.passes.grant({ guildId: 'G1', userId: 'U3', ruleId: r.id, passDays: 5 });
  assert.ok(h.row);
  w.storage.rules.update('G1', r.id, { allowPass: false }); w.bw.invalidate('G1');
  assert.equal(await w.wf.screen(w.msg({ id: 'P5', userId: 'U3' })), true, 'aturan tanpa allow-pass tidak menghormati pass');
});
test('pass: pass hanya berlaku untuk aturannya sendiri; menghapus aturan ikut menghapus pass-nya', async () => {
  const w = world(); const a = w.rule({ allowPass: true }); const b = w.rule({ name: 'Promo', phrase: 'free nitro', mode: 'exact', allowPass: true });
  w.storage.passes.grant({ guildId: 'G1', userId: 'U1', ruleId: a.id, passDays: 5 });
  assert.equal(await w.wf.screen(w.msg({ id: 'X1', content: 'check my bio' })), false);
  assert.equal(await w.wf.screen(w.msg({ id: 'X2', content: 'free nitro now' })), true, 'pass aturan A tidak melewatkan aturan B');
  assert.equal(w.storage.passes.list({ guildId: 'G1' }).length, 1);
  w.storage.rules.remove('G1', a.id);
  assert.equal(w.storage.passes.list({ guildId: 'G1', activeOnly: false }).length, 0, 'ON DELETE CASCADE');
});

/* ---------------- challenge via tombol ---------------- */
test('challenge: hanya penulis pesan yang boleh memulai; aturan harus aktif dan menawarkan pass', async () => {
  const w = world(); const r = w.rule({ allowPass: true }); const plain = w.rule({ name: 'Tanpa pass', phrase: 'free nitro', mode: 'exact', allowPass: false });
  const stolen = await w.startChallenge('U1', r.id, 'U2');
  assert.match(w.said(stolen), /bukan untuk Anda/);
  const noPass = await w.startChallenge('U1', plain.id); assert.match(w.said(noPass), /tidak lagi menawarkan verifikasi/);
  const missing = await w.startChallenge('U1', 999); assert.match(w.said(missing), /tidak lagi menawarkan verifikasi/);
  w.storage.rules.update('G1', r.id, { enabled: false }); w.bw.invalidate('G1');
  assert.match(w.said(await w.startChallenge('U1', r.id)), /tidak lagi menawarkan verifikasi/);
  w.storage.rules.update('G1', r.id, { enabled: true });
  w.storage.passes.grant({ guildId: 'G1', userId: 'U1', ruleId: r.id, passDays: 3 });
  assert.match(w.said(await w.startChallenge('U1', r.id)), /sudah punya pass/);
});
test('challenge: jawaban benar -> pass diberikan (SQLite) dan pesan berikutnya tidak dihapus; jawaban TIDAK ada di customId', async () => {
  const w = world(); const r = w.rule({ allowPass: true, passDays: 10 });
  const start = await w.startChallenge('U1', r.id);
  assert.equal(start.calls.reply[0].flags, 64);
  const ids = w.buttonsOf(w.view(start)).map((b) => b.customId);
  assert.equal(ids.length, 4); assert.ok(ids.every((id) => /^bw:ans:\d+:[0-9a-f]{12}:[0-3]$/.test(id)));
  const done = await w.answer('U1', r.id, w.view(start), w.solve(w.view(start)));
  assert.match(w.said(done), /Verifikasi berhasil.*berlaku sampai <t:\d+:d>/); assert.deepEqual(w.view(done).components, []);
  const pass = w.storage.passes.list({ guildId: 'G1' })[0];
  assert.deepEqual([pass.userId, pass.ruleId, pass.source, pass.expiresAt - pass.grantedAt], ['U1', r.id, 'challenge', 10 * DAY]);
  assert.ok(w.storage.audit.list({ guildId: 'G1', action: 'challenge_pass' }).length === 1);
  assert.equal(await w.wf.screen(w.msg({ id: 'AFTER' })), false);
  assert.match(w.said(await w.startChallenge('U1', r.id)), /sudah punya pass/);
});
test('challenge: jawaban salah -> soal baru; percobaan habis -> gagal, staf diberi tahu, cooldown 15 dtk, lalu boleh lagi', async () => {
  const w = world(); const r = w.rule({ allowPass: true });
  const start = await w.startChallenge('U1', r.id);
  const wrong1 = await w.answer('U1', r.id, w.view(start), w.wrongIndex(w.view(start)));
  assert.match(w.said(wrong1), /Jawaban salah\..*Sisa percobaan: 1/s);
  const wrong2 = await w.answer('U1', r.id, w.view(wrong1), w.wrongIndex(w.view(wrong1)));
  assert.match(w.said(wrong2), /Percobaan habis.*15 detik/);
  assert.equal(w.storage.passes.list({ guildId: 'G1' }).length, 0);
  assert.equal(w.storage.audit.list({ guildId: 'G1', action: 'challenge_fail' })[0].details.attempts, 2);
  await flush();
  assert.match(w.modlogSent.at(-1).content, /Challenge gagal: <@U1> — aturan #1 \(Anti-Scam\).*tidak ada pass/s);

  assert.match(w.said(await w.startChallenge('U1', r.id)), /Coba lagi dalam 15 detik/);
  w.clock.t += 15_000;
  const again = await w.startChallenge('U1', r.id);
  assert.match(w.said(again), /Verifikasi singkat/);
  const stale = await w.answer('U1', r.id, w.view(start), 0); // tombol dari sesi lama
  assert.match(w.said(stale), /Sesi tidak valid/);
});
test('challenge: timeout aktif lewat penjadwal -> gagal + staf diberi tahu; jawaban benar setelah habis ditolak', async () => {
  const w = world(); const r = w.rule({ allowPass: true });
  const start = await w.startChallenge('U1', r.id);
  const timer = w.scheduled.find((s) => s.ms === 60_250); assert.ok(timer, 'timeout dijadwalkan');
  w.clock.t += 61_000; timer.fn();
  assert.equal(w.storage.audit.list({ guildId: 'G1', action: 'challenge_timeout' }).length, 1);
  await flush();
  assert.match(w.modlogSent.at(-1).content, /Challenge kedaluwarsa: <@U1>/);
  const late = await w.answer('U1', r.id, w.view(start), w.solve(w.view(start)));
  assert.match(w.said(late), /Sesi berakhir/); assert.equal(w.storage.passes.list({ guildId: 'G1' }).length, 0);
  timer.fn(); assert.equal(w.storage.audit.list({ guildId: 'G1', action: 'challenge_timeout' }).length, 1, 'timer dipanggil ulang tidak menggandakan');
  assert.match(w.said(await w.startChallenge('U1', r.id)), /Coba lagi dalam 14 detik/);
});
test('challenge: jawaban benar SETELAH sesi habis ditolak walau timer penjadwal belum berjalan (pengecekan di handler)', async () => {
  const w = world(); const r = w.rule({ allowPass: true });
  const start = await w.startChallenge('U1', r.id);
  w.clock.t += 61_000; // timer TIDAK dijalankan
  const late = await w.answer('U1', r.id, w.view(start), w.solve(w.view(start)));
  assert.match(w.said(late), /Sesi berakhir/);
  assert.equal(w.storage.passes.list({ guildId: 'G1', activeOnly: false }).length, 0);
  assert.equal(w.storage.audit.list({ guildId: 'G1', action: 'challenge_timeout' }).length, 1);
  const startAgain = await w.startChallenge('U1', r.id);
  assert.match(w.said(startAgain), /Coba lagi dalam/);
});
test('challenge: pengguna lain tidak bisa memakai/membajak sesi; indeks tidak valid ditolak; satu pass walau klik ganda', async () => {
  const w = world(); const r = w.rule({ allowPass: true });
  const start = await w.startChallenge('U1', r.id);
  const sid = w.buttonsOf(w.view(start))[0].customId.split(':')[3];
  const thief = w.button('U2', `bw:ans:${r.id}:${sid}:${w.solve(w.view(start))}`); await w.wf.handle(thief);
  assert.match(w.said(thief), /Sesi tidak valid/); assert.equal(w.storage.passes.list({ guildId: 'G1' }).length, 0);
  const bad = w.button('U1', `bw:ans:${r.id}:${sid}:9`); await w.wf.handle(bad); assert.match(w.said(bad), /Pilihan tidak valid/);

  const right = w.solve(w.view(start));
  await w.answer('U1', r.id, w.view(start), right);
  const dup = await w.answer('U1', r.id, w.view(start), right);
  assert.match(w.said(dup), /sudah lolos/);
  assert.equal(w.storage.passes.list({ guildId: 'G1', activeOnly: false }).length, 1);
});
test('challenge: database gagal saat memberi pass -> tidak ada pass, pesan error jujur, boleh coba lagi', async () => {
  const w = world(); const r = w.rule({ allowPass: true });
  const start = await w.startChallenge('U1', r.id);
  const realLog = w.storage.audit.log; w.storage.audit.log = () => { throw new Error('disk penuh'); };
  const bad = await w.answer('U1', r.id, w.view(start), w.solve(w.view(start)));
  assert.match(w.said(bad), /TIDAK dianggap berhasil/); assert.equal(w.storage.passes.list({ guildId: 'G1', activeOnly: false }).length, 0, 'transaksi dibatalkan');
  w.storage.audit.log = realLog;
  const ok = await w.answer('U1', r.id, w.view(start), w.solve(w.view(start)));
  assert.match(w.said(ok), /Verifikasi berhasil/);
});
test('routing: komponen bw:* tidak dikenal, di luar server, tanpa database; interaksi lain diabaikan', async () => {
  const w = world();
  assert.equal(await w.wf.handle({ isChatInputCommand: () => false, isButton: () => false }), false);
  assert.equal(await w.wf.handle(w.button('U1', 'verify:start')), false);
  const odd = w.button('U1', 'bw:aneh'); assert.equal(await w.wf.handle(odd), true); assert.match(w.said(odd), /tidak dikenali/);
  const dm = w.button('U1', 'bw:start:1:U1'); dm.inGuild = () => false; await w.wf.handle(dm); assert.match(w.said(dm), /Hanya bisa dipakai di server/);
  const off = world({ nullStorage: true }); const i = off.button('U1', 'bw:start:1:U1'); await off.wf.handle(i); assert.match(off.said(i), /nonaktif/);
});

/* ---------------- /modpass ---------------- */
test('modpass: definisi identik dengan golden', () => {
  const list = buildModpassCommandList();
  const goldenPath = path.join(__dirname, 'fixtures', 'modpass-commands.golden.json');
  const actual = JSON.stringify(list, null, 2) + '\n';
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(goldenPath, actual);
  assert.equal(actual, fs.readFileSync(goldenPath, 'utf8'));
});
test('modpass: izin ManageGuild diperiksa di handler; list/info/revoke bekerja; revoke berlaku seketika + audit + modlog', async () => {
  const w = world(); const r = w.rule({ allowPass: true });
  const g = w.storage.passes.grant({ guildId: 'G1', userId: 'U1', ruleId: r.id, passDays: 7 });
  for (const sub of ['list', 'info', 'revoke']) { const d = w.command(sub, { id: g.row.id }, perms()); await w.wf.handle(d); assert.match(w.said(d), /tidak punya izin/, sub); }
  assert.equal(w.storage.passes.hasActive('G1', 'U1', r.id), true);

  const list = w.command('list'); await w.wf.handle(list); assert.match(w.said(list), /Pass aktif\*\* \(1\)|Pass aktif.*\(1\)/); assert.match(w.said(list), new RegExp(`#${g.row.id} • <@U1> • aturan #${r.id} \\(Anti-Scam\\)`));
  const forUser = w.command('list', { user: { id: 'NOBODY' } }); await w.wf.handle(forUser); assert.match(w.said(forUser), /Tidak ada pass aktif untuk <@NOBODY>/);
  const info = w.command('info', { id: g.row.id }); await w.wf.handle(info); assert.match(w.said(info), /Pass #\d+\*\* — active.*Sumber: challenge/s);
  const missing = w.command('info', { id: 99 }); await w.wf.handle(missing); assert.match(w.said(missing), /tidak ditemukan/);

  const rv = w.command('revoke', { id: g.row.id, reason: 'disalahgunakan' }); await w.wf.handle(rv);
  assert.match(w.said(rv), /dicabut\. Berlaku seketika/);
  assert.equal(w.storage.passes.hasActive('G1', 'U1', r.id), false);
  const entry = w.storage.audit.list({ guildId: 'G1', action: 'pass_revoke' })[0];
  assert.deepEqual([entry.actorId, entry.targetId, entry.reason, entry.details.passId], ['ADMIN', 'U1', 'disalahgunakan', g.row.id]);
  assert.match(w.modlogSent.at(-1).content, /Pass #\d+\*\* dicabut oleh <@ADMIN>.*disalahgunakan/s);
  const again = w.command('revoke', { id: g.row.id }); await w.wf.handle(again); assert.match(w.said(again), /sudah tidak aktif/);
  const gone = w.command('revoke', { id: 999 }); await w.wf.handle(gone); assert.match(w.said(gone), /tidak ditemukan/);
  const info2 = w.command('info', { id: g.row.id }); await w.wf.handle(info2); assert.match(w.said(info2), /revoked.*Dicabut.*disalahgunakan/s);
  assert.equal(await w.wf.screen(w.msg({ id: 'AFTER_REVOKE' })), true);
});

/* ---------------- repo pass ---------------- */
test('repo passes: grant/hasActive/list/revoke, kedaluwarsa, tanpa dobel, isolasi server', () => {
  const db = openDatabase(':memory:'); let t = 1000; const rules = createRulesRepo(db, { now: () => t }); const passes = createPassesRepo(db, { now: () => t });
  const a = rules.add({ guildId: 'G1', name: 'A', phrase: 'aaa bbb', mode: 'exact', reason: 'x', createdBy: 'M' });
  const g1 = passes.grant({ guildId: 'G1', userId: 'U1', ruleId: a.id, passDays: 2 });
  assert.deepEqual([g1.alreadyActive, g1.row.status, g1.row.expiresAt - g1.row.grantedAt], [false, 'active', 2 * DAY]);
  const g2 = passes.grant({ guildId: 'G1', userId: 'U1', ruleId: a.id, passDays: 9 });
  assert.deepEqual([g2.alreadyActive, g2.row.id], [true, g1.row.id], 'pass aktif tidak digandakan');
  assert.equal(passes.hasActive('G1', 'U1', a.id), true); assert.equal(passes.hasActive('G2', 'U1', a.id), false); assert.equal(passes.hasActive('G1', 'U2', a.id), false);
  assert.equal(passes.get('G2', g1.row.id), undefined);
  t += 2 * DAY + 1;
  assert.equal(passes.hasActive('G1', 'U1', a.id), false); assert.equal(passes.list({ guildId: 'G1' }).length, 0); assert.equal(passes.list({ guildId: 'G1', activeOnly: false }).length, 1);
  const g3 = passes.grant({ guildId: 'G1', userId: 'U1', ruleId: a.id, passDays: 1 });
  assert.notEqual(g3.row.id, g1.row.id); assert.equal(passes.get('G1', g1.row.id).status, 'expired');
  assert.deepEqual(passes.revoke({ guildId: 'G2', id: g3.row.id, revokedBy: 'M' }), { ok: false, reason: 'not_found' });
  assert.equal(passes.revoke({ guildId: 'G1', id: g3.row.id, revokedBy: 'M', reason: 'x' }).ok, true);
  assert.deepEqual(passes.revoke({ guildId: 'G1', id: g3.row.id, revokedBy: 'M' }), { ok: false, reason: 'already_inactive' });
  assert.throws(() => db.prepare("INSERT INTO moderation_passes (guild_id,user_id,rule_id,granted_at,expires_at) VALUES ('G1','U1',999,1,2)").run(), /FOREIGN KEY/);
  db.close();
});
