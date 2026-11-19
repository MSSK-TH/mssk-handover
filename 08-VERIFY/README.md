# 08-VERIFY · 验收说明

`verify.sh` 有 9 组检查，逐项打印 `PASS / FAIL / SKIP`，最后给出汇总。

```bash
cd <包目录>/08-VERIFY
chmod +x verify.sh
source /root/mssk.env     # 需填过 DOMAIN_RELAY / DOMAIN_IMAGE 才有第 8 组
./verify.sh
```

## 每组在验什么

| 组 | 检查 | 失败意味着 |
|---|---|---|
| 1 | 5 个容器都是 `running` | 有容器崩了，看 `docker logs <name>` |
| 2 | 3001 / 3002 / 8788 / 80 四个本地接口 + shim 有响应 | 某个服务没起来，或端口冲突 |
| 3 | `one-api.db` 与 `-wal` 都在，`users/tokens/channels` 行数 > 0 | 数据库没搬全，**不要继续** |
| 4 | 用 DB 里的 admin 令牌调 `/api/user/self` 返回 `success:true` | 令牌不对或数据库不对 |
| 5 | `console/index.html` 与入口 JS 存在 | 前端产物没铺好 |
| 6 | `codex-quota.json` 有 `used_percent` 且较新 | cron 没装或跑失败 |
| 7 | `/etc/cron.d/` 有两条、没有 autoupdate | cron 装错 |
| 8 | 两个域名 HTTPS 200 | DNS 还没切（阶段 9 之前 SKIP 是正常的） |
| 9 | `/v1/chat/completions` 真实调用（默认关闭） | 上游渠道/令牌有问题 |

## 手动补充验证（脚本覆盖不到的）

```bash
# 控制台四档数值：浏览器打开 https://<relay 域名> 登录后，
# 依次点 今天 / 近 3 天 / 近 7 天 / 近 30 天，数值必须不同。
# 若四档数值一样 → 前端没拿到 flow 接口数据，检查 /api/data/flow/self 是否 200。

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3001/api/data/flow/self?start_timestamp=$(( $(date +%s)-604800 ))&end_timestamp=$(date +%s)" \
  | head -c 300
# 期望：包含 "token_name"、"model_name"、"count"、"quota"、"token_used"

# 生图站出一张图（网页版 Cookie 是否生效最直接的证据）
# 浏览器打开 https://<image 域名>，用 owner 给的令牌/口令登录，生成一张小图。
```

## 与数据库真值对账（可选，想更严谨时做）

```bash
python3 - <<'PY'
import sqlite3, time
c = sqlite3.connect('/opt/mssk/new-api/data/one-api.db')
now = int(time.time())
for label, days in (("today",1),("3d",3),("7d",7),("30d",30)):
    r = c.execute("select sum(count), sum(quota), sum(token_used) from quota_data where created_at >= ?",
                  (now - days*86400,)).fetchone()
    print(f"{label}: requests={r[0]} quota={r[1]} tokens={r[2]}")
PY
```

把上面四行与浏览器里「用量概览」四档的请求数对比：**请求数应完全相等**，
tokens 允许显示层四舍五入（控制台用 compact 格式）。偏差 > 5% 说明数据源不是同一份，要查。

> 注意：`quota_data` 是约 10 分钟一次的快照，所以「今天」档天然滞后 10 分钟，这是设计如此，不是 bug。
