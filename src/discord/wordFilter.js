'use strict';

const crypto = require('crypto');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} = require('discord.js');
const { TtlStore } = require('../core/ttlStore');
const { generateChallenge } = require('../core/challenge');
const { hasGuildPermission } = require('./permissions');

/**
 * Filter kata terlarang (tahap 5): hapus pesan yang cocok, pemberitahuan publik singkat, challenge
 * pilihan ganda ringan, pass per aturan, dan /modpass.
 *
 * Catatan perilaku Discord yang dipertimbangkan:
 *  - Cache anggota dimatikan -> message.member selalu null. Data anggota (role, izin) diambil lewat REST
 *    HANYA kalau pesan cocok dengan suatu aturan (jarang), bukan untuk tiap pesan.
 *  - Cache pesan dimatikan -> event messageUpdate hanya terkirim kalau Partials.Message aktif (diatur di main.js);
 *    edit tanpa isi (mis. embed otomatis) tidak bisa dinilai dan dilewati.
 *  - Pass dibaca langsung dari SQLite setiap kali (tanpa cache) supaya pencabutan berlaku seketika.
 *  - Challenge hanya "gesekan ringan": bot otomatis bisa menjawabnya. Jawaban benar tidak ada di customId.
 */

const NO_MENTIONS = { parse: [] };
const EPHEMERAL = MessageFlags.Ephemeral;
const MSG_NO_PERM = '❌ Anda tidak punya izin untuk command ini.';
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_MEMBER = 10007;

function buildModpassCommandList() {
  return [
    new SlashCommandBuilder().setName('modpass').setDescription('Manage moderation passes (rule exemptions earned via challenge)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('list').setDescription('List active passes')
        .addUserOption((o) => o.setName('user').setDescription('Only this member')))
      .addSubcommand((s) => s.setName('info').setDescription('Show details of a pass')
        .addIntegerOption((o) => o.setName('id').setDescription('Pass ID').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('revoke').setDescription('Revoke a pass immediately')
        .addIntegerOption((o) => o.setName('id').setDescription('Pass ID').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('reason').setDescription('Why the pass is revoked').setMaxLength(200))),
  ].map((c) => c.toJSON());
}

const defaultSchedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
const ts = (ms, style = 'd') => `<t:${Math.floor(ms / 1000)}:${style}>`;

function createWordFilter({
  storage, bannedWords, now = Date.now, rng = Math.random, log = console, schedule = defaultSchedule,
  challengeMs = 60_000, maxAttempts = 2, cooldownMs = 15_000,   // pengaturan challenge TERPISAH dari verification utama
  noticeWindowMs = 30_000, noticeLifetimeMs = 10 * 60_000, staffAlertWindowMs = 10 * 60_000,
} = {}) {
  const seen = new TtlStore({ now, maxEntries: 5000 });      // pesan+isi yang sudah/sedang diperiksa (promise)
  const notices = new TtlStore({ now });                      // satu pemberitahuan per pengguna per jendela waktu
  const staffAlerts = new TtlStore({ now });                  // satu peringatan staf per channel per jendela waktu
  const sessions = new TtlStore({ now });                     // sesi challenge: (server, pengguna, aturan)

  async function postModlog(guild, content) {
    try {
      const channelId = storage.settings.get(guild.id, 'modlog.channelId');
      if (!channelId) return false;
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.isTextBased?.()) return false;
      await channel.send({ content, allowedMentions: NO_MENTIONS });
      return true;
    } catch (err) {
      log.warn(`[WordFilter] Gagal mengirim ke channel modlog: ${err.message}`);
      return false;
    }
  }

  /* ---------------- pemeriksaan pesan ---------------- */
  async function sendNotice(message, rule, matches) {
    const { guild } = message; const userId = message.author.id;
    const key = `${guild.id}:${userId}`;
    if (notices.has(key)) return;                               // anti-amplifikasi: hapus diam-diam saja
    notices.set(key, true, noticeWindowMs);
    const offer = matches.find((r) => r.allowPass);
    const payload = {
      content: `🛡️ Pesan <@${userId}> dihapus: ${rule.reason}${offer ? '\nJika ini keliru, tekan tombol di bawah untuk verifikasi singkat.' : ''}`,
      allowedMentions: { users: [userId] },
    };
    if (offer) {
      payload.components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bw:start:${offer.id}:${userId}`).setLabel('Verifikasi saya').setStyle(ButtonStyle.Secondary),
      )];
    }
    try {
      const sent = await message.channel.send(payload);
      schedule(() => { Promise.resolve(sent?.delete?.()).catch(() => {}); }, noticeLifetimeMs); // bersihkan notifikasi (best-effort)
    } catch (err) {
      log.warn(`[WordFilter] Gagal mengirim pemberitahuan: ${err.message}`);
    }
  }

  async function enforce(message, matches) {
    const { guild } = message; const userId = message.author.id;
    const rule = matches[0];
    let deleted = false; let deleteError = null;
    try { await message.delete(); deleted = true; } catch (err) { if (err?.code === UNKNOWN_MESSAGE) deleted = true; else deleteError = err; }

    try {
      storage.audit.log({
        guildId: guild.id, action: 'banned_word_hit', targetId: userId, reason: rule.reason, status: deleted ? 'ok' : 'failed',
        // JANGAN mencatat isi pesan.
        details: { ruleIds: matches.map((r) => r.id), channelId: message.channelId ?? message.channel?.id, edited: Boolean(message.editedTimestamp), deleted, ...(deleteError ? { error: String(deleteError.message).slice(0, 200) } : {}) },
      });
    } catch (err) { log.error(`[WordFilter] Gagal mencatat audit: ${err.message}`); }

    if (!deleted) {
      const channelId = message.channelId ?? message.channel?.id;
      if (!staffAlerts.has(channelId)) {
        staffAlerts.set(channelId, true, staffAlertWindowMs);
        await postModlog(guild, `⚠️ Bot gagal menghapus pesan yang melanggar aturan di <#${channelId}> (izin Manage Messages kurang?). Pengguna: <@${userId}>. Kode: ${deleteError?.code ?? 'n/a'}.`);
      }
      return true;
    }
    await sendNotice(message, rule, matches);
    return true;
  }

  async function inspect(message) {
    const { guild } = message; const userId = message.author.id; const text = message.content;
    const channelIds = [message.channelId ?? message.channel?.id, message.channel?.parentId].filter(Boolean);

    // Tahap murah: tanpa data anggota. Pesan biasa berhenti di sini (tanpa REST).
    if (!bannedWords.evaluate(guild.id, text, { channelIds }).length) return false;

    let member = null;
    try { member = await guild.members.fetch(userId); } catch (err) {
      if (err?.code !== UNKNOWN_MEMBER) { log.error(`[WordFilter] Gagal mengambil data anggota ${userId}: ${err.message} — pesan dilewati (gagal-aman).`); return false; }
    }
    if (userId === guild.ownerId || member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return false; // staf dikecualikan

    const roleIds = member ? [...member.roles.cache.keys()] : [];
    const matches = bannedWords.evaluate(guild.id, text, { channelIds, roleIds })
      .filter((r) => !(r.allowPass && storage.passes.hasActive(guild.id, userId, r.id)));
    if (!matches.length) return false;
    return enforce(message, matches);
  }

  /** true = pesan melanggar dan ditangani (dihapus / dilaporkan). Aman dipanggil berkali-kali untuk pesan+isi yang sama. */
  function screen(message) {
    if (!storage || !bannedWords || !message?.guild || typeof message.content !== 'string' || !message.content) return Promise.resolve(false);
    if (message.author?.bot || message.webhookId || message.system) return Promise.resolve(false);
    const key = `${message.id}:${crypto.createHash('sha1').update(message.content).digest('hex').slice(0, 16)}`;
    let p = seen.get(key);
    if (!p) {
      p = inspect(message).catch((err) => { log.error(`[WordFilter] Pemeriksaan pesan gagal: ${err.stack || err.message}`); return false; });
      seen.set(key, p, 120_000);
    }
    return p;
  }

  /** Edit pesan: hanya bila isi baru tersedia (edit tanpa isi, mis. embed otomatis, dilewati). */
  function screenEdit(oldMessage, newMessage) {
    if (!newMessage || typeof newMessage.content !== 'string' || !newMessage.author) return Promise.resolve(false);
    return screen(newMessage);
  }

  function register(client) {
    client.on('messageUpdate', (oldMessage, newMessage) => { screenEdit(oldMessage, newMessage).catch(() => {}); });
  }

  /* ---------------- challenge ---------------- */
  const keyOf = (guildId, userId, ruleId) => `${guildId}:${userId}:${ruleId}`;

  function failSession(session, reason) {
    session.state = 'failed';
    session.timedOut = reason === 'timeout';
    session.failedAt = session.timedOut ? session.expiresAt : now();
    try {
      storage.audit.log({ guildId: session.guildId, action: session.timedOut ? 'challenge_timeout' : 'challenge_fail', targetId: session.userId, details: { ruleId: session.ruleId, attempts: session.attempts } });
    } catch (err) { log.error(`[WordFilter] Gagal mencatat audit challenge: ${err.message}`); }
    postModlog(session.guild, `⚠️ Challenge ${session.timedOut ? 'kedaluwarsa' : 'gagal'}: <@${session.userId}> — aturan #${session.ruleId} (${session.ruleName}). Pesan yang melanggar sudah dihapus; tidak ada pass diberikan.`).catch(() => {});
  }
  function settleIfExpired(session) {
    if (session.state === 'active' && now() >= session.expiresAt) failSession(session, 'timeout');
  }

  const challengeView = (session, prefix = '') => ({
    content: `${prefix}🧩 **Verifikasi singkat** — aturan #${session.ruleId}\n${session.challenge.prompt}\nSisa percobaan: ${maxAttempts - session.attempts} • berakhir ${ts(session.expiresAt, 'R')}`,
    components: [new ActionRowBuilder().addComponents(
      ...session.challenge.options.map((label, idx) => new ButtonBuilder().setCustomId(`bw:ans:${session.ruleId}:${session.sid}:${idx}`).setLabel(label).setStyle(ButtonStyle.Secondary)),
    )],
    allowedMentions: NO_MENTIONS,
  });
  const reply = (i, content, extra = {}) => (i.replied || i.deferred
    ? i.editReply({ content, allowedMentions: NO_MENTIONS, ...extra })
    : i.reply({ content, flags: EPHEMERAL, allowedMentions: NO_MENTIONS, ...extra }));
  const closeView = (i, content) => i.update({ content, components: [], allowedMentions: NO_MENTIONS });

  async function handleStart(i, ruleId, ownerId) {
    if (i.user.id !== ownerId) return reply(i, '❌ Tombol ini bukan untuk Anda.');
    const guildId = i.guild.id; const userId = i.user.id;
    const rule = storage.rules.get(guildId, ruleId);
    if (!rule || !rule.enabled || !rule.allowPass) return reply(i, 'ℹ️ Aturan ini tidak lagi menawarkan verifikasi.');
    if (storage.passes.hasActive(guildId, userId, ruleId)) return reply(i, '✅ Anda sudah punya pass untuk aturan ini.');

    const key = keyOf(guildId, userId, ruleId);
    const existing = sessions.get(key);
    if (existing) {
      settleIfExpired(existing);
      if (existing.state === 'active') return reply(i, undefined, challengeView(existing));
      if (existing.state === 'passed') return reply(i, '✅ Anda sudah lolos verifikasi.');
      const wait = existing.failedAt + cooldownMs - now();
      if (wait > 0) return reply(i, `⏳ Coba lagi dalam ${Math.ceil(wait / 1000)} detik.`);
      sessions.delete(key);
    }
    const session = {
      sid: crypto.randomBytes(6).toString('hex'), guild: i.guild, guildId, userId, ruleId, ruleName: rule.name,
      attempts: 0, state: 'active', expiresAt: now() + challengeMs, failedAt: null, timedOut: false, challenge: generateChallenge(rng),
    };
    sessions.set(key, session, challengeMs + cooldownMs);
    schedule(() => { if (sessions.get(key) === session) settleIfExpired(session); }, challengeMs + 250); // timeout aktif -> staf diberi tahu
    return reply(i, undefined, challengeView(session));
  }

  async function handleAnswer(i, ruleId, sid, idx) {
    const guildId = i.guild.id; const userId = i.user.id;
    const session = sessions.get(keyOf(guildId, userId, ruleId));   // hanya sesi MILIK penekan tombol
    if (!session || session.sid !== sid) return closeView(i, '❌ Sesi tidak valid. Tekan tombol verifikasi lagi.');
    settleIfExpired(session);
    if (session.state === 'passed') return closeView(i, '✅ Anda sudah lolos verifikasi.');
    if (session.state === 'failed') {
      return closeView(i, session.timedOut ? '⌛ Sesi berakhir. Tekan tombol verifikasi lagi.' : '❌ Sesi ini sudah gagal. Tunggu cooldown lalu coba lagi.');
    }
    const index = Number(idx);
    if (!Number.isInteger(index) || index < 0 || index >= session.challenge.options.length) return closeView(i, '❌ Pilihan tidak valid.');

    if (index === session.challenge.correctIndex) {
      const rule = storage.rules.get(guildId, ruleId);
      if (!rule || !rule.enabled || !rule.allowPass) return closeView(i, 'ℹ️ Aturan ini tidak lagi menawarkan verifikasi.');
      // Simpan DULU; kalau gagal, error dilempar dan tidak ada pass.
      const granted = storage.db.transaction(() => {
        const g = storage.passes.grant({ guildId, userId, ruleId, passDays: rule.passDays });
        storage.audit.log({ guildId, action: 'challenge_pass', targetId: userId, details: { ruleId, passId: g.row.id, expiresAt: g.row.expiresAt } });
        return g;
      });
      session.state = 'passed';
      return closeView(i, `✅ Verifikasi berhasil. Pass untuk aturan **${rule.name}** berlaku sampai ${ts(granted.row.expiresAt)}.`);
    }

    session.attempts += 1;
    if (session.attempts >= maxAttempts) {
      failSession(session, 'attempts');
      return closeView(i, `❌ Jawaban salah. Percobaan habis. Coba lagi dalam ${Math.ceil(cooldownMs / 1000)} detik.`);
    }
    session.challenge = generateChallenge(rng);                  // soal baru tiap percobaan
    return i.update(challengeView(session, '❌ Jawaban salah.\n'));
  }

  /* ---------------- /modpass ---------------- */
  async function handleModpass(i) {
    if (!i.inGuild()) return reply(i, '❌ Command ini hanya bisa dipakai di server.');
    if (!hasGuildPermission(i, PermissionFlagsBits.ManageGuild)) return reply(i, MSG_NO_PERM);
    if (!storage) return reply(i, '⚠️ Fitur pass nonaktif: database tidak tersedia. Cek log bot.');
    const guildId = i.guild.id; const sub = i.options.getSubcommand();
    const ruleName = (id) => storage.rules.get(guildId, id)?.name ?? '?';

    if (sub === 'list') {
      const user = i.options.getUser('user');
      const passes = storage.passes.list({ guildId, userId: user?.id, limit: 20 });
      if (!passes.length) return reply(i, `ℹ️ Tidak ada pass aktif${user ? ` untuk <@${user.id}>` : ''}.`);
      let content = `🎟️ **Pass aktif** (${passes.length})\n${passes.map((p) => `#${p.id} • <@${p.userId}> • aturan #${p.ruleId} (${ruleName(p.ruleId)}) • berakhir ${ts(p.expiresAt)}`).join('\n')}`;
      if (content.length > 1900) content = `${content.slice(0, 1890)}…`;
      return reply(i, content);
    }

    const id = i.options.getInteger('id', true);
    if (sub === 'info') {
      const p = storage.passes.get(guildId, id);
      if (!p) return reply(i, `❌ Pass #${id} tidak ditemukan.`);
      const live = p.status === 'active' && p.expiresAt <= now() ? 'kedaluwarsa' : p.status;
      return reply(i, [
        `🎟️ **Pass #${p.id}** — ${live}`,
        `Anggota: <@${p.userId}> • aturan #${p.ruleId} (${ruleName(p.ruleId)})`,
        `Sumber: ${p.source} • diberikan ${ts(p.grantedAt)} • berakhir ${ts(p.expiresAt)}`,
        ...(p.revokedAt ? [`Dicabut ${ts(p.revokedAt)} oleh <@${p.revokedBy}>${p.revokedReason ? `: ${p.revokedReason}` : ''}`] : []),
      ].join('\n'));
    }

    // revoke
    const reason = i.options.getString('reason')?.trim() || null;
    const result = storage.db.transaction(() => {
      const r = storage.passes.revoke({ guildId, id, revokedBy: i.user.id, reason });
      if (r.ok) storage.audit.log({ guildId, action: 'pass_revoke', actorId: i.user.id, targetId: r.row.userId, reason, details: { passId: id, ruleId: r.row.ruleId } });
      return r;
    });
    if (!result.ok) return reply(i, result.reason === 'already_inactive' ? `❌ Pass #${id} sudah tidak aktif.` : `❌ Pass #${id} tidak ditemukan.`);
    await postModlog(i.guild, `🎟️ **Pass #${id}** dicabut oleh <@${i.user.id}> (anggota <@${result.row.userId}>, aturan #${result.row.ruleId})${reason ? `\nAlasan: ${reason}` : ''}`);
    return reply(i, `✅ Pass #${id} dicabut. Berlaku seketika: pesan berikutnya yang cocok akan diproses seperti biasa.`);
  }

  /** true kalau interaksi ini milik modul filter (tombol bw:* atau /modpass). */
  async function handle(interaction) {
    const id = interaction.customId ?? '';
    const isCmd = interaction.isChatInputCommand?.() && interaction.commandName === 'modpass';
    const isBtn = interaction.isButton?.() && id.startsWith('bw:');
    if (!isCmd && !isBtn) return false;
    try {
      if (isCmd) { await handleModpass(interaction); return true; }
      if (!interaction.inGuild?.()) { await reply(interaction, '❌ Hanya bisa dipakai di server.'); return true; }
      if (!storage) { await reply(interaction, '⚠️ Fitur ini nonaktif: database tidak tersedia. Hubungi staf.'); return true; }
      const parts = id.split(':'); // bw:start:<rule>:<user> | bw:ans:<rule>:<sid>:<idx>
      if (parts[1] === 'start' && parts.length === 4) await handleStart(interaction, Number(parts[2]), parts[3]);
      else if (parts[1] === 'ans' && parts.length === 5) await handleAnswer(interaction, Number(parts[2]), parts[3], parts[4]);
      else await reply(interaction, '❌ Komponen tidak dikenali. Tekan tombol verifikasi lagi.');
    } catch (err) {
      log.error(`[WordFilter] ${id || interaction.commandName} gagal: ${err.stack || err.message}`);
      await reply(interaction, isCmd ? '❌ Terjadi kesalahan. Perubahan tidak tersimpan — cek log bot.' : '❌ Terjadi kesalahan. Verifikasi TIDAK dianggap berhasil — coba lagi atau hubungi staf.').catch(() => {});
    }
    return true;
  }

  return { screen, screenEdit, register, handle };
}

module.exports = { buildModpassCommandList, createWordFilter };
