'use strict';


/* =========================================================================
 * ENV VALIDATION
 * ========================================================================= */
function validateEnv() {
  if (!process.env.DISCORD_TOKEN && !process.env.Discord_token) {
    console.error('❌ DISCORD_TOKEN not found in environment');
    process.exit(1);
  }
}

module.exports = {
  validateEnv,
};
