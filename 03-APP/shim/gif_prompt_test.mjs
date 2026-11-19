import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = 'https://chatgpt.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const CV = 'prod-a194cd50d4416d3c0b47c740f206b12ce60f5887';
const CB = '6708908';
const cookie = fs.readFileSync('/app/cookies/a.txt', 'utf8').trim();
const did = (cookie.match(/oai-did=([0-9a-f-]+)/) || [])[1] || crypto.randomUUID();

function H(extra = {}, path = '') {
  const h = {
    cookie, 'user-agent': UA,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: BASE, referer: BASE + '/',
    'oai-device-id': did, 'oai-session-id': crypto.randomUUID(),
    'oai-language': 'zh-CN',
    'oai-client-version': CV, 'oai-client-build-number': CB,
    'sec-ch-ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
  };
  if (path) { h['x-openai-target-path'] = path; h['x-openai-target-route'] = path; }
  return { ...h, ...extra };
}

const s = await fetch(BASE + '/api/auth/session', { headers: H() });
const tok = ((await s.json()).accessToken) || '';
const p = '/backend-api/sentinel/chat-requirements/prepare';
const pr = await fetch(BASE + p, { method: 'POST', headers: H({ authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, p), body: '{}' });
const pj = await pr.json();
console.log('prepare:', pr.status, 'persona:', pj.persona);

const prompt = process.argv[2] || 'Create an animated GIF of a red ball bouncing up and down, 6 frames, smooth loop';

const uuid = () => crypto.randomUUID();
const body = {
  action: 'next',
  messages: [{ id: uuid(), author: { role: 'user' }, create_time: Date.now() / 1000,
    content: { content_type: 'text', parts: [prompt] },
    metadata: { developer_mode_connector_ids: [], selected_github_repos: [], selected_all_github_repos: false,
      system_hints: ['picture_v2'], serialization_metadata: { custom_symbol_offsets: [] } } }],
  parent_message_id: uuid(),
  model: 'auto', client_prepare_state: 'sent',
  timezone_offset_min: -480, timezone: 'Asia/Shanghai',
  conversation_mode: { kind: 'primary_assistant' },
  enable_message_followups: true, system_hints: ['picture_v2'],
  supports_buffering: true, supported_encodings: ['v1'],
  client_contextual_info: { is_dark_mode: false, time_since_loaded: 1200, page_height: 1072,
    page_width: 1724, pixel_ratio: 1.2, screen_height: 1440, screen_width: 2560, app_name: 'chatgpt.com' },
  paragen_cot_summary_display_override: 'allow', force_parallel_switch: 'auto',
};
const cp = '/backend-api/f/conversation';
const t0 = Date.now();
const r = await fetch(BASE + cp, {
  method: 'POST',
  headers: H({ authorization: 'Bearer ' + tok, 'content-type': 'application/json', accept: 'text/event-stream',
    'openai-sentinel-chat-requirements-token': pj.token || '' }, cp),
  body: JSON.stringify(body),
});
const txt = await r.text();
console.log('conversation:', r.status, '| len:', txt.length, '| t:', ((Date.now() - t0) / 1000).toFixed(1));
if (r.status !== 200) { console.log(txt.slice(0, 200)); process.exit(0); }

const ids = [...new Set([...txt.matchAll(/"asset_pointer"\s*:\s*"(?:sediment|file-service):\/\/([A-Za-z0-9_-]+)"/g)].map(m => m[1]))];
console.log('unique assets:', ids.length);
ids.forEach((id, i) => console.log(`  [${i}] ${id.slice(0, 24)}`));
// 找工具定义里的 output_format
const of = [...txt.matchAll(/"output_format"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
if (of.length) console.log('output_format 出现:', [...new Set(of)]);