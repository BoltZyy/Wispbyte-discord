'use strict';

const {
  PermissionFlagsBits, SlashCommandBuilder,
} = require('discord.js');

/* =========================================================================
 * SLASH COMMANDS
 * ========================================================================= */
function buildCommandList() {
  return [
    new SlashCommandBuilder()
      .setName('echo')
      .setDescription('Send a clean standalone message to the channel')
      .addStringOption(o => o.setName('text').setDescription('Text to send').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setwelcome')
      .setDescription('Set the welcome channel and message template')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption(o => o.setName('channel').setDescription('Channel for welcome messages').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Template — use {mention}/{user}, {userId}, {username}, {server}').setRequired(false)),

    new SlashCommandBuilder()
      .setName('testwelcome')
      .setDescription('Preview the welcome message in the configured channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('create')
      .setDescription('Create a new auto-responder')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('trigger').setDescription('Trigger keyword').setRequired(true)),

    new SlashCommandBuilder()
      .setName('edit')
      .setDescription('Edit an existing auto-responder')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('trigger').setDescription('Trigger keyword to edit').setRequired(true)),

    new SlashCommandBuilder()
      .setName('list')
      .setDescription('List all registered auto-responder triggers')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('delete')
      .setDescription('Delete an auto-responder trigger')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('trigger').setDescription('Trigger keyword to delete').setRequired(true)),

    new SlashCommandBuilder()
      .setName('blockuser')
      .setDescription('Block a user from using AI features')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('User to block').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for blocking').setRequired(false)),

    new SlashCommandBuilder()
      .setName('unblockuser')
      .setDescription('Unblock a user from using AI features')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('User to unblock').setRequired(true)),

    // Catatan: TIDAK ada .setDefaultMemberPermissions di sini secara sengaja.
    // Discord permission flags cuma bisa membatasi berdasarkan role/permission
    // (mis. ManageGuild) — tidak bisa menyatakan "hanya 1 user ID spesifik".
    // Validasi OWNER_ID wajib dilakukan manual di dalam handler (lihat di bawah).
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('[Owner only] Kelola model AI yang aktif')
      .addSubcommand(sub => sub
        .setName('set')
        .setDescription('[Owner only] Set model AI utama (Attempt #1) — fallback chain tetap aktif')
        .addStringOption(o => o
          .setName('provider')
          .setDescription('Provider AI')
          .setRequired(true)
          .addChoices(
            { name: 'Gemini', value: 'gemini' },
            { name: 'Groq', value: 'groq' },
            { name: 'OpenRouter', value: 'openrouter' },
          ))
        .addStringOption(o => o
          .setName('model')
          .setDescription('Model spesifik dari provider yang dipilih')
          .setRequired(true)
          .setAutocomplete(true)))
      .addSubcommand(sub => sub
        .setName('status')
        .setDescription('[Owner only] Lihat model aktif & provider yang terkonfigurasi saat ini'))
      .addSubcommand(sub => sub
        .setName('reset')
        .setDescription('[Owner only] Hapus override manual, kembali ke urutan fallback otomatis')),

    // Catatan: "me" sengaja TIDAK pakai .setDefaultMemberPermissions atau
    // gate OWNER_ID — semua user boleh reset riwayat MEREKA SENDIRI. "channel"
    // dan "all" divalidasi manual di handler (owner-only), sama seperti /model,
    // karena bisa menghapus riwayat milik orang lain.
    new SlashCommandBuilder()
      .setName('resethistory')
      .setDescription('Reset riwayat percakapan AI')
      .addSubcommand(sub => sub
        .setName('me')
        .setDescription('Reset riwayat percakapan AI milik kamu sendiri di channel ini'))
      .addSubcommand(sub => sub
        .setName('channel')
        .setDescription('[Owner only] Reset riwayat semua user di channel ini'))
      .addSubcommand(sub => sub
        .setName('all')
        .setDescription('[Owner only] Reset SELURUH riwayat percakapan AI di semua channel')),
  ].map(c => c.toJSON());
}

module.exports = {
  buildCommandList,
};
