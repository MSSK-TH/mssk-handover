/**
 * webpipe.mjs —— 网页管线（picture_v2）的最小实现
 *
 * 协议来源：https://github.com/basketikun/chatgpt2api
 *   services/openai_backend_api.py  →  _image_model_settings / _prepare_image_conversation /
 *                                      _start_image_generation / 文件上传 / SSE 解析
 *   utils/pow.py                    →  proof token 算法（与 gpt4free 的 proofofwork.py 同构）
 *
 * 只实现"生图"这一条链路：不碰号池/任务队列/Web UI/PPT 逆向（那些 new-api 或不需要）。
 *
 * 关键事实（2026-10-16 实测）：
 *   1. cookie 只是入场券，`/backend-api/*` 认的是 `Authorization: Bearer <accessToken>`，
 *      accessToken 用 cookie 打 `GET /api/auth/session` 换（会过期，过期就再换一次）。
 *   2. 端点必须是 `/backend-api/f/conversation`（带 /f/），且前面要先
 *      `POST /backend-api/f/conversation/prepare` 拿 `conduit_token`。
 *   3. `model` 用**账号实际支持的 slug**（我们账号是 gpt-5-6）。写死 gpt-5-5 会让
 *      无害提示词也被"内容政策"误拒。
 *   4. Turnstile 没有被强制，PoW 足够；所以**不需要常驻浏览器**。
 */

import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://chatgpt.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/143.0.0.0 Safari/537.36';
// 原版 DEFAULT_CLIENT_VERSION / DEFAULT_CLIENT_BUILD_NUMBER
const CLIENT_VERSION = process.env.WEB_CLIENT_VERSION || 'prod-a194cd50d4416d3c0b47c740f206b12ce60f5887';
const CLIENT_BUILD = process.env.WEB_CLIENT_BUILD || '6708908';
/** 'auto'（默认）= 动态从 /backend-api/models 取 default_model_slug；也可写死某个 slug */
const MODEL_OVERRIDE = process.env.WEB_MODEL || 'auto';
const COOKIE_FILE = process.env.WEB_COOKIE_FILE || '/app/web-cookie.txt';
const IDLE_MS = Number(process.env.WEB_IDLE_TIMEOUT_MS || 180000);
const WALL_MS = Number(process.env.WEB_WALL_MS || 900000);
// 【2026-11-03】SSE 里没找到图时，去对话里补捞的最长等待时间。
// 起因：用 thinking 档（如 gpt-6-thinking）时，SSE 4 秒就结束且不带图，
// 但对话其实还在后台继续画（实测 41 秒后才出图）→ 我们误判失败 → 回退原生又画了一张。
const CONV_RECOVER_MS = Number(process.env.WEB_CONV_RECOVER_MS || 150000);
// 【2026-11-04】上游风控冷却。
// 实测文档：连续建对话后 chatgpt.com 会回
//   403 {"detail":"Unusual activity has been detected from your device..."}
// 或者 422 {"detail":"Invalid conversation body"}（同一个风控，换个马甲）。
// 撞上之后如果还每单都去试，一是每单白等十几秒，二是把账号越踩越深。
// 这里记一个冷却窗口，窗口内直接跳过网页管线、立刻走原生。
// 冷却时长：实测这类限制几十秒~两三分钟就能过，20 分钟太狠了 ——
// 而且冷却一到期就又去试，试失败又续 20 分钟，会把系统长期锁在降级状态。
const COOLDOWN_MS = Number(process.env.WEB_COOLDOWN_MS || 120000);
let upstreamBlockUntil = 0;
let upstreamBlockReason = '';

const log = (...a) => console.log('[webpipe]', ...a);
/** 短 id：头 8 + 尾 6。sediment/file-service 的 id 前缀都一样，只截前 10 位看不出区别 */
const sid = (id) => {
  const s = String(id || '');
  return s.length <= 16 ? s : s.slice(0, 8) + '..' + s.slice(-6);
};
/** 去掉 sediment:// / file-service:// 前缀和 # 之后的变体后缀 */
const stripId = (raw) => String(raw || '')
  .replace(/^sediment:\/\//, '').replace(/^file-service:\/\//, '').split('#')[0];
/**
 * speed 变体指针里真正的文件 id：
 *   sediment://6e48d0196dcb48d#file_00000000aac881f888bfe5496e97aee9#speed_1.5 → file_0000...aee9
 * 【2026-11-06 实测】8 档变体全部指向同一个文件，速度只是客户端时序参数；
 * 直接把变体前缀当 asset 去下载会 200 + file_not_found。
 */
const fileIdFromPointer = (raw) => {
  const segs = String(raw || '').replace(/^sediment:\/\//, '').split('#');
  return segs.find((x) => /^file[-_]/.test(x)) || segs[0] || '';
};

// ---------------------------------------------------------------- 凭据
// ---------------------------------------------------------------- 号池
const COOKIE_DIR = process.env.WEB_COOKIE_DIR || '/app/cookies';
// 【2026-11-06】20 分钟太长：上游这类限制实测几十秒~几分钟就过，冷却一到期又去试、试失败又续 20 分钟，
// 会把系统长期锁在"降级原生"的状态（网页管线明明能用却被自己关掉）。改成 5 分钟。
const COOKIE_BLOCK_MS = Number(process.env.WEB_COOKIE_BLOCK_MS || 5 * 60 * 1000);

const pool = { files: [], blocked: {}, idx: 0, current: '', cache: {} };

/**
 * 【2026-11-06】每个请求绑定自己的号（真正的并发隔离）。
 * 事故：pool.current 是全局单变量，readCookie() 在 generateViaWeb 里被调用 8 次以上，
 * 两个请求（a/b）并发时 A 的 token 可能配上 B 的 cookie → 上游看到会话/设备不匹配
 * → 422 Invalid conversation body。表现就是"一个成功、一个 422"。
 * 现在用 AsyncLocalStorage 把号钉在本次请求的异步上下文里，所有中途读 cookie 的地方都读它。
 */
const accountCtx = new AsyncLocalStorage();
const currentAccount = () => {
  const st = accountCtx.getStore();
  return (st && st.cookieName) || pool.current || '';
};

/**
 * 【2026-11-06】新建对话硬闸（由"测试把账号刷出 20+ 个对话"的事故而来）。
 * 光靠人自觉不够 —— 下面任何一条超了就直接拒绝"新建"，并要求调用方续接已有对话。
 *   · 同一个号：10 分钟内最多 2 个新对话（真人也就这个量级）
 *   · 同一个号：1 小时内最多 12 个
 *   · 所有号合计：10 分钟内最多 4 个（熔断，防止多号一起刷）
 * 续接对话（带 conversation_id）永远不受限。
 */
// ── 节奏熔断：[2026-11-06] 专门用来锁"程序化连发新建对话"这种测试行为 ──
// 真人：开一个新对话要打字，两次新建之间至少几秒；同一个号更不可能 5 秒内连开两个。
// 脚本：curl 一秒钟能打三个 556 → 这正是把账号刷出 20+ 个对话、并诱发 422 的原因。
// 触发后只冻结"新建对话"，已有对话继续用不受影响 —— 真人几乎不可能碰到。
// 【2026-11-06 按用户口径修正】判定标准 = **1 秒内出现 3 个"新建对话"**（脚本特征）。
// 真人再快也只能 1 秒内点 1~2 次；3 个/秒只有压测脚本做得到。
const TRIP_WINDOW_MS = Number(process.env.WEB_NEW_CONV_TRIP_WINDOW_MS || 1000);
const TRIP_COUNT = Number(process.env.WEB_NEW_CONV_TRIP_COUNT || 3);
// 分流：最多同时跑几个"新建对话"（= 号池数量）；超出的排队等空号
const NEW_CONV_WAIT_MS = Number(process.env.WEB_NEW_CONV_WAIT_MS || 180000);
const BREAKER_MS = Number(process.env.WEB_NEW_CONV_BREAKER_MS || 30 * 60 * 1000); // 熔断时长

let breakerUntil = 0;                 // 新建对话熔断到期时间
let breakerReason = '';
const lastNewConvByAccount = new Map(); // 号 -> 上次新建时间戳

const breakerLeftS = () => (breakerUntil > Date.now() ? Math.ceil((breakerUntil - Date.now()) / 1000) : 0);

/**
 * 【2026-11-06】新建对话分流：
 *   1 个请求 → 有空号就给空号；2 个 → a 一个 b 一个（不同 cookie 并行是安全的）；
 *   第 3 个 → 等 a/b 里先空出来的那个（排队，不并发堆在同一个号上）。
 * busy 集合保证"同一个号同一时刻只有一个新建对话在跑"。
 */
const newConvBusy = new Set();
const convAttempts = [];   // 最近 1 秒内的新建请求到达时间（熔断判定用）

function assertNotBotBurst() {
  const now = Date.now();
  while (convAttempts.length && now - convAttempts[0] > TRIP_WINDOW_MS) convAttempts.shift();
  convAttempts.push(now);
  if (convAttempts.length >= TRIP_COUNT) {
    breakerUntil = now + BREAKER_MS;
    breakerReason = `${TRIP_WINDOW_MS / 1000} 秒内建出 ${convAttempts.length} 个新对话（真人做不到，脚本特征）`;
    log(`  🛑🛑 ${breakerReason} → 冻结新建 ${Math.round(BREAKER_MS / 60000)} 分钟`);
    throw Object.assign(
      new Error(`新建对话被拒绝：${breakerReason}。已有对话不受影响`),
      { convQuota: true, web: true, definitive: true, code: 'new_conversation_burst' },
    );
  }
}

async function acquireAccountForNewConv() {
  if (breakerLeftS() > 0) {
    throw Object.assign(
      new Error(`新建对话被拒绝：熔断中（${breakerReason}），还剩 ${breakerLeftS()}s。已有对话不受影响`),
      { convQuota: true, web: true, definitive: true, code: 'new_conversation_limited' },
    );
  }
  const deadline = Date.now() + NEW_CONV_WAIT_MS;
  let waited = 0;
  for (;;) {
    const now = Date.now();
    const files = listPool().filter((f) => (pool.blocked[f] || 0) <= now && !newConvBusy.has(f));
    if (files.length) {
      // 优先挑"最久没被用过"的号，避免总压在一个号上
      const pickName = files.slice().sort((x, y) => (lastNewConvByAccount.get(x) || 0) - (lastNewConvByAccount.get(y) || 0))[0];
      newConvBusy.add(pickName);
      lastNewConvByAccount.set(pickName, now);
      pool.current = pickName;
      try {
        // 【2026-11-06】判定点 = "真的新建了"这一刻：a 一个、b 一个（1 秒内 2 个）是正常的；
        // 1 秒内建出第 3 个才不可能由真人产生 → 熔断。
        assertNotBotBurst();
      } catch (e) {
        newConvBusy.delete(pickName);   // 熔断时把占位还回去
        pool.current = '';
        throw e;
      }
      if (waited > 1000) log(`  ⏳ 新建对话排队 ${(waited / 1000).toFixed(1)}s → 轮到 ${pickName.replace('.txt', '')}`);
      else log(`  🔀 新建对话分流 → ${pickName.replace('.txt', '')}（忙着的号：${[...newConvBusy].filter((x) => x !== pickName).map((x) => x.replace('.txt', '')).join(',') || '无'}）`);
      return pickName;
    }
    if (now > deadline) {
      throw Object.assign(
        new Error(`新建对话排队超时（${Math.round(NEW_CONV_WAIT_MS / 1000)}s 内没有空号）。请稍后再试，或续接已有对话`),
        { convQuota: true, web: true, definitive: true, code: 'new_conversation_queue_timeout' },
      );
    }
    await new Promise((r) => setTimeout(r, 250));
    waited = Date.now() - (deadline - NEW_CONV_WAIT_MS);
  }
}

function releaseNewConvAccount(name) {
  if (name) newConvBusy.delete(name);
}


function listPool() {
  try {
    return fs.readdirSync(COOKIE_DIR).filter((f) => f.endsWith('.txt')).sort();
  } catch { return []; }
}

// 轮询挑一个没冷却的号；全部冷却时挑最早解冻的
function poolPick() {
  const files = listPool();
  if (!files.length) return '';
  const now = Date.now();
  for (let i = 0; i < files.length; i++) {
    const name = files[(pool.idx + i) % files.length];
    if ((pool.blocked[name] || 0) <= now) {
      pool.idx = (pool.idx + i + 1) % files.length;
      pool.current = name;
      log(`  号池：${name.replace('.txt', '')}（共 ${files.length} 个号）`);
      return name;
    }
  }
  const name = files.slice().sort((a, b) => (pool.blocked[a] || 0) - (pool.blocked[b] || 0))[0];
  pool.current = name;
  return name;
}

function readCookieByName(name) {
  const c = pool.cache[name];
  if (c && Date.now() - c.at < 30000) return c.value;
  const raw = fs.readFileSync(path.join(COOKIE_DIR, name), 'utf8').trim();
  const v = normalizeCookie(raw);
  pool.cache[name] = { at: Date.now(), value: v };
  return v;
}

export function markCookieBlocked(ms = COOKIE_BLOCK_MS, reason = '') {
  // 【2026-11-06】只冷却"本次请求真正用的那个号"，不误伤别人
  const name = currentAccount();
  if (!name) return;
  pool.blocked[name] = Date.now() + ms;
  log(`  🚫 号 ${name.replace('.txt', '')} 冷却 ${Math.round(ms / 60000)} 分钟${reason ? '（' + reason + '）' : ''}`);
  if (pool.current === name) pool.current = '';
}

export function getCookiePoolState() {
  return { files: listPool(), blocked: { ...pool.blocked }, current: pool.current };
}

let cookieCache = { at: 0, value: '' };
// 【2026-11-18】记住"最近一次发现 cookie/JWT 已过期"的时间，供 /health 暴露给站点
let lastExpiredAt = 0;

/**
 * 【2026-10-16】cookie 里带着 `oai-chat-surface-mode=work` / `codex_composer_mode=work`，
 * 会把请求钉在 ChatGPT 的**工作(Work)模式**。实测工作模式生图被拒率明显更高，
 * **聊天(Chat)模式成功率高得多** —— 所以默认统一成 chat，并允许调用方显式指定。
 */
let surfaceMode = 'chat';   // 'chat' | 'work'

export function setSurfaceMode(mode) {
  surfaceMode = mode === 'work' ? 'work' : 'chat';
  cookieCache = { at: 0, value: '' };   // 让 cookie 重新归一化
  return surfaceMode;
}

function normalizeCookie(raw) {
  const drop = new Set(['oai-chat-surface-mode', 'codex_composer_mode']);
  const kept = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !drop.has(p.split('=')[0]));
  kept.push(`oai-chat-surface-mode=${surfaceMode}`);
  return kept.join('; ');
}

function readCookie() {
  const name = currentAccount();
  if (!name) {
    // 号池为空时回退单文件
    const p = path.resolve(COOKIE_FILE);
    const raw = fs.readFileSync(p, 'utf8').trim();
    return normalizeCookie(raw);
  }
  return readCookieByName(name);
}

const tokenCache = new Map();
function deviceId(cookie) {
  return /oai-did=([0-9a-f-]+)/.exec(cookie)?.[1] || crypto.randomUUID();
}

function headers(cookie, token, extra = {}, targetPath = '') {
  const h = {
    cookie,
    'user-agent': UA,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: BASE,
    referer: `${BASE}/`,
    'oai-device-id': deviceId(cookie),
    'oai-session-id': crypto.randomUUID(),
    'oai-language': 'zh-CN',
    'oai-client-version': CLIENT_VERSION,
    'oai-client-build-number': CLIENT_BUILD,
    'sec-ch-ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  if (targetPath) {
    h['x-openai-target-path'] = targetPath;
    h['x-openai-target-route'] = targetPath;
  }
  return { ...h, ...extra };
}

// 【2026-11-04】读 JWT 自己的 exp。不能拿 /api/auth/session 的 j.expires 当缓存寿命 ——
// 那是**会话**有效期（本例给到 2027-02），而 accessToken 这个 JWT 早在 11-01 就过期了，
// 结果缓存一直认为自己有效，每次请求都拿一个死 token 去撞 401。
function jwtExpMs(tok) {
  try {
    const p = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8'));
    return p?.exp ? p.exp * 1000 : 0;
  } catch { return 0; }
}

async function getAccessToken(force = false) {
  const _cname = currentAccount();   // 【2026-11-06】token 必须与本次请求的号一致
  const _tc = tokenCache.get(_cname);
  if (!force && _tc && _tc.value && Date.now() < _tc.expires - 60000) return _tc.value;
  const cookie = readCookie();
  const r = await fetch(`${BASE}/api/auth/session`, { headers: headers(cookie, '') });
  const text = await r.text();
  if (!r.ok) throw new Error(`auth/session HTTP ${r.status}: ${text.slice(0, 160)}`);
  let tok = '';
  let exp = Date.now() + 30 * 60000;
  try {
    const j = JSON.parse(text);
    tok = j.accessToken || '';
    if (j.expires) exp = new Date(j.expires).getTime();
  } catch {
    tok = /"accessToken":"(.+?)"/.exec(text)?.[1] || '';
  }
  if (!tok) throw new Error('cookie 无效或未登录（/api/auth/session 没返回 accessToken）');

  const jwtExp = jwtExpMs(tok);
  if (jwtExp) exp = Math.min(exp, jwtExp);
  if (jwtExp && jwtExp < Date.now()) {
    log(`⚠️⚠️ accessToken 已于 ${new Date(jwtExp).toISOString()} 过期（cookie 要重新导出）`
      + `，网页管线现在必然 401，全部会回退原生端点`);
  }
  tokenCache.set(_cname, { value: tok, expires: exp });
  if (jwtExp && jwtExp < Date.now()) lastExpiredAt = jwtExp;
  return tok;
}

// ---------------------------------------------------------------- PoW
const POW_SCRIPT = 'https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js';

function solvePow(seed, difficulty) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const tok = [
    pick([3008, 4010, 6000]) * pick([1, 2, 4]),
    new Date().toUTCString(),
    null,
    0,
    UA,
    POW_SCRIPT,
    'dpl=1440a687921de39ff5ee56b92807faaadce73f13',
    'en',
    'en-US',
    null,
    'plugins−[object PluginArray]',
    pick(['_reactListeningcfilawjnerp', '_reactListening9ne2dfo1i47', '_reactListening410nzwhan2a']),
    pick(['alert', 'ontransitionend', 'onprogress']),
  ];
  const n = String(difficulty || '').length;
  for (let i = 0; i < 200000; i++) {
    tok[3] = i;
    const b64 = Buffer.from(JSON.stringify(tok)).toString('base64');
    const hex = crypto.createHash('sha3-512').update(seed + b64).digest('hex');
    if (hex.slice(0, n) <= difficulty) return 'gAAAAAB' + b64;
  }
  throw new Error('PoW 未在 200000 次内解出');
}

async function chatRequirements(token) {
  const cookie = readCookie();
  const p = '/backend-api/sentinel/chat-requirements';
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: headers(cookie, token, { 'content-type': 'application/json', accept: '*/*' }, p),
    body: '{}',
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`chat-requirements HTTP ${r.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text);
  const hdrs = { 'OpenAI-Sentinel-Chat-Requirements-Token': j.token || '' };
  if (j.proofofwork?.required) {
    hdrs['OpenAI-Sentinel-Proof-Token'] = solvePow(j.proofofwork.seed, j.proofofwork.difficulty);
  }
  return { hdrs, persona: j.persona, turnstile: !!j.turnstile?.required };
}

// ---------------------------------------------------------------- 模型（动态）
// 【为什么不能写死】不同账号/不同时间可选的 slug 不一样（我们这台现在有 gpt-6 / gpt-6.1-sol-wm /
// gpt-5-6 / gpt-6-thinking …）。用错的 slug 会让无害提示词被"内容政策"误拒（实测 gpt-5-5 就这样）。
// 正确做法：跟着 `/backend-api/models` 的 `default_model_slug` 走，1 小时缓存。
let modelCache = { at: 0, value: '', count: 0 };

async function resolveModel(token, force = false) {
  if (MODEL_OVERRIDE && MODEL_OVERRIDE !== 'auto') return MODEL_OVERRIDE;
  if (!force && modelCache.value && Date.now() - modelCache.at < 3600_000) return modelCache.value;
  const cookie = readCookie();
  const p = '/backend-api/models';
  const r = await fetch(BASE + p, { headers: headers(cookie, token, { accept: '*/*' }, p) });
  const text = await r.text();
  if (!r.ok) throw new Error(`models HTTP ${r.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text);
  const slugs = (j.models || []).map((m) => m.slug).filter(Boolean);
  const def = j.default_model_slug || '';
  // 【2026-11-18】关键修正：default_model_slug 只是"版本名"（如 gpt-6），
  //   **对话接口要的是 preset 的 model_slug**（gpt-6-thinking / gpt-6-instant）。
  //   实测发 gpt-6 会被上游判 422 Invalid conversation body；网页端自己发的是 gpt-6-thinking。
  const presets = [];
  for (const v of j.versions || []) {
    for (const p2 of v.intelligence_presets || []) {
      if (p2 && p2.model_slug) presets.push({ slug: String(p2.model_slug), lane: String(p2.lane || '') });
    }
  }
  const thinking = presets.find((x) => x.lane === 'thinking' && slugs.includes(x.slug));
  const instant = presets.find((x) => x.lane === 'instant' && slugs.includes(x.slug));
  const defThinking = def ? `${def}-thinking` : '';
  const pick = (thinking && thinking.slug)
    || (slugs.includes(defThinking) ? defThinking : '')
    || (def && slugs.includes(def) ? def : '')
    || (instant && instant.slug)
    || slugs[0];
  if (!pick) throw new Error('模型表为空，无法选择');
  modelCache = { at: Date.now(), value: pick, count: slugs.length };
  log(`动态选模型 ${pick}（版本默认=${def || '-'}，thinking 预设=${thinking ? thinking.slug : '-'}，可选 ${slugs.length} 个）`);
  return pick;
}

export function getSurfaceMode() {
  return surfaceMode;
}

/**
 * 网页模式可选的模型 —— 按 ChatGPT UI 的真实结构返回（随 surface 变）：
 *   versions[].display_text            = 模型名（"GPT-6" / "GPT-5.6 Sol"）
 *   versions[].intelligence_presets[]  = 推理档（Instant/Medium/High → slug + thinking_effort）
 * mode = 'chat' | 'work'：两种 surface 的模型表不一样，所以按 mode 各拉一次。
 */
export async function listWebModels(mode = '') {
  const want = mode === 'work' ? 'work' : (mode === 'chat' ? 'chat' : surfaceMode);
  const prev = surfaceMode;
  surfaceMode = want;
  cookieCache = { at: 0, value: '' };
  try {
    const token = await getAccessToken();
    const cookie = readCookie();
    const p = '/backend-api/models';
    const r = await fetch(BASE + p, { headers: headers(cookie, token, { accept: '*/*' }, p) });
    const text = await r.text();
    if (!r.ok) throw new Error(`models HTTP ${r.status}: ${text.slice(0, 120)}`);
    const j = JSON.parse(text);

    // ── 工作(Work)模式 ────────────────────────────────────────────────
    // 模型 = slug 带 `-wm` 的那批（GPT-6 Astra / GPT-6.1 Sol / GPT-6 Luna / GPT-6 Sol /
    // GPT-5.6 Sol|Terra|Luna）。推理档**按每个模型自带的 `thinking_efforts` 生成**，不写死：
    //   API 里 reasoning 型模型只声明 standard / extended 两档；
    //   另外实测 `max` 服务端接受（请求能走到出图阶段），所以额外提供「极高」；
    //   「即时」= 不传 thinking_effort。
    if (want === 'work') {
      // 工作模式的推理档 = 网页 UI 的 5 档滑杆：轻度 / 中 / 高 / 极高 / max（**没有「即时」**）。
      // 顺序映射到实测服务端接受的 5 个取值（minimal/low/standard/extended/max 都跑出过图）。
      const WORK_PRESETS = [
        { title: '轻度', effort: 'minimal' },
        { title: '中', effort: 'low' },
        { title: '高', effort: 'standard' },
        { title: '极高', effort: 'extended' },
        { title: 'max', effort: 'max' },
      ];
      const wm = (j.models || []).filter((m) => m && String(m.slug || '').endsWith('-wm'));
      const versions = wm.map((m) => ({
        id: m.slug,
        name: String(m.title || m.slug),
        short: String(m.title || m.slug),
        presets: WORK_PRESETS.map((p2) => ({ ...p2, slug: m.slug, lane: p2.effort === 'minimal' ? 'instant' : 'thinking' })),
      }));
      const list = versions.length ? versions : [{ id: 'work', name: 'GPT-6 Astra', short: 'GPT-6 Astra',
        presets: [{ title: '即时', slug: 'gpt-6-astra-wm', effort: '', lane: 'instant' }] }];
      return { default: list[0].id, defaultVersion: list[0].id, versions: list, mode: 'work' };
    }

    const versions = (j.versions || []).filter((v) => v && v.enabled !== false).map((v) => ({
      id: String(v.id || v.display_text || ''),
      name: String(v.display_text_for_intelligence || v.display_text || v.id || ''),
      short: String(v.short_display_text_for_intelligence || v.display_text || ''),
      presets: (v.intelligence_presets || [])
        .filter((p2) => p2 && p2.preset_type !== 'unavailable' && p2.model_slug)
        .map((p2) => ({
          title: String(p2.title || p2.selected_display_title || ''),
          slug: String(p2.model_slug || ''),
          effort: String(p2.thinking_effort || ''),
          lane: String(p2.lane || ''),
        })),
    })).filter((v) => v.presets.length);

    const fallback = [{ id: 'latest', name: 'GPT-6', short: 'GPT-6',
      presets: [{ title: 'Instant', slug: 'gpt-6-instant', effort: '', lane: 'instant' }] }];
    const list = versions.length ? versions : fallback;
    return {
      default: j.default_model_slug || list[0].presets[0].slug,
      defaultVersion: list[0].id,
      versions: list,
      mode: want,
    };
  } finally {
    surfaceMode = prev;
    cookieCache = { at: 0, value: '' };
  }
}

// ---------------------------------------------------------------- 图片尺寸
function imageSize(buf) {
  // PNG
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), mime: 'image/png' };
  }
  // JPEG：扫 SOF0/2
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), mime: 'image/jpeg' };
      }
      i += 2 + len;
    }
    return { w: 1024, h: 1024, mime: 'image/jpeg' };
  }
  // WebP (VP8X)
  if (buf.length > 30 && buf.subarray(0, 4).toString('latin1') === 'RIFF') {
    const w = 1 + (buf.readUIntLE(24, 3));
    const h = 1 + (buf.readUIntLE(27, 3));
    return { w, h, mime: 'image/webp' };
  }
  return { w: 1024, h: 1024, mime: 'image/png' };
}

// ---------------------------------------------------------------- 上传
async function uploadImage(token, dataUrl, index = 1) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('参考图不是 data URL');
  const buf = Buffer.from(m[2], 'base64');
  const { w, h, mime } = imageSize(buf);
  const name = `ref${index}.${mime.split('/')[1].replace('jpeg', 'jpg')}`;
  const cookie = readCookie();

  const p1 = '/backend-api/files';
  const r1 = await fetch(BASE + p1, {
    method: 'POST',
    headers: headers(cookie, token, { 'content-type': 'application/json', accept: '*/*' }, p1),
    body: JSON.stringify({ file_name: name, file_size: buf.length, use_case: 'multimodal' }),
  });
  const t1 = await r1.text();
  if (!r1.ok) throw new Error(`files init HTTP ${r1.status}: ${t1.slice(0, 160)}`);
  const { file_id: fileId, upload_url: uploadUrl } = JSON.parse(t1);
  if (!fileId || !uploadUrl) throw new Error('files init 没返回 file_id/upload_url');

  const r2 = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': mime, 'content-length': String(buf.length) },
    body: buf,
  });
  if (!r2.ok) throw new Error(`blob PUT HTTP ${r2.status}`);

  const p3 = `/backend-api/files/${fileId}/uploaded`;
  const r3 = await fetch(BASE + p3, {
    method: 'POST',
    headers: headers(cookie, token, { 'content-type': 'application/json', accept: '*/*' }, p3),
    body: '{}',
  });
  if (!r3.ok) throw new Error(`files confirm HTTP ${r3.status}`);

  return { file_id: fileId, width: w, height: h, size: buf.length, mime, name };
}

// ---------------------------------------------------------------- 生成
async function prepare(token, sentinel, prompt, parts, model) {
  const cookie = readCookie();
  const p = '/backend-api/f/conversation/prepare';
  // 【2026-11-18】按网页端真实 /f/conversation/prepare 请求对齐（抓包得到）：
  //   网页端只发这几个字段；我们之前塞 messages/partial_query/system_hints 是多余的。
  const body = {
    client_prepare_state: 'sent',
    action: 'next',
    model,
    parent_message_id: 'client-created-root',
    timezone: 'Asia/Shanghai',
    timezone_offset_min: -480,
    is_do_not_remember: false,
    local_function_names: ['local.continue_in_work'],
    client_prepare_dispatch: 'debounced',
    client_prepare_source: 'composer_editor_state',
  };
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: headers(cookie, token, { ...sentinel, 'content-type': 'application/json', accept: '*/*' }, p),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    log(`  [METRIC] prepare HTTP ${r.status} | model=${model} | parts=${parts.length} | bodyLen=${JSON.stringify(body).length} | resp=${String(text).slice(0, 140).replace(/\s+/g, ' ')}`);
    throw new Error(`prepare HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const conduit = JSON.parse(text).conduit_token || '';
  if (!conduit) throw new Error('prepare 没返回 conduit_token');
  return conduit;
}

// 【2026-11-06】对话 JSON 统一入口：调用方可以只拉一次，解析/诊断/GIF 挑选共用。
async function fetchConversationJson(token, conversationId) {
  if (!conversationId) return null;
  const cookie = readCookie();
  const p = `/backend-api/conversation/${conversationId}`;
  const r = await fetch(BASE + p, { headers: headers(cookie, token, { accept: '*/*' }, p) });
  if (!r.ok) throw new Error(`GET conversation HTTP ${r.status} conv=${conversationId.slice(0, 8)}`);
  return await r.json();
}

/**
 * 【2026-11-06】这一轮是否已经结束 —— 用上游自己的信号，而不是我们数字数。
 * 实测对话里：收尾的 assistant 节点 message.end_turn === true 且 metadata.is_complete === true，
 * 且 conversation.current_node 指向它；中间节点都是 end_turn=false。
 */
/**
 * 【2026-11-06】从提示词 + 请求参数推算"用户要几张"（仅用于日志与等待策略，不参与停止判断）。
 * 注意：n 必须由调用方传进来 —— 上一版直接引用 n，在 webpipe 里是未定义变量，
 * 一算就 ReferenceError，导致整条网页管线抛错降级到 codex 端点（用户拿到的是静态 PNG）。
 */
function requestedCount(prompt, n = 1) {
  const txt = String(prompt || '');
  const QTY = '(?:张|个|份|套|组|幅|枚|款)';
  const CN = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  let fromPrompt = 0;
  const digits = new RegExp('(\\d+)\\s*' + QTY).exec(txt);
  if (digits) fromPrompt = Number(digits[1]);
  if (!fromPrompt) {
    // "两个/三张…" 这类中文数量词（之前只认阿拉伯数字，"设计两个gif" 被算成 1）
    const cn = new RegExp('([一两二三四五六七八九十])\\s*' + QTY).exec(txt);
    if (cn) fromPrompt = CN[cn[1]] || 0;
  }
  const fromParam = Number(n) > 1 ? Number(n) : 0;
  return Math.max(1, Math.min(8, fromPrompt || fromParam || 1));
}

/**
 * 【2026-11-06】"盯对话"策略（纯函数，可单测）。
 * 上一版在这段里引用了前面被删掉的变量 wantMatch → ReferenceError，
 * 把整条网页管线炸掉（表现：站内报 web_pipeline_bug，上游其实在正常画）。
 */
function drainPlan(prompt, n = 1) {
  const wantN = requestedCount(prompt, n);
  const multiHint = /多张|几张|一套|一组|表情包|合集|系列/.test(String(prompt || ''));
  const drain = wantN > 1 || multiHint || Number(n) > 1 || String(process.env.WEB_DRAIN_ALWAYS || '') === '1';
  const quietMs = Number(process.env.WEB_DRAIN_QUIET_MS || (wantN > 1 ? 75000 : 18000));
  const maxMs = Number(process.env.WEB_DRAIN_MAX_MS || (wantN > 1 ? Math.min(300000, wantN * 120000) : 90000));
  return { wantN, multiHint, drain, quietMs, maxMs };
}

function turnCompleted(j) {
  if (!j || !j.current_node || !j.mapping) return false;
  const node = j.mapping[j.current_node];
  const m = node && node.message;
  if (!m) return false;
  const meta = m.metadata || {};
  return m.end_turn === true || meta.is_complete === true;
}

/** 从对话 JSON 里按时间戳筛出图片 asset_pointer（sinceTs=0 表示不限） */
function collectImageIds(j, sinceTs = 0) {
  const out = [];
  for (const node of Object.values((j && j.mapping) || {})) {
    const msg = node && node.message;
    if (!msg) continue;
    const ct = Number(msg.create_time || 0);
    if (sinceTs && ct && ct < sinceTs - 5) continue;
    for (const part of (msg.content && msg.content.parts) || []) {
      if (!part || part.content_type !== 'image_asset_pointer') continue;
      const id = String(part.asset_pointer || '').replace(/^sediment:\/\//, '').split('#')[0];
      if (id) out.push(id);
    }
  }
  return [...new Set(out)];
}

const DIAG_ASSETS = String(process.env.WEB_DIAG_ASSETS ?? '1') === '1';

/**
 * 【2026-11-06】② 多图：把"本轮真正新增的成品图"全部捞出来（有序、去重）。
 * 实测结构 = A：一张图一条 role=tool 消息，每条消息 1 个 image_asset_pointer part。
 * 排除：参考图（refFileIds）、上一轮已有的图（preexisting）、sprite sheet（在 metadata.generation 里，
 * 某些情况下也会作为 asset_pointer 出现，但永远不是成品）。
 */
function collectFreshAssets(j, { sinceTs = 0, preexisting = new Set(), refFileIds = new Set() } = {}) {
  const raw = [];
  const spriteIds = new Set();
  for (const node of Object.values((j && j.mapping) || {})) {
    const msg = node && node.message;
    if (!msg) continue;
    const ct = Number(msg.create_time || 0);
    const role = String((msg.author && msg.author.role) || '');
    if (role === 'user') continue;              // 用户消息里只有参考图
    for (const part of ((msg.content && msg.content.parts) || [])) {
      if (!part || typeof part !== 'object' || part.content_type !== 'image_asset_pointer') continue;
      const id = stripId(part.asset_pointer);
      if (!id) continue;
      const gen = (part.metadata && part.metadata.generation) || {};
      const spId = stripId(gen.spritesheet && gen.spritesheet.asset_pointer);
      if (spId) spriteIds.add(spId);
      raw.push({ id, ct, role, mime: String(part.mime_type || 'N/A'), gen, spId });
    }
  }
  const seen = new Set();
  return raw
    .filter((a) => !spriteIds.has(a.id))
    .filter((a) => !refFileIds.has(a.id) && !preexisting.has(a.id))
    .filter((a) => !sinceTs || !a.ct || a.ct >= sinceTs - 5)
    .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
    .sort((x, y) => (x.ct || 0) - (y.ct || 0));
}

/**
 * 【2026-11-06】② 多图诊断：把对话里所有 image_asset_pointer 打出来，看清上游一次多图的结构。
 * 判定：A=多条消息各 1 part；B=一条消息多 part；混合=两者都有。
 * 同时标注 fresh（本轮新增）/ sprite（带 generation 元数据）/ 尺寸字节，用来排除参考图与上一轮的图。
 */
function dumpConversationAssets(j, { label = '', sinceTs = 0, preexisting = new Set(), refFileIds = new Set() } = {}) {
  if (!j || !j.mapping) { log(`  [diag·${label}] 没有 mapping`); return []; }
  const msgs = [];
  for (const node of Object.values(j.mapping)) {
    const msg = node && node.message;
    if (!msg) continue;
    const ct = Number(msg.create_time || 0);
    const role = String((msg.author && msg.author.role) || '?');
    const parts = (msg.content && msg.content.parts) || [];
    const imgs = [];
    parts.forEach((part, i) => {
      if (!part || typeof part !== 'object' || part.content_type !== 'image_asset_pointer') return;
      const id = String(part.asset_pointer || '').replace(/^sediment:\/\//, '').split('#')[0];
      const gen = (part.metadata && part.metadata.generation) || {};
      imgs.push({
        i, id,
        mime: String(part.mime_type || '?'),
        fresh: !preexisting.has(id) && !refFileIds.has(id) && (!sinceTs || !ct || ct >= sinceTs - 5),
        sprite: !!(gen.spritesheet || (gen.animation && gen.animation.frame_count)),
        w: part.width, h: part.height, size: part.size_bytes,
      });
    });
    if (imgs.length) msgs.push({ role, ct, imgs, total: parts.length });
  }
  msgs.sort((a, b) => (a.ct || 0) - (b.ct || 0));
  const all = msgs.flatMap((m) => m.imgs);
  const multiPartMsgs = msgs.filter((m) => m.imgs.length > 1).length;
  const shape = multiPartMsgs
    ? (msgs.length > multiPartMsgs ? '混合（A+C）' : 'B（一条消息多 part）')
    : (msgs.length > 1 ? 'A（多条消息各 1 part）' : '单个/无');
  log(`  [diag·${label}] 带图消息 ${msgs.length} 条 / 图 part ${all.length} 个`
    + `（本轮新增 ${all.filter((a) => a.fresh).length}）mime=[${[...new Set(all.map((a) => a.mime))].join(',')}] 结构=${shape}`);
  if (DIAG_ASSETS) {
    for (const m of msgs.slice(-8)) {
      log(`    msg role=${m.role} ct=${m.ct ? new Date(m.ct * 1000).toISOString().slice(11, 19) : '?'} parts=${m.total} 图=${m.imgs.length}`);
      for (const a of m.imgs) {
        log(`      part#${a.i} ${a.mime.padEnd(11)} fresh=${a.fresh ? 'Y' : 'N'} sprite=${a.sprite ? 'Y' : 'N'}`
          + ` ${a.w || '?'}x${a.h || '?'} ${a.size ? Math.round(a.size / 1024) + 'KB' : ''} id=${sid(a.id)}`);
      }
    }
  }
  return all;
}

// [2026-11-05] GIF 支持：对话 parts[0] 可能就是成品 GIF（mime_type=image/gif），
// sprite sheet 只是 metadata 里的附带物。这里按 mime 精确挑，有 GIF 就返回 GIF。
async function findGifAsset(token, convId, speed, sinceTs = 0, prefetched = null) {
  if (!convId) return null;
  let j = prefetched;
  if (!j) { try { j = await fetchConversationJson(token, convId); } catch { return null; } }
  const nodes = Object.values(j.mapping || {});
  for (const node of nodes) {
    const msg = node && node.message;
    if (!msg) continue;
    const ct = Number(msg.create_time || 0);
    // [FIX] 只要有 create_time，就必须不早于本次请求，避免把上一轮的图当成本轮结果
    if (sinceTs && ct && ct < sinceTs - 5) continue;
    const parts = (msg.content && msg.content.parts) || [];
    for (const part of parts) {
      if (!part || part.content_type !== 'image_asset_pointer') continue;
      if (String(part.mime_type || '') !== 'image/gif') continue;
      const raw = String(part.asset_pointer || '');
      const baseId = raw.replace(/^sediment:\/\//, '').split('#')[0];
      const gen = (part.metadata && part.metadata.generation) || (node.message.metadata && node.message.metadata.generation) || {};
      const sp = gen.spritesheet || {};
      const spriteId = String(sp.asset_pointer || '').replace(/^sediment:\/\//, '').split('#')[0];
      const anim = gen.animation || {};
      const variants = gen.gif_speed_variants || {};
      const extra = {
        spriteId,
        animation: (anim.rows && anim.columns && anim.frame_count)
          ? { rows: anim.rows, columns: anim.columns, frame_count: anim.frame_count, frame_duration_ms: anim.frame_duration_ms || 160 }
          : null,
      };
      if (speed && variants[String(speed)]) {
        // 变体 = 同一文件的时序档位；拿 file 段去下载，时长按倍率缩放
        const vid = fileIdFromPointer(variants[String(speed)]) || baseId;
        const k = Number(speed);
        if (extra.animation && k > 0) {
          const base = Number(extra.animation.frame_duration_ms || 160);
          extra.animation = { ...extra.animation, frame_duration_ms: Math.max(20, Math.round(base / k)) };
        }
        log(`  GIF 命中 speed=${speed} assets=${sid(vid)}/sprite=${sid(spriteId)}`);
        return { id: vid, mime: 'image/gif', speed: String(speed), ...extra };
      }
      log(`  GIF 命中 默认速度 assets=${sid(baseId)}/sprite=${sid(spriteId)}`);
      return { id: baseId, mime: 'image/gif', speed: '1', ...extra };
    }
  }
  return null;
}

async function downloadAsset(token, assetId) {
  const cookie = readCookie();
  const p = `/backend-api/files/${assetId}/download`;
  const r = await fetch(BASE + p, { headers: headers(cookie, token, { accept: '*/*' }, p) });
  const text = await r.text();
  if (!r.ok) throw new Error(`asset download HTTP ${r.status}: ${text.slice(0, 160)}`);
  let url = '';
  try {
    const j = JSON.parse(text);
    url = j.download_url || '';
    // 【2026-11-06】gif_speed 变体 asset 可能不是真文件（200 但没 download_url）→ 这里要出声
    if (!url) log(`  [diag] ${sid(assetId)} 下载响应无 download_url：${JSON.stringify(j).slice(0, 200)}`);
  } catch {
    log(`  [diag] ${sid(assetId)} 下载响应非 JSON：${String(text).slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  if (!url) throw new Error('没有 download_url');
  // ⚠️ estuary 不是外部 CDN，它就是 chatgpt.com 的后端接口（/backend-api/estuary/content?id=...），
  //    所以**必须带 Bearer token**。只带 cookie 会 403 {"detail":"File stream access denied."}
  //    （2026-11-03 实测：cookie+UA → 403；加 Bearer → 200，3187KB）
  const r2 = await fetch(url, {
    headers: {
      ...headers(cookie, token, { accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8' }, new URL(url).pathname),
      referer: `${BASE}/`,
    },
  });
  if (!r2.ok) {
    let body = '';
    try { body = (await r2.text()).slice(0, 160).replace(/\s+/g, ' '); } catch {}
    throw new Error(`estuary HTTP ${r2.status} host=${new URL(url).host} ${body}`);
  }
  const buf = Buffer.from(await r2.arrayBuffer());
  return { b64: buf.toString('base64'), bytes: buf.length };
}

/**
 * 走网页管线生成一张图。
 * @returns {{b64:string, elapsed:number, model:string, reqId:string}}
 */
/**
 * 【2026-11-06】入口包装：先把"这次用哪个号"定下来，再把它钉进异步上下文跑完整条管线。
 * 之后所有 readCookie()/getAccessToken() 都读上下文，不会因为别的请求改了全局 pool.current 而串号。
 */
export async function generateViaWeb(opts = {}) {
  // 【2026-11-06】新建对话 → 交给分流器：1 个给 a、2 个给 b、第 3 个排队等空号
  if (!opts.conversationId) {
    const account = await acquireAccountForNewConv();
    try {
      return await accountCtx.run({ cookieName: account }, () => generateViaWebInner(opts));
    } finally {
      releaseNewConvAccount(account);
    }
  }
  // 续接对话：不加锁、不排队（两个标签页各自改图可以并行）
  if (opts.cookieName && listPool().includes(opts.cookieName)) {
    pool.current = opts.cookieName;
  } else if (!pool.current) {
    poolPick();
  }
  const account = pool.current || '_default';
  return accountCtx.run({ cookieName: account }, () => generateViaWebInner(opts));
}

async function generateViaWebInner({
  prompt,
  refDataUrls = [],
  model: modelOverride = '',
  effort = '',
  cookieName = '',
  // 【2026-10-27】对话续接：带上这两个值就落进同一个 ChatGPT 对话，
  // 不传就是新建（和以前完全一样，向后兼容）。
  conversationId = '',
  parentMessageId = '',
  gifSpeed = '',
  n = 1,
}) {
  const t0 = Date.now();
  // 续接同一对话时锁定原号（否则新号看不到旧对话，会 404）；新对话才轮询
  if (cookieName && listPool().includes(cookieName)) {
    pool.current = cookieName;
  } else if (!pool.current) {
    poolPick();
  }
  // 冷却窗口内直接跳过：省掉每单十几秒的无谓等待，也不继续踩上游风控
  if (Date.now() < upstreamBlockUntil) {
    const left = Math.ceil((upstreamBlockUntil - Date.now()) / 60000);
    throw Object.assign(
      new Error(`网页管线冷却中（${upstreamBlockReason}，还剩约 ${left} 分钟）`),
      { web: true, cooldown: true, definitive: true, upstream: true },
    );
  }
  let token = await getAccessToken();
  const model = modelOverride || await resolveModel(token);

  // 参考图先上传
  const refs = [];
  for (let i = 0; i < refDataUrls.length; i++) {
    refs.push(await uploadImage(token, refDataUrls[i], i + 1));
  }
  log(`上传 ${refs.length} 张参考图完毕`);

  // 【2026-11-04】参考图的 file_id 会作为 asset_pointer 出现在 SSE / 对话里，
  // 而且**排在我们生成的那张图前面**。以前直接用 ids[0] → 把用户上传的参考图当成果返回
  // （实测：610x1138、68KB，正是用户那张 0.07MB 的参考图）。
  // 这里记下来，后面从候选里排除。
  const refFileIds = new Set(refs.map((r) => r.file_id).filter(Boolean));

  // 续接对话时，对话里本来就有的图（上一轮的成果）也不能当成这一轮的
  let preexisting = new Set();
  let preexistingErr = '';
  if (conversationId) {
    for (let attempt = 0; attempt < 2 && !preexisting.size; attempt++) {
      try {
        preexisting = new Set(await assetsInConversation(conversationId, token));
        preexistingErr = '';
        break;
      } catch (e) {
        preexistingErr = String(e.message).slice(0, 100);
        log(`  ⚠️ 预存图拉取失败（第 ${attempt + 1} 次）：${preexistingErr}`);
      }
    }
    log(`  预存图 conv=${conversationId.slice(0, 8)} 已有 ${preexisting.size} 个 asset（本轮排除）`
      + `${preexistingErr ? ` ⚠️ 末次失败=${preexistingErr}` : ''}`);
  }
  /**
   * 本轮真正新增的候选：排除参考图 + 排除上一轮已有的。
   * 【2026-11-06】独立出来，日志和取图共用同一份判定，避免"日志说新增 0 个却返回了图"。
   */
  const freshIds = (list) => list.filter((id) => !refFileIds.has(id) && !preexisting.has(id));
  /** 从候选里挑出"这次真正生成的"那张：排除参考图、排除上一轮已有的，取最新 */
  const pickResult = (list) => {
    const fresh = freshIds(list);
    // [fix] 没有本轮新图时返回空，绝不回退成旧图/参考图
    if (!fresh.length) return '';
    return fresh[fresh.length - 1];
  };

  const sentinel = await chatRequirements(token);
  log(`sentinel persona=${sentinel.persona} turnstile=${sentinel.turnstile}（未强制就无需浏览器）`);

  const parts = refs.map((r) => ({
    content_type: 'image_asset_pointer',
    asset_pointer: `file-service://${r.file_id}`,
    width: r.width,
    height: r.height,
    size_bytes: r.size,
  }));
  parts.push(prompt);

  const cookie = readCookie();
  const p = '/backend-api/f/conversation';
  const metadata = {
    developer_mode_connector_ids: [],
    selected_github_repos: [],
    selected_all_github_repos: false,
    system_hints: ['picture_v2'],
    serialization_metadata: { custom_symbol_offsets: [] },
  };
  if (refs.length) {
    metadata.attachments = refs.map((r) => ({
      id: r.file_id, mimeType: r.mime, name: r.name, size: r.size, width: r.width, height: r.height,
    }));
  }
  // 【2026-11-18】按网页端真实请求对齐（抓包：/backend-api/f/conversation）
  //   关键差异：**新对话的 parent_message_id 必须是 'client-created-root'**，
  //   随机 UUID 会被上游判 422 Invalid conversation body。
  //   同时补上网页端会带的 turn_attribution / is_do_not_remember / local_function_names /
  //   genui_state_snapshots，去掉它已不再发送的 conversation_mode / enable_message_followups /
  //   supports_buffering / paragen_cot_summary_display_override / force_parallel_switch。
  // 【2026-11-18】按网页端真实 /f/conversation 请求对齐（抓包实锤）：
  //   · client_prepare_state 必须是 'success'（我们原来发 'sent' → 422）
  //   · **没有 system_hints**（picture_v2 那套已废弃，带上会被判非法 body）
  //   · 消息 metadata 只留 automation_creation_attribution
  const msgId = crypto.randomUUID();
  const body = {
    turn_attribution: { turn_trigger: 'composer' },
    action: 'next',
    model,
    parent_message_id: conversationId ? (parentMessageId || 'client-created-root') : 'client-created-root',
    timezone: 'Asia/Shanghai',
    timezone_offset_min: -480,
    is_do_not_remember: false,
    client_contextual_info: {
      app_name: 'chatgpt.com',
      app_surface: 'codex_browser',
      has_web_push_capabilities: true,
      web_push_notification_permission: 'default',
    },
    local_function_names: ['local.continue_in_work'],
    messages: [{
      author: { metadata: {}, name: null, role: 'user' },
      channel: null,
      content: { content_type: refs.length ? 'multimodal_text' : 'text', parts },
      create_time: Date.now() / 1000,
      end_turn: null,
      id: msgId,
      metadata: {
        ...(refs.length ? { attachments: refs.map((r) => ({ id: r.file_id, mimeType: r.mime, name: r.name, size: r.size, width: r.width, height: r.height })) } : {}),
        automation_creation_attribution: { origin: 'conversation', flow_id: msgId },
      },
      recipient: 'all',
      status: 'finished_successfully',
      update_time: null,
      weight: 1,
    }],
    supported_encodings: ['v1'],
    genui_state_snapshots: [],
    client_prepare_state: 'success',
  };
  // ★ 续接同一个对话（2026-10-27 实测通过）：带上 conversation_id，
  //   后端就会把这条消息挂到 parent_message_id 指的那个节点下，不再新建对话。
  if (conversationId) body.conversation_id = conversationId;
  // 推理强度（thinking_effort）：实测服务端接受 minimal / low / standard / extended / max。
  // 不设白名单 —— 设了会把「轻度(minimal)」这类值静默丢掉，换档看起来没效果。
  // 【2026-11-18】实测踩坑：上游会把 thinking_effort="undefined"（字符串）当非法字段 →
  //   整个 body 被判 422 Invalid conversation body。这里只发"真实的档位字符串"。
  const effortStr = effort === undefined || effort === null ? '' : String(effort).trim();
  if (effortStr && effortStr !== 'undefined' && effortStr !== 'null' && effortStr !== 'auto') {
    body.thinking_effort = effortStr;
  }

  // 【2026-11-06】只锁"新建对话"这一个动作，不锁普通请求。
  //   · 真人可以有两条请求在飞（两个标签页各自改图）→ 续接对话并发是允许的
  //   · 但真人**不可能在同一时刻点两次"新建对话"**（我们测试时正是这么干的：3 个新对话瞬间连开）
  //   · 所以：conv=new 走"按号串行 + 最小间隔"，续接对话直接放行
  //   · 凭据串号问题已由 AsyncLocalStorage 解决，不再依赖这把锁
  const lockName = currentAccount();
  const queuedAt = Date.now();
  let text = '';
  let bodyModel = model;
  const submitTurn = async () => {
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs > 500) log(`  ⏳ 新建对话排队 ${(waitedMs / 1000).toFixed(1)}s（${lockName} 上有一条新对话还在建）`);
    const conduit = await prepare(token, sentinel.hdrs, prompt, parts, model);
    body.messages[0].create_time = Date.now() / 1000;   // 排队过的请求刷新时间戳，别带上排队时长
    const ac = new AbortController();
    let idle = setTimeout(() => ac.abort(new Error('idle')), IDLE_MS);
    const wall = setTimeout(() => ac.abort(new Error('wall')), WALL_MS);
    const keepAlive = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('idle')), IDLE_MS); };
    try {
      let r;
      // 【2026-11-04】422 = 上游判定请求体非法。实测原因之一是 model slug 这个账号不认
      // （比如显式传 gpt-6-instant）。这种情况不该直接判死退回原生 ——
      // 先用账号默认模型重试一次，能出图就走网页管线。
      for (let attempt = 0; ; attempt++) {
        body.model = bodyModel;
        if (process.env.WEB_DEBUG_BODY === '1') log('  [DEBUG body] ' + JSON.stringify(body));
        r = await fetch(BASE + p, {
          method: 'POST',
          headers: headers(cookie, token, {
            ...sentinel.hdrs,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-conduit-token': conduit,
            'x-oai-turn-trace-id': crypto.randomUUID(),
          }, p),
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (r.ok) break;
        const t422 = await r.text();
        // 上游风控：这两种状态码都是同一件事（403 Unusual activity / 422 Invalid conversation body）。
        // 记冷却窗口，别继续踩。
        if (r.status === 403 || r.status === 422) {
          const kind = r.status === 403 ? '403-feng-kong' : '422-body-rejected';
          log(`  [METRIC] conversation HTTP ${r.status} ${kind} | model=${bodyModel} | refs=${refs.length} | bodyLen=${JSON.stringify(body).length} | conv=${conversationId ? 'resume' : 'new'} | resp=${String(t422).slice(0, 140).replace(/\s+/g, ' ')}`);
        }
        // 【2026-11-18】把两类错误彻底分开（之前混为一谈，导致误冷却账号、把排查方向带偏）：
        //   ① 403 / "Unusual activity"  = 真风控 → 冷却该号、换号重试
        //   ② 422 / "Invalid conversation body" = **我们自己的 body 非法**（字段/值写错）
        //      → 不该冷却账号，也不该当风控；标记成 webBug 让上层直接报错、保留诊断信息
        //      （实测成因：model 用版本名 gpt-6、带已废弃的 system_hints、thinking_effort="undefined"）
        if (/Unusual activity/i.test(t422) || r.status === 403) {
          const why = '上游风控 Unusual activity';
          markCookieBlocked(COOKIE_BLOCK_MS, why);
          log(`  ⛔ ${why} → 该号冷却 ${Math.round(COOKIE_BLOCK_MS / 60000)} 分钟，下次请求自动换号`);
          throw Object.assign(new Error(`conversation HTTP ${r.status}: ${t422.slice(0, 200)}`), {
            rateLimited: true, upstream: true, web: true, status: r.status,
          });
        }
        if (r.status === 422 && /Invalid conversation body/i.test(t422)) {
          // 我们的请求体有问题：不冷却账号、不换号重试（换号也一样失败），直接把诊断抛上去
          log('  ‼ 422 Invalid conversation body = 请求体非法（不是风控，账号不冷却）'
            + `；bodyLen=${JSON.stringify(body).length} model=${bodyModel}`);
          throw Object.assign(new Error(`请求体被上游拒绝（422 Invalid conversation body）：`
            + `model=${bodyModel} bodyLen=${JSON.stringify(body).length}`), {
            webBug: true, upstream: false, web: true, status: 422,
          });
        }
        throw new Error(`conversation HTTP ${r.status}: ${t422.slice(0, 240)}`);
      }
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        keepAlive();
        text += dec.decode(chunk, { stream: true });
      }
    } finally {
      clearTimeout(idle); clearTimeout(wall);
    }
  };

  // 【2026-11-06】新建对话的互斥/分流已在 acquireAccountForNewConv() 里完成；
  // 续接对话本来就可以并行。这里统一提交。
  await submitTurn();

  // SSE 里找资源指针（新账号给 sediment://，老的是 file-service://）
  const ids = [...new Set([
    ...[...text.matchAll(/"asset_pointer"\s*:\s*"sediment:\/\/([A-Za-z0-9_-]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/"asset_pointer"\s*:\s*"file-service:\/\/([A-Za-z0-9_-]+)"/g)].map((m) => m[1]),
  ])];
  const returnedConvId = (/"conversation_id"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(text) || [])[1] || conversationId || '';

  log(`  SSE 候选 ${ids.length} 个（refs=${refFileIds.size} preexisting=${preexisting.size}`
    + ` 新增=${freshIds(ids).length}） conv=${returnedConvId ? returnedConvId.slice(0, 8) : '无'}`);

  // 【2026-11-06】② 多图诊断：SSE 结束后先把对话里的 asset 结构打清楚
  // （每个 part 的 mime / 是否本轮新增 / 是否带 generation 元数据），确认上游一次多图是 A/B/C 哪种。
  let convJson = null;
  if (returnedConvId) {
    try {
      convJson = await fetchConversationJson(token, returnedConvId);
      dumpConversationAssets(convJson, { label: 'SSE结束后', sinceTs: t0 / 1000, preexisting, refFileIds });
    } catch (e) {
      log(`  [diag] 拉对话失败（忽略）：${String(e.message).slice(0, 80)}`);
    }
  }

  /** 对话里出现的 sprite sheet asset_pointer（SSE 里也会带，绝不能当成品返回） */
  const spriteIdsInConv = () => {
    const s = new Set();
    for (const node of Object.values((convJson && convJson.mapping) || {})) {
      const msg = node && node.message;
      for (const p of ((msg && msg.content && msg.content.parts) || [])) {
        const gen = (p && p.metadata && p.metadata.generation) || {};
        const sp = stripId(gen.spritesheet && gen.spritesheet.asset_pointer);
        if (sp) s.add(sp);
      }
    }
    return s;
  };
  /** 当前能看到的"本轮新品"：优先对话 parts（权威），没有就先用 SSE 候选顶上 */
  const currentFresh = () => {
    const sprites = spriteIdsInConv();
    const fromConv = collectFreshAssets(convJson, { sinceTs: t0 / 1000, preexisting, refFileIds })
      .filter((a) => !sprites.has(a.id));
    if (fromConv.length) return fromConv;
    return freshIds(ids).filter((id) => !sprites.has(id))
      .map((id) => ({ id, ct: 0, mime: '', gen: {}, spId: '' }));
  };

  // 【2026-11-06】多图/多 GIF：上游是一张一张往外给的（实测相邻两张间隔 13~15 秒），
  // 以前拿到第一张就 break → 用户要 3 个 GIF 只回 1 个。现在改成"静默窗口"：
  // 最后一次发现新图之后，再安静 DRAIN_QUIET_MS 才收工；总时长有上限。
  // 【2026-11-06 修正】PNG 相邻 13~15s，GIF 相邻 40~78s（实测第二个 GIF 在 +78s 才出现），
  // 固定 18s 静默会把慢的掐掉 → 改成"按用户要的数量决定等多久"。
  const plan = drainPlan(prompt, n);
  const wantN = plan.wantN;
  const drain = plan.drain;
  const DRAIN_QUIET_MS = plan.quietMs;
  const DRAIN_MAX_MS = plan.maxMs;

  // 【2026-11-03】SSE 结束时"只有参考图/没有新图" —— 先别急着判失败。
  // thinking 档的对话会在后台继续画，图最后落在对话里（实测 SSE 4s 结束、41s 才出图）。
  // 这里按 convId 轮询对话把图补捞回来，避免"误判失败 → 回退原生 → 又画一张"。
  let list = currentFresh();
  if (returnedConvId && (drain || !list.length)) {
    log(`开始盯对话（${list.length ? `已有 ${list.length}/${wantN} 张` : `SSE 没给图，期待 ${wantN} 张`}；`
      + `静默窗口 ${Math.round(DRAIN_QUIET_MS / 1000)}s，上限 ${Math.round((list.length ? DRAIN_MAX_MS : CONV_RECOVER_MS) / 1000)}s）`
      + ` conv=${returnedConvId.slice(0, 8)}`);
    const hardDeadline = Date.now() + (list.length ? DRAIN_MAX_MS : CONV_RECOVER_MS);
    let lastNewAt = list.length ? Date.now() : 0;
    let prevCount = list.length;
    let round = 0;
    while (Date.now() < hardDeadline) {
      await new Promise((r) => setTimeout(r, 4000));
      round++;
      try {
        convJson = await fetchConversationJson(token, returnedConvId);
        ids.push(...collectImageIds(convJson, t0 / 1000));
        dumpConversationAssets(convJson, { label: `盯对话第${round}轮`, sinceTs: t0 / 1000, preexisting, refFileIds });
      } catch (e) {
        log(`  对话查询失败：${String(e.message).slice(0, 80)}`);
      }
      list = currentFresh();
      if (list.length > prevCount) {
        prevCount = list.length;
        lastNewAt = Date.now();
        log(`  ➕ 又有新图：本轮累计 ${list.length} 张（${list.map((a) => sid(a.id)).join(', ')}）`);
      }
      const ended = turnCompleted(convJson);
      log(`  盯对话：end_turn=${ended ? 'Y' : 'N'} preexisting=${preexisting.size} 候选=${ids.length} 本轮共=${list.length}`
        + `（第 ${round} 轮，等了 ${((Date.now() - t0) / 1000).toFixed(1)}s`
        + `${list.length ? `，静默 ${((Date.now() - lastNewAt) / 1000).toFixed(1)}s` : ''}）`);
      if (list.length && ended) {
        log(`  ✅ 收工：上游 end_turn=true（本轮 ${list.length} 张${wantN > 1 ? `，你要的是 ${wantN} 张` : ''}）`
          + ` 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        break;
      }
      if (list.length && Date.now() - lastNewAt >= DRAIN_QUIET_MS) {
        log(`  ✅ 收工：共 ${list.length} 张（静默 ${Math.round(DRAIN_QUIET_MS / 1000)}s 没有新图）`
          + ` 等了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        break;
      }
    }
  }

  const noImageError = () => {
    // 没有图 → 把模型的话原样抛出（内容政策/其他）
    const said = [...text.matchAll(/"parts":\["((?:[^"\\]|\\.)*)"/g)]
      .map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return ''; } })
      .filter((s) => s && s.trim()).join(' ').slice(0, 300);
    return Object.assign(new Error(said || '网页管线没有返回图片'), {
      upstream: true, refusal: /内容政策|content policy/i.test(said), definitive: true, web: true,
      conversationId: returnedConvId,
    });
  };
  if (!list.length) throw noImageError();

  // 多图：一个 asset 一个 data 项。上限防爆（上游偶尔会吐一堆）。
  const MAX_IMAGES = Math.max(1, Number(process.env.WEB_MAX_IMAGES || 8));
  if (list.length > MAX_IMAGES) {
    log(`  ⚠️ 本轮 ${list.length} 张，超过上限 ${MAX_IMAGES}，只返回前 ${MAX_IMAGES} 张`);
    list = list.slice(0, MAX_IMAGES);
  }
  const assets = [];
  for (const a of list) {
    let id = a.id;
    let mime = a.mime || '';
    let spriteId = a.spId || '';
    let animation = null;
    const gen = a.gen || {};
    const anim = gen.animation || {};
    if (anim.rows && anim.columns && anim.frame_count) {
      animation = {
        rows: anim.rows, columns: anim.columns, frame_count: anim.frame_count,
        frame_duration_ms: anim.frame_duration_ms || 160,
      };
    }
    const variants = gen.gif_speed_variants || {};
    if (gifSpeed) {
      log(`  gif_speed=${gifSpeed} 变体=${Object.keys(variants).length ? Object.keys(variants).join('/') : '空'}`);
    }
    if (gifSpeed && variants[String(gifSpeed)]) {
      // 变体只是同一个文件的时序档位：取里面的 file 段，别拿变体前缀去下载（会 file_not_found）
      const vid = fileIdFromPointer(variants[String(gifSpeed)]);
      if (vid) { id = vid; mime = 'image/gif'; }
      const k = Number(gifSpeed);
      if (animation && k > 0) {
        const base = Number(animation.frame_duration_ms || 160);
        const scaled = Math.max(20, Math.round(base / k));
        animation = { ...animation, frame_duration_ms: scaled };
        log(`  速度 ${gifSpeed}x → frame_duration_ms ${base} → ${scaled}（文件与 1x 相同）`);
      } else {
        log(`  ⚠️ speed=${gifSpeed} 但这一张没有 animation 元数据，速度只能靠前端播放器`);
      }
    }
    // 从 SSE 顶上来的候选不带 mime/sprite → 用 findGifAsset 兜底识一次 GIF
    if (!mime && returnedConvId) {
      try {
        const g = await findGifAsset(token, returnedConvId, gifSpeed, t0 / 1000, convJson);
        if (g) { id = g.id; mime = g.mime; spriteId = g.spriteId || ''; animation = g.animation || animation; }
      } catch (e) {
        log(`  查 GIF 失败（忽略）：${String(e.message).slice(0, 60)}`);
      }
    }
    if (!mime || mime === 'N/A') mime = 'image/png';
    if (preexisting.has(id) || refFileIds.has(id)) {
      log(`  ⚠️ 跳过 ${sid(id)}：命中 preexisting/参考图（判定逻辑异常，宁缺勿旧）`);
      continue;
    }
    if (assets.some((x) => x.assetId === id)) continue;   // 同一 asset 只返回一次
    let d;
    try {
      d = await downloadAsset(token, id);
    } catch (e) {
      // speed 变体不是可下载文件时退回原版（1x）：动图仍然出，只是速度不是用户要的那档
      if (id !== a.id) {
        log(`  ⚠️ 变体 ${sid(id)} 下载失败（${String(e.message).slice(0, 60)}）→ 退回原版 ${sid(a.id)}`);
        id = a.id;
        d = await downloadAsset(token, id);
      } else {
        throw e;
      }
    }
    const tag = crypto.createHash('sha1').update(Buffer.from(d.b64, 'base64')).digest('hex').slice(0, 10);
    // 【2026-11-06】不再下载 sprite sheet：前端直接播 GIF 自己的帧（ImageDecoder），
    // 这张九宫格每张图白拉 2MB 且是"裁切"问题的源头，只保留 animation 元数据。
    const spriteB64 = '';
    if (spriteId) log(`  跳过 sprite 下载（${sid(spriteId)}，前端用 GIF 自己的帧播放）`);
    if (assets.some((x) => x.sha1 === tag)) {
      log(`  ⚠️ ${sid(id)} 与已下载的图字节完全相同（sha1=${tag}），跳过重复`);
      continue;
    }
    log(`  ✔ ${assets.length + 1}/${list.length} ${mime} ${Math.round((d.bytes || 0) / 1024)}KB`
      + ` asset=${sid(id)} sha1=${tag}`);
    assets.push({ b64: d.b64, bytes: d.bytes || 0, mime, spriteB64, animation, assetId: id, sha1: tag });
  }
  if (!assets.length) throw noImageError();

  const _usedCookie = currentAccount();
  // 【2026-11-06】只清"自己的"那个号，别把并发请求的号清掉
  if (pool.current === _usedCookie) pool.current = '';
  const first = assets[0];
  // 【2026-11-06】带上张数 + asset + sha1：两轮 sha1 相同 = 真的返回了同一张图
  log(`✅ 网页管线出图 ${assets.length} 张 [${assets.map((x) => `${x.mime} ${Math.round(x.bytes / 1024)}KB`).join(' | ')}]`
    + ` 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s asset=${sid(first.assetId)} sha1=${first.sha1}`
    + `${returnedConvId ? ` conv=${returnedConvId.slice(0, 8)}` : ''}`);
  return {
    b64: first.b64, mime: first.mime, spriteB64: first.spriteB64, animation: first.animation,
    assets, sha1: first.sha1, reqId: first.assetId,
    elapsed: (Date.now() - t0) / 1000, model, conversationId: returnedConvId, cookieName: _usedCookie,
  };
}

/**
 * 从一个对话里把所有图片资源指针捞出来（新的在前）。
 * 用途：SSE 没带图时，对话里可能已经有图了。
 */
async function assetsInConversation(conversationId, token, sinceTs = 0) {
  if (!conversationId) return [];
  const tk = token || await getAccessToken();
  const j = await fetchConversationJson(tk, conversationId);
  return collectImageIds(j, sinceTs);
}

/**
 * 取一个对话当前的叶子节点 id —— 下一轮的 parent_message_id 用它。
 * 不要从 SSE 里猜 assistant 消息 id，那个不可靠；这里查一次对话最准。
 */
export async function getConversationLeaf(conversationId, token, cookieName = '') {
  if (!conversationId) return '';
  // 【2026-11-06】必须钉在"画这张图的号"上：generateViaWeb 返回前已经把 pool.current 清空，
  // 这里不钉号就会用另一个号的 token 去读对话 → 404 "你无权访问此对话"
  // → 叶子节点拿不到 → 下一轮 parent 变成随机 uuid（对话被分叉/续接变得不可靠）。
  // 【2026-11-06】改成走异步上下文钉号：不再临时改全局 pool.current（并发时会串别人的号）
  const run = async () => {
    const tk = token || await getAccessToken();
    const j = await fetchConversationJson(tk, conversationId);
    return (j && j.current_node) || '';
  };
  if (cookieName && listPool().includes(cookieName)) {
    return accountCtx.run({ cookieName }, run);
  }
  return run();
}

/**
 * 主动探一次每个号的凭据是否还有效（一次 /api/auth/session，纯读，不生成图）。
 * 用于 /web/creds：cookie 过期时接口会明确告诉调用方，而不是"出图变静态"。
 */
export async function probeWebCredentials() {
  const files = listPool();
  const out = [];
  for (const name of files) {
    try {
      const r = await accountCtx.run({ cookieName: name }, async () => {
        const tok = await getAccessToken(true);
        const exp = jwtExpMs(tok);
        return { ok: true, expiresAt: exp ? new Date(exp).toISOString() : null, expired: !!(exp && exp < Date.now()) };
      });
      out.push({ account: name, ...r });
    } catch (e) {
      out.push({ account: name, ok: false, error: String(e.message).slice(0, 120) });
    }
  }
  return { accounts: out, anyExpired: out.some((a) => a.expired), anyInvalid: out.some((a) => a.ok === false) };
}

/** 网页管线凭据状态（给 /health 用，别把 token 本身吐出去） */
export function webCredentialStatus() {
  const now = Date.now();
  const entries = [...tokenCache.entries()].map(([name, v]) => ({
    account: name, expiresAt: v && v.expires ? new Date(v.expires).toISOString() : null,
    expired: !!(v && v.expires && v.expires < now),
  }));
  return {
    expired: entries.some((e) => e.expired) || (lastExpiredAt && lastExpiredAt < now && !entries.length),
    lastExpiredAt: lastExpiredAt ? new Date(lastExpiredAt).toISOString() : null,
    accounts: entries,
  };
}

export const WEB = {
  enabled: String(process.env.WEB_PIPELINE || '0') === '1',
  model: MODEL_OVERRIDE === 'auto' ? 'auto（动态）' : MODEL_OVERRIDE,
  cookieFile: COOKIE_FILE,
};

// 【2026-11-06】给"同号互斥"留一个可单测的出口（不参与业务，只在容器里 node -e 验证用）
export const __test = {
  acquireAccountForNewConv, releaseNewConvAccount, newConvBusy, breakerLeftS, requestedCount, drainPlan, turnCompleted,
  resetBreaker: () => {
    breakerUntil = 0; breakerReason = ''; convAttempts.length = 0;
    newConvBusy.clear(); lastNewConvByAccount.clear();
  },
  // 并发隔离自测用：把号钉进上下文后读 cookie，看会不会被"全局被改"带跑
  accountCtx, readCookie, getAccessToken, currentAccount,
  setPoolCurrent: (n) => { pool.current = n; },
  poolSnapshot: () => ({ current: pool.current, blocked: { ...pool.blocked } }),
};
