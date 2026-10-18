'use strict';


/**
 * PROVIDER_MODEL_TIERS — daftar model per provider, urutan = prioritas fallback
 * default (sebelum ada override manual dari /model).
 *
 * Terakhir diverifikasi 18 Oktober 2026. File ini adalah satu-satunya sumber
 * kebenaran untuk slug model — kalau ada yang deprecated lagi, edit array di
 * sini saja, tidak perlu menyentuh logic lain. Verifikasi berkala di:
 *   Groq       -> https://console.groq.com/docs/models  (+ /docs/deprecations)
 *   Gemini     -> https://ai.google.dev/gemini-api/docs/models  (+ /docs/deprecations)
 *   OpenRouter -> https://openrouter.ai/models?max_price=0
 *
 * "models"     = ikut fallback OTOMATIS, urutan = urutan coba.
 * "manualOnly" = HANYA bisa dipilih lewat /model set — TIDAK PERNAH ikut
 *                fallback otomatis (dan tidak mengganggu fallback provider lain).
 */
const PROVIDER_MODEL_TIERS = {
  gemini: {
    label: 'Gemini',
    // gemini-3.5-flash dan seluruh lini 2.x sengaja dibuang (deprecated).
    models: [
      { id: 'gemini-3.6-flash',      label: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
    ],
    manualOnly: [
      { id: 'gemini-3.8-flash',      label: 'Gemini 3.8 Flash — manual dulu: kelayakan API & rate limit akun belum diuji' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite — manual saja, dijadwalkan berhenti 7 Mei 2027 (pakai 3.5 Flash-Lite)' },
    ],
  },
  groq: {
    label: 'Groq',
    // llama-3.1-8b-instant (shutdown 16 Agu 2026) dan moonshotai/kimi-k2-instruct
    // (deprecated) sengaja dibuang.
    models: [
      { id: 'openai/gpt-oss-20b',  label: 'gpt-oss-20b' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      { id: 'qwen/qwen3.8-27b',    label: 'Qwen3.8 27B' },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    // Katalog ":free" OpenRouter berputar cepat — itulah kenapa hanya auto-router
    // openrouter/free yang dipakai. meta-llama/llama-3.3-70b-instruct:free dibuang:
    // API membalas HTTP 404 (versi gratis sudah tidak ada) pada 18 Okt 2026.
    // OpenRouter dipakai sebagai pilihan TERAKHIR (lihat LAST_RESORT_PROVIDER_TYPES).
    models: [
      { id: 'openrouter/free', label: 'Auto (openrouter/free) — pilihan terakhir, tahan rotasi' },
    ],
  },
};

// Gabungan "models" (auto-fallback) + "manualOnly" (cuma /model) — dipakai
// untuk autocomplete & validasi /model set, supaya keduanya sah dipilih
// manual walau cuma "models" yang ikut fallback otomatis.
function getAllTierModels(providerType) {
  const tier = PROVIDER_MODEL_TIERS[providerType];
  if (!tier) return [];
  return [...(tier.models || []), ...(tier.manualOnly || [])];
}

// true kalau tidak ada override, atau override menunjuk model yang masih ada di
// PROVIDER_MODEL_TIERS. Override lama yang modelnya sudah dibuang dari daftar
// diabaikan oleh buildProviderModelPlan — fungsi ini dipakai untuk memberi tahu.
function isKnownModelOverride(cfg) {
  if (!cfg?.activeProviderType) return true;
  return getAllTierModels(cfg.activeProviderType).some((m) => m.id === cfg.activeModelId);
}

module.exports = {
  PROVIDER_MODEL_TIERS,
  getAllTierModels,
  isKnownModelOverride,
};
