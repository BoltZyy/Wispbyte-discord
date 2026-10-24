'use strict';

/**
 * Pemeriksaan izin sisi-handler. Izin di UI Discord (setDefaultMemberPermissions)
 * hanya penyaring tampilan — setiap handler WAJIB memanggil fungsi di sini.
 */

/** Anggota yang menjalankan command punya izin Discord tertentu (Administrator otomatis lolos). */
function hasGuildPermission(interaction, flag) {
  return Boolean(interaction.inGuild?.() && interaction.memberPermissions?.has(flag));
}

const isGuildOwner = (interaction) => Boolean(interaction.guild && interaction.guild.ownerId === interaction.user.id);

/**
 * Hierarki: pemilik server boleh menindak siapa pun (selain dirinya sendiri, dicek
 * terpisah); pemilik server tidak bisa ditindak; selain itu role tertinggi moderator
 * harus LEBIH tinggi daripada role tertinggi target. Target yang bukan anggota
 * (sudah keluar) tidak punya hierarki -> lolos.
 */
function checkTargetHierarchy({ guild, moderatorMember, targetMember }) {
  if (!targetMember) return { ok: true };
  if (guild.ownerId === targetMember.id) return { ok: false, reason: 'target_is_owner' };
  if (guild.ownerId === moderatorMember.id) return { ok: true };
  if (moderatorMember.roles.highest.comparePositionTo(targetMember.roles.highest) > 0) return { ok: true };
  return { ok: false, reason: 'target_higher_or_equal' };
}

module.exports = { checkTargetHierarchy, hasGuildPermission, isGuildOwner };
