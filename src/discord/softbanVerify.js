'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} = require('discord.js');
const { botCanManageRole, checkTargetHierarchy, fetchBotMember, hasGuildPermission } = require('./permissions');

/**
 * Softban-verifikasi (tahap 6): moderator mencabut role Verified, anggota TETAP di server, harus
 * verifikasi ulang, lalu MENUNGGU persetujuan staf sebelum role dipulihkan.
 *
 * ATURAN PENTING: lolos verifikasi ulang TIDAK memulihkan akses. Role Verified hanya kembali lewat
 * approve/cancel staf yang sudah TERCATAT di SQLite (database dulu, baru Discord). Selama ada kasus
 * yang memblokir, verification.js tidak boleh memberi role lewat jalur biasa.
 *
 * Mencabut role Verified TIDAK cukup membatasi akses kalau role lain masih memberi izin lihat channel:
 * setelah pencabutan, bot menghitung channel mana saja yang MASIH bisa dilihat anggota
 * (kecuali channel verifikasi dan channel publik yang diizinkan) dan melaporkannya — tindakan dicatat
 * 'partial' kalau ada kebocoran. Bot TIDAK mencabut role lain secara otomatis.
 */

const NO_MENTIONS = { parse: [] };
const EPHEMERAL = MessageFlags.Ephemeral;
const MSG_NO_PERM = '❌ Anda tidak punya izin untuk command ini.';
const UNKNOWN_MEMBER = 10007;
const MAX_LEAKS_SHOWN = 10;

function buildSoftbanVerifyCommandList() {
  const caseId = (o) => o.setName('case').setDescription('Case ID').setRequired(true).setMinValue(1);
  const reason = (o) => o.setName('reason').setDescription('Reason (staff log)').setMaxLength(300);
  return [
    new SlashCommandBuilder().setName('softban-verify').setDescription('Revoke Verified, require re-verification and staff approval')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addSubcommand((s) => s.setName('start').setDescription('Revoke the Verified role and require re-verification')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption(reason))
      .addSubcommand((s) => s.setName('approve').setDescription('Approve a case that passed re-verification and restore Verified').addIntegerOption(caseId))
      .addSubcommand((s) => s.setName('reject').setDescription('Reject a case (member stays restricted)').addIntegerOption(caseId).addStringOption(reason))
      .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a case and restore Verified right away (staff decision)').addIntegerOption(caseId).addStringOption(reason))
      .addSubcommand((s) => s.setName('status').setDescription('List cases waiting for verification or approval')
        .addUserOption((o) => o.setName('user').setDescription('Only this member'))),
  ].map((c) => c.toJSON());
}

const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const STATUS_LABEL = {
  awaiting_verification: 'menunggu verifikasi ulang', pending_approval: 'MENUNGGU PERSETUJUAN', approved: 'disetujui', rejected: 'ditolak', cancelled: 'dibatalkan',
};

function createSoftbanVerify({ storage, now = Date.now, log = console } = {}) {
  const reply = (i, content, extra = {}) => (i.replied || i.deferred
    ? i.editReply({ content, allowedMentions: NO_MENTIONS, ...extra })
    : i.reply({ content, flags: EPHEMERAL, allowedMentions: NO_MENTIONS, ...extra }));

  const memberHasRole = (member, roleId) => Boolean(member?.roles?.cache?.has(roleId));
  async function fetchMember(guild, userId, force = false) {
    try { return await guild.members.fetch(force ? { user: userId, force: true } : userId); } catch (err) {
      if (err?.code === UNKNOWN_MEMBER) return null;
      throw err;
    }
  }
  /** Audit untuk langkah SETELAH efek di Discord terjadi: kegagalan dicatat ke log bot, tidak melempar. */
  function safeAudit(entry) {
    try { storage.audit.log(entry); return true; } catch (err) { log.error(`[SoftbanVerify] Gagal mencatat audit (${entry.action}): ${err.message}`); return false; }
  }
  async function postStaff(guild, payload) {
    try {
      const channelId = storage.settings.get(guild.id, 'modlog.channelId');
      if (!channelId) return false;
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.isTextBased?.()) return false;
      await channel.send({ allowedMentions: NO_MENTIONS, ...payload });
      return true;
    } catch (err) {
      log.warn(`[SoftbanVerify] Gagal mengirim ke channel modlog: ${err.message}`);
      return false;
    }
  }

  const cfgOf = (guildId) => {
    const s = storage.settings;
    const roleId = s.get(guildId, 'verify.roleId');
    return { roleId, channelId: s.get(guildId, 'verify.channelId'), publicIds: s.get(guildId, 'verify.publicChannelIds', []), ready: Boolean(roleId && s.get(guildId, 'verify.question') && s.get(guildId, 'verify.answer')) };
  };

  /** Channel (selain yang diizinkan) yang MASIH bisa dilihat anggota ini. */
  function findLeaks(guild, member, allowed) {
    const leaks = [];
    for (const ch of guild.channels.cache.values()) {
      if (ch.type === ChannelType.GuildCategory || ch.isThread?.()) continue;
      if (allowed.has(String(ch.id))) continue;
      if (ch.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) leaks.push(ch.id);
    }
    return leaks;
  }

  /* ---------------- memulihkan role (setelah keputusan staf tercatat) ---------------- */
  async function restoreRole(guild, row, actorId, action) {
    const roleId = storage.settings.get(guild.id, 'verify.roleId');
    const fail = (error) => { safeAudit({ guildId: guild.id, action: 'softban_verify_role_restore_failed', actorId, targetId: row.userId, status: 'failed', reason: String(error).slice(0, 300), details: { caseId: row.id, via: action } }); return { ok: false, error }; };
    if (!roleId) return fail('role Verified belum dikonfigurasi');
    let member;
    try { member = await fetchMember(guild, row.userId); } catch (err) { return fail(err.message); }
    if (!member) return fail('anggota sudah tidak ada di server');
    try { await member.roles.add(roleId, `Softban-verify ${action} oleh ${actorId}`); } catch (err) { return fail(err.message); }
    storage.softbans.markRoleRestored(guild.id, row.id);
    safeAudit({ guildId: guild.id, action: 'softban_verify_role_restored', actorId, targetId: row.userId, details: { caseId: row.id, via: action } });
    return { ok: true };
  }

  const wrongStatus = (row) => ({
    awaiting_verification: `❌ Kasus #${row.id} belum lolos verifikasi ulang — belum bisa disetujui.`,
    pending_approval: `❌ Kasus #${row.id} masih menunggu keputusan.`,
    approved: `❌ Kasus #${row.id} sudah disetujui.`,
    rejected: `❌ Kasus #${row.id} sudah ditolak.`,
    cancelled: `❌ Kasus #${row.id} sudah dibatalkan.`,
  }[row.status]);

  async function approveCase(guild, actorId, caseId) {
    const row = storage.softbans.get(guild.id, caseId);
    if (!row) return { ok: false, message: `❌ Kasus #${caseId} tidak ditemukan.` };
    if (row.userId === actorId) return { ok: false, message: '❌ Anda tidak bisa memutuskan kasus milik sendiri.' };

    if (row.status === 'approved') {   // sudah disetujui; hanya coba ulang pemulihan role kalau sebelumnya gagal
      if (row.roleRestoredAt) return { ok: false, message: wrongStatus(row) };
      const r = await restoreRole(guild, row, actorId, 'approve (ulang)');
      return r.ok ? { ok: true, message: `✅ Role Verified dipulihkan untuk <@${row.userId}> (percobaan ulang kasus #${row.id}).` } : { ok: false, message: `⚠️ Kasus #${row.id} sudah disetujui tetapi role masih gagal dipulihkan: ${r.error}. Jalankan lagi untuk mencoba ulang.` };
    }
    if (row.status !== 'pending_approval') return { ok: false, message: wrongStatus(row) };

    // Keputusan staf disimpan DULU; baru role diberikan.
    const t = storage.db.transaction(() => {
      const r = storage.softbans.transition({ guildId: guild.id, id: row.id, from: ['pending_approval'], to: 'approved', by: actorId });
      if (r.ok) storage.audit.log({ guildId: guild.id, action: 'softban_verify_approve', actorId, targetId: row.userId, details: { caseId: row.id } });
      return r;
    });
    if (!t.ok) return { ok: false, message: t.row ? wrongStatus(t.row) : `❌ Kasus #${caseId} tidak ditemukan.` };
    const r = await restoreRole(guild, t.row, actorId, 'approve');
    await postStaff(guild, { content: `✅ **Kasus #${row.id}** disetujui oleh <@${actorId}> — <@${row.userId}>${r.ok ? ': role Verified dipulihkan.' : `: role GAGAL dipulihkan (${r.error}).`}` });
    return r.ok
      ? { ok: true, message: `✅ Kasus #${row.id} disetujui. Role Verified dipulihkan untuk <@${row.userId}>.` }
      : { ok: false, message: `⚠️ Kasus #${row.id} disetujui, tetapi role gagal dipulihkan: ${r.error}. Jalankan \`/softban-verify approve\` lagi untuk mencoba ulang.` };
  }

  async function rejectCase(guild, actorId, caseId, reason) {
    const row = storage.softbans.get(guild.id, caseId);
    if (!row) return { ok: false, message: `❌ Kasus #${caseId} tidak ditemukan.` };
    if (row.userId === actorId) return { ok: false, message: '❌ Anda tidak bisa memutuskan kasus milik sendiri.' };
    const t = storage.db.transaction(() => {
      const r = storage.softbans.transition({ guildId: guild.id, id: row.id, from: ['awaiting_verification', 'pending_approval'], to: 'rejected', by: actorId, note: reason });
      if (r.ok) storage.audit.log({ guildId: guild.id, action: 'softban_verify_reject', actorId, targetId: row.userId, reason, details: { caseId: row.id } });
      return r;
    });
    if (!t.ok) return { ok: false, message: t.row ? wrongStatus(t.row) : `❌ Kasus #${caseId} tidak ditemukan.` };
    await postStaff(guild, { content: `⛔ **Kasus #${row.id}** ditolak oleh <@${actorId}> — <@${row.userId}> tetap dibatasi.${reason ? `\nAlasan: ${reason}` : ''}` });
    return { ok: true, message: `✅ Kasus #${row.id} ditolak. <@${row.userId}> tetap dibatasi dan tidak bisa memulihkan akses lewat verifikasi.` };
  }

  async function cancelCase(guild, actorId, caseId, reason) {
    const row = storage.softbans.get(guild.id, caseId);
    if (!row) return { ok: false, message: `❌ Kasus #${caseId} tidak ditemukan.` };
    if (row.userId === actorId) return { ok: false, message: '❌ Anda tidak bisa memutuskan kasus milik sendiri.' };
    if (row.status === 'cancelled') {
      if (row.roleRestoredAt) return { ok: false, message: wrongStatus(row) };
      const r = await restoreRole(guild, row, actorId, 'cancel (ulang)');
      return r.ok ? { ok: true, message: `✅ Role Verified dipulihkan untuk <@${row.userId}> (percobaan ulang kasus #${row.id}).` } : { ok: false, message: `⚠️ Role masih gagal dipulihkan: ${r.error}. Jalankan lagi untuk mencoba ulang.` };
    }
    const t = storage.db.transaction(() => {
      const r = storage.softbans.transition({ guildId: guild.id, id: row.id, from: ['awaiting_verification', 'pending_approval', 'rejected'], to: 'cancelled', by: actorId, note: reason });
      if (r.ok) storage.audit.log({ guildId: guild.id, action: 'softban_verify_cancel', actorId, targetId: row.userId, reason, details: { caseId: row.id } });
      return r;
    });
    if (!t.ok) return { ok: false, message: t.row ? wrongStatus(t.row) : `❌ Kasus #${caseId} tidak ditemukan.` };
    const r = await restoreRole(guild, t.row, actorId, 'cancel');
    await postStaff(guild, { content: `↩️ **Kasus #${row.id}** dibatalkan oleh <@${actorId}> — <@${row.userId}>${r.ok ? ': role Verified dipulihkan.' : `: role GAGAL dipulihkan (${r.error}).`}${reason ? `\nAlasan: ${reason}` : ''}` });
    return r.ok
      ? { ok: true, message: `✅ Kasus #${row.id} dibatalkan. Role Verified dipulihkan untuk <@${row.userId}>.` }
      : { ok: false, message: `⚠️ Kasus #${row.id} dibatalkan, tetapi role gagal dipulihkan: ${r.error}. Jalankan lagi untuk mencoba ulang.` };
  }

  /** Dipanggil verification.js setelah anggota softban lolos verifikasi ulang (status sudah 'pending_approval'). */
  async function notifyPending(guild, row) {
    return postStaff(guild, {
      content: `🔔 **Verifikasi ulang lolos** — kasus #${row.id}: <@${row.userId}> menunggu persetujuan staf.\nRole Verified BELUM dipulihkan. Setujui untuk memulihkan akses, atau tolak.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sbv:approve:${row.id}`).setLabel('Setujui').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`sbv:reject:${row.id}`).setLabel('Tolak').setStyle(ButtonStyle.Danger),
      )],
    });
  }

  /* ---------------- /softban-verify start ---------------- */
  async function startCase(i) {
    const { guild } = i; const guildId = guild.id;
    const target = i.options.getUser('user', true);
    const reason = i.options.getString('reason')?.trim() || null;
    if (target.id === i.user.id) return reply(i, '❌ Anda tidak bisa softban-verifikasi diri sendiri.');
    if (target.bot) return reply(i, '❌ Tidak bisa dilakukan pada bot.');
    const cfg = cfgOf(guildId);
    if (!cfg.ready) return reply(i, '❌ Verifikasi belum dikonfigurasi. Atur `/verification setup` dan `/verification question` dulu.');

    const member = await fetchMember(guild, target.id);
    if (!member) return reply(i, '❌ Anggota tidak ada di server.');
    const h = checkTargetHierarchy({ guild, moderatorMember: i.member, targetMember: member });
    if (!h.ok) return reply(i, h.reason === 'target_is_owner' ? '❌ Pemilik server tidak bisa dikenai tindakan ini.' : '❌ Role tertinggi target sama dengan atau lebih tinggi dari role Anda.');
    const existing = storage.softbans.getBlocking(guildId, target.id);
    if (existing) return reply(i, `❌ Anggota ini sudah punya kasus #${existing.id} (${STATUS_LABEL[existing.status]}). Selesaikan atau batalkan dulu.`);
    if (!memberHasRole(member, cfg.roleId)) return reply(i, '❌ Anggota ini tidak punya role Verified.');
    const role = guild.roles?.cache?.get(cfg.roleId) ?? { id: cfg.roleId, managed: false, position: 0 };
    const botMember = await fetchBotMember(guild);
    if (!botCanManageRole(botMember, role, guild)) return reply(i, '❌ Bot tidak bisa mengelola role Verified. Pastikan bot punya izin Manage Roles dan role bot LEBIH TINGGI dari role Verified.');

    // 1. Kasus + audit tersimpan DULU (database tidak boleh tertinggal dari kenyataan di Discord).
    const opened = storage.db.transaction(() => {
      const r = storage.softbans.open({ guildId, userId: target.id, moderatorId: i.user.id, reason });
      if (r.ok) storage.audit.log({ guildId, action: 'softban_verify_start', actorId: i.user.id, targetId: target.id, reason, details: { caseId: r.row.id, step: 'case_created' } });
      return r;
    });
    if (!opened.ok) return reply(i, `❌ Anggota ini sudah punya kasus #${opened.existing.id} (${STATUS_LABEL[opened.existing.status]}). Selesaikan atau batalkan dulu.`);
    const row = opened.row;

    // 2. Cabut role Verified. Gagal -> kasus dibatalkan (belum ada yang berubah di Discord).
    try {
      await member.roles.remove(cfg.roleId, `Softban-verify oleh ${i.user.id}${reason ? `: ${reason}` : ''}`);
    } catch (err) {
      try {
        storage.db.transaction(() => {
          storage.softbans.transition({ guildId, id: row.id, from: ['awaiting_verification'], to: 'cancelled', by: i.user.id, note: 'gagal mencabut role' });
          storage.audit.log({ guildId, action: 'softban_verify_role_removed', actorId: i.user.id, targetId: target.id, status: 'failed', reason: String(err.message).slice(0, 300), details: { caseId: row.id } });
        });
      } catch (dbErr) { log.error(`[SoftbanVerify] Gagal membatalkan kasus #${row.id}: ${dbErr.message}`); }
      return reply(i, `❌ Gagal mencabut role Verified: ${err.message}. Tidak ada perubahan (kasus #${row.id} dibatalkan).`);
    }
    safeAudit({ guildId, action: 'softban_verify_role_removed', actorId: i.user.id, targetId: target.id, details: { caseId: row.id } });

    // 3. Pastikan akses benar-benar terbatas (mencabut Verified saja belum tentu cukup).
    let leaks = []; let checkError = null;
    try {
      const fresh = await fetchMember(guild, target.id, true);
      if (!fresh) throw new Error('anggota tidak ditemukan saat pemeriksaan');
      if (memberHasRole(fresh, cfg.roleId)) throw new Error('role Verified masih terdeteksi pada anggota');
      leaks = findLeaks(guild, fresh, new Set([cfg.channelId, ...cfg.publicIds].filter(Boolean).map(String)));
    } catch (err) { checkError = err; }
    const partial = leaks.length > 0 || checkError !== null;
    safeAudit({
      guildId, action: 'softban_verify_restriction_check', actorId: i.user.id, targetId: target.id, status: partial ? 'partial' : 'ok',
      reason: checkError ? String(checkError.message).slice(0, 300) : null,
      details: { caseId: row.id, leakCount: leaks.length, leakedChannelIds: leaks.slice(0, 25), checkFailed: checkError !== null },
    });

    // 4. Beri tahu anggota (di channel verifikasi, tanpa DM) dan staf.
    if (cfg.channelId) {
      try {
        const ch = await guild.channels.fetch(cfg.channelId);
        if (ch?.isTextBased?.()) await ch.send({ content: `🔒 <@${target.id}> akses Anda dibatasi sementara. Tekan **Mulai verifikasi** di panel untuk memverifikasi ulang; setelah lolos, staf akan meninjau sebelum akses dipulihkan.`, allowedMentions: { users: [target.id] } });
      } catch (err) { log.warn(`[SoftbanVerify] Gagal mengumumkan di channel verifikasi: ${err.message}`); }
    }
    await postStaff(guild, { content: `🔒 **Softban-verifikasi #${row.id}** — <@${target.id}> oleh <@${i.user.id}>${reason ? `\nAlasan: ${reason}` : ''}\nMenunggu anggota verifikasi ulang, lalu persetujuan staf.${partial ? '\n⚠️ Batas akses belum sepenuhnya terjamin (lihat balasan moderator / audit log).' : ''}` });

    const lines = [`✅ Softban-verifikasi dimulai (kasus #${row.id}): <@${target.id}> kehilangan role Verified dan tetap berada di server.`,
      'Anggota harus verifikasi ulang; setelah lolos, kasus MENUNGGU persetujuan staf (`/softban-verify approve`).'];
    if (leaks.length) {
      const shown = leaks.slice(0, MAX_LEAKS_SHOWN).map((id) => `<#${id}>`).join(', ');
      lines.push(`⚠️ **Akses belum terbatas:** anggota masih bisa melihat ${shown}${leaks.length > MAX_LEAKS_SHOWN ? ` (+${leaks.length - MAX_LEAKS_SHOWN} lainnya)` : ''}. Penyebabnya biasanya role lain atau izin channel. Perbaiki izin sebelum mengandalkan pembatasan ini; bot tidak mencabut role lain.`);
    }
    if (checkError) lines.push(`⚠️ Pemeriksaan batas akses gagal: ${checkError.message}. Periksa manual izin channel anggota.`);
    return reply(i, lines.join('\n'));
  }

  async function statusCases(i) {
    const user = i.options.getUser('user');
    const rows = user
      ? storage.softbans.list({ guildId: i.guild.id, userId: user.id, statuses: Object.keys(STATUS_LABEL), limit: 5 })
      : storage.softbans.list({ guildId: i.guild.id });
    if (!rows.length) return reply(i, user ? `ℹ️ <@${user.id}> tidak punya kasus softban-verifikasi.` : 'ℹ️ Tidak ada kasus yang menunggu.');
    const restoredNote = (r) => (r.status === 'approved' || r.status === 'cancelled' ? (r.roleRestoredAt ? ' • role dipulihkan' : ' • role BELUM dipulihkan') : '');
    const lines = rows.map((r) => `#${r.id} • <@${r.userId}> • ${STATUS_LABEL[r.status]} • ${ts(r.createdAt)}${restoredNote(r)}${r.reason ? ` • ${r.reason}` : ''}`);
    let content = `🔒 **Kasus softban-verifikasi**\n${lines.join('\n')}`;
    if (content.length > 1900) content = `${content.slice(0, 1890)}…`;
    return reply(i, content);
  }

  async function handleCommand(i) {
    if (!i.inGuild()) return reply(i, '❌ Command ini hanya bisa dipakai di server.');
    if (!hasGuildPermission(i, PermissionFlagsBits.ModerateMembers)) return reply(i, MSG_NO_PERM);
    if (!storage) return reply(i, '⚠️ Fitur ini nonaktif: database tidak tersedia. Cek log bot.');
    const sub = i.options.getSubcommand();
    if (sub === 'start') return startCase(i);
    if (sub === 'status') return statusCases(i);
    const id = i.options.getInteger('case', true);
    const reason = i.options.getString('reason')?.trim() || null;
    const result = sub === 'approve' ? await approveCase(i.guild, i.user.id, id)
      : sub === 'reject' ? await rejectCase(i.guild, i.user.id, id, reason)
        : await cancelCase(i.guild, i.user.id, id, reason);
    return reply(i, result.message);
  }

  async function handleButton(i, action, caseId) {
    if (!hasGuildPermission(i, PermissionFlagsBits.ModerateMembers)) return reply(i, MSG_NO_PERM);
    const result = action === 'approve' ? await approveCase(i.guild, i.user.id, caseId) : await rejectCase(i.guild, i.user.id, caseId, null);
    if (!result.ok) return reply(i, result.message);
    return i.update({ content: `${i.message?.content ?? ''}\n\n${result.message}`.trim().slice(0, 1990), components: [], allowedMentions: NO_MENTIONS });
  }

  /** true kalau interaksi ini milik modul softban-verifikasi. */
  async function handle(interaction) {
    const id = interaction.customId ?? '';
    const isCmd = interaction.isChatInputCommand?.() && interaction.commandName === 'softban-verify';
    const isBtn = interaction.isButton?.() && id.startsWith('sbv:');
    if (!isCmd && !isBtn) return false;
    try {
      if (isCmd) await handleCommand(interaction);
      else if (!interaction.inGuild?.()) await reply(interaction, '❌ Hanya bisa dipakai di server.');
      else if (!storage) await reply(interaction, '⚠️ Fitur ini nonaktif: database tidak tersedia.');
      else {
        const [, action, caseId] = id.split(':');
        if ((action === 'approve' || action === 'reject') && Number.isInteger(Number(caseId))) await handleButton(interaction, action, Number(caseId));
        else await reply(interaction, '❌ Komponen tidak dikenali.');
      }
    } catch (err) {
      log.error(`[SoftbanVerify] ${id || interaction.commandName} gagal: ${err.stack || err.message}`);
      await reply(interaction, '❌ Terjadi kesalahan. Keputusan/tindakan mungkin tidak lengkap — periksa `/softban-verify status` dan audit log.').catch(() => {});
    }
    return true;
  }

  return { handle, notifyPending };
}

module.exports = { buildSoftbanVerifyCommandList, createSoftbanVerify };
