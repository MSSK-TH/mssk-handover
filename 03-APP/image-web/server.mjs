/**
 * MSSK 生图站 —— 后端
 * ============================================================================
 *  零依赖（只用 node 内置模块）。做的事：
 *    1. 静态前端
 *    2. 口令登录（HMAC 签名 cookie）
 *    3. 对话/图片的本地存储（JSON + PNG，挂卷）
 *    4. 把 /v1/responses 的 SSE 转成"人能看懂的阶段进度"再推给浏览器
 *
 *  和 生图.ps1 的关系：**同一套调用方式**（Responses API + image_generation 工具），
 *  只是执行者从 Codex 的 shell 换成了这台常驻服务。
 *
 *  为什么在容器里直连 new-api：不绕公网、不经过 Windows Schannel，
 *  也不再受"沙箱只允许写工作目录"那一类限制。
 * ============================================================================
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------- sharp（可选）
// 用来把成图转成 WebP（显示用，体积约为 PNG 的 1/6~1/8）。
// 没装 sharp 也不会崩：自动退回"直接发 PNG"。
const requireCjs = createRequire(import.meta.url);
let sharp = null;
try {
  sharp = requireCjs('sharp');
  // 【2026-11-04】libvips 默认按 CPU 数开线程池，转一张 1600px 的 WebP 会同时铺满几个
  // worker，内存冲到 300M+，把容器自己的 mem_limit 顶爆（实测 OOM 8 次，
  // 内核日志里就是 "libvips worker invoked oom-killer"）。
  // 限到 1：转换慢一点无所谓（单张几十毫秒），但峰值内存减半。
  sharp.concurrency(1);
} catch {
  sharp = null;
}
import { classifyError, humanizeModeration, translateUpstream } from './lib/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- .env
// 可选：把 <程序目录>/.env 里的键值读进来（已存在的环境变量优先，不覆盖）。
// Docker 部署时走 env_file，本地直接 node server.mjs 时走这里 —— 两种都一样能用。
try {
  const txt = await fsp.readFile(path.join(__dirname, '.env'), 'utf8');
  let n = 0;
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) { process.env[m[1]] = v; n++; }
  }
  console.log(`[env] 已从 .env 读取 ${n} 项`);
} catch {}

// ---------------------------------------------------------------- 配置
const CFG = {
  port: Number(process.env.PORT || 8787),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  relayBase: (process.env.RELAY_BASE || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
  // 【2026-10-30】网关地址。原来写死 http://imagegen-shim:8899 —— 那是 DMIT 上的容器名，
  // 阿里云这台解析不了 → /api/models 每次 fetch 失败 → 静默回退成 relay 的对话模型表
  // → 前端「网页模式 + 推理档」下拉永远拿不到 slug。改成实地址，可用 SHIM_BASE 覆盖。
  shimBase: (process.env.SHIM_BASE || 'http://127.0.0.1:8899').replace(/\/+$/, ''),
  relayToken: process.env.RELAY_TOKEN || '',
  relayModel: process.env.RELAY_MODEL || 'gpt-5.6-sol',
  // 推理程度（reasoning.effort）
  // 实测 2026-09-21（5 个模型 × 9 个取值，逐个打上游验证，错误信息里带官方清单）：
  //   · 不传 = medium（上游回显证实）
  //   · ultra **不存在**（上游原文：Supported values are: 'none','minimal','low','medium','high','xhigh','max'）
  //   · minimal 对**这 5 个模型全都不支持**
  //   · gpt-5.5 额外不支持 max（它的清单只到 xhigh）
  //   · 生效证据：上游会把 effort 原样回显在 response 里
  defaultEffort: process.env.REASONING_EFFORT || 'medium',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 300000),
  password: process.env.ACCESS_PASSWORD || '',
  /**
   * 登录方式：
   *   password（默认）= 本地口令，完全离线比对
   *   token          = **用中转站令牌当口令**：本地名单比对之后，再去 new-api 实时校验该令牌是否有效。
   *                    好处：在后台吊销/删除令牌 → 站点立刻登不上（不用改这里的环境变量）。
   *                    名单形如 ACCESS_USERS=小明:sk-xxx,小红:sk-yyy；不配名单则任何有效令牌都能登
   *                    （身份退化成令牌前缀）。
   */
  authMode: (process.env.AUTH_MODE || 'password').toLowerCase() === 'token' ? 'token' : 'password',
  users: (process.env.ACCESS_USERS || '')      // 形如 "alice:pw1,bob:pw2"（token 模式下 password 处填 sk- 令牌）
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const i = s.indexOf(':'); return { name: s.slice(0, i), password: s.slice(i + 1) }; })
    .filter((u) => u.name && u.password),
  maxPromptChars: Number(process.env.MAX_PROMPT_CHARS || 4000),
  // 参考图：实测一次带 2 张（4.8MB 请求体）没问题，这里留点余量
  maxRefs: Number(process.env.MAX_REFS || 4),
  maxRefBytes: Number(process.env.MAX_REF_MB || 8) * 1024 * 1024,
  // 防滥用：这条链路烧的是你的订阅额度，1C1G 的机器也扛不住并发
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 2),
  minGapMs: Number(process.env.MIN_GAP_MS || 5000),
  /**
   * 拿不到图时的自动重试（和网关 imagegen-shim 的 RETRY_ATTEMPTS 对齐）。
   * 实测：上游是**成簇瞬时失败**的 —— 同一个请求上一次 56.7s 成功，下一次 13s 就空手而归。
   * 所以"HTTP 200 但流里没有图片数据"值得换一个全新请求再打一次。
   * 内容安全拒绝**不重试**（同一个提示词重试没有意义，见 lib/errors.mjs 的 content_refusal）。
   * 设 GENERATE_RETRY_ATTEMPTS=1 即可关闭。
   */
  retryAttempts: Number(process.env.GENERATE_RETRY_ATTEMPTS || 2),
  retryDelayMs: Number(process.env.GENERATE_RETRY_DELAY_MS || 3000),

  /**
   * 【2026-10-16 新增】生图走哪条路：
   *   native（默认）= 直接打 /v1/images/generations｜edits（原生图像端点）
   *                   —— 快 2~3 倍（文生图 14.6s / 参考图 24.5s / 被拒 26.9s）
   *                   —— **没有对话模型**：所以不会再出现"抱歉，我无法基于这张角色图…"这类
   *                      【对话式拒绝】（线上日志里出现过 6 次，重试永远不会好）
   *                   —— 内容安全拒绝会带回**结构化信息**（判定阶段/类别/请求 ID）
   *   responses     = 老路（/v1/responses + image_generation 工具）：有细粒度阶段进度，
   *                   但慢、且会被对话模型拒绝。留着做对照和一键回滚。
   */
  generatePath: (process.env.GENERATE_PATH || 'native').toLowerCase() === 'responses' ? 'responses' : 'native',
  // 原生路用的**图像模型名**（老路的 relayModel 是对话模型，两者不是一回事）
  imageModel: process.env.IMAGE_MODEL || 'gpt-image-2.6-flare',
  // 可选的生图模型：gpt-image-2 = 网页管线优先；codex-gpt-image-2 = 只走原生
  imageModelChoices: ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'codex-gpt-image-2.6-flare', 'codex-gpt-image-2.6-sunburst', 'gpt-image-2', 'codex-gpt-image-2'],
  // 原生路的硬上限：慢图（4K/复杂构图）不该被 300s 掐掉；
  // 上游空闲检测由网关（imagegen-shim）负责，这里只兜底
  nativeWallMs: Number(process.env.NATIVE_WALL_MS || 900000),
  // 原生路没有细粒度阶段事件 → 用它给用户"还活着"的进度心跳
  progressTickMs: Number(process.env.PROGRESS_TICK_MS || 10000),

  /**
   * 【2026-10-16 新增】定期清理：
   *   · 图片与对话记录**超过 TTL 就删**（默认 90 天 = 3 个月）
   *   · 目的是防磁盘占满（这台机器只有 20G，单张图 1~7MB）
   *   · 设 IMAGE_TTL_DAYS=0 可关闭清理
   */
  imageTtlDays: Number(process.env.IMAGE_TTL_DAYS || 90),
  cleanupIntervalHours: Number(process.env.CLEANUP_INTERVAL_HOURS || 24),

  /**
   * WebP（显示用）。原 PNG 永远保留 → 只有带 ?raw=1 下载时才拿原图。
   *   · WEBP=0        关闭（完全退回 PNG）
   *   · WEBP_MAX_W    显示用的最长边，默认 1600
   *   · WEBP_QUALITY  质量，默认 82（肉眼几乎无差别）
   */
  webpEnabled: String(process.env.WEBP ?? '1') !== '0',
  webpMaxW: Number(process.env.WEBP_MAX_W || 1600),
  webpQuality: Number(process.env.WEBP_QUALITY || 82),
};

if (!CFG.relayToken) {
  console.error('[FATAL] 缺 RELAY_TOKEN（中转站的 sk- 令牌）');
  process.exit(1);
}
// ⚠️ token 模式下不需要本地口令/名单（凭据就是各自的中转站令牌），别在这里把它拦下来
if (CFG.authMode !== 'token' && !CFG.password && CFG.users.length === 0) {
  console.error('[FATAL] 缺 ACCESS_PASSWORD 或 ACCESS_USERS —— 这个站会消耗你的账号额度，必须设口令');
  console.error('        或者用 AUTH_MODE=token（口令=各自的中转站令牌）');
  process.exit(1);
}

const PUBLIC_DIR = path.join(__dirname, 'public');

// 【2026-10-16】构建指纹：静态文件或 server.mjs 一变就变 → 前端据此判断「该刷新了」。
// 用 size+mtime（每次启动算一次，成本≈0），部署/重启都会换新值。
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['server.mjs', 'lib/errors.mjs', 'public/app.js', 'public/index.html', 'public/style.css']) {
    try {
      const st = fs.statSync(path.join(__dirname, f));
      h.update(`${f}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch { /* 文件不存在就跳过 */ }
  }
  return h.digest('hex').slice(0, 12);
})();
const STARTED_AT = new Date().toISOString();
const API_BASE = CFG.relayBase.endsWith('/v1') ? CFG.relayBase : CFG.relayBase + '/v1';
const RESPONSES_URL = API_BASE + '/responses';

// ---------------------------------------------------------------- 小工具
await fsp.mkdir(CFG.dataDir, { recursive: true });

// 会话密钥：没配就生成一次并落盘，重启后 cookie 仍然有效
let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  const f = path.join(CFG.dataDir, '.session-secret');
  try { SESSION_SECRET = (await fsp.readFile(f, 'utf8')).trim(); } catch {}
  if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    await fsp.writeFile(f, SESSION_SECRET, { mode: 0o600 });
  }
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const json = (res, code, obj, extra = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
};
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'x';

/** 校验并解析参考图 data URL → { mime, ext, bytes, dataUrl } */
function parseRefDataUrl(s) {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(s || ''));
  if (!m) return null;
  const mime = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
  const bytes = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (bytes.length < 32) return null;
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  return { mime, ext, bytes, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
}

function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeSession(user, days = 30) {
  const exp = Date.now() + days * 864e5;
  const payload = `${user}|${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}
function readSession(cookieHeader) {
  const raw = /(?:^|;\s*)mssk_img=([^;]+)/.exec(cookieHeader || '')?.[1];
  if (!raw) return null;
  const [b64, mac] = raw.split('.');
  if (!b64 || !mac) return null;
  let payload;
  try { payload = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  const expect = sign(payload);
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  const [user, exp] = payload.split('|');
  if (!user || Number(exp) < Date.now()) return null;
  return { user, exp: Number(exp) };
}
function checkPassword(user, password) {
  if (CFG.password) {
    // 单人共享口令：用户名固定为 owner
    if (user && user !== 'owner') return false;
    return password.length === CFG.password.length &&
      crypto.timingSafeEqual(Buffer.from(password), Buffer.from(CFG.password));
  }
  const hit = CFG.users.find((u) => u.name === user);
  if (!hit) return false;
  return password.length === hit.password.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(hit.password));
}

/**
 * token 模式：拿这个令牌去 new-api 问一次「你认不认它」。
 * 实测（2026-09-21，容器内网）：
 *   不带令牌 → 401；带的令牌有效 → 200；伪造的令牌 → 401
 * 所以 /v1/models 就是个可靠的"令牌是否有效"检查器，不需要改 new-api 后端。
 * 注意：new-api 连不上时**不放行**（本站生图本来就要靠它，放行只会让人以为能用）。
 */
async function verifyRelayToken(token) {
  try {
    const r = await fetch(API_BASE + '/models', {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(Number(process.env.TOKEN_CHECK_TIMEOUT_MS || 8000)),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/** 统一登录判定。返回 { ok, user, reason } */
async function checkCredential(user, password) {
  if (CFG.authMode !== 'token') {
    return checkPassword(user, password)
      ? { ok: true, user: CFG.password ? 'owner' : user }
      : { ok: false, reason: '口令不正确' };
  }

  // ---- token 模式：**只用令牌登录**，不需要用户名 ----
  // 身份取令牌前 12 个字符：每人一个令牌 → 天然隔离，不用再维护名单
  const raw = String(password || '').trim();
  if (!raw) return { ok: false, reason: '请粘贴你的中转站令牌' };
  const token = /^sk-/.test(raw) ? raw : 'sk-' + raw;   // 容错：漏了 sk- 也认

  const v = await verifyRelayToken(token);
  if (!v.ok) {
    log('登录失败：令牌校验未通过 status=', v.status);
    return {
      ok: false,
      reason: v.status === 401 ? '令牌无效或已被吊销（去后台确认一下）' : '无法连接中转站校验令牌，稍后再试',
    };
  }
  const identity = token.slice(0, 12);
  log(`登录成功 ${identity}…（令牌实时校验通过）`);
  return { ok: true, user: identity };
}

// ---------------------------------------------------------------- 存储
const userDir = (user) => path.join(CFG.dataDir, 'users', safeName(user));
const convFile = (user, id) => path.join(userDir(user), 'conversations', `${safeName(id)}.json`);
const imgDir = (user, id) => path.join(userDir(user), 'images', safeName(id));

async function listConversations(user) {
  const dir = path.join(userDir(user), 'conversations');
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter((n) => n.endsWith('.json'))) {
    try {
      const c = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
      out.push({
        id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
        count: c.messages.filter((m) => m.role === 'assistant').length,
        cover: c.messages.flatMap((m) => m.images || []).slice(-1)[0]?.url || null,
      });
    } catch {}
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
async function readConversation(user, id) {
  try { return JSON.parse(await fsp.readFile(convFile(user, id), 'utf8')); }
  catch { return null; }
}
async function writeConversation(user, conv) {
  conv.updatedAt = Date.now();
  await fsp.mkdir(path.dirname(convFile(user, conv.id)), { recursive: true });
  const tmp = convFile(user, conv.id) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(conv, null, 2));
  await fsp.rename(tmp, convFile(user, conv.id));
}
function newConversation(user) {
  const id = 'c' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  return { id, user, title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

// ---------------------------------------------------------------- 请求内容组装
/**
 * 两条线分清楚，不再有"勾选才生效"的开关：
 *
 *   ① **上下文** = 这个对话里的文字历史，**永远自动带上**（和 Codex 一样无状态重发）。
 *      模型因此记得你前面描述过的风格、主角、设定。
 *   ② **参考图** = 图片，**只认托盘里那些**（用户上传的 / 点了"用作参考图"的）。
 *      想拿上一张生成结果去改，就点那张图下面的"用作参考图"，它会变成可见的参考图1。
 *
 * 为什么不做"自动带上一张图"：同一个效果有两个入口（勾选框 + 托盘）会让人分不清
 * "到底是用它当参考，还是只是保留上下文"，所以只留显式的那个。
 *
 * 多张参考图时，模型靠**顺序 + 提示词里的编号**区分，所以下面自动加一行编号说明。
 */
function buildInput(conv, { prompt, refDataUrls = [] }) {
  const input = [];
  const history = conv.messages.filter((m) => m.text);
  for (const m of history) {
    if (m.role === 'user') {
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: m.text }] });
    } else {
      input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.text }] });
    }
  }

  const images = [...refDataUrls];
  let text = prompt;
  if (images.length) {
    const labels = images.map((_, i) => `参考图${i + 1}`).join('、');
    text = `（本次附带 ${images.length} 张图，按出现顺序依次是：${labels}）\n${prompt}`;
  }
  const content = [{ type: 'input_text', text }];
  for (const url of images) content.push({ type: 'input_image', image_url: url });
  input.push({ type: 'message', role: 'user', content });
  return input;
}

/**
 * 推理档位：上游是**按模型**校验的，所以这里也按模型给清单。
 *
 * ⚠️ 两个来源不一致，以**实测能跑通**的为准：
 *   · 官方下发给客户端的目录（~/.codex/models_cache.json）声称 sol 支持 low..ultra、默认 low
 *   · 但实际打上去：ultra → 400 `Invalid value: 'ultra'`；
 *     minimal → 400 `not supported with the 'gpt-5.6-sol' model`；
 *     不传 → 上游回显 medium。
 *   结论：目录比这条 API 面新（中转站是以 `originator: codex_cli_rs` 身份打上去的）。
 *   所以按实测表来，不然用户选了就 400。
 */
const EFFORT_BY_MODEL = {
  // 【2026-11-18 实测】
  //   · ultra：上游 200 接受，实际按 max 执行（"自动任务委派"是客户端行为）
  //   · ultrafast：不是 effort，是 service_tier（客户端的 Fast/Ultrafast 速度档），别放这里
  //   · minimal 五个模型全不支持；gpt-5.5 连 max 都不支持
  'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-astra': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6.1-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6.1-terra': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6.2-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6.2-astra': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};
const DEFAULT_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const effortsFor = (model) => EFFORT_BY_MODEL[model] || DEFAULT_EFFORTS;

/** 可用模型清单：从上游 /v1/models 拉，只留支持 Responses、且不是图片模型的
 *  注意：gpt-image-2 这类图片模型也报 openai-response，但它是「空端点」——
 *  在这条链路上选它只会误导用户，所以按端点类型 + 名字双重排除。
 */const FALLBACK_MODELS = ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra'];
let modelsCache = { at: 0, list: FALLBACK_MODELS };
async function listModels() {
  if (Date.now() - modelsCache.at < 10 * 60 * 1000) return modelsCache.list;
  try {
    const r = await fetch(API_BASE + '/models', { headers: { Authorization: `Bearer ${CFG.relayToken}` } });
    if (r.ok) {
      const j = await r.json();
      const list = (j.data || [])
        .filter((m) => Array.isArray(m.supported_endpoint_types) && m.supported_endpoint_types.includes('openai-response'))
        // 排除图片模型：它们虽然也声明 openai-response，但这里选它跑不通
        .filter((m) => !(Array.isArray(m.supported_endpoint_types) && m.supported_endpoint_types.includes('image-generation')))
        .filter((m) => !/^gpt-image/i.test(m.id))
        .map((m) => m.id);
      if (list.length) { modelsCache = { at: Date.now(), list }; return list; }
      log('上游模型列表里没有支持 Responses 的模型，用兜底清单');
    }
  } catch (e) { log('拉模型列表失败，用兜底清单：', e.message); }
  modelsCache = { at: Date.now(), list: FALLBACK_MODELS };
  return modelsCache.list;
}

// [2026-11-05] 从 GIF 头读宽高（Logical Screen Descriptor，偏移 6，小端 2 字节）
function gifSize(buf) {
  if (!buf || buf.length < 10) return null;
  if (buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46) return null;  // GIF
  return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

function pngSize(buf) {  if (buf.length > 24 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return null;
}

// ---------------------------------------------------------------- 阶段映射
/**
 * 把上游/中转站的报错分类，好让界面给出"能照做"的提示。
 * 两种过载要分清（交接文档里的实测结论）：
 *   · server_is_overloaded  → **上游**（OpenAI）过载：HTTP 200，但流里带 error 事件，
 *     且 headers.x-retry-metadata = NO_MORE_RETRY（上游在说"别再重试了"）
 *   · system cpu overloaded → **我们中转站**的 CPU 打满（1 核），HTTP 503
 */
/** 把上游 SSE 事件翻成前端能显示的阶段 */
function stageOf(event) {
  switch (event) {
    case 'response.created':
    case 'response.in_progress': return { stage: 'connected', label: '已连接上游' };
    case 'response.image_generation_call.in_progress': return { stage: 'drawing', label: '开始绘制' };
    case 'response.image_generation_call.generating': return { stage: 'generating', label: '绘制中' };
    case 'response.image_generation_call.completed': return { stage: 'finalizing', label: '收尾' };
    case 'response.completed': return { stage: 'completed', label: '完成' };
    // 注意：不要映射 response.output_item.added ——
    // 它在开头(reasoning)和结尾(message)各触发一次，会在"收尾"之后把进度打回"理解提示词"
    default: return null;
  }
}

// ---------------------------------------------------------------- 比例词表
/**
 * ⚠️ 这张表是把网关（imagegen-shim）的做法原样搬过来的，别再改回中文/像素数。
 *
 * 官方对图像模型下发的"画幅"本来就是 **Label + Size 成对**的英文词表，
 * 所以这里只用英文 `en` 当锚点，`name` 只是给人看的记号。
 *
 * 【为什么必须去掉像素数】旧版写的是
 *   「请生成一张画布比例与参考图1 完全一致的图片（参考图1 是 1672×941，宽高比 1.777）」
 * 实测这会把模型引向"先造一张 1672×941 的画布、再把内容贴进去"，
 * 产出上下边缘同色的伪影；而且 1672 和 941 是互质数，比例根本约不掉，模型只能瞎猜。
 * 现在只说 "widescreen landscape (16:9)"，模型按原生比例出图。
 */
const RATIO_TABLE = [
  { v: 1, name: '1:1', en: 'square' },
  { v: 4 / 3, name: '4:3', en: 'landscape' },
  { v: 3 / 2, name: '3:2', en: 'standard landscape' },
  { v: 16 / 9, name: '16:9', en: 'widescreen landscape' },
  { v: 3, name: '3:1', en: 'ultra-wide landscape' },
  { v: 3 / 4, name: '3:4', en: 'portrait' },
  { v: 2 / 3, name: '2:3', en: 'standard portrait' },
  { v: 9 / 16, name: '9:16', en: 'vertical portrait' },
];

/** 把实际宽高比匹配到词表里最近的一项（5% 容差），匹配不到返回 null */
function ratioMatch(w, h) {
  const r = w / h;
  let best = null;
  let bestErr = 0.05;
  for (const row of RATIO_TABLE) {
    const err = Math.abs(r - row.v) / row.v;
    if (err < bestErr) { bestErr = err; best = row; }
  }
  return best;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 上游的"内容安全拒绝"不是 error 事件，而是一段普通文字。
 * 认出来就别重试了（同一提示词重试必然再被拒，白烧额度）。
 */
const REFUSAL_RE = /内容安全|安全系统|safety system|image safety|flagged by the image|rejected by the image|couldn[’']t generate this image|unable to generate this image/i;
const isRefusalText = (s) => !!s && REFUSAL_RE.test(String(s));

// ---------------------------------------------------------------- SSE 上游解析
async function streamGenerate({ conv, prompt, ratio, refSize, refs = [], model, effort, background = '', imageModel = '',
  // 【2026-10-30】网页管线的三个上游参数。前端一直在发，但这里以前没有接收，
  // 导致界面上的「聊天/工作」「推理档」「模型版本」三个开关全是装饰品。
  webMode = '', webModel = '', webEffort = '',
  res, user, outerAc = null }) {
  // 比例（实测：请求参数控不了，只有写进提示词才有效）
  //   ''     = 让模型自己定
  //   'auto' = 画布宽高比自动适配参考图1（改图时最常用）
  //   其它    = 指定比例
  //
  // ⚠️ 2026-10-15 改：以前这里是**中文**，而且把**像素数**写进了提示词
  //    （"参考图1 是 1672×941，宽高比 1.777"）—— 那正是造出"上下边缘同色伪影"的写法。
  //    现在与网关（imagegen-shim）完全对齐：只用官方英文比例名，**不出现任何像素数**。
  //    这段是给上游图像模型看的内部指令，用户看不到，所以固定英文。
  let ratioLabel = ratio;
  const reqs = [];
  if (ratio === 'auto') {
    const dim = (refSize && refSize.w > 0 && refSize.h > 0) ? refSize : (refs[0] ? pngSize(refs[0].bytes) : null);
    const hit = dim ? ratioMatch(dim.w, dim.h) : null;
    ratioLabel = dim ? `适应原图 ${dim.w}×${dim.h}${hit ? `（≈${hit.name}）` : ''}` : '适应原图';
    reqs.push(hit
      ? `Aspect ratio: exactly match reference image 1 — ${hit.en} (${hit.name}). Frame the entire image natively at this ratio; no border, letterboxing, or padding`
      : 'Aspect ratio: exactly match reference image 1. Frame the entire image natively at that ratio; no border, letterboxing, or padding');
  } else if (ratio) {
    const hit = RATIO_TABLE.find((r) => r.name === ratio);
    reqs.push(`Aspect ratio: ${hit ? `${hit.en} (${hit.name})` : ratio}. Frame the entire image natively at this ratio; no border, letterboxing, or padding`);
  }
  if (background === 'transparent') {
    // 透明底（实测 2026-10-15）：**把要求写进提示词就能出真透明 PNG**（alpha 占比 52.4%）。
    // 而 background:transparent **作为参数**发给上游会被 400 拒掉，所以这里只折提示词、不传参。
    reqs.push('transparent background (preserve the alpha channel)');
  }
  const effPrompt = reqs.length ? `Requirements: ${reqs.join('; ')}\n${prompt}` : prompt;
  // 运维可见性：把折进提示词的英文要求打出来。出问题时一眼能看出"到底给模型发了什么"，
  // 也方便核对"比例/透明底"这类只有写进提示词才生效的东西有没有真的带上。
  if (reqs.length) log('折进提示词的要求：' + reqs.join('; '));

  // 参考图先落盘（每轮都存，对话历史里能看见"当时喂了什么图"）
  const refRecords = [];
  if (refs.length) {
    const dir = imgDir(user, conv.id);
    await fsp.mkdir(dir, { recursive: true });
    for (const rf of refs) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const file = `ref-${stamp}-${crypto.randomBytes(2).toString('hex')}.${rf.ext}`;
      await fsp.writeFile(path.join(dir, file), rf.bytes);
      refRecords.push({ file, url: `/api/images/${conv.id}/${file}`, bytes: rf.bytes.length });
    }
    log(`收到 ${refs.length} 张参考图，共 ${(refs.reduce((s, r) => s + r.bytes.length, 0) / 1024 / 1024).toFixed(2)}MB`);
  }

  const userMsg = { role: 'user', text: prompt, ratio: ratioLabel, at: Date.now(), images: [], refs: refRecords };
  conv.messages.push(userMsg);
  if (conv.title === '新对话') conv.title = prompt.slice(0, 24) || (refRecords.length ? '参考图生成' : '新对话');
  await writeConversation(user, conv);

  const body = {
    model: model || CFG.relayModel,
    stream: true,
    // ⚠️ 只发真正有效的东西（2026-10-15 复核过）：
    //   · size 被忽略 —— 分辨率恒在 ~1.57MP 量级，比例**只能写进提示词**
    //   · quality 被上游改写成 auto（low/medium/high 的分辨率/体积/耗时完全一样）
    //   · background:transparent **作为参数**会被上游 400 拒掉；
    //     但**把"透明底"写进提示词**就能出真透明 PNG（实测 alpha 占比 52.4%）
    // 所以工具参数一个都不发，工具只声明"我要用 image_generation"。
    tools: [{ type: 'image_generation' }],
    // 强制调用图像工具：这个站点的每一次请求都应该是"出图"。
    // 不带这个字段时，是否出图由模型自己决定；带上之后语义明确，也避免模型先写一段文字再画。
    // 实测（2026-09-21）：带 tool_choice 的裸请求与站点出图尺寸一致（1254×1254）。
    tool_choice: { type: 'image_generation' },
    input: buildInput(conv, { prompt: effPrompt, refDataUrls: refs.map((r) => r.dataUrl) }),
  };
  if (effort) body.reasoning = { effort };

  const send = (obj) => {
    if (obj && obj.stage) {                     // 把阶段记到 job 上，刷新后能恢复进度
      const j = jobs.get(`${user}/${conv.id}`);
      if (j) j.stage = obj.stage;
    }
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 没人看了 */ }
  };
  send({ type: 'stage', stage: 'connecting', label: '正在提交请求' });

  const ac = outerAc || new AbortController();
  let clientGone = false;      // 用户点了「停止」/关页面/刷新 → 只是"没人看直播了"
  // 【2026-11-06】以前这里 clientGone 就直接 ac.abort()：刷新一下就把正在画的图杀掉，
  // 违背"网页该有的行为"。现在断线只表示不再往这个 res 写，任务继续跑完并落库；
  // 用户刷新回来能看到结果（前端靠 running 标记 + 轮询恢复）。
  const onClose = () => { clientGone = true; };
  res.on('close', onClose);
  // 原生路更慢的图（4K/复杂构图）不该被 300s 掐掉；老路保持原值
  const wallMs = CFG.generatePath === 'native' ? CFG.nativeWallMs : CFG.requestTimeoutMs;
  const timer = setTimeout(() => ac.abort(), wallMs);
  // 两条路都定时发"还活着"的心跳：
  //   1) 原生路没有细粒度阶段事件，用户会以为卡死
  //   2) 过 Cloudflare / 反代时，空闲超过 ~100s 会被掐断，心跳能保住连接
  const ticker = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify({ type: 'stage', stage: 'generating', label: `上游正在渲染（已用 ${((Date.now() - t0) / 1000).toFixed(0)}s）`, elapsed: (Date.now() - t0) / 1000 })}\n\n`);
    } catch { /* 客户端走了就算了 */ }
  }, CFG.progressTickMs);

  const t0 = Date.now();
  let all = '';
  let lastStage = '';
  let resultB64 = null;
  let resultMime = 'image/png';
  let degradedNote = '';
  let resultSprite = '';
  let resultAnim = null;
  // 【2026-11-06】多图：上游 data[] 里的全部图片（原生路才有）
  let resultItems = [];
  let finalText = '';
  let failed = false;   // 硬错误（HTTP 非 200 / 流内 error）：错误事件已经发出去了，不再重试
  const attempts = Math.max(1, CFG.retryAttempts);
  try {
   for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // 每一轮都是**全新请求**：上一轮的残留必须清干净
    all = ''; lastStage = ''; resultB64 = null; finalText = '';
    if (attempt > 1) {
      log(`↻ 重试 ${attempt}/${attempts}（上一次 HTTP 200 但流里没有图）`);
      send({ type: 'stage', stage: 'retrying', label: `上游这次没给图，正在重试 ${attempt}/${attempts}` });
      await sleep(CFG.retryDelayMs);
    }
    if (CFG.generatePath === 'native') {
      // ───────────── 原生路：/v1/images/*（没有对话模型，不会"对话式拒绝"）─────────────
      const nativeUrl = refs.length
        ? `${CFG.relayBase}/v1/images/edits`
        : `${CFG.relayBase}/v1/images/generations`;
      // ⚠️ 这里只是"把请求发出去"，还没开始画 → stage 必须是 connecting（第 1 格「提交」），
      //    不能写 drawing，否则进度条会跳到「绘制」而文字还停在「正在提交」。
      send({ type: 'stage', stage: 'connecting', label: refs.length ? '正在上传参考图并提交' : '正在提交生成请求' });
      // 原生端点要等到出图才回响应头，中途没有任何事件；
      // 所以 0.8 秒后补一个「已提交，等待上游出图」，让进度条从「提交」走到「理解」而不是干等。
      const waitStageTimer = setTimeout(() => {
        send({ type: 'stage', stage: 'connected', label: '已提交，等待上游出图' });
      }, 800);
      let resp;
      // 【2026-10-27】对话续接钥匙：同一个本地对话 → 同一个上游对话。
      // 用「用户 hash + 本地对话 id」，不含明文 token，也不怕别人猜到。
      const webConvKey = crypto.createHash('sha256').update(String(user || '')).digest('hex').slice(0, 12)
        + ':' + conv.id;
      if (refs.length) {
        // edits 用 multipart：字段名 image（可重复，顺序即"参考图1、参考图2…"）
        const fd = new FormData();
        fd.append('model', imageModel || CFG.imageModel);
        fd.append('prompt', effPrompt);
        fd.append('web_conv_key', webConvKey);
        // 网页管线三参数：multipart 会被 new-api 原样透传
        if (webMode) fd.append('web_mode', webMode);
        if (webModel) fd.append('web_model', webModel);
        if (webEffort) fd.append('web_effort', webEffort);
        if (background === 'transparent') fd.append('background', 'transparent');  // 真参数，原生端点认
        for (const rf of refs) {
          const mime = rf.ext === 'jpg' || rf.ext === 'jpeg' ? 'image/jpeg'
            : rf.ext === 'webp' ? 'image/webp' : 'image/png';
          fd.append('image', new Blob([rf.bytes], { type: mime }), `ref.${rf.ext}`);
        }
        resp = await fetch(nativeUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${CFG.relayToken}` },
          body: fd,
          signal: ac.signal,
        });
      } else {
        resp = await fetch(nativeUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${CFG.relayToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: imageModel || CFG.imageModel,
            prompt: effPrompt,
            n: 1,
            // ⚠️ 不能直接加顶层 web_conv_key：new-api 的 ImageRequest 是强类型结构体，
            //    JSON 请求里的未知顶层字段会被丢弃（multipart 才原样透传）。
            //    style 是 json.RawMessage，能活着到 shim。
            style: {
              mssk_conv: webConvKey,
              ...(webMode ? { mssk_mode: webMode } : {}),
              ...(webModel ? { mssk_model: webModel } : {}),
              ...(webEffort ? { mssk_effort: webEffort } : {}),
            },
            ...(background === 'transparent' ? { background: 'transparent' } : {}),
          }),
          signal: ac.signal,
        });
      }
      const txt = await resp.text();
      clearTimeout(waitStageTimer);
      all = txt;
      if (!resp.ok) {        let code = '', msg = '';
        try { const j = JSON.parse(txt); msg = j?.error?.message || ''; code = j?.error?.code || ''; } catch { /* 非 JSON */ }
        const stage = /判定阶段=([^，,]+)/.exec(msg)?.[1] || '';
        const cats = /类别=([^，,]+)/.exec(msg)?.[1] || '';
        const rid = /请求ID=([0-9a-fA-F-]{8,})/.exec(msg)?.[1] || '';
        const isRefusal = /moderation_blocked/.test(code) || /内容安全|safety system/i.test(msg);
        const packet = {
          type: 'error',
          // 面向用户：一句中文（按类型翻译，不含英文代号）
          message: isRefusal
            ? humanizeModeration({ stage, categories: cats, requestId: rid })
            : `中转站返回 HTTP ${resp.status}${translateUpstream(msg) ? `（${translateUpstream(msg)}）` : ''}`,
          // 面向管理员：原始报错与代号原样保留，排查时照抄
          detail: [
            msg ? `上游原话：${msg}` : '',
            `code=${code || '-'} moderation_stage=${stage || '-'} categories=${cats || '-'} request_id=${rid || '-'}`,
          ].filter(Boolean).join('\n'),
          ...classifyError(txt + ' ' + msg),
        };
        if (isRefusal) {
          packet.code = 'content_safety';
          packet.stage = stage;
          packet.categories = cats;
          packet.request_id = rid;
        }
        log(`⚠️ images接口失败 [${packet.code}] 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s：${(msg || txt).slice(0, 200)}`);
        send(packet);
        failed = true;
        break;
      }
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { /* 非 JSON：下面按"没有图"处理 */ }
      // 【2026-11-06】上游降级出图（codex 端点/老路）会带 degraded:true —— 必须让人看得见，
      // 否则用户以为拿到的是网页管线的 GIF，其实是静态 PNG。
      if (parsed && parsed.degraded) {
        degradedNote = String(parsed.degraded_reason || '网页管线失败，走了备用通道');
        log(`⚠️ 本次图片来自备用通道（${degradedNote}）—— 不是网页管线出的图`);
      }
      // 【2026-11-06】多图：上游一次可能返回多张（data[] 每项一张），全部收下
      if (Array.isArray(parsed?.data)) {
        const items = parsed.data.filter((x) => x && x.b64_json);
        if (items.length > 1) log(`上游本次返回 ${items.length} 张（多图）`);
        if (items.length) {
          resultItems = items.map((x) => ({
            b64_json: String(x.b64_json),
            mime_type: x.mime_type ? String(x.mime_type) : '',
            sprite_sheet: x.sprite_sheet ? String(x.sprite_sheet) : '',
            animation: x.animation || null,
          }));
          resultB64 = resultItems[0].b64_json;
          resultMime = resultItems[0].mime_type || resultMime;
          resultSprite = resultItems[0].sprite_sheet || '';
          resultAnim = resultItems[0].animation || null;
        }
      }
      if (resultB64) {
        log(`✅ images接口(/v1/images/*) 出图 ${resultItems.length || 1} 张 ${(resultB64.length / 1024 / 1.37).toFixed(0)}KB 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        break;
      }
      // 200 但没有图：按老路同样的策略重试（上游有成簇的瞬时失败）
      finalText = txt.slice(0, 400);
      if (attempt < attempts) { log(`⚠️ images接口第 ${attempt} 次没有图片，准备重试`); continue; }
      break;
    }
    const r = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.relayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      log('上游 HTTP', r.status, txt.slice(0, 200));
      send({ type: 'error', message: `中转站返回 HTTP ${r.status}`, detail: txt.slice(0, 600), ...classifyError(txt) });
      failed = true;
      break;
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        all += chunk + '\n\n';
        const ev = /^event:\s*(\S+)/m.exec(chunk)?.[1];
        const data = /^data:\s*([\s\S]*)$/m.exec(chunk)?.[1] || '';
        if (!ev || ev === 'keepalive') continue;
        const st = stageOf(ev);
        if (st && st.stage !== lastStage) { lastStage = st.stage; send({ type: 'stage', elapsed: (Date.now() - t0) / 1000, ...st }); }
        // 流内错误（HTTP 200 但流里报错：上游过载就是这样）
        if (ev === 'response.failed' || /"type"\s*:\s*"error"/.test(data)) {
          const msg = /"message"\s*:\s*"([^"]+)"/.exec(data)?.[1] || '上游返回错误';
          const cls = classifyError(msg);
          // ⚠️ 这里以前**不打日志** —— 结果上游过载在运维视角是完全隐形的：
          // 2026-09-22 02:34~02:53 连续 5 次失败，站点日志里一行痕迹都没有，
          // 只能靠 new-api 那边的「上游没有返回计费信息」反推。必须留下。
          log(`⚠️ 上游流内报错 [${cls.code}] 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s：${msg.slice(0, 200)}`);
          send({ type: 'error', message: msg, ...cls });
          failed = true;
          try { await reader.cancel(); } catch { /* 流已经断了 */ }
          break;
        }
        if (ev === 'response.image_generation_call.completed' && !resultB64) {
          resultB64 = /"result"\s*:\s*"([A-Za-z0-9+/=]{2000,})"/.exec(data)?.[1] || null;
        }
        const partText = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(data)?.[1];
        if (ev === 'response.output_text.done' && partText) finalText = partText;
      }
    }
    if (failed) break;                 // 硬错误：错误事件已经发过了
    if (resultB64) break;              // 拿到图，收工
    // 内容安全拒绝：同一个提示词重试必然再被拒，只会白烧额度 → 直接跳出，把上游原话还给用户
    if (isRefusalText(finalText) || isRefusalText(all)) break;
    // 其余情况（HTTP 200 但流里没有图片数据）：上游是"成簇"瞬时失败的，
    // 换一个全新请求往往就出来了（网关侧实测：同一请求上一次 56.7s 成功、下一次 13s 就没有数据）
    if (attempt < attempts) { log(`⚠️ 第 ${attempt} 次没有图片数据，准备重试`); continue; }
   }
  } catch (e) {
    const aborted = e.name === 'AbortError';
    // 区分三种中止：用户主动停 / 超时 / 真失败 —— 日志里要能一眼看出来
    log(clientGone ? '用户中止（客户端断开，已同时断掉上游）' : aborted ? '请求超时中止' : '请求失败', e.name, e.message);
    if (!clientGone) send({ type: 'error', message: aborted ? '已取消或超时' : `请求失败：${e.message}` });
    // 只有"没人看直播"才提示继续收尾；用户点停止时不该说这句（那条已经撤回了）
    if (clientGone && !aborted) log('客户端已断开，但任务照常收尾（结果会落库）');
    conv.messages.pop();
    await writeConversation(user, conv);
    return;
  } finally {
    clearTimeout(timer);
    if (ticker) clearInterval(ticker);
    res.off('close', onClose);
  }

  if (!failed && !resultB64) {
    const m = [...all.matchAll(/"result"\s*:\s*"([A-Za-z0-9+/=]{2000,})"/g)].map((x) => x[1]).sort((a, b) => b.length - a.length)[0];
    resultB64 = m || null;
  }
  if (failed || !resultB64) {
    if (!failed) {
      // ⚠️ 【这里以前在吞原因】旧代码只从流里抠 `"message"` 字段 ——
      //    但图片被安全系统拒绝时上游**根本不发 message**，而是用一段普通文字回绝
      //    （"I couldn't generate this image because the request was flagged by the
      //      image safety system for sexualized content. …"）。
      //    结果那句真正的原因被丢掉，用户只看到一句"上游没有返回图片数据"。
      //    现在把流里的模型文字（finalText）当第一候选，再退回到 message。
      const errMsg = /"message"\s*:\s*"([^"]+)"/.exec(all)?.[1];
      const errDetail = /"detail"\s*:\s*"([^"]+)"/.exec(all)?.[1];
      const reason = (finalText && finalText.trim()) || errMsg || errDetail || '';
      log(`❌ 没有图片数据 bytes=${all.length} 上游原话：${reason.slice(0, 200) || '(空)'}`);
      // 上游有时回英文原话 → 给一句中文摘要放在最前面（英文原文仍在 detail / 日志里）
      const zh = translateUpstream(reason);
      send({
        type: 'error',
        message: zh ? `${zh}${reason ? `｜上游原话：${reason.slice(0, 160)}` : ''}` : (reason || '上游没有返回图片数据'),
        detail: all.slice(0, 400),
        ...classifyError(reason || ''),
      });
    }
    conv.messages.pop();
    await writeConversation(user, conv);
    return;
  }

  const dir = imgDir(user, conv.id);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  // 【2026-11-06】② 多图：data[] 里有几张就存几张、一起返回给前端。
  // 每张各自带 mime / sprite / animation（GIF 那张才有 sprite）。
  const items = (Array.isArray(resultItems) && resultItems.length)
    ? resultItems
    : [{ b64_json: resultB64, mime_type: resultMime, sprite_sheet: resultSprite, animation: resultAnim }];
  const savedImages = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const b64 = String(it.b64_json || '');
    if (!b64) continue;
    const bytes = Buffer.from(b64, 'base64');
    const mime = (it.mime_type || resultMime || 'image/png');
    const ext = mime === 'image/gif' ? 'gif' : 'png';
    const suffix = items.length > 1 ? `-${idx + 1}` : '';
    const file = `${stamp}${suffix}-${crypto.randomBytes(2).toString('hex')}.${ext}`;
    const pngPath = path.join(dir, file);
    await fsp.writeFile(pngPath, bytes);
    const size = ext === 'gif' ? gifSize(bytes) : pngSize(bytes);

    // [2026-11-05] 动图：额外保存 sprite sheet，供前端 canvas 播放与调速
    let spriteUrl = '';
    let spriteSize = null;
    if (it.sprite_sheet) {
      try {
        const sbuf = Buffer.from(String(it.sprite_sheet), 'base64');
        const sfile = `${stamp}${suffix}-${crypto.randomBytes(2).toString('hex')}-sprite.png`;
        await fsp.writeFile(path.join(dir, sfile), sbuf);
        spriteUrl = `/api/images/${conv.id}/${sfile}`;
        spriteSize = pngSize(sbuf);
        log(`sprite sheet 已保存 ${(sbuf.length / 1024).toFixed(0)}KB ${spriteSize ? spriteSize.w + 'x' + spriteSize.h : ''}`);
      } catch (e) {
        log('sprite sheet 保存失败（忽略）：' + e.message);
      }
    }

    // 同时生成显示用的 WebP（原图 PNG 保留，下载时才用）
    let webpBytes = 0;
    if (CFG.webpEnabled && sharp && ext !== 'gif') {
      try {
        const w = await makeWebp(pngPath);
        if (w) webpBytes = w.length;
      } catch (e) {
        log('WebP 生成失败（继续用 PNG）', file, e.message);
      }
    }

    savedImages.push({
      file, url: `/api/images/${conv.id}/${file}`, w: size?.w, h: size?.h, bytes: bytes.length, webpBytes,
      mime,
      ...(it.animation ? { animation: it.animation } : {}),
      ...(spriteUrl ? { spriteUrl, spriteW: spriteSize?.w, spriteH: spriteSize?.h } : {}),
    });
    log(`出图完成 [${savedImages.length}/${items.length}]`, file, (bytes.length / 1024).toFixed(0) + 'KB'
      + (webpBytes ? ` → WebP ${(webpBytes / 1024).toFixed(0)}KB` : ''));
  }
  if (!savedImages.length) {
    conv.messages.pop();
    await writeConversation(user, conv);
    send({ type: 'error', message: '上游返回了空图片' });
    return;
  }

  const assistantMsg = {
    role: 'assistant',
    text: finalText || '',          // 上游常常不返回文字，那就不要硬塞一句"已生成图片"
    at: Date.now(),
    images: savedImages,
    meta: {
      ratio: ratioLabel, elapsed: (Date.now() - t0) / 1000,
      // 【2026-11-03】标签以前写的是 model || CFG.relayModel —— 而 model 是界面的显示名（"GPT-6"），
      // 后端用 relay 的对话模型表校验不过就兜底成 gpt-5.6-sol，等于**永远显示假的**。
      // 现在优先显示真正传给上游的 slug + 推理档。
      model: webModel || model || CFG.relayModel,
      effort: webEffort || effort || '(默认)',
      ...(degradedNote ? { degraded: true, degradedReason: degradedNote } : {}),
    },
  };
  conv.messages.push(assistantMsg);
  await writeConversation(user, conv);

  log(`请求结束 共 ${savedImages.length} 张`, ((Date.now() - t0) / 1000).toFixed(1) + 's');
  send({ type: 'done', message: assistantMsg, elapsed: (Date.now() - t0) / 1000, title: conv.title });
}

/**
 * 把 <name>.png 转成同目录的 <name>.png.webp（显示用）。
 * 已存在就直接返回，不重复转。失败返回 null，调用方回落 PNG。
 */
async function makeWebp(pngPath) {
  if (!sharp) return null;
  const out = pngPath + '.webp';
  try {
    const st = await fsp.stat(out);
    if (st.size > 0) return { length: st.size, cached: true };
  } catch { /* 不存在，继续生成 */ }
  const buf = await sharp(pngPath)
    .rotate()                                        // 尊重 EXIF 方向
    .resize({ width: CFG.webpMaxW, withoutEnlargement: true })
    .webp({ quality: CFG.webpQuality, effort: 4 })
    .toBuffer();
  await fsp.writeFile(out, buf);
  return buf;
}

// ---------------------------------------------------------------- 静态文件
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
async function serveStatic(res, rel) {
  const p = path.join(PUBLIC_DIR, rel);
  if (!p.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const buf = await fsp.readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch {
    const buf = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(buf);
  }
}

// ---------------------------------------------------------------- 路由
const inFlight = new Set();
// 【2026-11-06】convKey(user/id) -> { ac, startedAt, prompt, stage }
// 作用：① 用户点「停止」时能精确掐掉这一条；② 刷新后前端能知道"这个对话还在后台跑"。
const jobs = new Map();
const lastStart = new Map();   // user -> 上次发起生成的时间戳

const server = http.createServer((req, res) => {
  // 处理器是 async 的：如果它 reject 而没人接，Node 会直接杀掉进程。
  // 客户端中断（上传参考图时点重试）最容易触发这种情况，所以这里必须兜住。
  handleRequest(req, res).catch((e) => {
    log('⚠️ 请求处理异常:', (e && e.message) || e);
    try {
      if (!res.headersSent) json(res, 500, { error: '内部错误' });
      else res.end();
    } catch { /* 连接已经没了，忽略 */ }
  });
});

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const cookie = req.headers.cookie || '';
  const session = readSession(cookie);

  const needAuth = (fn) => (...a) => {
    if (!session) return json(res, 401, { error: 'unauthorized' });
    return fn(...a);
  };

  try {
    // ---- 登录 ----
    if (p === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const { user = CFG.password ? 'owner' : '', password = '' } = body;
      const verdict = await checkCredential(user, password);
      if (!verdict.ok) {
        log('登录失败', user || '(空)', verdict.reason || '');
        return json(res, 401, { error: verdict.reason || '口令不正确' });
      }
      return json(res, 200, { ok: true, user: verdict.user }, { 'Set-Cookie': `mssk_img=${makeSession(verdict.user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}` });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'mssk_img=; Path=/; HttpOnly; Max-Age=0' });
    }
    if (p === '/api/me') return session ? json(res, 200, { user: session.user }) : json(res, 401, { error: 'unauthorized' });
    // 前端轮询它判断是否该强制刷新（不需要登录；返回里没有敏感信息）
    if (p === '/api/version') return json(res, 200, { build: BUILD, startedAt: STARTED_AT });
    if (p === '/api/health') {
      // token 模式：只要一个令牌框，不显示用户名
      const multiUser = CFG.authMode === 'token' ? false : (!CFG.password && CFG.users.length > 0);
      return json(res, 200, {
        ok: true, model: CFG.relayModel, upstream: RESPONSES_URL, multiUser, authMode: CFG.authMode,
        // 运行时可观测：此刻在画几张 / 上限几张（排查"没排上"时一眼看清）
        inFlight: inFlight.size, maxConcurrent: CFG.maxConcurrent,
      });
    }
    // 模型 + 推理档位（给前端下拉框用）
    if (p === '/api/models') {
      return needAuth(async () => {
        // 【2026-10-16】按管线返回不同的可选模型：
        //   pipeline=web   → 问 shim 要"网页模式可用模型"（/web/models，19 个 slug + 默认值）
        //   pipeline=codex → 固定 codex-gpt-image-2
        const pipeline = String(url.searchParams.get('pipeline') || 'web');
        // Codex 原生：推理模型/档位**和以前完全一样**（用 relay 的对话模型清单）。
        // 生图模型由 imageModel 决定（codex-gpt-image-2），两件事互不影响。
        if (pipeline === 'codex') {
          const list = await listModels();
          const effortsByModel = {};
          for (const m of list) effortsByModel[m] = effortsFor(m);
          return json(res, 200, {
            pipeline,
            models: list,
            effortsByModel,
            presetMap: {},
            efforts: effortsFor(CFG.relayModel),
            default: { model: CFG.relayModel, effort: CFG.defaultEffort },
            mode: '',
          });
        }
        try {
          const mode = String(url.searchParams.get('mode') || 'chat');
          const r = await fetch(CFG.shimBase + '/web/models?mode=' + encodeURIComponent(mode));
          const j = await r.json();
          const vs = j.versions || [];
          if (vs.length) {
            // versions → { 模型名: [档位名...] } + presetMap（档位 → slug+effort）
            const models = vs.map((v) => v.name);
            const effortsByModel = {};
            const presetMap = {};
            for (const v of vs) {
              effortsByModel[v.name] = v.presets.map((p2) => p2.title);
              presetMap[v.name] = {};
              for (const p2 of v.presets) presetMap[v.name][p2.title] = { slug: p2.slug, effort: p2.effort };
            }
            const defV = vs.find((v) => v.id === j.defaultVersion) || vs[0];
            return json(res, 200, {
              pipeline,
              models,
              effortsByModel,
              presetMap,
              efforts: effortsByModel[defV.name] || [],
              default: { model: defV.name, effort: (effortsByModel[defV.name] || [])[0] || '' },
              mode: j.mode || 'chat',
            });
          }
        } catch (e) {
          log('  拉网页模型列表失败，回退 relay 列表：', e.message);
        }
        const models = await listModels();
        const effortsByModel = {};
        for (const m of models) effortsByModel[m] = effortsFor(m);
        json(res, 200, {
          models,
          effortsByModel,
          efforts: effortsFor(CFG.relayModel),        // 兼容：默认模型的档位
          default: { model: CFG.relayModel, effort: CFG.defaultEffort },
          mode: 'chat',
        });
      })();
    }

    // ---- 对话 ----
    if (p === '/api/conversations' && req.method === 'GET') {
      return needAuth(async () => json(res, 200, await listConversations(session.user)))();
    }
    if (p === '/api/conversations' && req.method === 'POST') {
      return needAuth(async () => {
        const conv = newConversation(session.user);
        await writeConversation(session.user, conv);
        json(res, 200, conv);
      })();
    }
    const mConv = /^\/api\/conversations\/([A-Za-z0-9_-]+)$/.exec(p);
    if (mConv) {
      const id = mConv[1];
      return needAuth(async () => {
        const conv = await readConversation(session.user, id);
        if (!conv) return json(res, 404, { error: 'not found' });
        if (req.method === 'GET') {
          const job = jobs.get(`${session.user}/${conv.id}`);
          return json(res, 200, {
            ...conv,
            running: !!job,
            ...(job ? { runningSince: job.startedAt, runningPrompt: job.prompt, runningStage: job.stage } : {}),
          });
        }
        if (req.method === 'PATCH') {
          const b = await readBody(req);
          if (b.title) conv.title = String(b.title).slice(0, 60);
          await writeConversation(session.user, conv);
          return json(res, 200, conv);
        }
        if (req.method === 'DELETE') {
          await fsp.rm(convFile(session.user, id), { force: true });
          await fsp.rm(imgDir(session.user, id), { recursive: true, force: true });
          return json(res, 200, { ok: true });
        }
        json(res, 405, { error: 'method not allowed' });
      })();
    }

    // ---- 停止当前对话的生成（显式中止；断开连接不再等于停止）----
    const mStop = /^\/api\/conversations\/([A-Za-z0-9_-]+)\/stop$/.exec(p);
    if (mStop && req.method === 'POST') {
      return needAuth(async () => {
        const key = session.user + '/' + mStop[1];
        const job = jobs.get(key);
        if (!job) return json(res, 200, { ok: true, running: false });
        try { job.ac.abort(); } catch { /* 已经结束 */ }
        log('用户点了停止，已中止这次生成', mStop[1]);
        return json(res, 200, { ok: true, running: false });
      })();
    }

    // ---- 生成（SSE）----
    const mGen = /^\/api\/conversations\/([A-Za-z0-9_-]+)\/generate$/.exec(p);
    if (mGen && req.method === 'POST') {
      return needAuth(async () => {
        const id = mGen[1];
        const conv = await readConversation(session.user, id);
        if (!conv) return json(res, 404, { error: 'not found' });
        const b = await readBody(req, 48 * 1024 * 1024);   // 参考图走 base64，需要更大的上限
        const prompt = String(b.prompt || '').trim();

        // ---- 参考图（data URL 数组）----
        const refsIn = Array.isArray(b.refs) ? b.refs.slice(0, CFG.maxRefs) : [];
        const refs = [];
        for (const r of refsIn) {
          const p = parseRefDataUrl(r);
          if (!p) return json(res, 400, { error: '参考图格式不支持（只收 PNG / JPEG / WebP 的 data URL）' });
          if (p.bytes.length > CFG.maxRefBytes) {
            return json(res, 400, { error: `单张参考图上限 ${(CFG.maxRefBytes / 1024 / 1024).toFixed(0)}MB，这张 ${(p.bytes.length / 1024 / 1024).toFixed(1)}MB` });
          }
          refs.push(p);
        }
        const effPrompt = prompt || (refs.length ? '参考这些参考图生成一张图' : '');
        if (!effPrompt) return json(res, 400, { error: '提示词不能为空（也可以只传参考图）' });
        if (effPrompt.length > CFG.maxPromptChars) return json(res, 400, { error: `提示词太长（上限 ${CFG.maxPromptChars} 字）` });

        // ⚠️ 准入检查必须放在任何 await 之前：
        //    1) 被拒的请求不该再去问一次模型表（省一次上游调用）
        //    2) await 会让并发挤压错位 —— 位子在等模型表期间已经被别人占/释放，限制就不准了
        const key = session.user + '/' + id;
        if (inFlight.has(key)) return json(res, 429, { error: '这个对话正在生成中，等它画完' });
        if (inFlight.size >= CFG.maxConcurrent) {
          return json(res, 429, { error: `现在有 ${inFlight.size} 张在画（上限 ${CFG.maxConcurrent}），稍等一会儿` });
        }
        const last = lastStart.get(session.user) || 0;
        if (Date.now() - last < CFG.minGapMs) {
          return json(res, 429, { error: `发得太快了，${Math.ceil((CFG.minGapMs - (Date.now() - last)) / 1000)} 秒后再试` });
        }

        // 模型和推理档位都要按白名单校验（上游会拒绝不支持的取值，别把 400 丢给用户）
        const models = await listModels();
        const model = models.includes(String(b.model || '')) ? String(b.model) : CFG.relayModel;
        const effort = effortsFor(model).includes(String(b.effort || '')) ? String(b.effort) : '';

        lastStart.set(session.user, Date.now());
        inFlight.add(key);
        // 【2026-11-06】job 的 AbortController 交给 streamGenerate 用：
        // 只有「停止」按钮（/stop 接口）或超时才 abort；刷新/断线不再 abort。
        const jobAc = new AbortController();
        jobs.set(key, { ac: jobAc, startedAt: Date.now(), prompt, stage: 'connecting', convId: id, user: session.user });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': ok\n\n');
        try {
          await streamGenerate({
            conv, prompt: effPrompt, refs, model, effort, res, user: session.user,
            outerAc: jobAc,
            imageModel: CFG.imageModelChoices.includes(String(b.imageModel || '')) ? String(b.imageModel) : '',
            // 网页管线的三个上游参数（白名单校验，别把任意字符串丢给上游）
            webMode: ['chat', 'work'].includes(String(b.web_mode || '')) ? String(b.web_mode) : '',
            webModel: /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(b.web_model || '')) ? String(b.web_model) : '',
            // 【2026-11-18】修 bug：校验用的是 (b.web_effort || '')，返回值却用了 String(b.web_effort)
            //   → 前端不传 web_effort 时会变成字符串 "undefined"，一路传到上游 thinking_effort，
            //   整个对话体被判 422 Invalid conversation body。这里统一取归一后的值。
            webEffort: (() => {
              const v = String(b.web_effort ?? '').trim();
              if (!/^[a-z]{0,24}$/i.test(v)) return '';
              if (v === 'undefined' || v === 'null' || v === 'auto') return '';
              return v;
            })(),
            ratio: String(b.ratio || '').slice(0, 12),
            // 透明底：前端传 true 或 'transparent' 都认；只折提示词、不传上游参数
            background: (b.transparent === true || b.background === 'transparent') ? 'transparent' : '',
            refSize: (b.refSize && Number(b.refSize.w) > 0 && Number(b.refSize.h) > 0)
              ? { w: Math.round(Number(b.refSize.w)), h: Math.round(Number(b.refSize.h)) } : null,
          });
        } finally {
          inFlight.delete(key);
          jobs.delete(key);          // 【2026-11-06】任务收尾：清掉"正在跑"标记
          try { res.end(); } catch { /* 客户端早走了 */ }
        }
      })();
    }

    // ---- 图片 ----
    const mImg = /^\/api\/images\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/.exec(p);
    if (mImg) {
      return needAuth(async () => {
        const file = path.join(imgDir(session.user, mImg[1]), safeName(mImg[2]));
        if (!file.startsWith(imgDir(session.user, mImg[1]))) return json(res, 403, { error: 'forbidden' });

        // 原图（?raw=1）永远发原始 PNG —— 下载按钮用这个
        const urlObj = new URL(req.url, 'http://x');
        const wantRaw = urlObj.searchParams.get('raw') === '1';
        const acceptsWebp = /\bimage\/webp\b/i.test(req.headers.accept || '');

        try {
          if (!wantRaw && CFG.webpEnabled && sharp && acceptsWebp && file.toLowerCase().endsWith('.png')) {
            // 优先用已生成的 WebP；老图第一次访问时现场生成并缓存
            const webpFile = file + '.webp';
            let buf = null;
            try {
              buf = await fsp.readFile(webpFile);
            } catch {
              try {
                await makeWebp(file);
                buf = await fsp.readFile(webpFile);
              } catch { buf = null; }
            }
            if (buf && buf.length) {
              res.writeHead(200, {
                'Content-Type': 'image/webp',
                'Content-Length': buf.length,
                'Cache-Control': 'private, max-age=86400, immutable',
                'Vary': 'Accept',
              });
              return res.end(buf);
            }
          }

          const buf = await fsp.readFile(file);
          const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
          res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': buf.length,
            'Cache-Control': 'private, max-age=86400, immutable',
            'Accept-Ranges': 'bytes',
            'Vary': 'Accept',
          });
          res.end(buf);
        } catch { json(res, 404, { error: 'not found' }); }
      })();
    }

    // ---- 静态 ----
    if (req.method === 'GET') return serveStatic(res, p === '/' ? 'index.html' : p.replace(/^\//, ''));
    json(res, 404, { error: 'not found' });
  } catch (e) {
    log('未捕获异常', e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else try { res.end(); } catch {}
  }
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let data = '';
    // 只结算一次：客户端中断时可能同时触发 error / aborted / close
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { settle(reject, new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { settle(resolve, data ? JSON.parse(data) : {}); }
      catch { settle(reject, new Error('bad json')); }
    });
    req.on('error', (e) => settle(reject, e));
    // ⚠️ 点"重试"/关页面会让上传中的请求被中断。没有这两个兜底，
    //    Promise 永远不结算（或错误逃逸成 unhandled rejection）→ 整个站点进程被杀。
    req.on('aborted', () => settle(reject, new Error('client aborted')));
    req.on('close', () => settle(reject, new Error('client closed')));
  });
}

// 兜底网：任何未处理的 Promise 拒绝 / 异常都只记日志，绝不让一个客户端中断带走整个站点
process.on('unhandledRejection', (reason) => {
  log('⚠️ 未处理的 Promise 拒绝（已忽略，站点继续运行）:', (reason && reason.message) || reason);
});
process.on('uncaughtException', (err) => {
  log('⚠️ 未捕获异常（已忽略，站点继续运行）:', (err && err.message) || err);
});

// ---------------------------------------------------------------- 定期清理
/**
 * 【2026-10-16 新增】把超过保留期的图片与对话记录删掉，防止磁盘被占满。
 *   · 保留期 IMAGE_TTL_DAYS（默认 90 天 = 3 个月），设 0 关闭
 *   · 启动 60 秒后跑一次，之后每 CLEANUP_INTERVAL_HOURS 小时一次
 *   · 只按**文件修改时间**判断，绝不删新的东西；每次清理都打日志
 */
async function cleanupOldFiles() {
  const ttlMs = CFG.imageTtlDays * 86400000;
  if (!(ttlMs > 0)) return null;
  const now = Date.now();
  let files = 0, bytes = 0, convs = 0;
  const usersRoot = path.join(CFG.dataDir, 'users');
  let users = [];
  try { users = await fsp.readdir(usersRoot); } catch { return null; }

  for (const u of users) {
    // 1) 图片
    const imgRoot = path.join(usersRoot, u, 'images');
    let convDirs = [];
    try { convDirs = await fsp.readdir(imgRoot); } catch { /* 该用户没有图 */ }
    for (const c of convDirs) {
      const dir = path.join(imgRoot, c);
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isFile()) continue;
        const p = path.join(dir, e.name);
        try {
          const st = await fsp.stat(p);
          if (now - st.mtimeMs > ttlMs) { await fsp.rm(p, { force: true }); files += 1; bytes += st.size; }
        } catch { /* 并发删除/权限问题：跳过 */ }
      }
      // 目录空了顺手删掉，别留一堆空壳
      try { const left = await fsp.readdir(dir); if (!left.length) await fsp.rm(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    // 2) 对话记录（和图片同一条保留期，否则历史里全是失效缩略图）
    const convRoot = path.join(usersRoot, u, 'conversations');
    let convFiles = [];
    try { convFiles = await fsp.readdir(convRoot); } catch { continue; }
    for (const f of convFiles) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(convRoot, f);
      try {
        const st = await fsp.stat(p);
        if (now - st.mtimeMs > ttlMs) { await fsp.rm(p, { force: true }); convs += 1; }
      } catch { /* 忽略 */ }
    }
  }
  if (files || convs) {
    log(`🧹 定期清理：删除 ${files} 张图片（${(bytes / 1024 / 1024).toFixed(1)}MB）、${convs} 条过期对话（保留 ${CFG.imageTtlDays} 天）`);
  } else {
    log(`🧹 定期清理：没有超过 ${CFG.imageTtlDays} 天的内容，无需删除`);
  }
  return { files, bytes, convs };
}

async function listModelsForBanner() {
  try { return await listModels(); } catch { return []; }
}
void listModelsForBanner;

server.listen(CFG.port, '0.0.0.0', () => {
  log(`MSSK 生图站已启动  http://127.0.0.1:${CFG.port}`);
  log(CFG.generatePath === 'native'
    ? `生图路径 原生 /v1/images/*（图像模型 ${CFG.imageModel}）—— 无对话模型，不会被"对话式拒绝"`
    : `生图路径 老路 ${RESPONSES_URL}（对话模型 ${CFG.relayModel} + image_generation 工具）`);
  log(`数据目录 ${CFG.dataDir}`);
  log(`限额：并发 ${CFG.maxConcurrent} 张 / 间隔 ${CFG.minGapMs}ms / ${CFG.generatePath === 'native' ? `单次上限 ${CFG.nativeWallMs}ms` : `单次超时 ${CFG.requestTimeoutMs}ms`} / 参考图最多 ${CFG.maxRefs} 张`);
  log(`空手而归时自动重试 ${CFG.retryAttempts} 次（间隔 ${CFG.retryDelayMs}ms；内容安全拒绝不重试）`);
  log(CFG.imageTtlDays > 0
    ? `定期清理 ${CFG.imageTtlDays} 天前的图片与对话（每 ${CFG.cleanupIntervalHours} 小时一次）`
    : '定期清理 已关闭（IMAGE_TTL_DAYS=0）');
  // 启动 60 秒后跑第一次清理，之后定时重复
  if (CFG.imageTtlDays > 0) {
    setTimeout(() => { cleanupOldFiles().catch(() => {}); }, 60000);
    setInterval(() => { cleanupOldFiles().catch(() => {}); }, Math.max(1, CFG.cleanupIntervalHours) * 3600000);
  }
  log(`登录方式 ${
    CFG.authMode === 'token'
      ? '只用中转站令牌（每次登录实时去 new-api 校验）'
      : CFG.password
        ? '共享口令（owner）'
        : '多用户：' + CFG.users.map((u) => u.name).join(', ')
  }`);
});
