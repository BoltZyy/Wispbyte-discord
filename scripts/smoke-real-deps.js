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
const { buildModerationCommandList } = require('../src/discord/moderation');
const { buildVerificationCommandList } = require('../src/discord/verification');
const { buildBannedWordCommandList } = require('../src/discord/bannedWords');

const providers = bot.buildProviderRegistry({ GEMINI_KEY_1: 'x', GEMINI_KEY_2: 'x', GROQ_KEY: 'x', OPENROUTER_KEY: 'x' });
assert.deepEqual(providers.map((p) => p.id), ['gemini-1', 'gemini-2', 'groq-1', 'openrouter-1']);
for (const p of providers) assert.equal(typeof p.generateReply, 'function', `${p.id} tanpa generateReply`);

assert.equal(typeof Events.ClientReady, 'string');

const commands = buildCommandList(); // sudah berupa JSON; validasi SlashCommandBuilder asli terjadi di dalam fungsi ini
assert.equal(commands.length, 11);
const modCommands = buildModerationCommandList(); // validasi SlashCommandBuilder asli untuk command moderasi
assert.deepEqual(modCommands.map((c) => c.name), ['warn', 'warnings', 'warning-remove', 'modconfig', 'backup']);
for (const c of modCommands) assert.ok(c.description, `command ${c.name} tanpa deskripsi`);
const verifyCommands = buildVerificationCommandList(); // validasi builder asli: subcommand, opsi role/channel
assert.deepEqual(verifyCommands.map((c) => c.name), ['verification']);
assert.deepEqual(verifyCommands[0].options.map((o) => o.name), ['setup', 'question', 'panel', 'status']);
const bwCommands = buildBannedWordCommandList(); // validasi builder asli: pilihan mode, tipe channel, subcommand
assert.deepEqual(bwCommands.map((c) => c.name), ['banned-word']);
assert.deepEqual(bwCommands[0].options.map((o) => o.name), ['add', 'edit', 'remove', 'list', 'test', 'exempt-role', 'exempt-channel']);
for (const c of commands) assert.ok(c.name && c.description, `command tanpa nama/deskripsi: ${JSON.stringify(c).slice(0, 80)}`);

// Database SQLite (node:sqlite bawaan Node) di folder sementara: buka, tulis, baca, tutup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initStorage } = require('../src/storage');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovelia-smoke-'));
const errors = [];
const storage = initStorage({ dbPath: path.join(dir, 'smoke.sqlite'), log: { log() {}, error: (m) => errors.push(m) } });
assert.ok(storage, `database gagal dibuka: ${errors.join(' | ')}`);
storage.settings.set('G', 'k', 1);
assert.equal(storage.settings.get('G', 'k'), 1);
storage.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`OK — ${providers.length} provider, ${commands.length} + ${modCommands.length} + ${verifyCommands.length} + ${bwCommands.length} slash command, event ready = "${Events.ClientReady}", SQLite OK`);
