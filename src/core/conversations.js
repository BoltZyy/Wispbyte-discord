'use strict';


/* =========================================================================
 * UTIL: ConversationStore (riwayat per-channel, bounded)
 * ========================================================================= */
/**
 * ConversationStore — di-key per (channelId, userId), BUKAN per channel saja.
 *
 * Alasan: kalau cuma channelId, satu riwayat percakapan dipakai bersama oleh
 * SEMUA orang yang chat di channel itu. Klaim "kamu adalah BoltZy" yang AI
 * ucapkan ke owner asli akan ikut kebaca sebagai riwayat "milik" orang
 * berikutnya yang chat di channel yang sama — AI lanjut menegaskan klaim itu
 * meski pengirimnya beda, karena tidak ada pemisah identitas di riwayatnya.
 * Key gabungan (channelId + userId) menutup celah ini di akarnya.
 */
class ConversationStore {
  constructor(maxHistory = 6) {
    this.maxHistory = maxHistory;
    this.store = new Map(); // key: `${channelId}:${userId}` -> { history, lastActive }
  }

  key(channelId, userId) { return `${channelId}:${userId}`; }

  get(channelId, userId) {
    return this.store.get(this.key(channelId, userId))?.history || [];
  }

  append(channelId, userId, userMessage, assistantReply) {
    const k = this.key(channelId, userId);
    const history = this.get(channelId, userId);
    history.push({ role: 'user',      content: userMessage    });
    history.push({ role: 'assistant', content: assistantReply });
    this.store.set(k, {
      history: history.slice(-(this.maxHistory * 2)),
      lastActive: Date.now(),
    });
  }

  clear(channelId, userId) { this.store.delete(this.key(channelId, userId)); }

  // Hapus semua riwayat milik satu channel (semua user) — dipakai /resethistory channel.
  clearChannel(channelId) {
    const prefix = `${channelId}:`;
    let removed = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  // Hapus SELURUH riwayat di semua channel/user — dipakai /resethistory all.
  resetAll() {
    const removed = this.store.size;
    this.store.clear();
    return removed;
  }

  // Buang entri user yang sudah lama tidak chat — mencegah Map menumpuk tanpa
  // batas kalau banyak orang chat sekali lalu tidak pernah lagi (RAM-bounded).
  sweep(maxIdleMs) {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (now - v.lastActive > maxIdleMs) this.store.delete(k);
    }
  }
}

const CONVERSATION_MAX_IDLE_MS = 30 * 60 * 1000; // 30 menit tidak aktif -> dibuang
const conversations = new ConversationStore(Number(process.env.MAX_HISTORY || 6));

setInterval(() => conversations.sweep(CONVERSATION_MAX_IDLE_MS), 10 * 60 * 1000).unref();

module.exports = {
  conversations,
};
