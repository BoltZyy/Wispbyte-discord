# HANDOVER — Proyek Bot Discord "Ovelia"

Dokumen serah-terima untuk sesi chat baru. Ditulis di akhir sesi panjang (konteks penuh). Tujuan: Claude di sesi baru bisa langsung memahami apa yang sudah dibangun, bagaimana struktur dan fondasinya, apa yang belum, aturan kerja dengan pengguna ini, dan jebakan teknis yang sudah pernah menggigit.

**Keadaan terakhir:** tahap 1–6 dari rencana moderasi sudah dibangun. Snapshot penuh terakhir = `ovelia-stage6b-fix.zip` (184 tes lulus di sandbox). Yang sudah terbukti di server asli dan yang baru lolos tes dibedakan jelas di bagian 3. **Jangan menganggap sesuatu terbukti kalau belum tertulis "terbukti live".**

---

## 0. Cara memakai dokumen ini

**Untuk pengguna (BoltZyy):** di chat baru, unggah (1) berkas ini dan (2) zip terbaru proyek (`ovelia-stage6b-fix.zip`, atau zip lebih baru kalau sudah ada), lalu tempel "Prompt pembuka" di bagian 11.

**Untuk Claude di sesi baru, langkah pertama:**
1. Baca bagian 1 (aturan kerja) dengan teliti — itu preferensi pengguna yang sudah disepakati.
2. Ekstrak zip ke `/home/claude/work`, jalankan `npm test`. Jumlah tes yang diharapkan ada di bagian 10. Kalau berbeda, tanyakan zip versi mana yang dipasang pengguna.
3. Tanyakan hasil uji langsung yang masih tertunda (bagian 3 dan 9).
4. Jangan mulai tahap baru sebelum pengguna mengonfirmasi arah.

**Penting:** sandbox Claude bisa **di-reset** (direktori kerja hilang) dan tidak punya internet untuk `bash`. Satu-satunya hal yang bertahan adalah berkas di `/mnt/user-data/outputs`. Karena itu, selesaikan dan serahkan zip secepatnya; jangan menyimpan hasil hanya di sandbox.

---

## 1. Aturan kerja untuk Claude (WAJIB)

### Gaya komunikasi
- **Bahasa Indonesia.** Pengguna bekerja dari ponsel (Termux + Spck), jadi jawaban ringkas, langkah dan perintah siap salin. Hindari jawaban sangat panjang; letakkan detail di berkas.
- **Bedakan tegas: fakta terverifikasi, asumsi, dan belum teruji.** Jangan pernah mengklaim berhasil tanpa bukti. Laporkan jumlah tes dan hasil **sebenarnya** (termasuk yang gagal).
- Pengguna menghargai transparansi: kalau ada yang tidak bisa diuji di sandbox, sebutkan spesifik dan beri perintah/tes konkret untuk dijalankan di Termux/Wispbyte.
- Maksimal satu pertanyaan per balasan kecuali sedang meminta keputusan berpilihan (lihat bawah). Jangan bertanya hal teknis kecil yang bisa diputuskan sendiri.
- Jangan menyebut sistem memori internal, jangan menceritakan proses di balik layar.

### Cara mengambil keputusan
- **Keputusan penting** (arsitektur, keamanan, perilaku fitur, preferensi pengguna): tanyakan dengan **opsi + konsekuensi + rekomendasi**, lalu sambil menunggu lanjutkan pekerjaan lain yang tidak bergantung padanya.
- **Keputusan teknis kecil**: putuskan sendiri secara wajar dan laporkan singkat.
- Jangan merombak bagian yang sudah berfungsi tanpa alasan teknis yang jelas. Ikuti struktur modul dan konvensi yang ada.
- Kerjakan **bertahap**, bukan satu patch raksasa. Setiap tahap harus bisa diperiksa dan dilacak.

### Siklus kerja setiap tahap (kebiasaan yang sudah terbukti)
1. Verifikasi klaim eksternal lewat pencarian web/dokumentasi resmi sebelum menulis kode yang bergantung padanya (slug model, API discord.js, versi Node/npm). Slug model AI berubah cepat — **selalu verifikasi ulang**.
2. Implementasi + tes. Gunakan `node:test`. Database di tes = `node:sqlite` **asli** (file sementara); discord.js dan objek Discord = fake.
3. **Uji mutasi:** rusak kode secara sengaja (di salinan `/tmp`) dan pastikan tes yang tepat gagal. Mutasi yang lolos = celah tes → tambah tes. Pastikan tiap pola mutasi benar-benar menempel (assert jumlah kemunculan = 1), jangan sampai skrip mutasi diam-diam tidak menerapkan apa pun.
4. Jalankan pemeriksa identifier tak terdeklarasi (lihat bagian 8) pada semua berkas.
5. Kemas **zip datar** (tanpa folder pembungkus), **nama unik tiap versi**, uji dengan menimpa di atas proyek versi sebelumnya (`unzip -o`) lalu `npm test`.
6. Serahkan dengan `present_files` + panduan singkat: perintah `unzip -o ... -d ~/Ovelia`, hasil yang diharapkan (jumlah tes), cara memeriksa versi terpasang (mis. `grep -c`), langkah uji langsung, apa yang belum teruji.

### Larangan dan kehati-hatian khusus
- **Jangan** memasukkan berkas data runtime ke zip (`config.json`, `responders.json`, `blocklist.json`, `model_config.json`, `data/`, `.env`). Jangan menimpa data produksi.
- **Jangan** menyimpan jawaban verifikasi, isi pesan yang dihapus filter, atau token di database/log.
- Pesan moderasi ke pengguna = **template tetap**, bukan hasil AI. AI tidak ikut memutuskan tindakan moderasi.
- Ide "layanan AI tambahan" yang pengguna sudah minta dilupakan: **jangan dibahas lagi**.
- Jika pengguna melaporkan error dari server/Termux: baca pesannya teliti, cari akar masalah, **akui kesalahan sendiri dengan lugas** kalau memang salah, perbaiki, dan tambahkan tes agar tidak terulang. (Dua kasus nyata: `guild.members.me` null, dan skrip smoke yang usang.)

---

## 2. Konteks proyek dan pengguna

- **Bot:** "Ovelia" (`Ovelia#5212`), bot Discord untuk **satu server pribadi** (pengguna + teman, ≤15 orang, **tidak ada rencana publik**). Fungsi: chat AI berkarakter + sistem moderasi modular.
- **Pemilik:** BoltZyy (GitHub `BoltZyy`). Repo: `github.com/BoltZyy/Wispbyte-discord`. Berniat menambahkan lisensi **MIT** (belum ditambahkan).
- **Hosting:** Wispbyte (bukan serverless, proses jangka panjang, tampak berbasis panel gaya Pterodactyl). Perintah start di panel: `git pull` jika `AUTO_UPDATE=1`, `npm install` **setiap start**, lalu `node ${JS_FILE}`. Node image: 22 (terlihat v22.23.x). npm di server menampilkan peringatan "install scripts blocked" (perilaku npm v12) — tidak berbahaya.
- **Alur kerja pengguna:** terima zip dari Claude → simpan di `/storage/emulated/0/Download/claude/` → di Termux: `unzip -o <zip> -d ~/Ovelia` → `npm test`, `npm run smoke` → `git add -A && git commit && git push` → CI GitHub Actions → restart di Wispbyte (pull otomatis). Pengguna kadang mengunggah file lewat Spck; **folder pembungkus di zip menyulitkan**, makanya zip harus datar.
- **Termux** pengguna: Node v26.4.0, folder proyek `~/Ovelia`. Perangkatnya lambat untuk I/O: `npm test` penuh ~80 detik di sana (beberapa detik di sandbox) dan operasi backup SQLite kadang beberapa detik. **Tes tidak boleh bergantung pada kecepatan mesin** (gunakan polling/penantian, bukan asumsi milidetik).
- **Env di Wispbyte** (nama yang dipakai; nilai rahasia): `Discord_token`, `Gemini_API` (kunci Gemini pertama; bukan `Gemini_API_key`), `Gemini_API_2`, `Groq_API`, `Openrouter_API`, `COMMAND_PREFIX=!tanya`, `Personality`. Kode juga membaca nama baru huruf besar (lihat bagian 5).
- **Persona (env `Personality`, versi "B" yang dipilih pengguna):** "Kamu adalah asisten cewe Discord bernama Ovelia yang ramah dan membantu. Jawab dalam Bahasa Indonesia secara ringkas dan jelas. Kamu boleh menjadi sarkas dan tanpa filter. Tapi bersikaplah ramah ketika seseorang bersikap ramah." (Belum dikonfirmasi apakah sudah dipasang di env.)

---

## 3. Status pekerjaan

Legenda: ✅ terbukti live (pengguna mengonfirmasi di server/Termux) · 🧪 lolos tes di sandbox, **uji langsung belum dikonfirmasi** · ⏳ belum dikerjakan.

| Tahap | Isi | Status |
|---|---|---|
| 1 Stabilisasi | Migrasi ke `@google/genai`; daftar model diperbarui; timeout per percobaan (20 dtk) + total (60 dtk); tanpa retry tak terbatas; key rusak hanya dicoba 1× per pesan; OpenRouter selalu terakhir; log override aktif saat startup | ✅ |
| 2 Modularisasi | `index.js` (1381 baris) dipecah ke `src/` (lihat bagian 4); perilaku sama; CI GitHub (Node 22/24 + smoke paket asli) | ✅ |
| Fondasi data | SQLite (`node:sqlite`), migrasi, repository, `TtlStore` (pengganti Redis), backup gzip + jadwal + batas waktu | ✅ persistensi di Wispbyte terbukti (`start ke-7`, WAL, schema v3 kala itu) |
| Moderasi dasar | `/warn`, `/warnings`, `/warning-remove`, `/modconfig`, `/backup`, backup terjadwal, audit log, pemeriksaan izin + hierarki | 🧪 (tidak ada konfirmasi uji eksplisit per perintah) |
| 3 Verification utama | `/verification setup/question/panel/status`, sesi 120 dtk, maks 3 salah, cooldown 15 dtk, role Verified | ✅ (setup, panel, alur verifikasi dicoba live) |
| 4 Kata terlarang | Mesin `exact`/`evasion`, `/banned-word add/edit/remove/list/test/exempt-role/exempt-channel` | 🧪 |
| 5 Filter + challenge + pass | Hapus pesan melanggar, notifikasi publik + tombol challenge, pass per aturan, `/modpass`, edit pesan ikut disaring | 🧪 |
| 6 Softban-verifikasi | `/softban-verify`, persetujuan staf, pemeriksaan batas akses | 🧪 — pengguna melaporkan 2 masalah dari Termux (tes backup lambat, skrip smoke usang); **zip perbaikan `ovelia-stage6b-fix.zip` sudah dikirim, hasil penerapannya belum dilaporkan** |
| 7 Ticket | — | ⏳ |
| 8 Ban + softban klasik | — | ⏳ |
| 9 Integrasi/deploy | — | ⏳ |

**Urutan zip yang pernah dikirim** (yang terakhir = terbaru, snapshot penuh): `ovelia-stage1-storage.zip` → `ovelia-stage2-moderation.zip` → `ovelia-stage2b-backup-timeout.zip` → `ovelia-stage3-verification.zip` → `ovelia-stage3b-fix-members-me.zip` → `ovelia-stage4-banned-words.zip` → `ovelia-stage5-filter-challenge.zip` → `ovelia-stage6-softban-verify.zip` → **`ovelia-stage6b-fix.zip`** (terbaru). Semuanya zip datar, penuh (bukan patch), tanpa data runtime.

---

## 4. Struktur proyek

```
index.js                     entry: dotenv DULU, lalu ./src/main; ekspor kompatibilitas untuk tes
src/
  main.js                    merangkai semuanya: client, handler, command, storage, scheduler
  config/env.js              validasi env
  core/                      (lapisan 0 — tanpa dependensi ke lapisan lain)
    owner.js                 pengenalan owner via Discord ID + sesi
    rateLimit.js, conversations.js, text.js
    ttlStore.js              Map ber-TTL di memori (pengganti Redis)
    answer.js                normalisasi + hash scrypt jawaban verifikasi
    wordMatch.js             pencocokan kata terlarang (exact/evasion), tanpa regex pengguna
    challenge.js             generator soal pilihan ganda (4 opsi)
  storage/                   (lapisan 0)
    files.js                 ROOT_DIR + jalur JSON runtime; loadJSON/saveJSON
    state.js                 state JSON lama (welcome, responders, blocklist, modelConfig)
    db.js                    adaptor node:sqlite: migrasi, transaction(), backupTo()
    migrations.js            skema v1–v6 (lihat bagian 5)
    repositories.js          settings, audit, warnings, verification, rules, passes, softbans
    index.js                 initStorage(): TIDAK pernah melempar (gagal -> null)
    backup.js                backup konsisten + gzip + pembersihan berkas sisa
  ai/                        (lapisan 1)
    models.js                PROVIDER_MODEL_TIERS (sumber tunggal slug model)
    providers.js             Gemini (@google/genai), Groq, OpenRouter; registry dari env
    router.js                rencana model, fallback, timeout, skip saat error key
    persona.js               persona bawaan + konteks owner
  discord/                   (lapisan 2)
    commands.js              definisi 11 slash command inti
    interactions.js          handler interaksi inti; rantai ekstensi (lihat bawah)
    messages.js              handler pesan AI; memanggil wordFilter.screen DULU
    presence.js, permissions.js
    moderation.js            /warn /warnings /warning-remove /modconfig /backup + scheduler backup
    verification.js          /verification + tombol & modal verify:*
    bannedWords.js           /banned-word + mesin evaluasi aturan (cache per server)
    wordFilter.js            screen() pesan, challenge bw:*, /modpass
    softbanVerify.js         /softban-verify + tombol sbv:*
scripts/
  smoke-real-deps.js         smoke dengan paket ASLI (npm run smoke; juga di CI)
  smoke-stub-preload.js      stub berbentuk JSON discord.js untuk test/smoke-stub.test.js
test/                        *.test.js + fixtures/*.golden.json (definisi command)
.github/workflows/ci.yml     tes Node 22 & 24; job smoke paket asli
```

**Aturan lapisan** (dijaga oleh tes): `config/core/storage` (0) → `ai` (1) → `discord` (2) → `main.js` (3). Tidak boleh ada dependensi melingkar atau ke atas.

**Pola yang konsisten dipakai:**
- Modul dibuat lewat `createX({ storage, now, log, ... })` (dependency injection; `now` = jam yang disuntik agar tes tidak menunggu).
- Modul interaksi mengekspos `handle(interaction)` yang mengembalikan `true` bila interaksi miliknya. `interactions.js` merantai: `moderation → verification → bannedWords → wordFilter → softbanVerify`, lalu logika lama.
- `messages.js`: `if (wordFilter && await wordFilter.screen(message)) return;` di awal (pesan yang dihapus tidak boleh dijawab AI).
- Kegagalan database **tidak** menghentikan bot: `initStorage()` → `null`, fitur AI tetap jalan, fitur moderasi menjawab "nonaktif: database tidak tersedia".
- Setiap perubahan data penting + audit log dalam **satu transaksi** (`storage.db.transaction`). Efek ke Discord (role, hapus pesan) dilakukan **setelah** data tersimpan; kalau penyimpanan gagal, tidak ada efek.
- Pemeriksaan izin dilakukan **di handler** (bukan hanya `setDefaultMemberPermissions`).

**Konfigurasi klien (`main.js`):** intents `Guilds, GuildMembers, GuildMessages, MessageContent`; `partials: [Channel, Message]`; cache dibatasi (`GuildMemberManager: 0`, `MessageManager: 0`, `PresenceManager: 0`, `UserManager: 50`, `ReactionManager: 0`). **Ini sumber banyak jebakan — lihat bagian 8.**

---

## 5. Fondasi data

### Berkas runtime di root proyek (di-`.gitignore`, JANGAN dibawa zip)
`config.json` (welcome, presence), `responders.json`, `blocklist.json`, `model_config.json` (override model dari `/model`). `config.json` dan `model_config.json` sempat terlacak git lalu dikeluarkan dari pelacakan; pull otomatis Wispbyte bisa menghapus/memblokir bila salah penanganan.

### SQLite — `data/ovelia.sqlite` (env `DB_PATH`)
- Driver: **`node:sqlite` bawaan Node** (butuh Node ≥ 22.16; mencetak satu `ExperimentalWarning` saat start — normal). Alasan bukan `better-sqlite3`: npm v12 di Wispbyte memblokir install scripts paket native.
- WAL, `foreign_keys=ON`, `busy_timeout=5000`, tabel `STRICT`. ID Discord = `TEXT` (snowflake). Waktu = epoch milidetik.
- Log startup: `[DB] SQLite siap: … (schema vN, journal=wal, start ke-K)` — penghitung `start ke-K` tersimpan di DB (bukti persistensi).
- **Migrasi** (versi di `PRAGMA user_version`; **jangan pernah mengubah migrasi yang sudah dirilis**, tambah yang baru):

| v | Tabel | Catatan |
|---|---|---|
| 1 | `guild_settings`, `moderation_logs` | settings = pasangan kunci→JSON per server; log = audit trail seluruh fitur |
| 2 | `warnings` | status `active/removed/expired` (`expired` dicadangkan, logikanya belum ada) |
| 3 | `verification_records` | status termasuk `pending_approval/approved/rejected` (dicadangkan); **tanpa jawaban peserta** |
| 4 | `banned_word_rules` | mode `exact/evasion/regex` (`regex` dicadangkan, **ditolak** oleh kode); `allow_pass`, `pass_days`, pengecualian role/channel (JSON) |
| 5 | `moderation_passes` | pass per (guild, user, rule); indeks unik parsial untuk pass aktif; `ON DELETE CASCADE` ke aturan |
| 6 | `verify_softbans` | status `awaiting_verification/pending_approval/approved/rejected/cancelled`; indeks unik parsial: satu kasus **memblokir** (awaiting, pending, rejected) per anggota |

- **Kunci `guild_settings` yang dipakai:** `modlog.channelId`, `backup.channelId`, `backup.lastAt`, `verify.roleId`, `verify.channelId`, `verify.question`, `verify.answer` (objek `{salt, hash}`), `verify.publicChannelIds` (array), `_system/boot_count`.
- **Aksi `moderation_logs`:** `warn`, `warning_remove`, `config_change`, `backup`, `verification_pass/fail/timeout/role_failed`, `banned_word_add/edit/remove/exempt/hit`, `challenge_pass/fail/timeout`, `pass_revoke`, `softban_verify_start/role_removed/restriction_check/pending/approve/reject/cancel/role_restored/role_restore_failed`.
- **Komponen (customId):** `verify:start`, `verify:answer:<sid>`, `verify:submit:<sid>`, `verifycfg:question`, `bw:start:<ruleId>:<userId>`, `bw:ans:<ruleId>:<sid>:<idx>`, `sbv:approve:<caseId>`, `sbv:reject:<caseId>`. Jawaban benar challenge **tidak** ada di customId.
- Repository (`storage.*`): `settings`, `audit`, `warnings`, `verification`, `rules`, `passes`, `softbans`, plus `storage.db` (`transaction`, `prepare`, `backupTo`) dan `storage.close()`.

### `TtlStore` (memori, bukan Redis)
Sesi verifikasi, sesi challenge, cooldown, anti-amplifikasi notifikasi. Hilang saat restart (disengaja, gagal-tertutup). Tidak ada Redis: bot satu proses, tidak perlu.

### Backup
`createCompressedBackup` (API backup SQLite → gzip, di `data/backups`, berkas sisa >1 jam dibersihkan otomatis). `/modconfig backup-channel` mengatur channel **privat**; `/backup` manual (hanya owner bot/pemilik server); terjadwal tiap `BACKUP_INTERVAL_HOURS` (default 24; 0 = mati), retry paling cepat 1 jam setelah gagal, batas ukuran `BACKUP_MAX_MB` (8), batas waktu `BACKUP_TIMEOUT_SECONDS` (120) — proses yang melewati batas dicatat gagal dan antrean tidak macet. Pemulihan: hentikan bot, `gunzip -c ovelia-XXXX.sqlite.gz > data/ovelia.sqlite`.

### Variabel env (nama baru huruf besar didahulukan; nama lama masih dibaca)
`DISCORD_TOKEN`/`Discord_token`; `GEMINI_KEY_1`/`Gemini_API`; `GEMINI_KEY_2`/`Gemini_API_2`; `GROQ_KEY`/`Groq_API`; `OPENROUTER_KEY`/`Openrouter_API`; `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`; `COMMAND_PREFIX` (`!tanya`); `SYSTEM_PROMPT` → `Personality` → persona bawaan; `OWNER_ID`; `MAX_HISTORY` (6); `AI_ATTEMPT_TIMEOUT_MS` (20000); `AI_TOTAL_TIMEOUT_MS` (60000); `DB_PATH`; `BACKUP_*`; `BOT_NO_AUTOSTART` (hanya untuk tes). Contoh lengkap: `.env.example`.

---

## 6. Fitur dan perintah (20 slash command)

**Inti (11, kode lama, definisi dijaga golden):** `echo`, `setwelcome`, `testwelcome`, `create`, `edit`, `list`, `delete` (auto-responder `Ovelia <trigger>`), `blockuser`, `unblockuser` (blokir penggunaan AI), `model` (override model; khusus owner), `resethistory`.

**Moderasi:** `warn`, `warnings`, `warning-remove` (izin ModerateMembers; tolak diri sendiri/bot/pemilik/role setara-lebih tinggi); `modconfig modlog-channel|backup-channel|show` (ManageGuild); `backup` (owner bot/pemilik server).

**`verification`** (ManageGuild): `setup role [channel]`, `question` (modal pertanyaan + jawaban rahasia), `panel`, `public channel [remove]` (channel yang sengaja boleh dilihat anggota belum terverifikasi), `status`. Alur peserta: tombol → pertanyaan ephemeral → tombol Jawab → modal. Sesi 120 dtk, maks 3 salah, cooldown 15 dtk (termasuk karena waktu habis). Jawaban dicocokkan setelah normalisasi (NFKC, huruf kecil, rapatkan spasi, buang karakter lebar-nol) dan disimpan sebagai **hash scrypt**. Role diberikan hanya setelah hasil tersimpan di DB.

**`banned-word`** (ManageGuild): `add/edit/remove/list/test/exempt-role/exempt-channel`. Mode `exact` (frasa utuh pada batas kata) dan `evasion` (NFKC, aksen, karakter tak terlihat, huruf Cyrillic/Yunani mirip Latin, leet `0 1 3 4 5 7 @ $` dan `l/1/i`, huruf berulang, pemisah di antara huruf: maks 3 karakter dalam kata, 5 antar kata; harus pada awal/akhir kata; **tanpa regex** → linear, aman dari ReDoS). Frasa ≥2 (exact) / ≥3 (evasion) huruf-angka, maks 100 karakter, maks 100 aturan per server. `reason` aturan **ditampilkan publik** di notifikasi (tulis generik, jangan memuat pola).

**Filter pesan (`wordFilter.screen`)**: pesan (dan edit ber-isi) dicocokkan; pesan biasa berhenti tanpa REST. Jika cocok: ambil data anggota via REST (satu kali), kecualikan **pemilik server dan anggota ber-izin ManageMessages**, kecualikan role/channel (termasuk induk thread) yang dikecualikan aturan, lewati pass aktif (hanya jika aturan `allow-pass`), lalu hapus, catat audit `banned_word_hit` (tanpa isi pesan), kirim notifikasi publik singkat (maks 1 per anggota per 30 dtk; tombol challenge jika `allow-pass`). Gagal hapus (50013) → audit `failed` + peringatan ke modlog (sekali per 10 menit per channel). Gagal ambil data anggota (selain 10007 = sudah keluar) → **gagal-aman, tidak menghapus**.

**Challenge + pass:** soal pilihan ganda 4 opsi (hitungan/angka terbesar/tombol berwarna), dibuat ulang tiap percobaan; hanya penulis pesan yang boleh memulai; **60 dtk, 2 percobaan, cooldown 15 dtk** (konfigurasi terpisah dari verification utama; angka ini asumsi Claude, belum dikonfirmasi pengguna). Timeout aktif lewat penjadwal; gagal/timeout → notifikasi ke modlog. Lolos → pass (`pass-days`, default 30) untuk **satu aturan**, dibaca langsung dari DB (pencabutan seketika). `/modpass list|info|revoke` (ManageGuild). `/modpass grant` **sengaja belum dibuat**.

**`softban-verify`** (ModerateMembers): `start user [reason]`, `approve case`, `reject case [reason]`, `cancel case [reason]`, `status [user]`; tombol Setujui/Tolak (`sbv:*`) di modlog. **Invarian utama: role Verified TIDAK kembali tanpa keputusan staf yang tercatat.** Verifikasi biasa tidak boleh memberi role selama ada kasus memblokir (awaiting/pending/rejected); anggota yang lolos verifikasi ulang → kasus `pending_approval` + notifikasi staf; `approve` hanya dari `pending_approval`; tidak bisa memutuskan kasus sendiri; keputusan disimpan DB dulu baru role dipulihkan (gagal → bisa diulang); `cancel` memulihkan langsung (keputusan staf, dari awaiting/pending/rejected). Setelah pencabutan role, bot **menghitung channel yang masih terlihat** oleh anggota (kriteria: `ViewChannel`; kecuali channel verifikasi dan `verify.publicChannelIds`; kategori & thread diabaikan) dan melaporkan kebocoran (audit `partial`); bot **tidak** mencabut role lain otomatis. Pengumuman ke anggota di channel verifikasi (tanpa DM).

**Chat AI (kode inti):** dipicu mention atau prefix `!tanya`. Rencana per pesan: provider selain OpenRouter diacak (load balancing antar kunci), OpenRouter selalu terakhir; override `/model` jadi percobaan pertama. Per percobaan 20 dtk, total 60 dtk, tanpa retry SDK (`maxRetries: 0`); error 401, atau 400/403 yang pesannya menyebut "API key" → lewati sisa model provider itu. Model (diverifikasi Okt 2026, **cek ulang sebelum mengandalkan**): Gemini otomatis `gemini-3.6-flash`, `gemini-3.5-flash-lite`; manual saja `gemini-3.8-flash`, `gemini-3.1-flash-lite` (berhenti 7 Mei 2027); Groq `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`; OpenRouter `openrouter/free` (slug `:free` Llama sudah 404). Riwayat 6 giliran per (channel, user) di memori (idle 30 mnt), rate limit 5/menit/pengguna, owner dikenali via Discord ID (peniru ditangani).

---

## 7. Keputusan desain yang sudah disepakati (dan asumsi yang belum)

**Disepakati dengan pengguna:**
- Server pribadi ≤15 orang, bukan bot publik → konfigurasi per-guild tetap disimpan (kolom `guild_id`) tapi tanpa UI multi-server.
- Mesin deteksi **di dalam bot**, bukan Discord AutoMod (alasan: bisa diuji offline, penormalisasi variasi tulisan, pass per anggota di SQLite, tanpa izin Manage Guild). Saran tanpa kode: boleh buat 1 aturan AutoMod manual sebagai jaring pengaman saat bot mati.
- **Tanpa Redis** (cukup `TtlStore`); **tanpa mode regex** (Node tidak bisa membatasi waktu regex); **SQLite lewat `node:sqlite`**.
- Pass: **per aturan**, dengan flag `allow-pass` per aturan (aturan scam tidak boleh punya pass) **dan** masa berlaku.
- Challenge kata terlarang: tombol pilihan ganda sederhana, terikat ke pengguna, ada batas waktu dan percobaan; **bukan** perlindungan anti-bot kuat.
- Backup: ke channel privat Discord, terjadwal + manual (`/backup`).
- Tanpa DM ke anggota (peringatan, challenge, softban-verifikasi).
- Teks `Personality` versi B (lihat bagian 2).

**Asumsi Claude yang BELUM dikonfirmasi pengguna (boleh diubah):** angka challenge 60 dtk/2 percobaan/15 dtk; staf yang dikecualikan filter = pemilik server + ManageMessages; `reason` aturan tampil publik; notifikasi 1 per 30 dtk; batas 100 aturan/server; `cancel` softban boleh dari status ditolak; kriteria "akses terbatas" = tidak bisa **melihat** channel; `/modpass grant` ditunda.

---

## 8. Jebakan teknis dan pelajaran (BACA SEBELUM MENULIS KODE DISCORD)

**Perilaku discord.js dengan konfigurasi cache bot ini:**
1. `guild.members.me` selalu **`null`** (cache anggota 0). Gunakan `fetchBotMember(guild)` (`guild.members.fetchMe()`) dari `src/discord/permissions.js`. `channel.permissionsFor(null)` mengembalikan `null` → seolah "tidak ada izin".
2. **Jangan pakai `Role#editable`** — melempar `TypeError` saat `me` null. Pakai `botCanManageRole(botMember, role, guild)` (bukan managed/@everyone, punya ManageRoles, posisi role bot > role target).
3. `message.member` selalu `null`. Data anggota hanya lewat `guild.members.fetch(id)` (REST) — lakukan **hanya bila perlu** (setelah pesan cocok aturan). Anggota sudah keluar = error kode `10007`.
4. Event `messageUpdate` **tidak terkirim** untuk pesan yang tak ada di cache kecuali `Partials.Message` aktif (sudah diaktifkan; dijaga tes statis). Edit tanpa `content` (mis. embed otomatis) tak bisa dinilai.
5. Pakai `flags: MessageFlags.Ephemeral` (bukan `ephemeral: true`), `Events.ClientReady` (bukan `'ready'`), jangan pakai `setDMPermission`.
6. Kode error umum: `50013` Missing Permissions, `10008` Unknown Message (anggap sudah terhapus), `10007` Unknown Member.
7. Bot mengabaikan pesan bot/webhook/sistem/DM.
8. Batas Discord: label input modal ≤45 karakter (pertanyaan verifikasi ditampilkan di pesan, bukan label); `delete_message_seconds` ban maks 604800 (7 hari) — relevan untuk tahap 8.

**Praktik uji:**
- **Objek palsu harus meniru perilaku asli** (dua bug nyata lolos karena fake terlalu ramah: `members.me`, `role.editable`). Saat menambah fake, tiru kasus-kasus di atas.
- Golden fixture definisi command: `test/fixtures/*.golden.json`. Bila definisi command **sengaja** diubah, regenerasi per berkas tes: `UPDATE_GOLDEN=1 node --test test/<berkas>.test.js` (command inti: `stage1.test.js`).
- `scripts/smoke-real-deps.js` memuat daftar yang **diharapkan** (nama command, subcommand). Setiap kali menambah/mengubah command, **perbarui daftar itu** — sekarang `test/smoke-stub.test.js` menjalankannya dengan stub berbentuk JSON discord.js dan akan gagal bila usang (kasus nyata: subcommand `public` terlewat).
- Tes tidak boleh bergantung pada kecepatan mesin (Termux lambat). Pakai penantian/polling (`eventuallyEmpty` di `moderation.test.js`), bukan asumsi milidetik.
- Pemeriksa identifier tak terdeklarasi (`nounde.js`) **bukan bagian repo** dan hilang saat sandbox reset. Ia memakai acorn bawaan Node: `node --expose-internals nounde.js <berkas...>`, menganalisis scope dan melaporkan identifier bebas yang tak dideklarasikan. Buat ulang bila diperlukan (atau usulkan memasukkannya ke `scripts/`).
- Tes lama jangan diubah tanpa alasan; bila tes lama gagal setelah perubahan, selidiki dulu apakah perilaku ikut berubah.

**Sandbox:** tanpa internet untuk `bash` (hanya `web_search`/`web_fetch`). Hanya satu versi Node (22.x) → Node 20/24/26 tidak teruji lokal (CI menguji 22 dan 24). Berkas di luar `/mnt/user-data/outputs` bisa hilang saat reset.

---

## 9. Rencana ke depan

### Uji langsung yang masih tertunda (minta pengguna menjalankan)
- Terapkan `ovelia-stage6b-fix.zip` → `npm test` (harapan **184** lulus) → `npm run smoke` (harapan baris `OK — … 11 + 5 + 1 + 1 + 1 + 1 slash command …`).
- **Tahap 4–5 (belum ada konfirmasi live):** `/banned-word add` aturan uji (mis. frasa aman) mode `evasion` + `allow-pass`; `/banned-word test`; kirim dari **akun kedua non-staf** (admin/ManageMessages dikecualikan!) termasuk variasi (`k4ta uj1`); cek pesan terhapus + notifikasi + tombol; coba tombol dari akun lain (harus ditolak); challenge benar/salah/diamkan 1 menit; `/modpass list|revoke`; edit pesan biasa menjadi melanggar; bot butuh izin **Manage Messages** di channel.
- **Tahap 6:** akun kedua yang sudah Verified: `/softban-verify start` → role hilang + pengumuman; verifikasi ulang benar → role **tidak** kembali + tombol di modlog; `approve` oleh moderator → role pulih; coba `reject`/`cancel`; cek peringatan "Akses belum terbatas" (role lain/izin channel; tandai channel publik dengan `/verification public`). Prasyarat: role bot di atas role Verified + Manage Roles; channel dibatasi (@everyone hanya lihat channel verifikasi); `/modconfig modlog-channel` diatur.
- Konfirmasi: `Personality` sudah B? Override model (`/model status`) perlu di-reset? Env timeout uji (`AI_*`) sudah dihapus?
- Moderasi dasar (`/warn` dll.) belum pernah dikonfirmasi per perintah.

### Tahap berikutnya (sesuai rencana pengguna — detail dari dokumen rencana asli)
**Tahap 7 — Ticket sederhana** (tanpa claim/reopen/transcript):
- Panel tombol "buka ticket"; bot membuat channel privat; anggota + staf berwenang bisa membaca/menulis; anggota lain tidak bisa membaca.
- **Satu ticket aktif per anggota per server.**
- Tombol close (anggota atau staf yang diizinkan); status tercatat (siapa yang menutup, kapan).
- Tangani kegagalan Discord saat membuat channel (izin, batas jumlah channel); audit semua tindakan penting.
- SQLite menyimpan metadata (guild, user, channel, dibuat, status, ditutup, penutup). Redis/TtlStore bukan sumber data utama.
- Usulan teknis Claude (belum disepakati): migrasi v7 `tickets` (+ indeks unik parsial ticket terbuka per anggota), modul `src/discord/tickets.js` dengan pola `createTickets({storage})`, perintah `/ticket panel|close|status`, tombol `tk:*`; ingat jebakan cache (ambil anggota/bot lewat REST/`fetchMe`, izin channel lewat permission overwrites; verifikasi di dokumentasi sebelum menulis).

**Tahap 8 — `/ban` dan softban klasik** (izin BanMembers; hierarki; audit):
- `/ban`: melarang bergabung kembali; alasan; catat moderator/target/waktu/alasan; **default tidak menghapus riwayat pesan** (hanya bila diminta eksplisit).
- `/softban` klasik: ban dengan `deleteMessageSeconds` (maks **7 hari**, jangan menjanjikan lebih) lalu unban; catat tahap yang berhasil dan yang gagal bila terhenti di tengah (hasil `partial`).
- Perhatikan hierarki, bot tak bisa menindak role lebih tinggi, pemilik server tak bisa ditindak. (Berbeda dari `softban-verify`.)

**Tahap 9 — Integrasi dan deploy:** jalankan seluruh tes; periksa env; pastikan tak ada rahasia di repo; uji alur lengkap di server percobaan; periksa persistensi setelah restart; uji saat database tidak tersedia; periksa log error; deploy bertahap.

### Backlog opsional (belum diminta/diputuskan)
- Menambahkan `LICENSE` MIT (pengguna berniat; tawarkan membuatkan berkasnya).
- `/modpass grant` (hanya bila pengguna mau staf memberi pass manual).
- Memecah `interactions.js` (335 baris, satu fungsi) per perintah — **ditunda**: 10 dari 11 command inti belum punya tes perilaku (hanya `/model` teruji); rekomendasi: tulis tes karakterisasi dulu, refaktor hanya bila mulai mengubah/menambah command inti.
- Cooldown verifikasi yang bertambah (eskalasi), logika kedaluwarsa warning, dokumen/perintah pemulihan backup, README, masukkan `nounde.js` ke `scripts/`.
- Pengecekan berkala: `npm audit`, slug model AI, kelayakan `gemini-3.8-flash` untuk fallback otomatis (saat ini manual-only; pernah timeout 20 dtk), mutu `qwen3.8-27b` (batas `max_tokens` 800).

---

## 10. Referensi cepat

**Perintah rutin (di folder proyek):**
```
npm test                 # node --test ; harapan saat ini: 184 tes lulus (sandbox ~9 dtk, Termux ~80 dtk)
npm run smoke            # butuh `npm install` (paket asli, tanpa jaringan Discord)
UPDATE_GOLDEN=1 node --test test/<berkas>.test.js   # regenerasi golden command
unzip -o /storage/emulated/0/Download/claude/<zip> -d ~/Ovelia
```

**Rincian tes saat ini (blok `test`/`for`):** stage1 (48; harness inti + smoke main + golden 11 command + tes statis), storage (17), moderation (21), verification (21), bannedwords (13), wordmatch (14), wordfilter (25), softbanverify (23), smoke-stub (2). Total 184 (48+17+21+21+13+14+25+23+2; jumlah ini diverifikasi dengan menjalankan tiap berkas, bukan perkiraan).

**Membuat versi baru:** tiru siklus di bagian 1: implementasi → tes → mutasi → pemeriksa identifier → zip datar bernama unik (mis. `ovelia-stage7-ticket.zip`) → uji timpa di atas zip sebelumnya → `present_files` → panduan.

**Memeriksa versi yang terpasang pengguna:** minta `grep -c <penanda> <berkas>` atau `sha256sum`, dan jumlah tes dari `npm test` (nama zip bisa tertukar bila duplikat; pernah terjadi).

**CI (`.github/workflows/ci.yml`):** `actions/checkout@v6`, `actions/setup-node@v6`; job `test` (Node 22, 24; tanpa `npm install` karena SDK di-stub) dan job `real-deps` (`npm install` + `npm run smoke` dengan paket asli). `package.json` `engines.node >=22.16.0`.

---

## 11. Prompt pembuka untuk sesi baru (tempel ini)

> Halo Claude. Ini kelanjutan proyek bot Discord "Ovelia" (Node.js, discord.js, hosting Wispbyte). Saya lampirkan `HANDOVER.md` (serah-terima lengkap) dan zip proyek terbaru. Tolong:
> 1. Baca `HANDOVER.md` sampai habis, terutama bagian 1 (aturan kerja) dan bagian 8 (jebakan teknis).
> 2. Ekstrak zip ke `/home/claude/work`, jalankan `npm test`, dan laporkan jumlah tes yang lulus.
> 3. Ringkas pemahamanmu tentang status proyek dalam beberapa baris dan sebutkan hal yang belum terbukti live.
> 4. Tanyakan apa yang ingin saya kerjakan dulu (uji langsung tahap 4–6, tahap 7 ticket, tahap 8 ban/softban, atau lainnya). Jangan mulai mengubah kode sebelum saya jawab.
>
> Saya memakai ponsel (Termux/Spck); jawab dengan Bahasa Indonesia yang ringkas, bedakan fakta/asumsi/belum teruji, dan kirim hasil sebagai zip datar bernama unik.

---

*Dokumen ini dibuat dari kondisi kode aktual (daftar berkas, migrasi, env, kunci pengaturan, aksi audit, dan komponen diekstrak langsung dari repositori) dan dari keputusan selama sesi. Bila kode berubah, perbarui dokumen ini bersamaan dengan zip.*
