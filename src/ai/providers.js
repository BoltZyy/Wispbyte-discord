'use strict';


/* =========================================================================
 * PROVIDERS — Gemini, Groq, OpenRouter
 * OPTIMASI: SDK hanya di-require jika API key-nya benar-benar ada di env.
 * Kalau kamu cuma pakai 1 provider, 2 SDK lain TIDAK PERNAH masuk memori.
 * Ini tidak mengubah perilaku bot — provider tanpa key memang sudah tidak
 * pernah dipakai sebelumnya, sekarang cuma tidak di-load sama sekali.
 * ========================================================================= */
// Safety settings Gemini — nilai string sesuai contoh resmi @google/genai.
const GEMINI_SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

/*
 * Antarmuka provider (tidak berubah): { id, type, generateReply(systemPrompt,
 * history, userMessage, modelId, options?) }. `options.signal` (AbortSignal)
 * adalah tambahan opsional — dipakai router untuk membatalkan percobaan yang
 * melewati batas waktu.
 */
function createGeminiProvider({ id, apiKey }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  return {
    id, type: 'gemini',
    async generateReply(systemPrompt, history, userMessage, modelId, { signal } = {}) {
      const contents = [
        ...history.map((h) => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }],
        })),
        { role: 'user', parts: [{ text: userMessage }] },
      ];
      const response = await ai.models.generateContent({
        model: modelId,
        contents,
        config: {
          systemInstruction: systemPrompt,
          safetySettings: GEMINI_SAFETY_SETTINGS,
          ...(signal ? { abortSignal: signal } : {}),
        },
      });
      const text = response.text;
      if (!text?.trim()) throw new Error('Gemini returned an empty response.');
      return text.trim();
    },
  };
}

function createGroqProvider({ id, apiKey }) {
  const Groq = require('groq-sdk');
  // maxRetries: 0 — percobaan ulang ditangani router (fallback), bukan SDK.
  const client = new Groq({ apiKey, maxRetries: 0 });

  return {
    id, type: 'groq',
    async generateReply(systemPrompt, history, userMessage, modelId, { signal } = {}) {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: userMessage },
      ];
      const completion = await client.chat.completions.create(
        { model: modelId, messages, temperature: 0.8, max_tokens: 800 },
        signal ? { signal } : undefined,
      );
      const text = completion.choices?.[0]?.message?.content;
      if (!text?.trim()) throw new Error('Groq returned an empty response.');
      return text.trim();
    },
  };
}

function createOpenRouterProvider({ id, apiKey, siteUrl, appName }) {
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey,
    maxRetries: 0, // percobaan ulang ditangani router (fallback), bukan SDK
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      ...(siteUrl ? { 'HTTP-Referer': siteUrl } : {}),
      ...(appName ? { 'X-Title':      appName } : {}),
    },
  });

  return {
    id, type: 'openrouter',
    async generateReply(systemPrompt, history, userMessage, modelId, { signal } = {}) {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: userMessage },
      ];
      const completion = await client.chat.completions.create(
        { model: modelId, messages, temperature: 0.8, max_tokens: 800 },
        signal ? { signal } : undefined,
      );
      const text = completion.choices?.[0]?.message?.content;
      if (!text?.trim()) throw new Error('OpenRouter returned an empty response.');
      return text.trim();
    },
  };
}

function buildProviderRegistry(env = process.env) {
  const providers = [];
  const geminiKey1    = env.GEMINI_KEY_1    || env.Gemini_API;
  const geminiKey2    = env.GEMINI_KEY_2    || env.Gemini_API_2;
  const groqKey       = env.GROQ_KEY        || env.Groq_API;
  const openrouterKey = env.OPENROUTER_KEY  || env.Openrouter_API;

  if (geminiKey1)    providers.push(createGeminiProvider({ id: 'gemini-1', apiKey: geminiKey1 }));
  if (geminiKey2)    providers.push(createGeminiProvider({ id: 'gemini-2', apiKey: geminiKey2 }));
  if (groqKey)       providers.push(createGroqProvider({ id: 'groq-1', apiKey: groqKey }));
  if (openrouterKey) providers.push(createOpenRouterProvider({
    id: 'openrouter-1', apiKey: openrouterKey,
    siteUrl: env.OPENROUTER_SITE_URL,
    appName: env.OPENROUTER_APP_NAME,
  }));

  return providers;
}

module.exports = {
  buildProviderRegistry,
  createGeminiProvider,
  createGroqProvider,
  createOpenRouterProvider,
};
