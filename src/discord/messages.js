'use strict';

const { DEFAULT_SYSTEM_PROMPT, OWNER_IMPERSONATOR_CONTEXT, OWNER_SESSION_CONTINUATION_CONTEXT, OWNER_VERIFIED_CONTEXT, withContextNote } = require('../ai/persona');
const { buildProviderModelPlan, generateWithFallback } = require('../ai/router');
const { conversations } = require('../core/conversations');
const { OWNER_ID, isOwnerSessionActive, markOwnerRecognized, ownerTriggerRegex } = require('../core/owner');
const { RATE_LIMIT_MAX_HITS, isRateLimited } = require('../core/rateLimit');
const { splitMessage, stripBotMention } = require('../core/text');
const { blocklist, modelConfig, responders } = require('../storage/state');

/* =========================================================================
 * MESSAGE HANDLER
 * Urutan: bot guard → blocklist gate → owner recognition → auto-responder →
 *         AI (mention / prefix) dengan rate limiting.
 * Ini menyambungkan komponen yang sebelumnya dideklarasikan tanpa dipanggil.
 * ========================================================================= */
// Batasi panjang snippet supaya tidak boros token kalau balasan bot sebelumnya panjang.
const REPLIED_BOT_CONTEXT_MAX_CHARS = 500;

/**
 * fetchRepliedBotContext — kalau pesan user ini adalah REPLY ke pesan BOT
 * (bukan ke user lain — itu sengaja tidak dibaca, berisiko salah tafsir),
 * ambil isi pesan yang di-reply itu supaya AI tahu topik yang disambung.
 *
 * Cuma 1 potongan pesan spesifik, BUKAN seluruh riwayat percakapan pemilik
 * asli balasan itu — jadi tidak membocorkan riwayat penuh user lain, cuma
 * "mengingatkan" AI apa yang baru saja dia sendiri katakan di pesan itu.
 * Gagal fetch (pesan dihapus dll) -> return null, tidak menghentikan alur.
 */
async function fetchRepliedBotContext(message, client) {
  if (!message.reference?.messageId) return null;
  try {
    const replied = await message.channel.messages.fetch(message.reference.messageId);
    if (replied.author.id !== client.user.id) return null; // cuma reply ke bot sendiri
    const snippet = replied.content.slice(0, REPLIED_BOT_CONTEXT_MAX_CHARS);
    return `User ini me-reply pesanmu sebelumnya (ke orang lain, BUKAN riwayat percakapan user ini sendiri): "${snippet}". Sambungkan topiknya kalau relevan, jangan anggap ini riwayat pribadi user ini.`;
  } catch (err) {
    console.warn(`[Reply Context] Gagal fetch pesan yang di-reply: ${err.message}`);
    return null;
  }
}

function registerMessageHandler(client, providers, config) {
  const { prefix, systemPrompt, wordFilter } = config;
  const effectiveSystemPrompt = systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

  client.on('messageCreate', async (message) => {
    // Filter kata terlarang berjalan PERTAMA: pesan yang dihapus tidak boleh dijawab AI.
    if (wordFilter && await wordFilter.screen(message)) return;
    try {
      if (message.author.bot) return;

      // ── Blocklist gate: user diblokir tidak bisa pakai fitur AI ──
      if (blocklist[message.author.id]) return;

      const raw    = message.content;
      const rawLow = raw.trim().toLowerCase();

      // ── Owner recognition: validasi ID, BUKAN validasi teks ──
      // Trigger phrase memicu AI untuk SIAPA PUN yang mengetiknya; yang berbeda
      // hanyalah konteks yang disuntikkan ke system prompt tergantung apakah
      // pengirimnya benar-benar cocok dengan OWNER_ID.
      const isOwnerTrigger = ownerTriggerRegex.test(raw);
      const isRealOwner    = message.author.id === OWNER_ID;

      let ownerContextNote = null;
      if (isOwnerTrigger) {
        if (isRealOwner) {
          markOwnerRecognized(message.guildId);
          ownerContextNote = OWNER_VERIFIED_CONTEXT;
        } else {
          ownerContextNote = OWNER_IMPERSONATOR_CONTEXT; // sesi TIDAK diaktifkan
        }
      } else if (isRealOwner && isOwnerSessionActive(message.guildId)) {
        // Owner asli, tanpa trigger baru, tapi sesi sebelumnya masih aktif (TTL).
        ownerContextNote = OWNER_SESSION_CONTINUATION_CONTEXT;
      }

      // ── Auto-responder: "Ovelia <trigger>" ──
      if (rawLow.startsWith('ovelia ')) {
        const trigger = rawLow.slice('ovelia '.length).trim();
        if (trigger && responders[trigger] !== undefined) {
          await message.channel.send(responders[trigger]);
          return;
        }
      }

      // ── AI: bot mention, command prefix, ATAU trigger owner/impersonator ──
      const isMentioned = message.mentions.has(client.user.id);
      const isCommand    = rawLow.startsWith(prefix.toLowerCase());
      if (!isMentioned && !isCommand && !isOwnerTrigger) return;

      if (providers.length === 0) {
        await message.reply('⚠️ No AI providers are configured right now.');
        return;
      }

      // Rate limit tidak berlaku untuk owner sah — validasi ID, bukan klaim teks,
      // jadi ini tidak bisa ditembus dengan mengetik "gw BoltZy" dari akun lain.
      if (!isRealOwner && isRateLimited(message.author.id)) {
        await message.reply(`⏳ Terlalu banyak permintaan. Coba lagi sebentar (maks ${RATE_LIMIT_MAX_HITS}x/menit).`);
        return;
      }

      let userMessage = raw;
      if (isCommand)        userMessage = userMessage.slice(prefix.length).trim();
      else if (isMentioned) userMessage = stripBotMention(userMessage, client.user.id);
      else                  userMessage = raw.trim(); // trigger phrase murni, tanpa mention/prefix

      if (!userMessage) {
        await message.reply('Halo! Ada yang bisa dibantu? Tulis pertanyaanmu ya 🙂');
        return;
      }

      await message.channel.sendTyping();
      const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

      try {
        const replyContext = await fetchRepliedBotContext(message, client);
        const callSystemPrompt = withContextNote(effectiveSystemPrompt, [ownerContextNote, replyContext]);
        const plan = buildProviderModelPlan(providers, modelConfig);

        if (plan.length === 0) {
          await message.reply('⚠️ Tidak ada model yang bisa dicoba (cek PROVIDER_MODEL_TIERS / provider terkonfigurasi).');
          return;
        }

        const { text, providerId, modelId } = await generateWithFallback(
          plan, callSystemPrompt,
          conversations.get(message.channel.id, message.author.id), userMessage,
          ({ providerId: pid, modelId: mid, attempt, error }) => {
            if (error) console.warn(`[AI] Attempt #${attempt} via "${pid}/${mid}" failed${error.status ? ` [HTTP ${error.status}]` : ''}: ${error.message}`);
            else       console.log(`[AI] Attempt #${attempt} using "${pid}/${mid}"`);
          }
        );

        conversations.append(message.channel.id, message.author.id, userMessage, text);
        for (const chunk of splitMessage(text)) await message.reply(chunk);
        console.log(`[AI] Answered using: ${providerId}/${modelId}`);
      } finally {
        clearInterval(typingInterval);
      }

    } catch (error) {
      console.error('[MessageHandler] Error:', error);
      await message.reply('Maaf, semua layanan AI sedang bermasalah. Coba lagi beberapa saat ya 🙏').catch(() => {});
    }
  });
}

module.exports = {
  registerMessageHandler,
};
