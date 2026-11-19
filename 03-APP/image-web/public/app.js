/* ============================================================================
   MSSK 生图 —— 前端逻辑（原生 ES 模块，无构建步骤）
   ========================================================================== */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

const STEPS = [
  { key: 'connecting', label: '提交' },
  { key: 'thinking', label: '理解' },
  { key: 'generating', label: '绘制' },
  { key: 'finalizing', label: '收尾' },
];
const SAMPLES = [
  '一只戴圆框眼镜的橘猫坐在书桌前看书，暖色台灯光，插画风',
  '赛博朋克城市夜景，雨后霓虹倒影，电影感',
  '日系小清新静物：木质桌面、陶瓷杯、晨光斜射',
  '扁平风格的产品图标：云存储，圆角，柔和渐变',
];

const state = {
  user: null,
  conversations: [],
  conv: null,
  streaming: false,
  abort: null,          // 兼容旧字段（现在按对话存在 state.streams 里）
  streams: new Map(),   // 【2026-11-06】convId -> { ac, prog, mine, prompt }：每个对话一条流
  // 【2026-11-06】真实使用是"一边跑一边干别的"：草稿 / 参考图托盘 / 排队 都按对话隔离
  drafts: new Map(),    // convId -> 输入框里没发出去的文字
  refTrays: new Map(),  // convId -> 参考图数组
  queues: new Map(),    // convId -> [{ prompt, refs, opts }]
  unread: new Set(),    // convId -> 后台出完图、用户还没看的对话
  canStop: false,       // 按钮此刻是否是"停止"
  stoppedByUser: false, // 这次是不是用户主动停的
  ratio: '16:9',
  ratioTouched: false,   // 用户是否亲手挑过比例（挑过就不再被"适应原图"自动覆盖）
  transparent: false,    // 透明底：只折进提示词（上游不收 background 参数），见 server.mjs
  // 生图管线：'web' = gpt-image-2（网页优先，失败自动回退原生）；
  //           'codex' = codex-gpt-image-2（只走订阅 OAuth 的原生端点）
  pipeline: 'web',
  webMode: 'chat',        // 网页管线的 surface：chat（成功率更高）/ work
  modelLabels: {},
  presetMap: {},          // 网页管线：档位名 → { slug, effort }
  efforts: [],
  model: '',
  effort: '',
  models: [],
  effortsByModel: {},
  refs: [],            // 参考图托盘：{ id, name, dataUrl, bytes }
  stages: {},
};
const REF_MAX = 4;
const REF_MAX_MB = 8;
const EFFORT_LABEL = {
  none: '无（最快）', minimal: '最低', low: '低', medium: '中',
  high: '高', xhigh: '极高', max: '最高', ultra: 'Ultra', ultrafast: '极速',
};

// ------------------------------------------------------------------ 请求
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function toast(msg, isErr, ms) {
  const t = el('div', 'toast' + (isErr ? ' err' : ''), msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms || (isErr ? 7000 : 3200));
}

/**
 * 【2026-10-27】换模型时的提醒
 *
 * 现在的对话是**续接着上游同一个 ChatGPT 对话**的（靠 web_conv_key）。
 * 一个上游对话带模型属性：中途换模型，续接有可能不稳定或风格断档。
 *
 * 但**不自动新建对话** —— 那会把上下文直接丢掉，用户未必想要。
 * 这里只提示一句，让用户自己决定是「继续」还是「新建对话」。
 */
let lastModelHintAt = 0;
function hintModelSwitch() {
  const hasHistory = (state.conv?.messages || []).some((m) => m.text);
  if (!hasHistory) return;                       // 空对话，换模型没损失，不打扰
  const now = Date.now();
  if (now - lastModelHintAt < 8000) return;      // 连点几下只提示一次
  lastModelHintAt = now;
  toast('已换模型。当前对话接着上游同一个对话，换模型后继续聊可能风格断档 —— 建议新建对话重新开始，不换也能接着用。', false, 8000);
}

// ------------------------------------------------------------------ 登录
/** 按登录方式摆好表单：token 模式只要一个令牌框 */
function applyLoginMode() {
  const tokenMode = state.authMode === 'token';
  // token 模式只用令牌登录 —— 不显示用户名
  $('#userField').hidden = tokenMode ? true : state.multiUser !== true;
  $('#pwLabel').textContent = tokenMode ? '中转站令牌' : '口令';
  $('#loginPassword').placeholder = tokenMode ? '粘贴你的 sk- 令牌' : '输入访问口令';
  const hint = $('#loginHint');
  if (tokenMode) {
    hint.hidden = false;
    hint.innerHTML =
      '粘贴你的<b>中转站令牌</b>（<code>sk-</code> 开头，和 Codex 用的是同一个）即可，不用填用户名。' +
      '<br />登录时会拿它去中转站实时校验 —— 后台吊销令牌后此处立刻失效。';
  } else {
    hint.hidden = true;
  }
  (state.multiUser ? $('#loginUser') : $('#loginPassword')).focus();
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  applyLoginMode();
}

async function boot() {
  try {
    const me = await api('/api/me');
    state.user = me.user;
    await enterApp();
  } catch { showLogin(); }
  // 探测登录方式：multiUser 决定要不要填用户名；authMode=token 时口令是中转站令牌
  try {
    const r = await fetch('/api/health');
    const h = await r.json();
    state.multiUser = h.multiUser === true;
    state.authMode = h.authMode || 'password';
    // ⚠️ 必须在这里再同步一次：showLogin() 可能在 health 返回之前就跑过了
    if (!$('#login').hidden) applyLoginMode();
    // 顶栏模型名（下拉框已在用，这里只是兜底；老元素可能不存在）
    const tag = $('#modelTag');
    if (tag) tag.textContent = h.model || 'gpt-5.6-sol';
  } catch (e) {
    console.warn('[boot] 探测登录方式失败', e);
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginErr');
  err.hidden = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#loginPassword').value, user: $('#loginUser').value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '登录失败');
    state.user = data.user;
    $('#loginPassword').value = '';
    await enterApp();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
});

$('#btnLogout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  state.user = null; state.conv = null; state.conversations = [];
  showLogin();
});

async function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#whoami').textContent = state.user;
  renderSamples();
  await loadModels();
  await loadConversations();
  if (state.conversations.length) await openConversation(state.conversations[0].id);
  else await newConversation();
}

// ------------------------------------------------------------------ 自定义下拉
// 不用原生 <select>：它的弹层由浏览器/系统画，CSS 管不到背景，
// 在 Windows 上会出现"浅底浅字"看不清。这里自己画，颜色和位置都可控。
function makeDropdown(root, { items, value, direction = 'down', align = 'left', onPick }) {
  root.classList.add('dd');
  root.innerHTML = '';
  const btn = el('button', 'dd-btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  const pop = el('div', 'dd-pop' + (direction === 'up' ? ' up' : '') + (align === 'right' ? ' right' : ''));
  pop.setAttribute('role', 'listbox');
  pop.hidden = true;
  root.append(btn, pop);

  const close = () => {
    pop.hidden = true; root.classList.remove('open');
    document.removeEventListener('mousedown', onOutside, true);
  };
  const onOutside = (e) => { if (!root.contains(e.target)) close(); };
  const open = () => {
    pop.hidden = false; root.classList.add('open');
    document.addEventListener('mousedown', onOutside, true);
    pop.querySelector('.dd-opt.on')?.scrollIntoView({ block: 'nearest' });
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close();
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (pop.hidden) return open();
    const all = [...pop.querySelectorAll('.dd-opt')];
    const i = all.findIndex((n) => n.classList.contains('on'));
    all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.click();
  });

  return function update(newItems, newValue) {
    const list = newItems && newItems.length ? newItems : items;
    const val = newValue !== undefined ? newValue : value;
    const cur = list.find((x) => x.value === val) || list[0];
    btn.innerHTML = '';
    btn.append(el('span', null, cur ? cur.label : '—'), el('span', 'caret', '▾'));
    btn.title = cur ? (cur.hint ? `${cur.label} ${cur.hint}` : cur.label) : '';
    pop.innerHTML = '';
    for (const it of list) {
      const o = el('div', 'dd-opt' + (it.value === val ? ' on' : ''));
      o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', String(it.value === val));
      o.append(el('span', null, it.label));
      if (it.hint) o.append(el('span', 'dim', it.hint));
      o.addEventListener('click', (e) => { e.stopPropagation(); close(); onPick?.(it.value); });
      pop.appendChild(o);
    }
  };
}

// ------------------------------------------------------------------ 模型 / 推理档位
// 档位是**按模型**不同的（实测：gpt-5.5 不支持 max；minimal 全部不支持；ultra 不存在）
const effortsForModel = (m) => state.effortsByModel[m] || ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
let updateModelDd = null;
let updateEffortDd = null;

async function loadModels() {
  let info;
  const saved = JSON.parse(localStorage.getItem('mssk.prefs') || '{}');
  if (saved.pipeline === 'codex' || saved.pipeline === 'web') state.pipeline = saved.pipeline;
  if (saved.webMode === 'work' || saved.webMode === 'chat') state.webMode = saved.webMode;
  // 可选模型跟着管线走：web → 网页模式可用模型；codex → codex-gpt-image-2
  try { info = await api(`/api/models?pipeline=${state.pipeline}&mode=${state.webMode}`); } catch { return; }
  state.models = info.models || [];
  state.modelLabels = info.labels || {};
  state.presetMap = info.presetMap || {};
  state.effortsByModel = info.effortsByModel || {};
  state.efforts = info.efforts || [];

  const savedModel = state.pipeline === 'codex' ? saved.modelCodex : saved.modelWeb;
  state.model = state.models.includes(savedModel) ? savedModel
    : (info.default && state.models.includes(info.default.model) ? info.default.model : state.models[0] || '');
  state.effort = state.efforts.includes(saved.effortChoice) ? saved.effortChoice : '';

  if (state.pipeline === 'web') {
    const g = document.getElementById('pipelineGroup');
    if (g) [...g.querySelectorAll('.chip')].forEach((c) => c.classList.toggle('active', c.dataset.pipeline === 'web'));
    const m = document.getElementById('modeGroup');
    if (m) [...m.querySelectorAll('.chip')].forEach((c) => c.classList.toggle('active', c.dataset.mode === state.webMode));
  } else {
    const g = document.getElementById('pipelineGroup');
    if (g) [...g.querySelectorAll('.chip')].forEach((c) => c.classList.toggle('active', c.dataset.pipeline === 'codex'));
  }

  updateModelDd = makeDropdown($('#modelSelect'), {
    direction: 'down', align: 'right',
    items: state.models.map((m) => ({ value: m, label: state.modelLabels[m] ? `${m}` : m, hint: state.modelLabels[m] || '' })),
    value: state.model,
    onPick: (v) => {
      const changed = !!state.model && state.model !== v;
      state.model = v; savePrefs(); renderEfforts();
      if (changed) hintModelSwitch();
    },
  });
  updateEffortDd = makeDropdown($('#effort'), {
    direction: 'up',
    items: state.efforts.map((e) => ({ value: e, label: e || '默认' })),
    value: state.effort,
    onPick: (v) => { state.effort = v; savePrefs(); renderEfforts(); },
  });
  // Codex 原生没有聊天/工作之分 → 隐藏那一排，避免误解
  const mg = document.getElementById('modeGroup');
  if (mg) mg.hidden = state.pipeline === 'codex';
  renderEfforts();
  renderPipelineModel();
}

function renderEfforts() {
  const list = effortsForModel(state.model);
  // 换模型后，原来选的档位可能不被支持（比如 5.6-sol 的 max 到 5.5 就没有了）
  // 网页管线的档位是中文（即时/中/高）→ 默认挑「中」；老路是 medium → 也挑 medium
  if (!list.includes(state.effort)) {
    state.effort = list.includes('中') ? '中' : (list.includes('medium') ? 'medium' : list[0]);
  }
  updateModelDd?.(state.models.map((m) => ({ value: m, label: m })), state.model);
  updateEffortDd?.(
    list.map((e) => ({ value: e, label: EFFORT_LABEL[e] || e, hint: `（${e}）` })),
    state.effort
  );
}

function savePrefs() {
  localStorage.setItem('mssk.prefs', JSON.stringify({
    model: state.model, effort: state.effort, pipeline: state.pipeline,
    webMode: state.webMode, effortChoice: state.effort,
    ...(state.pipeline === 'codex' ? { modelCodex: state.model } : { modelWeb: state.model }),
  }));
}

// ------------------------------------------------------------------ 对话列表
async function loadConversations() {
  state.conversations = await api('/api/conversations');
  renderConvList();
}
function renderConvList() {
  const box = $('#convList');
  box.innerHTML = '';
  for (const c of state.conversations) {
    const item = el('div', 'conv' + (state.conv && state.conv.id === c.id ? ' active' : ''));
    const main = el('div', 'conv-main');
    main.appendChild(el('div', 'conv-title', c.title || '新对话'));
    const when = new Date(c.updatedAt || c.createdAt);
    main.appendChild(el('div', 'conv-sub', `${c.count || 0} 张 · ${when.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`));
    item.appendChild(main);
    const del = el('button', 'conv-del', '×');
    del.title = '删除对话';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除「${c.title}」及其所有图片？`)) return;
      await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
      if (state.conv && state.conv.id === c.id) state.conv = null;
      await loadConversations();
      if (state.conv) renderConversation();
      else if (state.conversations.length) await openConversation(state.conversations[0].id);
      else await newConversation();
    });
    item.appendChild(del);
    item.addEventListener('click', () => openConversation(c.id, true));
    if (state.streams.has(c.id)) {
      const dot = el('span', null, '●');
      dot.style.color = '#e8a33d';
      dot.title = '这个对话正在生成中';
      item.appendChild(dot);
    } else if (state.unread.has(c.id)) {
      const badge = el('span', null, '新');
      badge.style.color = '#e8a33d';
      badge.title = '后台已经出图，点开看看';
      item.appendChild(badge);
    }
    box.appendChild(item);
  }
}

async function newConversation() {
  if (state.conv) saveConvDraft();          // 旧对话的草稿/托盘先存起来
  const conv = await api('/api/conversations', { method: 'POST' });
  state.conv = conv;
  refreshConvUI();
  await loadConversations();
  const fresh = state.conversations.find((c) => c.id === conv.id);
  state.conv = await api(`/api/conversations/${conv.id}`);
  state.refs = [];
  loadConvDraft(conv.id);                   // 新对话：空草稿 + 空托盘
  renderConversation();
  renderConvList();
  updateDocTitle();
  return fresh;
}

async function openConversation(id) {
  if (state.conv && state.conv.id !== id) saveConvDraft();   // 先存当前对话的草稿/托盘
  state.conv = await api(`/api/conversations/${id}`);
  renderConversation();
  loadConvDraft(id);        // 恢复这个对话自己的草稿和参考图托盘
  state.unread.delete(id);
  if (state.conv.running) {
    // 【2026-11-06】把服务端的 startedAt / stage 传进去，否则秒数会从 0 重新算（用户看到"进度被重置"）
    attachRemoteJob(id, state.conv.runningSince, state.conv.runningStage);
  }
  refreshConvUI();          // 切对话立刻把按钮/提示/进度卡刷成这个对话的真实状态
  syncSendButton();
  renderConvList();
  updateDocTitle();
  // 这个对话有排队任务、现在空闲 → 自动接着跑
  if (!state.streams.has(id) && (state.queues.get(id) || []).length) {
    const next = state.queues.get(id).shift();
    toast('排队中的任务自动开始');
    generate(next);
  }
  $('#sidebar')?.classList.remove('open');
}

// ------------------------------------------------------------------ 渲染对话
function renderConversation() {
  const stream = $('#stream');
  stream.innerHTML = '';
  const conv = state.conv;
  $('#convTitle').textContent = conv ? conv.title : '新对话';
  if (!conv || conv.messages.length === 0) {
    stream.appendChild(buildEmpty());
    return;
  }
  for (const m of conv.messages) {
    if (m.role === 'user') stream.appendChild(userBubble(m));
    else stream.appendChild(assistantCard(m));
  }
  scrollDown();
  syncRefTags();
}

function buildEmpty() {
  const wrap = el('div', 'empty');
  wrap.id = 'empty';
  const img = el('img', 'empty-art'); img.src = '/assets/chibi.png'; img.alt = '';
  wrap.appendChild(img);
  wrap.appendChild(el('h2', null, '描述你想要的画面'));
  const p = el('p', 'muted');
  p.innerHTML =
    '<b>上下文</b>：这个对话里的文字会自动带上 —— 你前面说过的风格、主角、设定，模型都记得。<br />' +
    '<b>参考图</b>：图片要显式放进托盘才会影响出图 —— 点「＋参考图」上传，' +
    '或点那张图右上角的<b>「作为参考图」</b>标签。<br />一轮约 40～65 秒，带参考图更慢。';
  wrap.appendChild(p);
  const s = el('div', 'samples'); s.id = 'samples';
  wrap.appendChild(s);
  renderSamples(s);
  return wrap;
}
function renderSamples(box) {
  const target = box || $('#samples');
  if (!target) return;
  target.innerHTML = '';
  for (const t of SAMPLES) {
    const b = el('div', 'sample', t);
    b.addEventListener('click', () => { $('#prompt').value = t; autoGrow(); $('#prompt').focus(); });
    target.appendChild(b);
  }
}

function userBubble(m) {
  const row = el('div', 'msg user');
  const b = el('div', 'bubble');
  b.appendChild(el('div', null, m.text));
  if (m.refs && m.refs.length) {
    const rb = el('div', 'msg-refs');
    for (const r of m.refs) {
      const img = el('img');
      img.src = r.url || r.dataUrl; img.alt = '参考图'; img.title = '参考图 —— 点击放大';
      img.addEventListener('click', () => openLightbox(img.src, '参考图'));
      rb.appendChild(img);
    }
    b.appendChild(rb);
  }
  const chips = el('div', 'chips');
  if (m.ratio) chips.appendChild(el('span', 'chip-mini', '比例 ' + m.ratio));
  if (m.refs && m.refs.length) chips.appendChild(el('span', 'chip-mini', `参考图 ×${m.refs.length}`));
  if (chips.children.length) b.appendChild(chips);
  row.appendChild(b);
  return row;
}

// ------------------------------------------------------------------ 精确尺寸导出
/**
 * 【2026-10-16 新增】上游**忽略 size 参数**（每个比例只有一个固定渲染尺寸，约 1.57MP），
 * 所以"要 2048×1152 的文件"只能在**浏览器端**重采样——这里用 canvas 做，零依赖。
 * 规则与技能侧 imagegen-relay 的 --preset 完全一致（11 个比例 × 2K/4K，全部 16 像素对齐）。
 */
const EXPORT_PRESETS = {
  '1:1': { '2k': [2048, 2048], '4k': [2880, 2880] },
  '4:3': { '2k': [2048, 1536], '4k': [3264, 2448] },
  '3:2': { '2k': [2048, 1360], '4k': [3520, 2352] },
  '16:9': { '2k': [2048, 1152], '4k': [3840, 2160] },
  '2:1': { '2k': [2048, 1024], '4k': [3840, 1920] },
  '7:4': { '2k': [2208, 1264], '4k': [3808, 2176] },
  '3:4': { '2k': [1536, 2048], '4k': [2448, 3264] },
  '2:3': { '2k': [1360, 2048], '4k': [2352, 3520] },
  '9:16': { '2k': [1152, 2048], '4k': [2160, 3840] },
  '1:2': { '2k': [1024, 2048], '4k': [1920, 3840] },
  '4:7': { '2k': [1264, 2208], '4k': [2176, 3808] },
};

/** 找出与该图比例最接近的预设（按对数比例距离比较，横竖都算） */
function presetForRatio(w, h) {
  const r = w / h;
  let best = null, bestErr = Infinity;
  for (const [name, tiers] of Object.entries(EXPORT_PRESETS)) {
    const [a, b] = name.split(':').map(Number);
    const err = Math.abs(Math.log(r) - Math.log(a / b));
    if (err < bestErr) { bestErr = err; best = { name, tiers }; }
  }
  return best;
}

/** 按 cover 规则重采样到精确像素（保留透明通道），然后下载 */
async function exportExactSize(url, targetW, targetH) {
  const img = new Image();
  img.src = url;
  img.crossOrigin = 'anonymous';
  await img.decode();
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const scale = Math.max(targetW / iw, targetH / ih);
  const sw = Math.min(iw, targetW / scale), sh = Math.min(ih, targetH / scale);
  const sx = (iw - sw) / 2, sy = (ih - sh) / 2;      // 居中裁切，避免变形
  const c = document.createElement('canvas');
  c.width = targetW; c.height = targetH;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('导出失败');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `MSSK-${targetW}x${targetH}-${Date.now()}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function exportControl(im) {
  const best = presetForRatio(im.w || 1, im.h || 1);
  const sel = el('select', 'act size-select');
  sel.title = '默认就是原图尺寸（不重采样）。下面的 2K/4K 是本地放大后的交付尺寸——'
    + '上游不支持指定输出像素，所以放大只是把文件做大，细节不会凭空增加。';
  // 原图尺寸放第一位：这是默认、也是绝大多数情况下该用的
  sel.appendChild(new Option(`导出尺寸…（默认 原始 ${im.w}×${im.h}）`, 'raw'));
  if (best) {
    const short = best.name;
    const opt = (tier, pixels) => {
      const scale = pixels[0] / (im.w || 1);
      const tag = scale > 1.001 ? `放大 ${scale.toFixed(2)}×` : '缩小';
      return new Option(`${short} ${tier.toUpperCase()} · ${pixels[0]}×${pixels[1]}（${tag}）`, pixels.join('x'));
    };
    sel.appendChild(opt('2k', best.tiers['2k']));
    sel.appendChild(opt('4k', best.tiers['4k']));
  }
  sel.addEventListener('change', async () => {
    const v = sel.value;
    sel.value = '';
    if (!v || v === 'raw') { download(im.url, `MSSK-${im.w || ''}x${im.h || ''}-${Date.now()}.png`); return; }
    const [tw, th] = v.split('x').map(Number);
    try {
      toast(`正在导出 ${tw}×${th}…`);
      await exportExactSize(im.url, tw, th);
      toast(`已导出 ${tw}×${th}`);
    } catch (e) {
      toast('导出失败：' + e.message, true);
    }
  });
  return sel;
}

// [2026-11-06] 动图：**直接播放 GIF 本身**（官方网页/官方客户端就是这么显示的）。
//   · 默认：<img src="原版 GIF">，所见即 GIF 文件，不存在切格/裁切/拉伸
//   · 调速：不用 sprite，改用浏览器解码 GIF 自己的帧（ImageDecoder），按倍数播。
//     画的是 GIF 的原始帧，所以也不可能裁切。浏览器不支持时只留 1x（退化为纯播放）。
function makeSpriteView(im) {
  const box = el('div', 'sprite-box');
  const frameBox = el('div', 'sprite-frame');

  const gifImg = el('img', 'gen');
  gifImg.src = im.url;
  gifImg.alt = '动图';
  frameBox.appendChild(gifImg);

  const baseMs = Math.max(20, Number((im.animation && im.animation.frame_duration_ms) || 120));
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  let canvas = null, ctx = null, frames = null;   // frames: ImageBitmap[]，来自 GIF 自身
  let timer = null, idx = 0, speed = 1, playing = true, decoding = false, decodeFailed = false;

  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  const drawFrame = () => {
    if (!ctx || !frames || !frames.length) return;
    const bmp = frames[idx % frames.length];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // GIF 帧可能带透明区：先铺白，避免暗色卡片上出现黑边
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // 帧尺寸与画布一致（都来自同一个 GIF），直接 1:1 画，不缩放 → 不裁切
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    idx = (idx + 1) % frames.length;
  };
  const play = () => {
    stopTimer();
    if (!playing || !frames || !frames.length) return;
    timer = setInterval(drawFrame, Math.max(20, Math.round(baseMs / speed)));
  };

  /** 用 ImageDecoder 把 GIF 自己的帧解出来（不支持就返回 false，速度条退化为只有 1x） */
  const ensureFrames = async () => {
    if (frames) return true;
    if (decodeFailed || decoding) return false;
    if (typeof window.ImageDecoder !== 'function') { decodeFailed = true; return false; }
    decoding = true;
    try {
      const resp = await fetch(im.url);
      const data = await resp.arrayBuffer();
      const dec = new window.ImageDecoder({ data, type: 'image/gif' });
      if (dec.tracks && dec.tracks.ready) await dec.tracks.ready;   // ← 关键：不等就是空 track
      const track = dec.tracks && dec.tracks.selectedTrack;
      const n = track ? Number(track.frameCount) || 0 : 0;
      const out = [];
      for (let i = 0; i < n; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        out.push(image);
      }
      frames = out.length ? out : null;
      if (!frames) note('这个 GIF 解不出帧，已按原速播放');
      return !!frames;
    } catch (e) {
      decodeFailed = true;
      return false;
    } finally {
      decoding = false;
    }
  };

  const showGif = () => {
    stopTimer();
    playing = false;
    idx = 0;
    if (frameBox.firstChild !== gifImg) frameBox.replaceChildren(gifImg);
  };

  const note = (txt) => {
    let n = box.querySelector('.sprite-note');
    if (!n) { n = el('div', 'sprite-note'); box.appendChild(n); }
    n.textContent = txt;
  };

  const showCanvas = async (v) => {
    const ok = await ensureFrames();
    if (!ok) {                       // 解不了帧就老实播原版 GIF，并把按钮撤掉，不留"点了没反应"
      showGif();
      bar.style.display = 'none';
      note('当前浏览器不支持帧解码调速，已按原速播放 GIF');
      return;
    }
    note('');
    if (!canvas) {
      canvas = el('canvas', 'gen sprite-canvas');
      canvas.width = Math.max(1, Math.round(im.w || 1));
      canvas.height = Math.max(1, Math.round(im.h || 1));
      canvas.style.width = 'auto';
      canvas.style.height = 'auto';
      canvas.style.maxWidth = '100%';
      canvas.style.maxHeight = 'min(64vh, 620px)';
      ctx = canvas.getContext('2d');
    }
    speed = v;
    playing = true;
    idx = 0;
    if (frameBox.firstChild !== canvas) frameBox.replaceChildren(canvas);
    drawFrame();
    play();
  };

  const bar = el('div', 'speed-bar');
  SPEEDS.forEach((v) => {
    const b = el('button', 'speed-btn' + (v === 1 ? ' on' : ''), v + 'x');
    b.type = 'button';
    b.title = v === 1 ? '原速（播放原版 GIF）' : `播放速度 ${v}x`;
    b.addEventListener('click', async () => {
      for (const x of bar.querySelectorAll('.speed-btn')) x.classList.remove('on');
      b.classList.add('on');
      if (v === 1) showGif(); else await showCanvas(v);
    });
    bar.appendChild(b);
  });

  const ctrl = el('div', 'anim-bar');
  const tog = el('button', 'speed-btn', '暂停');
  tog.type = 'button';
  tog.addEventListener('click', async () => {
    if (frameBox.firstChild === gifImg) {
      await showCanvas(speed);      // GIF 没有原生暂停 API：切到逐帧后定格
      playing = false;
      stopTimer();
      tog.textContent = '播放';
      return;
    }
    playing = !playing;
    tog.textContent = playing ? '暂停' : '播放';
    if (playing) play(); else stopTimer();
  });
  ctrl.appendChild(bar);
  ctrl.appendChild(tog);

  box.appendChild(frameBox);
  box.appendChild(ctrl);
  return box;
}

function assistantCard(m) {
  const row = el('div', 'msg');
  const card = el('div', 'card');
  if (m.text) card.appendChild(el('div', 'caption', m.text));
  for (const im of m.images || []) {
    const wrap = el('div', 'img-wrap');
    // 【2026-11-06】动图判定只看 mime/animation：不再依赖 sprite（服务端已不下载九宫格）
    const isAnim = im.mime === 'image/gif' || !!(im.animation && im.animation.frame_count);
    if (isAnim) {
      wrap.appendChild(makeSpriteView(im));
      const cv = wrap.querySelector('canvas');
      if (cv) cv.addEventListener('click', () => openLightbox(im.url, `${im.w} × ${im.h} · 动图 ${im.animation.frame_count} 帧 · ${(im.bytes / 1024 / 1024).toFixed(2)} MB`));
    } else {
      const img = el('img', 'gen');
      img.src = im.url; img.alt = m.text || '生成结果'; img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(im.url, `${im.w} × ${im.h} · ${(im.bytes / 1024 / 1024).toFixed(2)} MB`));
      wrap.appendChild(img);
    }
    // 每张输出图自己带一个「作为参考图」标签 —— 不用去输入区找按钮，也不用先下载再上传
    const tag = el('button', 'img-tag', '作为参考图');
    tag.dataset.src = im.url;
    tag.type = 'button';
    tag.title = '把这张图放进参考图托盘（再点一次收回），然后写清楚要改哪里';
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleRefFromUrl(im.url).catch((err) => toast('加参考图失败：' + err.message, true));
    });
    wrap.appendChild(tag);
    card.appendChild(wrap);

    const meta = el('div', 'meta');
    if (im.w && im.h) meta.appendChild(el('span', null, `${im.w} × ${im.h}`));
    if (im.bytes) meta.appendChild(el('span', null, (im.bytes / 1024 / 1024).toFixed(2) + ' MB'));
    if (m.meta?.elapsed) meta.appendChild(el('span', null, `耗时 ${m.meta.elapsed.toFixed(1)}s`));
    if (m.meta?.model) meta.appendChild(el('span', null, m.meta.model));
    if (m.meta?.effort && m.meta.effort !== '(默认)') meta.appendChild(el('span', null, `推理 ${m.meta.effort}`));
    // 【2026-11-06】降级提示：这张图不是网页管线出的（可能是静态 PNG / 只出一张）
    if (m.meta?.degraded) {
      const d = el('span', null, '备用通道');
      d.style.color = '#e8a33d';
      d.title = m.meta.degradedReason || '网页管线失败，走了备用通道';
      meta.appendChild(d);
    }
    meta.appendChild(el('span', 'spacer'));
    const dl = el('button', 'act', '下载');
    dl.addEventListener('click', () => download(im.url, `MSSK-${Date.now()}${im.mime === 'image/gif' ? '.gif' : '.png'}`));
    meta.appendChild(dl);
    meta.appendChild(exportControl(im));
    card.appendChild(meta);
  }
  row.appendChild(card);
  return row;
}

/** 图片预览（灯箱）：默认"适应屏幕"整张可见，可切到 1:1 原尺寸，也能直接下载原图 */
let lbUrl = null;
function openLightbox(url, info = '') {
  lbUrl = url;
  $('#lightboxImg').src = url;
  $('#lbStage').classList.remove('actual');
  $('#lbZoom').textContent = '按原尺寸看';
  $('#lbInfo').textContent = info;
  $('#lightbox').hidden = false;
}
function closeLightbox() { $('#lightbox').hidden = true; }

$('#lbZoom').addEventListener('click', () => {
  const st = $('#lbStage');
  st.classList.toggle('actual');
  const on = st.classList.contains('actual');
  $('#lbZoom').textContent = on ? '适应屏幕' : '按原尺寸看';
  if (on) st.scrollTo({ top: 0, left: (st.scrollWidth - st.clientWidth) / 2 });
});
$('#lightboxImg').addEventListener('click', () => $('#lbZoom').click());
$('#lbClose').addEventListener('click', closeLightbox);
$('#lbDownload').addEventListener('click', () => { if (lbUrl) download(lbUrl, `MSSK-${Date.now()}.png`); });
$('#lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox' || e.target.id === 'lbStage') closeLightbox();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

async function download(url, name) {
  // 下载永远拿原始 PNG：页面显示用的是 WebP（约 1/6 体积），这里加 raw=1 取原图
  const rawUrl = url + (url.includes('?') ? '&' : '?') + 'raw=1';
  const r = await fetch(rawUrl, { credentials: 'same-origin' });
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const scrollDown = () => { const s = $('#stream'); s.scrollTop = s.scrollHeight; };

// ------------------------------------------------------------------ 进度卡片
function progressCard(startedAt) {
  const row = el('div', 'msg');
  const card = el('div', 'card progress');
  const top = el('div', 'progress-top');
  const spin = el('div', 'spinner');
  top.appendChild(spin);
  const label = el('div', 'progress-label', '正在提交请求');
  top.appendChild(label);
  const elapsed = el('div', 'progress-elapsed', '0.0s');
  top.appendChild(elapsed);
  card.appendChild(top);
  const steps = el('div', 'steps');
  const names = el('div', 'step-names');
  const bars = STEPS.map(() => { const b = el('div', 'step'); steps.appendChild(b); return b; });
  const labels = STEPS.map((s) => { const n = el('span', null, s.label); names.appendChild(n); return n; });
  card.appendChild(steps);
  card.appendChild(names);
  const detail = el('div', 'err-detail'); detail.hidden = true;
  card.appendChild(detail);
  row.appendChild(card);
  let furthest = -1;
  const setStage = (stage, text) => {
    // 「重试」是唯一允许把进度条往回拨的档：上游这次空手而归，站点换了个全新请求再打，
    // 进度条必须退回到"已连接上游"，否则会一直卡在"绘制中"，看起来像死了。
    if (stage === 'retrying') {
      furthest = 1;
      if (text) label.textContent = text;
      bars.forEach((b, i) => { b.className = 'step' + (i < 1 ? ' done' : i === 1 ? ' now' : ''); });
      labels.forEach((n, i) => n.className = i < 1 ? 'on' : '');
      return;
    }
    // 阶段只许前进不许后退（上游事件顺序不保证，别让进度条往回跳）
    let idx;
    if (stage === 'connecting') idx = 0;
    else if (stage === 'connected' || stage === 'thinking') idx = 1;
    else if (stage === 'drawing' || stage === 'generating') idx = 2;
    else if (stage === 'finalizing') idx = 3;
    else if (stage === 'completed') idx = STEPS.length;
    else idx = furthest;
    if (idx < furthest) return;
    furthest = idx;
    if (text) label.textContent = text;
    bars.forEach((b, i) => { b.className = 'step' + (i < idx ? ' done' : i === idx ? ' now' : ''); });
    labels.forEach((n, i) => n.className = i < idx ? 'on' : '');
  };
  const t0 = Number(startedAt) || Date.now();
  const timer = setInterval(() => { elapsed.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's'; }, 100);
  return {
    row, card, setStage,
    error(msg, detailText) {
      clearInterval(timer);
      card.classList.add('err-box');
      spin.remove();
      // ⚠️ 必须把"当前阶段"标记清掉：.step.now::after 是无限扫光动画，
      //    不清掉的话出错后进度条还在动 → 用户以为"还在生成、却没法停止"。
      bars.forEach((b) => b.classList.remove('now'));
      label.className = 'err-title';
      label.textContent = '✗ ' + msg;
      // ⚠️ 参数名不能叫 detail —— 会遮蔽上面的 detail 元素，导致 detail.hidden 作用在字符串上抛异常
      if (detailText) { detail.hidden = false; detail.textContent = detailText; }
    },
    done() { clearInterval(timer); },
    elapsedMs: () => Date.now() - t0,
  };
}

/** 把当前输入框文字和参考图托盘存进"这个对话"，切走/切回来各归各的 */
function saveConvDraft() {
  if (!state.conv) return;
  const t = $('#prompt') ? $('#prompt').value : '';
  state.drafts.set(state.conv.id, t);
  state.refTrays.set(state.conv.id, state.refs.slice());
}

function loadConvDraft(convId) {
  state.refs = (state.refTrays.get(convId) || []).slice();
  const p = $('#prompt');
  if (p) { p.value = state.drafts.get(convId) || ''; autoGrow(); }
  renderRefs();
}

/**
 * 【2026-11-06】把"当前对话的生成状态"一次性刷到界面：
 *   按钮（生成/停止）、底部提示语、进度卡是否在屏幕上。
 * 任何切对话/建对话/流开始/流结束都要调它，否则会出现"切到 B 了按钮还显示停止"。
 */
function refreshConvUI() {
  const btn = $('#btnSend');
  const rec = state.conv ? state.streams.get(state.conv.id) : null;
  if (btn) {
    btn.disabled = false;
    btn.textContent = rec ? '停止' : '生成';
    btn.classList.toggle('btn-stop', !!rec);
  }
  state.canStop = !!rec;

  const hint = $('#hint');
  if (hint) {
    if (rec) {
      const s0 = Math.round((Date.now() - rec.startedAt) / 1000);
      hint.textContent = `这个对话正在生成（已 ${s0}s）；可以切到别的对话，它会在后台继续。`;
    } else if (/正在生成|正在停止|这个对话正在生成/.test(hint.textContent || '')) {
      hint.textContent = '';
    }
  }

  // 当前对话在生成、但屏幕上没有进度卡（比如刚切回来）→ 补一张，并接着原来的秒数
  if (rec) {
    const attached = rec.prog && rec.prog.row && rec.prog.row.isConnected;
    if (!attached) {
      const prog = progressCard(rec.startedAt);
      if (rec.stage) prog.setStage(rec.stage, rec.label || '');
      rec.prog = prog;
      const stream = $('#stream');
      if (stream) { stream.appendChild(prog.row); scrollDown(); }
    }
  }
}

/**
 * 【2026-11-06】刷新页面后，服务端可能还在画（断线不再中止任务）。
 * 这里把它当成一条"远程流"登记进 state.streams，界面上照样有进度卡/停止按钮，
 * 并每 3 秒查一次会话，画完了自动把图接上。
 */
const remoteTimers = new Map();

function attachRemoteJob(convId, since, stage) {
  if (state.streams.has(convId) && !state.streams.get(convId).detached) return;   // 本地正在跑，别覆盖
  const rec = {
    convId, detached: true, ac: null, mine: null,
    startedAt: Number(since) || Date.now(), stage: stage || '', label: '',
    prog: progressCard(Number(since) || Date.now()),
  };
  if (stage) rec.prog.setStage(stage, '');
  state.streams.set(convId, rec);
  refreshConvUI();

  if (remoteTimers.has(convId)) return;
  const timer = setInterval(async () => {
    let c = null;
    try { c = await api(`/api/conversations/${convId}`); } catch { return; }
    if (c.running) {
      const r = state.streams.get(convId);
      if (r && c.runningStage && r.stage !== c.runningStage) {
        r.stage = c.runningStage;
        r.prog.setStage(c.runningStage, '');
      }
      return;
    }
    // 跑完了：收尾
    clearInterval(timer); remoteTimers.delete(convId);
    const rec2 = state.streams.get(convId);
    state.streams.delete(convId);
    try { rec2.prog.row.remove(); } catch { /* 已移除 */ }
    if (state.conv && state.conv.id === convId) {
      state.conv = c;
      renderConversation();
      toast('后台任务完成，图已经出来了');
    } else if ((c.messages || []).length) {
      state.unread.add(convId);
      toast(`「${c.title || '对话'}」的图出来了，点左侧查看`);
    }
    await loadConversations();
    renderConvList();
    refreshConvUI();
    updateDocTitle();
  }, 3000);
  remoteTimers.set(convId, timer);
}

/** 浏览器标签标题：后台还有几个任务在跑、几个对话有新图没看 */
function updateDocTitle() {
  const base = 'MSSK 生图';
  const running = state.streams.size;
  const unread = state.unread.size;
  const parts = [];
  if (running) parts.push(`${running} 个任务进行中`);
  if (unread) parts.push(`${unread} 个新结果`);
  document.title = parts.length ? `(${parts.join(' · ')}) ${base}` : base;
}

/** 按钮状态跟着"当前对话有没有在生成"走（不是全局一个布尔） */
function syncSendButton() {
  const btn = $('#btnSend');
  if (!btn) return;
  const rec = state.conv && state.streams.get(state.conv.id);
  btn.disabled = false;
  btn.textContent = rec ? '停止' : '生成';
  btn.classList.toggle('btn-stop', !!rec);
  state.canStop = !!rec;
}

// ------------------------------------------------------------------ 生成

async function generate(job) {
  const fromQueue = !!job;
  const prompt = (job ? job.prompt : ($('#prompt').value || '')).trim();
  if (!fromQueue && !prompt && !state.refs.length) { toast('写点描述，或者加一张参考图', true); return; }
  if (!state.conv) await newConversation();
  const convId = state.conv.id;                 // 【2026-11-06】这次生成属于哪个对话，钉死
  const refs = job ? (job.refs || []) : state.refs.slice();

  // 【2026-11-06】刷新后极端时序：服务端还在画，但前端还没 attach 上 → 先接上，绝不再发一个请求
  if (!state.streams.has(convId) && state.conv && state.conv.running) {
    attachRemoteJob(convId, state.conv.runningSince, state.conv.runningStage);
    toast('这个对话已经在上游画着了，已恢复进度，没有重复提交');
    return;
  }

  // 同一个对话已经在画：不拒绝，改成排队（真人就是"先排上，我切去干别的"）
  if (state.streams.has(convId)) {
    const q = state.queues.get(convId) || [];
    q.push({ prompt, refs });
    state.queues.set(convId, q);
    if (!fromQueue) { $('#prompt').value = ''; autoGrow(); state.drafts.set(convId, ''); }
    toast(`已排队（这个对话前面还有 ${q.length} 个），画完自动开始`);
    return;
  }

  state.stoppedByUser = false;
  const ac = new AbortController();
  if (!fromQueue) state.drafts.set(convId, '');
  // 生成期间按钮变成"停止"（原来这里是禁用按钮，导致卡住时完全没法中止）
  $('#btnSend').disabled = false;
  $('#btnSend').textContent = '停止';
  $('#btnSend').classList.add('btn-stop');
  $('#hint').textContent = refs.length
    ? `带着 ${refs.length} 张参考图生成中，约 45～80 秒；可以切到别的对话继续干活，这个在后台跑。`
    : '正在生成，约 40～65 秒；可以切到别的对话继续干活，这个在后台跑。';

  // 乐观渲染：先把自己这句话（和参考图）放上去
  const empty = $('#stream .empty'); if (empty) empty.remove();
  const mine = userBubble({
    text: prompt || '（按参考图生成）',
    ratio: ratioLabelOf(state.ratio) + (state.transparent ? ' ｜ 透明底' : ''),
    refs: refs.map((r) => ({ dataUrl: r.dataUrl })),
  });
  $('#stream').appendChild(mine);
  const prog = progressCard();
  // 只有当前正在看这个对话时才插进度卡；否则只记录（切回去能看到）
  if (state.conv && state.conv.id === convId) { $('#stream').appendChild(prog.row); scrollDown(); }
  const rec = { convId, ac, prog, mine, prompt, startedAt: Date.now(), stage: '', label: '' };
  state.streams.set(convId, rec);
  refreshConvUI();
  // 每秒刷新一次"已用秒数"和按钮状态（切到别的对话时，提示语也不会停在旧内容）
  const ticker = setInterval(() => {
    if (!state.streams.has(convId)) { clearInterval(ticker); return; }
    refreshConvUI();
  }, 1000);
  rec.ticker = ticker;

  try {
    const firstDim = refs.find((r) => r.w && r.h);
    const r = await fetch(`/api/conversations/${convId}/generate`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt, ratio: state.ratio,
        transparent: state.transparent,
        refSize: state.ratio === 'auto' && firstDim ? { w: firstDim.w, h: firstDim.h } : null,
        model: state.model, effort: state.effort,
        imageModel: state.pipeline === 'codex' ? 'codex-gpt-image-2' : 'gpt-image-2',
        web_mode: state.webMode,
        // 网页管线：把（模型版本 + 推理档）换成上游真正认的 slug + thinking_effort
        web_model: (state.presetMap[state.model] || {})[state.effort]?.slug || '',
        web_effort: (state.presetMap[state.model] || {})[state.effort]?.effort || '',
        refs: refs.map((r) => r.dataUrl),
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      const msg = d.error || `HTTP ${r.status}`;
      mine.remove();
      if (r.status === 429) {
        // 并发/间隔限制：这是"没排上"，不是出错。给一张明确的卡片，
        // 而不是一闪而过的 toast（以前用户只会觉得"点了没反应"）。
        showErrorCard(rec.prog, {
          message: '暂时没排上（前面还有图在画）',
          detail: msg,
          hint: '不用反复点。等前面那张画完，再点「重试」就行；也可以过一会儿再试。',
        }, prompt);
        $('#hint').textContent = '前面还有图在画，等一会儿再点「重试」';
      } else if (r.status === 401) {
        showErrorCard(rec.prog, { message: '登录已失效', detail: '请刷新页面重新登录。' }, prompt);
        $('#hint').textContent = '登录已失效，刷新页面重新登录';
      } else {
        showErrorCard(rec.prog, { message: '请求被拒绝：' + msg, detail: `HTTP ${r.status}` }, prompt);
        $('#hint').textContent = '';
      }
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finished = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let evt; try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        if (evt.type === 'stage') {
          rec.stage = evt.stage; rec.label = evt.label || '';
          rec.prog.setStage(evt.stage, evt.label);
          if (evt.stage === 'generating') $('#hint').textContent = '模型正在画，这一步最久（通常 20～50 秒）…';
        } else if (evt.type === 'error') {
          rec.mine.remove();                   // 服务端已经把这条失败的消息撤了
          rec.prog.row.remove();
          if (state.conv && state.conv.id === convId) showErrorCard(rec.prog, evt, prompt);
          else toast(`「另一个对话」生成失败：${String(evt.message || '').slice(0, 40)}`, true);
          finished = true;
        } else if (evt.type === 'done') {
          rec.prog.done();
          finished = true;
          let updated = null;
          try { updated = await api(`/api/conversations/${convId}`); } catch { /* 拉不到就只提示 */ }
          const watching = state.conv && state.conv.id === convId;
          rec.prog.row.remove();
          if (watching && updated) {
            state.conv = updated;
            $('#convTitle').textContent = updated.title || state.conv.title;
            renderConversation();               // 整屏按服务端数据重建，避免重复/错位
            $('#hint').textContent = `✅ 完成，用时 ${evt.elapsed.toFixed(1)} 秒`;
          } else {
            // 【2026-11-06】用户已经切到别的对话：绝不把图贴到当前屏幕
            const n = (evt.message && evt.message.images && evt.message.images.length) || 1;
            state.unread.add(convId);
            toast(`「${(updated && updated.title) || '另一个对话'}」已出 ${n} 张，点左侧对话查看`);
          }
          await loadConversations();
          renderConvList();
        }
      }
    }
    if (!finished) {
      // 流干净地结束了，但既没有 done 也没有 error（上游/中间设备把连接掐了）
      mine.remove();
      showErrorCard(rec.prog, {
        message: '连接中断',
        detail: '连接在出图前就断了 —— 可能是服务器重启、网络抖动，或上游把连接掐了。可以重试。',
      }, prompt);
    }
  } catch (e) {
    // ⚠️ 以前这里只弹个 toast，进度卡片就永远停在"生成中"了 —— 看起来就是"卡住停不下来"。
    //    现在无论哪种失败，卡片都必须收敛到终态。
    mine.remove();
    if (e.name === 'AbortError' || state.stoppedByUser) {
      rec.prog.error('已停止', '这次生成已中止：上游请求也一并断开了，不会再继续占用额度。');
      $('#hint').textContent = '已停止（提示词已放回输入框，可直接再生成）';
    } else {
      showErrorCard(rec.prog, {
        message: '连接中断：' + (e.message || '未知错误'),
        detail: '与服务器的连接断了（可能服务器重启或网络抖动）。可以重试。',
      }, prompt);
      $('#hint').textContent = '';
    }
  } finally {
    try { clearInterval(rec.ticker); } catch { /* 没起过 */ }
    state.streams.delete(convId);
    state.stoppedByUser = false;
    refreshConvUI();
    renderConvList();
    updateDocTitle();
    // 同一个对话里排着的下一个任务：用户还看着它就自动接着跑（不打断、不丢）
    const q = state.queues.get(convId) || [];
    if (q.length && state.conv && state.conv.id === convId) {
      const next = q.shift();
      state.queues.set(convId, q);
      toast('接着跑排队中的下一个任务');
      generate(next);
    }
  }
}

/** 点「停止」：中断这次生成（服务端 monitor 到连接断开后会同时断掉上游请求） */
async function stopGeneration() {
  const convId = state.conv && state.conv.id;
  const rec = convId && state.streams.get(convId);
  if (!rec) return;
  state.stoppedByUser = true;
  $('#hint').textContent = '正在停止…';
  // 【2026-11-06】断线不再中止任务，所以"停止"必须显式告诉服务端
  try {
    await fetch(`/api/conversations/${convId}/stop`, { method: 'POST', credentials: 'same-origin' });
  } catch { /* 服务端已经结束 */ }
  if (rec.detached) {
    state.streams.delete(convId);
    try { rec.prog.row.remove(); } catch { /* 已移除 */ }
    refreshConvUI();
    return;
  }
  try { rec.ac.abort(); } catch { /* 已经结束了 */ }
}


const ratioLabelOf = (r) => (r === 'auto' ? '适应原图' : (r || '默认'));

/**
 * 失败时给一张"能照做"的卡片：
 *   · 说清是谁的问题（上游过载 / 我们中转站 CPU / 凭据被踢 …）
 *   · 给一个重试按钮；**上游过载时带 15 秒倒计时**（上游回的是 NO_MORE_RETRY，猛点会更糟）
 *   · 提示词放回输入框，不用重打
 */
function showErrorCard(prog, evt, prompt) {
  prog.error(evt.message, evt.detail);
  if (evt.hint) prog.card.appendChild(el('div', 'err-hint', evt.hint));

  const row = el('div', 'err-actions');
  const retry = el('button', 'act', '重试');
  retry.addEventListener('click', () => { prog.row.remove(); generate(); });
  row.appendChild(retry);
  prog.card.appendChild(row);

  if (evt.code === 'upstream_overloaded') {
    let left = 15;
    retry.disabled = true;
    retry.textContent = `重试（${left}s）`;
    const t = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(t); retry.disabled = false; retry.textContent = '重试'; return; }
      retry.textContent = `重试（${left}s）`;
    }, 1000);
  }

  if (!$('#prompt').value.trim()) { $('#prompt').value = prompt; autoGrow(); }
  toast(evt.code === 'upstream_overloaded' ? '上游过载（不是你这边的问题），等十几秒再点重试' : '生成失败：' + evt.message, true);
  scrollDown();
}

// ------------------------------------------------------------------ 参考图托盘
function renderRefs() {
  const tray = $('#refTray');
  const list = $('#refList');
  tray.hidden = state.refs.length === 0;
  list.innerHTML = '';
  state.refs.forEach((r, i) => {
    const item = el('div', 'ref-item');
    item.title = r.name;
    const img = el('img'); img.src = r.dataUrl; img.alt = r.name;
    img.addEventListener('click', () => openLightbox(r.dataUrl, '参考图 · 点「按原尺寸看」可 1:1 查看'));
    item.appendChild(img);
    item.appendChild(el('span', 'ref-no', String(i + 1)));
    const x = el('button', 'ref-x', '×');
    x.title = '移除';
    x.addEventListener('click', () => { state.refs.splice(i, 1); renderRefs(); });
    item.appendChild(x);
    list.appendChild(item);
  });
  const ratioNote = state.refs.length
    ? (state.ratio === 'auto'
        ? '｜画布比例：沿用参考图1'
        : state.ratio
          ? `｜画布比例：按 ${state.ratio} 重新构图（不沿用原图比例）`
          : '｜画布比例：由模型决定')
    : '';
  const alphaNote = state.transparent ? '｜透明底（要求已写进提示词）' : '';
  $('#refHint').textContent = state.refs.length
    ? `会按顺序作为「参考图1..${state.refs.length}」发给模型${ratioNote}`
    : alphaNote;
  updateRatioAuto();
  syncRefTags();   // 图片上的标签跟着托盘状态一起更新
}

/** 从本地文件加入托盘（选文件 / 拖拽 / 粘贴 都走这里） */
function addRefFiles(files) {
  const list = [...files];
  if (!list.length) return;
  for (const f of list) {
    if (state.refs.length >= REF_MAX) { toast(`最多 ${REF_MAX} 张参考图`, true); break; }
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast(`不支持 ${f.type || f.name}（只收 PNG/JPEG/WebP）`, true); continue; }
    if (f.size > REF_MAX_MB * 1024 * 1024) { toast(`${f.name} 太大（单张上限 ${REF_MAX_MB}MB）`, true); continue; }
    const reader = new FileReader();
    reader.onload = async () => {
      const dim = await measureImage(reader.result);
      state.refs.push({ id: Math.random().toString(36).slice(2), name: f.name, dataUrl: reader.result, bytes: f.size, ...(dim || {}) });
      renderRefs();
    };
    reader.onerror = () => toast(`读不了 ${f.name}`, true);
    reader.readAsDataURL(f);
  }
}

/** 量一张图的真实像素尺寸（"适应原图"比例要用） */
function measureImage(dataUrl) {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => res(null);
    i.src = dataUrl;
  });
}

/** 「适应原图」只有在托盘里有一张量得出尺寸的图时才可用 */
function updateRatioAuto() {
  const btn = $('#ratioAuto');
  if (!btn) return;
  const ok = state.refs.some((r) => r.w && r.h);
  btn.disabled = !ok;
  if (!ok && state.ratio === 'auto') {
    state.ratio = '';
    [...$('#ratioGroup').querySelectorAll('.chip')].forEach((c) => c.classList.toggle('active', c.dataset.ratio === ''));
  }
}

/** 把站内已有图片变成参考图（图片上的「作为参考图」标签走这里）
 *  再点一次 = 收回（标签是开关，避免同一张被重复堆进托盘） */
async function toggleRefFromUrl(url) {
  const idx = state.refs.findIndex((r) => r.srcUrl === url);
  if (idx >= 0) {
    state.refs.splice(idx, 1);
    renderRefs();
    toast('已从参考图里移出');
    return;
  }
  let autoSwitched = false;
  if (state.refs.length >= REF_MAX) { toast(`最多 ${REF_MAX} 张参考图`, true); return; }
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  if (blob.size > REF_MAX_MB * 1024 * 1024) throw new Error(`超过 ${REF_MAX_MB}MB`);
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败'));
    fr.readAsDataURL(blob);
  });
  const dim = await measureImage(dataUrl);
  state.refs.push({ id: Math.random().toString(36).slice(2), name: '已生成的图片', dataUrl, bytes: blob.size, srcUrl: url, ...(dim || {}) });
  // 这是"改这张图"的意图 —— 比例自动切到「适应原图」。
  // ⚠️ 但**只在用户没自己挑过比例时**才自动切：
  //    之前无条件切换，会静默盖掉用户已经选好的比例，
  //    表现就是"我明明选了 16:9，出来的还是参考图的比例"。
  if (dim && !state.ratioTouched && state.refs.length === 1) {
    state.ratio = 'auto';
    [...$('#ratioGroup').querySelectorAll('.chip')].forEach((c) => c.classList.toggle('active', c.dataset.ratio === 'auto'));
    autoSwitched = true;
  }
  renderRefs();
  toast(
    autoSwitched
      ? `已作为参考图 1 放进托盘，比例自动切到「适应原图 ${dim.w}×${dim.h}」—— 写清楚要改哪里，再点生成`
      : `已作为参考图 ${state.refs.length} 放进托盘 —— 写清楚要改哪里，再点生成`
  );
  focusComposer();
}

/** 光标跳到输入框，顺手给个例子（只改 placeholder，不动你已经写的字） */
function focusComposer() {
  const t = $('#prompt');
  if (!t.value.trim()) t.placeholder = '写清楚要怎么改，例如：把背景换成夜晚，主角和构图保持不变';
  t.focus();
}

/** 让每张图上的标签跟着托盘状态变（已加入的显示"✓ 已在参考图"） */
function syncRefTags() {
  for (const t of document.querySelectorAll('.img-tag')) {
    const on = state.refs.some((r) => r.srcUrl === t.dataset.src);
    t.classList.toggle('on', on);
    t.textContent = on ? '✓ 已在参考图' : '作为参考图';
  }
}

$('#btnRef').addEventListener('click', () => $('#refInput').click());
$('#refInput').addEventListener('change', (e) => { addRefFiles(e.target.files); e.target.value = ''; });
$('#btnClearRefs').addEventListener('click', () => { state.refs = []; renderRefs(); });

// 拖进来
const composerBox = $('#composerBox');
['dragenter', 'dragover'].forEach((t) => composerBox.addEventListener(t, (e) => {
  e.preventDefault(); composerBox.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((t) => composerBox.addEventListener(t, (e) => {
  e.preventDefault(); composerBox.classList.remove('dragover');
}));
composerBox.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) addRefFiles(e.dataTransfer.files);
});
// Ctrl+V 粘贴图片
$('#prompt').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addRefFiles(files); }
});

// ------------------------------------------------------------------ 交互
$('#btnNew').addEventListener('click', async () => {
  // 【2026-11-06】别的对话在生成也能新建：各对话的流是独立的

  await newConversation();
  $('#prompt').focus();
});
$('#btnSend').addEventListener('click', () => {
  // 生成中这颗按钮就是「停止」
  if (state.conv && state.streams.has(state.conv.id)) { stopGeneration(); return; }
  generate();
});
$('#btnMenu')?.addEventListener('click', () => $('.sidebar').classList.toggle('open'));

$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); generate(); }
});
function autoGrow() { const t = $('#prompt'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 180) + 'px'; }
$('#prompt').addEventListener('input', autoGrow);

$('#ratioGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip'); if (!btn) return;
  [...$('#ratioGroup').querySelectorAll('.chip')].forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  state.ratio = btn.dataset.ratio;
  state.ratioTouched = true;   // 用户亲手选过，之后不再被自动覆盖
  renderRefs();                // 让托盘提示同步说出"这一轮会按什么比例"
});

/**
 * 管线不同 → 实际使用的模型不同，这里把它显式写出来：
 *   web   : gpt-image-2        → 上游按账号 default_model_slug 自动选（当前是 gpt-6 这一类）
 *   codex : codex-gpt-image-2 → 固定走订阅 OAuth 的原生端点
 * 顺便把"文本模型/推理档位"标注成对生图无效（它们只影响老路 /responses）。
 */
function renderPipelineModel() {
  const el = document.getElementById('pipelineModel');
  if (el) {
    el.textContent = state.pipeline === 'codex'
      ? '→ codex-gpt-image-2（订阅原生，模型固定）'
      : '→ gpt-image-2（网页管线，上游自动选模型）';
  }
  const ms = document.getElementById('modelSelect');
  if (ms) ms.title = '文本模型：只影响老路 /responses；生图管线用的是上面显示的模型';
}
// 生图管线：网页优先（gpt-image-2）/ Codex 原生（codex-gpt-image-2）
// 两个 slug 在 shim 侧走不同分支：gpt-image-2 = 网页管线优先+原生兜底；codex-gpt-image-2 = 只走原生。
$('#pipelineGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip'); if (!btn) return;
  [...$('#pipelineGroup').querySelectorAll('.chip')].forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  state.pipeline = btn.dataset.pipeline;
  savePrefs();
  loadModels();          // 管线变了 → 可选模型/档位跟着换（web: 网页模型；codex: codex-gpt-image-2）
  renderPipelineModel();
  toast(state.pipeline === 'codex'
    ? 'Codex 原生：只走订阅端点（快，但判定更严、不回退）'
    : '网页优先：先走网页管线，被拒再回退原生（慢一点、通过率更高）');
});

// 网页模式（聊天/工作）：只对网页管线有意义，实测聊天模式通过率明显更高
$('#modeGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip'); if (!btn) return;
  [...$('#modeGroup').querySelectorAll('.chip')].forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  state.webMode = btn.dataset.mode;
  savePrefs();
  loadModels();          // 聊天/工作 的模型表不一样 → 重新拉一份
  renderPipelineModel();
  toast(state.webMode === 'work' ? '网页模式：工作（通过率较低）' : '网页模式：聊天（推荐）');
});
// 透明底开关：**不是开关式 UI，而是可切换的 chip**（和比例那排一致）。
// 后端只把 "transparent background (preserve the alpha channel)" 折进提示词，
// 不往上游传 background 参数（实测传参数会被 400 拒掉，写提示词才有效）。
$('#btnAlpha').addEventListener('click', () => {
  state.transparent = !state.transparent;
  $('#btnAlpha').classList.toggle('active', state.transparent);
  toast(state.transparent ? '透明底：已开启（要求会写进提示词）' : '透明底：已关闭');
});

renderPipelineModel();
// ---------------------------------------------------------------- 版本轮询
// 服务端部署后 BUILD 会变 → 这里倒计时自动刷新，省得用户"不知道该不该刷"。
let loadedBuild = null;
let updateTimer = null;

function showUpdateBar(build = '', seconds = 8) {
  const bar = document.getElementById('updateBar');
  if (!bar || updateTimer) return;
  bar.hidden = false;
  let left = seconds;
  const txt = document.getElementById('updateText');
  const tick = () => {
    if (!txt) return;
    txt.textContent = `🔄 有新版本可用 · ${left} 秒后自动刷新…`;
  };
  tick();
  updateTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(updateTimer); location.reload(); return; }
    tick();
  }, 1000);
}

async function checkVersion() {
  try {
    const v = await api('/api/version');
    if (!v || !v.build) return;
    if (loadedBuild === null) { loadedBuild = v.build; return; }
    if (v.build !== loadedBuild) showUpdateBar(v.build);
  } catch { /* 网络抖动忽略 */ }
}

document.getElementById('updateNow')?.addEventListener('click', () => location.reload());
boot();
setInterval(checkVersion, 20000);
checkVersion();

