'use strict';

const crypto = require('crypto');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, ModalBuilder,
  PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { TtlStore } = require('../core/ttlStore');
const { answerMatches, makeAnswerRecord, normalizeAnswer } = require('../core/answer');
const { hasGuildPermission } = require('./permissions');

/**
 * Verification utama (tahap 3).
 *
 * Alur: panel (tombol "Mulai verifikasi") -> pesan ephemeral berisi pertanyaan -> tombol
 * "Jawab" -> modal -> hasil. Semua lewat interaction, tanpa DM dan tanpa membaca isi pesan.
 *
 * Aturan yang disepakati: sesi 120 dtk, maks 3 jawaban salah, cooldown 15 dtk setelah gagal
 * (karena waktu habis maupun karena salah 3x), lolos -> role Verified.
 *
 * Keamanan:
 *  - Sesi terikat ke (server, pengguna) DAN ID sesi acak; pengguna lain / sesi lama ditolak.
 *  - Jawaban benar diproses sekali (state diubah sinkron + kunci "busy").
 *  - Role HANYA diberikan setelah hasil tersimpan di SQLite; kalau database gagal, tidak ada role.
 *  - Jawaban peserta tidak pernah disimpan atau dicatat; jawaban resmi hanya berupa hash.
 */

const NO_MENTIONS = { parse: [] };
const MSG_NO_PERM = '❌ Anda tidak punya izin untuk command ini.';
const MAX_QUESTION = 300;
const EPHEMERAL = MessageFlags.Ephemeral;

function buildVerificationCommandList() {
  return [
    new SlashCommandBuilder().setName('verification').setDescription('Configure member verification')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('setup').setDescription('Set the Verified role (and the verification channel)')
        .addRoleOption((o) => o.setName('role').setDescription('Role given after passing verification').setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Verification channel (default: where the panel is posted)').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('question').setDescription('Set the verification question and its secret answer'))
      .addSubcommand((s) => s.setName('panel').setDescription('Post the verification panel (Start button)'))
      .addSubcommand((s) => s.setName('status').setDescription('Show the verification configuration')),
  ].map((c) => c.toJSON());
}

function createVerification({
  storage, now = Date.now, log = console,
  sessionMs = 120_000, maxAttempts = 3, cooldownMs = 15_000,
  store = new TtlStore({ now }),
} = {}) {
  const reply = (i, content, extra = {}) => (i.replied || i.deferred
    ? i.editReply({ content, allowedMentions: NO_MENTIONS, ...extra })
    : i.reply({ content, flags: EPHEMERAL, allowedMentions: NO_MENTIONS, ...extra }));

  if (storage) {
    // Sesi hanya hidup di memori: setelah restart, semua catatan yang masih 'started' sudah mati.
    try { storage.verification.closeAllStarted(); } catch (err) { log.error(`[Verification] Gagal menutup catatan lama: ${err.message}`); }
  }

  const keyOf = (guildId, userId) => `${guildId}:${userId}`;

  function readConfig(guildId) {
    const s = storage.settings;
    const roleId = s.get(guildId, 'verify.roleId');
    const question = s.get(guildId, 'verify.question');
    const answer = s.get(guildId, 'verify.answer');
    return { roleId, channelId: s.get(guildId, 'verify.channelId'), question, answer, ready: Boolean(roleId && question && answer) };
  }

  /** Ubah sesi aktif yang kedaluwarsa menjadi gagal (timeout) tepat satu kali. */
  function settleExpired(session) {
    if (session.state !== 'active' || now() < session.expiresAt) return;
    storage.db.transaction(() => {
      storage.verification.finish(session.recordId, 'timeout', session.attempts);
      storage.audit.log({ guildId: session.guildId, action: 'verification_timeout', targetId: session.userId, details: { attempts: session.attempts } });
    });
    session.state = 'failed';
    session.failedAt = session.expiresAt;
    session.timedOut = true;
  }

  const questionMessage = (session, question) => ({
    content: `🔐 **Verifikasi**\n${question}\n\nSisa percobaan: ${maxAttempts - session.attempts} • berakhir <t:${Math.floor(session.expiresAt / 1000)}:R>`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`verify:answer:${session.sid}`).setLabel('Jawab').setStyle(ButtonStyle.Primary),
    )],
  });

  /** Ambil sesi milik pengguna yang menekan/mengirim; hasil { session } atau { message }. */
  function sessionFor(i, sid) {
    const session = store.get(keyOf(i.guild.id, i.user.id));
    if (!session || session.sid !== sid) return { message: '❌ Sesi verifikasi tidak valid. Tekan "Mulai verifikasi" di channel verifikasi.' };
    settleExpired(session);
    if (session.state === 'passed') return { message: '✅ Anda sudah lolos verifikasi.' };
    if (session.state === 'failed') {
      return { message: session.timedOut ? '⌛ Sesi berakhir. Tekan "Mulai verifikasi" untuk mencoba lagi.' : '❌ Sesi ini sudah gagal. Tunggu cooldown lalu tekan "Mulai verifikasi" lagi.' };
    }
    return { session };
  }

  /* ---------------- alur peserta ---------------- */
  async function handleStart(i) {
    if (!storage) return reply(i, '⚠️ Fitur verifikasi nonaktif: database tidak tersedia. Hubungi staf.');
    const guildId = i.guild.id;
    const cfg = readConfig(guildId);
    if (!cfg.ready) return reply(i, '⚠️ Verifikasi belum dikonfigurasi oleh staf.');
    if (i.member.roles.cache.has(cfg.roleId)) return reply(i, '✅ Anda sudah terverifikasi.');

    const key = keyOf(guildId, i.user.id);
    const existing = store.get(key);
    if (existing) {
      settleExpired(existing);
      if (existing.state === 'active') return reply(i, undefined, questionMessage(existing, cfg.question));
      if (existing.state === 'passed') return reply(i, '✅ Anda baru saja lolos verifikasi. Jika role belum muncul, tunggu sebentar atau hubungi staf.');
      const wait = existing.failedAt + cooldownMs - now();
      if (wait > 0) return reply(i, `⏳ Coba lagi dalam ${Math.ceil(wait / 1000)} detik.`);
      store.delete(key);
    }

    const t = now();
    const recordId = storage.verification.start({ guildId, userId: i.user.id }); // gagal -> error, tidak ada sesi
    const session = {
      sid: crypto.randomBytes(6).toString('hex'), guildId, userId: i.user.id, recordId,
      attempts: 0, state: 'active', expiresAt: t + sessionMs, failedAt: null, timedOut: false, busy: false,
    };
    store.set(key, session, sessionMs + cooldownMs); // tetap hidup selama cooldown agar bisa ditegakkan
    return reply(i, undefined, questionMessage(session, cfg.question));
  }

  async function handleAnswerButton(i, sid) {
    if (!storage) return reply(i, '⚠️ Fitur verifikasi nonaktif.');
    const { session, message } = sessionFor(i, sid);
    if (!session) return reply(i, message);
    const modal = new ModalBuilder().setCustomId(`verify:submit:${session.sid}`).setTitle('Verifikasi')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('answer').setLabel('Jawaban Anda').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100),
      ));
    return i.showModal(modal);
  }

  async function handleSubmit(i, sid) {
    if (!storage) return reply(i, '⚠️ Fitur verifikasi nonaktif.');
    const { session, message } = sessionFor(i, sid);
    if (!session) return reply(i, message);
    const text = i.fields.getTextInputValue('answer');
    if (!normalizeAnswer(text)) return reply(i, '❌ Jawaban tidak boleh kosong (tidak dihitung sebagai percobaan).');
    if (session.busy) return reply(i, '⏳ Jawaban sebelumnya masih diproses.');
    const cfg = readConfig(session.guildId);
    if (!cfg.ready) return reply(i, '⚠️ Verifikasi belum dikonfigurasi oleh staf.');

    session.busy = true;
    try {
      const correct = await answerMatches(text, cfg.answer);
      if (now() >= session.expiresAt) { settleExpired(session); return reply(i, '⌛ Sesi berakhir sebelum jawaban diproses. Tekan "Mulai verifikasi" untuk mencoba lagi.'); }
      const attempts = session.attempts + 1;

      if (correct) {
        // Simpan hasil DULU. Kalau gagal, error dilempar dan role tidak diberikan.
        storage.db.transaction(() => {
          storage.verification.finish(session.recordId, 'passed', attempts);
          storage.audit.log({ guildId: session.guildId, action: 'verification_pass', targetId: session.userId, details: { attempts } });
        });
        session.attempts = attempts;
        session.state = 'passed';
        try {
          await i.member.roles.add(cfg.roleId, 'Verifikasi berhasil');
        } catch (err) {
          log.error(`[Verification] Gagal memberi role (server ${session.guildId}, pengguna ${session.userId}): ${err.message}`);
          try { storage.audit.log({ guildId: session.guildId, action: 'verification_role_failed', targetId: session.userId, status: 'failed', reason: String(err.message).slice(0, 300) }); } catch { /* abaikan */ }
          return reply(i, '⚠️ Jawaban Anda benar, tetapi bot gagal memberi role. Hubungi staf agar role diberikan manual.');
        }
        return reply(i, '✅ Verifikasi berhasil! Selamat datang.');
      }

      if (attempts >= maxAttempts) {
        storage.db.transaction(() => {
          storage.verification.finish(session.recordId, 'failed_attempts', attempts);
          storage.audit.log({ guildId: session.guildId, action: 'verification_fail', targetId: session.userId, reason: `jawaban salah ${attempts} kali`, status: 'ok', details: { attempts } });
        });
        session.attempts = attempts; session.state = 'failed'; session.failedAt = now(); session.timedOut = false;
        return reply(i, `❌ Jawaban salah. Percobaan habis. Coba lagi dalam ${Math.ceil(cooldownMs / 1000)} detik.`);
      }
      storage.verification.setAttempts(session.recordId, attempts);
      session.attempts = attempts;
      return reply(i, `❌ Jawaban salah. Sisa percobaan: ${maxAttempts - attempts}.`, {
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`verify:answer:${session.sid}`).setLabel('Jawab lagi').setStyle(ButtonStyle.Primary),
        )],
      });
    } finally {
      session.busy = false;
    }
  }

  /* ---------------- konfigurasi (staf) ---------------- */
  const botCanPost = (channel, guild) => channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);

  async function handleCommand(i) {
    if (!i.inGuild()) return reply(i, '❌ Command ini hanya bisa dipakai di server.');
    if (!hasGuildPermission(i, PermissionFlagsBits.ManageGuild)) return reply(i, MSG_NO_PERM);
    if (!storage) return reply(i, '⚠️ Fitur verifikasi nonaktif: database tidak tersedia. Cek log bot.');
    const guildId = i.guild.id;
    const sub = i.options.getSubcommand();

    if (sub === 'question') {
      return i.showModal(new ModalBuilder().setCustomId('verifycfg:question').setTitle('Pertanyaan verifikasi').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('question').setLabel('Pertanyaan').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(MAX_QUESTION)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('answer').setLabel('Jawaban (rahasia, tidak bisa dilihat lagi)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      ));
    }

    if (sub === 'setup') {
      const role = i.options.getRole('role', true);
      const channel = i.options.getChannel('channel');
      if (role.id === guildId) return reply(i, '❌ Role @everyone tidak boleh dipakai sebagai role Verified.');
      if (role.managed) return reply(i, '❌ Role itu dikelola integrasi/bot lain dan tidak bisa diberikan.');
      if (!role.editable) return reply(i, '❌ Bot tidak bisa mengelola role itu. Pastikan bot punya izin Manage Roles dan posisi role bot LEBIH TINGGI dari role tersebut.');
      if (channel && (!channel.isTextBased?.() || channel.guildId !== guildId || !botCanPost(channel, i.guild))) {
        return reply(i, '❌ Pilih channel teks di server ini yang bisa dikirimi pesan oleh bot.');
      }
      storage.db.transaction(() => {
        storage.settings.set(guildId, 'verify.roleId', role.id);
        if (channel) storage.settings.set(guildId, 'verify.channelId', channel.id);
        storage.audit.log({ guildId, action: 'config_change', actorId: i.user.id, details: { key: 'verify.setup', roleId: role.id, channelId: channel?.id ?? null } });
      });
      return reply(i, `✅ Role Verified: <@&${role.id}>${channel ? ` • channel: <#${channel.id}>` : ''}.`);
    }

    if (sub === 'panel') {
      const cfg = readConfig(guildId);
      if (!cfg.ready) return reply(i, '❌ Atur dulu `/verification setup` dan `/verification question`.');
      const channel = cfg.channelId ? await i.guild.channels.fetch(cfg.channelId).catch(() => null) : i.channel;
      if (!channel?.isTextBased?.() || !botCanPost(channel, i.guild)) return reply(i, '❌ Channel verifikasi tidak ditemukan atau bot tidak bisa mengirim pesan di sana.');
      await channel.send({
        content: `🔐 **Verifikasi**\nTekan tombol di bawah untuk memulai. Anda punya ${Math.round(sessionMs / 60000 * 10) / 10} menit dan ${maxAttempts} kali percobaan.`,
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify:start').setLabel('Mulai verifikasi').setStyle(ButtonStyle.Primary))],
        allowedMentions: NO_MENTIONS,
      });
      storage.audit.log({ guildId, action: 'config_change', actorId: i.user.id, details: { key: 'verify.panel', channelId: channel.id } });
      return reply(i, `✅ Panel verifikasi dikirim ke <#${channel.id}>.`);
    }

    // status
    const cfg = readConfig(guildId);
    return reply(i, [
      '⚙️ **Konfigurasi verifikasi**',
      `Role Verified: ${cfg.roleId ? `<@&${cfg.roleId}>` : '(belum diatur)'}`,
      `Channel: ${cfg.channelId ? `<#${cfg.channelId}>` : '(belum diatur)'}`,
      `Pertanyaan: ${cfg.question ? cfg.question : '(belum diatur)'}`,
      `Jawaban: ${cfg.answer ? '(tersimpan sebagai hash, tidak dapat dilihat)' : '(belum diatur)'}`,
      `Aturan: ${Math.round(sessionMs / 1000)} detik, maks ${maxAttempts} jawaban salah, cooldown ${Math.round(cooldownMs / 1000)} detik.`,
      `Status: ${cfg.ready ? 'siap dipakai' : 'belum lengkap'}`,
    ].join('\n'));
  }

  async function handleConfigModal(i) {
    if (!i.inGuild?.() || !hasGuildPermission(i, PermissionFlagsBits.ManageGuild)) return reply(i, MSG_NO_PERM);
    if (!storage) return reply(i, '⚠️ Fitur verifikasi nonaktif: database tidak tersedia.');
    const question = i.fields.getTextInputValue('question').trim();
    const answer = i.fields.getTextInputValue('answer');
    if (!question) return reply(i, '❌ Pertanyaan tidak boleh kosong.');
    if (!normalizeAnswer(answer)) return reply(i, '❌ Jawaban tidak boleh kosong.');
    const record = await makeAnswerRecord(answer);
    storage.db.transaction(() => {
      storage.settings.set(i.guild.id, 'verify.question', question);
      storage.settings.set(i.guild.id, 'verify.answer', record);
      // JANGAN mencatat jawaban (atau hash-nya) di log.
      storage.audit.log({ guildId: i.guild.id, action: 'config_change', actorId: i.user.id, details: { key: 'verify.question' } });
    });
    return reply(i, '✅ Pertanyaan dan jawaban disimpan. Jawaban tidak bisa ditampilkan kembali; ganti dengan menjalankan command ini lagi.');
  }

  /** true kalau interaksi ini milik modul verifikasi. */
  async function handle(interaction) {
    const isCmd = interaction.isChatInputCommand?.() && interaction.commandName === 'verification';
    const id = interaction.customId ?? '';
    const isBtn = interaction.isButton?.() && id.startsWith('verify:');
    const isModal = interaction.isModalSubmit?.() && (id.startsWith('verify:') || id === 'verifycfg:question');
    if (!isCmd && !isBtn && !isModal) return false;
    try {
      if (isCmd) await handleCommand(interaction);
      else if (!interaction.inGuild?.()) await reply(interaction, '❌ Hanya bisa dipakai di server.');
      else if (isBtn && id === 'verify:start') await handleStart(interaction);
      else if (isBtn && id.startsWith('verify:answer:')) await handleAnswerButton(interaction, id.slice('verify:answer:'.length));
      else if (isModal && id.startsWith('verify:submit:')) await handleSubmit(interaction, id.slice('verify:submit:'.length));
      else if (isModal && id === 'verifycfg:question') await handleConfigModal(interaction);
      else await reply(interaction, '❌ Komponen verifikasi tidak dikenali. Tekan "Mulai verifikasi" lagi.');
    } catch (err) {
      log.error(`[Verification] ${id || interaction.commandName} gagal: ${err.stack || err.message}`);
      await reply(interaction, '❌ Terjadi kesalahan. Verifikasi TIDAK dianggap berhasil — coba lagi atau hubungi staf.').catch(() => {});
    }
    return true;
  }

  return { handle };
}

module.exports = { buildVerificationCommandList, createVerification };
