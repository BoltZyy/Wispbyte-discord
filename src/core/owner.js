'use strict';


/* =========================================================================
 * NOTE — Owner Recognition (validasi ID, bukan validasi teks):
 * Trigger phrase ("aku adalah BoltZy", dst.) memicu AI TETAP dipanggil untuk
 * siapa pun yang mengetiknya — tapi konteks yang disuntikkan ke system prompt
 * berbeda tergantung apakah message.author.id benar-benar cocok dengan
 * OWNER_ID:
 *   - ID cocok      -> sesi owner diaktifkan (TTL), AI diberi tahu ini owner asli.
 *   - ID tidak cocok -> sesi TIDAK diaktifkan, AI diberi tahu ini penipu/roleplay.
 * Selama sesi owner masih aktif (TTL), pesan AI normal berikutnya dari owner
 * juga disisipi catatan ringan bahwa ia sudah dikenali sebelumnya.
 * =========================================================================
 */

/* =========================================================================
 * OWNER RECOGNITION & SESSION STORE (auto-cleanup, bounded)
 * ========================================================================= */
const OWNER_ID          = process.env.OWNER_ID || '1091901409668124805';
const OWNER_SESSION_TTL = 10 * 60 * 1000; // 10 menit
const ownerSessionStore = new Map(); // guildId -> timestamp pengenalan terakhir
// Regex trigger klaim identitas — diperluas supaya menangkap frasa dengan
// sisipan kata (mis. "gw adalah pencipta lu, BoltZy"), TAPI diblokir kalau
// ada kata penanda obrolan-biasa di sela-selanya (mis. "denger", "menurut",
// "apakah") supaya tidak salah tangkap pertanyaan/opini biasa soal BoltZy
// sebagai klaim identitas. Diuji terhadap 12 kasus (7 klaim asli harus kena,
// 5 obrolan biasa harus lolos) — semua sesuai ekspektasi.
const ownerTriggerRegex = new RegExp(
  '^\\s*(aku|saya|gw|gue|ini)\\s+' +
  '(?!.*(denger|katanya|menurut|kata|kalo|kalau|sih|apa|apakah|kenapa|gimana|bagaimana)\\s)' +
  '(\\S+\\s+){0,4}?(boltzy|penciptamu)\\b',
  'i'
);

function markOwnerRecognized(guildId) {
  ownerSessionStore.set(guildId, Date.now());
}

function isOwnerSessionActive(guildId) {
  const ts = ownerSessionStore.get(guildId);
  if (!ts) return false;
  if (Date.now() - ts > OWNER_SESSION_TTL) {
    ownerSessionStore.delete(guildId);
    return false;
  }
  return true;
}

// Sweeper periodik — mencegah Map menumpuk entri kedaluwarsa tanpa batas.
// .unref() supaya interval ini tidak menahan proses tetap hidup saat shutdown.
setInterval(() => {
  const now = Date.now();
  for (const [guildId, ts] of ownerSessionStore) {
    if (now - ts > OWNER_SESSION_TTL) ownerSessionStore.delete(guildId);
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  OWNER_ID,
  isOwnerSessionActive,
  markOwnerRecognized,
  ownerTriggerRegex,
};
