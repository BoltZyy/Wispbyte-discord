'use strict';

const fs   = require('fs');
const path = require('path');

/* =========================================================================
 * FILE STORAGE — config.json, responders.json & blocklist.json
 * ========================================================================= */
// Root proyek (folder yang berisi index.js). File data runtime (config.json,
// responders.json, blocklist.json, model_config.json) TETAP di sini, bukan di src/.
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_PATH       = path.join(ROOT_DIR, 'config.json');
const RESPONDERS_PATH   = path.join(ROOT_DIR, 'responders.json');
const BLOCKLIST_PATH    = path.join(ROOT_DIR, 'blocklist.json');
const MODEL_CONFIG_PATH = path.join(ROOT_DIR, 'model_config.json');

function loadJSON(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[Storage] Failed to load ${filePath}:`, err.message);
  }
  return defaultValue;
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  BLOCKLIST_PATH,
  CONFIG_PATH,
  MODEL_CONFIG_PATH,
  RESPONDERS_PATH,
  loadJSON,
  saveJSON,
};
