'use strict';

const {
  ActivityType,
} = require('discord.js');

/* =========================================================================
 * BOT PRESENCE / ACTIVITY STATUS — modular, tanpa dependency baru.
 * Sumber data: welcomeConfig.activity (dari config.json, lihat ensureActivityConfig).
 * Tipe yang didukung Discord untuk bot: PLAYING, STREAMING, LISTENING,
 * WATCHING, COMPETING (built-in discord.js ActivityType enum).
 * ========================================================================= */
const ACTIVITY_TYPE_MAP = {
  PLAYING:   ActivityType.Playing,
  STREAMING: ActivityType.Streaming,
  LISTENING: ActivityType.Listening,
  WATCHING:  ActivityType.Watching,
  COMPETING: ActivityType.Competing,
};

function resolveActivityType(rawType) {
  const key = String(rawType || 'WATCHING').toUpperCase().trim();
  return ACTIVITY_TYPE_MAP[key] ?? ActivityType.Watching; // fallback aman kalau typo di config.json
}

function applyActivity(client, entry) {
  if (!entry || !entry.text) return;
  const type = resolveActivityType(entry.type);

  // STREAMING tanpa url valid akan ditolak/diabaikan Discord — fallback ke
  // WATCHING supaya presence tetap tampil, bukan diam-diam gagal.
  if (type === ActivityType.Streaming && !entry.url) {
    console.warn(`[Presence] "${entry.text}" bertipe STREAMING tapi tidak ada "url" di config.json — fallback ke WATCHING.`);
    client.user.setActivity(entry.text, { type: ActivityType.Watching });
    return;
  }

  client.user.setActivity(entry.text, {
    type,
    ...(type === ActivityType.Streaming ? { url: entry.url } : {}),
  });
}

/**
 * startActivityRotation — set activity sekali di awal, lalu (kalau
 * activity.rotate !== false dan list-nya lebih dari 1) berganti otomatis
 * tiap activity.intervalSeconds detik. .unref() supaya interval ini tidak
 * menahan proses tetap hidup saat shutdown, konsisten dengan sweeper lain
 * di file ini (ownerSessionStore, rateLimitStore).
 */
function startActivityRotation(client, activityConfig) {
  const list = Array.isArray(activityConfig?.list)
    ? activityConfig.list.filter((entry) => entry?.text)
    : [];

  if (list.length === 0) {
    console.warn('[Presence] Tidak ada activity valid di config.json — presence tidak diset.');
    return;
  }

  let index = 0;
  applyActivity(client, list[index]);

  const shouldRotate = activityConfig?.rotate !== false && list.length > 1;
  if (!shouldRotate) return;

  const intervalMs = Math.max(10, Number(activityConfig?.intervalSeconds) || 30) * 1000;
  setInterval(() => {
    index = (index + 1) % list.length;
    applyActivity(client, list[index]);
  }, intervalMs).unref();
}

module.exports = {
  startActivityRotation,
};
