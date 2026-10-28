'use strict';

const { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { MAX_PHRASE_LENGTH, compileMatcher, validatePhrase } = require('../core/wordMatch');
const { hasGuildPermission } = require('./permissions');

/**
 * Kata terlarang (tahap 4): pengelolaan aturan + mesin evaluasi.
 * BELUM menghapus pesan atau memicu challenge — itu tahap 5. Untuk saat ini aturan dapat dibuat,
 * diubah, diberi pengecualian, dan diuji lewat /banned-word test.
 * Aturan aktif di-cache di memori per server dan di-invalidasi pada setiap perubahan (satu proses).
 */

const NO_MENTIONS = { parse: [] };
const MSG_NO_PERM = '❌ Anda tidak punya izin untuk command ini.';
const MAX_NAME = 40;
const MAX_REASON = 200;
const MAX_EXEMPT = 20;
const MODE_CHOICES = [{ name: 'exact (frasa utuh)', value: 'exact' }, { name: 'evasion (tahan variasi penulisan)', value: 'evasion' }];

function buildBannedWordCommandList() {
  const ruleId = (o) => o.setName('id').setDescription('Rule ID').setRequired(true).setMinValue(1);
  return [
    new SlashCommandBuilder().setName('banned-word').setDescription('Manage banned word / phrase rules')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('add').setDescription('Create a rule')
        .addStringOption((o) => o.setName('name').setDescription('Rule name').setRequired(true).setMaxLength(MAX_NAME))
        .addStringOption((o) => o.setName('phrase').setDescription('Word or phrase to match').setRequired(true).setMaxLength(MAX_PHRASE_LENGTH))
        .addStringOption((o) => o.setName('reason').setDescription('Reason shown to staff (generic, not the pattern)').setRequired(true).setMaxLength(MAX_REASON))
        .addStringOption((o) => o.setName('mode').setDescription('Matching mode (default: exact)').addChoices(...MODE_CHOICES))
        .addBooleanOption((o) => o.setName('allow-pass').setDescription('Offer a human-verification challenge and pass (default: no)'))
        .addIntegerOption((o) => o.setName('pass-days').setDescription('How long a pass lasts, in days (default 30)').setMinValue(1).setMaxValue(365)))
      .addSubcommand((s) => s.setName('edit').setDescription('Edit a rule')
        .addIntegerOption(ruleId)
        .addStringOption((o) => o.setName('name').setDescription('New name').setMaxLength(MAX_NAME))
        .addStringOption((o) => o.setName('phrase').setDescription('New phrase').setMaxLength(MAX_PHRASE_LENGTH))
        .addStringOption((o) => o.setName('reason').setDescription('New reason').setMaxLength(MAX_REASON))
        .addStringOption((o) => o.setName('mode').setDescription('New matching mode').addChoices(...MODE_CHOICES))
        .addBooleanOption((o) => o.setName('enabled').setDescription('Enable or disable the rule'))
        .addBooleanOption((o) => o.setName('allow-pass').setDescription('Offer challenge and pass'))
        .addIntegerOption((o) => o.setName('pass-days').setDescription('Pass duration in days').setMinValue(1).setMaxValue(365)))
      .addSubcommand((s) => s.setName('remove').setDescription('Delete a rule').addIntegerOption(ruleId))
      .addSubcommand((s) => s.setName('list').setDescription('List rules'))
      .addSubcommand((s) => s.setName('test').setDescription('Test a sample message against the rules (nothing is deleted)')
        .addStringOption((o) => o.setName('text').setDescription('Sample message').setRequired(true).setMaxLength(500))
        .addIntegerOption((o) => o.setName('id').setDescription('Only test this rule').setMinValue(1)))
      .addSubcommand((s) => s.setName('exempt-role').setDescription('Exempt a role from a rule')
        .addIntegerOption(ruleId)
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addBooleanOption((o) => o.setName('remove').setDescription('Remove the exemption instead')))
      .addSubcommand((s) => s.setName('exempt-channel').setDescription('Exempt a channel from a rule')
        .addIntegerOption(ruleId)
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addBooleanOption((o) => o.setName('remove').setDescription('Remove the exemption instead'))),
  ].map((c) => c.toJSON());
}

function createBannedWords({ storage, log = console, maxRulesPerGuild = 100 } = {}) {
  const reply = (i, content) => (i.replied || i.deferred
    ? i.editReply({ content, allowedMentions: NO_MENTIONS })
    : i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS }));

  /* ---------------- mesin evaluasi (dipakai tahap 5) ---------------- */
  const cache = new Map(); // guildId -> aturan aktif yang sudah dikompilasi
  const invalidate = (guildId) => cache.delete(guildId);

  const compile = (rule) => {
    const matches = compileMatcher({ mode: rule.mode, phrase: rule.phrase });
    const roles = new Set(rule.exemptRoles); const channels = new Set(rule.exemptChannels);
    return {
      id: rule.id, name: rule.name, mode: rule.mode, reason: rule.reason, allowPass: rule.allowPass, passDays: rule.passDays,
      matches,
      exempt: (roleIds, channelId) => channels.has(String(channelId)) || [...roleIds].some((r) => roles.has(String(r))),
    };
  };
  function activeRules(guildId) {
    if (!storage) return [];
    let list = cache.get(guildId);
    if (!list) {
      list = [];
      for (const r of storage.rules.list({ guildId, enabledOnly: true })) {
        try { list.push(compile(r)); } catch (err) { log.error(`[BannedWords] Aturan #${r.id} tidak valid, dilewati: ${err.message}`); }
      }
      cache.set(guildId, list);
    }
    return list;
  }
  /** Aturan aktif yang cocok dengan teks dan TIDAK dikecualikan untuk role/channel ini. */
  function evaluate(guildId, text, { roleIds = [], channelId } = {}) {
    return activeRules(guildId).filter((r) => !r.exempt(roleIds, channelId) && r.matches(text));
  }

  /* ---------------- perintah staf ---------------- */
  const describe = (r) => `#${r.id} **${r.name}** • ${r.mode} • ${r.enabled ? 'aktif' : 'NONAKTIF'} • pass: ${r.allowPass ? `${r.passDays} hari` : 'tidak'}`
    + `${r.exemptRoles.length || r.exemptChannels.length ? ` • pengecualian: ${r.exemptRoles.length} role, ${r.exemptChannels.length} channel` : ''}\n  ↳ \`${r.phrase.replace(/`/g, "'")}\``;

  async function handleAdd(i) {
    const guildId = i.guild.id;
    const mode = i.options.getString('mode') ?? 'exact';
    const phrase = i.options.getString('phrase', true);
    const check = validatePhrase(phrase, mode);
    if (!check.ok) return reply(i, `❌ ${check.error}`);
    const name = i.options.getString('name', true).trim(); const reason = i.options.getString('reason', true).trim();
    if (!name || !reason) return reply(i, '❌ Nama dan alasan tidak boleh kosong.');
    if (storage.rules.count(guildId) >= maxRulesPerGuild) return reply(i, `❌ Batas ${maxRulesPerGuild} aturan per server tercapai.`);
    const rule = storage.db.transaction(() => {
      const created = storage.rules.add({
        guildId, name, phrase: check.phrase, mode, reason, createdBy: i.user.id,
        allowPass: i.options.getBoolean('allow-pass') ?? false, passDays: i.options.getInteger('pass-days') ?? 30,
      });
      storage.audit.log({ guildId, action: 'banned_word_add', actorId: i.user.id, reason, details: { ruleId: created.id, name, mode } });
      return created;
    });
    invalidate(guildId);
    return reply(i, `✅ Aturan dibuat:\n${describe(rule)}\nCoba dulu dengan \`/banned-word test\` sebelum mengandalkannya.`);
  }

  async function handleEdit(i) {
    const guildId = i.guild.id; const id = i.options.getInteger('id', true);
    const rule = storage.rules.get(guildId, id);
    if (!rule) return reply(i, `❌ Aturan #${id} tidak ditemukan.`);
    const changes = {};
    const str = (opt, key) => { const v = i.options.getString(opt); if (v !== null && v !== undefined) changes[key] = v.trim(); };
    str('name', 'name'); str('phrase', 'phrase'); str('reason', 'reason'); str('mode', 'mode');
    const bool = (opt, key) => { const v = i.options.getBoolean(opt); if (v !== null && v !== undefined) changes[key] = v; };
    bool('enabled', 'enabled'); bool('allow-pass', 'allowPass');
    const days = i.options.getInteger('pass-days'); if (days !== null && days !== undefined) changes.passDays = days;
    if (!Object.keys(changes).length) return reply(i, '❌ Tidak ada yang diubah. Isi minimal satu opsi.');
    if (changes.name === '' || changes.reason === '') return reply(i, '❌ Nama dan alasan tidak boleh kosong.');
    const check = validatePhrase(changes.phrase ?? rule.phrase, changes.mode ?? rule.mode);
    if (!check.ok) return reply(i, `❌ ${check.error}`);
    const updated = storage.db.transaction(() => {
      const u = storage.rules.update(guildId, id, changes);
      storage.audit.log({ guildId, action: 'banned_word_edit', actorId: i.user.id, details: { ruleId: id, fields: Object.keys(changes) } });
      return u;
    });
    invalidate(guildId);
    return reply(i, `✅ Aturan diperbarui:\n${describe(updated)}`);
  }

  async function handleRemove(i) {
    const guildId = i.guild.id; const id = i.options.getInteger('id', true);
    const rule = storage.rules.get(guildId, id);
    if (!rule) return reply(i, `❌ Aturan #${id} tidak ditemukan.`);
    storage.db.transaction(() => {
      storage.rules.remove(guildId, id);
      storage.audit.log({ guildId, action: 'banned_word_remove', actorId: i.user.id, details: { ruleId: id, name: rule.name } });
    });
    invalidate(guildId);
    return reply(i, `✅ Aturan #${id} (${rule.name}) dihapus.`);
  }

  async function handleList(i) {
    const rules = storage.rules.list({ guildId: i.guild.id });
    if (!rules.length) return reply(i, 'ℹ️ Belum ada aturan. Buat dengan `/banned-word add`.');
    let content = `📋 **Aturan kata terlarang** (${rules.length})\n${rules.map(describe).join('\n')}`;
    if (content.length > 1900) content = `${content.slice(0, 1890)}…`;
    return reply(i, content);
  }

  async function handleTest(i) {
    const guildId = i.guild.id; const text = i.options.getString('text', true); const id = i.options.getInteger('id');
    const rules = storage.rules.list({ guildId }).filter((r) => id === null || id === undefined || r.id === id);
    if (!rules.length) return reply(i, id ? `❌ Aturan #${id} tidak ditemukan.` : 'ℹ️ Belum ada aturan.');
    const lines = rules.map((r) => {
      let verdict;
      try { verdict = compileMatcher({ mode: r.mode, phrase: r.phrase })(text) ? '🔴 COCOK' : '🟢 tidak cocok'; } catch (err) { verdict = `⚠️ aturan tidak valid (${err.message})`; }
      return `#${r.id} ${r.name} (${r.mode}${r.enabled ? '' : ', NONAKTIF'}): ${verdict}`;
    });
    return reply(i, `🧪 **Hasil uji** — tidak ada pesan yang dihapus; pengecualian role/channel tidak diperiksa.\n${lines.join('\n')}`.slice(0, 1990));
  }

  async function handleExempt(i, kind) {
    const guildId = i.guild.id; const id = i.options.getInteger('id', true);
    const target = kind === 'role' ? i.options.getRole('role', true) : i.options.getChannel('channel', true);
    const remove = i.options.getBoolean('remove') ?? false;
    const rule = storage.rules.get(guildId, id);
    if (!rule) return reply(i, `❌ Aturan #${id} tidak ditemukan.`);
    if (kind === 'channel' && target.guildId !== guildId) return reply(i, '❌ Pilih channel di server ini.');
    if (!remove && (kind === 'role' ? rule.exemptRoles : rule.exemptChannels).length >= MAX_EXEMPT && !(kind === 'role' ? rule.exemptRoles : rule.exemptChannels).includes(target.id)) {
      return reply(i, `❌ Maksimal ${MAX_EXEMPT} pengecualian ${kind} per aturan.`);
    }
    storage.db.transaction(() => {
      storage.rules.setExempt(guildId, id, kind, target.id, !remove);
      storage.audit.log({ guildId, action: 'banned_word_exempt', actorId: i.user.id, details: { ruleId: id, kind, targetId: target.id, removed: remove } });
    });
    invalidate(guildId);
    const mention = kind === 'role' ? `<@&${target.id}>` : `<#${target.id}>`;
    return reply(i, remove ? `✅ Pengecualian ${mention} dicabut dari aturan #${id}.` : `✅ ${mention} dikecualikan dari aturan #${id}.`);
  }

  async function handle(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'banned-word') return false;
    try {
      if (!interaction.inGuild()) { await reply(interaction, '❌ Command ini hanya bisa dipakai di server.'); return true; }
      if (!hasGuildPermission(interaction, PermissionFlagsBits.ManageGuild)) { await reply(interaction, MSG_NO_PERM); return true; }
      if (!storage) { await reply(interaction, '⚠️ Fitur kata terlarang nonaktif: database tidak tersedia. Cek log bot.'); return true; }
      const sub = interaction.options.getSubcommand();
      const handlers = {
        add: handleAdd, edit: handleEdit, remove: handleRemove, list: handleList, test: handleTest,
        'exempt-role': (i) => handleExempt(i, 'role'), 'exempt-channel': (i) => handleExempt(i, 'channel'),
      };
      await handlers[sub](interaction);
    } catch (err) {
      log.error(`[BannedWords] /banned-word gagal: ${err.stack || err.message}`);
      await reply(interaction, '❌ Terjadi kesalahan. Perubahan TIDAK tersimpan — cek log bot.').catch(() => {});
    }
    return true;
  }

  return { handle, evaluate, invalidate };
}

module.exports = { buildBannedWordCommandList, createBannedWords };
