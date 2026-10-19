'use strict';
/**
 * Smoke test dengan paket ASLI (discord.js, @google/genai, groq-sdk, openai).
 * Tanpa login Discord dan tanpa request jaringan. Jalankan setelah `npm install`:
 *   npm run smoke
 * Yang diperiksa: modul bot bisa dimuat dengan paket asli, client SDK asli bisa
 * dibuat, dan 11 slash command lolos validasi SlashCommandBuilder asli.
 */
process.env.BOT_NO_AUTOSTART = '1';
const assert = require('node:assert/strict');

const bot = require('../index.js');
const { Events } = require('discord.js');
const { buildCommandList } = require('../src/discord/commands');

const providers = bot.buildProviderRegistry({ GEMINI_KEY_1: 'x', GEMINI_KEY_2: 'x', GROQ_KEY: 'x', OPENROUTER_KEY: 'x' });
assert.deepEqual(providers.map((p) => p.id), ['gemini-1', 'gemini-2', 'groq-1', 'openrouter-1']);
for (const p of providers) assert.equal(typeof p.generateReply, 'function', `${p.id} tanpa generateReply`);

assert.equal(typeof Events.ClientReady, 'string');

const commands = buildCommandList(); // sudah berupa JSON; validasi SlashCommandBuilder asli terjadi di dalam fungsi ini
assert.equal(commands.length, 11);
for (const c of commands) assert.ok(c.name && c.description, `command tanpa nama/deskripsi: ${JSON.stringify(c).slice(0, 80)}`);

console.log(`OK — ${providers.length} provider, ${commands.length} slash command, event ready = "${Events.ClientReady}"`);
