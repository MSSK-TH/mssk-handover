// 保活代理 v3：流式透传，不缓冲请求体
//
// 链路：客户端 → CF/DMIT → 本进程(3002) → new-api(3001)
//
// v2 → v3 的改动（v2 会周期性被 OOM 杀掉，300M 上限跑满）：
//   ① 不再把整个请求体读进内存再 Buffer.concat
//      改为边收边转发；判断"是不是流式"优先看 Accept: text/event-stream，
//      没有该头时才嗅探前 16KB 是否含 "stream":true
//   ② 双向加背压：upstream 写不动就 pause 客户端，客户端写不动就 pause upstream
//   ③ 客户端断开 / 上游出错时立刻销毁对端并清空定时器，不再留着引用
//   ④ 日志只用字节计数，不再长期持有 body 引用
//
// 保活行为保持不变：
//   · 上游 20 秒不返回响应头 → 先自己发 200 + SSE 注释
//   · 已返回响应头但中间静默 → 每 PING_MS 发一个 `: keepalive`
//   · 非流式请求完全透传

import http from 'node:http';
import { request as httpRequest } from 'node:http';

const LISTEN_PORT = Number(process.env.PORT || 3002);
const UPSTREAM = { host: '127.0.0.1', port: Number(process.env.UPSTREAM_PORT || 3001) };
const PING_MS = Number(process.env.PING_MS || 10000);
const EARLY_MS = Number(process.env.EARLY_MS || 20000);
const SNIFF_MAX = 16 * 1024;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const server = http.createServer((cReq, cRes) => {
  const started = Date.now();

  let upReq = null;
  let clientHeadSent = false;
  let earlyTimer = null;
  let pingTimer = null;
  let lastWrite = Date.now();
  let sent = 0;
  let sniffed = false;
  let upstreamGone = false;
  let streaming = /text\/event-stream/i.test(cReq.headers.accept || '');

  const headers = { ...cReq.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` };
  delete headers['accept-encoding'];

  function ping() {
    if (Date.now() - lastWrite >= PING_MS - 300) {
      try { cRes.write(': keepalive\n\n'); lastWrite = Date.now(); } catch {}
    }
  }

  function startEarly() {
    if (!streaming || earlyTimer || clientHeadSent) return;
    earlyTimer = setTimeout(() => {
      if (clientHeadSent) return;
      try {
        cRes.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        });
        cRes.flushHeaders?.();
        cRes.write(': waiting for upstream\n\n');
        clientHeadSent = true;
        lastWrite = Date.now();
        if (!pingTimer) pingTimer = setInterval(ping, PING_MS);
        log(`提前保活生效 ${cReq.url}（上游 ${EARLY_MS}ms 未响应）`);
      } catch {}
    }, EARLY_MS);
  }

  function cleanup() {
    if (earlyTimer) { clearTimeout(earlyTimer); earlyTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  upReq = httpRequest(
    { host: UPSTREAM.host, port: UPSTREAM.port, path: cReq.url, method: cReq.method, headers },
    (upRes) => {
      if (earlyTimer) { clearTimeout(earlyTimer); earlyTimer = null; }
      const headAt = Date.now();
      const status = upRes.statusCode || 502;
      const upType = String(upRes.headers['content-type'] || '');
      const isSSE = streaming && upType.includes('text/event-stream');

      if (!clientHeadSent) {
        try {
          cRes.writeHead(status, { ...upRes.headers, 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
          cRes.flushHeaders?.();
        } catch {}
        clientHeadSent = true;
        lastWrite = Date.now();
      }
      if (isSSE && !pingTimer) pingTimer = setInterval(ping, PING_MS);

      upRes.on('data', (buf) => {
        lastWrite = Date.now();
        if (cRes.destroyed) return;
        if (!cRes.write(buf)) {
          upRes.pause();
          cRes.once('drain', () => { if (!cRes.destroyed) upRes.resume(); });
        }
      });

      upRes.on('end', () => {
        cleanup();
        try { cRes.end(); } catch {}
        const ms = Date.now() - started;
        const up = (headAt - started) / 1000;
        log(`${cReq.method} ${cReq.url} req=${(sent / 1024).toFixed(0)}KB 首包=${up.toFixed(2)}s 总=${(ms / 1000).toFixed(2)}s ${status}`);
      });

      upRes.on('error', () => { cleanup(); try { cRes.end(); } catch {} });
    },
  );

  upReq.setTimeout(0);

  upReq.on('error', (e) => {
    cleanup();
    upstreamGone = true;
    log(`上游错误 ${cReq.method} ${cReq.url}: ${e.message}`);
    if (!clientHeadSent) {
      try {
        cRes.writeHead(502, { 'content-type': 'application/json' });
        cRes.end('{"error":{"message":"upstream unreachable"}}');
      } catch {}
    } else {
      try { cRes.write('event: error\ndata: {"error":{"message":"upstream unreachable"}}\n\n'); cRes.end(); } catch {}
    }
  });

  // 请求体：边收边转发，不缓冲
  cReq.on('data', (c) => {
    if (!upstreamGone) sent += c.length;

    if (!sniffed) {
      if (/"stream"\s*:\s*true/.test(c.toString('latin1'))) {
        streaming = true; sniffed = true; startEarly();
      } else if (sent >= SNIFF_MAX) {
        sniffed = true;
      }
    }

    if (upstreamGone) return;
    if (!upReq.write(c)) {
      cReq.pause();
      upReq.once('drain', () => { if (!cReq.destroyed) cReq.resume(); });
    }
  });

  cReq.on('end', () => { if (!upstreamGone) { try { upReq.end(); } catch {} } });
  cReq.on('aborted', () => { upstreamGone = true; try { upReq.destroy(); } catch {} });
  cReq.on('error', () => { upstreamGone = true; try { upReq.destroy(); } catch {} });

  cRes.on('close', () => {
    cleanup();
    if (!cRes.writableEnded) { upstreamGone = true; try { upReq.destroy(); } catch {} }
  });

  startEarly();
});

server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  log(`保活代理 v3 启动: 127.0.0.1:${LISTEN_PORT} → ${UPSTREAM.host}:${UPSTREAM.port}  ping=${PING_MS}ms early=${EARLY_MS}ms 流式透传`);
});

process.on('uncaughtException', (e) => { log('uncaught', e && e.message); });
process.on('unhandledRejection', (e) => { log('unhandled', e && e.message); });
