'use strict';

/**
 * Entry point. Struktur proyek:
 *   src/config/    validasi env
 *   src/core/      owner, rate limit, riwayat percakapan, util teks   (tanpa dependensi ke lapisan lain)
 *   src/storage/   jalur & state file JSON (config, responders, blocklist, model_config)
 *   src/ai/        daftar model, provider, router fallback, persona
 *   src/discord/   slash command, interaction, message handler, presence
 *   src/main.js    merangkai semuanya dan login
 *
 * File data JSON tetap berada di folder ini (root proyek), bukan di src/.
 */

// dotenv HARUS dimuat sebelum modul src/ apa pun di-require: beberapa modul
// membaca process.env saat dimuat (OWNER_ID, MAX_HISTORY, AI_*_TIMEOUT_MS).
require('dotenv').config();

const { main } = require('./src/main');
const { PROVIDER_MODEL_TIERS, isKnownModelOverride } = require('./src/ai/models');
const {
  createGeminiProvider, createGroqProvider, createOpenRouterProvider, buildProviderRegistry,
} = require('./src/ai/providers');
const { buildProviderModelPlan, generateWithFallback } = require('./src/ai/router');

// BOT_NO_AUTOSTART=1 dipakai test supaya file ini bisa di-require tanpa login.
if (!process.env.BOT_NO_AUTOSTART) {
  main().catch((err) => {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
  });
}

module.exports = {
  PROVIDER_MODEL_TIERS, buildProviderModelPlan, generateWithFallback,
  createGeminiProvider, createGroqProvider, createOpenRouterProvider,
  buildProviderRegistry, isKnownModelOverride, main,
};
