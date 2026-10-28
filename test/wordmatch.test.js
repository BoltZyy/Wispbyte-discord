'use strict';
/**
 * Tes mesin pencocokan kata terlarang (fungsi murni): variasi penulisan, salah deteksi (false
 * positive), validasi frasa, dan ketahanan terhadap masukan patologis (tanpa regex pengguna).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileMatcher, foldEvasion, foldExact, validatePhrase } = require('../src/core/wordMatch');

const ev = (phrase) => compileMatcher({ mode: 'evasion', phrase });
const ex = (phrase) => compileMatcher({ mode: 'exact', phrase });
const expectAll = (matcher, texts, want) => { for (const t of texts) assert.equal(matcher(t), want, `${want ? 'harus cocok' : 'TIDAK boleh cocok'}: ${JSON.stringify(t)}`); };

/* ---------------- exact ---------------- */
test('exact: frasa utuh, tidak peka huruf besar/kecil dan spasi ganda, dan harus pada batas kata', () => {
  const m = ex('free nitro');
  expectAll(m, ['free nitro', 'FREE   Nitro!', 'get free nitro now', 'Free\tNitro', 'ｆｒｅｅ ｎｉｔｒｏ', 'fr\u200Bee nitro'], true);
  expectAll(m, ['freenitro', 'free nitrogen', 'carefree nitro', 'free  n1tro', 'free nitr0'], false);
});
test('exact: tidak melipat aksen atau leet (itu tugas mode evasion); tepi non-huruf tidak butuh batas', () => {
  assert.equal(ex('café')(' cafe '), false);
  assert.equal(ex('café')('di CAFÉ itu'), true);
  const money = ex('$100');
  assert.equal(money('win $100 now'), true);
  assert.equal(money('win $1000 now'), false, 'batas kanan tetap berlaku untuk karakter akhir yang berupa angka');
});

/* ---------------- evasion: variasi yang harus ditangkap ---------------- */
test('evasion: variasi penulisan "check my bio" dari rencana semuanya cocok', () => {
  expectAll(ev('check my bio'), [
    'Check my bio', 'CHECK MY BIO!', 'check my bi0', 'check my b1o', 'check my bl0', 'ch3ck my b1o', 'ch3ck my 8io'.replace('8', 'b'),
    'c.h.e.c.k m.y b.i.o', 'c h e c k  m y  b i o', 'check_my-bio', 'checkmybio', 'chheeck mmy biiio',
    'ｃｈｅｃｋ ｍｙ ｂｉｏ', '𝐜𝐡𝐞𝐜𝐤 𝐦𝐲 𝐛𝐢𝐨', 'chеck my bio' /* e Cyrillic */, 'check my bío', 'ch\u200Beck my bio', 'please check my bio now', 'check,\nmy\n\nbio',
  ], true);
});
test('evasion: kata "ass" — varian cocok, kata biasa yang memuatnya TIDAK cocok', () => {
  const m = ev('ass');
  expectAll(m, ['ass', 'ASS', 'a$$', '@ss', 'a s s', 'a.s.s', 'ａｓｓ', 'аss' /* a Cyrillic */, 'asss', 'you ass!'], true);
  expectAll(m, ['class', 'assignment', 'assess', 'pass', 'mass', 'bass guitar', 'Essex', 'as soon as possible', 'have a nice day'], false);
});
test('evasion: kata mirip yang BUKAN pelanggaran tidak cocok (batas awal dan akhir kata)', () => {
  expectAll(ev('check my bio'), [
    'check my biography', 'checkpoint my bio', 'check mybiology', 'I will check on my bone', 'recheck my bio', 'check my biodata',
    'Tolong cek bio saya ya', 'check the biology notebook', 'my bio is long, check later',
  ], false);
  expectAll(ev('free nitro'), ['free of charge, no nitro needed', 'carefree nitro', 'free nitrogen report', 'free  nitr'], false);
});
test('evasion: kalimat sehari-hari (Inggris dan Indonesia) tidak memicu aturan umum', () => {
  const rules = ['check my bio', 'free nitro', 'ass', 'click here'].map(ev);
  const corpus = [
    "I'm going to the class on Monday and then we'll pass by the mass transit station.",
    'She passed the assessment with flying colors, and the bass line was great.',
    'Kita makan nasi di kelas, lalu belajar tentang massa dan gravitasi.',
    'Besok jam 5 sore kita ketemu di warung, bawa 100 ribu ya, jangan lupa!',
    'Please click the button on the left, then press here to continue.',
    'Server ini punya 12 channel, 3 role, dan 1 bot untuk 15 orang.',
    'Aku mau nitro anggur, bukan free-range ayam.',
  ];
  for (const text of corpus) for (const rule of rules) assert.equal(rule(text), false, text);
});
test('evasion: batas jarak pemisah (dalam kata 3, antar kata 5) — di luar batas tidak cocok', () => {
  assert.equal(ev('check')('c . h . e . c . k'), true, 'celah " . " = 3 karakter, tepat di batas');
  assert.equal(ev('check')('c   h   e   c   k'), true, '3 spasi per celah, tepat di batas');
  assert.equal(ev('check')('c    h e c k'), false, '4 spasi di dalam kata melebihi batas');
  assert.equal(ev('check my')('check     my'), true, '5 spasi antar kata masih ok');
  assert.equal(ev('check my')('check      my'), false, '6 spasi antar kata melebihi batas');
});
test('evasion: huruf yang mirip (l/1/i, o/0, e/3, a/4/@, s/5/$, t/7) disamakan', () => {
  expectAll(ev('hello'), ['he11o', 'hell0', 'h3ll0', 'H3LL0!', 'hel1o'], true);
  expectAll(ev('tests'), ['7e57$', 't3st5'], true);
});
test('evasion: "@" dan "$" yang berdiri sendiri sebagai tanda baca tidak dianggap huruf', () => {
  assert.equal(ev('bio')('check my bio @ home'), true);
  assert.equal(ev('bio')('price in bio $ 5'), true, 'tanda berdiri sendiri tidak menempel ke kata');
  assert.equal(foldEvasion('a @ b'), 'a @ b');
  assert.equal(foldEvasion('@ss'), 'ass');
  assert.equal(foldEvasion('a$$'), 'ass', 'rangkaian simbol yang menempel pada huruf ikut dipetakan');
  assert.equal(foldEvasion('$$$'), '$$$', 'simbol berdiri sendiri tidak dipetakan');
});

/* ---------------- validasi ---------------- */
test('validatePhrase: menolak kosong, terlalu panjang, karakter kontrol, terlalu pendek, mode tidak dikenal', () => {
  assert.equal(validatePhrase('free nitro', 'exact').ok, true);
  assert.equal(validatePhrase('  spasi  ', 'exact').phrase, 'spasi');
  for (const [phrase, mode, re] of [
    ['', 'exact', /tidak boleh kosong/], ['   ', 'evasion', /tidak boleh kosong/], ['x'.repeat(101), 'exact', /maksimal 100/],
    ['ab\u0007cd', 'exact', /karakter kontrol/], ['a', 'exact', /minimal 2/], ['ab', 'evasion', /minimal 3/], ['a.b', 'evasion', /minimal 3/],
    ['!!!', 'exact', /minimal 2/], ['halo', 'regex', /regex belum didukung/], ['halo', 'bebas', /Mode tidak dikenal/],
  ]) { const r = validatePhrase(phrase, mode); assert.equal(r.ok, false, `${phrase}/${mode}`); assert.match(r.error, re); }
  assert.equal(validatePhrase('a.b.c', 'evasion').ok, true);
  assert.throws(() => compileMatcher({ mode: 'regex', phrase: '(a+)+$' }), /regex belum didukung/);
});
test('fold: deterministik dan idempoten untuk evasion; exact merapikan spasi', () => {
  for (const s of ['Check MY b1o', '𝐜𝐡𝐞𝐜𝐤', 'Ｈｅｌｌｏ', 'Привет', 'ΑΒΓ', 'a\u200Bb', '']) assert.equal(foldEvasion(foldEvasion(s)), foldEvasion(s), s);
  assert.equal(foldExact('  A   B\n\tC '), 'a b c');
  assert.equal(foldExact(null), '');
});

/* ---------------- ketahanan ---------------- */
test('ketahanan: masukan aneh (emoji, surrogate rusak, RTL, sangat panjang) tidak melempar error', () => {
  const m = ev('check my bio'); const e = ex('check my bio');
  for (const t of ['👍🏽 check my bio 🎉', '\uD800 check my bio', 'check my bio \u202E', '', '   ', 'ﷺ'.repeat(500), 'a'.repeat(10000)]) {
    assert.doesNotThrow(() => { m(t); e(t); }, JSON.stringify(t).slice(0, 30));
  }
  assert.equal(m('👍🏽 check my bio 🎉'), true);
});
test('ketahanan: teks patologis diproses cepat (tidak ada backtracking eksponensial)', () => {
  const text = `${'e'.repeat(5000)}x ${'e e '.repeat(1500)} ${'e.'.repeat(2000)}`;
  const matchers = ['eeeeeeeeee', 'e e e e e e e e', 'e.e.e.e.e.e', 'ee ee ee ee'].map(ev);
  const t0 = Date.now();
  for (const m of matchers) m(text);
  const dt = Date.now() - t0;
  assert.ok(dt < 2000, `terlalu lambat: ${dt}ms`);
});
test('ketahanan: 100 aturan x teks 5000 karakter selesai dalam batas wajar', () => {
  const words = Array.from({ length: 100 }, (_, i) => `kata${i}kunci${i * 7}`);
  const matchers = words.map((w, i) => (i % 2 ? ev(w) : ex(w)));
  const text = 'lorem ipsum dolor sit amet '.repeat(200);
  const t0 = Date.now();
  for (const m of matchers) m(text);
  assert.ok(Date.now() - t0 < 3000);
});
