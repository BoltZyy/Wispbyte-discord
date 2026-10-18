'use strict';

const {
  Client, Events, GatewayIntentBits, Options, Partials, REST, Routes,
} = require('discord.js');
const { isKnownModelOverride } = require('./ai/models');
const { buildProviderRegistry } = require('./ai/providers');
const { validateEnv } = require('./config/env');
const { formatWelcomeMessage } = require('./core/text');
const { buildCommandList } = require('./discord/commands');
const { registerInteractionHandler } = require('./discord/interactions');
const { registerMessageHandler } = require('./discord/messages');
const { startActivityRotation } = require('./discord/presence');
const { modelConfig, welcomeConfig } = require('./storage/state');

/* =========================================================================
 * MAIN INITIALIZATION & STARTUP
 *
 * OPTIMASI RAM utama ada di sini:
 * - makeCache: GuildMemberManager/MessageManager/PresenceManager di-nol-kan.
 *   Intent GuildMembers TETAP ada sehingga event guildMemberAdd tetap jalan;
 *   yang dimatikan hanya cache-nya (yang tadinya menyimpan seluruh member
 *   dari seluruh guild ke memori tanpa perlu).
 * - Tidak ada express / server HTTP — bot ini proses long-lived (bukan
 *   serverless) dan tidak butuh port terbuka. Kalau kamu memang butuh endpoint uptime
 *   monitor eksternal, beri tahu saya, saya tambahkan native http (~10 baris,
 *   jauh lebih ringan dari express).
 * ========================================================================= */
async function main() {
  validateEnv();

  const token = process.env.DISCORD_TOKEN || process.env.Discord_token;

  let providers = [];
  try {
    providers = buildProviderRegistry(process.env);
    console.log(`✅ ${providers.length} AI provider(s) active: ${providers.map((p) => p.id).join(', ')}`);
  } catch (err) {
    console.warn(`⚠️  No AI providers configured — AI replies disabled. (${err.message})`);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,   // tetap ada — dibutuhkan untuk guildMemberAdd
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    makeCache: Options.cacheWithLimits({
      GuildMemberManager: 0,   // jangan cache member sama sekali
      MessageManager: 0,       // jangan cache pesan
      PresenceManager: 0,      // jangan cache presence
      UserManager: 50,         // batasi cache user ke 50 entri terbaru
      ReactionManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      users: { interval: 3600, filter: () => () => true },
    },
  });

  if (!isKnownModelOverride(modelConfig)) {
    console.warn(`[Model] model_config.json menunjuk ke "${modelConfig.activeProviderType}/${modelConfig.activeModelId}" yang tidak ada di PROVIDER_MODEL_TIERS — override diabaikan. Jalankan /model set atau /model reset.`);
  }

  registerInteractionHandler(client, providers);
  registerMessageHandler(client, providers, {
    prefix:       process.env.COMMAND_PREFIX || '!tanya',
    systemPrompt: process.env.SYSTEM_PROMPT  || process.env.Personality,
  });

  client.once(Events.ClientReady, async () => {
    console.log(`🤖 Logged in as ${client.user.tag}!`);
    startActivityRotation(client, welcomeConfig.activity);

    const rest = new REST({ version: '10' }).setToken(token);
    try {
      console.log('Refreshing application (/) commands...');
      await rest.put(Routes.applicationCommands(client.user.id), { body: buildCommandList() });
      console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
      console.error('Failed to register slash commands:', error);
    }
  });

  client.on('guildMemberAdd', async (member) => {
    try {
      const cfg = welcomeConfig.welcome;
      if (!cfg.channelId) return;
      const channel = member.guild.channels.cache.get(cfg.channelId);
      if (!channel) return;
      await channel.send(formatWelcomeMessage(cfg.message, member));
    } catch (err) {
      console.error('[Welcome] Error:', err);
    }
  });

  client.on('error', (err) => console.error('[Discord Client Error]', err));
  process.on('unhandledRejection', (err) => console.error('[Unhandled Rejection]', err));

  await client.login(token);
}

module.exports = {
  main,
};
