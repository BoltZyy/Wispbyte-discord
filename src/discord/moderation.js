'use strict';

const fs = require('fs');
const {
  ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} = require('discord.js');
const { createCompressedBackup } = require('../storage/backup');
const { botCanSendIn, checkTargetHierarchy, hasGuildPermission, isGuildOwner } = require('./permissions');

/**
 * Moderasi (tahap 2): /warn, /warnings, /warning-remove, /modconfig, /backup.
 * - Semua pesan ke pengguna adalah TEMPLATE TETAP (bukan hasil AI).
 * - Setiap handler memeriksa izin sendiri (bukan hanya mengandalkan UI Discord).
 * - Perubahan data + audit log ditulis dalam SATU transaksi: gagal -> tidak ada yang tersimpan.
 * - Tidak ada DM ke anggota; hasil dikirim ephemeral ke moderator + (opsional) channel modlog.
 */

const MODERATION_COMMANDS = new Set(['warn', 'warnings', 'warning-remove', 'modconfig', 'backup']);
const NO_MENTIONS = { parse: [] };
const MSG_NO_PERM = '❌ Anda tidak punya izin untuk command ini.';
const MB = 1024 * 1024;

function buildModerationCommandList() {
  const P = PermissionFlagsBits;
  return [
    new SlashCommandBuilder().setName('warn').setDescription('Warn a member (recorded in the moderation log)')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason for the warning').setRequired(true).setMaxLength(300)),
    new SlashCommandBuilder().setName('warnings').setDescription("Show a member's warnings")
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member to look up').setRequired(true))
      .addBooleanOption((o) => o.setName('all').setDescription('Also show removed warnings')),
    new SlashCommandBuilder().setName('warning-remove').setDescription('Remove (revoke) a warning by its ID')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addIntegerOption((o) => o.setName('id').setDescription('Warning ID').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('reason').setDescription('Why the warning is removed').setMaxLength(300)),
    new SlashCommandBuilder().setName('modconfig').setDescription('Configure moderation channels')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand((s) => s.setName('modlog-channel').setDescription('Set the moderation log channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('backup-channel').setDescription('Set the (private!) database backup channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('show').setDescription('Show the current moderation configuration')),
    new SlashCommandBuilder().setName('backup').setDescription('Send a database backup to the backup channel (bot owner / server owner only)')
      .setDefaultMemberPermissions(P.ManageGuild),
  ].map((c) => c.toJSON());
}

const fmtSize = (bytes) => (bytes >= MB ? `${(bytes / MB).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`);
const ts = (ms, style = 'd') => `<t:${Math.floor(ms / 1000)}:${style}>`;

/**
 * @param {object} deps
 * @param {object|null} deps.storage  hasil initStorage() — null = fitur nonaktif
 * @param {string} deps.ownerId       ID Discord owner bot
 */
function createModeration({
  storage, ownerId, now = Date.now, log = console, env = process.env,
  backupMaxBytes = (Number(env.BACKUP_MAX_MB) || 8) * MB,
  backupIntervalMs = (env.BACKUP_INTERVAL_HOURS === undefined || env.BACKUP_INTERVAL_HOURS === '' || Number.isNaN(Number(env.BACKUP_INTERVAL_HOURS))
    ? 24 : Number(env.BACKUP_INTERVAL_HOURS)) * 3600 * 1000,
  backupRetryMs = 60 * 60 * 1000,
  backupTimeoutMs = (Number(env.BACKUP_TIMEOUT_SECONDS) || 120) * 1000,
  createBackup = createCompressedBackup,
} = {}) {
  const reply = (i, content) => (i.replied || i.deferred
    ? i.editReply({ content, allowedMentions: NO_MENTIONS })
    : i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS }));

  /** Kirim catatan ke channel modlog (best-effort). Hasil: 'sent' | 'not_configured' | 'failed'. */
  async function postModlog(guild, content) {
    const channelId = storage.settings.get(guild.id, 'modlog.channelId');
    if (!channelId) return 'not_configured';
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.isTextBased?.()) return 'failed';
      await channel.send({ content, allowedMentions: NO_MENTIONS });
      return 'sent';
    } catch (err) {
      log.warn(`[Moderation] Gagal mengirim ke channel modlog: ${err.message}`);
      return 'failed';
    }
  }
  const modlogNote = (status) => (status === 'failed' ? '\n⚠️ Catatan ke channel modlog gagal dikirim (tindakan tetap tersimpan).' : '');

  async function handleWarn(i) {
    if (!hasGuildPermission(i, PermissionFlagsBits.ModerateMembers)) return reply(i, MSG_NO_PERM);
    const target = i.options.getUser('user', true);
    const reason = i.options.getString('reason', true).trim();
    if (!reason) return reply(i, '❌ Alasan tidak boleh kosong.');
    if (target.id === i.user.id) return reply(i, '❌ Anda tidak bisa memberi peringatan pada diri sendiri.');
    if (target.bot) return reply(i, '❌ Tidak bisa memberi peringatan pada bot.');

    const targetMember = await i.guild.members.fetch(target.id).catch(() => null);
    const check = checkTargetHierarchy({ guild: i.guild, moderatorMember: i.member, targetMember });
    if (!check.ok) {
      return reply(i, check.reason === 'target_is_owner'
        ? '❌ Pemilik server tidak bisa diberi peringatan.'
        : '❌ Role tertinggi target sama dengan atau lebih tinggi dari role Anda.');
    }

    const warning = storage.db.transaction(() => {
      const w = storage.warnings.add({ guildId: i.guild.id, userId: target.id, moderatorId: i.user.id, reason });
      storage.audit.log({ guildId: i.guild.id, action: 'warn', actorId: i.user.id, targetId: target.id, reason, details: { warningId: w.id } });
      return w;
    });
    const total = storage.warnings.countActive(i.guild.id, target.id);
    const status = await postModlog(i.guild,
      `⚠️ **Warning #${warning.id}** — <@${target.id}> oleh <@${i.user.id}> (total aktif: ${total})\nAlasan: ${reason}`);
    return reply(i, `✅ Peringatan #${warning.id} dicatat untuk <@${target.id}> (total aktif: ${total}).`
      + `${targetMember ? '' : '\nℹ️ Pengguna ini tidak ada di server.'}${modlogNote(status)}`);
  }

  async function handleWarnings(i) {
    if (!hasGuildPermission(i, PermissionFlagsBits.ModerateMembers)) return reply(i, MSG_NO_PERM);
    const target = i.options.getUser('user', true);
    const all = i.options.getBoolean('all') ?? false;
    const rows = storage.warnings.list({ guildId: i.guild.id, userId: target.id, includeInactive: all, limit: 15 });
    if (!rows.length) return reply(i, `ℹ️ <@${target.id}> tidak punya peringatan${all ? '' : ' aktif'}.`);
    const lines = rows.map((w) => `#${w.id}${w.status === 'active' ? '' : ' (dicabut)'} • ${ts(w.createdAt)} • oleh <@${w.moderatorId}> — ${w.reason}`);
    let content = `📋 Peringatan <@${target.id}> — total aktif: ${storage.warnings.countActive(i.guild.id, target.id)}\n${lines.join('\n')}`;
    if (content.length > 1900) content = `${content.slice(0, 1890)}…`;
    return reply(i, content);
  }

  async function handleWarningRemove(i) {
    if (!hasGuildPermission(i, PermissionFlagsBits.ModerateMembers)) return reply(i, MSG_NO_PERM);
    const id = i.options.getInteger('id', true);
    const reason = i.options.getString('reason')?.trim() || null;
    const result = storage.db.transaction(() => {
      const r = storage.warnings.remove({ guildId: i.guild.id, id, removedBy: i.user.id, reason });
      if (r.ok) {
        storage.audit.log({ guildId: i.guild.id, action: 'warning_remove', actorId: i.user.id, targetId: r.row.userId, reason, details: { warningId: id } });
      }
      return r;
    });
    if (!result.ok) {
      return reply(i, result.reason === 'already_inactive' ? `❌ Peringatan #${id} sudah dicabut sebelumnya.` : `❌ Peringatan #${id} tidak ditemukan.`);
    }
    const status = await postModlog(i.guild,
      `✅ **Warning #${id}** dicabut oleh <@${i.user.id}> (untuk <@${result.row.userId}>)${reason ? `\nAlasan: ${reason}` : ''}`);
    return reply(i, `✅ Peringatan #${id} dicabut.${modlogNote(status)}`);
  }

  async function handleModconfig(i) {
    if (!hasGuildPermission(i, PermissionFlagsBits.ManageGuild)) return reply(i, MSG_NO_PERM);
    const sub = i.options.getSubcommand();
    const guildId = i.guild.id;

    if (sub === 'show') {
      const modlog = storage.settings.get(guildId, 'modlog.channelId');
      const backup = storage.settings.get(guildId, 'backup.channelId');
      const last = storage.settings.get(guildId, 'backup.lastAt', 0);
      return reply(i, [
        '⚙️ **Konfigurasi moderasi**',
        `Channel modlog: ${modlog ? `<#${modlog}>` : '(belum diatur)'}`,
        `Channel backup: ${backup ? `<#${backup}>` : '(belum diatur)'}`,
        `Backup terakhir: ${last ? ts(last, 'R') : '(belum pernah)'} • interval: ${backupIntervalMs > 0 ? `${backupIntervalMs / 3600000} jam` : 'nonaktif'}`,
      ].join('\n'));
    }

    const channel = i.options.getChannel('channel', true);
    if (!channel.isTextBased?.() || channel.guildId !== guildId) return reply(i, '❌ Pilih channel teks di server ini.');
    const extra = sub === 'backup-channel' ? [PermissionFlagsBits.AttachFiles] : [];
    if (!(await botCanSendIn(channel, i.guild, extra))) {
      return reply(i, `❌ Bot belum punya izin yang cukup di <#${channel.id}> (${sub === 'backup-channel' ? 'Lihat Channel, Kirim Pesan, Lampirkan File' : 'Lihat Channel, Kirim Pesan'}).`);
    }
    const key = sub === 'modlog-channel' ? 'modlog.channelId' : 'backup.channelId';
    storage.db.transaction(() => {
      storage.settings.set(guildId, key, channel.id);
      storage.audit.log({ guildId, action: 'config_change', actorId: i.user.id, details: { key, channelId: channel.id } });
    });
    return reply(i, sub === 'backup-channel'
      ? `✅ Channel backup diatur ke <#${channel.id}>.\n⚠️ Pastikan channel ini PRIVAT: backup berisi ID pengguna dan log moderasi.`
      : `✅ Channel modlog diatur ke <#${channel.id}>.`);
  }

  /* ---------------- backup ---------------- */
  let backupChain = Promise.resolve(); // serialisasi: tidak pernah dua backup berjalan bersamaan
  function runBackup(args) {
    const p = backupChain.then(() => doBackup(args));
    backupChain = p.catch(() => {});
    return p;
  }
  /** Langkah-langkah backup. Melempar error kalau gagal; menghormati state.cancelled (batas waktu terlewati). */
  async function backupSteps({ guild, trigger, actorId }, state) {
    let file;
    try {
      const channelId = storage.settings.get(guild.id, 'backup.channelId');
      if (!channelId) throw new Error('channel backup belum diatur');
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased?.()) throw new Error('channel backup tidak ditemukan atau bukan channel teks');
      file = await createBackup(storage.db, { now });
      state.file = file;
      if (state.cancelled) throw new Error('dibatalkan karena melewati batas waktu');
      if (file.bytes > backupMaxBytes) throw new Error(`ukuran backup ${fmtSize(file.bytes)} melebihi batas ${fmtSize(backupMaxBytes)}`);
      await channel.send({
        content: `📦 Backup database (${trigger}) — ${file.name} — ${fmtSize(file.bytes)}`,
        files: [{ attachment: file.path, name: file.name }],
        allowedMentions: NO_MENTIONS,
      });
      if (state.cancelled) throw new Error('pengiriman selesai setelah batas waktu — dianggap gagal');
      storage.settings.set(guild.id, 'backup.lastAt', now());
      storage.audit.log({ guildId: guild.id, action: 'backup', actorId, details: { trigger, bytes: file.bytes, name: file.name } });
      return { ok: true, channelId, name: file.name, bytes: file.bytes };
    } finally {
      if (file) fs.rmSync(file.path, { force: true });
    }
  }

  /**
   * Satu backup dengan BATAS WAKTU: proses yang macet berakhir sebagai kegagalan yang
   * tercatat dan tidak memblokir antrean. Catatan: operasi yang sudah berjalan tidak bisa
   * dibatalkan paksa; hasilnya yang terlambat diabaikan dan berkas sementaranya dihapus.
   */
  async function doBackup({ guild, trigger, actorId = null }) {
    const state = { cancelled: false, file: null };
    const work = backupSteps({ guild, trigger, actorId }, state);
    work.catch((err) => { if (state.cancelled) log.warn(`[Backup] Proses yang melewati batas waktu akhirnya berhenti: ${err.message}`); });
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        state.cancelled = true;
        if (state.file) fs.rmSync(state.file.path, { force: true });
        reject(new Error(`melewati batas waktu ${Math.round(backupTimeoutMs / 1000)} detik`));
      }, backupTimeoutMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } catch (err) {
      try {
        storage.audit.log({ guildId: guild.id, action: 'backup', actorId, status: 'failed', reason: String(err.message).slice(0, 300), details: { trigger } });
      } catch { /* database sendiri bermasalah — sudah dilaporkan lewat hasil */ }
      return { ok: false, error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleBackup(i) {
    const allowed = String(i.user.id) === String(ownerId) || isGuildOwner(i);
    if (!allowed) return reply(i, '❌ Hanya owner bot atau pemilik server yang boleh menjalankan backup.');
    if (!storage.settings.get(i.guild.id, 'backup.channelId')) {
      return reply(i, '❌ Channel backup belum diatur. Gunakan `/modconfig backup-channel` dulu.');
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await runBackup({ guild: i.guild, trigger: 'manual', actorId: i.user.id });
    return reply(i, r.ok ? `✅ Backup terkirim ke <#${r.channelId}> (${r.name}, ${fmtSize(r.bytes)}).` : `❌ Backup gagal: ${r.error}`);
  }

  const failedAt = new Map(); // guildId -> waktu kegagalan terakhir (mencegah percobaan ulang beruntun)
  /** Cek semua server: kirim backup terjadwal yang sudah jatuh tempo. */
  async function checkScheduledBackups(client) {
    if (!storage || !(backupIntervalMs > 0)) return [];
    const results = [];
    for (const guild of client.guilds.cache.values()) {
      if (!storage.settings.get(guild.id, 'backup.channelId')) continue;
      const t = now();
      if (t - storage.settings.get(guild.id, 'backup.lastAt', 0) < backupIntervalMs) continue;
      if (failedAt.has(guild.id) && t - failedAt.get(guild.id) < backupRetryMs) continue;
      const r = await runBackup({ guild, trigger: 'terjadwal' });
      if (r.ok) failedAt.delete(guild.id);
      else { failedAt.set(guild.id, t); log.warn(`[Backup] Backup terjadwal gagal (server ${guild.id}): ${r.error}`); }
      results.push({ guildId: guild.id, ok: r.ok });
    }
    return results;
  }
  /** Timer di-unref: tidak menahan proses. Pemeriksaan tiap 10 menit; interval backup dibaca dari database (tahan restart). */
  function startScheduler(client, { firstDelayMs = 30000, tickMs = 600000 } = {}) {
    if (!storage || !(backupIntervalMs > 0)) return null;
    const run = () => checkScheduledBackups(client).catch((err) => log.error(`[Backup] Pemeriksaan terjadwal error: ${err.message}`));
    const first = setTimeout(run, firstDelayMs); first.unref();
    const timer = setInterval(run, tickMs); timer.unref();
    return { stop() { clearTimeout(first); clearInterval(timer); } };
  }

  /** Mengembalikan true kalau interaksi ini milik modul moderasi (sudah ditangani). */
  async function handle(interaction) {
    if (!interaction.isChatInputCommand?.() || !MODERATION_COMMANDS.has(interaction.commandName)) return false;
    try {
      if (!interaction.inGuild()) { await reply(interaction, '❌ Command ini hanya bisa dipakai di server.'); return true; }
      if (!storage) { await reply(interaction, '⚠️ Fitur moderasi nonaktif: database tidak tersedia. Cek log bot.'); return true; }
      const handlers = { warn: handleWarn, warnings: handleWarnings, 'warning-remove': handleWarningRemove, modconfig: handleModconfig, backup: handleBackup };
      await handlers[interaction.commandName](interaction);
    } catch (err) {
      log.error(`[Moderation] /${interaction.commandName} gagal: ${err.stack || err.message}`);
      await reply(interaction, '❌ Terjadi kesalahan. Tindakan ini TIDAK tercatat sebagai berhasil — coba lagi atau cek log bot.').catch(() => {});
    }
    return true;
  }

  return { handle, runBackup, checkScheduledBackups, startScheduler };
}

module.exports = { buildModerationCommandList, createModeration };
