'use strict';

/**
 * TtlStore — penyimpanan sementara di memori dengan kedaluwarsa (TTL).
 * Pengganti Redis untuk bot satu proses: sesi verification/challenge, cooldown,
 * penghitung percobaan. Data hilang saat bot restart (disengaja: sesi hanya
 * hidup beberapa menit dan gagal tertutup).
 *
 * - get/has TIDAK PERNAH mengembalikan entri yang sudah kedaluwarsa.
 * - maxEntries membatasi memori; kalau penuh, entri tertua dibuang.
 * - Sweeper berkala opsional (unref, tidak menahan proses tetap hidup).
 */
class TtlStore {
  constructor({ now = Date.now, maxEntries = 10000 } = {}) {
    this._now = now;
    this._maxEntries = maxEntries;
    this._map = new Map(); // key -> { value, expiresAt }
    this._timer = null;
  }

  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs harus angka positif');
    this._map.delete(key); // pindahkan ke urutan paling baru
    if (this._map.size >= this._maxEntries) {
      this.sweep();
      if (this._map.size >= this._maxEntries) this._map.delete(this._map.keys().next().value);
    }
    this._map.set(key, { value, expiresAt: this._now() + ttlMs });
    return value;
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this._now()) { this._map.delete(key); return undefined; }
    return entry.value;
  }

  has(key) { return this.get(key) !== undefined; }

  delete(key) { return this._map.delete(key); }

  /** Sisa umur entri (ms), atau 0 kalau tidak ada / sudah kedaluwarsa. */
  ttlRemaining(key) {
    const entry = this._map.get(key);
    if (!entry) return 0;
    const left = entry.expiresAt - this._now();
    if (left <= 0) { this._map.delete(key); return 0; }
    return left;
  }

  /** Jumlah entri yang masih hidup. */
  get size() { this.sweep(); return this._map.size; }

  /** Buang entri kedaluwarsa; mengembalikan jumlah yang dibuang. */
  sweep() {
    const t = this._now();
    let removed = 0;
    for (const [key, entry] of this._map) {
      if (entry.expiresAt <= t) { this._map.delete(key); removed++; }
    }
    return removed;
  }

  startSweeper(intervalMs = 30000) {
    if (this._timer) return this;
    this._timer = setInterval(() => this.sweep(), intervalMs);
    this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

module.exports = { TtlStore };
