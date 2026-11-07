'use strict';
/**
 * Dipakai test/smoke-stub.test.js: menjalankan scripts/smoke-real-deps.js TANPA paket asli, memakai stub
 * yang menghasilkan bentuk JSON seperti discord.js (name, description, options bersarang). Tujuannya
 * menangkap asersi smoke yang usang (mis. daftar subcommand) saat `npm test`, bukan baru di CI.
 * BUKAN pengganti smoke dengan paket asli (`npm run smoke`).
 */
const Module = require('node:module');

const orig = Module._load;
function builder() {
  const json = { options: [] };
  const p = new Proxy({}, {
    get(_t, k) {
      if (k === 'toJSON') return () => json;
      if (k === 'json') return json;
      const name = String(k);
      if (name === 'addSubcommand') return (fn) => { const b = builder(); fn(b); json.options.push({ type: 1, ...b.json }); return p; };
      let m = /^add(\w+)Option$/.exec(name);
      if (m) return (fn) => { const b = builder(); fn(b); json.options.push({ ...b.json }); return p; };
      m = /^set(.)(.*)$/.exec(name);
      if (m) return (v) => { json[m[1].toLowerCase() + m[2]] = v; return p; };
      return () => p;
    },
  });
  return p;
}
const Built = class { constructor() { return builder(); } };
const sdk = class { constructor() { this.chat = { completions: { create() {} } }; this.models = {}; } };
const stubs = {
  dotenv: { config() {} }, 'groq-sdk': sdk, openai: sdk, '@google/genai': { GoogleGenAI: sdk },
  'discord.js': {
    Events: { ClientReady: 'clientReady' }, SlashCommandBuilder: Built, ModalBuilder: Built, TextInputBuilder: Built, ActionRowBuilder: Built, ButtonBuilder: Built, EmbedBuilder: Built,
    TextInputStyle: { Short: 1, Paragraph: 2 }, ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0, GuildCategory: 4, GuildAnnouncement: 5 }, MessageFlags: { Ephemeral: 64 },
    PermissionFlagsBits: new Proxy({}, { get: (_t, k) => String(String(k).length) }), // discord.js asli mengubahnya menjadi string
    ActivityType: {}, Client: class {}, GatewayIntentBits: {}, Partials: {}, Options: {}, REST: class {}, Routes: {},
  },
};
Module._load = function (request, ...rest) { return request in stubs ? stubs[request] : orig.call(this, request, ...rest); };
