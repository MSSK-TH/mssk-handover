# 07 · 部署执行手册（agent 用）

> **给 agent**：这是你要照着做的主线。
> **owner 不用读这一份** —— 他只需要看 `00-YOU-DO-THIS.md`（4 件事）。
>
> 执行原则：按 B1→B8 顺序，一次只做一步。每个 `CHECKPOINT` 停下来汇报，等 owner 确认再继续。
> **任何一步的"期望输出"和实际不一致 → 停下，不要试别的办法。**

---

## 这套东西最终要装成什么样

一台机器，5 个容器，2 个定时任务，2 个域名：

```
                       ┌───────────────────────────────────────┐
  api.example.com      │  caddy  :80 / :443                    │
  image.example.com →  │   ├─ /v1/*     → keepalive:3002       │
                       │   │              → new-api:3001       │
                       │   ├─ /api/*    → new-api:3001         │
                       │   ├─ /static/* + 其余 → /srv/console  │
                       │   └─ image 域名 → image-web:8788      │
                       │                                       │
                       │  imagegen-shim :8899（只绑 127.0.0.1） │
                       │  cron: mssk-quota / disk-guard        │
                       └───────────────────────────────────────┘
```

> **部署形态：单机全栈**
>
> 所有组件都装在这一台机器上——一个对外入口（caddy）、一个网关（new-api）、
> 一个 SSE 保活代理、一个生图站、一个生图执行层。
> **不需要第二台机器，也不需要与任何其它机器通信**：包里的配置、脚本、定时任务都是按单机准备的。
> 数据来源是旧部署的一次性迁移（`04-DATA/`），迁完就与新机无关。

---

# 阶段 A · 动手前确认东西齐了

```bash
# owner 必须给你这四样，缺任何一样都不要开始
#   1) 新机 IP + SSH 登录方式
#   2) 两个域名（api.xxx / image.xxx）
#   3) 05-SECRETS.enc 的解密口令
#   4) 本仓库的只读访问权限（git clone + Release 下载 token）
```

**同时确认域名与网络**（最容易拖时间，越早开始越好）：

```bash
# 域名是否已解析到新机（在你自己的电脑上执行）
dig +short api.<你的域名>
dig +short image.<你的域名>
# 期望返回新机 IP

# 80 端口是否放行（在你自己的电脑上执行）
nc -vz <新机IP> 80
```

> 如果这两项还没好 → **立刻把 `02-CONFIG/caddy/DOMAIN-AND-TLS-GUIDE.md` 的第三、四节发给 owner**，
> 让他并行去加 A 记录和放行端口。DNS 生效要 10 分钟以上，等到 B4 才弄会白等。

再确认一次新机硬指标（这一条不接受凑合）：

```bash
nproc                       # ≥ 2
free -m | sed -n 2p         # total ≥ 3900（4 GB）
df -h / | tail -1           # Avail ≥ 20G
```

> ### ⛔ CHECKPOINT A
> 汇报：四样东西是否齐、`nproc` / `free -m` / `df -h` 三项数字。

---

# 阶段 B · 部署（30~60 分钟）

## B1 · 体检与环境（5 分钟）

```bash
cat /etc/os-release | grep PRETTY   # Ubuntu 22.04/24.04 或 Debian 12
uname -m                            # x86_64

# Docker（没有就装）
docker --version || (curl -fsSL https://get.docker.com | sh && systemctl enable --now docker)
docker compose version

# 端口占用（除 22 之外不该有别的在听）
ss -ltnp | grep -vE ':22\b' || echo "only ssh listening — good"
```

公网 80/443 的放行你改不了（在云控制台安全组），**直接问 owner 是否已放行**，
并让他用自己电脑 `nc -vz <新机IP> 80` / `443` 验证。

**失败怎么办**：内存 < 3500 MB → **停下告诉 owner**，4 GB 是这套东西的底线。

> ### ⛔ CHECKPOINT B1
> 汇报时**必须带上域名状态**：A 记录是否已生效（`dig +short` 结果）、80 是否放行。
> 没好的话，现在就把域名教程发给 owner，别干等他回复——你可以继续 B2~B3。

---

## B2 · 拉仓库与公开资产（10 分钟）

> 私有资产（`data-db.tar.gz`、`05-SECRETS.enc`）**不在仓库里**，由 owner 单独发给你，
> 放到 `/root/mssk-private/`。这一步只处理公开资产，私有资产在 B3 用。

仓库里只有文档和配置（约 1.4 MB）。大文件走 Release 附件，一条命令拉下来：

```bash
git clone <owner 给的仓库地址> /root/mssk-handover
cd /root/mssk-handover

# 拉大文件：console 产物 / 数据库 / 生图镜像 / 凭据包，并自动解到 /opt/mssk
bash scripts/fetch-assets.sh
```

**期望**：

```bash
ls -lh /opt/mssk/console/index.html          # 存在
ls -lh /opt/mssk/new-api/data/one-api.db     # 约 119 MB
docker images | grep image-web               # mssk/image-web  webp
```

**失败怎么办**：

| 现象 | 做法 |
|---|---|
| `gh: command not found` 或未登录 | `GITHUB_TOKEN=<owner 给的只读 token> bash scripts/fetch-assets.sh` |
| sha256 校验不通过 | 删掉 `/root/mssk-assets` 重跑，别凑合 |
| 没有 docker | 先按 B1 装好，再 `docker load -i /root/mssk-assets/mssk-image-web-webp.tar.gz` |

> ### ⛔ CHECKPOINT B2
> 汇报：`fetch-assets.sh` 是否 OK、上面三条期望的实际输出。

---

## B3 · 铺配置与小代码 + 解凭据（10 分钟）

> `console` 和数据库已经由 `fetch-assets.sh` 解到 `/opt/mssk/`，这一步只铺配置和代码。

```bash
cd /root/mssk-handover

mkdir -p /opt/mssk/{caddy,new-api,image-web,shim,relay-keepalive,secrets,tools,scripts,data}

cp 02-CONFIG/caddy/Caddyfile             /opt/mssk/caddy/
cp 02-CONFIG/compose/caddy.yml           /opt/mssk/caddy/docker-compose.yml
cp 02-CONFIG/compose/new-api.yml         /opt/mssk/new-api/docker-compose.yml
cp 02-CONFIG/compose/image-web.yml       /opt/mssk/image-web/docker-compose.yml
cp 02-CONFIG/compose/imagegen-shim.yml   /opt/mssk/shim/docker-compose.yml
cp 02-CONFIG/compose/relay-keepalive.yml /opt/mssk/relay-keepalive/docker-compose.yml

cp -a 03-APP/image-web/.  /opt/mssk/image-web/
cp -a 03-APP/shim/.       /opt/mssk/shim/
cp -a 03-APP/keepalive/.  /opt/mssk/relay-keepalive/
cp -a 02-CONFIG/tools/.   /opt/mssk/tools/
[ -d 02-CONFIG/scripts ] && cp -a 02-CONFIG/scripts/. /opt/mssk/scripts/
chmod +x /opt/mssk/tools/*.sh 2>/dev/null
chown -R 1000:1000 /opt/mssk/new-api/data 2>/dev/null || true
```

**私有资产到位后，解包数据库与凭据**：

```bash
# owner 私下发的两个文件（放到 /root/mssk-private/）
ls -lh /root/mssk-private/
#   data-db.tar.gz     05-SECRETS.enc

mkdir -p /opt/mssk/new-api/data
tar xzf /root/mssk-private/data-db.tar.gz -C /opt/mssk/new-api/data
chown -R 1000:1000 /opt/mssk/new-api/data 2>/dev/null || true
ls -lh /opt/mssk/new-api/data/one-api.db*      # 期望 db ~119MB + wal
```

**关于数据库的新鲜度，先问 owner 一句话**：

> "资产里的数据库是打包那天的快照。之后旧机器上又跑了吗？需要的话请导一份最新的给我。"

需要更新时，owner 在**旧机器**上执行（约 30 秒，服务短暂中断）：

```bash
docker compose -f /opt/mssk/new-api/docker-compose.yml stop
cp /opt/mssk/new-api/data/one-api.db     /tmp/one-api.latest.db
cp /opt/mssk/new-api/data/one-api.db-wal /tmp/one-api.latest.db-wal
docker compose -f /opt/mssk/new-api/docker-compose.yml start
# 把 /tmp/one-api.latest.db* 给 agent
```

拿到后覆盖（**db 和 -wal 必须成对替换**）：

```bash
cp /path/to/one-api.latest.db     /opt/mssk/new-api/data/one-api.db
cp /path/to/one-api.latest.db-wal /opt/mssk/new-api/data/one-api.db-wal
chown 1000:1000 /opt/mssk/new-api/data/one-api.db*
```

然后：

```bash
# 有最新库就用最新库，没有就用包里的
SRC=/root   # 或 04-DATA
cp ${SRC}/one-api.latest.db  /opt/mssk/new-api/data/one-api.db     2>/dev/null \
  || cp 04-DATA/one-api.db   /opt/mssk/new-api/data/one-api.db
cp ${SRC}/one-api.latest.db-wal /opt/mssk/new-api/data/one-api.db-wal 2>/dev/null \
  || cp 04-DATA/one-api.db-wal   /opt/mssk/new-api/data/one-api.db-wal
cp 04-DATA/one-api.db.backup-latest /opt/mssk/new-api/data/
chown -R 1000:1000 /opt/mssk/new-api/data 2>/dev/null || true

# 凭据（口令由 owner 单独给，不要写进 shell 历史）
mkdir -p /opt/mssk/secrets
#   age 形式：  age -d -o /tmp/secrets.tar.gz /root/mssk-assets/05-SECRETS.enc
#   7z 形式：   7z x /root/mssk-assets/05-SECRETS.enc -o/tmp/secrets
mkdir -p /tmp/secrets-extract
tar xzf /tmp/secrets.tar.gz -C /tmp/secrets-extract
cp /tmp/secrets-extract/image-web.env      /opt/mssk/secrets/
cp /tmp/secrets-extract/imagegen-shim.env  /opt/mssk/secrets/
mkdir -p /opt/mssk/shim/cookies
cp /tmp/secrets-extract/shim-cookies/*.txt /opt/mssk/shim/cookies/ 2>/dev/null || true
cp /tmp/secrets-extract/shim-cookies/web-cookie.txt /opt/mssk/shim/ 2>/dev/null || true

chmod 700 /opt/mssk/secrets /opt/mssk/shim/cookies
chmod 600 /opt/mssk/secrets/*.env
chmod 600 /opt/mssk/shim/cookies/*.txt /opt/mssk/shim/web-cookie.txt 2>/dev/null || true
rm -rf /tmp/secrets-extract /tmp/secrets.tar.gz
```

**期望**：`ls /opt/mssk` 十项齐全；两个 `.env` 权限 `-rw-------`；`one-api.db` 约 119 MB。

> ### ⛔ CHECKPOINT B3
> 汇报：`ls /opt/mssk`、`ls -l /opt/mssk/secrets`、`ls -lh /opt/mssk/new-api/data/`、
> 以及**用的是包里那份库还是 owner 当天导出的最新库**。

---

## B4 · 填域名（5 分钟）

> 📖 开工前先读 `02-CONFIG/caddy/DOMAIN-AND-TLS-GUIDE.md`。
> 如果 `dig +short api.<域名>` 还没返回新机 IP，**先别往下做**，把教程第三、四节发给 owner。

```bash
cat > /root/mssk.env <<'EOF'
DOMAIN_RELAY=__DOMAIN_RELAY__
DOMAIN_IMAGE=__DOMAIN_IMAGE__
ACME_EMAIL=__ACME_EMAIL__
EOF
source /root/mssk.env

sed -i "s/__DOMAIN_RELAY__/${DOMAIN_RELAY}/g; s/__DOMAIN_IMAGE__/${DOMAIN_IMAGE}/g; s/__ACME_EMAIL__/${ACME_EMAIL}/g" /opt/mssk/caddy/Caddyfile

grep -rn "__DOMAIN\|__ACME" /opt/mssk/ || echo "no placeholders left"

docker run --rm -v /opt/mssk/caddy/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile
```

**期望**：`no placeholders left` + `Valid configuration`。

> ### ⛔ CHECKPOINT B4

---

## B5 · 准备镜像（10 分钟）

```bash
# 自建镜像（Docker Hub 没有，必须从包里导入）
docker load -i /root/mssk-assets/mssk-image-web-webp.tar.gz
docker images | grep image-web

docker pull caddy:2-alpine
docker pull node:22-alpine
docker pull calciumion/new-api:v1.0.0-rc.51
```

**期望**：四个镜像齐全，new-api 的 tag 必须是 **v1.0.0-rc.51**（不是 latest）。

**失败怎么办**：拉不动就加镜像加速 `/etc/docker/daemon.json` →
`{"registry-mirrors":["https://docker.m.daocloud.io"]}` → `systemctl restart docker`。
仍不行就让 owner 从旧机器 `docker save` 传给你。

> ### ⛔ CHECKPOINT B5

---

## B6 · 起网关并验证数据库（10 分钟）

```bash
cd /opt/mssk/new-api && docker compose up -d && sleep 8
docker ps --filter name=new-api --format '{{.Names}} {{.Status}}'

curl -s -o /dev/null -w "status_api=%{http_code}\n" http://127.0.0.1:3001/api/status   # 期望 200

TOKEN=$(python3 - <<'PY'
import sqlite3
c = sqlite3.connect('/opt/mssk/new-api/data/one-api.db')
print(c.execute('select access_token from users where id=1').fetchone()[0].strip())
PY
)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3001/api/user/self | head -c 200; echo
```

**失败怎么办**：

- 容器起不来 → `docker logs new-api --tail 50`；多半是 `data/` 权限（`chown 1000:1000`）。
- `no such table` → **必须同时有 `one-api.db` 和 `-wal`**，回 B3 重拷。
- 401 → `users` 表 id=1 的令牌不是你以为的那个。

> ### ⛔ CHECKPOINT B6
> 汇报：容器状态、`/api/status`、`/api/user/self` 的 success、`select count(*) from users`。

---

## B7 · 起其余四个容器（15 分钟）

**顺序有依赖，别乱**：

```bash
# 7.1 保活代理（caddy 的 /v1 指向它）
cd /opt/mssk/relay-keepalive && docker compose up -d && sleep 3
curl -s -o /dev/null -w "keepalive=%{http_code}\n" http://127.0.0.1:3002/api/status   # 200

# 7.2 生图站
cd /opt/mssk/image-web && docker compose up -d && sleep 5
curl -s -o /dev/null -w "image_web=%{http_code}\n" http://127.0.0.1:8788/api/health    # 200

# 7.3 生图执行层（本机容器，只绑 127.0.0.1:8899）
cd /opt/mssk/shim && docker compose up -d && sleep 5
docker logs imagegen-shim --tail 20

# 7.4 对外入口（⚠️ 先用自签证书）
#     原因：Caddy 自动签正式证书要求域名已解析到本机。现在 DNS 可能还指着旧机，
#     申请必然失败。所以临时加 tls internal，功能验完、DNS 切完再换回正式证书（C2）。
#
#     做法：编辑 /opt/mssk/caddy/Caddyfile，在两个域名站点块内各加一行：
#         tls internal
#
docker run --rm -v /opt/mssk/caddy/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile
cd /opt/mssk/caddy && docker compose up -d && sleep 10
docker logs caddy --tail 20

curl -s -o /dev/null -w "console=%{http_code}\n" http://127.0.0.1/                # 200
curl -sk -o /dev/null -w "console_tls=%{http_code}\n" \
  --resolve ${DOMAIN_RELAY}:443:127.0.0.1 https://${DOMAIN_RELAY}/                 # 200（自签，-k）
```

**生图出图排障**（不阻塞，记一笔继续）：

| 现象 | 判断 | 动作 |
|---|---|---|
| 容器没起来 | `.env` 路径/权限、cookies 缺失 | `docker logs imagegen-shim --tail 50` |
| 起来但 401/403 | Cookie 过期或**换 IP 被风控** | 需要 owner 重登网页版（附录 A） |
| 500 且日志提到上游 | 账号/额度 | 控制台 → 渠道 → 测试 |
| 60 秒被掐断 | `/v1` 没走 keepalive | 检查 Caddyfile 指向 3002 |

> ### ⛔ CHECKPOINT B7
> 汇报：四个容器状态、3002/8788/80 三个本地返回码、caddy 日志有无 error、
> 生图能否出图（能/不能，不能就记一笔继续）。

---

## B8 · 定时任务 + 验收 + 功能测试（15 分钟）

```bash
# 8.1 装 cron（只装两条，不要装 autoupdate）
install -m 644 /root/mssk-handover/02-CONFIG/cron/mssk-quota /etc/cron.d/mssk-quota
install -m 644 /root/mssk-handover/02-CONFIG/cron/disk-guard /etc/cron.d/disk-guard
systemctl reload cron 2>/dev/null || systemctl reload crond 2>/dev/null || true

# 8.2 手动跑一次额度脚本
MSSK_DB=/opt/mssk/new-api/data/one-api.db MSSK_OUT=/opt/mssk/console/codex-quota.json \
  /usr/bin/python3 /opt/mssk/tools/codex-quota.py; echo "exit=$?"
ls -l /opt/mssk/console/codex-quota.json && head -c 200 /opt/mssk/console/codex-quota.json; echo

# 8.3 验收脚本
cd /root/mssk-handover/08-VERIFY && chmod +x verify.sh
source /root/mssk.env && ./verify.sh
# 期望：除"域名"那组（会 SKIP）之外全 PASS

# 8.4 功能测试
cat /root/mssk-handover/08-VERIFY/FUNCTIONAL-TEST.md
```

**功能测试必须遵守**（违反会触发上游限流/风控）：

- **串行，不并发**，一次一个请求；
- 间隔：文本 **10 秒**、流式 **30 秒**、生图 **60 秒**；
- 失败最多重试 2 次（间隔 30 s / 60 s），连续失败就停；
- `max_tokens ≤ 16`，生图 `n=1` 小图；
- 测试令牌专建专删（名字 `migration-test`）。

四层顺序：**L1 只读 → L2 文本 → L3 流式（验保活）→ L4 生图（可选、不阻塞）**。

- L1~L3 全过 = 核心链路 OK，可以进阶段 C。
- **L4 不过不算失败**，记为"待 owner 处理"，切换后单独排。

> ### ⛔ CHECKPOINT B8（关键节点）
> 汇报：`verify.sh` 完整输出、L1~L4 各自结果、失败项。
> **汇报完停下来等 owner 决定是否切换。**

---

# 阶段 C · 切换（10 分钟 + 24 小时观察）

## C1 · 等 owner 确认

把 B8 结果发给他，明确问："**验收通过，是否现在切 DNS？**" 他不点头不要继续。

## C2 · 换正式证书（owner 改完 DNS 之后）

> 📖 对应 `02-CONFIG/caddy/DOMAIN-AND-TLS-GUIDE.md` 第五、六节（正常日志长什么样、失败 8 种原因）。
> 动手前再验一次：`dig +short <域名>` 返回新机 IP、`nc -vz <新机IP> 80` 通。
> **不要反复 restart caddy 去撞验证** —— Let's Encrypt 一周失败次数过多会限流。

```bash
source /root/mssk.env

# 恢复成包里的原始 Caddyfile（去掉临时加的 tls internal）
cp /root/mssk-handover/02-CONFIG/caddy/Caddyfile /opt/mssk/caddy/Caddyfile
sed -i "s/__DOMAIN_RELAY__/${DOMAIN_RELAY}/g; s/__DOMAIN_IMAGE__/${DOMAIN_IMAGE}/g; s/__ACME_EMAIL__/${ACME_EMAIL}/g" /opt/mssk/caddy/Caddyfile

docker run --rm -v /opt/mssk/caddy/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile
docker restart caddy && sleep 30

docker logs caddy --tail 40 | grep -iE "certificate obtained|error"
# 期望：certificate obtained for <你的域名>

curl -s -o /dev/null -w "relay=%{http_code}\n" https://${DOMAIN_RELAY}/
curl -s -o /dev/null -w "image=%{http_code}\n" https://${DOMAIN_IMAGE}/
echo | openssl s_client -connect ${DOMAIN_RELAY}:443 -servername ${DOMAIN_RELAY} 2>/dev/null | openssl x509 -noout -dates
```

**失败怎么办**：Cloudflare 橙云 + SSL "Full (strict)" 会在源站还没证书时返回 525/526。
先把 CF 的 SSL 模式临时改成 **Full**，签好后再改回 strict。

## C3 · 提醒 owner 通知客户端改地址

```
域名已切到新机，请通知所有使用者更新地址（sk- 令牌不变）：
· cc-switch / Codex CLI：base_url 改成 https://<relay 域名>/v1
· Cherry Studio 等客户端：API 地址同上
· 生图站书签：改成 https://<image 域名>
```

## C4 · 收尾与观察

```bash
grep -oE 'index\.[a-z0-9]+\.js' /opt/mssk/console/index.html       # 记录前端版本
docker images --format '{{.Repository}}:{{.Tag}}' | sort           # 记录镜像版本
rm -f /root/mssk-assets/05-SECRETS.enc                      # 删掉加密包
ls /etc/cron.d/ | grep -E "mssk|disk"                              # 应只有两条
```

**告诉 owner：旧机器 24 小时内不要关**——这是唯一的后悔药。出问题把 DNS 改回去即可。

---

# 附录 A · 故障对照表

| 现象 | 最可能原因 | 动作 |
|---|---|---|
| 容器起不来 | 权限/路径 | `docker logs <name> --tail 50` |
| `/api/status` 不通 | new-api 没起/端口冲突 | `ss -ltnp \| grep 3001` |
| 数据库 `no such table` | 只拷了 db 没拷 `-wal` | 回 B3 重拷两个文件 |
| 前端白屏、接口 404 | 静态目录没铺 | `ls /opt/mssk/console/index.html` |
| 长响应 100 秒被掐 | `/v1` 直连 3001 | Caddyfile 改回 3002 |
| 生图 401/403 | 网页版 Cookie 换 IP 失效 | 见下 |
| 证书申请失败 | DNS 没切 / 80 不通 / CF 橙云 strict | 见 C2 |
| 概览四档数值一样 | `/api/data/flow/self` 报错 | 单独 `curl` 看返回 |
| 订阅额度显示为空 | quota cron 没跑通 | 手动跑 `codex-quota.py` 看 exit |

**网页版 Cookie 重取**（owner 做，agent 不要自己登录）：

1. owner 浏览器登录 ChatGPT 网页版；
2. 开发者工具 → Network → 任一 `/backend-api/` 请求 → 复制完整 `Cookie` 头；
3. 写成一行，覆盖 `/opt/mssk/shim/cookies/a.txt`（权限 600）；
4. `docker restart imagegen-shim`；
5. 再测一次出图。

---

# 附录 B · 禁止事项（每条都有真实后果）

| 禁止 | 后果 |
|---|---|
| 在新机上跑 `bun install` / `bun run build` | 内存打满 → SSH 连不上 → 只能重启实例（真实发生过） |
| 把 new-api 镜像改成 `latest` 或启用 autoupdate | 版本漂移，行为不可预期 |
| 让 `/v1` 直连 3001（绕过 keepalive） | 生图与长对话在 ~100 秒被掐断 |
| 只拷 `one-api.db` 不拷 `-wal` | 丢最近写入的数据 |
| 测试时并发请求 / 秒级重试 | 触发上游限流甚至风控 |
| 自己改 DNS / 自己登录 ChatGPT | 越权；会把 owner 的账号搞乱 |
| 删旧机器上的任何东西 | 旧机还没下线，回滚要用 |
| `docker system prune -a` | 会删掉自建镜像 `mssk/image-web:webp`（唯一副本） |

---

# 附录 C · 命令速查

```bash
# 全部状态一屏
docker ps --format '{{.Names}}\t{{.Status}}'
ss -ltnp | grep -E ':3001|:3002|:8788|:8899|:80|:443'

# 日志
docker logs new-api --tail 50
docker logs relay-keepalive --tail 50
docker logs image-web --tail 50
docker logs imagegen-shim --tail 50
docker logs caddy --tail 50

# 重启单个服务
cd /opt/mssk/<服务目录> && docker compose restart

# 数据库行数
python3 -c "import sqlite3;c=sqlite3.connect('/opt/mssk/new-api/data/one-api.db');print([c.execute('select count(*) from '+t).fetchone()[0] for t in ('users','tokens','channels')])"

# 额度脚本手动跑
MSSK_DB=/opt/mssk/new-api/data/one-api.db MSSK_OUT=/opt/mssk/console/codex-quota.json \
  /usr/bin/python3 /opt/mssk/tools/codex-quota.py
```
