'use strict';

/**
 * Challenge pilihan ganda sederhana untuk "human verification" ringan (tahap 5).
 * BUKAN perlindungan anti-bot yang kuat: bot otomatis bisa menjawabnya. Tujuannya hanya
 * menambah gesekan kecil sebelum pemberian pass. Jawaban benar TIDAK boleh dimasukkan ke
 * customId tombol — hanya indeks pilihan yang dikirim, jawaban benar disimpan di sesi.
 *
 * rng(): () => angka [0,1) — disuntik agar tes deterministik.
 */
const COLORS = ['MERAH', 'BIRU', 'HIJAU', 'KUNING', 'UNGU', 'PUTIH', 'HITAM', 'JINGGA'];

const int = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Ambil `count` nilai unik yang dibuat generator `make`. */
function uniqueValues(count, make, avoid = new Set()) {
  const out = new Set(); let guard = 0;
  while (out.size < count && guard++ < 200) { const v = make(); if (!avoid.has(v)) out.add(v); }
  return [...out];
}

function withCorrect(prompt, correct, distractors, rng) {
  const labels = shuffle([correct, ...distractors], rng).map(String);
  return { prompt, options: labels, correctIndex: labels.indexOf(String(correct)) };
}

const GENERATORS = {
  add(rng) {
    const a = int(rng, 2, 9); const b = int(rng, 2, 9); const answer = a + b;
    return withCorrect(`Berapa ${a} + ${b}?`, answer, uniqueValues(3, () => answer + int(rng, -4, 4), new Set([answer])).filter((v) => v > 0), rng);
  },
  sub(rng) {
    const a = int(rng, 10, 20); const b = int(rng, 2, 9); const answer = a - b;
    return withCorrect(`Berapa ${a} - ${b}?`, answer, uniqueValues(3, () => answer + int(rng, -4, 4), new Set([answer])).filter((v) => v > 0), rng);
  },
  largest(rng) {
    const nums = uniqueValues(4, () => int(rng, 10, 99));
    return withCorrect('Pilih angka TERBESAR.', Math.max(...nums), nums.filter((n) => n !== Math.max(...nums)), rng);
  },
  word(rng) {
    const words = shuffle(COLORS, rng).slice(0, 4);
    return withCorrect(`Tekan tombol bertuliskan: ${words[0]}`, words[0], words.slice(1), rng);
  },
};

/** Hasil: { prompt, options: string[4], correctIndex }. Selalu tepat 4 pilihan unik. */
function generateChallenge(rng = Math.random) {
  const kinds = Object.keys(GENERATORS);
  for (let attempt = 0; attempt < 20; attempt++) {
    const c = GENERATORS[kinds[Math.floor(rng() * kinds.length)]](rng);
    if (c.options.length === 4 && new Set(c.options).size === 4 && c.correctIndex >= 0) return c;
  }
  return GENERATORS.word(rng); // jaring pengaman (praktis tidak pernah tercapai)
}

module.exports = { generateChallenge };
