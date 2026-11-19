# 08-2 · 功能测试流程（怎么发请求，怎么不把自己玩坏）

> 这份文档解决一个具体问题：**验收通过了，怎么确认"业务真的能用"**，
> 以及测试时**哪些动作会让上游限流、封号、或把额度刷掉**。
>
> 这些限制不是猜的——都来自这套系统真实跑过的教训。

---

## 一、通用铁律（先读这五条，违反任何一条都可能出事故）

| # | 铁律 | 原因 |
|---|---|---|
| 1 | **串行，不并发**。一次只发一个请求，等它彻底结束再发下一个 | 上游 Codex 账号是**单账号共享**的，并发会触发限流甚至风控；生图侧本来就是单线程 |
| 2 | **请求之间要有间隔**。文本 ≥10 秒，流式 ≥30 秒，生图 ≥60 秒 | 同上。短时间连发会被判为异常流量 |
| 3 | **失败不要立刻重试**。最多重试 2 次，间隔 30 秒 / 60 秒，连续失败就停手 | 秒级重试是最容易被封的行为 |
| 4 | **测试用专用令牌**。在控制台建一个叫 `migration-test` 的令牌，测完删掉 | 便于事后从日志里区分"测试产生的消耗"和真实业务；删了不污染账目 |
| 5 | **参数往小了给**。`max_tokens` ≤ 16，单条短 prompt，生图只出 1 张小图 | 测试不需要质量，只需要"链路通不通"；大参数只会浪费时间与额度 |

另外三条与这套系统特性相关的：

6. **别测长思考模型**（o1/o3 之类）。它可能返回 200 但 5 分钟才出结果，
   会被你误判成"卡死"。用便宜、快的模型（如 `gpt-4o-mini` 一类）。
7. **流式请求不要中途 Ctrl-C 之后立刻重发**。先等 30 秒，再发下一发。
8. **测完记一笔消耗**（控制台 → 使用日志，过滤你的测试令牌），
   否则将来对账时会把这笔算成"数据不一致"。

---

## 二、测试顺序：从最轻到最重

四层，**必须按顺序**。上一层不通就不要往下测——否则后面的失败原因会被前面掩盖。

| 层 | 测什么 | 会打到上游吗 | 间隔 | 每轮上限 |
|---|---|---|---|---|
| **L1** 只读接口 | 控制台数据、额度快照、flow 聚合 | ❌ 不消耗额度 | 1 秒 | 20 次 |
| **L2** 文本推理 | `/v1/chat/completions` 非流式 | ✅ 消耗少量额度 | **10 秒** | 3 次 |
| **L3** 流式 + 保活 | `stream:true`，看能否撑过 100 秒 | ✅ 消耗少量额度 | **30 秒** | 1~2 次 |
| **L4** 生图 | 生图站出 1 张图 | ✅ 消耗额度 | **60 秒** | 2 次 |

---

## 三、L1 · 只读接口（不消耗额度，可以放心测）

```bash
TOKEN=$(python3 - <<'PY'
import sqlite3
c = sqlite3.connect('/opt/mssk/new-api/data/one-api.db')
print(c.execute('select access_token from users where id=1').fetchone()[0].strip())
PY
)

# 1) 网关状态
curl -s -o /dev/null -w "status=%{http_code}\n" http://127.0.0.1:3001/api/status

# 2) 当前账号信息
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3001/api/user/self | head -c 200; echo

# 3) 按密钥×模型 聚合（控制台概览那张表的数据源）
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3001/api/data/flow/self?start_timestamp=$(( $(date +%s)-604800 ))&end_timestamp=$(date +%s)" \
  | head -c 300; echo

# 4) 额度快照（cron 生成的静态文件）
cat /opt/mssk/console/codex-quota.json | head -c 200; echo
```

**通过判据**：`status=200`；`/api/user/self` 里 `"success":true`；
`flow/self` 返回里能看到 `token_name`、`model_name`、`count`、`quota`、`token_used`；
`codex-quota.json` 有 `used_percent`。

> 只读接口可以连着发，但如果 `/api/data/flow/self` 你在 7 天区间上连续刷 20 次，
> 也会让机器吃力（这台机器只有 2 核）。**间隔 1 秒足够，不要狂刷。**

---

## 四、L2 · 文本推理（第一发真实请求）

**先建测试令牌**（控制台 → API 密钥 → 新建，名字 `migration-test`，额度随意）。

```bash
SK="sk-<你的测试令牌>"
MODEL="<一个便宜快的模型名，去 控制台→模型 里挑>"

# 第 1 发：最小请求
time curl -s -X POST http://127.0.0.1:3002/v1/chat/completions \
  -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"reply with: OK"}],"max_tokens":8}'
```

**通过判据**（三个都要满足）：

1. HTTP 200；
2. 返回体里有 `"choices"`，且 `content` 非空；
3. `time` 显示耗时在合理范围（通常 1~15 秒；超过 60 秒说明上游有问题）。

**这就是"链路通"的证据**：客户端 → caddy → keepalive → new-api → 上游 → 回来。

**要等 10 秒再发第 2 发。** 如果第 1 发就失败，**不要连续重试**：

| 返回 | 含义 | 做法 |
|---|---|---|
| 401 | 令牌无效 | 检查令牌是否建对、是否被禁用 |
| 429 | 上游限流 | **停 60 秒**，只重试 1 次；还 429 就停手，说明账号被限 |
| 500 + 日志里 `channel` 报错 | 渠道密钥/上游问题 | 控制台 → 渠道 → 点「测试」 |
| 502/504 | keepalive 或 new-api 挂了 | `docker logs relay-keepalive`、`docker logs new-api` |
| 200 但 `choices` 空 | 上游返回了但内容被过滤/额度不足 | 看返回里的 `message` 字段 |

---

## 五、L3 · 流式 + 保活验证（这条最能暴露那个经典坑）

**目的**：确认 `relay-keepalive` 真的在保活。直连 3001 的部署会在 ~100 秒被中间层掐断。

```bash
# 等上一步至少 30 秒
time curl -N -s -X POST http://127.0.0.1:3002/v1/chat/completions \
  -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"count from 1 to 30 slowly"}],"max_tokens":64,"stream":true}' \
  | tail -c 400
```

**通过判据**：

1. 能看到连续的 `data: {...}` 行（流式片段），最后有 `data: [DONE]`；
2. **全程没有被截断**（不是发了 20 秒突然断开）；
3. 如果这次请求超过 100 秒还没结束、且仍然正常出片段 —— 说明保活在起作用（这正是想要的结果）。

**如果 100 秒左右被掐断**：说明 `/v1` 没走 keepalive。立刻停下，
检查 Caddyfile 里 `/v1/*` 是不是指向 `127.0.0.1:3002`（不是 3001）。

---

## 六、L4 · 生图（最容易卡住的一层，也是最不重要的）

> ⚠️ **生图失败不阻塞迁移**。它依赖网页版 Cookie，换 IP 后大概率要重新登录。
> 核心链路（L1~L3）通了，就可以进 DNS 切换，生图事后单独排。

```bash
# 等上一步至少 60 秒
# 先看生图站是否活着
curl -s -o /dev/null -w "image_site=%{http_code}\n" http://127.0.0.1:8788/api/health

# 再走一次最小出图（路径以 03-APP/image-web/server.mjs 里的实际路由为准）
curl -s -X POST http://127.0.0.1:8788/api/generate \
  -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a red circle on white background","size":"512x512","n":1}' \
  | head -c 400; echo
```

**通过判据**：返回里拿到图片 URL 或 base64，且能在浏览器打开。

**失败判据与对应动作**（按顺序，每次只做一项，做完等 60 秒再试）：

| 现象 | 判断 | 动作 |
|---|---|---|
| `image_site=000` | 生图站没起来 | `docker logs image-web --tail 50` |
| 接口 401/403 | 令牌/Cookie 问题 | 先换 shim 的原生模式测；不行再看 Cookie |
| 报错提到 `/backend-api/`、`401`、`cloudflare` | **网页版 Cookie 失效或被 IP 风控** | 让 owner 重新登录导出 Cookie（07-MIGRATION 阶段 6） |
| 卡住 60 秒后超时 | shim 的上游超时 | 看 `docker logs imagegen-shim`，确认 `TIMEOUT_MS` |
| 连续两次失败 | — | **停手**，记为"待 owner 处理"，继续后续流程 |

---

## 七、测试完成后必做

1. **删掉测试令牌**（控制台 → API 密钥 → `migration-test` → 删除）；
2. **记下测试消耗**（使用日志里按令牌筛选，截图或记数字），将来对账时扣除；
3. **等 10 分钟**再跑一次 `08-VERIFY/verify.sh`——
   `quota_data` 是 10 分钟一次的快照，刚测完的消耗这时才会出现在概览里；
4. 把上面四层的实际结果（耗时、状态码、是否通过）写进交接记录。

---

## 八、一页速查

```
不发并发 · 文本 10s · 流式 30s · 生图 60s · 失败最多重试 2 次（30s/60s）
测试令牌专建专删 · max_tokens ≤ 16 · 生图 n=1 小图
L1 只读（随便测） → L2 文本（1 发确认） → L3 流式（1 发验保活） → L4 生图（可选）
生图失败不阻塞；100 秒被掐 = keepalive 没接对
```
