'use strict';


/* =========================================================================
 * UTIL: splitMessage
 * ========================================================================= */
const DISCORD_LIMIT = 2000;

function splitMessage(text, limit = DISCORD_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Placeholder yang didukung di template welcome message:
 *   {user} atau {mention}  -> mention nyata (ping) member baru, contoh: <@123456789>
 *   {userId}               -> ID mentah member baru (tanpa ping), contoh: 123456789
 *   {username}             -> nama akun Discord member baru (tanpa ping)
 *   {server}               -> nama guild/server
 *
 * String hasil replace ini dikirim apa adanya lewat channel.send()/reply(), dan
 * karena tidak ada allowedMentions.parse yang dibatasi di level Client, token
 * <@id> di dalamnya akan benar-benar mem-ping user tersebut saat dikirim.
 */
function formatWelcomeMessage(template, member) {
  return template
    .replace(/{mention}/g, `<@${member.id}>`)
    .replace(/{user}/g,    `<@${member.id}>`)
    .replace(/{userId}/g,  member.id)
    .replace(/{username}/g, member.user?.username ?? member.displayName ?? 'member')
    .replace(/{server}/g,  member.guild.name);
}

function stripBotMention(content, botUserId) {
  return content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
}

module.exports = {
  formatWelcomeMessage,
  splitMessage,
  stripBotMention,
};
