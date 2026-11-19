/**
 * 把上游 / 中转站的报错分类，好让界面给出"能照做"的提示。
 *
 * 两种过载必须分清（交接文档里的实测结论）：
 *   · server_is_overloaded   → **上游（OpenAI）** 过载：HTTP 200，但流里带 error 事件，
 *                              且 headers.x-retry-metadata = NO_MORE_RETRY（上游在说"别再重试了"）
 *   · system cpu overloaded  → **我们自己的中转站** CPU 打满（1 核），HTTP 503 直接被拒
 * 判断口诀：HTTP 200 但流里报错 = 上游；HTTP 503 直接被拒 = 我们的 CPU。
 */
/**
 * 【2026-10-16 新增】把上游给的英文/代号翻成人话（按类型）。
 *   上游的判定字段是英文代号：moderation_stage=output、categories=[sexual]…
 *   非技术同事看不懂，所以用户看到的是中文，原始代号丢到 detail 里给管理员排查。
 */
const STAGE_ZH = {
  input: '提示词/参考图阶段就被拦下',
  output: '图已经画好，只是被判掉',
};
const CATEGORY_ZH = {
  sexual: '性化/暴露',
  violence: '暴力',
  'self-harm': '自残',
  harassment: '骚扰',
  hate: '仇恨',
  minors: '未成年人相关',
  'sexual/minors': '未成年人性化',
};

/** 内容安全拒绝 → 一句中文（含可选的请求 ID） */
export function humanizeModeration({ stage, categories, requestId } = {}) {
  const s = STAGE_ZH[String(stage || '').toLowerCase()] || String(stage || '');
  const cat = String(categories || '')
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map((c) => CATEGORY_ZH[c.toLowerCase()] || c)
    .join('、');
  return [
    cat ? `图片被上游安全系统判定为「${cat}」内容，没有出图` : '图片被上游安全系统拒绝，没有出图',
    s ? `（${s}）` : '',
    requestId ? ` · 请求 ID：${requestId}` : '',
  ].filter(Boolean).join('');
}

/** 上游偶尔回英文原话（如 "I couldn't generate this image because …"）→ 给一句中文摘要 */
export function translateUpstream(text) {
  const t = String(text || '');
  if (!t) return '';
  const rules = [
    [/couldn'?t generate this image|unable to generate this image|was flagged by the image safety system|rejected by the image/i,
      '上游图像安全系统判定这张图/这条提示词不合规，没有生成'],
    [/server_is_overloaded|currently overloaded/i, '上游（OpenAI）正在过载'],
    [/system cpu overloaded/i, '我们中转站自己的 CPU 打满了'],
    [/token_revoked|invalidated oauth/i, '中转站的授权凭据被踢了'],
    [/no access to model/i, '这个令牌没有该模型的权限'],
  ];
  for (const [re, zh] of rules) if (re.test(t)) return zh;
  return '';
}

const RULES = [
  {
    // 【2026-10-16 新增】原生路（/v1/images/*）的内容安全拒绝是**结构化的**：
    //   网关会回 {code:"moderation_blocked", message:"…判定阶段=output，类别=sexual，请求ID=…"}
    //   判定发生在**图片渲染完成之后**（上游自报 moderation_stage=output）——
    //   也就是说"图真的画出来了，只是被判掉了"，跟提示词写得好不好关系不大。
    code: 'content_safety',
    re: /moderation_blocked|内容安全系统拒绝（原生端点）|判定阶段=/,
    hint: '这不是故障：图片已经渲染完成，被上游的图像安全系统判成了不允许的内容（多为"性化/暴露"类）。'
      + '两条路（原生端点 + 网页管线）都已经试过了，判定是随机的——再点一次仍有机会（实测约 1/3），但通常**换参考图**更快：'
      + '同一角色换一张穿得更保守的图，通过率明显更高。',
  },
  {
    // 【2026-10-16 新增】对话模型自己拒绝（老路 /v1/responses 特有）。
    //   线上日志实证：上游原话形如"抱歉，我无法基于这张参考图直接生成角色与新背景的合成画面…"，
    //   模型还会**提议替代方案**（例如"可以只生成不含人物的背景"），图像工具根本没被调用。
    //   ⚠️ 这类拒绝是**确定的**：重试一万次都一样 —— 只能换描述方式，或改用原生路。
    code: 'model_refusal',
    re: /抱歉[，,]\s*我(无法|不能)|我无法(直接)?(基于|按)这张|I (can'?t|cannot|am unable to)/i,
    hint: '这次是**对话模型自己拒绝**（不是内容安全系统）：它不愿意基于这张参考图做合成，还给了替代方案。'
      + '重试没有意义（同一段拒绝是确定的）。两个办法：① 换个说法（明确写"把参考图1的角色合成进新场景、保持人物不变"）；'
      + '② 走原生图像端点（GENERATE_PATH=native，当前默认）—— 那条路没有对话模型，这类拒绝会消失。',
  },
  {
    // 2026-10-15 新增：图片被**上游图像安全系统**拦掉时，上游不会回 error 事件，
    // 而是用一段普通文字回绝（"I couldn't generate this image because the request was
    // flagged by the image safety system for …"），网关侧统一加了「上游内容安全系统拒绝：」前缀。
    // 以前这条会被归成 upstream_error（无提示），用户只看到"上游没有返回图片数据"，完全不知道原因。
    code: 'content_refusal',
    re: /内容安全|安全系统|safety system|image safety|flagged by the image|rejected by the image/i,
    hint: '不是故障，是上游的图像安全系统把这个提示词/参考图判成了不允许的内容（常见触发：人物服装暴露或性化、真人肖像、暴力）。'
      + '⚠️ 注意：判定发生在出图之后、且是随机的（实测同一张图重试约 1/3 能过）——所以"再点一次"是有意义的，'
      + '但换一张更保守的参考图见效更快。',
  },
  {
    code: 'no_image_data',
    re: /没有返回图片数据|no image data/i,
    hint: '上游这次 HTTP 200 但流里没有图（实测是"成簇"发生：同一个请求上一次成功、这一次就空手而归）。站点已经自动重试过；还是失败就再点一次「重试」，通常第二次就出来了。',
  },
  {
    code: 'upstream_overloaded',
    re: /server_is_overloaded|currently overloaded/i,
    hint: '上游（OpenAI）过载，不是你或中转站的问题。上游明确回了 NO_MORE_RETRY —— 猛点重试会更糟，等 1～2 分钟再试。参考图会让请求更重，过载时更容易撞上。',
  },
  {
    code: 'relay_cpu',
    re: /system cpu overloaded/i,
    hint: '这是我们中转站自己的 CPU 打满了（1 核机器），和上游无关。等一会儿再试；如果经常发生，该升级到 2 核了。',
  },
  {
    code: 'token_revoked',
    re: /token_revoked|invalidated oauth/i,
    hint: '中转站凭据被踢了 —— 需要在 VPS 上重跑「重新播种凭据」脚本。',
  },
  {
    code: 'no_model_access',
    re: /no access to model/i,
    hint: '这个令牌没有该模型的权限，去 new-api 后台的令牌限制里把它加上。',
  },
  {
    code: 'bad_request',
    re: /Invalid value|Unsupported value|not supported/i,
    hint: '请求参数被上游拒绝（比如不支持的推理档位/工具参数）—— 降级到默认档位再试。',
  },
];

export function classifyError(msg = '') {
  for (const r of RULES) if (r.re.test(msg)) return { code: r.code, hint: r.hint };
  return { code: 'upstream_error', hint: '上游返回了没有归类的错误。可以原样重试一次；连续出现就把上面那段原始报错发给我。' };
}
