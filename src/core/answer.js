'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

/**
 * Jawaban verification TIDAK disimpan terbuka: hanya hash scrypt + salt acak.
 * Pemilik server tidak bisa melihatnya lagi (hanya bisa menggantinya), dan backup
 * database tidak membocorkannya. Catatan: jawaban pendek tetap bisa ditebak lewat
 * brute-force offline — ini mengurangi kebocoran, bukan pengganti rahasia yang kuat.
 */

/** NFKC, huruf kecil, buang karakter lebar-nol, rapatkan spasi, trim. Tanda baca TIDAK dibuang. */
function normalizeAnswer(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const hashOf = async (normalized, saltHex) => (await scrypt(normalized, Buffer.from(saltHex, 'hex'), 32)).toString('hex');

async function makeAnswerRecord(answer) {
  const normalized = normalizeAnswer(answer);
  if (!normalized) throw new TypeError('jawaban tidak boleh kosong');
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: await hashOf(normalized, salt) };
}

async function answerMatches(answer, record) {
  const normalized = normalizeAnswer(answer);
  if (!normalized || !record?.salt || !record?.hash) return false;
  const a = Buffer.from(await hashOf(normalized, record.salt), 'hex');
  const b = Buffer.from(record.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { answerMatches, makeAnswerRecord, normalizeAnswer };
