'use strict';

const {
  ActionRowBuilder, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { getAllTierModels, isKnownModelOverride } = require('../ai/models');
const { conversations } = require('../core/conversations');
const { OWNER_ID } = require('../core/owner');
const { formatWelcomeMessage } = require('../core/text');
const { blocklist, modelConfig, responders, saveBlocklist, saveModelConfig, saveResponders, saveWelcomeConfig, welcomeConfig } = require('../storage/state');

function registerInteractionHandler(client, providers, { moderation } = {}) {
  client.on('interactionCreate', async (interaction) => {
    try {
      // Command moderasi (src/discord/moderation.js) ditangani modul itu sendiri.
      if (moderation && await moderation.handle(interaction)) return;

      // ── Autocomplete untuk /model set model:<...> ──
      // Dihitung LIVE dari PROVIDER_MODEL_TIERS tiap request — tidak perlu
      // re-deploy slash command tiap kali daftar model diubah, penting karena
      // katalog OpenRouter terbukti berputar mingguan.
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'model' && interaction.options.getSubcommand() === 'set') {
          const focused = interaction.options.getFocused(true);
          if (focused.name === 'model') {
            const providerType = interaction.options.getString('provider');
            const allModels = getAllTierModels(providerType);
            const query = String(focused.value || '').toLowerCase();
            const results = allModels
              .filter((m) => m.id.toLowerCase().includes(query) || m.label.toLowerCase().includes(query))
              .slice(0, 25)
              .map((m) => ({ name: m.label.slice(0, 100), value: m.id }));
            await interaction.respond(results);
          } else {
            await interaction.respond([]);
          }
        }
        return;
      }

      if (interaction.isChatInputCommand()) {
        const cmd = interaction.commandName;

        if (cmd === 'model') {
          // ── Owner-only gate: validasi ID manual, bukan lewat Discord permission ──
          if (interaction.user.id !== OWNER_ID) {
            await interaction.reply({ content: '❌ Command ini khusus untuk owner bot.', flags: MessageFlags.Ephemeral });
            return;
          }

          const sub = interaction.options.getSubcommand();

          if (sub === 'status') {
            const current = modelConfig.activeProviderType
              ? `**${modelConfig.activeProviderType} / ${modelConfig.activeModelId}** (override manual, Attempt #1)${isKnownModelOverride(modelConfig) ? '' : '\n⚠️ Model ini tidak ada di daftar — override DIABAIKAN. Gunakan /model set atau /model reset.'}`
              : 'Otomatis (tanpa override — urutan fallback default)';
            const configuredProviders = providers.length > 0
              ? providers.map((p) => p.id).join(', ')
              : 'tidak ada provider terkonfigurasi';

            await interaction.reply({
              content: `📊 Model aktif: ${current}\n🔌 Provider terkonfigurasi: ${configuredProviders}`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (sub === 'reset') {
            modelConfig.activeProviderType = null;
            modelConfig.activeModelId = null;
            saveModelConfig();
            await interaction.reply({ content: '✅ Override dihapus — kembali ke urutan fallback otomatis.', flags: MessageFlags.Ephemeral });
            return;
          }

          if (sub === 'set') {
            const providerType = interaction.options.getString('provider');
            const modelId = interaction.options.getString('model');

            const providerConfigured = providers.some((p) => p.type === providerType);
            if (!providerConfigured) {
              await interaction.reply({
                content: `❌ Provider **${providerType}** belum terkonfigurasi (API key tidak ditemukan di Environment Variables).`,
                flags: MessageFlags.Ephemeral,
              });
              return;
            }

            const validModel = getAllTierModels(providerType).some((m) => m.id === modelId);
            if (!validModel) {
              await interaction.reply({
                content: `❌ Model \`${modelId}\` tidak ada di daftar untuk provider **${providerType}**. Gunakan autocomplete supaya tidak salah ketik.`,
                flags: MessageFlags.Ephemeral,
              });
              return;
            }

            modelConfig.activeProviderType = providerType;
            modelConfig.activeModelId = modelId;
            saveModelConfig();

            await interaction.reply({
              content: `✅ Model aktif diset ke **${providerType} / ${modelId}** sebagai Attempt #1.\nFallback chain tetap aktif — kalau model ini gagal/deprecated, bot otomatis lanjut ke model/provider lain.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }

        if (cmd === 'resethistory') {
          const sub = interaction.options.getSubcommand();

          if (sub === 'me') {
            // Semua user boleh — cuma hapus riwayat MILIK SENDIRI, tidak
            // menyentuh riwayat user lain (key channelId:userId lain tetap utuh).
            conversations.clear(interaction.channelId, interaction.user.id);
            await interaction.reply({
              content: '✅ Riwayat percakapan AI kamu di channel ini sudah direset.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // "channel" dan "all" wajib owner — bisa menghapus riwayat orang lain.
          if (interaction.user.id !== OWNER_ID) {
            await interaction.reply({ content: '❌ Subcommand ini khusus untuk owner bot.', flags: MessageFlags.Ephemeral });
            return;
          }

          if (sub === 'channel') {
            const removed = conversations.clearChannel(interaction.channelId);
            await interaction.reply({
              content: `✅ Riwayat ${removed} user di channel ini sudah direset.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (sub === 'all') {
            const removed = conversations.resetAll();
            await interaction.reply({
              content: `✅ SELURUH riwayat percakapan AI direset (${removed} entri di semua channel/user).`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }

        if (cmd === 'echo') {
          const text = interaction.options.getString('text');
          await interaction.channel.send(text);
          await interaction.reply({ content: 'Message sent!', flags: MessageFlags.Ephemeral });
          return;
        }

        if (cmd === 'setwelcome') {
          const channel = interaction.options.getChannel('channel');
          const message = interaction.options.getString('message');

          welcomeConfig.welcome.channelId = channel.id;
          if (message) welcomeConfig.welcome.message = message;
          saveWelcomeConfig();

          await interaction.reply({
            content: `✅ Welcome channel set to <#${channel.id}>.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (cmd === 'testwelcome') {
          // Simulasi memakai member yang menjalankan command — tidak ada fetch,
          // tidak ada penulisan ke cache; interaction.member sudah tersedia
          // langsung dari payload interaksi (GuildMemberManager tetap 0).
          if (!interaction.inGuild() || !interaction.member) {
            await interaction.reply({ content: '❌ Command ini hanya bisa dipakai di dalam server.', flags: MessageFlags.Ephemeral });
            return;
          }

          const cfg = welcomeConfig.welcome;
          if (!cfg.channelId) {
            await interaction.reply({ content: '❌ No welcome channel set yet.', flags: MessageFlags.Ephemeral });
            return;
          }
          const channel = interaction.guild.channels.cache.get(cfg.channelId);
          if (!channel) {
            await interaction.reply({ content: '❌ Configured channel not found.', flags: MessageFlags.Ephemeral });
            return;
          }
          const msg = formatWelcomeMessage(cfg.message, interaction.member);
          await channel.send(msg);
          await interaction.reply({ content: `✅ Test welcome sent to <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
          return;
        }

        if (cmd === 'create') {
          const trigger = interaction.options.getString('trigger').trim().toLowerCase();
          if (responders[trigger] !== undefined) {
            await interaction.reply({ content: `⚠️ Trigger \`${trigger}\` already exists.`, flags: MessageFlags.Ephemeral });
            return;
          }

          const modal = new ModalBuilder()
            .setCustomId(`create:${trigger}`)
            .setTitle('Create Custom Responder');

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('response')
                .setLabel('Response Content')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
            )
          );

          await interaction.showModal(modal);
          return;
        }

        if (cmd === 'edit') {
          const trigger = interaction.options.getString('trigger').trim().toLowerCase();
          if (responders[trigger] === undefined) {
            await interaction.reply({ content: `❌ Trigger \`${trigger}\` does not exist.`, flags: MessageFlags.Ephemeral });
            return;
          }

          const modal = new ModalBuilder()
            .setCustomId(`edit:${trigger}`)
            .setTitle('Edit Custom Responder');

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('response')
                .setLabel('Response Content')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(responders[trigger])
                .setRequired(true)
            )
          );

          await interaction.showModal(modal);
          return;
        }

        if (cmd === 'list') {
          const triggers = Object.keys(responders);
          if (triggers.length === 0) {
            await interaction.reply({ content: '📜 No custom responders configured.', flags: MessageFlags.Ephemeral });
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle('Custom Auto-Responders')
            .setColor(0x5865F2)
            .setDescription(triggers.map(t => `• \`Ovelia ${t}\``).join('\n'));

          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          return;
        }

        if (cmd === 'delete') {
          const trigger = interaction.options.getString('trigger').trim().toLowerCase();
          if (responders[trigger] === undefined) {
            await interaction.reply({ content: `❌ Trigger \`${trigger}\` does not exist.`, flags: MessageFlags.Ephemeral });
            return;
          }

          delete responders[trigger];
          saveResponders();
          await interaction.reply({ content: `✅ Removed auto-responder for \`${trigger}\`.`, flags: MessageFlags.Ephemeral });
          return;
        }

        if (cmd === 'blockuser') {
          const targetUser = interaction.options.getUser('user');
          const reason = interaction.options.getString('reason') || 'No reason provided';

          blocklist[targetUser.id] = { blockedAt: new Date().toISOString(), reason };
          saveBlocklist();

          await interaction.reply({ content: `🚫 User <@${targetUser.id}> blocked. Reason: ${reason}`, flags: MessageFlags.Ephemeral });
          return;
        }

        if (cmd === 'unblockuser') {
          const targetUser = interaction.options.getUser('user');
          if (!blocklist[targetUser.id]) {
            // FIX: sebelumnya body if ini kosong sehingga request tetap lanjut
            // ke reply "berhasil di-unblock" walau user memang belum diblokir.
            await interaction.reply({ content: `⚠️ User <@${targetUser.id}> is not blocked.`, flags: MessageFlags.Ephemeral });
            return;
          }

          delete blocklist[targetUser.id];
          saveBlocklist();

          await interaction.reply({ content: `✅ User <@${targetUser.id}> unblocked.`, flags: MessageFlags.Ephemeral });
          return;
        }
      }

      if (interaction.isModalSubmit()) {
        const [action, trigger] = interaction.customId.split(':');
        const responseContent = interaction.fields.getTextInputValue('response');

        if (action === 'create' || action === 'edit') {
          responders[trigger] = responseContent;
          saveResponders();

          await interaction.reply({
            content: `✅ Custom responder for \`${trigger}\` has been ${action === 'create' ? 'created' : 'updated'}!`,
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    } catch (err) {
      console.error('[Interaction Error]', err);
      // Autocomplete tidak mendukung .reply() — cuma .respond(). Kalau error
      // terjadi di jalur autocomplete, cukup log saja, jangan coba reply.
      if (!interaction.isAutocomplete() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred processing this interaction.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
}

module.exports = {
  registerInteractionHandler,
};
