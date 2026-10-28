'use strict';

/**
 * Pencocokan kata/frasa terlarang — fungsi murni, tanpa regex dari pengguna.
 *
 * Mode:
 *  - exact   : frasa utuh, tanpa membedakan huruf besar/kecil dan spasi ganda; harus pada batas kata.
 *  - evasion : tahan variasi penulisan: huruf lebar-penuh/matematis (NFKC), aksen, karakter tak terlihat,
 *              huruf Cyrillic/Yunani yang mirip Latin, "leet" (0 1 3 4 5 7 @ $), huruf berulang
 *              ("chheeck"), dan pemisah di antara huruf ("c.h.e.c.k", "c h e c k").
 *  - regex   : DICADANGKAN, belum didukung (Node tidak bisa membatasi waktu regex -> risiko ReDoS).
 *
 * Pencocokan evasion bersifat DETERMINISTIK dan linear (tanpa backtracking), dengan batas:
 *  - harus dimulai di awal kata dan berakhir di akhir kata (mencegah "ass" cocok di "class"),
 *  - pemisah di antara huruf dalam satu kata maksimal MAX_GAP_WITHIN (3) karakter, mis. "c . h . e",
 *  - pemisah di antara kata dalam frasa maksimal MAX_GAP_BETWEEN (5) karakter (boleh nol: "checkmybio").
 */

const MAX_GAP_WITHIN = 3;
const MAX_GAP_BETWEEN = 5;
const MAX_PHRASE_LENGTH = 100;
const MIN_ALNUM = { exact: 2, evasion: 3 };
const MODES = new Set(['exact', 'evasion']);

const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const COMBINING = /\p{M}/gu;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const isWord = (ch) => ch !== undefined && WORD_CHAR.test(ch);

// Huruf Cyrillic/Yunani yang tampak seperti huruf Latin (sudah huruf kecil).
const HOMOGLYPHS = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'i',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ο: 'o', ρ: 'p', τ: 't', υ: 'u', ν: 'v', χ: 'x', γ: 'y', η: 'n', μ: 'u', ω: 'w',
};
// "Kerangka" huruf: karakter yang sering ditukar disamakan. l/1/i satu kelompok.
const LEET = { 0: 'o', 1: 'i', l: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };
const SYMBOL_LEET = { '@': 'a', $: 's' };

/** Mode exact: NFKC, huruf kecil, buang karakter tak terlihat, rapatkan spasi. */
function foldExact(text) {
  return String(text ?? '').normalize('NFKC').replace(INVISIBLE, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Mode evasion: lipatan agresif (lihat atas). Pemisah/spasi dipertahankan karena dipakai untuk menghitung jarak. */
function foldEvasion(text) {
  const base = String(text ?? '').normalize('NFKC').replace(INVISIBLE, '').toLowerCase().normalize('NFD').replace(COMBINING, '');
  const chars = Array.from(base);
  // @ dan $ hanya dianggap huruf bila berada dalam satu rangkaian (huruf/angka/@/$) yang memuat huruf atau
  // angka asli: "a$$" dan "@ss" dipetakan, tetapi "a @ b" atau "$$$" yang berdiri sendiri tidak.
  const symbolIsLetter = new Array(chars.length).fill(false);
  for (let i = 0; i < chars.length;) {
    if (!(isWord(chars[i]) || SYMBOL_LEET[chars[i]])) { i++; continue; }
    let j = i; let hasWord = false;
    while (j < chars.length && (isWord(chars[j]) || SYMBOL_LEET[chars[j]])) { if (isWord(chars[j])) hasWord = true; j++; }
    if (hasWord) for (let k = i; k < j; k++) symbolIsLetter[k] = true;
    i = j;
  }
  return chars.map((ch, i) => HOMOGLYPHS[ch] ?? LEET[ch] ?? (symbolIsLetter[i] ? SYMBOL_LEET[ch] : undefined) ?? ch).join('');
}

const alnumCount = (s) => Array.from(s).filter(isWord).length;

/** Validasi frasa untuk sebuah mode. Hasil: { ok: true, phrase } | { ok: false, error }. */
function validatePhrase(phrase, mode) {
  if (!MODES.has(mode)) return { ok: false, error: mode === 'regex' ? 'Mode regex belum didukung.' : `Mode tidak dikenal: ${mode}` };
  const text = String(phrase ?? '').trim();
  if (!text) return { ok: false, error: 'Frasa tidak boleh kosong.' };
  if (text.length > MAX_PHRASE_LENGTH) return { ok: false, error: `Frasa maksimal ${MAX_PHRASE_LENGTH} karakter.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(text)) return { ok: false, error: 'Frasa tidak boleh memuat karakter kontrol.' };
  const folded = mode === 'exact' ? foldExact(text) : foldEvasion(text);
  if (alnumCount(folded) < MIN_ALNUM[mode]) {
    return { ok: false, error: `Frasa mode ${mode} minimal ${MIN_ALNUM[mode]} huruf/angka (frasa yang terlalu pendek menimbulkan banyak salah deteksi).` };
  }
  return { ok: true, phrase: text };
}

function compileExact(phrase) {
  const needle = foldExact(phrase);
  const chars = Array.from(needle);
  const needStart = isWord(chars[0]); const needEnd = isWord(chars.at(-1));
  return (text) => {
    const hay = foldExact(text);
    for (let from = 0; ;) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) return false;
      const before = Array.from(hay.slice(Math.max(0, idx - 2), idx)).at(-1);
      const after = Array.from(hay.slice(idx + needle.length, idx + needle.length + 2))[0];
      if ((!needStart || !isWord(before)) && (!needEnd || !isWord(after))) return true;
      from = idx + 1;
    }
  };
}

function compileEvasion(phrase) {
  const folded = Array.from(foldEvasion(phrase));
  // kelompokkan per kata, lalu per "run" huruf berulang di dalam satu kata
  const runs = []; let wi = -1; let prevWord = false;
  for (const ch of folded) {
    if (!isWord(ch)) { prevWord = false; continue; }
    if (!prevWord) wi++;
    prevWord = true;
    const last = runs.at(-1);
    if (last && last.wi === wi && last.ch === ch) last.count++; else runs.push({ ch, wi, count: 1 });
  }
  if (!runs.length) throw new Error('frasa tidak memuat huruf/angka');

  const skip = (t, pos, cap) => { let n = 0; while (pos < t.length && !isWord(t[pos]) && n < cap) { pos++; n++; } return pos; };

  /** Coba cocokkan mulai dari `start`; mengembalikan posisi akhir atau -1. */
  function matchAt(t, start) {
    let pos = start; let first = true; let prevWi = runs[0].wi;
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      for (let k = 0; k < run.count; k++) {
        if (!first) pos = skip(t, pos, k === 0 && run.wi !== prevWi ? MAX_GAP_BETWEEN : MAX_GAP_WITHIN);
        if (pos >= t.length || t[pos] !== run.ch) return -1;
        pos++; first = false;
      }
      const next = runs[r + 1];
      if (!next || next.ch !== run.ch) { while (pos < t.length && t[pos] === run.ch) pos++; } // huruf berulang berlebih
      prevWi = run.wi;
    }
    return pos >= t.length || !isWord(t[pos]) ? pos : -1;
  }

  return (text) => {
    const t = Array.from(foldEvasion(text));
    for (let i = 0; i < t.length; i++) {
      if (t[i] === runs[0].ch && (i === 0 || !isWord(t[i - 1])) && matchAt(t, i) >= 0) return true;
    }
    return false;
  };
}

/** Kompilasi sebuah frasa menjadi fungsi (text) => boolean. Melempar error kalau frasa/mode tidak valid. */
function compileMatcher({ mode, phrase }) {
  const v = validatePhrase(phrase, mode);
  if (!v.ok) throw new Error(v.error);
  return mode === 'exact' ? compileExact(v.phrase) : compileEvasion(v.phrase);
}

module.exports = {
  MAX_GAP_BETWEEN, MAX_GAP_WITHIN, MAX_PHRASE_LENGTH, MODES,
  compileMatcher, foldEvasion, foldExact, validatePhrase,
};
