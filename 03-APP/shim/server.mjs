/**
 * imagegen-shim —— 把 /v1/images/generations 翻译成 /v1/responses + image_generation 工具
 *
 * 【为什么需要它】
 *   Codex 桌面端的内置 `image_gen` 工具，触发时是客户端自己发起
 *       POST /v1/images/generations   { model: "gpt-image-2", prompt: ... }
 *   而不是把图像工具塞进 /v1/responses。
 *
 *   但我们的中转站里唯一能出图的是「Codex 订阅」型渠道(type 57)，而 new-api 对
 *   这个类型的适配器里 ConvertImageRequest 是个写死的桩：
 *       relay/channel/codex/adaptor.go:36
 *       func (a *Adaptor) ConvertImageRequest(...) { return nil, errors.New("codex channel: endpoint not supported") }
 *   所以那个端点永远 500。
 *
 *   而同一个渠道的 /v1/responses **是实现了的** —— 生图站和 生图.ps1 一直靠它出图。
 *
 * 【所以这个 shim 干的活】
 *   Codex ──/v1/images/generations──▶ new-api 新渠道(type 1) ──▶ 本 shim
 *        本 shim 内部：POST /v1/responses { tools:[{type:"image_generation"}] }
 *                      → 现有 Codex 渠道 → 真出图 → base64
 *        本 shim 按 OpenAI Images 标准格式回 { data:[{ b64_json }] }
 *   Codex 收到图，内联显示。
 *
 * 【零 npm 依赖，只用 node 内置模块】
 */

import http from 'node:http';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { generateViaWeb, getConversationLeaf, WEB, listWebModels, setSurfaceMode, getSurfaceMode, webCredentialStatus, probeWebCredentials } from './webpipe.mjs';

/* ============================================================================
 * 对话续接映射（2026-10-27）
 *
 *   调用方每次带一个 web_conv_key（image-web 用「用户:本地对话id」），
 *   本进程记住这个 key 对应的上游 conversation_id 和叶子节点。
 *   下一轮同一个 key → 落进同一个 ChatGPT 对话，上下文天然继承。
 *
 *   为什么由 shim 存而不是调用方存：
 *   conversation_id / parent_message_id 是 ChatGPT 内部标识，只有 shim 打得通
 *   /backend-api/conversation 接口；让上游之外的人持有它们没有意义。
 *
 *   落盘在 /tmp：容器重启会丢 → 下次就是新建对话，属于优雅降级，不报错。
 * ========================================================================== */
const CONV_MAP_FILE = process.env.WEB_CONV_MAP || '/tmp/web-conv-map.json';
let convMap = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(CONV_MAP_FILE, 'utf8'));
  for (const [k, v] of Object.entries(raw || {})) if (v && v.conversationId) convMap.set(k, v);
  if (convMap.size) log(`已载入 ${convMap.size} 条对话映射`);
} catch { /* 没有就是空表 */ }

let convMapDirty = false;
function persistConvMap() {
  if (!convMapDirty) return;
  convMapDirty = false;
  try {
    fs.writeFileSync(CONV_MAP_FILE, JSON.stringify(Object.fromEntries(convMap), null, 0));
  } catch (e) { log('对话映射落盘失败：', e.message); }
}
setInterval(persistConvMap, 10000).unref?.();

function rememberConv(key, conversationId, parentMessageId, cookieName) {
  if (!key || !conversationId) return;
  convMap.set(key, { conversationId, parentMessageId: parentMessageId || '', cookieName: cookieName || '', at: Date.now() });
  convMapDirty = true;
}
function forgetConv(key) {
  if (!key) return;
  convMap.delete(key);
  convMapDirty = true;
}
function lookupConv(key) {
  return key ? convMap.get(key) : null;
}

const CFG = {
  port: Number(process.env.PORT || 8899),
  // 中转站内部地址（同 docker 网络，不走公网）
  relayBase: (process.env.RELAY_BASE || 'http://new-api:3000').replace(/\/+$/, ''),
  relayToken: process.env.RELAY_TOKEN || '',
  // 真正干活的对话模型：它负责"决定调用 image_generation 工具"
  relayModel: process.env.RELAY_MODEL || 'gpt-5.6-sol',
  // 本 shim 自己的网关密钥（填进 new-api 渠道的 key 字段）
  apiKey: process.env.API_KEY || '',
  timeoutMs: Number(process.env.TIMEOUT_MS || 300000),
  // 对外声明的模型名：必须是 Codex 期望的图片模型名
  imageModels: (process.env.IMAGE_MODELS || 'gpt-image-2.6-flare,codex-gpt-image-2.6-flare,gpt-image-2.6-sunburst,codex-gpt-image-2.6-sunburst,gpt-image-2,codex-gpt-image-2').split(',').map((s) => s.trim()).filter(Boolean),
  // 【2026-11-18】原生端点（/codex/images/*）默认用哪个模型。
  //   留空 = 原样透传（老行为，gpt-image-2）
  //   设成 gpt-image-2.6-flare = 网页管线失败回退到原生时，自动升级到 2.6
  nativeUpgradeModel: (process.env.NATIVE_UPGRADE_MODEL || '').trim(),
  logLevel: process.env.LOG_LEVEL || 'info',
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * 【2026-11-06】测试标记：日志里必须能一眼分清"我的测试"和"真实用户流量"。
 * 之前把真实用户的 codex-gpt-image-2 请求误判成 keepalive 定时任务，归因直接错。
 * 测试请求带 x-mssk-test: 1 头或 style.mssk_test，日志里就会出现 [TEST]。
 */
function isTestReq(req, body) {
  if (String(req.headers['x-mssk-test'] || '') === '1') return true;
  const st = body && body.style;
  return !!(st && typeof st === 'object' && st.mssk_test);
}

// ------------------------------------------------------------- 原生端点（实验性）
/**
 * 【为什么要加这一段】
 *   官方 Codex 客户端的内置生图**不写** /v1/responses，而是客户端自己打
 *       POST {chatgpt_base}/backend-api/codex/images/{generations|edits}
 *   （源码：codex-rs/codex-api/src/endpoint/images.rs）
 *
 *   实测（2026-10-16，VPS 同出口 IP + 渠道 1 的 OAuth 凭据）：
 *     · /images/generations           → 200，直接返回 b64_json
 *     · /images/edits + 参考图         → 400 moderation_blocked（moderation_stage=output）
 *
 *   走它的好处：少一跳（不经 /responses）、少一轮对话模型、没有拒绝缓存、
 *   错误是结构化的（带 code/stage/categories/request_id）。
 *   风险控制：任何**基础设施类**失败（401/403/404/5xx/网络）都自动回退到
 *   原来的 /responses + 图像工具 逻辑 —— 最坏情况 = 没改。
 */
const NAT = {
  enabled: (process.env.NATIVE_IMAGES || '0') === '1',
  base: (process.env.NATIVE_BASE || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, ''),
  timeoutMs: Number(process.env.NATIVE_TIMEOUT_MS || 240000),
  dbPath: process.env.RELAY_DB || '/db/one-api.db',
  channelId: Number(process.env.RELAY_CHANNEL_ID || 1),
  // ⚠️ 必须带 codex 的 UA。直连 chatgpt.com 时 Cloudflare 按客户端指纹判定，
  //    普通 UA（Python-urllib / curl 默认）会直接吃一个 403 HTML 挑战页。
  ua: process.env.NATIVE_UA || 'codex_cli_rs/0.162.0 (Linux 6.8; x86_64) codex',
  // 原生端点**明确判定**内容安全拒绝时，要不要再用老逻辑试一次。
  // 默认 0：拒绝就立刻返回（"失败要快"）。设 1 则回退老逻辑再赌一次。
  refusalFallback: (process.env.NATIVE_REFUSAL_FALLBACK || '0') === '1',
};

// node:sqlite 在 Node 22 是实验特性（会有 ExperimentalWarning），拿不到就用文本兜底。
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

/**
 * 图像工具定义。
 *   不传 moderation → 上游用默认值 auto（当前默认行为）
 *   传 'low'        → 显式降低审核强度
 *
 * 实测（2026-10-09，用良性提示词 + 回显上游 response.completed 的 tools 字段）：
 *   · moderation 字段**会被上游采纳**（发 low，回显就是 low）
 *   · quality  字段**不会被采纳**（发 high，回显仍是 auto）—— 上游锁死 auto
 *   · 带上这两个字段**不会 400**
 */
const buildImageTool = (moderation) =>
  moderation ? { type: 'image_generation', moderation } : { type: 'image_generation' };

// 审核强度：本站默认 low（2026-10-09 起，按需求下调）。
// 想回到上游默认（auto），把 IMAGE_MODERATION=auto 设进容器环境即可。
const IMAGE_MODERATION = (process.env.IMAGE_MODERATION || 'low').toLowerCase();
const imageTool = () => buildImageTool(IMAGE_MODERATION === 'low' ? 'low' : undefined);


// ------------------------------------------------------------------ 工具函数
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('aborted', () => reject(new Error('aborted')));
    req.on('error', reject);
  });
}

/** 读原始字节 —— multipart 里的图片是二进制，绝不能走 utf8 字符串（会损坏） */
function readRawBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('aborted', () => reject(new Error('aborted')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function apiError(res, code, message, type = 'invalid_request_error') {
  json(res, code, { error: { message, type, param: null, code: null } });
}

/** 从 PNG 头部读出真实分辨率（上游会忽略请求里的 size） */
function pngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * 极简 multipart/form-data 解析（只够 /v1/images/edits 用，零依赖）。
 * Codex 的 edits 请求是 multipart：一个 image 文件 + prompt 字段。
 */
function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary);
  let idx = buf.indexOf(delim);
  while (idx !== -1) {
    const next = buf.indexOf(delim, idx + delim.length);
    if (next === -1) break;
    const seg = buf.subarray(idx + delim.length, next);
    const headerEnd = seg.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = seg.subarray(0, headerEnd).toString('utf8');
      let bodyBuf = seg.subarray(headerEnd + 4);
      // 去掉尾部 CRLF
      if (bodyBuf.length >= 2 && bodyBuf[bodyBuf.length - 2] === 0x0d && bodyBuf[bodyBuf.length - 1] === 0x0a) {
        bodyBuf = bodyBuf.subarray(0, bodyBuf.length - 2);
      }
      parts.push({
        name: /name="([^"]*)"/.exec(headers)?.[1],
        filename: /filename="([^"]*)"/.exec(headers)?.[1],
        ctype: /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim(),
        body: bodyBuf,
      });
    }
    idx = next;
  }
  return parts;
}

/**
 * 把请求里的 size / quality 折进提示词。
 * 实测（docs/14）：这条链路上 size 参数被上游忽略、quality 被改写成 auto，
 * 只有写进提示词才有效。所以这里做同样的处理，而不是原样透传。
 */

// 常用比例表，用来把像素对说成"人话"。
// 为什么要查表而不是约分：我们的像素对**除不尽**——1672×941 里 941 是质数，
// gcd=1，约分后还是 1672:941。旧版就是这么写的，结果提示词里出现两个具体像素数，
// 模型会理解成"造一张 1672×941 的画布"，于是在改图时先造白底图再贴内容，画面四周全是白边。
// 现在改成按数值匹配最接近的常用比例，容差 5%。
//
// 措辞取官方 image-api.md「Popular sizes」表的 Label 列：
//   Square / Landscape / Portrait / Widescreen / Vertical
// name 是给模型的锚点（官方同样是 Label + Size 成对给的）。
//
// 为什么只有英文、不做中文分支：这是**给上游图像模型看的内部指令**，用户看不到；
// 而且官方的词表本来就是英文。真要做中文就得自己翻译一遍，那已经不是"官方用词"了。
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

function ratioMatch(w, h) {
  const r = w / h;
  let best = null;
  let bestErr = 0.05; // 5% 容差
  for (const row of RATIO_TABLE) {
    const err = Math.abs(r - row.v) / row.v;
    if (err < bestErr) { bestErr = err; best = row; }
  }
  return best;
}

function foldParams(prompt, size, quality, background) {
  const notes = [];

  if (size && size !== 'auto') {
    const m = /^(\d+)x(\d+)$/.exec(String(size));
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      const hit = ratioMatch(w, h);
      // 关键：**不出现像素数**。旧版写「按 1672×941 构图」，把模型引向"造画布"。
      const what = hit ? `${hit.en} (${hit.name})` : `${(w / h).toFixed(3)}:1`;
      notes.push(`Aspect ratio: ${what}. Frame the entire image natively at this ratio — no border, letterboxing, or padding`);
    }
  }

  if (quality === 'high') notes.push('high quality, rich detail');
  else if (quality === 'low') notes.push('keep it simple');
  if (background === 'transparent') {
    notes.push('transparent background (preserve the alpha channel)');
  }

  if (!notes.length) return prompt;
  return `Requirements: ${notes.join('; ')}\n${prompt}`;
}

// ------------------------------------------------- 核心：调 /v1/responses 拿图
/**
 * 上游会成簇地瞬时失败（实测：同一请求前一次 56.7s 成功、后一次 13s 就没数据）。
 * 所以这里做重试 —— 每次重试都是一次全新的请求，失败代价只有十几秒。
 */
/**
 * 内容安全拒绝的"全局"计数（按 提示词+参考图 记账，带 TTL）。
 *
 * 【为什么需要它】
 *   上游每次都重新改写提示词 → 安全判定是**概率性**的，同一句提示词重试几次
 *   常常能过（实测第 2~6 次）。所以保留重试是有价值的。
 *   但重试会被**乘两层**：shim 自己重试(RETRY_ATTEMPTS) × 调用方自己重试
 *   （CLI 的 --max-attempts 3，且 502 在它的 retryable 表里），一次工具调用
 *   最多打 6 次上游，而每次被拒要 40~60s —— 用户感受就是"卡很久、还没结果"。
 *
 *   所以这里不按"单次 HTTP 请求"限制，而是按内容记账：累计被拒超过
 *   REFUSAL_MAX_ATTEMPTS 次就**不再打上游**，直接返回错误。
 *   这样无论上面套几层重试，上游总尝试次数都有硬上限。
 */
const refusalSeen = new Map(); // key -> { n, text, at }
const REFUSAL_MAX = Math.max(1, Number(process.env.REFUSAL_MAX_ATTEMPTS || 2));
const REFUSAL_TTL_MS = Math.max(1000, Number(process.env.REFUSAL_TTL_MS || 10 * 60 * 1000));

function refusalKey(prompt, refDataUrl) {
  const h = createHash('sha256');
  h.update(String(prompt));
  h.update('\u0000');
  if (refDataUrl) h.update(refDataUrl);
  return h.digest('hex').slice(0, 16);
}

function refusalState(key) {
  const e = refusalSeen.get(key);
  if (!e) return null;
  if (Date.now() - e.at > REFUSAL_TTL_MS) { refusalSeen.delete(key); return null; }
  return e;
}

function bumpRefusal(key, text) {
  const prev = refusalState(key);
  const n = (prev ? prev.n : 0) + 1;
  refusalSeen.set(key, { n, text: text || (prev ? prev.text : ''), at: Date.now() });
  if (refusalSeen.size > 400) {
    const now = Date.now();
    for (const [k, v] of refusalSeen) if (now - v.at > REFUSAL_TTL_MS) refusalSeen.delete(k);
  }
  return n;
}

const refusalError = (n, text) => Object.assign(
  new Error(`上游内容安全系统拒绝：${text || '未能生成'}（同一提示词已连续被拒 ${n} 次，达上限 ${REFUSAL_MAX}，已停止重试）`),
  { upstream: true, refusal: true, refusalText: text || '' },
);

async function generateViaResponses({ prompt, model, refDataUrls }) {
  // [fix] 被拒一次就停：默认不重试（原来默认 3 次，每次都在给账号加分）
const attempts = Math.max(1, Number(process.env.RETRY_ATTEMPTS || 1));
  const delayMs = Number(process.env.RETRY_DELAY_MS || 20000);
  const key = refusalKey(prompt, (refDataUrls || []).join('\u0000'));

  // 这个内容已经被拒够了：不再打上游（省掉 40~60s/次），立刻返回错误。
  const seen = refusalState(key);
  if (seen && seen.n >= REFUSAL_MAX) {
    log(`   🛑 同一提示词已被内容安全拒绝 ${seen.n} 次（上限 ${REFUSAL_MAX}），不再打上游`);
    throw refusalError(seen.n, seen.text);
  }

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const out = await attemptOnce({ prompt, model, refDataUrls });
      if (i > 1) log(`   ↩️ 第 ${i} 次尝试成功`);
      refusalSeen.delete(key); // 成功了就把这笔账清掉
      return out;
    } catch (e) {
      lastErr = e;
      if (e.refusal) {
        const n = bumpRefusal(key, e.refusalText);
        log(`   🚫 内容安全拒绝（累计 ${n}/${REFUSAL_MAX}）`);
        if (n >= REFUSAL_MAX) throw refusalError(n, e.refusalText);
      }
      if (!e.upstream || i === attempts) throw e;
      // 内容安全拒绝 ≠ 网络抖动：判定不会因为多等 15 秒而改变，所以用短间隔。
      const wait = e.refusal
        ? Math.max(0, Number(process.env.REFUSAL_RETRY_DELAY_MS ?? 2000))
        : delayMs;
      log(`   ⚠️ 第 ${i}/${attempts} 次失败（${e.refusal ? '内容安全拒绝' : e.message}），${wait / 1000}s 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * 上游安全系统拦截时不返回图片，只回一段说明文字。实测原文形如：
 *   "抱歉，该请求被图像安全系统判定为涉及过度性感化内容，因此未能生成。…"
 *   "抱歉，图像生成请求被安全系统拦截，未能完成。请求 ID：`…`。"
 * 抓到它有两个用处：
 *   ① 让调用方知道真正原因 —— 原先被吞成"上游没有返回图片数据"，
 *      客户端（Codex）把它当成临时故障，于是同一句提示词反复重打 3~6 次，
 *      每次 40~60s，用户只看到"耗时很长、没有结果、也不知道为什么"。
 *   ② 标记为"拒绝"，走短间隔重试，不用白等 RETRY_DELAY_MS。
 */
function extractRefusal(all) {
  const m = /"type"\s*:\s*"response\.output_text\.done"[^\n]*?"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(all);
  if (!m) return '';
  try { return JSON.parse('"' + m[1] + '"').trim(); } catch { return m[1].trim(); }
}

async function attemptOnce({ prompt, model, refDataUrls }) {
  // 参考图（走 /v1/images/edits 进来的）以 input_image 传给上游；多张就多条，
  // 顺序即"参考图1、参考图2…"（上游只能靠顺序+提示词里的序号对应，见 docs 14 §2.1）
  const content = [{ type: 'input_text', text: prompt }];
  for (const url of refDataUrls || []) content.push({ type: 'input_image', image_url: url });

  const body = {
    model: CFG.relayModel,
    stream: true,
    // ── 关于 instructions：已回退（2026-10-08）──────────────────────
    // 曾经加过一段 "Call image_generation exactly once / Do not reply with text"
    // 想把提示词锁成逐字。但实测之后 502「上游没有返回图片数据」明显变多
    // （09-21/09-22 各 1 次 → 10-08 一天 7 次），失败响应里 output 完全为空、
    // tool_usage.image_gen 全 0 —— 说明模型干脆没去调工具，只吐了空消息。
    // 判断是那两句硬约束堵死了模型的退路。**原则：给它最少约束，得到啥就输出啥。**
    // 只保留下面这句纯描述性的（不再命令它必须调用、也不禁止它说话）：
    instructions: 'Use the user message as the image prompt. Do not rewrite it into a different request.',
    // 工具参数：实测（2026-10-09）moderation / quality 两个字段**不会 400**，
    // 其中 moderation 被上游采纳、quality 被强制改写成 auto。
    // 本站默认带 moderation:low（见 IMAGE_MODERATION）；其余字段不发，用上游默认。
    tools: [imageTool()],
    // 强制走图像工具：这个 shim 的每一次请求语义都是"出图"
    tool_choice: { type: 'image_generation' },
    input: [{
      type: 'message',
      role: 'user',
      content,
    }],
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CFG.timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${CFG.relayBase}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.relayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw Object.assign(new Error(`上游 HTTP ${r.status}: ${txt.slice(0, 400)}`), { upstream: true });
    }

    // 整段流读下来再找图 —— 图片在 response.output_item.done 那一帧里，
    // 不在 image_generation_call.completed。这是生图站踩过的坑，这里沿用它的兜底策略。
    let all = '';
    const dec = new TextDecoder();
    for await (const chunk of r.body) all += dec.decode(chunk, { stream: true });

    // 诊断：记下上游最终采用的提示词长度与开头，用来确认"锁定改写"有没有生效。
    // 若长度与用户原文一致，说明 instructions 生效；明显变长说明又被润色了。
    const revMatch = /"revised_prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(all);
    if (revMatch) {
      const revText = revMatch[1].replace(/\\"/g, '"');
      log(`上游最终提示词 ${revText.length} 字：${revText.slice(0, 120)}`);
    }

    const errMatch = /"type"\s*:\s*"error"[^}]*"message"\s*:\s*"([^"]+)"/.exec(all)
      || /"code"\s*:\s*"([^"]+)"[^}]*"message"\s*:\s*"([^"]+)"/.exec(all);
    const hits = [...all.matchAll(/"result"\s*:\s*"([A-Za-z0-9+/=]{2000,})"/g)].map((m) => m[1]);
    // 诊断：上游实际采用的工具定义。用来确认 moderation / quality 等字段有没有被采纳
    // —— 上游会在 response.completed 里把它最终使用的 tools 原样回显。
    const toolEcho = /"tools":\s*(\[[^\[\]]*\])/.exec(all);
    if (toolEcho) log(`   上游工具定义 ${toolEcho[1].slice(0, 400)}`);
    if (!hits.length) {
      // 诊断：失败时把流的"骨架"记下来（去掉超长 base64），下次不用猜
      const skeleton = all
        .replace(/[A-Za-z0-9+/=]{200,}/g, '<base64>')
        .split('\n')
        .filter((l) => l.startsWith('event:') || l.includes('"type"') || l.includes('"message"'))
        .slice(-12)
        .join('\n      ');
      log(`   [诊断] 流共 ${all.length} 字节，尾部事件：\n      ${skeleton}`);
      const refusal = extractRefusal(all);
      if (refusal) log(`   🚫 上游拒绝原文：${refusal.slice(0, 200)}`);
      const msg = refusal
        ? `上游内容安全系统拒绝：${refusal}`
        : (errMatch?.[1] || '上游没有返回图片数据');
      throw Object.assign(new Error(msg), { upstream: true, refusal: !!refusal, refusalText: refusal });
    }
    const b64 = hits.sort((a, b) => b.length - a.length)[0];
    return { b64, elapsed: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------- 原生端点：读凭据 + 调用
/**
 * 读渠道 1 的 OAuth 凭据（access_token / account_id）。
 *
 * 【为什么只读、绝不自己刷新】
 *   refresh_token 是**一次性**的：谁刷新谁就得把新 token 写回 new-api 的库里。
 *   new-api 本来就是渠道 1 的持有者、已经在做刷新；shim 如果自己刷一次，
 *   会把 new-api 手里的凭据顶掉 —— 那不是"生图坏了"，是**整个中转站挂掉**。
 *   所以这里永远只读。
 *
 * 【为什么先复制到 /tmp 再读】
 *   真实库是 WAL 模式，只读挂载直接 open 会报 readonly；
 *   复制一份 db + -wal，读取最干净，也不打扰正在写的 new-api。
 */
const credCache = { at: 0, token: '', account: '' };
const CRED_TTL_MS = Number(process.env.NATIVE_CRED_TTL_MS || 60000);
const CRED_TMP = '/tmp/shim-one-api.db';

function readCredential(force = false) {
  if (!force && credCache.token && Date.now() - credCache.at < CRED_TTL_MS) return credCache;

  try {
    fs.copyFileSync(NAT.dbPath, CRED_TMP);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.copyFileSync(NAT.dbPath + suffix, CRED_TMP + suffix); } catch { /* 不存在就算了 */ }
    }
  } catch (e) {
    log(`   ⚠️ 复制数据库失败：${e.message}`);
    return { ...credCache, token: '' };
  }

  let raw = '';
  if (DatabaseSync) {
    try {
      const db = new DatabaseSync(CRED_TMP, { readOnly: true });
      const row = db.prepare('select key from channels where id = ?').get(NAT.channelId);
      db.close();
      raw = String(row?.key || '');
    } catch (e) {
      log(`   ⚠️ sqlite 读取失败，改用文本兜底：${e.message}`);
    }
  }
  if (!raw) {
    // 兜底：渠道 key 是明文 JSON 存在 TEXT 列里（未压缩），可直接在字节里找。
    let text = '';
    try { text = fs.readFileSync(CRED_TMP).toString('latin1'); } catch { /* ignore */ }
    try { text += fs.readFileSync(CRED_TMP + '-wal').toString('latin1'); } catch { /* ignore */ }
    const tokens = [...text.matchAll(/"access_token"\s*:\s*"([A-Za-z0-9._~+\/-]{60,})"/g)].map((m) => m[1]);
    const accounts = [...text.matchAll(/"account_id"\s*:\s*"([0-9a-fA-F-]{20,})"/g)].map((m) => m[1]);
    if (tokens.length && accounts.length) {
      credCache.token = tokens[tokens.length - 1];
      credCache.account = accounts[accounts.length - 1];
      credCache.at = Date.now();
      log('   ℹ️ 凭据来自文本兜底扫描');
      return credCache;
    }
  }

  try {
    const j = JSON.parse(raw);
    credCache.token = String(j.access_token || '');
    credCache.account = String(j.account_id || '');
    credCache.at = Date.now();
  } catch (e) {
    log(`   ⚠️ 渠道 ${NAT.channelId} 的 key 既不是可用 JSON、也没扫到 token：${e.message}`);
  }
  return credCache;
}

function nativeHeaders(cred) {
  return {
    Authorization: `Bearer ${cred.token}`,
    'chatgpt-account-id': cred.account,
    originator: 'codex_cli_rs',
    'OpenAI-Beta': 'responses=experimental',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': NAT.ua,
  };
}

/** 打原生图像端点。抛出的错误分三类：
 *   · definitive = true  → 上游**明确**判定内容安全拒绝（确定答案，别重试别回退）
 *   · nativeSkip = true  → 原生这条路不可用（没开关/没凭据），直接回退
 *   · 其它               → 基础设施类故障，内部重试一轮后回退
 */
async function generateViaNative({ prompt, model, refDataUrls, size, quality, background }) {
  if (!NAT.enabled) throw Object.assign(new Error('原生端点未启用'), { nativeSkip: true });

  let cred = readCredential();
  if (!cred.token) throw Object.assign(new Error('拿不到渠道凭据'), { nativeSkip: true });

  const hasRefs = Array.isArray(refDataUrls) && refDataUrls.length > 0;
  const path = hasRefs ? '/images/edits' : '/images/generations';
  const body = () => (hasRefs
    ? {
        // 原生契约：images 是数组，天然支持多张（顺序即 "参考图1、参考图2…"）
        images: refDataUrls.map((u) => ({ image_url: u })),
        prompt,
        model,
        // 实测（2026-10-16）：原生端点**接受且执行** background=transparent
        // （返回的 PNG 是 RGBA，color_type=6；老路是直接 400）。
        ...(background === 'transparent' ? { background: 'transparent' } : {}),
      }
    : {
        prompt,
        model,
        n: 1,
        // size 实测仍被忽略（要 1024x1536 给 1254x1254）—— 比例仍靠提示词里的
        // "Aspect ratio"（见 foldParams）。这里照传，等上游哪天修好。
        ...(size && size !== 'auto' ? { size } : {}),
        ...(quality ? { quality } : {}),
        ...(background === 'transparent' ? { background: 'transparent' } : {}),
      });

  const t0 = Date.now();
  for (let round = 1; round <= 2; round++) {
    const ac = new AbortController();
    // 【为什么用"静默超时"而不是固定超时】
    //   实测：这个端点支持 stream=true，会先回 keepalive（0.3s）再回成品。
    //   固定超时（NATIVE_TIMEOUT_MS=240s）会在上游**还在正常渲染**时把它掐掉——
    //   4K/复杂构图有可能超过 240s。改成"多久没收到数据才算超时"，
    //   并用 NATIVE_WALL_MS 作为硬上限兜底。
    const idleMs = Number(process.env.NATIVE_IDLE_TIMEOUT_MS || 120000);
    const wallMs = Number(process.env.NATIVE_WALL_MS || 900000);
    let idleTimer = setTimeout(() => ac.abort(new Error('idle')), idleMs);
    const wallTimer = setTimeout(() => ac.abort(new Error('wall')), wallMs);
    const keepAlive = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ac.abort(new Error('idle')), idleMs);
    };
    try {
      const r = await fetch(`${NAT.base}${path}`, {
        method: 'POST',
        // ⚠️ 必须同时给 Accept: text/event-stream —— 实测只发 body 里的 stream=true
        //    时上游会按 Accept 回普通 JSON，keepalive 就拿不到了。
        headers: { ...nativeHeaders(cred), Accept: 'text/event-stream' },
        // stream=true：拿 keepalive，长任务不会被中间任何一层当成"卡死"掐掉
        body: JSON.stringify({ ...body(), stream: true }),
        signal: ac.signal,
      });

      // ── 流式读取：兼容 SSE（我们请求的）与一次性 JSON（万一上游忽略 stream）──
      const ctype = String(r.headers.get('content-type') || '');
      let text = '';
      let b64FromStream = '';
      let refusalText = '';
      if (r.ok && ctype.includes('text/event-stream') && r.body) {
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
          keepAlive();
          buf += dec.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
            if (!dataLine) continue;
            let payload = null;
            try { payload = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
            if (payload?.b64_json) b64FromStream = String(payload.b64_json);
            if (payload?.error || payload?.type === 'error') {
              refusalText = JSON.stringify(payload).slice(0, 600);
            }
          }
        }
        if (!b64FromStream && !refusalText) refusalText = '流结束但没有图片事件';
      } else {
        text = await r.text();
      }

      if (r.ok) {
        let first = {};
        if (b64FromStream) {
          first = { b64_json: b64FromStream };
        } else if (text) {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* ignore */ }
          first = parsed?.data?.[0] || {};
        }
        const b64 = String(first.b64_json || '');
        if (!b64) {
          throw Object.assign(
            new Error(`返回里没有图片：${(refusalText || text || '').slice(0, 300)}`),
            { upstream: true },
          );
        }
        log(`   ⚡ codex原生端点 ${path} 出图 ${(b64.length / 1024 / 1.37).toFixed(0)}KB ${Date.now() - t0}ms${first.size ? ' ' + first.size : ''}${b64FromStream ? ' [sse]' : ''}`);
        return { b64, elapsed: Date.now() - t0, native: true };
      }
      if (!text) text = refusalText;

      // 凭据可能刚被 new-api 轮换过 → 强制重读一轮
      if ((r.status === 401 || r.status === 403) && round === 1) {
        log(`   ↻ 原生 ${r.status}，强制重读凭据后重试`);
        cred = readCredential(true);
        if (!cred.token) throw Object.assign(new Error('凭据读取失败'), { nativeSkip: true });
        continue;
      }

      const stage = /"moderation_stage"\s*:\s*"([^"]+)"/.exec(text)?.[1] || '';
      const cats = (/\"categories\"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] || '').replace(/["\s]/g, '');
      const rid = /"request_id"\s*:\s*"([^"]+)"/.exec(text)?.[1]
        || /request ID[:：]?\s*([0-9a-fA-F-]{36})/i.exec(text)?.[1] || '';
      if (/"code"\s*:\s*"moderation_blocked"/.test(text) || /safety system/i.test(text)) {
        const msg = `上游内容安全系统拒绝（原生端点）${stage ? `：判定阶段=${stage}` : ''}${cats ? `，类别=${cats}` : ''}${rid ? `，请求ID=${rid}` : ''}`;
        log(`   🚫 ${msg}  ${Date.now() - t0}ms`);
        throw Object.assign(new Error(msg), {
          upstream: true, refusal: true, refusalText: text.slice(0, 400), definitive: true, native: true,
        });
      }

      throw Object.assign(new Error(`原生端点 HTTP ${r.status}: ${text.slice(0, 300)}`), { upstream: true });
    } catch (e) {
      if (e.definitive || e.nativeSkip || round === 2) throw e;
      log(`   ⚠️ 原生端点异常（${String(e.message).slice(0, 120)}），1s 后重试一轮`);
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(wallTimer);
    }
  }
  throw Object.assign(new Error('原生端点不可用'), { nativeSkip: true });
}

// ------------------------------------------------- 透传：非图片端点原样转发
/**
 * 为什么需要它：new-api 是**按模型名**路由的，不看端点。
 * `gpt-image-2` 现在挂在优先级 10 的 shim 渠道上，所以任何用这个名字发起的请求
 * （包括 /v1/responses、/v1/chat/completions）都会被抢到这里。
 *
 * 早先这里直接返回 404，结果 Codex 把 404 显示成
 *   "Selected model is at capacity. Please try a different model."
 * —— 一个误导性的报错（2026-09-22 发现并修复）。
 *
 * 现在改成：把模型名换成真正干活的对话模型，请求原样转发回上游，响应流式透传。
 */
async function passthrough(req, res, path) {
  let bodyText = '';
  try {
    bodyText = await readBody(req);
  } catch (e) {
    return apiError(res, 400, `read body failed: ${e.message}`);
  }

  let body = null;
  try {
    body = JSON.parse(bodyText || '{}');
  } catch {
    return apiError(res, 400, 'invalid json');
  }

  const originalModel = String(body?.model ?? '');
  if (CFG.imageModels.includes(originalModel)) {
    body.model = CFG.relayModel;
    log(`↪ 透传 ${path}：模型 ${originalModel} → ${CFG.relayModel}`);
  } else {
    log(`↪ 透传 ${path}：模型 ${originalModel}`);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CFG.timeoutMs);
  try {
    const r = await fetch(`${CFG.relayBase}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.relayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    res.writeHead(r.status, {
      'Content-Type': r.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    if (r.body) {
      for await (const chunk of r.body) {
        if (!res.write(chunk)) await new Promise((k) => res.once('drain', k));
      }
    }
    res.end();
  } catch (e) {
    log(`   ❌ 透传失败: ${e.message}`);
    if (!res.headersSent) apiError(res, 502, `passthrough failed: ${e.message}`, 'upstream_error');
    else res.end();
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ 请求处理
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // 健康检查（容器探活 / 人工排查）
  if (p === '/health') {
    // 【2026-11-18】把"网页管线凭据是否过期"暴露出来：过期时站点/日志能一眼看到，
    // 否则只会表现为"图变静态、只出一张"，很难想到是 cookie 到期。
    let web = null;
    try { web = webCredentialStatus(); } catch { web = null; }
    return json(res, 200, {
      ok: true, upstream: `${CFG.relayBase}/v1/responses`, model: CFG.relayModel,
      web: WEB.enabled ? { enabled: true, ...(web || {}) } : { enabled: false },
    });
  }

  // 【内部用】网页模式可选的模型列表（站点直接问 shim，不经 new-api）
  // 【2026-11-18】主动探凭据：cookie 过期时这里直接返回过期时间，不用等出图才暴露
  if (p === '/web/creds') {
    try {
      const r = await probeWebCredentials();
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  if (p === '/web/models') {
    try {
      const info = await listWebModels(String(url.searchParams.get('mode') || ''));
      return json(res, 200, { ok: true, ...info, mode: getSurfaceMode() });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message).slice(0, 200), models: [] });
    }
  }

  // new-api 的"测试渠道"会打这个接口，实现了它渠道才显示正常
  if (p === '/v1/models') {
    return json(res, 200, {
      object: 'list',
      data: CFG.imageModels.map((id) => ({ id, object: 'model', created: 1704067200, owned_by: 'mssk-shim' })),
    });
  }

  // 非图片端点：透传回上游（见上面的 passthrough 注释 —— 404 会被 Codex 显示成
  // "Selected model is at capacity"，是我们踩过的坑）
  if (req.method === 'POST' && (p === '/v1/responses' || p === '/v1/chat/completions' || p === '/v1/messages')) {
    return passthrough(req, res, p);
  }

  // 图片端点：generations 和 edits 都要实现。
  // ⚠️ 少实现一个就会被 Codex 显示成 "Selected model is at capacity"
  //    （2026-09-22 先栽在 /v1/responses，又栽在 /v1/images/edits）
  const isGen = p === '/v1/images/generations';
  // ⚠️ 教训：每漏掉一个 Codex 会调的端点，它就把 404 显示成
  //    "Selected model is at capacity. Please try a different model."
  //    已经栽过两次（/v1/responses、/v1/images/edits）。
  //    所以 images/* 下除 generations 外一律按"带参考图的编辑"处理 ——
  //    宁可多支持一个，也不要再 404。
  const isEdit = p.startsWith('/v1/images/') && !isGen;
  if (req.method !== 'POST' || (!isGen && !isEdit)) {
    return apiError(res, 404, `unknown endpoint: ${req.method} ${p}`, 'not_found');
  }

  // 鉴权：new-api 会用渠道里配的 key 来打
  if (CFG.apiKey) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CFG.apiKey}`) return apiError(res, 401, 'invalid api key', 'authentication_error');
  }

  let prompt = '';
  let refDataUrls = [];        // 多张参考图（原生契约本身就是 images: [...]）
  let model = CFG.imageModels[0];
  let n = 1;
  let effPrompt = '';
  let reqSize = '';
  let reqQuality = '';
  let reqBackground = '';
  // 【2026-10-16】站点可指定网页管线的模式（chat/work）与具体模型 slug。
  // 走 new-api 时这些字段会被原样透传（body 里的额外字段），Codex 自己不会发。
  let webMode = 'chat';
  let webModel = '';
  let webEffort = '';
  // 【2026-10-27】对话续接的钥匙（调用方生成，本进程据此找回上游 conversation_id）
  let webConvKey = '';
  let gifSpeed = '';   // [2026-11-05] GIF 速度档位：0.25/0.5/0.75/1/1.25/1.5/1.75/2

  if (isEdit) {
    // ---- /v1/images/edits：multipart（Codex 走这条）或 JSON 都支持 ----
    const ctype = String(req.headers['content-type'] || '');
    let rawBuf;
    try {
      rawBuf = await readRawBody(req, 40 * 1024 * 1024);
    } catch (e) {
      return apiError(res, 400, `read body failed: ${e.message}`);
    }

    const images = [];   // [{mime, b64}] —— 按出现顺序，支持多张

    const bMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    if (bMatch) {
      const boundary = (bMatch[1] || bMatch[2]).trim();
      for (const part of parseMultipart(rawBuf, boundary)) {
        // ⚠️ 参考图的字段名各家不一样：image / image[] / image[0] / images / images[] 都要认。
        //    旧版只认 name === 'image' 且循环里覆盖赋值 → **多张图只有最后一张生效**。
        if (/^images?(\[[0-9]*\])?$/.test(part.name || '')) {
          images.push({ mime: part.ctype || 'image/png', b64: part.body.toString('base64') });
        } else if (part.name === 'prompt') prompt = part.body.toString('utf8').trim();
        else if (part.name === 'model') model = part.body.toString('utf8').trim();
        else if (part.name === 'n') n = Number(part.body.toString('utf8')) || 1;
        else if (part.name === 'background') reqBackground = part.body.toString('utf8').trim();
        else if (part.name === 'web_conv_key') webConvKey = part.body.toString('utf8').trim();
          else if (part.name === 'gif_speed') gifSpeed = part.body.toString('utf8').trim();
        // 【2026-11-04】multipart 分支以前只认 web_conv_key，web_mode/web_model/web_effort
        // 全被丢掉 → 参考图的请求永远是 web=chat/auto，用户在界面上选的模型对改图无效。
        else if (part.name === 'web_mode') webMode = part.body.toString('utf8').trim();
        else if (part.name === 'web_model') webModel = part.body.toString('utf8').trim();
        else if (part.name === 'web_effort') webEffort = part.body.toString('utf8').trim();
        // mask：目前只记日志不转发 —— 原生契约是否支持遮罩我们还没验证过（别假装支持）。
        else if (part.name === 'mask') log('   ℹ️ 收到 mask 字段（当前不转发，见 docs）');
      }
    } else {
      let j = null;
      try { j = JSON.parse(rawBuf.toString('utf8') || '{}'); } catch { return apiError(res, 400, 'invalid json'); }
      prompt = String(j.prompt || '').trim();
      if (j.model) model = String(j.model);
      if (j.n) n = Number(j.n) || 1;
      if (j.background) reqBackground = String(j.background);
      if (j.web_mode) webMode = String(j.web_mode);
      if (j.web_model) webModel = String(j.web_model);
      if (j.web_effort) webEffort = String(j.web_effort);
      if (j.web_conv_key) webConvKey = String(j.web_conv_key);
        if (j.gif_speed) gifSpeed = String(j.gif_speed);
      // 官方 Codex 的 JSON 契约是 images:[{image_url}]；也兼容单值 image / 裸 base64。
      const raw = Array.isArray(j.images) ? j.images : (j.image ? [j.image] : []);
      for (const entry of raw) {
        const value = typeof entry === 'string' ? entry : String(entry?.image_url || entry?.image || '');
        const m = /^data:([^;]+);base64,(.*)$/s.exec(value);
        if (m) images.push({ mime: m[1], b64: m[2] });
        else if (value) images.push({ mime: 'image/png', b64: value });
      }
    }

    if (!images.length) return apiError(res, 400, 'image is required for /v1/images/edits');
    refDataUrls = images.map((i) => `data:${i.mime};base64,${i.b64}`);
    n = 1; // Codex 的 edits 语义是一次一张
    effPrompt = prompt || '参考这张图生成一张图';
    const totalKb = images.reduce((sum, i) => sum + Buffer.from(i.b64, 'base64').length / 1024, 0);
    log(`→ images/edits model=${model} images=${images.length} 共${totalKb.toFixed(0)}KB`
      + ` web=${webMode}/${webModel || 'auto'} prompt=${(prompt || '(空)').slice(0, 50)}`
      + `${isTestReq(req, null) ? ' [TEST]' : ''}`);
  } else {
    // ---- /v1/images/generations ----
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
      return apiError(res, 400, `invalid json: ${e.message}`);
    }
    prompt = String(body.prompt || '').trim();
    if (!prompt) return apiError(res, 400, 'prompt is required');
    if (body.model) model = String(body.model);
    n = Math.min(Math.max(Number(body.n) || 1, 1), 4);
    effPrompt = foldParams(prompt, body.size, body.quality, body.background);
    reqSize = String(body.size || '');
    reqQuality = String(body.quality || '');
    reqBackground = String(body.background || '');
    if (body.web_mode) webMode = String(body.web_mode);
    if (body.web_model) webModel = String(body.web_model);
    if (body.web_effort) webEffort = String(body.web_effort);
    if (body.web_conv_key) webConvKey = String(body.web_conv_key);
    if (body.gif_speed) gifSpeed = String(body.gif_speed);   // [2026-11-05] GIF 速度
    // ⚠️ image-web 走 new-api 时，顶层自定义字段会被 new-api 的强类型结构体丢掉，
    //    所以这几个参数走 style（json.RawMessage，能透传）。两种写法都认。
    if (body.style && typeof body.style === 'object') {
      const st = body.style;
      if (!webConvKey && st.mssk_conv) webConvKey = String(st.mssk_conv);
      if (!webMode || webMode === 'chat') { if (st.mssk_mode) webMode = String(st.mssk_mode); }
      if (!webModel && st.mssk_model) webModel = String(st.mssk_model);
      if (!webEffort && st.mssk_effort) webEffort = String(st.mssk_effort);
  // 【2026-11-18】挡掉前端把 undefined/null 当字符串传上来的情况：
  //   实测 thinking_effort="undefined" 会让上游判整个 body 非法（422 Invalid conversation body）。
  if (webEffort === 'undefined' || webEffort === 'null' || webEffort === 'null') webEffort = '';
      if (!gifSpeed && st.mssk_gif_speed) gifSpeed = String(st.mssk_gif_speed);
    }
    log(`→ images/generations model=${model} n=${n} size=${body.size || '-'} quality=${body.quality || '-'}`
      + `${webModel || webMode !== 'chat' ? ` web=${webMode}/${webModel || 'auto'}` : ''} prompt=${prompt.slice(0, 60)}`
      + `${isTestReq(req, body) ? ' [TEST]' : ''}`);
  }

  // 单张出图：**按模型名选管线**（2026-10-16）
  //   · gpt-image-2        → 网页管线（picture_v2）优先，失败再回退原生端点
  //   · codex-gpt-image-2  → 只走原生端点（订阅 OAuth 的 /codex/images/*）
  //   · gpt-image-2.6-*    → 同样先走网页管线（能出 GIF/多图），失败回退原生端点并按 2.6 出图
  // 原生也不可用时，最后才走 /responses + 图像工具。
  if (WEB.enabled) setSurfaceMode(webMode);
  const isCodexModel = /^codex-/i.test(model);
  let nativeModel = model.replace(/^codex-/i, '') || 'gpt-image-2';
  // 没点名 2.6 时，按配置把原生端点升级到新版本（网页管线的回退也走这里）
  if (CFG.nativeUpgradeModel && !/^gpt-image-2\./i.test(nativeModel)) {
    log(`   ⤴ 原生端点模型升级：${nativeModel} → ${CFG.nativeUpgradeModel}`);
    nativeModel = CFG.nativeUpgradeModel;
  }
  let degradedReason = '';          // 非空 = 这次是降级路径出的图（要上报）
  const generateOne = async () => {
    // ① 网页管线（只有非 codex-* 模型才走）
    if (WEB.enabled && !isCodexModel) {
      const saved = lookupConv(webConvKey);
      // 【2026-11-06】上游风控（422/403）不再直接降级：原生端点永远只出 1 张 PNG，
      // 一降级多图/GIF 功能就等于没了（实测 03:11:38 站内要 4 张 → 422 → 降级 → 只回 1 张）。
      // 这里等一会儿换号再试一次；两次都失败才降级。
      let rateRetried = 0;
      try {
        let w;
        try {
          if (saved) {
            log(`   🔗 续接对话 conv=${String(saved.conversationId).slice(0, 8)}`
              + ` parent=${String(saved.parentMessageId).slice(0, 8)} key=${webConvKey.slice(-12)}`);
          }
          w = await generateViaWeb({
            prompt: effPrompt,
            refDataUrls,
            model: webModel,
            effort: webEffort,
            conversationId: saved?.conversationId || '',
            parentMessageId: saved?.parentMessageId || '',
            cookieName: saved?.cookieName || '',
            gifSpeed,
            n,
          });
        } catch (e) {
          // 续接失败（对话被删 / 过期 / 结构变了 / 号被风控）→ 丢掉记录，按新建对话重试一次。
          if (!saved) throw e;
          log(`   ↩️ 续接失败（${String(e.message).slice(0, 100)}）→ 丢掉记录，改新建对话重试`);
          forgetConv(webConvKey);
          w = await generateViaWeb({ prompt: effPrompt, refDataUrls, model: webModel, effort: webEffort, gifSpeed, n });
        }
        if (w && w.b64) {
          // 记下这一轮的叶子节点，下一轮 parent_message_id 用它
          if (webConvKey && w.conversationId) {
            try {
              // 【2026-11-06】带上本轮用的号：不钉号就会用另一个号的 token 读对话 → 404 无权访问
              const leaf = await getConversationLeaf(w.conversationId, '', w.cookieName || '');
              rememberConv(webConvKey, w.conversationId, leaf, w.cookieName);
            } catch (e) {
              rememberConv(webConvKey, w.conversationId, '', w.cookieName);
              log(`   ⚠️ 取叶子节点失败（下轮会当新对话）：${String(e.message).slice(0, 80)}`);
            }
          }
          return w;
        }
      } catch (e) {
        // 【2026-11-06】新建对话被限流：直接失败，绝不换端点偷偷画（否则闸门形同虚设）
        if (e.convQuota) throw e;
        // 【2026-11-06】我们自己的代码错误（ReferenceError/TypeError/SyntaxError）不是"上游不可用"。
        // 之前这类异常被当成"网页管线不可用"→ 静默降级 codex 端点 → 用户拿到一张来历不明的静态 PNG
        // （实测：n is not defined 时，上游 GIF 还在画，用户却收到 1774x887 PNG）。
        const isOurBug = e instanceof ReferenceError || e instanceof TypeError || e instanceof SyntaxError;
        if (isOurBug) {
          log(`   💥 [BUG] 网页管线代码异常（${e.name}: ${e.message}）→ 不降级，直接报错`);
          throw Object.assign(e, { webBug: true, definitive: false });
        }
        // 【2026-11-04】措辞分清两件事：
        //   · 冷却中 = 已知的上游风控窗口，属于"计划内降级"，不是故障
        //   · 其他   = 真·失败
        // 用户侧一律无感（原生照常出图），所以日志要写清楚是降级还是故障。
        // 【2026-11-06】风控（422/403）先换号重试一次，别急着降级 —— 原生只出 1 张。
        if (e.rateLimited && rateRetried < 1) {
          rateRetried++;
          const retryDelay = Number(process.env.WEB_RATE_RETRY_DELAY_MS || 15000);
          log(`   🔁 上游风控（${String(e.message).slice(0, 60)}）→ 等 ${Math.round(retryDelay / 1000)}s 换号重试一次（不降级）`);
          await new Promise((r) => setTimeout(r, retryDelay));
          try {
            const w2 = await generateViaWeb({ prompt: effPrompt, refDataUrls, model: webModel, effort: webEffort, gifSpeed, n });
            if (w2 && w2.b64) {
              if (webConvKey && w2.conversationId) {
                try {
                  const leaf = await getConversationLeaf(w2.conversationId, '', w2.cookieName || '');
                  rememberConv(webConvKey, w2.conversationId, leaf, w2.cookieName);
                } catch {
                  rememberConv(webConvKey, w2.conversationId, '', w2.cookieName);
                }
              }
              log(`   ✅ 换号重试成功（网页管线保住了，${(w2.assets || [1]).length} 张）`);
              return w2;
            }
          } catch (e2) {
            log(`   ⚠️ 换号重试仍失败：${String(e2.message).slice(0, 100)}`);
          }
        }
        const msg = String(e.message).slice(0, 140);
        degradedReason = msg;      // ← 上报给调用方（最终响应里带 degraded:true）
        if (e.cooldown) log(`   ⏸️ 降级（计划内）：${msg} → 用 codex 原生端点出图`);
        else log(`   ⚠️ 降级：网页管线失败（${msg}）→ 用 codex 原生端点出图（结果会标 degraded）`);
      }
    }
    // ② 原生端点（订阅 OAuth）
    if (NAT.enabled) {
      try {
        const rNative = await generateViaNative({
          prompt: effPrompt,
          model: nativeModel,
          refDataUrls,
          size: isEdit ? '' : reqSize,
          quality: isEdit ? '' : reqQuality,
          background: reqBackground,
        });
        return degradedReason ? { ...rNative, degraded: true, degradedReason } : rNative;
      } catch (e) {
        if (e.definitive && !NAT.refusalFallback) throw e;
        if (!e.definitive) {
          log(`   ↩️ 回退 /responses + 图像工具（原生不可用：${String(e.message).slice(0, 110)}）`);
        }
      }
    }
    // ③ 老路
    const rOld = await generateViaResponses({ prompt: effPrompt, model: nativeModel, refDataUrls });
    return degradedReason ? { ...rOld, degraded: true, degradedReason } : rOld;
  };

  try {
    const data = [];
    for (let i = 0; i < n; i++) {
      const r = await generateOne();
      // 【2026-11-06】② 多图返回：网页管线一次可能出多张（上游结构 = 一张一条 tool 消息），
      // 每个 asset 都是一个独立的 data 项；老路径没有 assets 字段时退回单张。
      const list = Array.isArray(r.assets) && r.assets.length
        ? r.assets
        : [{ b64: r.b64, mime: r.mime || 'image/png', spriteB64: r.spriteB64 || '', animation: r.animation || null }];
      if (list.length > 1) log(`   🖼️ 第 ${i + 1}/${n} 次请求上游返回 ${list.length} 张，全部透传`);
      for (const a of list) {
        const buf = Buffer.from(a.b64, 'base64');
        const dim = pngSize(buf);
        data.push({
          b64_json: a.b64,
          revised_prompt: prompt,
          mime_type: a.mime || 'image/png',
          // [2026-11-05] 有动图时附带 sprite sheet + 帧参数，前端可用 canvas 播放并调速
          ...(a.spriteB64 ? { sprite_sheet: a.spriteB64 } : {}),
          ...(a.animation ? { animation: a.animation } : {}),
          ...(dim ? { size: `${dim.w}x${dim.h}` } : {}),
        });
        log(`   ✅ 第 ${data.length} 张 ${dim ? `${dim.w}x${dim.h}` : '?'} ${(buf.length / 1024).toFixed(0)}KB`
          + ` ${a.mime || 'image/png'} ${r.elapsed}ms`);
      }
    }
    return json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data,
      ...(degradedReason ? { degraded: true, degraded_reason: degradedReason } : {}),
    });
  } catch (e) {
    log(`   ❌ ${e.message}`);
    // 【2026-11-06】我们自己的代码 bug：明确报错，不冒充"上游问题"
    if (e.webBug) {
      return json(res, 500, {
        error: {
          message: `网页管线代码异常：${e.name}: ${e.message}（这是本站 bug，不是上游问题；没有出图）`,
          type: 'server_error', param: null, code: 'web_pipeline_bug',
        },
      });
    }
    // 【2026-11-06】新建对话限流 → 429（明确告诉调用方：别再开新对话，续接已有对话）
    if (e.convQuota) {
      return json(res, 429, {
        error: { message: e.message, type: 'rate_limit_error', param: null, code: 'new_conversation_limited' },
      });
    }
    if (e.definitive) {
      // 上游明确判定（内容安全）—— 这是**确定的答案**，不是故障：
      // 立刻回 400 + 结构化信息（阶段/类别/请求 ID），让调用方秒级知道原因。
      return json(res, 400, {
        error: { message: e.message, type: 'image_generation_user_error', param: null, code: 'moderation_blocked' },
      });
    }
    return apiError(res, e.upstream ? 502 : 500, e.message, e.upstream ? 'upstream_error' : 'server_error');
  }
});

server.listen(CFG.port, () => {
  log(`imagegen-shim 已启动  http://0.0.0.0:${CFG.port}`);
  log(`  上游        ${CFG.relayBase}/v1/responses   模型 ${CFG.relayModel}`);
  log(`  对外模型    ${CFG.imageModels.join(', ')}`);
  log(`  鉴权        ${CFG.apiKey ? '已启用' : '⚠️ 未设置 API_KEY'}`);
  log(`  单次超时    ${CFG.timeoutMs}ms`);
  log(`  原生端点    ${NAT.enabled ? `✅ 启用 → ${NAT.base}/images/*（失败自动回退）` : '⛔ 关闭（走 /responses + 图像工具）'}`);
  log(`  凭据来源    ${NAT.dbPath} (渠道 ${NAT.channelId})  sqlite=${DatabaseSync ? 'node:sqlite' : '文本兜底'}`);
  log(`  网页管线    ${WEB.enabled ? '✅ 启用 → picture_v2 优先（model=' + WEB.model + '，失败再走原生）' : '⛔ 关闭（WEB_PIPELINE=1 开启）'}`);
});
