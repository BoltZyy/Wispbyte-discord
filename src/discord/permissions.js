'use strict';

const { PermissionFlagsBits } = require('discord.js');

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

/**
 * Anggota (GuildMember) milik bot sendiri. JANGAN memakai guild.members.me langsung:
 * cache anggota dimatikan di main.js (GuildMemberManager: 0), jadi nilainya null.
 * Role#editable pun TIDAK boleh dipakai (melempar error saat me == null).
 */
async function fetchBotMember(guild) {
  return guild.members.me ?? guild.members.fetchMe();
}

/** Bot boleh mengelola role: bukan @everyone / managed, punya ManageRoles, role tertinggi bot lebih tinggi. */
function botCanManageRole(botMember, role, guild) {
  if (!role || role.managed || role.id === guild.id) return false;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  return botMember.roles.highest.position > role.position;
}

/** Bot bisa melihat channel dan mengirim pesan (plus izin tambahan, mis. AttachFiles). */
async function botCanSendIn(channel, guild, extra = []) {
  if (typeof channel?.permissionsFor !== 'function') return false;
  const botMember = await fetchBotMember(guild);
  return Boolean(channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, ...extra]));
}

module.exports = { botCanManageRole, botCanSendIn, checkTargetHierarchy, fetchBotMember, hasGuildPermission, isGuildOwner };
