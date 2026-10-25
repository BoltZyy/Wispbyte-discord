'use strict';
/**
 * Tes verification utama (tahap 3). Database = node:sqlite ASLI; discord.js dan objek
 * Discord (interaction, guild, member, channel) = stub/fake. Waktu memakai jam yang disuntik,
 * jadi sesi 120 dtk / cooldown 15 dtk diuji tanpa menunggu.
 * Tidak mencakup: perilaku Discord sungguhan (modal/tombol di klien, izin role nyata).
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
/** Builder pencatat data: setX(v) -> data.x = v, addComponents(...) -> data.components. */
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
const P = { Administrator: 1n << 3n, ManageGuild: 1n << 5n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n, ModerateMembers: 1n << 40n };
const mk = (Cls) => class { constructor() { return Cls(); } };
const discordStub = {
  SlashCommandBuilder: mk(recorder), ModalBuilder: mk(dataBuilder), TextInputBuilder: mk(dataBuilder), ActionRowBuilder: mk(dataBuilder), ButtonBuilder: mk(dataBuilder),
  PermissionFlagsBits: P, ChannelType: { GuildText: 0 }, MessageFlags: { Ephemeral: 64 }, TextInputStyle: { Short: 1, Paragraph: 2 }, ButtonStyle: { Primary: 1, Secondary: 2 },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'discord.js' ? discordStub : origLoad.call(this, request, ...rest); };

const { createVerification, buildVerificationCommandList } = require('../src/discord/verification');
const { answerMatches, makeAnswerRecord, normalizeAnswer } = require('../src/core/answer');
const { initStorage } = require('../src/storage');
const { openDatabase } = require('../src/storage/db');
const { createVerificationRepo } = require('../src/storage/repositories');

const silent = { log() {}, warn() {}, error() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovelia-ver-'));
const perms = (...flags) => { const bits = flags.reduce((a, f) => a | f, 0n); const admin = (bits & P.Administrator) !== 0n; return { has: (f) => (Array.isArray(f) ? f : [f]).every((x) => admin || (bits & x) === x) }; };
const ANSWER = 'Kucing Biru';

/* ---------------- dunia uji ---------------- */
async function world({ configured = true, nullStorage = false } = {}) {
  const storage = nullStorage ? null : initStorage({ dbPath: path.join(tmpDir(), 'v.sqlite'), log: silent });
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const verification = createVerification({ storage, now, log: silent });
  const roleAdds = [];
  const members = new Map();
  const memberOf = (userId, { hasRole = false, failRole = false } = {}) => {
    if (!members.has(userId)) {
      members.set(userId, { id: userId, roles: { cache: { has: () => hasRole }, add: async (roleId, reason) => { if (failRole) throw new Error('Missing Permissions'); roleAdds.push({ userId, roleId, reason }); } } });
    }
    return members.get(userId);
  };
  const sent = [];
  const channel = { id: 'CH_V', guildId: 'G1', isTextBased: () => true, permissionsFor: () => perms(P.ViewChannel, P.SendMessages), send: async (m) => { sent.push(m); } };
  const guild = { id: 'G1', ownerId: 'OWN', members: { me: { id: 'BOT' } }, channels: { fetch: async (id) => (id === 'CH_V' ? channel : null) } };
  if (configured && storage) {
    storage.settings.set('G1', 'verify.roleId', 'ROLE_V');
    storage.settings.set('G1', 'verify.question', 'Apa nama hewan peliharaan kita?');
    storage.settings.set('G1', 'verify.answer', await makeAnswerRecord(ANSWER));
  }
  const base = (userId, extra = {}) => {
    const calls = { reply: [], edit: [], modal: [] };
    const i = { user: { id: userId }, guild, member: memberOf(userId), channel, calls, replied: false, deferred: false, inGuild: () => true,
      isButton: () => false, isModalSubmit: () => false, isChatInputCommand: () => false,
      reply: async (o) => { calls.reply.push(o); i.replied = true; }, editReply: async (o) => { calls.edit.push(o); },
      showModal: async (m) => { calls.modal.push(m); }, ...extra };
    return i;
  };
  const button = (userId, customId) => base(userId, { customId, isButton: () => true });
  const modal = (userId, customId, fields) => base(userId, { customId, isModalSubmit: () => true, fields: { getTextInputValue: (id) => fields[id] } });
  const command = (userId, sub, opts = {}, perm = perms(P.ManageGuild)) => base(userId, {
    commandName: 'verification', isChatInputCommand: () => true, memberPermissions: perm,
    options: { getSubcommand: () => sub, getRole: (n) => opts[n], getChannel: (n) => opts[n] ?? null },
  });
  const said = (i) => (i.calls.edit.at(-1) ?? i.calls.reply.at(-1)).content;
  const replyOf = (i) => i.calls.edit.at(-1) ?? i.calls.reply.at(-1);
  const sidOf = (i) => replyOf(i).components[0].data.components[0].data.customId.split(':')[2];

  const startFlow = async (userId) => { const i = button(userId, 'verify:start'); await verification.handle(i); return i; };
  const answer = async (userId, sid, text) => { const i = modal(userId, `verify:submit:${sid}`, { answer: text }); await verification.handle(i); return i; };
  const records = () => storage.db.prepare('SELECT * FROM verification_records ORDER BY id').all();
  const auditActions = () => storage.audit.list({ guildId: 'G1', limit: 200 }).map((r) => r.action).reverse();
  return { storage, clock, verification, roleAdds, memberOf, sent, channel, guild, button, modal, command, said, replyOf, sidOf, startFlow, answer, records, auditActions, now };
}

/* ---------------- jawaban ter-hash ---------------- */
test('answer: normalisasi, hash bergaram, tidak menyimpan jawaban terbuka', async () => {
  assert.equal(normalizeAnswer('  KuCing\t  BIRU \n'), 'kucing biru');
  assert.equal(normalizeAnswer('Ｋｕｃｉｎｇ'), 'kucing', 'NFKC: huruf lebar penuh disamakan');
  assert.equal(normalizeAnswer('ku\u200Bcing'), 'kucing', 'karakter lebar-nol dibuang');
  assert.equal(normalizeAnswer('kucing, biru!'), 'kucing, biru!', 'tanda baca dipertahankan');
  assert.equal(normalizeAnswer(undefined), '');

  const rec = await makeAnswerRecord(ANSWER);
  assert.ok(!JSON.stringify(rec).toLowerCase().includes('kucing'));
  assert.equal(await answerMatches('kucing   biru', rec), true);
  assert.equal(await answerMatches('Kucing Merah', rec), false);
  assert.equal(await answerMatches('', rec), false);
  assert.equal(await answerMatches(ANSWER, null), false);
  const rec2 = await makeAnswerRecord(ANSWER);
  assert.notEqual(rec.salt, rec2.salt); assert.notEqual(rec.hash, rec2.hash);
  await assert.rejects(() => makeAnswerRecord('   '), /tidak boleh kosong/);
});

/* ---------------- command ---------------- */
test('command: definisi /verification identik dengan golden', () => {
  const list = buildVerificationCommandList();
  const goldenPath = path.join(__dirname, 'fixtures', 'verification-commands.golden.json');
  const actual = JSON.stringify(list, null, 2) + '\n';
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(goldenPath, actual);
  assert.equal(actual, fs.readFileSync(goldenPath, 'utf8'));
  assert.deepEqual(list.map((c) => c.find((e) => e[0] === 'setName')[1][0]), ['verification']);
});

/* ---------------- konfigurasi ---------------- */
test('konfigurasi: semua sub-command menolak pengguna tanpa ManageGuild', async () => {
  const w = await world({ configured: false });
  for (const sub of ['setup', 'question', 'panel', 'status']) {
    const i = w.command('U1', sub, { role: { id: 'R', managed: false, editable: true } }, perms(P.ModerateMembers));
    assert.equal(await w.verification.handle(i), true);
    assert.match(w.said(i), /tidak punya izin/); assert.equal(i.calls.modal.length, 0);
  }
  assert.equal(w.storage.settings.get('G1', 'verify.roleId'), undefined);
});
test('konfigurasi: setup memvalidasi role dan channel, lalu menyimpan + audit', async () => {
  const w = await world({ configured: false });
  const run = async (opts) => { const i = w.command('ADMIN', 'setup', opts); await w.verification.handle(i); return w.said(i); };
  assert.match(await run({ role: { id: 'G1', managed: false, editable: true } }), /@everyone/);
  assert.match(await run({ role: { id: 'R1', managed: true, editable: true } }), /dikelola integrasi/);
  assert.match(await run({ role: { id: 'R1', managed: false, editable: false } }), /posisi role bot LEBIH TINGGI/);
  const voice = { id: 'V', guildId: 'G1', isTextBased: () => false, permissionsFor: () => perms() };
  assert.match(await run({ role: { id: 'R1', managed: false, editable: true }, channel: voice }), /channel teks/);
  assert.equal(w.storage.settings.get('G1', 'verify.roleId'), undefined, 'validasi gagal tidak boleh menyimpan apa pun');

  assert.match(await run({ role: { id: 'R1', managed: false, editable: true }, channel: w.channel }), /Role Verified: <@&R1>.*<#CH_V>/);
  assert.equal(w.storage.settings.get('G1', 'verify.roleId'), 'R1'); assert.equal(w.storage.settings.get('G1', 'verify.channelId'), 'CH_V');
  assert.ok(w.auditActions().includes('config_change'));
});
test('konfigurasi: question membuka modal; jawaban disimpan sebagai hash dan TIDAK muncul di database/log', async () => {
  const w = await world({ configured: false });
  const open = w.command('ADMIN', 'question'); await w.verification.handle(open);
  const m = open.calls.modal[0].data;
  assert.equal(m.customId, 'verifycfg:question');
  assert.deepEqual(m.components.map((row) => row.data.components[0].data.customId), ['question', 'answer']);

  const denied = w.modal('RANDOM', 'verifycfg:question', { question: 'Q?', answer: ANSWER }); denied.memberPermissions = perms();
  await w.verification.handle(denied); assert.match(w.said(denied), /tidak punya izin/);
  assert.equal(w.storage.settings.get('G1', 'verify.question'), undefined);

  for (const bad of [{ question: '   ', answer: ANSWER }, { question: 'Q?', answer: '  ' }]) {
    const i = w.modal('ADMIN', 'verifycfg:question', bad); i.memberPermissions = perms(P.ManageGuild);
    await w.verification.handle(i); assert.match(w.said(i), /tidak boleh kosong/);
  }
  const ok = w.modal('ADMIN', 'verifycfg:question', { question: ' Hewan apa? ', answer: ANSWER }); ok.memberPermissions = perms(P.ManageGuild);
  await w.verification.handle(ok); assert.match(w.said(ok), /disimpan/);
  assert.equal(w.storage.settings.get('G1', 'verify.question'), 'Hewan apa?');
  const rec = w.storage.settings.get('G1', 'verify.answer');
  assert.equal(await answerMatches(ANSWER, rec), true);

  const dump = JSON.stringify([
    w.storage.db.prepare('SELECT * FROM guild_settings').all(), w.storage.db.prepare('SELECT * FROM moderation_logs').all(),
  ]).toLowerCase();
  assert.ok(!dump.includes('kucing biru'), 'jawaban tidak boleh ada di database');
  assert.ok(!w.storage.db.prepare('SELECT details FROM moderation_logs').all().some((r) => String(r.details).includes(rec.hash)), 'hash tidak boleh ada di log');
});
test('konfigurasi: panel butuh konfigurasi lengkap, mengirim tombol verify:start, memeriksa izin bot; status menyembunyikan jawaban', async () => {
  const w = await world({ configured: false });
  const early = w.command('ADMIN', 'panel'); await w.verification.handle(early);
  assert.match(w.said(early), /Atur dulu/); assert.equal(w.sent.length, 0);

  const w2 = await world();
  w2.storage.settings.set('G1', 'verify.channelId', 'CH_V');
  const ok = w2.command('ADMIN', 'panel'); await w2.verification.handle(ok);
  assert.match(w2.said(ok), /Panel verifikasi dikirim ke <#CH_V>/);
  const btn = w2.sent[0].components[0].data.components[0].data;
  assert.deepEqual([btn.customId, btn.label], ['verify:start', 'Mulai verifikasi']);
  assert.deepEqual(w2.sent[0].allowedMentions, { parse: [] });

  w2.channel.permissionsFor = () => perms(P.ViewChannel);
  const noPerm = w2.command('ADMIN', 'panel'); await w2.verification.handle(noPerm);
  assert.match(w2.said(noPerm), /tidak bisa mengirim pesan/); assert.equal(w2.sent.length, 1);

  const st = w2.command('ADMIN', 'status'); await w2.verification.handle(st);
  assert.match(w2.said(st), /<@&ROLE_V>.*<#CH_V>.*Apa nama hewan.*tersimpan sebagai hash.*120 detik, maks 3.*cooldown 15.*siap dipakai/s);
  assert.ok(!w2.said(st).toLowerCase().includes('kucing biru'));
});

/* ---------------- alur peserta ---------------- */
test('alur: tanpa konfigurasi / database nonaktif / sudah terverifikasi / bukan di server', async () => {
  const w = await world({ configured: false });
  assert.match(w.said(await w.startFlow('U1')), /belum dikonfigurasi/);
  const off = await world({ nullStorage: true });
  assert.match(off.said(await off.startFlow('U1')), /Fitur verifikasi nonaktif/);
  const ready = await world();
  ready.memberOf('VER', { hasRole: true });
  assert.match(ready.said(await ready.startFlow('VER')), /sudah terverifikasi/);
  assert.equal(ready.records().length, 0);
  const dm = ready.button('U1', 'verify:start'); dm.inGuild = () => false;
  assert.equal(await ready.verification.handle(dm), true); assert.match(ready.said(dm), /Hanya bisa dipakai di server/);
  assert.equal(await ready.verification.handle({ isChatInputCommand: () => false, isButton: () => false, isModalSubmit: () => false }), false);
  assert.equal(await ready.verification.handle(ready.button('U1', 'tombol-lain')), false);
});
test('alur: mulai -> pertanyaan ephemeral + catatan "started"; menekan lagi melanjutkan sesi yang sama', async () => {
  const w = await world();
  const i = await w.startFlow('U1');
  assert.equal(replyOfFlags(i), 64);
  assert.match(w.said(i), /Apa nama hewan peliharaan kita\?.*Sisa percobaan: 3/s);
  const sid = w.sidOf(i);
  assert.equal(w.records().length, 1); assert.equal(w.records()[0].status, 'started');
  const again = await w.startFlow('U1');
  assert.equal(w.sidOf(again), sid, 'sesi yang sama dilanjutkan'); assert.equal(w.records().length, 1);

  const ab = w.button('U1', `verify:answer:${sid}`); await w.verification.handle(ab);
  const m = ab.calls.modal[0].data;
  assert.equal(m.customId, `verify:submit:${sid}`);
  assert.equal(m.components[0].data.components[0].data.customId, 'answer');
});
function replyOfFlags(i) { return i.calls.reply[0].flags; }

test('alur: jawaban benar (variasi huruf/spasi) -> hasil tersimpan LALU role diberikan tepat sekali', async () => {
  const w = await world();
  const sid = w.sidOf(await w.startFlow('U1'));
  const ok = await w.answer('U1', sid, '  KUCING   biru ');
  assert.match(w.said(ok), /Verifikasi berhasil/);
  assert.deepEqual(w.roleAdds, [{ userId: 'U1', roleId: 'ROLE_V', reason: 'Verifikasi berhasil' }]);
  assert.deepEqual(w.records().map((r) => [r.status, r.attempts]), [['passed', 1]]);
  assert.ok(w.auditActions().includes('verification_pass'));

  const again = await w.answer('U1', sid, ANSWER);
  assert.match(w.said(again), /sudah lolos/); assert.equal(w.roleAdds.length, 1, 'tidak boleh ada role ganda');
});
test('alur: dua jawaban benar BERSAMAAN hanya menghasilkan satu role', async () => {
  const w = await world();
  const sid = w.sidOf(await w.startFlow('U1'));
  const [a, b] = await Promise.all([w.answer('U1', sid, ANSWER), w.answer('U1', sid, ANSWER)]);
  assert.equal(w.roleAdds.length, 1);
  assert.deepEqual([a, b].map((i) => /berhasil|diproses/.test(w.said(i))), [true, true]);
  assert.equal(w.records().filter((r) => r.status === 'passed').length, 1);
});
test('alur: jawaban salah 3x -> gagal, cooldown 15 dtk ditegakkan, lalu sesi baru diizinkan', async () => {
  const w = await world();
  const sid = w.sidOf(await w.startFlow('U1'));
  const w1 = await w.answer('U1', sid, 'anjing'); assert.match(w.said(w1), /Sisa percobaan: 2/);
  assert.equal(w.replyOf(w1).components[0].data.components[0].data.customId, `verify:answer:${sid}`);
  assert.deepEqual([w.records()[0].status, w.records()[0].attempts], ['started', 1]);
  const w2 = await w.answer('U1', sid, 'kucing merah'); assert.match(w.said(w2), /Sisa percobaan: 1/);
  const w3 = await w.answer('U1', sid, 'burung'); assert.match(w.said(w3), /Percobaan habis.*15 detik/);
  assert.deepEqual([w.records()[0].status, w.records()[0].attempts], ['failed_attempts', 3]);
  assert.ok(w.auditActions().includes('verification_fail')); assert.equal(w.roleAdds.length, 0);

  const late = await w.answer('U1', sid, ANSWER);
  assert.match(w.said(late), /sudah gagal/); assert.equal(w.roleAdds.length, 0, 'jawaban benar setelah gagal tidak boleh diterima');

  assert.match(w.said(await w.startFlow('U1')), /Coba lagi dalam 15 detik/);
  w.clock.t += 14_000; assert.match(w.said(await w.startFlow('U1')), /Coba lagi dalam 1 detik/);
  w.clock.t += 1_000;
  const fresh = await w.startFlow('U1');
  assert.notEqual(w.sidOf(fresh), sid); assert.equal(w.records().length, 2);
});
test('alur: sesi kedaluwarsa (120 dtk) -> dicatat timeout, tidak bisa dipakai, cooldown 15 dtk dihitung dari batas waktu', async () => {
  const w = await world();
  const sid = w.sidOf(await w.startFlow('U1'));
  w.clock.t += 119_000;
  const stillOk = w.button('U1', `verify:answer:${sid}`); await w.verification.handle(stillOk);
  assert.equal(stillOk.calls.modal.length, 1, 'pada detik ke-119 masih valid');

  w.clock.t += 1_000; // tepat 120 detik
  const expired = w.button('U1', `verify:answer:${sid}`); await w.verification.handle(expired);
  assert.match(w.said(expired), /Sesi berakhir/); assert.equal(expired.calls.modal.length, 0);
  assert.equal(w.records()[0].status, 'timeout'); assert.ok(w.auditActions().includes('verification_timeout'));

  w.clock.t += 5_000; assert.match(w.said(await w.startFlow('U1')), /Coba lagi dalam 10 detik/);
  w.clock.t += 10_000;
  assert.notEqual(w.sidOf(await w.startFlow('U1')), sid);
});
test('alur: jawaban BENAR yang dikirim setelah sesi berakhir ditolak (tanpa role)', async () => {
  const w = await world();
  const sid = w.sidOf(await w.startFlow('U1'));
  w.clock.t += 121_000;
  const i = await w.answer('U1', sid, ANSWER);
  assert.match(w.said(i), /Sesi berakhir/); assert.equal(w.roleAdds.length, 0);
  assert.equal(w.records()[0].status, 'timeout');
});
test('alur: sesi habis SELAMA jawaban diproses (hash berjalan) -> ditolak tanpa role', async () => {
  const w = await world();
  const sid = w.sidOf(await w.startFlow('U1'));
  const i = w.modal('U1', `verify:submit:${sid}`, {});
  i.fields.getTextInputValue = () => { w.clock.t += 121_000; return ANSWER; }; // waktu berjalan setelah sesi dinyatakan valid
  await w.verification.handle(i);
  assert.match(w.said(i), /Sesi berakhir sebelum jawaban diproses/);
  assert.equal(w.roleAdds.length, 0);
  assert.equal(w.records()[0].status, 'timeout');
});
test('alur: pengguna lain dan sesi lama tidak bisa memakai sesi orang lain', async () => {
  const w = await world();
  const sidA = w.sidOf(await w.startFlow('A'));

  const stolenBtn = w.button('B', `verify:answer:${sidA}`); await w.verification.handle(stolenBtn);
  assert.match(w.said(stolenBtn), /Sesi verifikasi tidak valid/); assert.equal(stolenBtn.calls.modal.length, 0);
  const stolenSubmit = await w.answer('B', sidA, ANSWER);
  assert.match(w.said(stolenSubmit), /tidak valid/); assert.equal(w.roleAdds.length, 0);

  const sidB = w.sidOf(await w.startFlow('B'));
  const crossed = await w.answer('B', sidA, ANSWER); // B sudah punya sesi sendiri, tapi memakai sid A
  assert.match(w.said(crossed), /tidak valid/); assert.equal(w.roleAdds.length, 0);

  assert.match(w.said(await w.answer('B', sidB, ANSWER)), /berhasil/);
  assert.deepEqual(w.roleAdds.map((r) => r.userId), ['B']);
  assert.equal(w.records().find((r) => r.user_id === 'A').status, 'started', 'sesi A tidak terpengaruh');

  // sesi lama: A gagal 3x, mulai sesi baru -> sid lama tidak valid
  for (const t of ['x', 'y', 'z']) await w.answer('A', sidA, t);
  w.clock.t += 15_000;
  const sidA2 = w.sidOf(await w.startFlow('A'));
  const old = w.button('A', `verify:answer:${sidA}`); await w.verification.handle(old);
  assert.match(w.said(old), /tidak valid/); assert.notEqual(sidA2, sidA);
});
test('alur: jawaban kosong/spasi saja tidak dihitung sebagai percobaan', async () => {
  const w = await world();
  const sid = w.sidOf(await w.startFlow('U1'));
  assert.match(w.said(await w.answer('U1', sid, '   ')), /tidak boleh kosong/);
  assert.match(w.said(await w.answer('U1', sid, 'salah')), /Sisa percobaan: 2/);
});
test('alur: gagal memberi role -> pesan jujur ke peserta + audit "failed", tidak ada klaim sukses', async () => {
  const w = await world();
  w.memberOf('U1', { failRole: true });
  const sid = w.sidOf(await w.startFlow('U1'));
  const i = await w.answer('U1', sid, ANSWER);
  assert.match(w.said(i), /bot gagal memberi role.*Hubungi staf/); assert.ok(!/berhasil!/.test(w.said(i)));
  assert.equal(w.roleAdds.length, 0);
  const entry = w.storage.audit.list({ guildId: 'G1', action: 'verification_role_failed' })[0];
  assert.deepEqual([entry.status, entry.targetId, entry.reason], ['failed', 'U1', 'Missing Permissions']);
  assert.equal(w.records()[0].status, 'passed');
});
test('alur: database gagal saat menyimpan hasil -> role TIDAK diberikan dan jawaban benar masih bisa dicoba lagi', async () => {
  const w = await world();
  const sid = w.sidOf(await w.startFlow('U1'));
  const realLog = w.storage.audit.log; w.storage.audit.log = () => { throw new Error('disk penuh'); };
  const bad = await w.answer('U1', sid, ANSWER);
  assert.match(w.said(bad), /TIDAK dianggap berhasil/); assert.equal(w.roleAdds.length, 0);
  assert.equal(w.records()[0].status, 'started', 'transaksi dibatalkan: catatan tidak berubah');

  w.storage.audit.log = realLog;
  const retry = await w.answer('U1', sid, ANSWER);
  assert.match(w.said(retry), /berhasil/); assert.equal(w.roleAdds.length, 1);
});
test('alur: setelah restart, catatan "started" lama ditutup sebagai timeout; komponen tak dikenal ditangani', async () => {
  const w = await world();
  await w.startFlow('U1');
  assert.equal(w.records()[0].status, 'started');
  createVerification({ storage: w.storage, now: w.now, log: silent }); // = bot start ulang
  assert.equal(w.records()[0].status, 'timeout');

  const bogus = w.button('U1', 'verify:aneh'); assert.equal(await w.verification.handle(bogus), true);
  assert.match(w.said(bogus), /tidak dikenali/);
  const gone = w.modal('U1', 'verify:submit:deadbeef', { answer: ANSWER }); await w.verification.handle(gone);
  assert.match(w.said(gone), /tidak valid/); assert.equal(w.roleAdds.length, 0);
});

/* ---------------- repo ---------------- */
test('repo verification: start/finish hanya sekali, setAttempts, closeAllStarted, latest', () => {
  const db = openDatabase(':memory:'); let t = 100;
  const r = createVerificationRepo(db, { now: () => t++ });
  const a = r.start({ guildId: 'G1', userId: 'U1' }); const b = r.start({ guildId: 'G1', userId: 'U2' });
  assert.equal(r.get(a).status, 'started');
  assert.equal(r.setAttempts(a, 2), true); assert.equal(r.get(a).attempts, 2);
  assert.equal(r.finish(a, 'passed', 3), true);
  assert.equal(r.finish(a, 'timeout', 3), false, 'catatan yang sudah ditutup tidak boleh ditimpa');
  assert.equal(r.setAttempts(a, 9), false);
  assert.deepEqual([r.get(a).status, r.get(a).attempts, r.get(a).finishedAt !== null], ['passed', 3, true]);
  assert.throws(() => r.finish(b, 'bebas', 0), /status akhir tidak valid/);
  assert.equal(r.closeAllStarted(), 1); assert.equal(r.get(b).status, 'timeout');
  assert.equal(r.latest('G1', 'U1').id, a); assert.equal(r.latest('G1', 'NOBODY'), undefined);
  db.close();
});
