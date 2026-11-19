# 域名与 HTTPS 证书 · 完整教程

> **谁会用到这份**：agent 用它来指导 owner；owner 也可以直接照着做。
> **什么时候用到**：见文末「三个时间点」——不要在最后一步才想起来。

---

## 一、先搞懂三件事（30 秒版）

### 1. 域名 = 门牌号，A 记录 = 门牌号对应哪个地址

域名本身没有地址。DNS 是电话簿，**A 记录**就是一行"域名 → IP"：

```
api.example.com     A     203.0.113.10      ← 你的服务器
image.example.com   A     203.0.113.10      ← 同一台
```

「**直连**」= 这条记录不经过任何代理/CDN，浏览器查到 IP 就直接连服务器。
（如果开了 Cloudflare 橙云，DNS 会返回 CF 的 IP，流量先到 CF 再回源，多一跳。）

### 2. HTTPS 证书必须绑域名，不能绑 IP

Let's Encrypt（免费证书机构）**不给 IP 签证书**。所以没有域名就只能用自签证书，
所有客户端都会报"证书不受信任"，`sk-` 调用可能直接被 TLS 校验拦掉。

**结论：域名是必需品，不是装饰。**

### 3. Caddy 自动签 = 服务器自己去申请、自己续期

Caddy 是这套系统对外的那个 web 服务器。它内置 ACME 客户端，启动时自动做这件事：

```
Caddy → Let's Encrypt："我要给 api.example.com 签证书"
Let's Encrypt → "证明这域名是你的：访问 http://api.example.com/.well-known/acme-challenge/<随机串>，
                 看到我给你的一串字符就算过"
Caddy → 自动应答 → 验证通过 → 拿到证书 → 自己装好 → 到期前 30 天自动续
```

所以它有两个**硬前提**：

| 前提 | 不满足会怎样 |
|---|---|
| 域名已经解析到这台机器 | 验证请求打到别处，签发失败 |
| 80 端口公网可达 | 验证请求进不来，签发失败 |

---

## 二、你要准备什么（清单）

| # | 东西 | 备注 |
|---|---|---|
| 1 | **一个域名** | `.com` 一年几十块。用两个子域（`api.` / `image.`）就够，不用买两个 |
| 2 | **两条 A 记录** | 都指向新机 IP，TTL 设 600（10 分钟） |
| 3 | **80 端口放行** | 云控制台安全组 |
| 4 | **一个邮箱** | 填在 Caddy 配置里，证书到期提醒用 |

> **备案**：服务器在境外 → **不需要 ICP 备案**。如果要搬回国内，域名必须先备案，
> 否则 80/443 会被拦，证书也签不下来。

---

## 三、怎么加 A 记录（按注册商找你的界面）

### 阿里云 / 腾讯云 / 华为云

```
控制台 → 云解析 DNS（或 DNS 解析）→ 选中你的域名 → 解析设置 → 添加记录

  记录类型：A
  主机记录：api            ← 只要填 "api"，不要填 api.example.com
  记录值：  <新机IP>
  TTL：    600

再点一次「添加记录」：
  记录类型：A
  主机记录：image
  记录值：  <新机IP>
  TTL：    600
```

### Cloudflare（域名托管在这里，但**不要开代理**）

```
Cloudflare → 选中域名 → DNS → Records → Add record

  Type: A
  Name: api
  IPv4 address: <新机IP>
  Proxy status: 点成【灰云 · DNS only】   ← 关键

再加一条 Name: image，同样灰云
```

> ⚠️ 必须灰云。橙云（Proxied）有两个问题：① 证书申请会被 CF 拦（源站还没证书）；
> ② CF 免费版有 100 秒连接上限，生图和长对话会被掐断。

### Namecheap / GoDaddy / 其它国外注册商

```
域名管理 → Advanced DNS → Add New Record

  Type: A Record
  Host: api
  Value: <新机IP>
  TTL: 10 min

再加一条 Host: image
```

### 还没有域名

任意注册商买一个即可。推荐买在**阿里云**或 **Cloudflare**——不是因为功能差异，
只是这两家的 DNS 面板最直观、中文文档最全。买完按上面加两条 A 记录。

---

## 四、怎么确认配好了（三条命令，必做）

### 1. 解析是否正确

```bash
# Linux / macOS
dig +short api.example.com
# 期望输出：203.0.113.10 （你的新机 IP）

# Windows PowerShell
nslookup api.example.com
```

```bash
dig +short image.example.com
```

### 2. 如果解析结果不对

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 返回 `198.18.x.x` 或 `10.x.x.x` | 你本机开了代理软件（Clash/Surge 等）在做 DNS 劫持 | 关掉代理再测，或用手机 4G 热点测 |
| 返回旧 IP | DNS 缓存 / 还没生效 | 等 10 分钟（TTL 600）；或换用 `dig @8.8.8.8 api.example.com` 直接问公共 DNS |
| 完全没有返回 | 记录没加上 / 加在了错误的域名下 | 回面板检查主机记录是不是只填了 `api` |
| 返回 Cloudflare 的 IP（104.x / 172.x） | 开了橙云 | 改成灰云（DNS only） |

### 3. 80 端口是否通（从**你自己的电脑**测，不是服务器上测）

```bash
# Linux / macOS
nc -vz <新机IP> 80

# Windows PowerShell
Test-NetConnection <新机IP> -Port 80
```

期望：`succeeded` / `open`。
不通 → 云控制台安全组没放行，去加规则（这一步 agent 做不了）。

---

## 五、Caddy 签名时会发生什么（给 agent 判断用）

在 `07-MIGRATION.md` 的 **C2** 阶段（DNS 已切、正式证书）执行：

```bash
docker restart caddy && sleep 30
docker logs caddy --tail 40 | grep -iE "certificate obtained|error"
```

**正常日志**（10~60 秒内出现）：

```
certificate obtained successfully  identifier=api.example.com  issuer=Let's Encrypt
```

**验证证书真的生效**：

```bash
curl -sI https://api.example.com | head -3
echo | openssl s_client -connect api.example.com:443 -servername api.example.com 2>/dev/null \
  | openssl x509 -noout -dates
# 期望：notBefore / notAfter 是最近 90 天内的日期
```

---

## 六、签发失败的 8 种原因与修法

| 日志里的关键词 | 原因 | 修法 |
|---|---|---|
| `no such host` / `DNS problem` | 域名没解析 / 记录没生效 | 回第四节验证；等 TTL |
| `connection refused` / `timeout` on port 80 | 80 没放行，或被本机防火墙拦 | 云安全组放行 80；`ss -ltnp \| grep :80` |
| `unauthorized` / `invalid response` | 验证请求被别的服务接走了 | 确认 80 端口是 caddy 在监听，不是别的进程 |
| `too many failed authorizations` | Let's Encrypt 频率限制（一周内失败太多次） | **停手等 1 小时**，别反复重启去撞 |
| `HTTP 403` + 提到 Cloudflare | 域名开了橙云 | 改灰云（DNS only） |
| `no certificate` / 一直 pending | Caddyfile 里站点块写法有问题 | `docker run --rm -v .../Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate` |
| 525 / 526（浏览器看到） | 用了 CF 橙云 + SSL 设为 Full(strict)，但源站没证书 | CF 的 SSL 模式临时改成 Full，签好再改回 strict |
| `rate limited` | 同上频率限制 | 等；也可以临时换用 `tls internal` 继续其余工作 |

---

## 七、证书的续期与备份

- **续期**：Caddy 自动，到期前 30 天续。你不用管。
- **存放位置**：`/opt/mssk/caddy/data/`（容器内 `/data`，已挂载成宿主机目录）。
  **重建容器不会丢证书**，也不浪费 Let's Encrypt 的签发配额。
- **备份**：迁移或重装前，把 `/opt/mssk/caddy/data/` 一起打包带走即可，省一次申请。

---

## 八、什么情况下才要改方案（不是二选一，是触发条件）

| 情况 | 做法 |
|---|---|
| 需要隐藏源站 IP（防攻击） | 改成 Cloudflare 橙云 + CF Origin 证书，见 `README-CERT.md` 方案 B |
| 目标用户在大陆且直连质量差 | 上付费 CDN / 专线；**免费橙云帮不上，反而更慢** |
| 服务器搬回国内 | 域名必须先 ICP 备案，否则 80/443 被拦 |
| 想用非标端口（如 9443） | Caddyfile 改 `https_port`，所有客户端地址跟着改；CF 免费版只代理 80/443 |

默认情况下**不要动**，直连 + 自动签就是最优。

---

## 九、三个时间点：agent 该在什么时候找 owner

> 这条最重要——域名和 DNS 是有生效时间的，**卡在最后一步才发现没配，会白等半小时**。

| 时间点 | agent 要做什么 | 为什么现在 |
|---|---|---|
| **B1 体检时** | 问一句："域名准备好了吗？A 记录加了吗？80 端口放行了吗？" 如果没好，**立刻把本文第三、四节发给 owner**，让他并行去弄 | DNS 生效需要 10 分钟以上，越早开始越好 |
| **B4 填写域名时** | 确认 `dig +short` 已经返回新机 IP；没返回就先等，不要硬填 | 填了但没解析，后面证书一定失败 |
| **C2 换正式证书前** | 确认 DNS 已经切到新机、80 仍放行；否则不要执行 `docker restart caddy` | 反复失败会触发 Let's Encrypt 频率限制 |

### agent 可以直接照抄发给 owner 的话

```
为了给新机配 HTTPS，你需要做三件小事（大约 10 分钟，其余我来）：

1) 在你买域名的地方加两条 A 记录（都指向 <新机IP>，TTL 600）：
     api.<你的域名>
     image.<你的域名>
2) 在云服务器控制台的安全组里放行 80 和 443（22 也放行，限你自己的 IP）
3) 加完告诉我，我会验证是否生效（命令：dig +short api.<你的域名>）

⚠️ 如果你的域名在 Cloudflare，请把这两条记录的云朵点成灰色（DNS only），
   不要开橙色代理——开了证书签不下来，而且长响应会被掐断。

如果你还没有域名，我可以给你购买建议（买一个就够，用两个子域即可）。
```

---

## 十、一页速查

```
加两条 A 记录（api / image → 新机IP，TTL 600，灰云）
放行 80 / 443（22 限源 IP）
验证：dig +short api.example.com → 新机 IP；nc -vz <IP> 80 → open
Caddy 启动 10~60 秒后日志出现：certificate obtained successfully
失败先看：DNS 生效没 / 80 通没 / 是不是橙云 / 有没有撞频率限制
证书存 /opt/mssk/caddy/data/，重建容器不丢
```
