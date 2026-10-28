'use strict';
/**
 * Tes tahap 1 — dijalankan dengan `npm test` (node --test), tanpa jaringan.
 *
 * PENTING: SDK pihak ketiga (@google/genai, groq-sdk, openai) dan discord.js
 * di sini DI-STUB. Tes ini memastikan logika bot kita (router fallback,
 * timeout, urutan model, bentuk request ke SDK, wiring event) — BUKAN bahwa
 * SDK asli/Discord/API provider menerima request itu. Itu hanya bisa diuji
 * dengan menjalankan bot sungguhan dengan API key asli.
 */
process.env.BOT_NO_AUTOSTART = '1';
process.env.OWNER_ID = 'OWNER1';

const test   = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');

/* ---------------- stub SDK ---------------- */
const rec = { gemini: [], geminiCtor: [], groq: [], groqCtor: [], openai: [], openaiCtor: [], restPut: [], clients: [] };
let geminiBehavior = async () => ({ text: 'gemini-ok' });
let groqBehavior   = async () => ({ choices: [{ message: { content: 'groq-ok' } }] });
let openaiBehavior = async () => ({ choices: [{ message: { content: 'or-ok' } }] });

class StubGoogleGenAI {
  constructor(o) { rec.geminiCtor.push(o); this.models = { generateContent: (req) => { rec.gemini.push(req); return geminiBehavior(req, o.apiKey); } }; }
}
class StubGroq {
  constructor(o) { rec.groqCtor.push(o); this.chat = { completions: { create: (body, opts) => { rec.groq.push({ body, opts }); return groqBehavior(body, opts); } } }; }
}
class StubOpenAI {
  constructor(o) { rec.openaiCtor.push(o); this.chat = { completions: { create: (body, opts) => { rec.openai.push({ body, opts }); return openaiBehavior(body, opts); } } }; }
}

function chain() {
  const p = new Proxy(function () {}, { get: (_t, k) => (k === 'toJSON' ? () => ({}) : p), apply: () => p });
  return p;
}
function recorder() {
  const trace = [];
  const ser = (a) => {
    if (typeof a === 'function') { const child = recorder(); a(child); return { cb: child.toJSON() }; }
    if (typeof a === 'bigint') return `${a}n`;
    return a;
  };
  const proxy = new Proxy({}, {
    get(_t, k) {
      if (k === 'toJSON') return () => trace;
      return (...args) => { trace.push([String(k), args.map(ser)]); return proxy; };
    },
  });
  return proxy;
}
class StubClient {
  constructor(opts) {
    this.opts = opts; this.handlers = {}; this.once_ = {};
    this.user = { id: 'BOT', tag: 'bot#0', setActivity() {} };
    rec.clients.push(this);
  }
  on(e, f) { this.handlers[e] = f; return this; }
  once(e, f) { this.once_[e] = f; return this; }
  async login(t) { this.token = t; }
}
const discordStub = {
  Client: StubClient,
  GatewayIntentBits: new Proxy({}, { get: (_t, k) => String(k) }),
  Partials: { Channel: 'Channel' },
  Options: { cacheWithLimits: (o) => o, DefaultSweeperSettings: {} },
  REST: class { setToken() { return this; } async put(_route, { body }) { rec.restPut.push(body); } },
  Routes: { applicationCommands: (id) => `/apps/${id}/commands` },
  SlashCommandBuilder: class { constructor() { return recorder(); } },
  ModalBuilder: class { constructor() { return chain(); } },
  TextInputBuilder: class { constructor() { return chain(); } },
  ActionRowBuilder: class { constructor() { return chain(); } },
  EmbedBuilder: class { constructor() { return chain(); } },
  TextInputStyle: { Paragraph: 2 },
  PermissionFlagsBits: { Administrator: 8n, ManageGuild: 32n, ViewChannel: 1024n, SendMessages: 2048n, AttachFiles: 32768n, ModerateMembers: 1n << 40n },
  ChannelType: { GuildText: 0, GuildAnnouncement: 5 },
  ButtonBuilder: class { constructor() { return chain(); } },
  ButtonStyle: { Primary: 1, Secondary: 2 },
  ActivityType: { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5 },
  MessageFlags: { Ephemeral: 64 },
  Events: { ClientReady: 'clientReady' },
};
const stubs = { '@google/genai': { GoogleGenAI: StubGoogleGenAI }, 'groq-sdk': StubGroq, openai: StubOpenAI, dotenv: { config() {} }, 'discord.js': discordStub };
const origLoad = Module._load;
const requestLog = [];
Module._load = function (request, ...rest) { requestLog.push(request); return request in stubs ? stubs[request] : origLoad.call(this, request, ...rest); };

/* ---------------- muat index.js dari folder sementara (state JSON terisolasi) ---------------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcbot-'));
const PROJECT_DIR = path.join(__dirname, '..');
fs.copyFileSync(path.join(PROJECT_DIR, 'index.js'), path.join(tmp, 'index.js'));
fs.cpSync(path.join(PROJECT_DIR, 'src'), path.join(tmp, 'src'), { recursive: true }); // seluruh src/ ikut diuji
fs.writeFileSync(path.join(tmp, 'model_config.json'), JSON.stringify({ activeProviderType: 'groq', activeModelId: 'llama-3.1-8b-instant' }));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  welcome: { channelId: null, message: 'hai {mention}' },
  activity: { rotate: false, intervalSeconds: 30, list: [{ type: 'WATCHING', text: 'tes' }] },
}));
const bot = require(path.join(tmp, 'index.js'));
const requestsAtLoad = [...requestLog]; // require yang terjadi saat index.js + src/ dimuat
const { PROVIDER_MODEL_TIERS: TIERS, buildProviderModelPlan, generateWithFallback } = bot;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (list) => list.map((m) => m.id);
const fakeProviders = [{ id: 'gemini-1', type: 'gemini' }, { id: 'groq-1', type: 'groq' }, { id: 'openrouter-1', type: 'openrouter' }];
const byProvider = (plan, pid) => plan.filter((x) => x.provider.id === pid).map((x) => x.modelId);

/* ================= 1. daftar model ================= */
test('daftar model: gemini auto = 3.6-flash + 3.5-flash-lite; 3.8-flash & 3.1-flash-lite manualOnly', () => {
  assert.deepEqual(ids(TIERS.gemini.models), ['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(ids(TIERS.gemini.manualOnly), ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
});
test('daftar model: slug deprecated tidak ada lagi', () => {
  const all = Object.values(TIERS).flatMap((t) => ids([...(t.models || []), ...(t.manualOnly || [])]));
  for (const dead of ['gemini-3.5-flash', 'gemini-3.7-flash', 'llama-3.1-8b-instant', 'moonshotai/kimi-k2-instruct', 'meta-llama/llama-3.3-70b-instruct:free']) {
    assert.ok(!all.includes(dead), `${dead} masih ada`);
  }
  assert.ok(!all.some((id) => id.startsWith('gemini-2')), 'masih ada lini gemini-2.x');
  assert.ok(ids(TIERS.groq.models).includes('qwen/qwen3.8-27b'));
});

/* ================= 2. rencana (plan) ================= */
test('plan default: tanpa model manualOnly; urutan model per provider = urutan tier', () => {
  const plan = buildProviderModelPlan(fakeProviders, { activeProviderType: null, activeModelId: null });
  assert.deepEqual(byProvider(plan, 'gemini-1'), ids(TIERS.gemini.models));
  assert.deepEqual(byProvider(plan, 'groq-1'), ids(TIERS.groq.models));
  assert.deepEqual(byProvider(plan, 'openrouter-1'), ids(TIERS.openrouter.models));
  assert.ok(!plan.some((x) => TIERS.gemini.manualOnly.some((m) => m.id === x.modelId)));
});
for (const manual of ['gemini-3.8-flash', 'gemini-3.1-flash-lite']) {
  test(`plan dengan override manual ${manual}: jadi Attempt #1, fallback provider lain tetap utuh`, () => {
    const plan = buildProviderModelPlan(fakeProviders, { activeProviderType: 'gemini', activeModelId: manual });
    assert.equal(plan[0].provider.id, 'gemini-1');
    assert.equal(plan[0].modelId, manual);
    assert.equal(plan.filter((x) => x.modelId === manual).length, 1, 'manual hanya boleh muncul sekali');
    assert.deepEqual(byProvider(plan, 'gemini-1').slice(1), ids(TIERS.gemini.models));
    assert.deepEqual(byProvider(plan, 'groq-1'), ids(TIERS.groq.models));
    assert.deepEqual(byProvider(plan, 'openrouter-1'), ids(TIERS.openrouter.models));
  });
}
test('plan: override ke provider lain tidak memunculkan model manualOnly gemini', () => {
  const plan = buildProviderModelPlan(fakeProviders, { activeProviderType: 'groq', activeModelId: 'qwen/qwen3.8-27b' });
  assert.equal(plan[0].provider.id, 'groq-1');
  assert.equal(plan[0].modelId, 'qwen/qwen3.8-27b');
  assert.ok(!plan.some((x) => TIERS.gemini.manualOnly.some((m) => m.id === x.modelId)));
});
test('plan default: OpenRouter SELALU terakhir; provider lain tetap diacak (100x)', () => {
  const firsts = new Set();
  for (let i = 0; i < 100; i++) {
    const plan = buildProviderModelPlan(fakeProviders, { activeProviderType: null, activeModelId: null });
    const lastNonOr = plan.map((x) => x.provider.type).lastIndexOf('groq') > plan.map((x) => x.provider.type).lastIndexOf('gemini')
      ? plan.map((x) => x.provider.type).lastIndexOf('groq') : plan.map((x) => x.provider.type).lastIndexOf('gemini');
    const firstOr = plan.findIndex((x) => x.provider.type === 'openrouter');
    assert.ok(firstOr > lastNonOr, 'OpenRouter muncul sebelum provider lain');
    assert.notEqual(plan[0].provider.type, 'openrouter');
    firsts.add(plan[0].provider.id);
  }
  assert.deepEqual([...firsts].sort(), ['gemini-1', 'groq-1'], 'provider non-OpenRouter harus tetap bergantian di posisi pertama');
});
test('plan: OpenRouter tetap bisa jadi Attempt #1 kalau dipilih eksplisit lewat /model set', () => {
  const plan = buildProviderModelPlan(fakeProviders, { activeProviderType: 'openrouter', activeModelId: 'openrouter/free' });
  assert.equal(plan[0].provider.id, 'openrouter-1');
  assert.equal(plan[0].modelId, 'openrouter/free');
  assert.ok(plan.some((x) => x.provider.type === 'gemini') && plan.some((x) => x.provider.type === 'groq'));
});
test('plan: override lama yang modelnya sudah dibuang diabaikan (tidak ada model mati di plan)', () => {
  const cfg = { activeProviderType: 'groq', activeModelId: 'llama-3.1-8b-instant' };
  assert.equal(bot.isKnownModelOverride(cfg), false);
  assert.equal(bot.isKnownModelOverride({ activeProviderType: null, activeModelId: null }), true);
  assert.equal(bot.isKnownModelOverride({ activeProviderType: 'gemini', activeModelId: 'gemini-3.8-flash' }), true);
  const plan = buildProviderModelPlan(fakeProviders, cfg);
  assert.ok(!plan.some((x) => x.modelId === 'llama-3.1-8b-instant'));
});

/* ================= 3. router fallback + timeout ================= */
function mkProvider(id, impl) {
  const calls = [];
  return { id, type: 'x', calls, async generateReply(...args) { calls.push(args); return impl(...args); } };
}
const planOf = (...provs) => provs.map((p, i) => ({ provider: p, modelId: `m${i}` }));

test('router: sukses di percobaan pertama, provider menerima 5 argumen dengan AbortSignal', async () => {
  const p = mkProvider('a', async () => 'halo');
  const r = await generateWithFallback(planOf(p), 'SYS', [], 'u');
  assert.equal(r.text, 'halo');
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].length, 5);
  assert.ok(p.calls[0][4].signal instanceof AbortSignal);
});
test('router: error 429 lanjut ke percobaan berikut, tiap entri hanya dicoba 1x', async () => {
  const a = mkProvider('a', async () => { const e = new Error('rate limited'); e.status = 429; throw e; });
  const b = mkProvider('b', async () => 'dari-b');
  const r = await generateWithFallback(planOf(a, b), 'S', [], 'u');
  assert.equal(r.providerId, 'b');
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
});
test('router: percobaan yang menggantung di-timeout, di-abort, lalu lanjut', async () => {
  const hang = mkProvider('hang', (_s, _h, _u, _m, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))));
  const ok = mkProvider('ok', async () => 'selamat');
  const t0 = Date.now();
  const r = await generateWithFallback(planOf(hang, ok), 'S', [], 'u', null, { attemptTimeoutMs: 60, totalTimeoutMs: 1000 });
  const dt = Date.now() - t0;
  assert.equal(r.text, 'selamat');
  assert.ok(dt >= 55 && dt < 400, `elapsed ${dt}ms`);
  assert.equal(hang.calls[0][4].signal.aborted, true);
});
const errWith = (status, message) => Object.assign(new Error(message), { status });
test('router: error key (401) -> sisa model provider yang sama dilewati, provider lain tetap dicoba', async () => {
  const a = mkProvider('a', async () => { throw errWith(401, 'Invalid API Key'); });
  const b = mkProvider('b', async () => 'dari-b');
  const plan = [{ provider: a, modelId: 'a0' }, { provider: a, modelId: 'a1' }, { provider: b, modelId: 'b0' }];
  const attempts = [];
  const r = await generateWithFallback(plan, 'S', [], 'u', (e) => { if (!e.error) attempts.push(e.attempt); });
  assert.equal(r.providerId, 'b');
  assert.equal(a.calls.length, 1, 'model kedua provider dengan key rusak tidak boleh dicoba');
  assert.deepEqual(attempts, [1, 2], 'nomor percobaan dihitung dari percobaan nyata');
});
test('router: Gemini 400 "API key not valid" juga dianggap error key', async () => {
  const g = mkProvider('g', async () => { throw errWith(400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'); });
  const ok = mkProvider('ok', async () => 'ok');
  await generateWithFallback([{ provider: g, modelId: 'm0' }, { provider: g, modelId: 'm1' }, { provider: ok, modelId: 'x' }], 'S', [], 'u');
  assert.equal(g.calls.length, 1);
});
for (const [label, err] of [
  ['400 bukan soal key', errWith(400, 'Invalid argument: unsupported parameter')],
  ['403 bukan soal key', errWith(403, 'Model not available in your region')],
  ['429 rate limit', errWith(429, 'rate limited')],
  ['500 server error', errWith(500, 'internal error')],
]) {
  test(`router: ${label} BUKAN error key -> model lain milik provider yang sama tetap dicoba`, async () => {
    const a = mkProvider('a', async (_s, _h, _u, modelId) => { if (modelId === 'a0') throw err; return 'dari-a1'; });
    const r = await generateWithFallback([{ provider: a, modelId: 'a0' }, { provider: a, modelId: 'a1' }], 'S', [], 'u');
    assert.equal(r.text, 'dari-a1');
    assert.equal(a.calls.length, 2);
  });
}
test('router: timeout BUKAN error key -> model lain milik provider yang sama tetap dicoba', async () => {
  const a = mkProvider('a', (_s, _h, _u, modelId) => (modelId === 'a0' ? new Promise(() => {}) : Promise.resolve('dari-a1')));
  const r = await generateWithFallback([{ provider: a, modelId: 'a0' }, { provider: a, modelId: 'a1' }], 'S', [], 'u', null, { attemptTimeoutMs: 40, totalTimeoutMs: 1000 });
  assert.equal(r.text, 'dari-a1');
});
test('router: semua gagal -> satu error ringkasan, tidak ada retry', async () => {
  const mk = (id) => mkProvider(id, async () => { throw new Error(`boom-${id}`); });
  const [a, b, c] = [mk('a'), mk('b'), mk('c')];
  await assert.rejects(() => generateWithFallback(planOf(a, b, c), 'S', [], 'u'), (e) => {
    assert.match(e.message, /All AI provider\/model combinations failed/);
    assert.match(e.message, /boom-a/); assert.match(e.message, /boom-c/);
    return true;
  });
  assert.deepEqual([a.calls.length, b.calls.length, c.calls.length], [1, 1, 1]);
});
test('router: batas total menghentikan rantai walau plan panjang', async () => {
  const hangs = Array.from({ length: 10 }, (_, i) => mkProvider(`h${i}`, () => new Promise(() => {})));
  const t0 = Date.now();
  await assert.rejects(
    () => generateWithFallback(planOf(...hangs), 'S', [], 'u', null, { attemptTimeoutMs: 100, totalTimeoutMs: 250 }),
    /batas total 250ms tercapai/,
  );
  const dt = Date.now() - t0;
  const attempted = hangs.filter((h) => h.calls.length > 0).length;
  assert.ok(dt < 700, `elapsed ${dt}ms`);
  assert.ok(attempted >= 2 && attempted <= 4, `attempted ${attempted}`);
});
test('router: provider yang gagal terlambat (setelah timeout) tidak memicu unhandledRejection', async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  const late = mkProvider('late', () => new Promise((_res, rej) => setTimeout(() => rej(new Error('terlambat')), 120)));
  const ok = mkProvider('ok', async () => 'ok');
  await generateWithFallback(planOf(late, ok), 'S', [], 'u', null, { attemptTimeoutMs: 30, totalTimeoutMs: 1000 });
  await sleep(200);
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, 0);
});
test('router: plan kosong -> error jelas', async () => {
  await assert.rejects(() => generateWithFallback([], 'S', [], 'u'), /empty plan/);
});

/* ================= 4. provider: bentuk request ke SDK (stub) ================= */
test('gemini provider: bentuk request @google/genai', async () => {
  rec.gemini.length = 0; rec.geminiCtor.length = 0;
  const prov = bot.createGeminiProvider({ id: 'g', apiKey: 'KEY' });
  assert.deepEqual(rec.geminiCtor[0], { apiKey: 'KEY' });
  const ac = new AbortController();
  geminiBehavior = async () => ({ text: '  halo  ' });
  const out = await prov.generateReply('SYS', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 'c', 'gemini-3.6-flash', { signal: ac.signal });
  assert.equal(out, 'halo');
  const req = rec.gemini[0];
  assert.equal(req.model, 'gemini-3.6-flash');
  assert.deepEqual(req.contents, [
    { role: 'user', parts: [{ text: 'a' }] }, { role: 'model', parts: [{ text: 'b' }] }, { role: 'user', parts: [{ text: 'c' }] },
  ]);
  assert.equal(req.config.systemInstruction, 'SYS');
  assert.equal(req.config.abortSignal, ac.signal);
  assert.equal(req.config.safetySettings.length, 4);
  assert.ok(req.config.safetySettings.every((s) => s.threshold === 'BLOCK_ONLY_HIGH' && s.category.startsWith('HARM_CATEGORY_')));
});
test('gemini provider: tanpa signal tidak ada abortSignal; respons kosong/diblokir -> error', async () => {
  rec.gemini.length = 0;
  const prov = bot.createGeminiProvider({ id: 'g', apiKey: 'K' });
  geminiBehavior = async () => ({ text: undefined });
  await assert.rejects(() => prov.generateReply('S', [], 'x', 'gemini-3.6-flash'), /empty response/);
  assert.equal('abortSignal' in rec.gemini[0].config, false);
});
test('groq & openrouter provider: maxRetries 0, signal diteruskan, pesan benar', async () => {
  rec.groq.length = rec.groqCtor.length = rec.openai.length = rec.openaiCtor.length = 0;
  const g = bot.createGroqProvider({ id: 'g', apiKey: 'GK' });
  const o = bot.createOpenRouterProvider({ id: 'o', apiKey: 'OK', siteUrl: 'https://x', appName: 'n' });
  assert.equal(rec.groqCtor[0].maxRetries, 0);
  assert.equal(rec.openaiCtor[0].maxRetries, 0);
  assert.equal(rec.openaiCtor[0].baseURL, 'https://openrouter.ai/api/v1');
  const ac = new AbortController();
  await g.generateReply('SYS', [{ role: 'user', content: 'a' }], 'b', 'openai/gpt-oss-20b', { signal: ac.signal });
  await o.generateReply('SYS', [], 'b', 'openrouter/free');
  assert.equal(rec.groq[0].body.model, 'openai/gpt-oss-20b');
  assert.deepEqual(rec.groq[0].body.messages.map((m) => m.role), ['system', 'user', 'user']);
  assert.equal(rec.groq[0].opts.signal, ac.signal);
  assert.equal(rec.openai[0].opts, undefined);
});
test('registry: nama env baru dan lama (legacy) sama-sama terbaca', () => {
  const a = bot.buildProviderRegistry({ GEMINI_KEY_1: 'a', GEMINI_KEY_2: 'b', GROQ_KEY: 'c', OPENROUTER_KEY: 'd' });
  const b = bot.buildProviderRegistry({ Gemini_API: 'a', Gemini_API_2: 'b', Groq_API: 'c', Openrouter_API: 'd' });
  assert.deepEqual(a.map((p) => p.type), ['gemini', 'gemini', 'groq', 'openrouter']);
  assert.deepEqual(b.map((p) => p.id), a.map((p) => p.id));
});

/* ================= 4b. key Gemini-1 rusak -> fallback ke Gemini-2 ================= */
function withBehaviors(fn) {
  const saved = [geminiBehavior, groqBehavior, openaiBehavior];
  return async () => { try { await fn(); } finally { [geminiBehavior, groqBehavior, openaiBehavior] = saved; } };
}
const badKeyError = () => Object.assign(new Error('400 API key not valid. Please pass a valid API key.'), { status: 400 });

test('gemini-1 rusak + gemini-2 sehat + groq + openrouter: selalu terjawab, tidak pernah oleh gemini-1/OpenRouter, gemini-2 benar-benar terpakai', withBehaviors(async () => {
  geminiBehavior = async (_req, key) => { if (key === 'BAD') throw badKeyError(); return { text: 'dari-gemini-2' }; };
  groqBehavior = async () => ({ choices: [{ message: { content: 'dari-groq' } }] });
  openaiBehavior = async () => ({ choices: [{ message: { content: 'dari-openrouter' } }] });
  const providers = bot.buildProviderRegistry({ GEMINI_KEY_1: 'BAD', GEMINI_KEY_2: 'GOOD', GROQ_KEY: 'g', OPENROUTER_KEY: 'o' });
  assert.deepEqual(providers.map((p) => p.id), ['gemini-1', 'gemini-2', 'groq-1', 'openrouter-1']);
  const answered = new Map();
  for (let i = 0; i < 60; i++) {
    const plan = buildProviderModelPlan(providers, { activeProviderType: null, activeModelId: null });
    const r = await generateWithFallback(plan, 'S', [], 'u');
    answered.set(r.providerId, (answered.get(r.providerId) || 0) + 1);
  }
  assert.ok(!answered.has('gemini-1'), 'gemini-1 (key rusak) tidak mungkin menjawab');
  assert.ok(!answered.has('openrouter-1'), 'OpenRouter tidak boleh terpakai selama provider lain sehat');
  assert.ok(answered.get('gemini-2') > 0, 'gemini-2 harus ikut menjawab');
  assert.ok(answered.get('groq-1') > 0);
}));
test('hanya gemini-1 (rusak) + gemini-2 (sehat): SELALU berakhir di gemini-2, dan tiap model gemini-1 dicoba tepat 1x', withBehaviors(async () => {
  const keysSeen = [];
  geminiBehavior = async (_req, key) => { keysSeen.push(key); if (key === 'BAD') throw badKeyError(); return { text: 'dari-gemini-2' }; };
  const providers = bot.buildProviderRegistry({ GEMINI_KEY_1: 'BAD', GEMINI_KEY_2: 'GOOD' });
  for (let i = 0; i < 20; i++) {
    keysSeen.length = 0;
    const plan = buildProviderModelPlan(providers, { activeProviderType: null, activeModelId: null });
    const r = await generateWithFallback(plan, 'S', [], 'u');
    assert.equal(r.providerId, 'gemini-2');
    assert.ok(keysSeen.filter((k) => k === 'BAD').length <= 1, 'key rusak hanya boleh dicoba 1x per pesan');
    assert.equal(keysSeen.filter((k) => k === 'GOOD').length >= 1, true);
  }
}));

/* ================= 5. smoke: main() + alur pesan (discord.js di-stub) ================= */
const fakeMessage = (content, uid, replies) => ({
  author: { id: uid, bot: false }, content, guildId: 'G1', reference: null,
  mentions: { has: (id) => id === 'BOT' },
  channel: { id: 'C1', sendTyping: async () => {}, send: async () => {}, messages: { fetch: async () => null } },
  reply: async (t) => { replies.push(t); },
});
const fakeInteraction = (sub, getString, replies) => ({
  isAutocomplete: () => false, isChatInputCommand: () => true, isModalSubmit: () => false,
  commandName: 'model', user: { id: 'OWNER1' }, channelId: 'C1',
  options: { getSubcommand: () => sub, getString },
  reply: async (o) => { replies.push(o); },
});

test('smoke: main() login, wiring event, registrasi 11 slash command', async () => {
  Object.assign(process.env, { DISCORD_TOKEN: 'TOK', GEMINI_KEY_1: 'g', GROQ_KEY: 'q' });
  rec.clients.length = 0; rec.restPut.length = 0;
  await bot.main();
  const c = rec.clients[0];
  assert.equal(c.token, 'TOK');
  for (const ev of ['interactionCreate', 'messageCreate', 'guildMemberAdd', 'error']) assert.equal(typeof c.handlers[ev], 'function', ev);
  assert.equal(typeof c.once_[discordStub.Events.ClientReady], 'function');
  assert.equal(c.once_.ready, undefined, 'tidak boleh lagi memakai event \'ready\' yang deprecated');
  await c.once_[discordStub.Events.ClientReady]();
  // 11 command inti + 5 command moderasi + 1 verification + 1 banned-word.
  const names = rec.restPut[0].map((c) => c.find((e) => e[0] === 'setName')[1][0]);
  assert.deepEqual(names.slice(11), ['warn', 'warnings', 'warning-remove', 'modconfig', 'backup', 'verification', 'banned-word']);
  assert.equal(rec.restPut[0].length, 18);
  // Golden: definisi 11 slash command inti harus identik dengan versi sebelum modularisasi.
  const goldenPath = path.join(__dirname, 'fixtures', 'commands.golden.json');
  const actual = JSON.stringify(rec.restPut[0].slice(0, 11), null, 2) + '\n';
  if (process.env.UPDATE_GOLDEN === '1') { fs.mkdirSync(path.dirname(goldenPath), { recursive: true }); fs.writeFileSync(goldenPath, actual); }
  assert.equal(actual, fs.readFileSync(goldenPath, 'utf8'), 'definisi slash command berubah dari golden');
});
async function captureStartupLogs() {
  const out = []; const l = console.log, w = console.warn, e = console.error;
  console.log = (...a) => out.push(a.join(' ')); console.warn = (...a) => out.push(a.join(' ')); console.error = (...a) => out.push(a.join(' '));
  try { await bot.main(); } finally { console.log = l; console.warn = w; console.error = e; }
  return out;
}
test('smoke: startup memperingatkan override lama yang modelnya sudah dibuang (tanpa log "aktif")', async () => {
  const logs = (await captureStartupLogs()).join('\n');
  assert.match(logs, /llama-3\.1-8b-instant.*override diabaikan/);
  assert.ok(!/Override manual aktif/.test(logs));
});
test('smoke: startup membuka database SQLite di folder data/ proyek dan mencatat statusnya', async () => {
  const logs = (await captureStartupLogs()).join('\n');
  assert.match(logs, /\[DB\] SQLite siap: .*ovelia\.sqlite \(schema v\d+, journal=wal, start ke-\d+\)/);
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'ovelia.sqlite')), 'file database harus berada di data/ pada root proyek');
});
test('smoke: database gagal dibuka -> bot tetap start dan login (fitur AI tidak terganggu)', async () => {
  const saved = process.env.DB_PATH;
  process.env.DB_PATH = path.join('index.js', 'tidak-bisa.sqlite'); // induknya file biasa -> gagal
  const before = rec.clients.length;
  try {
    const logs = (await captureStartupLogs()).join('\n');
    assert.match(logs, /\[DB\] Gagal membuka database .*fitur AI tetap berjalan/);
    assert.equal(rec.clients.length, before + 1, 'client Discord tetap dibuat');
    assert.equal(rec.clients.at(-1).token, 'TOK', 'login tetap dipanggil');
  } finally {
    if (saved === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = saved;
  }
});
test('smoke: pesan -> balasan AI via Groq (tanpa model mati; override lama diabaikan)', async () => {
  const c = rec.clients[0]; const replies = []; rec.groq.length = 0; rec.gemini.length = 0;
  geminiBehavior = async () => { throw new Error('gemini down'); };
  groqBehavior = async () => ({ choices: [{ message: { content: 'halo dari groq' } }] });
  await c.handlers.messageCreate(fakeMessage('<@BOT> halo', 'U1', replies));
  assert.deepEqual(replies, ['halo dari groq']);
  assert.ok(!rec.groq.some((x) => x.body.model === 'llama-3.1-8b-instant'));
});
test('smoke: /model status memberi peringatan untuk override lama', async () => {
  const c = rec.clients[0]; const replies = [];
  await c.handlers.interactionCreate(fakeInteraction('status', () => null, replies));
  assert.match(replies[0].content, /DIABAIKAN/);
  assert.equal(replies[0].flags, 64);
});
test('smoke: command moderasi dirutekan lewat main -> handler interaksi -> modul moderasi (izin diperiksa di handler)', async () => {
  const c = rec.clients[0]; const replies = [];
  await c.handlers.interactionCreate({
    isChatInputCommand: () => true, isAutocomplete: () => false, isModalSubmit: () => false,
    inGuild: () => true, commandName: 'warnings', user: { id: 'RANDOM' }, memberPermissions: { has: () => false },
    replied: false, deferred: false, reply: async (o) => { replies.push(o); },
  });
  assert.match(replies[0].content, /tidak punya izin/);
  assert.equal(replies[0].flags, 64);
});
test('smoke: /model set gemini-3.8-flash -> Attempt #1, gagal -> fallback tetap jalan sampai Groq', async () => {
  const c = rec.clients[0]; const replies = []; rec.groq.length = 0; rec.gemini.length = 0;
  await c.handlers.interactionCreate(fakeInteraction('set', (n) => (n === 'provider' ? 'gemini' : 'gemini-3.8-flash'), replies));
  assert.match(replies[0].content, /gemini \/ gemini-3\.8-flash/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'model_config.json'), 'utf8')).activeModelId, 'gemini-3.8-flash');
  replies.length = 0;
  geminiBehavior = async () => { throw new Error('belum layak / rate limit'); };
  groqBehavior = async () => ({ choices: [{ message: { content: 'fallback groq' } }] });
  await c.handlers.messageCreate(fakeMessage('<@BOT> tes', 'U2', replies));
  assert.deepEqual(rec.gemini.map((x) => x.model), ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(replies, ['fallback groq']);
});
test('smoke: startup mencatat override manual yang sah (gemini-3.8-flash)', async () => {
  const logs = (await captureStartupLogs()).join('\n');
  assert.match(logs, /Override manual aktif: gemini\/gemini-3\.8-flash/);
  assert.ok(!/override diabaikan/.test(logs));
});
test('smoke: setelah /model reset, model manualOnly tidak pernah dicoba otomatis', async () => {
  const c = rec.clients[0]; const replies = [];
  await c.handlers.interactionCreate(fakeInteraction('reset', () => null, replies));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'model_config.json'), 'utf8')).activeModelId, null);
  rec.gemini.length = 0; replies.length = 0;
  for (const uid of ['U3', 'U4', 'U5', 'U6']) await c.handlers.messageCreate(fakeMessage('<@BOT> tes', uid, replies));
  const used = rec.gemini.map((x) => x.model);
  assert.ok(!used.includes('gemini-3.8-flash') && !used.includes('gemini-3.1-flash-lite'), used.join(','));
});
test('smoke: semua provider gagal -> pesan error ke user, tiap model dicoba tepat 1x (tanpa retry)', async () => {
  const c = rec.clients[0]; const replies = []; rec.groq.length = 0; rec.gemini.length = 0;
  geminiBehavior = async () => { throw new Error('x'); };
  groqBehavior = async () => { throw new Error('y'); };
  await c.handlers.messageCreate(fakeMessage('<@BOT> tes', 'U7', replies));
  assert.match(replies[0], /semua layanan AI sedang bermasalah/);
  assert.equal(rec.gemini.length, TIERS.gemini.models.length);
  assert.equal(rec.groq.length, TIERS.groq.models.length);
});

/* ================= 6. cek statis ================= */
const listJs = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listJs(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
const SRC_DIR = path.join(PROJECT_DIR, 'src');
test('statis: tidak ada "ephemeral:" lama, tidak ada SDK Gemini lama', () => {
  const src = [path.join(PROJECT_DIR, 'index.js'), ...listJs(SRC_DIR)].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/ephemeral:\s*true/.test(src));
  assert.ok(!src.includes('@google/generative-ai'));
  assert.ok(!/\.once\('ready'/.test(src), "masih memakai event 'ready'");
  assert.ok(src.includes('Events.ClientReady'));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['@google/genai']);
  assert.ok(!pkg.dependencies['@google/generative-ai']);
});

/* ================= 7. struktur modul (tahap 2) ================= */
test('modul: seluruh file src/ ikut tersalin ke folder uji dan bisa di-load tanpa error', () => {
  const files = listJs(SRC_DIR);
  assert.ok(files.length >= 15, `hanya ${files.length} file di src/`);
  for (const f of files) {
    const copy = path.join(tmp, path.relative(PROJECT_DIR, f));
    assert.ok(fs.existsSync(copy), `${copy} tidak tersalin`);
    assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(f, 'utf8'));
    require(copy);
  }
});
test('modul: file data JSON tetap di root proyek, bukan di src/', () => {
  const files = require(path.join(tmp, 'src', 'storage', 'files.js'));
  const root = fs.realpathSync(tmp);
  const keys = ['CONFIG_PATH', 'RESPONDERS_PATH', 'BLOCKLIST_PATH', 'MODEL_CONFIG_PATH'];
  assert.deepEqual(keys.map((k) => path.basename(files[k])), ['config.json', 'responders.json', 'blocklist.json', 'model_config.json']);
  for (const k of keys) assert.equal(fs.realpathSync(path.dirname(files[k])), root, `${k} tidak di root proyek`);
});
test('modul: tidak ada dependensi melingkar dan arah dependensi hanya ke lapisan bawah', () => {
  const RANK = { config: 0, core: 0, storage: 0, ai: 1, discord: 2, 'main.js': 3 };
  const rankOf = (f) => RANK[path.relative(SRC_DIR, f).split(path.sep)[0]];
  const graph = new Map();
  for (const f of listJs(SRC_DIR)) {
    const resolveReq = (from, req) => {
      const base = path.resolve(path.dirname(from), req);
      return fs.existsSync(`${base}.js`) ? `${base}.js` : path.join(base, 'index.js'); // ./x -> x.js atau x/index.js
    };
    const deps = [...fs.readFileSync(f, 'utf8').matchAll(/require\('(\.[^']+)'\)/g)].map((m) => resolveReq(f, m[1]));
    graph.set(f, deps);
    for (const d of deps) {
      assert.ok(fs.existsSync(d), `${path.relative(SRC_DIR, f)} me-require file yang tidak ada: ${d}`);
      assert.ok(rankOf(d) <= rankOf(f), `${path.relative(SRC_DIR, f)} -> ${path.relative(SRC_DIR, d)} melanggar arah lapisan`);
    }
  }
  const done = new Set(); const stack = new Set();
  const visit = (n) => {
    assert.ok(!stack.has(n), `siklus dependensi di ${path.relative(SRC_DIR, n)}`);
    if (done.has(n)) return;
    stack.add(n); for (const d of graph.get(n) || []) visit(d); stack.delete(n); done.add(n);
  };
  for (const n of graph.keys()) visit(n);
});
test('modul: ekspor publik index.js tidak berubah', () => {
  assert.deepEqual(Object.keys(bot).sort(), [
    'PROVIDER_MODEL_TIERS', 'buildProviderModelPlan', 'buildProviderRegistry', 'createGeminiProvider', 'createGroqProvider',
    'createOpenRouterProvider', 'generateWithFallback', 'isKnownModelOverride', 'main',
  ]);
});
test('modul: dotenv dimuat sebelum modul src/ apa pun', () => {
  const order = requestsAtLoad.slice(1).filter((r) => r !== 'fs' && r !== 'path' && !r.startsWith('node:'));
  assert.equal(order[0], 'dotenv');
});
test('modul: SDK provider tetap lazy (tidak di-require saat modul dimuat, baru saat provider dibuat)', () => {
  const sdk = ['groq-sdk', 'openai', '@google/genai'];
  assert.deepEqual(requestsAtLoad.filter((r) => sdk.includes(r)), []);
  const before = requestLog.length;
  bot.createGroqProvider({ id: 'lazy', apiKey: 'k' });
  assert.ok(requestLog.slice(before).includes('groq-sdk'));
});

test('smoke: startup tanpa override tidak mencetak baris override apa pun', async () => {
  const c = rec.clients[0]; const replies = [];
  await c.handlers.interactionCreate(fakeInteraction('reset', () => null, replies));
  const logs = (await captureStartupLogs()).join('\n');
  assert.ok(!/\[Model\]/.test(logs), logs);
});
