'use strict';

const { PROVIDER_MODEL_TIERS } = require('./models');

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * buildProviderModelPlan — susun urutan percobaan (provider, model) flat.
 *
 * Kalau ada override manual dari /model (activeSelection):
 *   1. Provider yang dipilih owner dipindah ke urutan PALING DEPAN.
 *   2. Model yang dipilih owner dipindah ke urutan PALING DEPAN di provider itu.
 *   -> Kombinasi ini = Attempt #1 sesuai requirement "owner pick jadi attempt
 *      pertama", TANPA mematikan sisa fallback chain (model lain di provider
 *      yang sama, lalu provider lain, tetap dicoba kalau Attempt #1 gagal).
 *
 * Kalau tidak ada override (activeSelection null): provider SELAIN OpenRouter
 * di-shuffle untuk load balancing antar API key (mis. gemini-1, gemini-2, groq-1
 * — kalau satu gagal, sisanya tetap dicoba dalam urutan acak). OpenRouter selalu
 * di belakang. Tiap provider mencoba model-nya sesuai urutan di
 * PROVIDER_MODEL_TIERS.
 */
// Provider yang selalu dicoba paling akhir (di belakang provider lain), kecuali
// dipilih eksplisit lewat /model set.
const LAST_RESORT_PROVIDER_TYPES = new Set(['openrouter']);

function buildProviderModelPlan(providers, activeSelection) {
  const plan = [];
  const orderedProviders = [
    ...shuffle(providers.filter((p) => !LAST_RESORT_PROVIDER_TYPES.has(p.type))),
    ...providers.filter((p) => LAST_RESORT_PROVIDER_TYPES.has(p.type)),
  ];

  if (activeSelection?.activeProviderType) {
    const idx = orderedProviders.findIndex((p) => p.type === activeSelection.activeProviderType);
    if (idx > 0) {
      const [picked] = orderedProviders.splice(idx, 1);
      orderedProviders.unshift(picked);
    }
  }

  for (const provider of orderedProviders) {
    const tier = PROVIDER_MODEL_TIERS[provider.type] || {};
    const autoModels = (tier.models || []).map((m) => m.id);
    let modelOrder = autoModels;

    if (activeSelection?.activeProviderType === provider.type && activeSelection.activeModelId) {
      // Model yang dipilih boleh berasal dari "models" (auto) ATAU "manualOnly"
      // — keduanya sah dipilih manual. Kalau dari manualOnly, dia HANYA jadi
      // Attempt #1 di sini (di-prepend), TIDAK ikut masuk ke autoModels untuk
      // percobaan berikutnya — jadi model boros-token tetap tidak pernah
      // otomatis dicoba berulang di luar pilihan eksplisit owner.
      const manualModelIds = (tier.manualOnly || []).map((m) => m.id);
      const isKnownModel = autoModels.includes(activeSelection.activeModelId) || manualModelIds.includes(activeSelection.activeModelId);

      if (isKnownModel) {
        modelOrder = [
          activeSelection.activeModelId,
          ...autoModels.filter((m) => m !== activeSelection.activeModelId),
        ];
      }
    }

    for (const modelId of modelOrder) plan.push({ provider, modelId });
  }

  return plan;
}

// Batas waktu fallback (ms), bisa di-override lewat env.
//  - AI_ATTEMPT_TIMEOUT_MS : batas satu percobaan (provider/model)
//  - AI_TOTAL_TIMEOUT_MS   : batas total seluruh rantai fallback per pesan
const AI_ATTEMPT_TIMEOUT_MS = Math.max(1000, Number(process.env.AI_ATTEMPT_TIMEOUT_MS) || 20000);
const AI_TOTAL_TIMEOUT_MS   = Math.max(AI_ATTEMPT_TIMEOUT_MS, Number(process.env.AI_TOTAL_TIMEOUT_MS) || 60000);

/**
 * generateWithFallback — coba tiap (provider, model) di `plan` SEKALI, berurutan.
 *
 * Batas (tidak ada retry tanpa akhir):
 *   - Tiap entri plan dicoba maksimal 1x; timeout, rate limit (429), maupun
 *     error lain langsung lanjut ke entri berikutnya, tidak diulang.
 *   - Tiap percobaan dibatasi attemptTimeoutMs dan dibatalkan lewat AbortSignal.
 *   - Seluruh rantai dibatasi totalTimeoutMs.
 *   - SDK Groq/OpenRouter dibuat dengan maxRetries: 0 supaya tidak ada retry
 *     tersembunyi di dalamnya.
 */
async function generateWithFallback(plan, systemPrompt, history, userMessage, onAttempt, options = {}) {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? AI_ATTEMPT_TIMEOUT_MS;
  const totalTimeoutMs   = options.totalTimeoutMs   ?? AI_TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + totalTimeoutMs;
  const errors = [];

  for (let i = 0; i < plan.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      errors.push({ providerId: '-', modelId: '-', error: new Error(`batas total ${totalTimeoutMs}ms tercapai sebelum percobaan #${i + 1}`) });
      break;
    }

    const { provider, modelId } = plan[i];
    const timeoutMs  = Math.min(attemptTimeoutMs, remaining);
    const controller = new AbortController();
    let timer;

    try {
      if (onAttempt) onAttempt({ providerId: provider.id, modelId, attempt: i + 1 });

      const work = (async () => provider.generateReply(
        systemPrompt, history, userMessage, modelId, { signal: controller.signal },
      ))();
      work.catch(() => {}); // cegah unhandledRejection kalau work gagal setelah timeout

      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timeout setelah ${timeoutMs}ms`));
          controller.abort();
        }, timeoutMs);
      });

      const text = await Promise.race([work, timeout]);
      return { text, providerId: provider.id, modelId };
    } catch (error) {
      errors.push({ providerId: provider.id, modelId, error });
      if (onAttempt) onAttempt({ providerId: provider.id, modelId, attempt: i + 1, error });
    } finally {
      clearTimeout(timer);
    }
  }

  if (errors.length === 0) {
    throw new Error('No provider/model succeeded (empty plan — cek konfigurasi provider & PROVIDER_MODEL_TIERS).');
  }
  throw new Error(`All AI provider/model combinations failed. Details: ${errors.map((e) => `${e.providerId}/${e.modelId}: ${e.error.message}`).join(' | ')}`);
}

module.exports = {
  buildProviderModelPlan,
  generateWithFallback,
};
