'use strict';

const { BLOCKLIST_PATH, CONFIG_PATH, MODEL_CONFIG_PATH, RESPONDERS_PATH, loadJSON, saveJSON } = require('./files');

let welcomeConfig = loadJSON(CONFIG_PATH, {
  welcome: {
    channelId: null,
    message: 'hai {mention}, selamat datang di server A',
  },
  activity: {
    rotate: true,
    intervalSeconds: 30,
    list: [
      { type: 'WATCHING',  text: 'over BoltZy ~' },
      { type: 'LISTENING', text: '/model dan /setwelcome' },
      { type: 'PLAYING',   text: 'dengan AI fallback engine' },
    ],
  },
});
let responders = loadJSON(RESPONDERS_PATH, {});
let blocklist  = loadJSON(BLOCKLIST_PATH, {});

// modelConfig = { activeProviderType, activeModelId } | keduanya null = pakai
// urutan fallback otomatis (shuffle antar-provider, tanpa override manual).
let modelConfig = loadJSON(MODEL_CONFIG_PATH, {
  activeProviderType: null,
  activeModelId: null,
});

function saveWelcomeConfig() { saveJSON(CONFIG_PATH,       welcomeConfig); }
function saveResponders()    { saveJSON(RESPONDERS_PATH,   responders);    }
function saveBlocklist()     { saveJSON(BLOCKLIST_PATH,    blocklist);     }
function saveModelConfig()   { saveJSON(MODEL_CONFIG_PATH, modelConfig);   }

// BUG GUARD: kalau config.json sudah ada dari deploy SEBELUM fitur presence
// ini ditambahkan, loadJSON() cuma mengembalikan isi file apa adanya — key
// "activity" tidak otomatis muncul dari default di atas karena file sudah
// ada duluan. Tanpa guard ini, welcomeConfig.activity akan undefined dan
// bikin startActivityRotation() crash saat startup. Backfill sekali, lalu
// simpan supaya file di server ikut ter-update.
function ensureActivityConfig() {
  const hasValidList = Array.isArray(welcomeConfig.activity?.list) && welcomeConfig.activity.list.length > 0;
  if (!hasValidList) {
    welcomeConfig.activity = {
      rotate: true,
      intervalSeconds: 30,
      list: [
        { type: 'WATCHING',  text: 'over BoltZy ~' },
        { type: 'LISTENING', text: '/model dan /setwelcome' },
        { type: 'PLAYING',   text: 'dengan AI fallback engine' },
      ],
    };
    saveWelcomeConfig();
  }
}
ensureActivityConfig();

module.exports = {
  blocklist,
  modelConfig,
  responders,
  saveBlocklist,
  saveModelConfig,
  saveResponders,
  saveWelcomeConfig,
  welcomeConfig,
};
