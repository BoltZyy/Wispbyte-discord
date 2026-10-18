'use strict';


/* =========================================================================
 * MANUAL RATE LIMITER — mencegah spam token AI (auto-cleanup, bounded)
 * ========================================================================= */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // jendela 1 menit
const RATE_LIMIT_MAX_HITS  = 5;         // maksimal 5 request AI per user per menit
const rateLimitStore = new Map(); // userId -> { count, windowStart }

function isRateLimited(userId) {
  const now   = Date.now();
  const entry = rateLimitStore.get(userId);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(userId, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_HITS;
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of rateLimitStore) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitStore.delete(userId);
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  RATE_LIMIT_MAX_HITS,
  isRateLimited,
};
